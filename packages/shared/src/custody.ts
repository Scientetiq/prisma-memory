import { MemoryError, type ErrorCode } from "./errors.ts";
import { orgUnitId, slugify } from "./ids.ts";
import { isShowcaseLogin, isTestDomainLogin, showcaseSql, testLoginSql } from "./test-logins.ts";

interface Queryable { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> }
interface SettingsLike { get<T>(path: string, fallback: T): T }

export const CUSTODY_PERSONAL = ["keep", "delete"] as const;
export const CUSTODY_MEETINGS = ["transfer", "wait"] as const;
export const CUSTODY_READ = ["all", "open", "off"] as const;
export const CUSTODY_AFTER_DAYS: readonly [number, number] = [0, 90];
export const CUSTODY_CHAIN_LIMIT = 10;

export type CustodyBasis = "manager" | "department_head" | "admin" | "manual";
export interface CustodyPolicy {
  personal: (typeof CUSTODY_PERSONAL)[number];
  meetings: (typeof CUSTODY_MEETINGS)[number];
  afterDays: number;
  testToo: boolean;
  read: (typeof CUSTODY_READ)[number];
  retentionDays: number;
}

export function custodyPolicy(s: SettingsLike): CustodyPolicy {
  const personal = s.get<unknown>("access.dismissed_personal", "keep");
  const meetings = s.get<unknown>("access.dismissed_meetings", "transfer");
  const after = s.get<unknown>("access.dismissed_custody_after_days", 7);
  const read = s.get<unknown>("access.dismissed_custody", "all");
  const days = Number(s.get<unknown>("access.dismissed_retention_days", 90));
  return {
    personal: personal === "delete" ? "delete" : "keep",
    meetings: meetings === "transfer" ? "transfer" : "wait",
    afterDays: typeof after === "number" && Number.isInteger(after) && after >= CUSTODY_AFTER_DAYS[0] && after <= CUSTODY_AFTER_DAYS[1] ? after : 7,
    testToo: s.get<unknown>("access.dismissed_custody_test", false) === true,
    read: (CUSTODY_READ as readonly unknown[]).includes(read) ? read as CustodyPolicy["read"] : "off",
    retentionDays: Number.isFinite(days) ? Math.max(0, Math.floor(days)) : 90,
  };
}

export const circleOf = (login: string | null | undefined): "staff" | "test" => (isTestDomainLogin(login) ? "test" : "staff");
export const inCustodyScope = (policy: CustodyPolicy, login: string | null | undefined): boolean => circleOf(login) === "staff" || policy.testToo;
export const custodyDeletes = (policy: CustodyPolicy, login: string | null | undefined): boolean =>
  policy.retentionDays > 0 && (circleOf(login) === "test" || policy.personal === "delete");

export const custodyDataSql = (person: string, space: string, liveOnly: boolean): string =>
  `(EXISTS (SELECT 1 FROM record_locations dl WHERE dl.space_id = ${space}${liveOnly ? " AND NOT dl.deleted" : ""})
    OR EXISTS (SELECT 1 FROM record_locations dm WHERE dm.owner_id = ${person} AND dm.type = 'transcript' AND NOT dm.deleted))`;

export const MEETINGS_MOVED_SQL = `SELECT count(*)::int AS n FROM records
  WHERE attrs ? 'organizer_transfer' AND attrs->'organizer_transfer'->>'origin' = $1::text AND parent_id IS NULL
    AND owner_id::text = attrs->'organizer_transfer'->>'to'`;

export async function meetingsMovedOf(dbs: readonly Queryable[], personId: string): Promise<number> {
  let n = 0;
  for (const db of dbs) n += Number((await db.query(MEETINGS_MOVED_SQL, [personId])).rows[0]?.n ?? 0);
  return n;
}

export const MEETINGS_HANDED_SQL = `SELECT EXISTS (SELECT 1 FROM records
  WHERE attrs ? 'organizer_transfer' AND attrs->'organizer_transfer'->>'origin' = $1::text AND parent_id IS NULL) AS handed`;

export async function meetingsHandedFrom(dbs: readonly Queryable[], personId: string): Promise<boolean> {
  for (const db of dbs) if ((await db.query(MEETINGS_HANDED_SQL, [personId])).rows[0]?.handed === true) return true;
  return false;
}

export const custodyLockKey = (instanceId: string): string => `custody:${instanceId}`;

