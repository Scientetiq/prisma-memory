import { commitOrThrow } from "@memory/shared";   // a COMMIT answered with ROLLBACK is an error
import { ldapDirectorySource } from "./identity.ts";
import {
  canonicalObjectGuid, clientText, dnUnder, firstRdnValue, groupStaleHours, invalid, ldapConfig, LdapFailure, LockConnectionLost, log, matchGroups, MemoryError, newId,
  normalizeDn, notFound, projectGroupsBase, raiseAlert, tx, watchLock, type DirectoryGroup, type GroupMember, type GroupMembership,
} from "@memory/shared";
import type pg from "pg";
import type { App, Caller } from "./context.ts";
import { archivedWithRecordsSql, lockReconcile, reconcileAccess, type SpaceAccess } from "./access.ts";
import { audit } from "./audit.ts";
import { chooseCard, type GuidLink } from "./card-choice.ts";
import { isUuidParam } from "./paging.ts";
import { archivedManageDenied, PROJECTS, resolveWithArchive, spaceGroupsOf, unmanageableWhy } from "./spaces.ts";
import { requireHuman } from "./workplace.ts";

type Q = Pick<pg.PoolClient, "query">;
export interface GroupSyncRun {
  at: string; ok: boolean; error_code: string | null; trigger: "timer" | "admin" | "owner" | "bind"; space: string | null;
  groups: number; members_added: number; members_removed: number; missing: number; too_large: number;
}
const LOCK_WAIT_MS = 10_000;
const LOCK_HOLDERS_MAX = 3;
const AUDIT_PEOPLE_MAX = 100;
const LIVE = `s.instance_id = $1 AND s.kind IN ('team','project') AND s.org_unit_id IS NULL AND (s.archived_at IS NULL OR ${archivedWithRecordsSql("s")})`;

export class DirectoryReject extends Error {
  constructor(readonly status: 409 | 503, readonly code: string, message: string) { super(message); }
}
export const ldapDisabled = (): DirectoryReject =>
  new DirectoryReject(409, "ldap_disabled", "The company directory is disconnected. Group membership becomes available when the memory administrator enables directory sign-in under “Sign-in and LDAP” in the admin panel");
export function directoryReject(e: unknown, what: string): DirectoryReject {
  const f = e instanceof LdapFailure ? e : new LdapFailure("ldap_unreachable", clientText(e));
  log.warn(`${what}_ldap_failed`, { code: f.code, detail: f.detail.slice(0, 300) });
  return f.code === "ldap_disabled" ? ldapDisabled() : new DirectoryReject(503, f.code, f.message);
}

async function groupsSpace(app: App, caller: Caller, ref: string, what: string, o: { archived?: "deny" | "narrow" } = {}): Promise<SpaceAccess> {
  const s = await resolveWithArchive(app, caller, ref);
  if (!s) throw notFound();
  if (s.role !== "owner") throw new MemoryError("forbidden", `${what} is restricted to the owner of space ${s.slug}`);
  if (s.archived_at && o.archived !== "narrow") throw archivedManageDenied(s);
  return s;
}

export function parseBind(b: unknown): { dn: string; role: "member" | "reader" } {
  if (typeof b !== "object" || b === null || Array.isArray(b)) throw invalid("Request body: {\"group_dn\": group DN, \"role\": member | reader}");
  const o = b as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== "group_dn" && k !== "role");
  if (extra.length) throw invalid(`Unexpected fields: ${extra.join(", ")}`);
  const dn = typeof o.group_dn === "string" ? o.group_dn.trim() : "";
  if (dn.length < 3 || dn.length > 1024 || /[\r\n\u0000]/.test(dn) || !dn.includes("="))
    throw invalid("group_dn: enter the directory group DN on one line (CN=…,OU=…,DC=…). Select the group using the group search");
  const role = o.role === undefined ? "member" : o.role;
  if (role !== "member" && role !== "reader") throw invalid("role: member (can write) or reader (read-only)");
  return { dn, role };
}

