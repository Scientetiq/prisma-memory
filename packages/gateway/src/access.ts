// Rights: checked on every read against live tables; indexes and caches are no source of rights.
// The order for a record by id: locator in control → class → (only if the class is allowed to the key) record base → scope.
// A T2-level key does not touch the closed base even to check existence; another's = nonexistent.
import type pg from "pg";
import { archivedDenied, CHAIN_HEAD, inProgress, isChainType, log, notFound, slugify, newId, tx, type DataClass, type MemoryError, type VisibilitySpec } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { audit } from "./audit.ts";
import { byIdSpec, classAllowed, listingSpec, recordVisible } from "./visibility.ts";
import { heldFromReader } from "./org-hold.ts";

/** Space kind; project — a project space, made by an employee in the workplace. */
export type SpaceKind = "personal" | "team" | "org" | "project";

export interface SpaceAccess {
  id: string; slug: string; kind: SpaceKind; name: string; description: string | null; owner_id: string | null;
  default_class: DataClass; readme: string | null; org_unit_id: string | null;
  role: "owner" | "member" | "reader";
  /** On what basis access is given — for explainability (GET /api/v1/me/access); group — a directory group. */
  via: "personal" | "org" | "manual" | "org_unit" | "grant" | "group";
  grant_id: string | null; expires_at: Date | null;
  /**
   * An archived space: read-only. Present only in the maps of `readableSpaces(…, {archived: true})` —
   * the default map holds no archived ones; no field or null — the space is active.
   */
  archived_at?: Date | null;
  /** Who archived it (people.id) in the workplace; null — the panel, a dismissal, or an older archive. */
  archived_by?: string | null;
}

/**
 * An archived space with live records (the set A): a project or a team space without a department, which
 * has a non-deleted locator. Only it drops out of the default search and keeps its make-up by directory groups (the sync
 * only narrows it); empty archives and the dismissed's personal spaces are not in it. `alias` — the query's alias of spaces.
 */
export const archivedWithRecordsSql = (alias: string): string =>
  `(${alias}.archived_at IS NOT NULL AND ${alias}.kind IN ('team','project') AND ${alias}.org_unit_id IS NULL
    AND EXISTS (SELECT 1 FROM record_locations al WHERE al.space_id = ${alias}.id AND NOT al.deleted))`;

/**
 * The membership cache under the DN of binding `alias` belongs to another group: the same DN in instance `$1` has a binding with
 * another objectGUID, synced later. synced_at — when the sync last wrote the group's members (ok) or confirmed it
 * (too_large); "group gone" and a directory failure (error) do not move it — so the second binding's status does not matter:
 * its group gone or the directory silent, the cache under the DN is still its. A binding without objectGUID (older) stays in.
 */
export const GROUP_CACHE_TAKEN_SQL = (alias: string): string =>
  `EXISTS (SELECT 1 FROM space_groups g2 JOIN spaces s2 ON s2.id = g2.space_id AND s2.instance_id = $1
            WHERE g2.group_key = ${alias}.group_key AND g2.id <> ${alias}.id
              AND ${alias}.group_guid IS NOT NULL AND g2.group_guid IS NOT NULL AND g2.group_guid <> ${alias}.group_guid
              AND g2.synced_at > COALESCE(${alias}.synced_at, '-infinity'::timestamptz))`;

/**
 * The instance's set A: ids of archived projects and team spaces with live records — the exclude mode of the answer. One query to
 * control; almost always a handful. Whose it is does not matter: the condition only cuts off (an author does not find their own
 * in another's archive by default search); the make-up of A is not given to the caller.
 */
export async function archivedSpaceIds(app: Pick<App, "db" | "instanceId">): Promise<string[]> {
  const { rows } = await app.db.control.query(`SELECT s.id FROM spaces s WHERE s.instance_id = $1 AND ${archivedWithRecordsSql("s")}`, [app.instanceId]);
  return rows.map((r) => r.id as string);
}

/** The archived ones with live records among the given (A ∩ ids): "Archive", counts and hints — without old empty archives. */
export async function archivedWithRecords(app: Pick<App, "db">, ids: readonly string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const { rows } = await app.db.control.query(`SELECT s.id FROM spaces s WHERE s.id = ANY($1::uuid[]) AND ${archivedWithRecordsSql("s")}`, [ids]);
  return new Set(rows.map((r) => r.id as string));
}

/**
 * The archive of a record's home: a project or team space in the archive — {slug, archived_at}, else null. From the map if
 * the space is there (archived_at of a map with the archive); a control query only otherwise (the author, no longer a member).
 */
export async function spaceArchived(app: Pick<App, "db">, spaceId: string, spaces?: ReadonlyMap<string, SpaceAccess>): Promise<{ slug: string; archived_at: Date } | null> {
  const s = spaces?.get(spaceId);
  if (s) return s.archived_at && (s.kind === "team" || s.kind === "project") ? { slug: s.slug, archived_at: s.archived_at } : null;
  return archivedTeamSpace(app.db.control, [spaceId]);
}

/** An archived project or team space among the given (the first) — for the "the archive only narrows" refusals. */
export async function archivedTeamSpace(q: Pick<pg.Pool, "query">, ids: readonly (string | null | undefined)[]): Promise<{ id: string; slug: string; archived_at: Date } | null> {
  return [...(await archivedTeamSpaces(q, ids)).values()][0] ?? null;
}

/** All archived project and team spaces among the given (id → slug, archived_at; by slug): the "only narrows" check for each. */
export async function archivedTeamSpaces(q: Pick<pg.Pool, "query">, ids: readonly (string | null | undefined)[]): Promise<Map<string, { id: string; slug: string; archived_at: Date }>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (!list.length) return new Map();
  const { rows } = await q.query("SELECT id, slug, archived_at FROM spaces WHERE id = ANY($1::uuid[]) AND archived_at IS NOT NULL AND kind IN ('team','project') ORDER BY slug", [list]);
  return new Map(rows.map((r) => [r.id as string, r as { id: string; slug: string; archived_at: Date }]));
}

