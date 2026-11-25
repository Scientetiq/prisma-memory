// Archive of a space with records (when a project ends, the space goes to the
// archive, read only, outside the general search). The archive is only a space state (spaces.archived_at, archived_by):
// records stay in place and keep their class. The project owner (role owner) archives and restores it in the work
// place — a person only, no demo persona, not a service's write space; team spaces and projects — the administrator in the panel
// (admin.ts, with_records). Agents have no tool for it. The archive membership only narrows (access.ts, space-groups.ts).
import { binder, clientText, invalid, ldapConfig, log, MemoryError, notFound, tx, visibleSql } from "@memory/shared";
import type pg from "pg";
import type { App, Caller } from "./context.ts";
import { archivedWithRecords, GROUP_CACHE_TAKEN_SQL, lockReconcile, readableSpaces, type SpaceAccess } from "./access.ts";
import { audit } from "./audit.ts";
import { offsetCursor } from "./paging.ts";
import { grantPendingMeetings } from "./participants.ts";
import { peopleOf, recount, syncGroups, type Changes } from "./space-groups.ts";
import { PROJECTS, projectsLimit, resolveWithArchive, spaceCard, unmanageableWhy } from "./spaces.ts";
import { listingSpec } from "./visibility.ts";
import { requireHuman } from "./workplace.ts";

type Q = Pick<pg.PoolClient, "query">;

/** Live records of the space (undeleted locators): for the event and the administrator's confirmation. No rights — a count. */
export async function liveRecords(q: Q, spaceId: string): Promise<number> {
  return (await q.query("SELECT count(*)::int AS n FROM record_locations WHERE space_id = $1 AND NOT deleted", [spaceId])).rows[0].n as number;
}

/**
 * Archive (on) or restore: the space row and the membership recount in one transaction. The reconcile lock comes before
 * editing the row (a concurrent reconcile edits space owners) and before the old-state snapshot (recount). An archived space
 * with records keeps group membership (the reconcile only narrows it); an empty one drops it, as before. A restore recounts
 * membership from the group cache and the assignments in force. null — the state is already so (a concurrent request was first).
 */
export async function setArchived(q: pg.PoolClient, instanceId: string, spaceId: string, on: boolean, by: string | null): Promise<Changes | null> {
  await lockReconcile(q, instanceId);
  const r = on
    ? await q.query("UPDATE spaces SET archived_at = now(), archived_by = $2 WHERE id = $1 AND archived_at IS NULL", [spaceId, by])
    : await q.query("UPDATE spaces SET archived_at = NULL, archived_by = NULL WHERE id = $1 AND archived_at IS NOT NULL", [spaceId]);
  if (!r.rowCount) return null;
  // restore from the archive: bindings whose DN now resolves to another group (another objectGUID) are marked
  // as group gone: no membership through them (reconcileAccess), the owner sees it and decides to unbind or bind again
  if (!on)
    await q.query(`UPDATE space_groups g SET status = 'missing', missing_since = COALESCE(g.missing_since, now()), last_error = NULL
                   WHERE g.space_id = $2 AND ${GROUP_CACHE_TAKEN_SQL("g")}`, [instanceId, spaceId]);
  // the archive only narrows: invitations before the first sign-in are dropped, new people do not come into an archive
  if (on) await q.query("DELETE FROM space_invites WHERE space_id = $1", [spaceId]);
  return recount(q, instanceId, [spaceId]);
}

/**
 * The limit limits.projects_per_person on restore — by the space creator (created_by), under the same
 * lock as creation: otherwise the archive would bypass the limit. No creator (panel, org table) —
 * no limit. Called in the restore transaction; exceeded — a refusal, the row does not change.
 */
export async function unarchiveLimit(app: App, q: Q, spaceId: string): Promise<void> {
  const by = (await q.query("SELECT created_by FROM spaces WHERE id = $1", [spaceId])).rows[0]?.created_by as string | null | undefined;
  if (!by) return;
  await q.query("SELECT pg_advisory_xact_lock(hashtext('spaces_by:' || $1))", [by]);
  const max = projectsLimit(app);
  const created = (await q.query(
    `SELECT count(*)::int AS n FROM spaces
     WHERE created_by = $1 AND instance_id = $2 AND kind IN ('team','project') AND org_unit_id IS NULL AND archived_at IS NULL`, [by, app.instanceId])).rows[0].n as number;
  if (created >= max)
    throw invalid(`The project creator already has ${created} active spaces (limit ${max}). Restore it from archive after one of those spaces is archived or the memory administrator raises the limit`,
                  { limit: { setting: "limits.projects_per_person", max, created } });
}