const instanceLock = (app: App): string => `group_sync:${app.instanceId}`;
const keyLock = (app: App, key: string): string => `group_key:${app.instanceId}:${key}`;
const growLock = (app: App, key: string): string => `group_login_grow:${app.instanceId}:${key}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const busy = (what: string): MemoryError => new MemoryError("in_progress", `${what} — try again in a minute`, { retry_after: 30 });
type Lock = (name: string) => Promise<boolean>;
let lockHolders = 0;

async function withLocks<T>(app: App, names: string[], waitMs: number, run: (c: pg.PoolClient, got: Set<string>, lock: Lock, alive: () => Promise<void>) => Promise<T>): Promise<T> {
  const until = Date.now() + waitMs;
  while (lockHolders >= LOCK_HOLDERS_MAX) {
    if (Date.now() >= until) throw busy("Directory groups are syncing");
    await sleep(250);
  }
  lockHolders++;
  try {
    const client = await app.db.control.connect();
    const got = new Set<string>();
    const lock: Lock = async (name) => {
      if (got.has(name)) return true;
      if (!(await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [name])).rows[0].ok) return false;
      got.add(name);
      return true;
    };
    let broken: Error | undefined;
    let watch: ReturnType<typeof watchLock> | undefined;
    try {
      for (const name of names) while (!(await lock(name)) && Date.now() < until) await sleep(250);
      watch = watchLock(client);
      const result = await run(client, got, lock, watch.alive);
      if (watch.lost()) throw new LockConnectionLost();
      return result;
    } finally {
      try {
        for (const name of got) {
          if (watch?.lost()) break;
          await client.query("SELECT pg_advisory_unlock(hashtext($1))", [name]);
        }
      }
      catch (e) { broken = e as Error; }
      finally {
        try {
          if (watch?.lost()) {
            broken = new LockConnectionLost();
            log.warn("lock_connection_lost", { job: "space_groups" });
          }
        } finally {
          watch?.done();
          client.release(broken);
        }
      }
    }
  } finally { lockHolders--; }
}

async function txOn<T>(c: pg.PoolClient, fn: (q: pg.PoolClient) => Promise<T>): Promise<T> {
  await c.query("BEGIN");
  try {
    const out = await fn(c);
    await commitOrThrow(c);
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
}

export interface Target { key: string; dn: string; guid: string | null }

async function targetsOf(app: App, spaceId: string | null): Promise<Target[]> {
  const { rows } = await app.db.control.query(
    `SELECT DISTINCT ON (g.group_key, g.group_guid) g.group_key, g.group_dn, g.group_guid
     FROM space_groups g JOIN spaces s ON s.id = g.space_id AND ${LIVE}
     WHERE ($2::uuid IS NULL OR g.space_id = $2) ORDER BY g.group_key, g.group_guid, g.created_at`, [app.instanceId, spaceId]);
  const withGuid = new Set(rows.filter((r) => r.group_guid).map((r) => r.group_key as string));
  return rows.filter((r) => r.group_guid || !withGuid.has(r.group_key as string))
    .map((r) => ({ key: r.group_key as string, dn: r.group_dn as string, guid: (r.group_guid as string | null) ?? null }));
}

export async function matchMembers(q: Q, instanceId: string, members: GroupMember[]): Promise<string[]> {
  const uniq = (xs: Array<string | null>) => [...new Set(xs.filter((x): x is string => !!x))];
  const guidOf = (m: GroupMember) => canonicalObjectGuid(m.guid);
  const guids = uniq(members.map(guidOf)), emps = uniq(members.map((m) => m.employeeId)), mails = uniq(members.map((m) => m.mail));
  type Row = Omit<GuidLink, "bound_elsewhere"> & { k: string; bound: string[] };
  const index = async (sql: string, keys: string[]) =>
    new Map<string, Row>(keys.length ? ((await q.query(sql, [instanceId, keys])).rows as Row[]).map((r) => [r.k, r]) : []);
  const card = `p.id, p.login, p.employee_id, p.active, COALESCE(p.attrs->>'demo','') = 'true' AS demo,
    ARRAY(SELECT lower(btrim(o.external_id, '{} ')) FROM person_identities o WHERE o.person_id = p.id AND o.system = 'ad' AND o.active
          AND COALESCE(o.source, '') <> 'rename') AS bound`;
  const byGuid = await index(`SELECT i.external_id AS k, ${card}, i.active AS link_active, i.verified AS link_verified
                              FROM person_identities i JOIN people p ON p.id = i.person_id AND p.instance_id = $1
                              WHERE i.system = 'ad' AND COALESCE(i.source, '') <> 'rename' AND i.external_id = ANY($2::text[])`, guids);
  const byEmp = await index(`SELECT p.employee_id AS k, ${card}, true AS link_active, true AS link_verified FROM people p
                             WHERE p.instance_id = $1 AND p.employee_id = ANY($2::text[])`, emps);
  const byMail = await index(`SELECT p.login AS k, ${card}, true AS link_active, true AS link_verified FROM people p
                              WHERE p.instance_id = $1 AND p.login = ANY($2::text[])`, mails);
  const out = new Set<string>();
  for (const m of members) {
    const guid = guidOf(m);
    const pick = (map: Map<string, Row>, key: string | null): GuidLink | null => {
      const r = key ? map.get(key) : undefined;
      return r ? { ...r, bound_elsewhere: r.bound.some((x) => x !== guid) } : null;
    };
    const choice = chooseCard({ guidLink: pick(byGuid, guid), byEmployee: pick(byEmp, m.employeeId), byMail: pick(byMail, m.mail) }, true);
    if (choice.kind === "card" && choice.card) out.add(choice.card.id);
  }
  return [...out];
}

async function followGroup(q: Q, instanceId: string, t: Target, g: DirectoryGroup, lockKey: (key: string) => Promise<boolean>): Promise<string> {
  const found = normalizeDn(g.dn);
  if (found === t.key || !(await lockKey(found))) return t.key;
  const guid = g.guid ?? t.guid;
  if (guid && (await q.query(`SELECT 1 FROM space_groups x JOIN spaces s ON s.id = x.space_id AND s.instance_id = $1
                                WHERE x.group_key = $2 AND x.group_guid IS NOT NULL AND x.group_guid <> $3 LIMIT 1`, [instanceId, found, guid])).rowCount) {
    log.warn("group_key_taken", { from: t.key, to: found });
    return t.key;
  }
  const mine = "s.id = o.space_id AND s.instance_id = $1 AND o.group_key = $2 AND ($4::text IS NULL OR o.group_guid IS NULL OR o.group_guid = $4)";
  const args = [instanceId, t.key, found, guid];
  await q.query(`UPDATE space_groups n SET role = 'member' FROM space_groups o, spaces s
                 WHERE ${mine} AND n.space_id = o.space_id AND n.group_key = $3 AND o.role = 'member' AND n.role = 'reader'`, args);
  const merged = (await q.query(`DELETE FROM space_groups o USING space_groups n, spaces s WHERE ${mine} AND n.space_id = o.space_id AND n.group_key = $3`, args)).rowCount ?? 0;
  if (merged) log.info("group_bindings_merged", { from: t.key, to: found, merged });
  const moved = (await q.query(`UPDATE space_groups o SET group_dn = $5, group_key = $3 FROM spaces s WHERE ${mine}`, [...args, g.dn])).rowCount ?? 0;
  if (moved || merged)
    await q.query(`INSERT INTO directory_group_members (instance_id, group_key, person_id, source, seen_at)
                   SELECT instance_id, $3, person_id, source, seen_at FROM directory_group_members WHERE instance_id = $1 AND group_key = $2
                   ON CONFLICT (instance_id, group_key, person_id) DO NOTHING`, [instanceId, t.key, found]);
  return found;
}

export async function applyGroup(q: Q, instanceId: string, t: Target, r: GroupMembership, started: Date, lockKey: (key: string) => Promise<boolean>): Promise<string[]> {
  const where = (guid: number) => `FROM spaces s WHERE s.id = g.space_id AND s.instance_id = $1 AND g.group_key = $2 AND (g.group_guid IS NULL OR g.group_guid = $${guid})`;
  if (r.status === "missing") {
    await q.query(`UPDATE space_groups g SET status = 'missing', missing_since = COALESCE(g.missing_since, now()), last_error = NULL ${where(3)}`,
                  [instanceId, t.key, t.guid]);
    return [];
  }
  const key = await followGroup(q, instanceId, t, r.group, lockKey);
  const meta = [r.group.dn, r.group.name, r.group.guid ?? t.guid];
  if (r.status === "too_large") {
    await q.query(`UPDATE space_groups g SET status = 'too_large', synced_at = now(), missing_since = NULL, last_error = NULL,
                     group_dn = $3, display_name = $4, group_guid = COALESCE(g.group_guid, $5) ${where(5)}`, [instanceId, key, ...meta]);
    return [];
  }
  const ids = await matchMembers(q, instanceId, r.members);
  await q.query(`DELETE FROM directory_group_members WHERE instance_id = $1 AND group_key = $2 AND NOT (person_id = ANY($3::uuid[]))
                   AND NOT (source = 'login' AND seen_at > $4)`, [instanceId, key, ids, started]);
  if (ids.length)
    await q.query(`INSERT INTO directory_group_members (instance_id, group_key, person_id, source) SELECT $1, $2, x, 'sync' FROM unnest($3::uuid[]) x
                   ON CONFLICT (instance_id, group_key, person_id) DO UPDATE SET source = 'sync', seen_at = now()`, [instanceId, key, ids]);
  await q.query(`UPDATE space_groups g SET status = 'ok', members_seen = $6, members_matched = $7, synced_at = now(), missing_since = NULL, last_error = NULL,
                   group_dn = $3, display_name = $4, group_guid = COALESCE(g.group_guid, $5) ${where(5)}`, [instanceId, key, ...meta, r.members.length, ids.length]);
  return ids;
}

async function dropForeignCache(q: Q, instanceId: string, key: string, guid: string | null, syncedAt: Date | null): Promise<number> {
  if (!guid || !syncedAt) return 0;
  return (await q.query(`DELETE FROM directory_group_members d WHERE d.instance_id = $1 AND d.group_key = $2 AND NOT EXISTS (
                           SELECT 1 FROM space_groups g JOIN spaces s ON s.id = g.space_id AND s.instance_id = $1
                           WHERE g.group_key = $2 AND (g.group_guid IS NULL OR g.group_guid = $3 OR COALESCE(g.synced_at, '-infinity'::timestamptz) >= $4))`,
                         [instanceId, key, guid, syncedAt])).rowCount ?? 0;
}

async function dropOrphans(q: Q, instanceId: string, keys: string[] | null = null): Promise<number> {
  return (await q.query(`DELETE FROM directory_group_members d WHERE d.instance_id = $1 AND ($2::text[] IS NULL OR d.group_key = ANY($2::text[])) AND NOT EXISTS (
                           SELECT 1 FROM space_groups g JOIN spaces s ON s.id = g.space_id AND ${LIVE} WHERE g.group_key = d.group_key)`, [instanceId, keys])).rowCount ?? 0;
}

interface Seat { space: string; slug: string; person: string; source: string }
async function seatsOf(q: Q, instanceId: string, spaceIds?: string[]): Promise<{ ids: string[]; seats: Map<string, Seat> }> {
  const live = `s.instance_id = $1 AND (s.archived_at IS NULL OR ${archivedWithRecordsSql("s")})`;
  const ids = spaceIds ?? (await q.query(
    `SELECT DISTINCT g.space_id AS id FROM space_groups g JOIN spaces s ON s.id = g.space_id AND ${live}
     UNION SELECT DISTINCT m.space_id FROM space_members m JOIN spaces s ON s.id = m.space_id AND ${live} WHERE m.source = 'group'`, [instanceId])).rows.map((r) => r.id as string);
  const seats = new Map<string, Seat>();
  if (ids.length) {
    const { rows } = await q.query("SELECT m.space_id, s.slug, m.person_id, m.source FROM space_members m JOIN spaces s ON s.id = m.space_id WHERE m.space_id = ANY($1::uuid[])", [ids]);
    for (const r of rows) seats.set(`${r.space_id}:${r.person_id}`, { space: r.space_id, slug: r.slug, person: r.person_id, source: r.source });
  }
  return { ids, seats };
}

export interface Changes { added: Seat[]; removed: Seat[] }
function diffSeats(before: Map<string, Seat>, after: Map<string, Seat>): Changes {
  return { added: [...after].filter(([k, s]) => s.source === "group" && !before.has(k)).map(([, s]) => s),
           removed: [...before].filter(([k, s]) => s.source === "group" && !after.has(k)).map(([, s]) => s) };
}

export function peopleOf(ch: Changes): Record<string, unknown> {
  const all = [...ch.added.map((s) => ({ ...s, kind: "added" })), ...ch.removed.map((s) => ({ ...s, kind: "removed" }))];
  if (!all.length) return {};
  const cut = all.slice(0, AUDIT_PEOPLE_MAX);
  const pick = (kind: string) => cut.filter((s) => s.kind === kind).map((s) => ({ space: s.slug, person: s.person }));
  return { people: { added: pick("added"), removed: pick("removed") }, ...(all.length > cut.length ? { people_truncated: all.length } : {}) };
}

const inSpace = (ch: Changes, id: string, yes: boolean): Changes =>
  ({ added: ch.added.filter((x) => (x.space === id) === yes), removed: ch.removed.filter((x) => (x.space === id) === yes) });

async function auditOtherSpaces(app: App, caller: Caller | null, s: { id: string; slug: string }, ch: Changes, trigger: "owner" | "bind"): Promise<void> {
  const other = inSpace(ch, s.id, false);
  if (!other.added.length && !other.removed.length) return;
  await audit(app, caller, { event_type: "admin", space_id: null, details: {
    op: "group_sync", trigger, slug: s.slug, other_spaces: true, ok: true, added: other.added.length, removed: other.removed.length, ...peopleOf(other) } });
}

export async function recount(q: pg.PoolClient, instanceId: string, spaceIds?: string[]): Promise<Changes> {
  await lockReconcile(q, instanceId);
  const before = await seatsOf(q, instanceId, spaceIds);
  await reconcileAccess(q, instanceId, false);
  const after = await seatsOf(q, instanceId, before.ids);
  return diffSeats(before.seats, after.seats);
}

export async function syncGroups(app: App, o: { trigger: "timer" | "admin" | "owner"; space?: SpaceAccess | null; caller?: Caller | null }): Promise<GroupSyncRun> {
  const cfg = ldapConfig(app.settings);
  if (!cfg.enabled) throw ldapDisabled();
  const space = o.space ?? null;
  const targets = await targetsOf(app, space?.id ?? null);
  const names = [...new Set([...(space ? [] : [instanceLock(app)]), ...targets.map((t) => keyLock(app, t.key))])];
  let changes: Changes = { added: [], removed: [] };
  const run = await withLocks(app, names, space ? LOCK_WAIT_MS : 0, async (c, got, lock): Promise<GroupSyncRun> => {
    if (!space && !got.has(instanceLock(app))) throw busy("A directory group sync is already in progress");
    if (space && got.size < names.length) throw busy("Another process is syncing this space’s groups");
    const mine = targets.filter((t) => got.has(keyLock(app, t.key)));
    const base: GroupSyncRun = { at: new Date().toISOString(), ok: true, error_code: null, trigger: o.trigger, space: space?.slug ?? null,
                                 groups: mine.length, members_added: 0, members_removed: 0, missing: 0, too_large: 0 };
    const started = (await c.query("SELECT clock_timestamp() AS t")).rows[0].t as Date;
    let results: GroupMembership[] = [];
    try {
      results = await ldapDirectorySource.groups.members(cfg, mine, { max: cfg.group_max_members });
    } catch (e) {
      const code = e instanceof LdapFailure ? e.code : "ldap_unreachable";
      log.warn("group_sync_failed", { trigger: o.trigger, code, detail: (e instanceof LdapFailure ? e.detail : clientText(e)).slice(0, 300) });
      if (mine.length)
        await c.query(`UPDATE space_groups g SET status = 'error', last_error = $3 FROM spaces s WHERE s.id = g.space_id AND s.instance_id = $1 AND g.group_key = ANY($2::text[])`,
                      [app.instanceId, mine.map((t) => t.key), code]);
      return { ...base, ok: false, error_code: code };
    }
    changes = await txOn(c, async (q) => {
      for (const [i, t] of mine.entries()) await applyGroup(q, app.instanceId, t, results[i]!, started, (k) => lock(keyLock(app, k)));
      const dropped = await dropOrphans(q, app.instanceId);
      return mine.length || dropped ? recount(q, app.instanceId) : { added: [], removed: [] };
    });
    const shown = space ? inSpace(changes, space.id, true) : changes;
    return { ...base, members_added: shown.added.length, members_removed: shown.removed.length,
             missing: results.filter((r) => r.status === "missing").length, too_large: results.filter((r) => r.status === "too_large").length };
  });
  if (!space) {
    await app.db.control.query(`INSERT INTO maintenance_state (instance_id, key, value, updated_at) VALUES ($1, 'group_sync', $2::jsonb, now())
                                ON CONFLICT (instance_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [app.instanceId, JSON.stringify(run)]);
    if (run.ok) await endOutage(app);                                   // the directory answers again
    await countFailure(app, run.ok);
  }
  if (o.trigger !== "timer" || !run.ok || run.members_added || run.members_removed)
    await audit(app, o.caller ?? null, { event_type: "admin", space_id: space?.id ?? null, details: {
      op: "group_sync", trigger: run.trigger, ...(space ? { slug: space.slug } : {}), ok: run.ok, ...(run.error_code ? { error_code: run.error_code } : {}),
      groups: run.groups, added: run.members_added, removed: run.members_removed, missing: run.missing, too_large: run.too_large,
      ...peopleOf(space ? inSpace(changes, space.id, true) : changes) } });
  if (space) await auditOtherSpaces(app, o.caller ?? null, space, changes, "owner");
  return run;
}