/**
 * The people list of a record in an archived space: it only narrows — people can be removed,
 * not added. A refusal — class_denied with details.archived; no mail goes to participants (the refusal comes before applying).
 */
export const peopleOnlyNarrow = (a: { slug: string; archived_at: Date | string }): MemoryError => {
  const since = new Date(a.archived_at).toISOString().slice(0, 10);
  return archivedDenied(a.slug, a.archived_at,
    `The record is in archived space ${a.slug} (archived since ${since}). You can remove readers, but you cannot add them. Ask the project owner or memory administrator to restore the space from archive first.`);
};

/**
 * A new reader circle of a meeting and its derived records where the record lies in an archived project or team space:
 * for EACH such record — only a subset of the present one (its people and owner); else an archive refusal. All
 * archived spaces of the tree count, not the first (meeting versions may be in different projects, a decision in another).
 * Called by PUT /ingest/access (rest.ts) and the meeting participants edit (meetings.ts applyParticipants). `control` — under
 * the record locks, the connection of the lock transaction (the holder of a control connection takes no second).
 */
export async function archivedOnlyNarrows(app: Pick<App, "db">, q: { query: (sql: string, v: unknown[]) => Promise<{ rows: any[] }> }, tree: string[], ids: string[], ownerId: string,
                                          control: Pick<pg.Pool, "query"> = app.db.control): Promise<void> {
  if (!tree.length) return;
  const homes = (await q.query("SELECT id, space_id FROM records WHERE id = ANY($1::uuid[])", [tree])).rows as Array<{ id: string; space_id: string }>;
  const arch = await archivedTeamSpaces(control, homes.map((x) => x.space_id));
  const inArch = homes.filter((x) => arch.has(x.space_id));
  if (!inArch.length) return;
  const people = new Map<string, Set<string>>(inArch.map((x) => [x.id, new Set([ownerId])]));
  for (const r of (await q.query("SELECT record_id, person_id FROM record_people WHERE record_id = ANY($1::uuid[])", [inArch.map((x) => x.id)])).rows) people.get(r.record_id)?.add(r.person_id);
  const grows = inArch.find((x) => ids.some((id) => !people.get(x.id)!.has(id)));
  if (grows) throw peopleOnlyNarrow(arch.get(grows.space_id)!);
}

const RANK = { reader: 1, member: 2, owner: 3 } as const;

/**
 * The join condition "the owner of space s — person p (= owner_id) — is in force" for showing the owner (the space
 * card, the panel list). Outside departments — always (a dismissed one is shown with active: false). For
 * a department space — if p has an active owner row
 * (the head by the HR list or appointed by the administrator) or p is dismissed; a working removed head whom
 * owner_id still remembers has no owner rights — and is not called the owner.
 */
export const OWNER_IN_FORCE_SQL = `(s.org_unit_id IS NULL OR NOT p.active
  OR EXISTS (SELECT 1 FROM space_members_effective eo WHERE eo.space_id = s.id AND eo.person_id = p.id AND eo.role = 'owner'))`;

/**
 * The spaces the person reads now. A service without a person reads nothing. By default only
 * active ones (all the old calls); `{archived: true}` — plus archived projects and team spaces where the person is a member or
 * owner by membership (personal and org — never): reads by id, an explicit path, a write with an archive refusal.
 * The list of calls with the archive is kept by a guard test.
 */
export async function readableSpaces(app: App, caller: Caller, o: { archived?: boolean } = {}): Promise<Map<string, SpaceAccess>> {
  const out = new Map<string, SpaceAccess>();
  if (!caller.person) return out;
  // a personal space is read only by its owner: a membership row in it has no force (an assignment to a personal slug used to give owner).
  // The rule "everyone reads the organizational one" acts only for an ACTIVE person and not for a showcase demo persona:
  // otherwise an administrator via "view as" got a live read of the real org, and the card of a dismissed one promised them org.
  const { rows } = await app.db.control.query(
    `SELECT s.id, s.slug, s.kind, s.name, s.description, s.owner_id, s.default_class, s.readme, s.org_unit_id, s.archived_at, s.archived_by,
            m.role AS m_role, m.source AS m_source, m.grant_id, m.expires_at
     FROM spaces s
     LEFT JOIN space_members_effective m ON m.space_id = s.id AND m.person_id = $1 AND s.kind <> 'personal'
     CROSS JOIN (SELECT active, COALESCE(attrs->>'demo','') = 'true' AS demo FROM people WHERE id = $1) me
     WHERE s.instance_id = $2 AND (s.archived_at IS NULL OR ($3::boolean AND s.kind IN ('team','project')))
       AND ((s.kind = 'personal' AND s.owner_id = $1) OR (s.kind = 'org' AND me.active AND NOT me.demo) OR m.person_id IS NOT NULL)`,
    [caller.person.id, app.instanceId, o.archived === true]);
  for (const r of rows) {
    let role: SpaceAccess["role"], via: SpaceAccess["via"];
    if (r.kind === "personal") { role = "owner"; via = "personal"; }
    else if (r.m_role) { role = r.m_role; via = r.m_source === "org" ? "org_unit" : r.m_source === "grant" ? "grant" : r.m_source === "group" ? "group" : "manual"; }
    else { role = "reader"; via = "org"; }                      // every active person of the instance reads org — computed
    // the space owner (including the organizational one, if the administrator appointed them) has the owner role. Except a
    // department space: it is run by the active head by the HR list
    // (a derived owner row) or by the one the administrator appointed (a manual owner row); owner_id there only remembers
    // the previous head if there is no new one — a removed head at once becomes an ordinary member
    if (r.owner_id !== null && r.owner_id === caller.person.id && r.org_unit_id === null && RANK[role] < RANK.owner) role = "owner";
    out.set(r.id, { id: r.id, slug: r.slug, kind: r.kind, name: r.name, description: r.description, owner_id: r.owner_id, default_class: r.default_class,
                    readme: r.readme, org_unit_id: r.org_unit_id, role, via, grant_id: r.grant_id ?? null, expires_at: r.expires_at ?? null,
                    archived_at: r.archived_at ?? null, archived_by: r.archived_by ?? null });
  }
  return out;
}