export async function lockCustody(q: Queryable, instanceId: string): Promise<void> {
  await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [custodyLockKey(instanceId)]);
}

export async function tryLockCustody(q: Queryable, instanceId: string): Promise<boolean> {
  return (await q.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok", [custodyLockKey(instanceId)])).rows[0]?.ok === true;
}

export const meetingSharedSql = (r = "r", person = "$1"): string =>
  `(EXISTS (SELECT 1 FROM record_people rp WHERE rp.record_id = ${r}.id AND rp.person_id <> ${person})
    OR (jsonb_typeof(${r}.attrs->'participants_pending') = 'array' AND jsonb_array_length(${r}.attrs->'participants_pending') > 0))`;

export function meetingOriginOf(mark: unknown, owner: string): string {
  const t = mark && typeof mark === "object" && !Array.isArray(mark) ? mark as Record<string, unknown> : null;
  return t && t.to === owner && typeof t.origin === "string" && t.origin ? t.origin : owner;
}

export const HANDED_PARTS_SQL = `SELECT id, owner_id, source_ref, attrs->'organizer_transfer'->>'origin' AS origin, attrs->'organizer_transfer'->>'basis' AS basis,
       hidden_at IS NOT NULL AS hidden FROM records
  WHERE source_kind = 'transcriber' AND parent_id IS NULL AND source_ref = ANY($1::text[]) AND deleted_at IS NULL
    AND owner_id <> $2::uuid AND attrs ? 'organizer_transfer'`;
export const HANDED_VISIBLE_SQL = "SELECT id FROM records WHERE id = ANY($1::uuid[]) AND hidden_at IS NULL";

export const handedKey = (ref: string, origin: string): string => `${ref}\u0000${origin}`;

export interface HandedRoot { id: string; owner_id: string; source_ref: string; origin: string; basis: string | null }

export async function handedRoots(dbs: readonly Queryable[], refs: readonly string[], person: string): Promise<HandedRoot[]> {
  if (!refs.length) return [];
  const rows: Array<HandedRoot & { hidden: boolean }> = [];
  for (const db of dbs)
    for (const r of (await db.query(HANDED_PARTS_SQL, [[...new Set(refs)], person])).rows)
      if (typeof r.origin === "string" && r.origin)
        rows.push({ id: r.id as string, owner_id: r.owner_id as string, source_ref: r.source_ref as string, origin: r.origin, basis: (r.basis ?? null) as string | null,
                    hidden: r.hidden === true });
  const hidden = [...new Set(rows.filter((r) => r.hidden).map((r) => r.id))];
  const visible = new Set<string>();
  if (hidden.length) for (const db of dbs) for (const r of (await db.query(HANDED_VISIBLE_SQL, [hidden])).rows) visible.add(r.id as string);
  return rows.filter((r) => !r.hidden || !visible.has(r.id)).map(({ hidden: _hidden, ...r }) => r);
}

export async function handedParts(dbs: readonly Queryable[], refs: readonly string[], person: string): Promise<Set<string>> {
  return new Set((await handedRoots(dbs, refs, person)).map((r) => handedKey(r.source_ref, r.origin)));
}

export async function despiteShown(q: Queryable, rows: ReadonlyArray<{ id: string; holder: string; since?: string | null }>): Promise<Set<string>> {
  if (!rows.length) return new Set();
  const by = new Map(rows.map((r) => [r.id, r]));
  const last = (await q.query(
    `SELECT DISTINCT ON (cm.record_id) cm.record_id, cm.requested_by, COALESCE(cm.finished_at, cm.requested_at) AS at,
            (cm.accepted_rules IS NOT NULL OR COALESCE((to_jsonb(cm)->>'text_only')::boolean, false)) AS despite
       FROM class_moves cm WHERE cm.record_id = ANY($1::uuid[]) AND cm.to_class = 'open' AND cm.status = 'done'
      ORDER BY cm.record_id, cm.finished_at DESC NULLS LAST, cm.requested_at DESC`, [[...by.keys()]])).rows;
  const before = (at: unknown, since: string | null | undefined) => !since || !Number.isFinite(Date.parse(since)) || new Date(at as string).getTime() < Date.parse(since);
  return new Set(last.filter((r) => { const x = by.get(r.record_id)!; return r.despite === true && r.requested_by !== x.holder && before(r.at, x.since); })
    .map((r) => r.record_id as string));
}

export const HELD_ORIGINS_SQL = `SELECT p.id::text AS id FROM people p
  WHERE p.instance_id = $1 AND NOT ${testLoginSql("p")} AND NOT ${showcaseSql("p")} ORDER BY p.id`;

export async function heldOrigins(q: Queryable, instanceId: string, policy: Pick<CustodyPolicy, "personal">): Promise<string[]> {
  if (policy.personal !== "keep") return [];
  return (await q.query(HELD_ORIGINS_SQL, [instanceId])).rows.map((r) => r.id as string);
}

export const heldTreeCte = (param: number): string => `held_tree(id) AS (
    SELECT h.id FROM records h WHERE h.attrs ? 'organizer_transfer' AND h.attrs->'organizer_transfer'->>'origin' = ANY($${param}::text[])
    UNION SELECT k.id FROM records k JOIN held_tree t ON k.parent_id = t.id)`;

export const HELD_TRANSFER_SQL = `WITH RECURSIVE ${heldTreeCte(2)} SELECT id FROM held_tree WHERE id = ANY($1::uuid[])`;

export async function heldTransferred(db: Queryable, ids: readonly string[], origins: readonly string[]): Promise<Set<string>> {
  if (!ids.length || !origins.length) return new Set();
  return new Set((await db.query(HELD_TRANSFER_SQL, [[...new Set(ids)], [...origins]])).rows.map((r) => r.id as string));
}

export const HELD_TRANSFER_TEXTS = {
  refused: "This meeting cannot be permanently deleted: it was transferred to you from an employee who left, and their records are retained. It will remain in Trash and can be restored",
  deleted: "in the Trash and exempt from permanent deletion while the former organizer’s records are under retention",
  trash: "kept for as long as the former organiser’s records are retained",
} as const;

export const custodyCurrentSql = (c = "c", s = "s"): string => `${c}.created_at >= ${s}.archived_at`;

export async function hasCustodyData(q: Queryable, personId: string, spaceId: string, liveOnly = false): Promise<boolean> {
  return (await q.query(`SELECT ${custodyDataSql("$1::uuid", "$2::uuid", liveOnly)} AS has`, [personId, spaceId])).rows[0]?.has === true;
}

export interface CustodyPerson {
  id: string; login: string; active: boolean; demo: boolean; instance_id: string;
  manager_login: string | null; department: string | null; department_code: string | null;
  created_at?: Date | string | null;
  dismissed_at?: Date | string | null;
  detached?: readonly string[] | null;
}
export interface CustodyWorld {
  instanceId: string;
  byId: Map<string, CustodyPerson>;
  byLogin: Map<string, CustodyPerson>;
  snapshotManager: Map<string, string | null>;
  units: Map<string, string | null>;
  heads: Map<string, string[]>;
}
export interface CustodySnapshot { manager_login: string | null; org_unit_ids: readonly string[] }
export interface CustodyPick {
  id: string | null; basis: Exclude<CustodyBasis, "manual">; levels: number;
  chain: string[];
}

const normLogin = (v: string | null | undefined): string | null => {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return s || null;
};

export function departmentUnits(instanceId: string, p: Pick<CustodyPerson, "department" | "department_code">): string[] {
  const code = (p.department_code ?? "").trim() || (p.department ? slugify(p.department, "unit") : "");
  return code ? [orgUnitId(instanceId, code)] : [];
}

export function custodianFits(p: Pick<CustodyPerson, "id" | "login" | "instance_id">, x: CustodyPerson | undefined | null): x is CustodyPerson {
  return !!x && x.active && !x.demo && x.instance_id === p.instance_id && x.id !== p.id && circleOf(x.login) === circleOf(p.login);
}

const timeOf = (v: Date | string | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const t = (v instanceof Date ? v : new Date(v)).getTime();
  return Number.isFinite(t) ? t : null;
};

export function cardAfterDismissal(from: Pick<CustodyPerson, "active" | "dismissed_at">, x: Pick<CustodyPerson, "created_at">): boolean {
  if (from.active) return false;
  const off = timeOf(from.dismissed_at), born = timeOf(x.created_at);
  return off !== null && born !== null && born > off;
}

export const CUSTODY_DETACHED_ATTR = "custody_detached";

export function detachedOf(v: unknown): string[] {
  return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase()).filter(Boolean))] : [];
}