export async function groupSyncTick(app: App): Promise<void> {
  const cfg = ldapConfig(app.settings);
  let failuresInRow = 0;
  if (cfg.enabled && cfg.group_sync_minutes > 0) {
    try {
      const { rows } = await app.db.control.query(
        "SELECT key, value, updated_at FROM maintenance_state WHERE instance_id = $1 AND key IN ('group_sync', $2)", [app.instanceId, RETRY_STATE]);
      const last = rows.find((r) => r.key === "group_sync") as { value: { ok?: boolean } | null; updated_at: Date } | undefined;
      const lastFailed = last?.value?.ok === false;
      // a failed run without the counter (written before it existed) counts as one failure
      failuresInRow = lastFailed ? Math.max(Number((rows.find((r) => r.key === RETRY_STATE)?.value as { failures?: unknown } | undefined)?.failures) || 0, 1) : 0;
      // a retry is due at the next tick: the tick is a minute, give it a few seconds of slack
      const waitMs = lastFailed ? syncRetryMinutes(failuresInRow, cfg.group_sync_minutes) * 60_000 - RETRY_SLACK_MS : cfg.group_sync_minutes * 60_000;
      if (!last || Date.now() - new Date(last.updated_at).getTime() >= waitMs) {
        const run = await syncGroups(app, { trigger: "timer" });
        failuresInRow = run.ok ? 0 : failuresInRow + 1;
      }
    } catch (e) {
      if (!(e instanceof MemoryError && e.code === "in_progress")) log.warn("group_sync_timer_failed", { error: clientText(e) });
    }
  }
  if (failuresInRow === 1) return;                                       // the retry on a following tick decides
  try {
    await expireStaleGroups(app);
  } catch (e) {
    if (!(e instanceof MemoryError && e.code === "in_progress")) log.warn("group_expiry_failed", { error: clientText(e) });
  }
}