/**
 * Reverse visibility for the derivation gate: S_p ∩ C for many people in one query. The rule
 * is the same as `readableSpaces(p, {archived: true})` (the guard test derivation-pg matches them on random data): personal —
 * the owner only, org — an active non-demo person, team and project (and archived ones) — active membership. Empty inputs —
 * an empty map without a query.
 */
export async function spacesOfMany(app: App, personIds: readonly string[], candidates: readonly string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (!personIds.length || !candidates.length) return out;
  const { rows } = await app.db.control.query(
    `SELECT DISTINCT p.id AS person_id, s.id AS space_id
     FROM people p
     JOIN spaces s ON s.instance_id = $3 AND s.id = ANY($2::uuid[]) AND (s.archived_at IS NULL OR s.kind IN ('team','project'))
     LEFT JOIN space_members_effective m ON m.space_id = s.id AND m.person_id = p.id AND s.kind <> 'personal'
     WHERE p.id = ANY($1::uuid[])
       AND ((s.kind = 'personal' AND s.owner_id = p.id) OR (s.kind = 'org' AND p.active AND COALESCE(p.attrs->>'demo','') <> 'true') OR m.person_id IS NOT NULL)`,
    [[...new Set(personIds)], [...new Set(candidates)], app.instanceId]);
  for (const r of rows) {
    let set = out.get(r.person_id);
    if (!set) out.set(r.person_id, (set = new Set()));
    set.add(r.space_id);
  }
  return out;
}

/** Readers of a space for the derivation gate: personal — the owner; org — "all active non-demo" (not listed); else — active members. */
export type SpaceReaders = { kind: "self"; owner: string | null } | { kind: "all_org" } | { kind: "list"; ids: string[] };

export async function spaceReaders(app: App, s: { id: string; kind: SpaceKind; owner_id: string | null }): Promise<SpaceReaders> {
  if (s.kind === "personal") return { kind: "self", owner: s.owner_id };
  if (s.kind === "org") return { kind: "all_org" };
  const { rows } = await app.db.control.query("SELECT DISTINCT person_id FROM space_members_effective WHERE space_id = $1", [s.id]);
  return { kind: "list", ids: rows.map((r) => r.person_id as string) };
}

/** `me`, `org` or a slug → a space among the readable ones. Another's and a nonexistent one are indistinguishable: null. */
export async function resolveSpace(app: App, caller: Caller, ref: string, spaces?: Map<string, SpaceAccess>): Promise<SpaceAccess | null> {
  const all = spaces ?? (await readableSpaces(app, caller));
  for (const s of all.values()) {
    if (ref === "me" ? s.kind === "personal" && s.owner_id === caller.person?.id : ref === "org" ? s.kind === "org" : s.slug === ref) return s;
  }
  return null;
}

/** Does the member write: role owner or member and the space not archived (defence in depth for maps with the archive). */
export const canWrite = (s: SpaceAccess): boolean => !s.archived_at && (s.role === "owner" || s.role === "member");

/**
 * A service's write space: the transcriber's test circuit writes only there. The administrator assigned
 * it to the service explicitly — so the write needs no on-behalf person's membership; an archived one does not write (null).
 */
export async function serviceWriteSpace(app: App, caller: Caller): Promise<SpaceAccess | null> {
  const id = caller.service?.write_space_id;
  if (!id) return null;
  const r = (await app.db.control.query(
    "SELECT id, slug, kind, name, description, owner_id, default_class, readme, org_unit_id FROM spaces WHERE id = $1 AND instance_id = $2 AND archived_at IS NULL",
    [id, app.instanceId])).rows[0];
  return r ? { ...r, role: "member", via: "manual", grant_id: null, expires_at: null } : null;
}

// ---------------------------------------------------------------- records
/**
 * `open_check` — the mark of the personal-open fallback path: only on a closed record (with `class = open`
 * null is returned even if the column is not cleared); it may be given only to the record's author.
 */
export interface Locator { record_id: string; class: DataClass; space_id: string; type: string; owner_id: string; deleted: boolean; created_at: Date | null; open_check: unknown }

/** `control` — the connection held under the record lock (startOpenMove): no second pool connection while the first is busy. */
export async function locate(app: App, id: string, control: Pick<pg.Pool, "query"> = app.db.control): Promise<Locator | null> {
  const { rows } = await control.query(
    "SELECT record_id, class, space_id, type, owner_id, deleted, created_at, CASE WHEN class = 'closed' THEN open_check END AS open_check FROM record_locations WHERE record_id = $1", [id]);
  return rows[0] ?? null;
}

export interface RecordRow {
  id: string; type: string; class: DataClass; space_id: string; audience: "space" | "people"; owner_id: string; source_kind: string; source_ref: string | null;
  parent_id: string | null; locator: Record<string, unknown> | null; method: string; origin: string; confirmed_at: Date | null; occurred_at: Date; ingested_at: Date;
  title: string | null; summary_line: string | null; event_kind: string | null; domain_tags: string[]; token_count: number | null; version: number;
  event_key?: string | null;
  supersedes_id: string | null; is_current: boolean; processor: Record<string, unknown> | null; attrs: Record<string, any>; deleted_at: Date | null;
}

// The record visibility rule is one builder: the core `@memory/shared` visibility.ts, the wrapper ./visibility.ts.
// Re-exported so the old imports from access.ts work; the dependency goes one way (visibility.ts does not import access.ts).
export { classAllowed, classGate, gateOf, hiddenClosedSql, recordVisible, byIdSpec, listingSpec, authorRule } from "./visibility.ts";

/**
 * The caller's visibility spec together with the spaces they read now: `byId` — the reference of a read by id
 * (the author — always), else a selection (the author rule from `access.author_rule`) with the "in space" filter `scope`.
 */
export async function visibilityFor(app: App, caller: Caller, o: { scope?: readonly string[] | null; spaces?: Map<string, SpaceAccess>; byId?: boolean } = {})
  : Promise<{ spec: VisibilitySpec; spaces: Map<string, SpaceAccess> }> {
  // by id — S_all (the archive is read by id without a filter); selections without their own map — active ones
  const spaces = o.spaces ?? (await readableSpaces(app, caller, { archived: o.byId === true }));
  return { spaces, spec: o.byId ? byIdSpec(caller, spaces) : listingSpec(app, caller, spaces, o.scope ?? null) };
}