/**
 * After a restore from the archive — pending meeting participants: a meeting whose tree touches this space
 * waited in the archive (grantPendingMeetings grants nothing into it). Whoever has a card (active, not demo) gets the meeting
 * at once, not at the next sign-in or people upload. The number of granted meetings; granting is idempotent.
 */
export async function grantPendingAfterUnarchive(app: App, spaceId: string, caller: Caller | null): Promise<number> {
  const logins = new Set<string>();
  for (const cls of ["open", "closed"] as const) {
    const rows = (await app.db.recordsForWrite(cls, "T0").query(
      `WITH RECURSIVE up AS (SELECT id, parent_id FROM records WHERE space_id = $1 AND deleted_at IS NULL
                             UNION SELECT r.id, r.parent_id FROM records r JOIN up ON r.id = up.parent_id)
       SELECT DISTINCT lower(e->>'login') AS login
       FROM records r JOIN up ON up.id = r.id
       CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.attrs->'participants_pending') = 'array' THEN r.attrs->'participants_pending' ELSE '[]'::jsonb END) e
       WHERE r.source_kind = 'transcriber' AND r.deleted_at IS NULL`, [spaceId])).rows;
    for (const r of rows) if (r.login) logins.add(r.login as string);
  }
  if (!logins.size) return 0;
  const people = (await app.db.control.query(
    "SELECT id, login FROM people WHERE instance_id = $1 AND active AND COALESCE(attrs->>'demo','') <> 'true' AND lower(login) = ANY($2::text[])",
    [app.instanceId, [...logins]])).rows as Array<{ id: string; login: string }>;
  return people.length ? grantPendingMeetings(app, people, "space_unarchive", caller) : 0;
}

/**
 * After a restore — granting to pending meeting participants (grantPendingAfterUnarchive) and reconciling the space's groups
 * with the directory at once: the cache of the archived space may be stale. Only with the directory on (otherwise syncGroups
 * refuses ldap_disabled); a failure or busy state goes to the log without content: the restore has already happened,
 * the next reconcile catches up the membership, the meetings — the next sign-in or people upload.
 */
export function syncAfterUnarchive(app: App, s: SpaceAccess, caller: Caller | null): void {
  void grantPendingAfterUnarchive(app, s.id, caller)
    .catch((e) => log.warn("space_unarchive_pending_grant_failed", { space: s.id, detail: clientText(e).slice(0, 200) }));
  if (!ldapConfig(app.settings).enabled) return;
  void syncGroups(app, { trigger: "owner", space: { ...s, archived_at: null, archived_by: null }, caller })
    .catch((e) => log.warn("space_unarchive_group_sync_failed", { space: s.id, code: e instanceof MemoryError ? e.code : (e as { code?: string })?.code ?? "error", detail: clientText(e).slice(0, 200) }));
}

// ---------------------------------------------------------------- workplace: the project owner
/**
 * A project the caller may archive or restore: only a person in the workplace, not a demo persona;
 * foreign and missing — not_found (an archived space is not visible to an outsider); not the owner — 403; personal, org,
 * department — 400; team — 400 (the administrator runs it in the panel).
 */
async function ownProject(app: App, caller: Caller, ref: string, what: string): Promise<SpaceAccess> {
  await requireHuman(app, caller, what, PROJECTS);
  if (caller.person!.demo) throw new MemoryError("forbidden", "The showcase demo persona cannot archive or restore spaces");
  const s = await resolveWithArchive(app, caller, ref);
  if (!s) throw notFound();
  if (s.role !== "owner") throw new MemoryError("forbidden", `${what}: only the owner of space ${s.slug} can do this`);
  const why = unmanageableWhy(s);
  if (why) throw invalid(why);
  if (s.kind !== "project")
    throw invalid("The memory administrator archives and restores team spaces under “Spaces” in the admin panel. Only projects can be archived and restored in the workspace");
  return s;
}

/**
 * POST /me/spaces/{slug}/archive: the owner archives the project with its records. A repeat — the same card without
 * a second event. A service's write space — 400: the service would stop writing meetings.
 */