/** Slack of a retry against the minute tick (a tick that comes a little early must not wait a whole extra minute). */
const RETRY_SLACK_MS = 5_000;
/** maintenance_state key of the failed full syncs in a row (failures; 0 after a successful one). */
const RETRY_STATE = "group_sync_retry";
/** Minutes until the next attempt after the n-th failed full sync in a row; never later than the sync period. */
const RETRY_LADDER_MIN = [1, 2, 5, 10, 15, 30, 60];
export const syncRetryMinutes = (failures: number, period: number): number =>
  Math.min(period, RETRY_LADDER_MIN[Math.min(Math.max(failures, 1), RETRY_LADDER_MIN.length) - 1]!);

/** After a full sync: count the failures in a row (the role has no DELETE on maintenance_state — 0 after a success). */
async function countFailure(app: App, ok: boolean): Promise<void> {
  await app.db.control.query(
    `INSERT INTO maintenance_state (instance_id, key, value, updated_at) VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (instance_id, key) DO UPDATE SET updated_at = now(), value = CASE WHEN $4::boolean THEN EXCLUDED.value
       ELSE jsonb_build_object('failures', COALESCE((maintenance_state.value->>'failures')::int, 0) + 1) END`,
    [app.instanceId, RETRY_STATE, JSON.stringify({ failures: ok ? 0 : 1 }), ok]);
}