/**
 * A record for a read by id. Versions that stopped being current are read by id; deleted ones are not. The default map is
 * with the archive: a member of an archived space reads its records by id; a write there is refused by its own check.
 */
export async function loadReadable(app: App, caller: Caller, id: string, spaces?: Map<string, SpaceAccess>): Promise<{ rec: RecordRow; db: pg.Pool; spaces: Map<string, SpaceAccess> }> {
  const loc = await locate(app, id);
  // another's closed class is refused to an extended key by the locator — the closed base is not opened at all
  if (!loc || loc.deleted || !caller.scope.classes.includes(loc.class) || !classAllowed(caller, loc.class, loc.owner_id)) throw notFound();   // vis-ok: gates of visibility.ts
  const all = spaces ?? (await readableSpaces(app, caller, { archived: true }));
  const db = app.db.records(loc.class, caller.scope);
  // hidden_at — rows of an unfinished class move: nobody reads them, as in records_live
  const { rows } = await db.query("SELECT * FROM records WHERE id = $1 AND deleted_at IS NULL AND hidden_at IS NULL", [id]);
  const rec: RecordRow | undefined = rows[0];
  if (!rec) {
    // the locator is switched but the rows still move (or the reverse) — a class move in progress; for an old note version
    // the move is set on the chain head (closing hides the rows of the whole chain)
    if ((await moveInFlight(app, id) || (isChainType(loc.type) && await headMoveInFlight(app, db, id))) && (loc.owner_id === caller.person?.id || all.has(loc.space_id))) throw inProgress();
    throw notFound();
  }
  if (!(await recordVisible(db, caller, rec, all))) throw notFound();
  // the "Wrong / not for everyone" hold in org: by id only the author and people in the workplace read
  if (await heldFromReader(app, caller, db, rec)) throw notFound();
  if (await moveInFlight(app, id)) throw inProgress();
  // an old version of one's note moves together with the chain head — one request, on the head
  // (openTarget, closeMove). While it runs, the old version gets the same answer as the head: "moving", not the old class
  // — otherwise the workplace, waiting for the showing to end on the old version, took the closed class for a worker refusal
  if (rec.is_current === false && isChainType(rec.type) && await headMoveInFlight(app, db, id)) throw inProgress();
  return { rec, db, spaces: all };
}

export async function moveInFlight(app: App, recordId: string): Promise<boolean> {
  const { rowCount } = await app.db.control.query("SELECT 1 FROM class_moves WHERE record_id = $1 AND status IN ('pending','copying','verifying')", [recordId]);
  return (rowCount ?? 0) > 0;
}

/**
 * Is a class move of the head of record `id`'s version chain running. The head — by the record's class base (CHAIN_HEAD; hidden
 * rows of a running closing are there); a record without a chain is its own head, with no second control query. The
 * source rows are already deleted by the worker (the last milliseconds of the move) — the head cannot be found: false, as before.
 */
async function headMoveInFlight(app: App, db: Pick<pg.Pool, "query">, id: string): Promise<boolean> {
  const head = (await db.query(CHAIN_HEAD, [id])).rows[0]?.id as string | undefined;
  return !!head && head !== id && await moveInFlight(app, head);
}

// ---------------------------------------------------------------- role model: compiled into membership
/**
 * Sync of derived membership: the org table (source = org), active grants (source = grant) and directory groups
 * bound to spaces (source = group) → space_members. Manual rows are not touched. Called in the same transaction as the org table load and the grant issue/revoke,
 * so a transfer, dismissal and revoke act without a separate delay.
 */
export interface AccessSummary { spaces_created: string[]; added: number; removed: number; orphaned_spaces: string[] }

/**
 * The membership sync lock until the end of the transaction: two simultaneous syncs (an org table load and a grant issue) do not
 * remove each other's fresh rows. Whoever compares membership "before" and "after" its sync (directory groups) takes
 * it before the first snapshot: otherwise the difference picks up the changes of another sync committed while it waited.
 * In the same transaction it is taken again without waiting.
 */
export async function lockReconcile(c: Pick<pg.PoolClient, "query">, instanceId: string): Promise<void> {
  await c.query("SELECT pg_advisory_xact_lock(hashtext('reconcile:' || $1))", [instanceId]);
}