export function refDetached(from: Pick<CustodyPerson, "active" | "detached">, m: string | null): boolean {
  return !from.active && !!m && !!from.detached?.includes(m);
}

export function lateManager(w: CustodyWorld, p: CustodyPerson, snap: Pick<CustodySnapshot, "manager_login">): CustodyPerson | null {
  const m = normLogin(snap.manager_login);
  const x = m ? w.byLogin.get(m) : undefined;
  return x && (cardAfterDismissal(p, x) || refDetached(p, m)) && custodianFits(p, x) ? x : null;
}

export function chainPick(w: CustodyWorld, p: CustodyPerson, snap: CustodySnapshot): CustodyPick {
  let pick: { id: string; basis: CustodyPick["basis"]; levels: number } | null = null;
  const chain: string[] = [];
  const take = (x: CustodyPerson, basis: CustodyPick["basis"], levels: number) => {
    if (!chain.includes(x.id)) chain.push(x.id);
    if (!pick) pick = { id: x.id, basis, levels };
  };
  const seen = new Set<string>([p.id]);
  let m = normLogin(snap.manager_login);
  let from: CustodyPerson = p;
  for (let step = 0; step < CUSTODY_CHAIN_LIMIT && m; step++) {
    const x = w.byLogin.get(m);
    if (!x || seen.has(x.id) || cardAfterDismissal(from, x) || refDetached(from, m)) break;
    if (custodianFits(p, x)) take(x, "manager", step);
    seen.add(x.id);
    from = x;
    m = normLogin(w.snapshotManager.has(x.id) ? w.snapshotManager.get(x.id) : x.manager_login);
  }
  const units = snap.org_unit_ids.length ? snap.org_unit_ids : departmentUnits(w.instanceId, p);
  for (const start of units) {
    const visited = new Set<string>();
    let u: string | null = start;
    for (let level = 0; level < CUSTODY_CHAIN_LIMIT && u && !visited.has(u); level++) {
      visited.add(u);
      const heads = (w.heads.get(u) ?? []).map((id) => w.byId.get(id)).filter((x): x is CustodyPerson => custodianFits(p, x))
        .sort((a, b) => (a.login < b.login ? -1 : a.login > b.login ? 1 : 0));
      for (const h of heads) take(h, "department_head", level);
      u = w.units.get(u) ?? null;
    }
  }
  const got = pick as { id: string; basis: CustodyPick["basis"]; levels: number } | null;
  return got ? { ...got, chain } : { id: null, basis: "admin", levels: 0, chain };
}