export function startGroupSync(app: App, tickMs = 60_000): NodeJS.Timeout {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await groupSyncTick(app); } finally { busy = false; }
  };
  const t = setInterval(() => void tick(), tickMs);
  t.unref();
  return t;
}

// ----------------------------------------------------------------: expiry without verification
/**
 * Group keys not verified for `hours`: the newest verification over the key's live bindings (synced_at; a binding never
 * synced counts from its creation) is older than the cutoff (`at`, default the database clock). Per key, not per binding:
 * under one DN the cache belongs to the binding verified last, and a key verified by any of its bindings is not
 * stale. withRows — only keys that still hold cache rows (what an expiry removes); keys — only these.
 */
async function staleKeys(q: Q, instanceId: string, hours: number, o: { at?: Date | null; keys?: string[] | null; withRows?: boolean } = {}): Promise<string[]> {
  const { rows } = await q.query(
    `SELECT g.group_key FROM space_groups g JOIN spaces s ON s.id = g.space_id AND ${LIVE}
     WHERE ($3::text[] IS NULL OR g.group_key = ANY($3::text[]))
     GROUP BY g.group_key
     HAVING max(COALESCE(g.synced_at, g.created_at)) < COALESCE($4::timestamptz, now()) - make_interval(hours => $2::int)
        AND (NOT $5::boolean OR EXISTS (SELECT 1 FROM directory_group_members d WHERE d.instance_id = $1 AND d.group_key = g.group_key))
     ORDER BY g.group_key`, [instanceId, hours, o.keys ?? null, o.at ?? null, o.withRows === true]);
  return rows.map((r) => r.group_key as string);
}

/** maintenance_state key of the expiry: when the current outage began (its alert was raised then). */
const STALE_STATE = "group_stale";
/** Group keys named in the expiry event; beyond — only the count. */
const STALE_KEYS_MAX = 100;

export interface GroupExpiry { groups: number; removed: number }

/**
 * Remove the cached membership of group keys not verified for the expiry in force (groupStaleHours; 0 — nothing, null
 * returned). Under the instance lock of the sync (a full sync or another process's expiry runs — this tick skips) and the
 * locks of the keys (a key another process syncs now is left to the next tick); the keys are checked again under the
 * locks, then their directory_group_members rows go and recount() removes the derived memberships (source group) in the
 * same transaction. Manual membership, membership by an org unit or a grant are not touched. One audit event
 * admin {op: group_sync, trigger: stale}, and one high alert directory_groups_stale per outage: the first expiry that
 * removed a membership after the last successful full sync. A group over ldap.group_max_members (too_large) expires like
 * any other — fail closed — but a sync does not refill its cache: it stays without members until the limit is raised or
 * the group is unbound; "Readiness" lists such groups (groupExpiryState.frozenEmpty). `at` — the clock of the check (tests); default the database's.
 */
export async function expireStaleGroups(app: App, o: { at?: Date } = {}): Promise<GroupExpiry | null> {
  const hours = groupStaleHours(ldapConfig(app.settings));
  if (!hours) return null;
  const due = await staleKeys(app.db.control, app.instanceId, hours, { at: o.at, withRows: true });
  if (!due.length) return { groups: 0, removed: 0 };
  let expired: string[] = [];
  let changes: Changes = { added: [], removed: [] };
  await withLocks(app, [instanceLock(app), ...due.map((k) => keyLock(app, k))], 0, async (c, got) => {
    if (!got.has(instanceLock(app))) return;
    const mine = due.filter((k) => got.has(keyLock(app, k)));
    if (!mine.length) return;
    await txOn(c, async (q) => {
      expired = await staleKeys(q, app.instanceId, hours, { at: o.at, keys: mine, withRows: true });   // a sync may have just verified one
      if (!expired.length) return;
      await q.query("DELETE FROM directory_group_members WHERE instance_id = $1 AND group_key = ANY($2::text[])", [app.instanceId, expired]);
      changes = await recount(q, app.instanceId);
    });
  });
  if (!expired.length) return { groups: 0, removed: 0 };
  const removed = changes.removed.length;
  log.warn("group_membership_expired", { groups: expired.length, removed, hours });
  await audit(app, null, { event_type: "admin", space_id: null, details: {
    op: "group_sync", trigger: "stale", ok: true, stale_hours: hours, groups: expired.length, added: 0, removed,
    group_keys: expired.slice(0, STALE_KEYS_MAX), ...(expired.length > STALE_KEYS_MAX ? { group_keys_truncated: expired.length } : {}), ...peopleOf(changes) } });
  if (removed) await alertOutage(app, expired.length, removed, hours);  // nobody lost anything — the event is enough
  return { groups: expired.length, removed };
}