export async function reconcileAccess(c: pg.PoolClient, instanceId: string, autoCreateSpaces: boolean): Promise<AccessSummary> {
  await lockReconcile(c, instanceId);
  const created: string[] = [];
  if (autoCreateSpaces) {
    const { rows: units } = await c.query(
      `SELECT u.id, u.code, u.name,
              (SELECT pu.person_id FROM person_org_units pu JOIN people p ON p.id = pu.person_id AND p.active
               WHERE pu.org_unit_id = u.id AND pu.relation = 'head' ORDER BY pu.created_at LIMIT 1) AS head_id
       FROM org_units u
       WHERE u.instance_id = $1 AND u.active AND NOT EXISTS (SELECT 1 FROM spaces s WHERE s.org_unit_id = u.id)
         AND EXISTS (SELECT 1 FROM person_org_units pu JOIN people p ON p.id = pu.person_id AND p.active WHERE pu.org_unit_id = u.id)`, [instanceId]);
    for (const u of units) {
      if (!u.head_id) continue;                                 // a space must have a human owner; without a head — not created
      const slug = await insertSpace(c, { id: newId(), kind: "team", name: u.name, description: "Department space: membership comes from the org table", owner_id: u.head_id,
                                          instance_id: instanceId, default_class: "closed", org_unit_id: u.id, created_via: "org_table" },
                                     slugCandidates(`dep-${slugify(u.code, "unit")}`.slice(0, 60)));
      if (slug) created.push(slug);
    }
  }
  // the owner of a department space is the active head
  await c.query(
    `UPDATE spaces s SET owner_id = h.person_id
     FROM (SELECT DISTINCT ON (pu.org_unit_id) pu.org_unit_id, pu.person_id FROM person_org_units pu JOIN people p ON p.id = pu.person_id AND p.active
           WHERE pu.relation = 'head' ORDER BY pu.org_unit_id, pu.created_at) h
     WHERE s.org_unit_id = h.org_unit_id AND s.instance_id = $1 AND s.owner_id <> h.person_id`, [instanceId]);

  // the wanted derived membership: the strongest role per pair (space, person)
  await c.query("CREATE TEMP TABLE desired_members (space_id uuid, person_id uuid, role text, source text, grant_id uuid, expires_at timestamptz) ON COMMIT DROP");
  await c.query(
    `INSERT INTO desired_members
     SELECT s.id, pu.person_id, CASE pu.relation WHEN 'head' THEN 'owner' ELSE 'member' END, 'org', NULL, NULL
     FROM person_org_units pu JOIN spaces s ON s.org_unit_id = pu.org_unit_id AND s.instance_id = $1 AND s.archived_at IS NULL
     JOIN people p ON p.id = pu.person_id AND p.active`, [instanceId]);
  await c.query(
    `WITH RECURSIVE branch AS (
       SELECT g.id AS grant_id, u.id AS unit_id FROM role_grants g JOIN org_units u ON u.instance_id = g.instance_id AND u.code = g.scope_ref
       WHERE g.scope_kind IN ('org_unit','org_branch')
       UNION
       SELECT b.grant_id, ch.id FROM branch b JOIN role_grants g ON g.id = b.grant_id AND g.scope_kind = 'org_branch' JOIN org_units ch ON ch.parent_id = b.unit_id
     ), target AS (
       SELECT b.grant_id, s.id AS space_id FROM branch b JOIN spaces s ON s.org_unit_id = b.unit_id
       UNION SELECT g.id, s.id FROM role_grants g JOIN spaces s ON s.instance_id = g.instance_id AND s.org_unit_id IS NOT NULL WHERE g.scope_kind = 'company'
       -- the space scope covers only team spaces and projects: only the owner reads a personal space, and everyone reads the
       -- organization space anyway. Scopes wider than a space (company, org_unit, org_branch) do not apply to projects — above
       -- them they go only into the department spaces
       UNION SELECT g.id, s.id FROM role_grants g JOIN spaces s ON s.instance_id = g.instance_id AND s.slug = g.scope_ref AND s.kind IN ('team','project') WHERE g.scope_kind = 'space'
       -- the curator of the company space is the owner of org by assignment; for other roles org is never a scope
       UNION SELECT g.id, s.id FROM role_grants g JOIN spaces s ON s.instance_id = g.instance_id AND s.slug = g.scope_ref AND s.kind = 'org'
             WHERE g.scope_kind = 'space' AND g.role_code = 'org_curator'
     )
     INSERT INTO desired_members
     -- space_reader always compiles to reader: the assignment’s actions (edit/upload) concern the portal tools, not writing to the memory
     SELECT t.space_id, g.person_id, CASE WHEN r.memory_effect = 'space_owner' THEN 'owner' ELSE 'reader' END, 'grant', g.id, g.valid_to
     FROM target t JOIN role_grants g ON g.id = t.grant_id JOIN roles r ON r.code = g.role_code AND r.active JOIN people p ON p.id = g.person_id AND p.active
     WHERE g.instance_id = $1 AND g.revoked_at IS NULL AND g.valid_from <= now() AND (g.valid_to IS NULL OR g.valid_to > now())
       AND r.memory_effect IN ('space_owner','space_reader')
       -- the archive only narrows: a row is held only by an assignment that was already in force at archiving, and only
       -- if the person has a derived row. An assignment that became effective later (valid_from in the future; a new one in an
       -- archived space is rejected anyway) does not pick up a row of another basis: after it ended no access would remain
       -- (grant → group and back)
       AND NOT EXISTS (SELECT 1 FROM spaces xs WHERE xs.id = t.space_id AND xs.archived_at IS NOT NULL
                         AND NOT (g.created_at <= xs.archived_at AND g.valid_from <= xs.archived_at
                                  AND EXISTS (SELECT 1 FROM space_members x WHERE x.space_id = t.space_id AND x.person_id = g.person_id AND x.source <> 'manual')))`, [instanceId]);
  // a directory group bound to a space: the group members by the membership cache —
  // members or readers, as the owner chose. Only a project and a team space without a department: a row in a space of another
  // kind (personal — trigger of 05-access-model.sql, org, department) would drop the whole sync, with it the org table load and
  // grant issuing. The dismissed and demo personas get no membership; a too_large or missing group — the cache for
  // it did not change, the make-up is frozen. An archived one with records is only narrowed: one who left the group and
  // the dismissed are removed, a new member is not added — the wanted set holds only pairs that already have a row EXACTLY
  // by the group: a grant row does not turn into a group row, otherwise one who joined the group after
  // archiving would read the archive even after the grant ended. The flip side: there is one row per
  // pair — a group member whose row is written by a grant loses the archive when the grant ends. An empty archive — as before:
  // membership by groups is removed.
  // A group by objectGUID (under an old DN another group does not stand in for one's own): the membership cache is shared per DN,
  // so binding g gives no membership if the same DN has a binding of another group (another objectGUID) synced later —
  // whatever its status (gone, directory failure): the cache is its now. So an empty project returned from the archive
  // after its group's DN was taken by another project does not get the people of a foreign group
  await c.query(
    `INSERT INTO desired_members
     SELECT g.space_id, d.person_id, g.role, 'group', NULL, NULL
     FROM space_groups g JOIN spaces s ON s.id = g.space_id AND s.instance_id = $1 AND s.kind IN ('team','project') AND s.org_unit_id IS NULL
     JOIN directory_group_members d ON d.instance_id = $1 AND d.group_key = g.group_key
     JOIN people p ON p.id = d.person_id AND p.active AND COALESCE(p.attrs->>'demo','') <> 'true'
     WHERE (s.archived_at IS NULL
            OR (${archivedWithRecordsSql("s")}
                AND EXISTS (SELECT 1 FROM space_members x WHERE x.space_id = s.id AND x.person_id = d.person_id AND x.source = 'group')))
       AND NOT ${GROUP_CACHE_TAKEN_SQL("g")}`, [instanceId]);

  // a department space with nobody left in the org table (a rename without department_code, a disbanding):
  // derived membership is not removed but fixed as manual — records must not become inaccessible to everyone
  const orphaned = await c.query(
    `UPDATE space_members m SET source = 'manual', grant_id = NULL, expires_at = NULL
     FROM spaces s WHERE s.id = m.space_id AND s.instance_id = $1 AND s.org_unit_id IS NOT NULL AND m.source = 'org'
       AND NOT EXISTS (SELECT 1 FROM desired_members d WHERE d.space_id = s.id AND d.source = 'org')
     RETURNING s.slug`, [instanceId]);
  const removed = await c.query(
    `DELETE FROM space_members m USING spaces s
     WHERE s.id = m.space_id AND s.instance_id = $1 AND m.source <> 'manual'
       AND NOT EXISTS (SELECT 1 FROM desired_members d WHERE d.space_id = m.space_id AND d.person_id = m.person_id)`, [instanceId]);
  // one row per pair: the strongest role, on a tie — the unlimited basis (a temporary grant over
  // a permanent group gave the row its own term otherwise, and at its end the person lost permanent access too), then the source
  const added = await c.query(
    `INSERT INTO space_members (space_id, person_id, role, source, grant_id, expires_at)
     SELECT DISTINCT ON (space_id, person_id) space_id, person_id, role, source, grant_id, expires_at FROM desired_members
     ORDER BY space_id, person_id, CASE role WHEN 'owner' THEN 3 WHEN 'member' THEN 2 ELSE 1 END DESC,
              expires_at DESC NULLS FIRST,
              CASE source WHEN 'org' THEN 3 WHEN 'grant' THEN 2 ELSE 1 END DESC
     ON CONFLICT (space_id, person_id) DO UPDATE
       SET role = EXCLUDED.role, source = EXCLUDED.source, grant_id = EXCLUDED.grant_id, expires_at = EXCLUDED.expires_at
       WHERE space_members.source <> 'manual'
          -- the current manager of a department who was earlier added by hand as a member or reader: in the department’s
          -- space only the membership row gives owner rights, owner_id no longer gives them
          -- — without replacing the row the new manager would stay a member
          OR (EXCLUDED.source = 'org' AND EXCLUDED.role = 'owner' AND space_members.role <> 'owner')
     RETURNING (xmax = 0) AS inserted`);
  await c.query("DROP TABLE desired_members");
  return { spaces_created: created, added: added.rows.filter((r) => r.inserted).length, removed: removed.rowCount ?? 0, orphaned_spaces: [...new Set(orphaned.rows.map((r) => r.slug as string))] };
}