export async function archiveMySpace(app: App, caller: Caller, ref: string) {
  const s = await ownProject(app, caller, ref, "Archive project");
  if (s.archived_at) return spaceCard(app, s);
  const svc = (await app.db.control.query("SELECT name FROM services WHERE write_space_id = $1 ORDER BY name LIMIT 1", [s.id])).rows[0]?.name as string | undefined;
  if (svc) throw invalid(`Service ${svc} saves meetings here (the service’s write space). The memory administrator must assign it another space in the admin panel first`);
  const out = await tx(app.db.control, async (q) => {
    const ch = await setArchived(q, app.instanceId, s.id, true, caller.person!.id);
    return ch ? { ch, records: await liveRecords(q, s.id) } : null;
  });
  if (out) await audit(app, caller, { event_type: "admin", space_id: s.id, details: {
    op: "space_archive", slug: s.slug, via: "owner", records: out.records,
    ...(out.ch.removed.length ? { members_removed: out.ch.removed.length, ...peopleOf({ added: [], removed: out.ch.removed }) } : {}) } });
  const after = await resolveWithArchive(app, caller, s.slug);
  return spaceCard(app, after ?? s);
}

/**
 * POST /me/spaces/{slug}/unarchive: the owner restores the project. A repeat — the same card without an event. The limit
 * of projects — by the creator (unarchiveLimit); membership — a recount in one transaction, then a directory group reconcile.
 */
export async function unarchiveMySpace(app: App, caller: Caller, ref: string) {
  const s = await ownProject(app, caller, ref, "Restore project from archive");
  if (!s.archived_at) return spaceCard(app, s);
  const out = await tx(app.db.control, async (q) => {
    await lockReconcile(q, app.instanceId);              // the lock order as when the panel archives: reconcile, then the limit
    await unarchiveLimit(app, q, s.id);
    const ch = await setArchived(q, app.instanceId, s.id, false, null);
    return ch ? { ch, records: await liveRecords(q, s.id) } : null;
  });
  if (out) {
    await audit(app, caller, { event_type: "admin", space_id: s.id, details: {
      op: "space_unarchive", slug: s.slug, via: "owner", records: out.records, members_added: out.ch.added.length, members_removed: out.ch.removed.length, ...peopleOf(out.ch) } });
    syncAfterUnarchive(app, s, caller);
  }
  const after = await resolveWithArchive(app, caller, s.slug);
  return spaceCard(app, after ?? s);
}

// ---------------------------------------------------------------- list: projects and archive
/**
 * How many records of the space the caller sees (the visibility builder, filter in the space): closed ones the key does not
 * read and foreign meetings with the people audience are not counted (a direct locator count revealed their number).
 */
export async function visibleRecords(app: App, caller: Caller, spaceId: string): Promise<number> {
  const spec = listingSpec(app, caller, [spaceId]);
  let n = 0;
  for (const cls of caller.scope.classes) {
    const args: unknown[] = [], bind = binder(args);
    const vis = visibleSql(spec, cls, bind);
    if (vis === null) continue;
    n += (await app.db.records(cls, caller.scope).query(`SELECT count(*)::int AS n FROM records_live r WHERE ${vis} AND r.space_id = ${bind(spaceId)}`, args)).rows[0].n as number;
  }
  return n;
}

/** Archived spaces with live records among the data (A ∩ S_all) — in access.ts: memory_me, search and list use it. */
export { archivedWithRecords };

/**
 * GET /me/spaces: spaces the person reads, page by page. archived=false — active (by slug);
 * archived=true — archived projects and team spaces with records, newest archives first. Each has a card (MySpace) and the number
 * of records visible to the caller.
 */
export async function listMySpaces(app: App, caller: Caller, o: { archived: boolean; limit: number; cursor?: string | null }) {
  if (!caller.person) throw notFound();
  const offset = offsetCursor(o.cursor);
  const all = [...(await readableSpaces(app, caller, { archived: o.archived })).values()];
  let picked: SpaceAccess[];
  if (o.archived) {
    const a = await archivedWithRecords(app, all.filter((s) => s.archived_at).map((s) => s.id));
    picked = all.filter((s) => a.has(s.id))
      .sort((x, y) => new Date(y.archived_at!).getTime() - new Date(x.archived_at!).getTime() || x.slug.localeCompare(y.slug));
  } else picked = all.filter((s) => !s.archived_at).sort((x, y) => x.slug.localeCompare(y.slug));
  const page = picked.slice(offset, offset + o.limit);
  const items = [];
  for (const s of page) items.push({ ...(await spaceCard(app, s)), counts: { records: await visibleRecords(app, caller, s.id) } });
  return { items, next_cursor: picked.length > offset + o.limit ? String(offset + o.limit) : null };
}