/**
 * The alert of an outage — once: an outage begins with the first expiry while none is open (maintenance_state
 * group_stale, active) and ends with the next successful full sync (endOutage); a switched-off directory is one outage
 * until it syncs again.
 */
async function alertOutage(app: App, groups: number, removed: number, hours: number): Promise<void> {
  const now = new Date().toISOString();
  const opened = (await app.db.control.query(
    `INSERT INTO maintenance_state (instance_id, key, value, updated_at) VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (instance_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
       WHERE COALESCE(maintenance_state.value->>'active', 'false') <> 'true'
     RETURNING key`, [app.instanceId, STALE_STATE, JSON.stringify({ active: true, since: now, groups, removed })])).rowCount;
  if (!opened) return;
  const r = await raiseAlert({ control: app.db.control, audit: app.db.audit }, {
    instanceId: app.instanceId, level: "high", code: "directory_groups_stale", dedupeKey: `directory_groups_stale:${now}`,
    summary: `Directory group membership expired: ${groups} group(s) not verified for ${hours} h, ${removed} membership(s) removed until the directory answers (a group over ldap.group_max_members does not come back by itself)`,
    details: { groups, removed, hours } }).catch(() => ({ inserted: false }));
  // the alert was not written — the outage is not marked as alerted, the next expiry tries again
  if (!r.inserted)
    await app.db.control.query(`UPDATE maintenance_state SET value = value || '{"active": false}'::jsonb, updated_at = now()
                                WHERE instance_id = $1 AND key = $2 AND value->>'since' = $3`, [app.instanceId, STALE_STATE, now]);
}

/** A successful full sync closes the open outage: the next expiry raises a new alert. */
async function endOutage(app: App): Promise<void> {
  await app.db.control.query(`UPDATE maintenance_state SET value = value || '{"active": false}'::jsonb, updated_at = now()
                              WHERE instance_id = $1 AND key = $2 AND value->>'active' = 'true'`, [app.instanceId, STALE_STATE]);
}

/**
 * For "Readiness" (directory_groups): live group bindings, the keys not verified for `hours` (the expiry in force by
 * default; 0 — none counted) and the over-limit keys left without members.
 */
export async function groupExpiryState(app: App, hours = groupStaleHours(ldapConfig(app.settings))): Promise<{ bindings: number; stale: number; frozenEmpty: number }> {
  const bindings = (await app.db.control.query(`SELECT count(*)::int AS n FROM space_groups g JOIN spaces s ON s.id = g.space_id AND ${LIVE}`, [app.instanceId])).rows[0].n as number;
  const stale = hours && bindings ? (await staleKeys(app.db.control, app.instanceId, hours)).length : 0;
  // over-limit group keys without cache rows: a sync does not refill them — the administrator acts
  const frozenEmpty = bindings ? (await app.db.control.query(
    `SELECT count(*)::int AS n FROM (SELECT g.group_key FROM space_groups g JOIN spaces s ON s.id = g.space_id AND ${LIVE}
       GROUP BY g.group_key HAVING bool_or(g.status = 'too_large')
          AND NOT EXISTS (SELECT 1 FROM directory_group_members d WHERE d.instance_id = $1 AND d.group_key = g.group_key)) k`,
    [app.instanceId])).rows[0].n as number : 0;
  return { bindings, stale, frozenEmpty };
}

export async function listSpaceGroups(app: App, caller: Caller, ref: string) {
  const s = await groupsSpace(app, caller, ref, "Viewing directory groups", { archived: "narrow" });
  return { ldap_enabled: ldapConfig(app.settings).enabled, items: await spaceGroupsOf(app, s.id) };
}

export async function syncMySpaceGroups(app: App, caller: Caller, ref: string): Promise<GroupSyncRun> {
  await requireHuman(app, caller, "Update membership from directory groups", PROJECTS);
  const s = await groupsSpace(app, caller, ref, "Updating membership from directory groups");
  return syncGroups(app, { trigger: "owner", space: s, caller });
}