// ---------------------------------------------------------------- end of temporary access
/** How many people to list in the recount event at the end of a term (as for the group sync). */
const EXPIRY_AUDIT_PEOPLE_MAX = 100;

/** Derived membership rows with an expired term: the space_members_effective view already hides them. */
const EXPIRED_SQL = `FROM space_members m JOIN spaces s ON s.id = m.space_id
  WHERE s.instance_id = $1 AND m.source <> 'manual' AND m.expires_at IS NOT NULL AND m.expires_at <= now()`;

/** The result of the recount at the end of a term: what became of the membership of each expired row (source null — removed). */
export interface ExpirySweep { expired: number; kept: number; removed: number; added: number; people: Array<{ space: string; person: string; source: string | null }> }

/**
 * End of temporary access (a grant with valid_to): an expired row is hidden at once, but membership on another basis
 * (a directory group, the org table, an unlimited grant) came back only with the next sync — in 15 minutes, and with
 * the directory off or unavailable — not at all. With expired rows — a membership recount
 * (reconcileAccess under the sync lock: gateways do not collide), whatever the directory does; afterwards there are no expired
 * rows: each is replaced by another basis or removed. No expired ones — null, the lock is not taken.
 */
export async function sweepExpiredAccess(app: App): Promise<ExpirySweep | null> {
  if (!(await app.db.control.query(`SELECT EXISTS (SELECT 1 ${EXPIRED_SQL}) AS any`, [app.instanceId])).rows[0]?.any) return null;
  const out = await tx(app.db.control, async (c): Promise<ExpirySweep | null> => {
    await lockReconcile(c, app.instanceId);
    const was = (await c.query(`SELECT m.space_id, s.slug, m.person_id ${EXPIRED_SQL}`, [app.instanceId])).rows as Array<{ space_id: string; slug: string; person_id: string }>;
    if (!was.length) return null;                                         // while we waited for the lock, another recounted
    const sum = await reconcileAccess(c, app.instanceId, false);
    const now = new Map<string, string>((await c.query(
      "SELECT space_id, person_id, source FROM space_members WHERE (space_id, person_id) IN (SELECT * FROM unnest($1::uuid[], $2::uuid[]))",
      [was.map((x) => x.space_id), was.map((x) => x.person_id)])).rows.map((r) => [`${r.space_id}:${r.person_id}`, r.source as string]));
    const people = was.map((x) => ({ space: x.slug, person: x.person_id, source: now.get(`${x.space_id}:${x.person_id}`) ?? null }));
    return { expired: was.length, kept: people.filter((x) => x.source).length, removed: sum.removed, added: sum.added, people };
  });
  if (!out) return null;
  // membership changed (an expired row replaced by another basis or removed) — a log event, as for the group sync timer
  await audit(app, null, { event_type: "admin", details: {
    op: "access_recount", trigger: "expiry", expired: out.expired, kept: out.kept, added: out.added, removed: out.removed,
    people: out.people.slice(0, EXPIRY_AUDIT_PEOPLE_MAX), ...(out.people.length > EXPIRY_AUDIT_PEOPLE_MAX ? { people_truncated: out.people.length } : {}) } });
  return out;
}

/**
 * The term-end tick: once a minute, independent of the directory (ldap.enabled and group_sync_minutes do not turn it off).
 * Ticks do not overlap; a failure goes to the log, the process does not fall.
 */