export async function custodyWorld(q: Queryable, instanceId: string): Promise<CustodyWorld> {
  const people = (await q.query(
    `SELECT p.id, p.login, p.active, ${showcaseSql("p")} AS demo, p.instance_id, p.manager_login, p.department, p.attrs->>'department_code' AS department_code,
            p.created_at, (SELECT max(s.archived_at) FROM spaces s WHERE s.kind = 'personal' AND s.owner_id = p.id) AS dismissed_at,
            p.attrs->'${CUSTODY_DETACHED_ATTR}' AS detached
     FROM people p WHERE p.instance_id = $1`, [instanceId])).rows.map((r) => ({ ...r, detached: detachedOf(r.detached) })) as CustodyPerson[];
  const byId = new Map(people.map((p) => [p.id, p]));
  const byLogin = new Map(people.map((p) => [p.login.toLowerCase(), p]));
  const snapshotManager = new Map<string, string | null>((await q.query("SELECT person_id, manager_login FROM personal_custody WHERE instance_id = $1", [instanceId]))
    .rows.map((r) => [r.person_id as string, (r.manager_login as string | null) ?? null]));
  const units = new Map<string, string | null>((await q.query("SELECT id, parent_id FROM org_units WHERE instance_id = $1", [instanceId]))
    .rows.map((r) => [r.id as string, (r.parent_id as string | null) ?? null]));
  const heads = new Map<string, string[]>();
  for (const r of (await q.query(
    `SELECT h.org_unit_id, h.person_id FROM person_org_units h JOIN org_units u ON u.id = h.org_unit_id AND u.instance_id = $1 WHERE h.relation = 'head'`, [instanceId])).rows)
    heads.set(r.org_unit_id, [...(heads.get(r.org_unit_id) ?? []), r.person_id]);
  return { instanceId, byId, byLogin, snapshotManager, units, heads };
}