export async function bindSpaceGroup(app: App, caller: Caller, ref: string, body: unknown): Promise<{ created: boolean; group: unknown }> {
  await requireHuman(app, caller, "Link a directory group", PROJECTS);
  const s = await groupsSpace(app, caller, ref, "Binding a directory group");
  const why = unmanageableWhy(s);
  if (why) throw invalid(`${why}. Directory groups can be bound only to projects or team spaces without a department`);
  const { dn, role } = parseBind(body);
  const cfg = ldapConfig(app.settings);
  if (!cfg.enabled) throw ldapDisabled();
  const existing = async (key: string) => {
    const id = (await app.db.control.query("SELECT id FROM space_groups WHERE space_id = $1 AND group_key = $2", [s.id, key])).rows[0]?.id as string | undefined;
    return id ? (await spaceGroupsOf(app, s.id)).find((g) => g.id === id) ?? null : null;
  };
  const same = await existing(normalizeDn(dn));
  if (same) return { created: false, group: same };
  const base = projectGroupsBase(cfg);
  if (!dnUnder(dn, base)) throw invalid(`Group ${firstRdnValue(dn)} is outside the directory branch for spaces (${base}). The memory administrator sets the branch under “Sign-in and LDAP”`);
  const want = normalizeDn(dn);
  const inUse = "Another process is syncing this group";
  const out = await withLocks(app, [keyLock(app, want)], LOCK_WAIT_MS, async (c, got, lock) => {
    if (!got.size) throw busy(inUse);
    const lockKey = (k: string) => lock(keyLock(app, k));
    const started = (await c.query("SELECT clock_timestamp() AS t")).rows[0].t as Date;
    let r: GroupMembership;
    try { [r] = (await ldapDirectorySource.groups.members(cfg, [{ dn, guid: null }], { max: cfg.group_max_members })) as [GroupMembership]; }
    catch (e) { throw directoryReject(e, "group_bind"); }
    if (r.status === "missing") throw invalid(`The directory has no group ${dn}, or it is not a group. Select it using the group search`);
    if (r.status === "too_large")
      throw invalid(`Group ${r.group.name} has more than ${cfg.group_max_members} active accounts (ldap.group_max_members): bind a smaller group — the limit is raised by the memory administrator`);
    const key = normalizeDn(r.group.dn), guid = r.group.guid;
    if (!(await lockKey(key))) throw busy(inUse);
    if (guid) {
      const prev = (await c.query("SELECT group_key, group_dn FROM space_groups WHERE space_id = $1 AND group_guid = $2 AND group_key <> $3 ORDER BY created_at LIMIT 1",
                                  [s.id, guid, key])).rows[0] as { group_key: string; group_dn: string } | undefined;
      if (prev) {
        if (!(await lockKey(prev.group_key))) throw busy(inUse);
        const changes = await txOn(c, async (q) => {
          await applyGroup(q, app.instanceId, { key: prev.group_key, dn: prev.group_dn, guid }, r, started, lockKey);
          await dropOrphans(q, app.instanceId);
          return recount(q, app.instanceId);
        });
        return { id: null, key, changes, renamedFrom: prev.group_key };
      }
      if ((await c.query(`SELECT 1 FROM space_groups g JOIN spaces s ON s.id = g.space_id AND ${LIVE}
                          WHERE g.group_key = $2 AND g.group_guid IS NOT NULL AND g.group_guid <> $3 LIMIT 1`, [app.instanceId, key, guid])).rowCount)
        throw invalid(`The directory now has a different group under the name ${r.group.name} than the one the earlier binding pointed to (that one was renamed or deleted): try again after the directory groups are reconciled or ask the memory administrator`);
    }
    const id = newId();
    return txOn(c, async (q) => {
      const ins = await q.query(`INSERT INTO space_groups (id, space_id, group_dn, group_key, group_guid, display_name, role, added_by)
                                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (space_id, group_key) DO NOTHING RETURNING id`,
                                [id, s.id, r.group.dn, key, guid, r.group.name, role, caller.person!.id]);
      if (!ins.rowCount) return { id: null, key, changes: null, renamedFrom: null };
      await applyGroup(q, app.instanceId, { key, dn: r.group.dn, guid }, r, started, lockKey);
      await dropOrphans(q, app.instanceId);
      return { id, key, changes: await recount(q, app.instanceId), renamedFrom: null };
    });
  });
  if (!out.id) {
    const group = (await existing(out.key)) ?? (out.renamedFrom ? await existing(out.renamedFrom) : null);
    if (out.renamedFrom && out.changes) {
      const gained = out.changes.added.filter((x) => x.space === s.id), lost = out.changes.removed.filter((x) => x.space === s.id);
      await audit(app, caller, { event_type: "admin", space_id: s.id, details: { op: "space_group_bind", slug: s.slug, group_key: out.key, renamed_from: out.renamedFrom,
                                                                                 role: group?.role ?? null, via: "owner", members: gained.length,
                                                                                 ...peopleOf({ added: gained, removed: lost }) } });
      await auditOtherSpaces(app, caller, s, out.changes, "bind");
    }
    return { created: false, group };
  }
  const gained = out.changes!.added.filter((x) => x.space === s.id);
  await audit(app, caller, { event_type: "admin", space_id: s.id, details: { op: "space_group_bind", slug: s.slug, group_key: out.key, role, via: "owner", members: gained.length,
                                                                             ...peopleOf({ added: gained, removed: [] }) } });
  await auditOtherSpaces(app, caller, s, out.changes!, "bind");
  return { created: true, group: (await spaceGroupsOf(app, s.id)).find((g) => g.id === out.id) };
}

export async function unbindSpaceGroup(app: App, caller: Caller | null, s: { id: string; slug: string }, id: string, via: "owner" | "admin") {
  if (!isUuidParam(id)) throw notFound();
  const key = (await app.db.control.query("SELECT group_key FROM space_groups WHERE id = $1 AND space_id = $2", [id, s.id])).rows[0]?.group_key as string | undefined;
  if (!key) throw notFound();
  const inUse = "Another process is syncing this group";
  const out = await withLocks(app, [keyLock(app, key)], LOCK_WAIT_MS, async (c, got) => {
    if (!got.size) throw busy(inUse);
    return txOn(c, async (q) => {
      const g = (await q.query("SELECT group_key, role, group_guid, synced_at FROM space_groups WHERE id = $1 AND space_id = $2 FOR UPDATE", [id, s.id])).rows[0];
      if (!g) return null;
      if (g.group_key !== key) throw busy(inUse);
      await lockReconcile(q, app.instanceId);
      const before = await seatsOf(q, app.instanceId);
      await q.query("DELETE FROM space_groups WHERE id = $1", [id]);
      await dropOrphans(q, app.instanceId, [key]);
      await dropForeignCache(q, app.instanceId, key, g.group_guid ?? null, g.synced_at ?? null);
      await reconcileAccess(q, app.instanceId, false);
      const after = await seatsOf(q, app.instanceId, before.ids);
      return { key, role: g.role as string, lost: diffSeats(before.seats, after.seats).removed.filter((x) => x.space === s.id) };
    });
  });
  if (!out) throw notFound();
  await audit(app, caller, { event_type: "admin", space_id: s.id, details: { op: "space_group_unbind", slug: s.slug, group_key: out.key, role: out.role, via, members: out.lost.length,
                                                                             ...peopleOf({ added: [], removed: out.lost }) } });
  return { id, members_removed: out.lost.length };
}