export function startAccessExpiry(app: App, tickMs = 60_000): NodeJS.Timeout {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await sweepExpiredAccess(app); }
    catch (e) { log.warn("access_expiry_sweep_failed", { error: String((e as Error)?.message ?? e).slice(0, 300) }); }
    finally { busy = false; }
  };
  const t = setInterval(() => void tick(), tickMs);
  t.unref();
  return t;
}

// ---------------------------------------------------------------- person card: shared org-table and directory sign-in steps
type Q = Pick<pg.PoolClient, "query">;

/** The personal space is created with the person: slug u-<login before the at sign>, on a clash — with a number. */
export async function ensurePersonalSpace(q: Q, instanceId: string, id: string, login: string, displayName: string): Promise<void> {
  if ((await q.query("SELECT 1 FROM spaces WHERE kind = 'personal' AND owner_id = $1", [id])).rowCount) return;
  await insertSpace(q, { id: newId(), kind: "personal", name: `Personal space · ${displayName}`, owner_id: id, instance_id: instanceId, default_class: "closed" },
                    slugCandidates(`u-${slugify(login.split("@")[0]!, "user")}`.slice(0, 60)));
}

// ---------------------------------------------------------------- space creation and the owner
/** Where a space was created from (spaces.created_via): the workplace, memory_space_create, the panel, the org table. */
export type SpaceCreatedVia = "workplace" | "mcp" | "admin" | "org_table";

export interface NewSpace {
  id: string; kind: SpaceKind; name: string; description?: string | null; owner_id: string | null; instance_id: string; default_class: DataClass;
  org_unit_id?: string | null;
  /** "More about the space": set only when a project is created in the workplace with the templates on. */
  readme?: string | null;
  /** Who created it (people.id); the panel administrator and the org table — null. */
  created_by?: string | null; created_via?: SpaceCreatedVia | null;
}

/** Slug candidates: base, then base-2, base-3… — the base with the suffix is cut to 56 characters (a slug is at most 63). */
export function* slugCandidates(base: string, max = 10_000): Generator<string> {
  yield base;
  const head = base.slice(0, 56);
  for (let i = 2; i <= max; i++) yield `${head}-${i}`;
}

/**
 * A space with the first free slug of the candidates; null — all taken. The insert is INSERT … ON CONFLICT (slug) DO NOTHING,
 * not "SELECT whether one exists, then INSERT": simultaneous creations with one slug (memory_space_create, the workplace,
 * org table departments, personal spaces at sign-in) do not fail on UNIQUE with a 500 but get different suffixes.
 * A slug taken by an invisible space — a suffix too: "taken" would reveal another's.
 */
export async function insertSpace(q: Q, s: NewSpace, slugs: Iterable<string>): Promise<string | null> {
  for (const slug of slugs) {
    const r = await q.query(
      `INSERT INTO spaces (id, slug, kind, name, description, owner_id, instance_id, default_class, org_unit_id, created_by, created_via, readme)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (slug) DO NOTHING RETURNING slug`,
      [s.id, slug, s.kind, s.name, s.description ?? null, s.owner_id, s.instance_id, s.default_class, s.org_unit_id ?? null, s.created_by ?? null, s.created_via ?? null, s.readme ?? null]);
    if (r.rowCount) return slug;
  }
  return null;
}

/**
 * The space owner (admin.ts — PUT /admin/spaces/:slug and org_owner_login of the export; the workplace — an ownership transfer):
 * owner_id and the owner row as manual membership, the previous manual owner is lowered to a member.
 * Called in a transaction. The previous owner is read right here under the lock of the space row, not
 * taken from the passed `s`: the administrator read the space before the transaction, and if the owner meanwhile handed it
 * to a colleague, the one lowered would not be the owner and the colleague's manual owner row would stay. Panel owner changes and
 * workplace transfers thus go strictly in turn; a repeated lock in the same transaction (transferMySpace) does not wait.
 */
export async function setSpaceOwner(q: Q, s: { id: string; owner_id: string | null }, ownerId: string): Promise<void> {
  const prev = ((await q.query("SELECT owner_id FROM spaces WHERE id = $1 FOR UPDATE", [s.id])).rows[0]?.owner_id ?? null) as string | null;
  await q.query("UPDATE spaces SET owner_id = $2 WHERE id = $1", [s.id, ownerId]);
  await q.query(`INSERT INTO space_members (space_id, person_id, role, source) VALUES ($1,$2,'owner','manual')
                 ON CONFLICT (space_id, person_id) DO UPDATE SET role = 'owner', source = 'manual', grant_id = NULL, expires_at = NULL`, [s.id, ownerId]);
  if (prev && prev !== ownerId)   // the previous owner stays a member if they were one by the org table; the manual owner row is lowered
    await q.query("UPDATE space_members SET role = 'member' WHERE space_id = $1 AND person_id = $2 AND role = 'owner' AND source = 'manual'", [s.id, prev]);
}