export function inCustodyChains(w: CustodyWorld, personId: string,
                                rows: ReadonlyArray<{ person_id: string; custodian_id: string | null } & CustodySnapshot>): boolean {
  const me = w.byId.get(personId);
  if (!me) return false;
  const on: CustodyPerson = { ...me, active: true };
  const sim: CustodyWorld = { ...w, byId: new Map(w.byId).set(on.id, on), byLogin: new Map(w.byLogin).set(on.login.toLowerCase(), on) };
  for (const r of rows) {
    if (r.person_id === personId) continue;
    if (r.custodian_id === personId) return true;
    const p = sim.byId.get(r.person_id);
    if (p && !p.active && chainPick(sim, p, r).chain.includes(personId)) return true;
  }
  return false;
}

export async function custodyChainHolds(q: Queryable, instanceId: string, personId: string, policy?: CustodyPolicy,
                                        snapshots?: ReadonlyMap<string, { manager: string | null; units: readonly string[] }>): Promise<boolean> {
  const rows = (await q.query(
    "SELECT person_id, custodian_id, manager_login, org_unit_ids FROM personal_custody WHERE instance_id = $1 AND person_id <> $2", [instanceId, personId])).rows
    .map((r) => ({ person_id: r.person_id as string, custodian_id: (r.custodian_id ?? null) as string | null, manager_login: (r.manager_login ?? null) as string | null,
                   org_unit_ids: (r.org_unit_ids ?? []) as string[] }));
  if (policy)
    for (const p of await pendingCustodyRows(q, instanceId, policy)) {
      if (p.person_id === personId) continue;
      const snap = snapshots?.get(p.person_id);
      rows.push({ person_id: p.person_id, custodian_id: null, manager_login: snap ? normLogin(snap.manager) : p.manager_login, org_unit_ids: snap ? [...snap.units] : p.org_unit_ids });
    }
  if (!rows.length) return false;
  return inCustodyChains(await custodyWorld(q, instanceId), personId, rows);
}

export interface PendingCustodyRow { person_id: string; space_id: string; login: string; manager_login: string | null; org_unit_ids: string[] }

export async function pendingCustodyRows(q: Queryable, instanceId: string, policy: CustodyPolicy): Promise<PendingCustodyRow[]> {
  const cands = (await q.query(
    `SELECT p.id, p.login, p.manager_login, p.department, p.attrs->>'department_code' AS department_code, s.id AS space_id,
            ${custodyDataSql("p.id", "s.id", false)} AS has_any, ${custodyDataSql("p.id", "s.id", true)} AS has_live
     FROM people p JOIN spaces s ON s.kind = 'personal' AND s.owner_id = p.id
     WHERE p.instance_id = $1 AND NOT p.active AND NOT ${showcaseSql("p")}
       AND NOT EXISTS (SELECT 1 FROM personal_custody c WHERE c.person_id = p.id OR c.space_id = s.id)
     ORDER BY s.id`, [instanceId])).rows;
  const out: PendingCustodyRow[] = [];
  let known: Set<string> | null = null;
  for (const p of cands) {
    if (!inCustodyScope(policy, p.login) || !(custodyDeletes(policy, p.login) ? p.has_live : p.has_any)) continue;
    known ??= new Set((await q.query("SELECT id FROM org_units WHERE instance_id = $1", [instanceId])).rows.map((r) => r.id as string));
    out.push({ person_id: p.id, space_id: p.space_id, login: p.login, manager_login: normLogin(p.manager_login),
               org_unit_ids: departmentUnits(instanceId, p).filter((u) => known!.has(u)) });
  }
  return out;
}

export async function resolveCustodian(q: Queryable, instanceId: string, row: { person_id: string } & CustodySnapshot, world?: CustodyWorld): Promise<CustodyPick> {
  const w = world ?? await custodyWorld(q, instanceId);
  const p = w.byId.get(row.person_id);
  return p ? chainPick(w, p, row) : { id: null, basis: "admin", levels: 0, chain: [] };
}