export async function unbindMySpaceGroup(app: App, caller: Caller, ref: string, id: string) {
  await requireHuman(app, caller, "Unlink a directory group", PROJECTS);
  const s = await groupsSpace(app, caller, ref, "Unlinking a directory group", { archived: "narrow" });
  return unbindSpaceGroup(app, caller, s, id, "owner");
}

async function openTargets(q: Q, instanceId: string, keys: string[] | null = null, staleHours = 0): Promise<Target[]> {
  // a group not verified for staleHours is frozen too — a sign-in does not bring its membership back before a sync
  const { rows } = await q.query(
    `SELECT g.group_key, (array_agg(g.group_dn ORDER BY g.group_guid IS NULL, g.created_at))[1] AS group_dn,
            (array_agg(g.group_guid ORDER BY g.group_guid IS NULL, g.created_at))[1] AS group_guid
     FROM space_groups g JOIN spaces s ON s.id = g.space_id AND ${LIVE}
     WHERE ($2::text[] IS NULL OR g.group_key = ANY($2::text[]))
     GROUP BY g.group_key HAVING bool_and(g.status IN ('ok','pending'))
        AND ($3::int = 0 OR max(COALESCE(g.synced_at, g.created_at)) >= now() - make_interval(hours => $3::int))
     ORDER BY g.group_key`, [instanceId, keys, staleHours]);
  return rows.map((r) => ({ key: r.group_key as string, dn: r.group_dn as string, guid: (r.group_guid as string | null) ?? null }));
}

export async function refreshGroupsOnLogin(app: App, personId: string, memberOf: string[], caller: Caller | null = null): Promise<void> {
  const cfg = ldapConfig(app.settings);
  const staleHours = groupStaleHours(cfg);
  const open = await openTargets(app.db.control, app.instanceId, null, staleHours);
  if (!open.length) return;
  const hit = new Set(matchGroups(memberOf, open.map((t) => t.key)));
  const had = new Set((await app.db.control.query("SELECT group_key FROM directory_group_members WHERE instance_id = $1 AND person_id = $2",
                                                  [app.instanceId, personId])).rows.map((r) => r.group_key as string));
  const ask = open.filter((t) => (hit.has(t.key) ? !had.has(t.key) : !cfg.nested_groups && had.has(t.key)));
  const confirmed = new Map<string, string | null>();
  if (ask.length) {
    try {
      const where = await ldapDirectorySource.groups.find(cfg, ask);
      ask.forEach((t, i) => { if (where[i] && normalizeDn(where[i]!.dn) === t.key) confirmed.set(t.key, t.guid); });
    } catch (e) {
      log.warn("group_login_check_failed", { person: personId, code: e instanceof LdapFailure ? e.code : "ldap_unreachable" });
    }
  }
  const keys = [...new Set([...[...hit].filter((k) => had.has(k)), ...confirmed.keys()])].sort();
  if (!keys.length) return;
  const changes = await tx(app.db.control, async (q) => {
    const mine: string[] = [], skipped: string[] = [];
    for (const k of keys) ((await q.query("SELECT pg_try_advisory_xact_lock_shared(hashtext($1)) AS ok", [keyLock(app, k)])).rows[0].ok ? mine : skipped).push(k);
    if (skipped.length) log.info("group_login_skipped", { person: personId, groups: skipped });
    if (!mine.length) return null;
    const still = new Map((await openTargets(q, app.instanceId, mine, staleHours)).map((t) => [t.key, t.guid]));
    const same = (k: string) => still.has(k) && (!confirmed.has(k) || still.get(k) === confirmed.get(k));
    const drop = mine.filter((k) => !hit.has(k) && same(k));
    let add = mine.filter((k) => hit.has(k) && same(k));
    const fresh = add.filter((k) => !had.has(k));
    if (fresh.length) {
      for (const k of fresh) await q.query("SELECT pg_advisory_xact_lock(hashtext($1))", [growLock(app, k)]);
      const seats = new Map((await q.query(`SELECT k, (SELECT count(*)::int FROM directory_group_members d WHERE d.instance_id = $1 AND d.group_key = k AND d.person_id <> $2) AS n
                                            FROM unnest($3::text[]) k`, [app.instanceId, personId, fresh])).rows.map((r) => [r.k as string, r.n as number]));
      const full = fresh.filter((k) => (seats.get(k) ?? 0) >= cfg.group_max_members);
      if (full.length) {
        log.warn("group_login_cap", { person: personId, groups: full, max: cfg.group_max_members });
        add = add.filter((k) => !full.includes(k));
      }
    }
    let changed = 0;
    if (add.length)
      changed += (await q.query(`INSERT INTO directory_group_members (instance_id, group_key, person_id, source) SELECT $1, k, $2, 'login' FROM unnest($3::text[]) k
                                 ON CONFLICT (instance_id, group_key, person_id) DO UPDATE SET source = 'login', seen_at = now() RETURNING (xmax = 0) AS inserted`,
                                [app.instanceId, personId, add])).rows.filter((r) => r.inserted).length;
    if (drop.length)
      changed += (await q.query("DELETE FROM directory_group_members WHERE instance_id = $1 AND person_id = $2 AND group_key = ANY($3::text[])",
                                [app.instanceId, personId, drop])).rowCount ?? 0;
    return changed ? recount(q, app.instanceId) : null;
  });
  if (changes && (changes.added.length || changes.removed.length))
    await audit(app, caller, { event_type: "admin", details: { op: "group_login", person: personId, added: changes.added.length, removed: changes.removed.length, ...peopleOf(changes) } });
}