/**
 * Login change: the same person — the id, keys, personal space and
 * records stay; the old login becomes an inactive person_identities link (source = rename), the head references and the entity
 * register are updated. The caller checks a clash of the new login with another's card itself (before the call).
 * The caller holds the custody recount lock (lockCustody), taken before the people row locks (the org table load —
 * the first query of the transaction, sign-in through the directory and the identity provider — right after ldap:<guid>): the head
 * snapshots below are edited only in committed personal_custody rows, and without the lock a row the job creates
 * in that second would land with the old mail. Taking the lock here is too late — the rows are already locked.
 *
 * Dangling references to the new mail (a mark instead of a removal): the login is unique, so at
 * the moment of the change any reference of an inactive person to `to`, saved earlier, points to a mail that memory did not have
 * (a head outside the HR export, an outdated mail). Otherwise a long-made card that got this mail would become
 * a keeper by the rule: the check (cardAfterDismissal) looks at the card's creation date, and it is older than the dismissal. So
 * BEFORE rewriting from → to, such dismissed get the mark `people.attrs.custody_detached` += lower(to) — the rule ignores this
 * mail for them (refDetached: "not found", as on the dismissal day) — now and at any repeat: an HR row with the same
 * mail (an export always has the dismissed), a fix to it, a card snapshot by a worker pass. The reference itself
 * stays (what the org table says is seen in the dismissed person's card). Marked are the inactive ones with a keeper row snapshot
 * `to` (any committed row, including one made by a job pass while the change waited for the custody lock; the
 * former condition "the row is older than this transaction" skipped such a row, and the one who got the mail became the keeper.
 * No rows of this transaction exist at the call: the HR load makes them in syncCustody after the row loop, sign-in never) or, if
 * no row, with `to` as the head in the card (intermediate links, dismissed without a row), except people of `keep` (snapshots
 * and corrections the load holds in memory and that HR named in the row itself — one export, the data
 * agree) and those already marked with this mail. Working people are not touched: their head is the current HR data. A real
 * head who changed their mail stays a keeper: their references (from)
 * go to `to` after the mark, and where `to` was marked already, the mark goes (the reference is legitimate now). References
 * marked with `from` are not rewritten: they never pointed to this person. Returns the marked ones (snapshot — the reference
 * in the keeper row snapshot, space — their personal space); the caller writes the log and the warning. The mail changed only in
 * case — nothing to mark.
 */
export interface DetachedManager { person: string; login: string; space: string | null; snapshot: boolean }
const DETACHED = "COALESCE(attrs->'custody_detached', '[]'::jsonb)";
/**
 * Mark for the dismissed the head's mail the rule does not count for them (people.attrs.custody_detached, refDetached).
 * Those already marked with this mail are not touched; returns the ids marked now.
 */
export async function markCustodyDetached(q: Q, ids: readonly string[], email: string): Promise<string[]> {
  if (!ids.length) return [];
  return (await q.query(
    `UPDATE people SET attrs = jsonb_set(attrs, '{custody_detached}', ${DETACHED} || to_jsonb($2::text)) WHERE id = ANY($1::uuid[]) AND NOT ${DETACHED} ? $2 RETURNING id`,
    [[...ids], email.trim().toLowerCase()])).rows.map((r) => r.id as string);
}
/**
 * Which of `ids` are marked with mail `email`: their reference to it is not rewritten by the mail change — neither in the base
 * (renamePersonLogin), nor in the snapshots and corrections the load holds in memory (renameCustodyManager).
 */
export async function custodyDetachedAmong(q: Q, ids: readonly string[], email: string): Promise<Set<string>> {
  if (!ids.length) return new Set();
  return new Set((await q.query(`SELECT id FROM people WHERE id = ANY($1::uuid[]) AND ${DETACHED} ? $2`, [[...ids], email.trim().toLowerCase()]))
    .rows.map((r) => r.id as string));
}
export async function renamePersonLogin(q: Q, instanceId: string, id: string, from: string, to: string,
                                        o: { keep?: Iterable<string> } = {}): Promise<DetachedManager[]> {
  const was = from.trim().toLowerCase(), now = to.trim().toLowerCase();
  const detached: DetachedManager[] = [];
  if (was !== now) {
    const keep = [...new Set(o.keep ?? [])];
    for (const r of (await q.query(
      `SELECT p.id, p.login, c.space_id, c.person_id IS NOT NULL AS snapshot
         FROM people p LEFT JOIN personal_custody c ON c.person_id = p.id
        WHERE p.instance_id = $1 AND NOT p.active AND p.id <> $4 AND NOT (p.id = ANY($3::uuid[]))
          AND CASE WHEN c.person_id IS NOT NULL THEN c.manager_login = $2 ELSE lower(p.manager_login) = $2 END
          AND NOT ${DETACHED.replace("attrs", "p.attrs")} ? $2
        ORDER BY p.login`, [instanceId, now, keep, id])).rows)
      detached.push({ person: r.id, login: r.login, space: r.snapshot ? r.space_id : null, snapshot: !!r.snapshot });
    await markCustodyDetached(q, detached.map((d) => d.person), now);
  }
  await q.query("UPDATE people SET login = $2 WHERE id = $1", [id, to]);
  // old-mail references go to the new mail; those marked with the old mail do not. Whoever had the new mail marked loses the mark
  // if an active reference is rewritten: the keeper row snapshot, and without a row — the head in the card
  const back = new Set<string>((await q.query(
    `UPDATE people p SET manager_login = $2 WHERE p.manager_login = $1 AND p.instance_id = $3 AND NOT ${DETACHED.replace("attrs", "p.attrs")} ? lower($1)
     RETURNING p.id, EXISTS (SELECT 1 FROM personal_custody c WHERE c.person_id = p.id) AS has_row`, [from, to, instanceId])).rows
    .filter((r) => !r.has_row).map((r) => r.id as string));
  // the head snapshot on the keeper rows of the dismissed: otherwise the rule would look for the keeper by the old mail — past
  // this head, and the old mail given to a newcomer would make a stranger the keeper
  for (const r of (await q.query(
    `UPDATE personal_custody c SET manager_login = lower($2) WHERE c.manager_login = lower($1) AND c.instance_id = $3
        AND NOT EXISTS (SELECT 1 FROM people p WHERE p.id = c.person_id AND ${DETACHED.replace("attrs", "p.attrs")} ? lower($1))
      RETURNING c.person_id`, [from, to, instanceId])).rows) back.add(r.person_id);
  if (was !== now && back.size)
    await q.query(`UPDATE people SET attrs = jsonb_set(attrs, '{custody_detached}', (attrs->'custody_detached') - $2::text) WHERE id = ANY($1::uuid[]) AND ${DETACHED} ? $2`,
                  [[...back], now]);
  await q.query("UPDATE entities SET external_id = $2 WHERE id = $1 AND kind = 'person' AND external_system = 'people'", [id, to]);
  await q.query(`INSERT INTO person_identities (system, external_id, person_id, verified, active, source) VALUES ('ad', $1, $2, false, false, 'rename')
                 ON CONFLICT (system, external_id) DO UPDATE SET active = false, source = 'rename' WHERE person_identities.person_id = EXCLUDED.person_id`, [from, id]);
  return detached;
}