export type CustodyReason = "assign" | "rule" | "correction" | "custodian_dismissed" | "reactivated" | "orphan" | "policy" | "deleted" | "manual";
export interface CustodyChange {
  person: string; space: string; from: string | null; to: string | null; basis: CustodyBasis | null; levels: number; reason: CustodyReason;
}
export interface CustodySyncResult {
  changes: CustodyChange[];
  created: string[];
  waiting: string[];
}
export const custodyOp = (r: CustodyReason): "custody_assign" | "custody_change" | "custody_end" | "custody_set" =>
  r === "assign" ? "custody_assign" : r === "rule" || r === "correction" || r === "custodian_dismissed" ? "custody_change" : r === "manual" ? "custody_set" : "custody_end";

interface CustodyRow { space_id: string; person_id: string; custodian_id: string | null; basis: CustodyBasis; levels: number; manager_login: string | null; org_unit_ids: string[] }
const ROW_COLS = "space_id, person_id, custodian_id, basis, levels, manager_login, org_unit_ids";
const ended = (rows: any[], reason: CustodyReason): CustodyChange[] =>
  rows.map((r) => ({ person: r.person_id, space: r.space_id, from: r.custodian_id ?? null, to: null, basis: null, levels: 0, reason }));

export async function syncCustody(q: Queryable, instanceId: string, policy: CustodyPolicy, o: {
  snapshots?: ReadonlyMap<string, { manager: string | null; units: readonly string[] }>;
  corrections?: ReadonlyMap<string, string>;
  reactivated?: readonly string[];
  all?: boolean;
} = {}): Promise<CustodySyncResult> {
  const changes: CustodyChange[] = [], created: string[] = [];
  const touched = new Set<string>();
  if (o.reactivated?.length)
    changes.push(...ended((await q.query(`DELETE FROM personal_custody WHERE instance_id = $1 AND person_id = ANY($2::uuid[]) RETURNING ${ROW_COLS}`,
                                         [instanceId, [...o.reactivated]])).rows, "reactivated"));
  const insert = async (p: { id: string; space_id: string }, manager: string | null, units: readonly string[]) => {
    const r = await q.query(
      `INSERT INTO personal_custody (space_id, instance_id, person_id, custodian_id, basis, levels, manager_login, org_unit_ids)
       VALUES ($1, $2, $3, NULL, 'admin', 0, $4, $5::uuid[]) ON CONFLICT DO NOTHING RETURNING person_id`,
      [p.space_id, instanceId, p.id, normLogin(manager), [...new Set(units)]]);
    if (r.rowCount) created.push(p.id);
  };
  if (o.snapshots?.size) {
    const ids = [...o.snapshots.keys()];
    const rows = (await q.query(
      `SELECT p.id, p.login, s.id AS space_id, ${custodyDataSql("p.id", "s.id", false)} AS has_any, ${custodyDataSql("p.id", "s.id", true)} AS has_live
       FROM people p JOIN spaces s ON s.kind = 'personal' AND s.owner_id = p.id
       WHERE p.id = ANY($1::uuid[]) AND p.instance_id = $2 AND NOT p.active AND NOT ${showcaseSql("p")} ORDER BY s.id`, [ids, instanceId])).rows;
    for (const p of rows) {
      touched.add(p.id);
      if (!inCustodyScope(policy, p.login) || !(custodyDeletes(policy, p.login) ? p.has_live : p.has_any)) continue;
      const snap = o.snapshots.get(p.id)!;
      await insert(p, snap.manager, snap.units);
    }
  }
  const corrected = new Set<string>();
  for (const [person, manager] of o.corrections ?? []) {
    const m = normLogin(manager);
    if (!m) continue;
    touched.add(person);
    if ((await q.query("UPDATE personal_custody SET manager_login = $3 WHERE instance_id = $1 AND person_id = $2 AND manager_login IS DISTINCT FROM $3",
                       [instanceId, person, m])).rowCount) corrected.add(person);
  }
  if (o.all) {
    changes.push(...ended((await q.query(
      `DELETE FROM personal_custody c USING spaces s WHERE c.instance_id = $1 AND s.id = c.space_id AND NOT ${custodyCurrentSql("c", "s")}
       RETURNING ${ROW_COLS.split(", ").map((x) => `c.${x}`).join(", ")}`, [instanceId])).rows, "reactivated"));
    for (const p of await pendingCustodyRows(q, instanceId, policy)) await insert({ id: p.person_id, space_id: p.space_id }, p.manager_login, p.org_unit_ids);
    changes.push(...ended((await q.query(
      `DELETE FROM personal_custody c WHERE c.instance_id = $1 AND NOT EXISTS (SELECT 1 FROM people p WHERE p.id = c.person_id AND p.instance_id = c.instance_id)
       RETURNING ${ROW_COLS}`, [instanceId])).rows, "orphan"));
    changes.push(...ended((await q.query(
      `DELETE FROM personal_custody c USING people p WHERE c.instance_id = $1 AND p.id = c.person_id AND p.active RETURNING ${ROW_COLS.split(", ").map((x) => `c.${x}`).join(", ")}`,
      [instanceId])).rows, "reactivated"));
    changes.push(...ended((await q.query(
      `DELETE FROM personal_custody c USING people p WHERE c.instance_id = $1 AND p.id = c.person_id AND NOT p.active
         AND (${showcaseSql("p")} OR (NOT $2::boolean AND ${testLoginSql("p")}))
       RETURNING ${ROW_COLS.split(", ").map((x) => `c.${x}`).join(", ")}`, [instanceId, policy.testToo])).rows, "policy"));
  }
  const w = await custodyWorld(q, instanceId);
  const rows = (await q.query(`SELECT ${ROW_COLS} FROM personal_custody WHERE instance_id = $1 ORDER BY space_id`, [instanceId])).rows as CustodyRow[];
  const waiting: string[] = [];
  for (const row of rows) {
    const p = w.byId.get(row.person_id);
    if (!p) continue;
    const held = row.custodian_id ? w.byId.get(row.custodian_id) : undefined;
    let next: { id: string | null; basis: CustodyBasis; levels: number };
    if (row.basis === "manual" && custodianFits(p, held)) next = { id: row.custodian_id, basis: "manual", levels: row.levels };
    else next = chainPick(w, p, row);
    if (next.id !== row.custodian_id || next.basis !== row.basis || next.levels !== row.levels) {
      const upd = await q.query(
        `UPDATE personal_custody SET custodian_id = $2, basis = $3, levels = $4,
                assigned_at = CASE WHEN custodian_id IS DISTINCT FROM $2 THEN now() ELSE assigned_at END, assigned_by = NULL, reason = NULL,
                by_operator = CASE WHEN custodian_id IS DISTINCT FROM $2 THEN NULL ELSE by_operator END
          WHERE space_id = $1 AND custodian_id IS NOT DISTINCT FROM $5 AND basis = $6`,
        [row.space_id, next.id, next.basis, next.levels, row.custodian_id, row.basis]);
      if (upd.rowCount && next.id !== row.custodian_id)
        changes.push({ person: row.person_id, space: row.space_id, from: row.custodian_id, to: next.id, basis: next.basis, levels: next.levels,
                       reason: row.custodian_id === null ? "assign" : !custodianFits(p, held) ? "custodian_dismissed" : corrected.has(row.person_id) ? "correction" : "rule" });
      if (!upd.rowCount) continue;
    }
    if (next.id === null && (o.all || touched.has(row.person_id))) waiting.push(row.person_id);
  }
  return { changes, created, waiting };
}

export const CUSTODY_TEXTS = {
  personMissing: "This person does not exist.",
  personActive: "This person is an active employee. Custodians are assigned only to former employees.",
  personDemo: "A showcase demo persona cannot have a custodian.",
  nothingToKeep: "This employee has no records or meetings of their own, so no custodian is needed.",
  custodianMissing: "This person does not exist.",
  custodianInactive: "The custodian must be an active employee.",
  custodianSelf: "The former employee cannot be their own custodian.",
  custodianOperator: "You cannot assign yourself as custodian. Memory administrators do not read employee records.",
  operatorUnlinked: "Identify yourself under “Administrator access” so the memory can check that you are assigning someone else as custodian.",
  custodianCircle: "Assign a test account as custodian for a test account and an employee as custodian for an employee.",
  reasonNeeded: "Give a reason because you are assigning someone other than the manager listed in the org table.",
  reasonLateManager: "Give a reason, for example “manager added after the employee left”. This manager’s e-mail address appeared in memory after the employee left, so the assignment is manual.",
  reasonLength: "The reason must be 3–200 characters long.",
} as const;

export class CustodyRefusal extends MemoryError {
  constructor(code: Extract<ErrorCode, "not_found" | "invalid_argument">, readonly httpStatus: 400 | 404 | 409, readonly reason: keyof typeof CUSTODY_TEXTS) {
    super(code, CUSTODY_TEXTS[reason], { details: { reason } });
  }
  override get status(): number { return this.httpStatus; }
}

export const MEETING_HANDOVER_REASON = "organizer_transfer";
export const meetingHandoverBusy = (message: string): MemoryError =>
  new MemoryError("in_progress", message, { retry_after: 60, details: { reason: MEETING_HANDOVER_REASON } });

export interface CustodySetResult {
  change: CustodyChange | null;
  offRule: boolean;
  reasonChanged?: boolean;
}

export async function setCustodian(q: Queryable, instanceId: string, policy: CustodyPolicy, a: {
  personLogin: string; custodianLogin: string | null; reason?: string | null; actorLabel: string; operatorId: string | null; operatorUnknown?: boolean;
}): Promise<CustodySetResult> {
  const refuse = (status: 400 | 404 | 409, reason: keyof typeof CUSTODY_TEXTS) =>
    new CustodyRefusal(status === 404 ? "not_found" : "invalid_argument", status, reason);
  const w = await custodyWorld(q, instanceId);
  const p = w.byLogin.get(normLogin(a.personLogin) ?? "");
  if (!p) throw refuse(404, "personMissing");
  if (p.active) throw refuse(409, "personActive");
  if (p.demo || isShowcaseLogin(p.login)) throw refuse(400, "personDemo");
  const row = (await q.query(`SELECT ${ROW_COLS}, reason FROM personal_custody WHERE instance_id = $1 AND person_id = $2 FOR UPDATE`, [instanceId, p.id])).rows[0] as
    (CustodyRow & { reason: string | null }) | undefined;
  if (!row) throw refuse(409, "nothingToKeep");
  const pick = chainPick(w, p, row);
  if (a.custodianLogin === null) {
    if (pick.id === row.custodian_id && pick.basis === row.basis && pick.levels === row.levels) return { change: null, offRule: false };
    await q.query(
      `UPDATE personal_custody SET custodian_id = $2, basis = $3, levels = $4,
              assigned_at = CASE WHEN custodian_id IS DISTINCT FROM $2 THEN now() ELSE assigned_at END, assigned_by = NULL, reason = NULL,
              by_operator = CASE WHEN custodian_id IS DISTINCT FROM $2 THEN NULL ELSE by_operator END WHERE space_id = $1`,
      [row.space_id, pick.id, pick.basis, pick.levels]);
    return { change: { person: p.id, space: row.space_id, from: row.custodian_id, to: pick.id, basis: pick.basis, levels: pick.levels, reason: "manual" }, offRule: false };
  }
  const c = w.byLogin.get(normLogin(a.custodianLogin) ?? "");
  if (!c) throw refuse(400, "custodianMissing");
  if (c.id === p.id) throw refuse(400, "custodianSelf");
  if (a.operatorUnknown) throw refuse(409, "operatorUnlinked");
  if (a.operatorId && c.id === a.operatorId) throw refuse(409, "custodianOperator");
  if (!c.active || c.demo) throw refuse(400, "custodianInactive");
  if (circleOf(c.login) !== circleOf(p.login)) throw refuse(400, "custodianCircle");
  const reason = typeof a.reason === "string" ? a.reason.replace(/\s+/g, " ").trim() : "";
  const offRule = !pick.chain.includes(c.id);
  if (reason && (reason.length < 3 || reason.length > 200)) throw refuse(400, "reasonLength");
  if (offRule && !reason) throw refuse(400, lateManager(w, p, row)?.id === c.id ? "reasonLateManager" : "reasonNeeded");
  const same = row.custodian_id === c.id && row.basis === "manual";
  if (same && (row.reason ?? null) === (reason || null)) return { change: null, offRule };
  await q.query(
    `UPDATE personal_custody SET custodian_id = $2, basis = 'manual', levels = 0, assigned_at = now(), assigned_by = $3, reason = $4,
            by_operator = CASE WHEN custodian_id IS DISTINCT FROM $2 THEN NULL ELSE by_operator END WHERE space_id = $1`,
    [row.space_id, c.id, a.actorLabel, reason || null]);
  return { change: { person: p.id, space: row.space_id, from: row.custodian_id, to: c.id, basis: "manual", levels: 0, reason: "manual" }, offRule,
           ...(same ? { reasonChanged: true } : {}) };
}
