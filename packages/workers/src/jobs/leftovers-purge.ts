import { createHash } from "node:crypto";
import { closeSync, existsSync, fchmodSync, openSync, readdirSync, readFileSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { auditArchivedBefore, chainTreeSql, isShowcaseLogin, isTestDomainLogin, liveApplicationNames, log, s3List, s3Remove, SHOWCASE_LOGINS, syncDeletionMarks, tx, LockConnectionLost, watchLock, type DataClass } from "@memory/shared";
import { auditWorkerStrict, recordsDb, type DbCtx } from "../ctx.ts";
import { judgeAll, type JudgeWorld, type Kind, type Loc, type Person, type SpaceInfo, type TreeRow } from "./leftovers.ts";
import { deleteLocators, purgeLinks, type HeldLocator } from "./links.ts";
import { purgeRetrying, PurgeStop, type PurgeCtx } from "./maintenance.ts";
import { CLASSES, liveHashes, movingHashes, purgedTombsByHash, STORAGE_MAX, unreferencedObjects } from "./storage-orphans.ts";

export const TEST_PURGE_BATCH = 500;
const RECORDS_BATCH = 1000;
const TREE_CHUNK = 1000;
const PLAN_V = 1;
export const BASIS_RE = /^approval [0-9]+(; [^\n]{0,80})?$/;
const PLAN_MAX_AGE_MS = 24 * 3_600_000;
const PURGE_WAIT_MS = 5 * 60_000;
const TP_RETURN_TABLES = ["people", "spaces", "space_members", "api_keys", "oauth_connections", "services", "user_sessions", "role_grants"] as const;
void TP_RETURN_TABLES;

const KNOWN_FK: Record<string, string[]> = {
  people: ["action_plans.person_id", "admin_users.person_id", "api_keys.created_by", "class_moves.requested_by", "deletion_requests.owner_id", "deletion_requests.requester_id",
    "directory_group_members.person_id", "oauth_connections.person_id", "person_identities.person_id", "person_identities.verified_by", "person_org_units.person_id",
    "record_links.created_by", "record_links.decided_by", "record_locations.owner_id", "role_grants.created_by", "role_grants.person_id", "role_grants.revoked_by",
    "space_groups.added_by", "space_members.added_by", "space_members.person_id", "spaces.archived_by", "spaces.created_by", "spaces.owner_id", "upload_tickets.person_id", "user_sessions.person_id"],
  spaces: ["record_locations.space_id", "services.write_space_id", "space_groups.space_id", "space_members.space_id"],
  api_keys: ["oauth_connections.id", "upload_tickets.key_id"],
  org_units: ["org_units.parent_id", "person_org_units.org_unit_id", "spaces.org_unit_id"],
};

export const STOP_CODES = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9", "S10", "S11", "S12", "S13", "S14", "S15", "S16", "S17", "S18"] as const;
export type StopCode = (typeof STOP_CODES)[number];
export class TestPurgeStop extends Error {
  constructor(readonly codes: StopCode[], message: string, readonly detail: Record<string, unknown> = {}) { super(message); }
}

type Q = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };
interface Dbs { control: Q; records: (cls: DataClass) => Q; audit: Q }
type Ids = string[];

const uniq = <T>(xs: Iterable<T>): T[] => [...new Set(xs)];
const sorted = (xs: Iterable<string>): string[] => uniq(xs).sort();
const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));
const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
function sortDeep(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(sortDeep);
  if (x && typeof x === "object" && !(x instanceof Date)) return Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, sortDeep((x as any)[k])]));
  return x;
}
export const canon = (x: unknown): string => JSON.stringify(sortDeep(x));
const nonEmpty = (v: unknown): boolean =>
  Array.isArray(v) ? v.length > 0 : v !== null && typeof v === "object" ? Object.keys(v as object).length > 0 : typeof v === "string" ? v.trim() !== "" : false;
const ms = (d: Date | string | null | undefined): number | null => (d === null || d === undefined ? null : new Date(d).getTime());
const tlogin = (login: string): boolean => isTestDomainLogin(login) && !isShowcaseLogin(login);
const RUN_LABEL = /^([a-z]+-[0-9a-f]{6,})-/;

function writeNew(file: string, data: unknown): void {
  const fd = openSync(file, "wx", 0o600);
  try { fchmodSync(fd, 0o600); writeSync(fd, typeof data === "string" ? data : JSON.stringify(data, null, 1)); }
  finally { closeSync(fd); }
}
const readJson = (file: string): any => JSON.parse(readFileSync(file, "utf8"));
export function appliedPath(plan: string): string {
  if (!existsSync(`${plan}.applied.json`)) return `${plan}.applied.json`;
  for (let i = 2; ; i++) if (!existsSync(`${plan}.applied.${i}.json`)) return `${plan}.applied.${i}.json`;
}
function appliedFiles(plan: string): any[] {
  const out: any[] = [];
  if (existsSync(`${plan}.applied.json`)) out.push(readJson(`${plan}.applied.json`));
  for (let i = 2; existsSync(`${plan}.applied.${i}.json`); i++) out.push(readJson(`${plan}.applied.${i}.json`));
  return out;
}

export interface PurgeSettings { purge: "off" | "auto"; after_hours: number; max: number; leftovers_scope: string; grace: number }
export async function purgeSettings(q: Q, instanceId: string): Promise<PurgeSettings> {
  const rows = (await q.query(
    `SELECT key, COALESCE(value, default_value) AS value FROM settings WHERE instance_id = $1 AND category = 'access'
       AND key IN ('test_purge', 'test_purge_after_hours', 'test_purge_max', 'test_leftovers_scope', 'test_leftovers_grace_minutes')`, [instanceId])).rows;
  const v = (k: string) => rows.find((r) => r.key === k)?.value;
  const int = (x: unknown, lo: number, hi: number, d: number) => (typeof x === "number" && Number.isInteger(x) && x >= lo && x <= hi ? x : d);
  return {
    purge: v("test_purge") === "auto" ? "auto" : "off",
    after_hours: int(v("test_purge_after_hours"), 1, 8760, 24),
    max: int(v("test_purge_max"), 1, 100_000, 500),
    leftovers_scope: ["off", "org", "all"].includes(v("test_leftovers_scope")) ? v("test_leftovers_scope") : "org",
    grace: int(v("test_leftovers_grace_minutes"), 1, 10080, 60),
  };
}
export const ageLowerBound = (s: PurgeSettings): number => Math.max(60, s.grace);

export interface ExpectCheck { path: string; max?: number; eq?: unknown }
export interface Baseline { control: Record<string, { n: number; sha: string }>; open: Record<string, { n: number; sha: string }>; closed: Record<string, { n: number; sha: string }> }
export interface Expected { staff_active: number; active_spaces: number; showcase: { personas: number; spaces: number; units: number } }
export interface MeetingRef { root: string; cls: DataClass; fp: string }
export interface MarkRef { kind: "org_unit" | "service"; id: string; evidence: string[]; owner_listed: boolean }
export interface PurgePlan {
  kind: "test_purge_plan"; v: 1; instance: string; at: string; mode: "manual" | "auto"; age_minutes: number;
  inputs: { meetings_sha: string | null; approve_sha: string | null; expect_sha: string | null; expect: ExpectCheck[] };
  t_all: Ids;
  people: Ids; personal: Ids; spaces: Ids; records: { open: Ids; closed: Ids };
  meetings: Array<MeetingRef & { ids: Ids }>;
  tickets: Ids; keys: Ids; oauth: Ids; sessions: Ids; grants: Ids; members: Array<[string, string]>;
  person_attrs: Ids; services: Ids; org_units: Ids; marks: MarkRef[];
  entities: { person: Ids; project: Ids };
  class_moves: Ids; deletion_requests: Ids; mail: Ids; action_plans: Ids; orphan_locators: Ids;
  storage_orphans: { open: string[]; closed: string[] };
  links: Ids;
  derived_keep?: Ids;
  guard: { owners: Ids; spaces: Ids };
  kept: Record<string, Record<string, Ids>>;
  mail_to_staff: { count: number; by_day: Record<string, number> };
  baseline: Baseline;
  expected: Expected;
  sha256: string;
}
type PlanBody = Omit<PurgePlan, "sha256" | "baseline" | "inputs">;

interface BuildOpts {
  mode: "manual" | "auto";
  age: number;
  meetings: MeetingRef[] | "all" | null;
  marks: MarkRef[];
  tAll?: Ids;
  s3: PurgeCtx["s3"] | null;
  held?: HeldLocator[];
}

interface Built {
  at: string; now: Date; settings: PurgeSettings; age: number; mode: "manual" | "auto";
  body: PlanBody;
  counters: Record<string, unknown>;
  proof: Record<string, number>;
  stops: StopCode[];
  work: { busy: number; stale_running: number; pgboss_jobs: number; moving: number; mail_pending: number; in_both_dbs: number };
  meetingsAll: Array<MeetingRef & { ids: Ids; kept: string[] }>;
  approveOut: { org_units: Array<Record<string, unknown>>; services: Array<Record<string, unknown>> };
  originals: { count: number; bytes: number };
  rejectedMeetings: { changed: Ids; bad: Ids; missing: Ids };
  unitsWithoutOrigin: Ids; servicesWithoutOrigin: Ids;
  storageDown: DataClass[];
}

type Kept = Record<string, Record<string, Set<string>>>;
const keep = (k: Kept, kind: string, code: string, id: string) => { ((k[kind] ??= {})[code] ??= new Set()).add(id); };
const keptOut = (k: Kept): Record<string, Record<string, Ids>> =>
  Object.fromEntries(Object.entries(k).map(([kind, codes]) => [kind, Object.fromEntries(Object.entries(codes).map(([c, s]) => [c, sorted(s)]))]));
const keptCounts = (k: Kept, kind: string): Record<string, number> => Object.fromEntries(Object.entries(k[kind] ?? {}).map(([c, s]) => [c, s.size]));

export function syntheticName(s: unknown): boolean {
  if (typeof s !== "string" || s.includes("@")) return false;
  const w = s.trim().split(/\s+/);
  return w.length >= 2 && w.length <= 5 && /^[0-9a-f]{6,16}$/.test(w[w.length - 1]!);
}
const norm = (s: string) => s.toLowerCase().trim().split(/\s+/).join(" ");
export function staffNameHit(s: string, staff: { names: Set<string>; loginParts: Set<string> }): boolean {
  const words = s.trim().split(/\s+/).slice(0, -1).map((w) => w.toLowerCase());
  const name = words.join(" ");
  if (!name) return false;
  if (staff.names.has(name) || staff.names.has([...words].reverse().join(" "))) return true;
  if (words.length >= 2 && staff.names.has([words[1], words[0], ...words.slice(2)].join(" "))) return true;
  return words.some((w) => w.length >= 4 && staff.loginParts.has(w));
}
export function meetingFp(t: { root: string; cls: DataClass; space_id: string; owner_id: string; ids: string[]; unresolved: unknown; pending: unknown; people: Array<[string, string]> }): string {
  return sha256(canon({ root: t.root, cls: t.cls, space_id: t.space_id, owner_id: t.owner_id, ids: [...t.ids].sort(),
    participants_unresolved: t.unresolved ?? null, participants_pending: t.pending ?? null,
    record_people: [...t.people].map((p) => `${p[0]}:${p[1]}`).sort() }));
}

interface PRow { id: string; login: string; active: boolean; department: string | null; display_name: string; attrs: any; emp: boolean; manager_login: string | null; updated_at: Date; showcase_member: boolean }
interface SRow { id: string; slug: string; kind: string; owner_id: string | null; created_by: string | null; archived_at: Date | null; archived_by: string | null; org_unit_id: string | null; unit_code: string | null }
interface RRow { id: string; parent_id: string | null; owner_id: string; space_id: string; confirmed_by: string | null; deleted_by: string | null; deleted: boolean; cls: DataClass }
interface TRow extends TreeRow { parent_id: string | null; cls: DataClass; running_stale: boolean; deleted_batch: string | null }

async function buildPlan(inst: string, dbs: Dbs, o: BuildOpts, settingsGet: (k: string, d: any) => any): Promise<Built> {
  const c = dbs.control;
  const now = new Date((await c.query("SELECT now() AS now")).rows[0].now);
  const at = now.toISOString();
  const st = await purgeSettings(c, inst);
  const age = Math.max(o.age, ageLowerBound(st));
  const cutoff = now.getTime() - age * 60_000;
  const aged = (d: Date | string | null | undefined) => { const t = ms(d); return t !== null && t <= cutoff; };
  const kept: Kept = {};

  const people: PRow[] = (await c.query(
    `SELECT p.id, p.login, p.active, p.department, p.display_name, p.attrs, p.employee_id IS NOT NULL AS emp, p.manager_login, p.updated_at,
            EXISTS (SELECT 1 FROM spaces s LEFT JOIN org_units u ON u.id = s.org_unit_id WHERE (s.slug = 'demo-showcase' OR u.code = 'demo')
                     AND (s.owner_id = p.id OR EXISTS (SELECT 1 FROM space_members m WHERE m.space_id = s.id AND m.person_id = p.id))) AS showcase_member
     FROM people p WHERE p.instance_id = $1`, [inst])).rows;
  const person = new Map(people.map((p) => [p.id, p]));
  const T = new Set(people.filter((p) => tlogin(p.login) && !p.showcase_member).map((p) => p.id));
  const Tl = new Set(people.filter((p) => tlogin(p.login)).map((p) => p.id));
  const keys = (await c.query("SELECT id, principal_type, principal_id, revoked_at, expires_at, last_used_at, created_by FROM api_keys WHERE instance_id = $1", [inst])).rows;
  const services = (await c.query("SELECT id, name, active, created_at, write_space_id FROM services WHERE instance_id = $1", [inst])).rows;
  const deps = (await c.query(
    "SELECT person_id, kind, id, key_id, eligible, live, admin_user, last_seen FROM tp_dependents($1, $2::uuid[], make_interval(mins => $3), $4::uuid[])",
    [inst, [...T], age, keys.filter((k) => k.principal_type === "service" || (k.principal_type === "person" && T.has(k.principal_id))).map((k) => k.id)])).rows;
  const admin = new Set(deps.filter((d) => d.kind === "person" && d.admin_user).map((d) => d.person_id as string));
  const lastSeen = new Map<string, Date | null>(deps.filter((d) => d.kind === "person").map((d) => [d.person_id as string, d.last_seen]));
  const T0 = new Set([...T].filter((id) => !person.get(id)!.active && !admin.has(id)));
  for (const id of T) { const p = person.get(id)!; if (!p.active && admin.has(id)) keep(kept, "people", "admin_user", id); }

  const spaces: SRow[] = (await c.query(
    `SELECT s.id, s.slug, s.kind, s.owner_id, s.created_by, s.archived_at, s.archived_by, s.org_unit_id, u.code AS unit_code
     FROM spaces s LEFT JOIN org_units u ON u.id = s.org_unit_id WHERE s.instance_id = $1`, [inst])).rows;
  const space = new Map(spaces.map((s) => [s.id, s]));
  const showcaseSpace = (s: SRow | undefined) => !!s && (s.slug === "demo-showcase" || s.unit_code === "demo");
  const personalOf = new Map(spaces.filter((s) => s.kind === "personal" && s.owner_id).map((s) => [s.owner_id!, s]));
  const members = (await c.query(
    "SELECT m.space_id, m.person_id, m.added_by, m.grant_id FROM space_members m JOIN spaces s ON s.id = m.space_id WHERE s.instance_id = $1", [inst])).rows as Array<{ space_id: string; person_id: string; added_by: string | null; grant_id: string | null }>;
  const groups = (await c.query("SELECT g.space_id, g.added_by FROM space_groups g JOIN spaces s ON s.id = g.space_id WHERE s.instance_id = $1", [inst])).rows;
  const moved = new Set<string>();
  for (const r of (await c.query("SELECT DISTINCT from_space_id, to_space_id FROM space_moves")).rows) { if (r.from_space_id) moved.add(r.from_space_id); if (r.to_space_id) moved.add(r.to_space_id); }
  const grants = (await c.query("SELECT id, person_id, scope_kind, scope_ref, revoked_at, valid_to, revoked_by, created_by FROM role_grants WHERE instance_id = $1", [inst])).rows;
  const liveGrant = (g: any) => !g.revoked_at && (!g.valid_to || ms(g.valid_to)! > now.getTime());
  const oauth = (await c.query("SELECT id, person_id FROM oauth_connections WHERE instance_id = $1", [inst])).rows;
  const mentionedSvc = new Set<string>((await c.query(
    `SELECT s.id FROM services s WHERE s.instance_id = $1 AND EXISTS (SELECT 1 FROM settings st WHERE st.instance_id = $1
       AND (strpos(COALESCE(st.value::text, ''), s.id::text) > 0 OR strpos(COALESCE(st.default_value::text, ''), s.id::text) > 0
            OR strpos(COALESCE(st.value::text, ''), '"' || s.name || '"') > 0 OR strpos(COALESCE(st.default_value::text, ''), '"' || s.name || '"') > 0))`, [inst])).rows.map((r) => r.id));
  const linkRefs = (await c.query("SELECT id, src_id, dst_id, created_by, decided_by FROM record_links WHERE created_by = ANY($1::uuid[]) OR decided_by = ANY($1::uuid[])", [[...T]])).rows;
  const units = (await c.query("SELECT id, code, name, parent_id, active, attrs, updated_at FROM org_units WHERE instance_id = $1", [inst])).rows;
  const orgLinks = (await c.query("SELECT l.person_id, l.org_unit_id FROM person_org_units l JOIN org_units u ON u.id = l.org_unit_id WHERE u.instance_id = $1", [inst])).rows;
  const identities = (await c.query("SELECT i.person_id, i.verified_by, i.active FROM person_identities i JOIN people p ON p.id = i.person_id WHERE p.instance_id = $1", [inst])).rows;
  const dgm = (await c.query("SELECT person_id FROM directory_group_members WHERE instance_id = $1", [inst])).rows;
  const entities = (await c.query(
    "SELECT id, kind, external_system, external_id, attrs ? 'space_id' AS has_space, attrs->>'space_id' AS space_attr FROM entities WHERE instance_id = $1", [inst])).rows;
  const marks = (await c.query("SELECT kind, target_id, marked_at FROM test_purge_marks WHERE instance_id = $1", [inst])).rows;
  const moves = (await c.query(
    "SELECT id, record_id, requested_by, status FROM class_moves WHERE status IN ('pending', 'copying', 'verifying') OR requested_by = ANY($1::uuid[])", [[...T]])).rows;
  const movingRec = new Set(moves.filter((m) => ["pending", "copying", "verifying"].includes(m.status)).map((m) => m.record_id as string));
  const delreq = (await c.query("SELECT id, record_id, owner_id, requester_id FROM deletion_requests WHERE instance_id = $1", [inst])).rows;
  const mail = (await c.query("SELECT id, kind, to_address, status, dedupe_key, created_by, created_at FROM mail_outbox WHERE instance_id = $1", [inst])).rows;
  const aplans = (await c.query("SELECT id, person_id, status FROM action_plans WHERE instance_id = $1", [inst])).rows;

  const T0a = [...T0];
  const CS = spaces.filter((s) => s.owner_id && T0.has(s.owner_id) && s.kind !== "org").map((s) => s.id);
  const locs = (await c.query(
    `SELECT record_id AS id, class AS cls, space_id, owner_id, deleted, deleted_by, created_at, source_hash FROM record_locations
     WHERE space_id = ANY($1::uuid[]) OR owner_id = ANY($2::uuid[]) OR deleted_by = ANY($2::uuid[])`, [CS, T0a])).rows;
  const heldIds = new Set((o.held ?? []).map((h) => h.id));
  for (const h of o.held ?? []) if (!locs.some((l) => l.id === h.id)) locs.push({ ...h, source_hash: null });
  const loc = new Map(locs.map((l) => [l.id as string, l]));
  const rows = new Map<string, RRow>();
  const inDb: Record<DataClass, Set<string>> = { open: new Set(), closed: new Set() };
  const rp: Array<{ record_id: string; person_id: string }> = [], pl: Array<{ record_id: string; space_id: string; placed_by: string | null }> = [];
  for (const cls of CLASSES) {
    const db = dbs.records(cls);
    for (const r of (await db.query(
      `SELECT r.id, r.parent_id, r.owner_id, r.space_id, r.confirmed_by, r.deleted_by, r.deleted_at IS NOT NULL AS deleted FROM records r
       WHERE r.space_id = ANY($1::uuid[]) OR r.owner_id = ANY($2::uuid[]) OR r.confirmed_by = ANY($2::uuid[]) OR r.deleted_by = ANY($2::uuid[]) OR r.id = ANY($3::uuid[])`,
      [CS, T0a, locs.map((l) => l.id)])).rows) { rows.set(r.id, { ...r, cls }); inDb[cls].add(r.id); }
    rp.push(...(await db.query("SELECT record_id, person_id FROM record_people WHERE person_id = ANY($1::uuid[])", [T0a])).rows);
    pl.push(...(await db.query("SELECT record_id, space_id, placed_by FROM record_placements WHERE placed_by = ANY($1::uuid[]) OR space_id = ANY($2::uuid[])", [T0a, CS])).rows);
  }
  const inBoth = [...inDb.open].filter((id) => inDb.closed.has(id));
  const derivedIn = locs.length ? (await c.query(
    `SELECT src_id, dst_id FROM record_links WHERE relation = 'derived_from' AND dst_id = ANY($1::uuid[]) AND NOT (status = 'rejected' AND decided_by IS NOT NULL)`,
    [locs.map((l) => l.id)])).rows as Array<{ src_id: string; dst_id: string }> : [];
  const movingTree = new Set<string>(movingRec);
  if (derivedIn.length && movingRec.size)
    for (const cls of CLASSES)
      for (const r of (await dbs.records(cls).query(`${chainTreeSql("ANY($1::uuid[])")} SELECT id FROM tree`, [[...movingRec]])).rows) movingTree.add(r.id as string);
  const CSset = new Set(CS);
  const trees = new Map<string, TRow[]>();
  const stuckHours = Number(settingsGet("processing.retries", { stuck_running_hours: 2 })?.stuck_running_hours) || 2;
  for (const cls of CLASSES) {
    const db = dbs.records(cls);
    const inCs = [...rows.values()].filter((r) => r.cls === cls && CSset.has(r.space_id));
    const del = inCs.filter((r) => r.deleted).map((r) => r.id);
    const up = new Map<string, { parent_id: string | null; deleted: boolean }>();
    for (const part of chunks(del, TREE_CHUNK))
      for (const a of (await db.query(
        `WITH RECURSIVE up AS (SELECT id, parent_id, deleted_at IS NOT NULL AS deleted FROM records WHERE id = ANY($1::uuid[])
                               UNION SELECT r.id, r.parent_id, r.deleted_at IS NOT NULL FROM records r JOIN up ON r.id = up.parent_id)
         SELECT id, parent_id, deleted FROM up`, [part])).rows) up.set(a.id, a);
    const topOf = (id: string) => { let cur = id; for (let i = 0; i < 1000; i++) { const p = up.get(cur)?.parent_id; if (!p || !up.get(p)?.deleted) return cur; cur = p; } return cur; };
    const roots = uniq([...del.map(topOf), ...inCs.filter((r) => !r.deleted && !r.parent_id).map((r) => r.id)]);
    for (const part of chunks(roots, TREE_CHUNK))
      for (const t of (await db.query(
        `WITH RECURSIVE tree AS (SELECT id, id AS root FROM records WHERE id = ANY($1::uuid[])
                                 UNION ALL SELECT r.id, t.root FROM records r JOIN tree t ON r.parent_id = t.id)
         SELECT t.root, t.id, r.parent_id, r.owner_id, r.space_id, r.deleted_at IS NULL AS live, r.deleted_batch, r.hidden_at IS NOT NULL AS hidden,
                r.attrs -> 'participants_pending' AS pending, r.attrs -> 'participants_unresolved' AS unresolved,
                (SELECT COALESCE(jsonb_agg(COALESCE(s.claimed_by, '')), '[]'::jsonb) FROM record_stages s
                  WHERE s.record_id = r.id AND s.status = 'running' AND s.updated_at > now() - make_interval(hours => $2)) AS run_claims,
                EXISTS (SELECT 1 FROM record_stages s WHERE s.record_id = r.id AND s.status = 'running' AND s.updated_at <= now() - make_interval(hours => $2)) AS running_stale,
                (SELECT COALESCE(jsonb_agg(p.person_id ORDER BY p.person_id), '[]'::jsonb) FROM record_people p WHERE p.record_id = r.id) AS people,
                (SELECT COALESCE(jsonb_agg(jsonb_build_object('s', x.space_id, 'b', x.placed_by)), '[]'::jsonb) FROM record_placements x WHERE x.record_id = r.id) AS placements
         FROM tree t JOIN records r ON r.id = t.id`, [part, stuckHours])).rows) {
        const list = trees.get(t.root); const row = { ...t, cls } as TRow;
        if (list) list.push(row); else trees.set(t.root, [row]);
      }
  }
  const claims = uniq([...trees.values()].flat().flatMap((t) => (t as any).run_claims as string[]).filter(Boolean));
  const liveClaims = await liveApplicationNames(c as Parameters<typeof liveApplicationNames>[0], claims);
  for (const t of [...trees.values()].flat()) {
    const cl = ((t as any).run_claims ?? []) as string[];
    t.running = cl.some((x) => x === "" || liveClaims.has(x));
    if (cl.some((x) => x !== "" && !liveClaims.has(x))) t.running_stale = true;
  }
  const treeOf = (root: string) => trees.get(root) ?? [];
  const liveRoots = [...trees.keys()].filter((r) => { const x = treeOf(r).find((t) => t.id === r); return !!x && x.live && !x.parent_id; });
  const markedMeetings = new Map<string, { cls: DataClass; fp: string; ids: string[] }>();
  if (o.mode === "manual" && Array.isArray(o.meetings)) for (const m of o.meetings) {
    const tr = treeOf(m.root), root = tr.find((t) => t.id === m.root);
    if (!root || root.parent_id || root.live || root.deleted_batch !== m.root || tr.some((t) => t.live) || root.cls !== m.cls) continue;
    const fp = meetingFp({ root: m.root, cls: root.cls, space_id: root.space_id, owner_id: root.owner_id, ids: tr.map((t) => t.id), unresolved: root.unresolved, pending: root.pending,
      people: tr.flatMap((t) => (t.people as string[]).map((p) => [t.id, p] as [string, string])) });
    if (fp === m.fp) markedMeetings.set(m.root, { cls: root.cls, fp, ids: tr.map((t) => t.id) });
  }
  const delRoots = [...trees.keys()].filter((r) => { const x = treeOf(r).find((t) => t.id === r); return !!x && !x.live && !markedMeetings.has(r); });

  const recPeople = new Map<string, string[]>();
  for (const x of rp) { const l = recPeople.get(x.person_id); if (l) l.push(x.record_id); else recPeople.set(x.person_id, [x.record_id]); }

  const staffPeople = people.filter((p) => !tlogin(p.login));
  const staffNames = { names: new Set(staffPeople.map((p) => norm(p.display_name ?? ""))), loginParts: new Set(staffPeople.flatMap((p) => (p.login.split("@")[0] ?? "").toLowerCase().split(/[._-]/).filter((w) => w.length >= 4))) };
  const staffIds = new Set(staffPeople.map((p) => p.id));
  const meetingInfo = new Map<string, { cls: DataClass; fp: string; ids: string[]; codes: Set<string>; root: TRow }>();
  const allTreeIds = liveRoots.flatMap((r) => treeOf(r).map((t) => t.id));
  const touchedBy = new Map<string, Set<string>>();
  if (allTreeIds.length && staffIds.size) {
    for (const part of chunks(allTreeIds, 5000))
      for (const t of (await dbs.audit.query(
        `SELECT DISTINCT x AS id, e.principal_id, e.on_behalf_of FROM audit_events e CROSS JOIN LATERAL unnest(e.record_ids) AS x
         WHERE e.instance_id = $1 AND e.record_ids && $2::uuid[] AND x = ANY($2::uuid[]) AND (e.principal_id = ANY($3::uuid[]) OR e.on_behalf_of = ANY($3::uuid[]))`,
        [inst, part, [...staffIds]])).rows) {
        const s = touchedBy.get(t.id) ?? new Set<string>();
        for (const id of [t.principal_id, t.on_behalf_of]) if (id && staffIds.has(id)) s.add(id);
        touchedBy.set(t.id, s);
      }
  }
  for (const r of liveRoots) {
    const tr = treeOf(r), root = tr.find((t) => t.id === r)!;
    const unresolved = Array.isArray(root.unresolved) ? root.unresolved : [];
    if (!unresolved.length && !nonEmpty(root.pending)) continue;
    const codes = new Set<string>();
    if (nonEmpty(root.pending) || tr.some((t) => nonEmpty(t.pending))) codes.add("pending");
    if (!unresolved.length || !unresolved.every(syntheticName)) codes.add("not_synthetic");
    else if (unresolved.some((u: string) => staffNameHit(u, staffNames))) codes.add("staff_name");
    if (tr.some((t) => (t.placements as any[]).length)) codes.add("placed");
    if (tr.some((t) => t.running)) codes.add("running");
    if (tr.some((t) => movingRec.has(t.id) || t.hidden)) codes.add("moving");
    if (tr.some((t) => [...(touchedBy.get(t.id) ?? [])].some((id) => id !== t.owner_id))) codes.add("staff_touch");
    const peoplePairs = tr.flatMap((t) => (t.people as string[]).map((p) => [t.id, p] as [string, string]));
    const fp = meetingFp({ root: r, cls: root.cls, space_id: root.space_id, owner_id: root.owner_id, ids: tr.map((t) => t.id), unresolved: root.unresolved, pending: root.pending, people: peoplePairs });
    meetingInfo.set(r, { cls: root.cls, fp, ids: tr.map((t) => t.id), codes, root });
  }
  const approved = o.meetings === "all" ? null : new Map((o.meetings ?? []).map((m) => [m.root, m]));
  const rejectedMeetings = { changed: [] as Ids, bad: [] as Ids, missing: [] as Ids };
  if (approved) for (const [root, m] of approved) {
    const info = meetingInfo.get(root);
    if (!info && markedMeetings.has(root)) continue;
    if (!info) { rejectedMeetings.missing.push(root); keep(kept, "meetings", "changed", root); continue; }
    if (info.fp !== m.fp || info.cls !== m.cls) { rejectedMeetings.changed.push(root); keep(kept, "meetings", "changed", root); }
    else if (info.codes.has("not_synthetic") || info.codes.has("staff_name")) rejectedMeetings.bad.push(root);
  }

  const runLabel = (name: string) => { const m = RUN_LABEL.exec(name.toLowerCase()); return !!m && people.some((p) => Tl.has(p.id) && p.login.toLowerCase().startsWith(`${m[1]}-`)); };
  const markOf = new Map(marks.map((m) => [`${m.kind}:${m.target_id}`, m]));
  const approvedMark = new Map(o.marks.map((m) => [`${m.kind}:${m.id}`, m]));
  const unitEvidence = (u: any): string[] => {
    const ev: string[] = [];
    if (people.some((p) => Tl.has(p.id) && (p.attrs?.department_code === u.code || p.attrs?.parent_department_code === u.code))) ev.push("code_of_T");
    if (spaces.some((s) => s.org_unit_id === u.id && s.owner_id && Tl.has(s.owner_id) && !person.get(s.owner_id)!.active && !admin.has(s.owner_id))) ev.push("space_of_T0");
    if (grants.some((g) => Tl.has(g.person_id) && ["org_unit", "org_branch"].includes(g.scope_kind) && g.scope_ref === u.code)) ev.push("grant_of_T");
    if (runLabel(u.code)) ev.push("run_label");
    if (people.some((p) => Tl.has(p.id) && p.department === u.name)) ev.push("name_of_T");
    return ev;
  };
  const STRONG = ["code_of_T", "space_of_T0", "grant_of_T", "run_label"];
  const staffDept = (u: any) => people.some((p) => !Tl.has(p.id) && (p.department === u.name || p.attrs?.department_code === u.code || p.attrs?.parent_department_code === u.code));
  const serviceEvidence = (s: any): string[] => {
    const ev: string[] = [];
    if (runLabel(s.name)) ev.push("run_label");
    const ws = s.write_space_id ? space.get(s.write_space_id) : undefined;
    if (ws?.owner_id && Tl.has(ws.owner_id) && !person.get(ws.owner_id)!.active) ev.push("write_space_of_T0");
    return ev;
  };
  const mentioned = (s: any) => mentionedSvc.has(s.id);

  const S0 = spaces.filter((s) => (s.kind === "team" || s.kind === "project") && s.owner_id && T.has(s.owner_id));
  const spaceKept = new Map<string, string>();
  for (const s of S0) {
    const code = !T0.has(s.owner_id!) ? "owner_active"
      : s.archived_at === null ? null
      : showcaseSpace(s) ? "showcase"
      : !aged(s.archived_at) ? "young"
      : members.some((m) => m.space_id === s.id && !T0.has(m.person_id)) ? "foreign_member"
      : groups.some((g) => g.space_id === s.id) ? "groups"
      : grants.some((g) => g.scope_kind === "space" && g.scope_ref === s.slug && liveGrant(g)) ? "grant_scope"
      : moved.has(s.id) ? "space_moves"
      : null;
    if (code) spaceKept.set(s.id, code);
  }
  let S = new Set(S0.filter((s) => s.archived_at !== null && !spaceKept.has(s.id)).map((s) => s.id));
  let P = new Set([...T0].filter((id) => { const p = person.get(id)!; const touch = [p.updated_at, personalOf.get(id)?.archived_at ?? null, ...keys.filter((k) => k.principal_type === "person" && k.principal_id === id).map((k) => k.last_used_at), lastSeen.get(id) ?? null].map(ms).filter((x): x is number => x !== null); return Math.max(...touch) <= cutoff; }));
  for (const id of T0) if (!P.has(id)) keep(kept, "people", "young", id);
  const serviceCand = services.filter((s) => serviceEvidence(s).length || markOf.has(`service:${s.id}`) || approvedMark.has(`service:${s.id}`)
    || (s.write_space_id && space.get(s.write_space_id)?.owner_id && T.has(space.get(s.write_space_id)!.owner_id!)));
  const serviceKept = new Map<string, string>();
  const week = now.getTime() - 7 * 86_400_000;
  const STRONG_SERVICE = ["run_label"];
  const serviceMarkable = (s: any) => { const a = approvedMark.get(`service:${s.id}`); return o.mode === "manual" && !!a && !s.active
    && (serviceEvidence(s).some((e) => STRONG_SERVICE.includes(e)) || (a.owner_listed && ms(s.created_at)! <= week)); };
  const serviceOrigin = (s: any) => markOf.has(`service:${s.id}`) || runLabel(s.name) || serviceMarkable(s);
  for (const s of serviceCand) {
    const ev = serviceEvidence(s);
    const code = s.active ? "active" : !aged(s.created_at) ? "young" : mentioned(s) ? "settings_mention"
      : !serviceOrigin(s) ? (ev.length === 0 ? "no_evidence" : ev.some((e) => STRONG_SERVICE.includes(e)) ? "unmarked" : "weak_only") : null;
    if (code) serviceKept.set(s.id, code);
  }
  let V = new Set(serviceCand.filter((s) => !serviceKept.has(s.id)).map((s) => s.id));
  const ticketRows = deps.filter((d) => d.kind === "ticket");
  const sessionRows = deps.filter((d) => d.kind === "session");
  const ticketsPlan = new Set(ticketRows.filter((t) => t.eligible && T0.has(t.person_id)).map((t) => t.id as string));
  const sessionsPlan = new Set(sessionRows.filter((s) => s.eligible && T0.has(s.person_id)).map((s) => s.id as string));
  const timeDead = (k: any) => aged(k.revoked_at) || aged(k.expires_at);
  const otherFk = async (target: string, ids: string[]) => new Set<string>(ids.length
    ? (await c.query("SELECT DISTINCT id FROM tp_fk_blockers($1::regclass, $2::uuid[], $3::text[])", [target, ids, KNOWN_FK[target] ?? []])).rows.map((r) => r.id as string) : []);
  const fkPeople = await otherFk("people", [...T0]);
  const fkSpaces = await otherFk("spaces", uniq([...S0.map((s) => s.id), ...[...T0].map((id) => personalOf.get(id)?.id).filter((x): x is string => !!x)]));
  const fkKeys = await otherFk("api_keys", keys.filter((k) => (k.principal_type === "person" && T0.has(k.principal_id)) || k.principal_type === "service").map((k) => k.id));
  for (const id of fkSpaces) if (S.delete(id)) spaceKept.set(id, "fk_other");
  const moveRecIds = uniq(moves.filter((m) => T0.has(m.requested_by) && ["done", "failed"].includes(m.status)).map((m) => m.record_id as string));
  const presentAnywhere = new Set<string>(), tomb = new Set<string>();
  for (const cls of CLASSES) if (moveRecIds.length) {
    for (const r of (await dbs.records(cls).query("SELECT id FROM records WHERE id = ANY($1::uuid[])", [moveRecIds])).rows) presentAnywhere.add(r.id);
    for (const r of (await dbs.records(cls).query("SELECT id FROM record_tombstones WHERE id = ANY($1::uuid[])", [moveRecIds])).rows) tomb.add(r.id);
  }
  const locNow = new Set<string>(moveRecIds.length ? (await c.query("SELECT record_id FROM record_locations WHERE record_id = ANY($1::uuid[])", [moveRecIds])).rows.map((r) => r.record_id) : []);
  const reqLocs = new Set<string>(delreq.length ? (await c.query("SELECT record_id FROM record_locations WHERE record_id = ANY($1::uuid[])", [delreq.map((d) => d.record_id)])).rows.map((r) => r.record_id) : []);
  const finalMail = (m: any) => ["sent", "failed", "cancelled"].includes(m.status);
  let tailReqSet = new Set<string>();
  const mailRule = (m: any, final = true) => (!final || finalMail(m)) && (isTestDomainLogin(m.to_address)
    || (m.kind === "meeting_delete" && typeof m.dedupe_key === "string" && /^deletion:[^:]+:admin$/.test(m.dedupe_key) && isTestDomainLogin(m.created_by ?? "")
        && mail.some((x) => x.dedupe_key === m.dedupe_key.replace(/:admin$/, ":owner") && isTestDomainLogin(x.to_address) && isTestDomainLogin(x.created_by ?? ""))
        && (() => { const rid = m.dedupe_key.split(":")[1]; return !delreq.some((d) => d.id === rid) || tailReqSet.has(rid); })()));
  const S_init = new Set(S), P_init = new Set(P), V_init = new Set(V), spaceKept0 = new Map(spaceKept), serviceKept0 = new Map(serviceKept);
  function solve(appr: Map<string, MeetingRef> | null) {
    let P = new Set(P_init), S = new Set(S_init), V = new Set(V_init);
    const spaceKept = new Map(spaceKept0), serviceKept = new Map(serviceKept0), personKept = new Map<string, string>();
    const meetingOk = new Set<string>();
    let R: string[] = [], Rids = new Set<string>(), Mids = new Set<string>(), K = new Set<string>(), orphanLoc: string[] = [];
    let grantsPlan = new Set<string>(), membersPlan: Array<[string, string]> = [];
    let tailMoves: string[] = [], tailReqs: string[] = [], tailMail: string[] = [], tailPlans: string[] = [];
    for (let iter = 0; iter < 50; iter++) {
      const before = `${P.size}|${S.size}|${V.size}|${Rids.size}|${Mids.size}|${K.size}`;
      const SP = new Set([...P].map((id) => personalOf.get(id)).filter((s): s is SRow => !!s && s.archived_at !== null).map((s) => s.id));
      const SS = new Set([...S, ...SP]);
      R = []; Rids = new Set();
      if (o.mode === "manual") for (const r of delRoots) {
        const tr = treeOf(r);
        const ok = tr.every((t) => T0.has(t.owner_id) && SS.has(t.space_id) && (t.people as string[]).every((p) => T0.has(p))
          && (t.placements as Array<{ s: string; b: string | null }>).every((x) => SS.has(x.s) && (!x.b || T0.has(x.b))));
        if (ok) { R.push(r); for (const t of tr) Rids.add(t.id); }
      }
      Mids = new Set(); meetingOk.clear();
      if (o.mode === "manual" && appr) for (const [r, info] of meetingInfo) {
        if (!appr.has(r) || rejectedMeetings.changed.includes(r)) continue;
        const tr = treeOf(r);
        const codes = new Set(info.codes);
        if (tr.some((t) => !P.has(t.owner_id) || !SS.has(t.space_id) || (t.people as string[]).some((p) => !P.has(p)))) codes.add("foreign_row");
        const persons = new Map<string, Person>();
        for (const id of uniq(tr.flatMap((t) => [t.owner_id, ...(t.people as string[]), ...(t.placements as any[]).map((x) => x.b).filter(Boolean)])))
          { const p = person.get(id); if (p) persons.set(id, { id, login: p.login, active: p.active, demo: p.attrs?.demo === true || p.attrs?.demo === "true" || isShowcaseLogin(p.login), testDomain: isTestDomainLogin(p.login) }); }
        const spInfo = new Map<string, SpaceInfo>();
        for (const sid of uniq(tr.flatMap((t) => [t.space_id, ...(t.placements as any[]).map((x) => x.s)]))) {
          const s = space.get(sid);
          const staffM = members.filter((m) => m.space_id === sid && staffIds.has(m.person_id)).length;
          spInfo.set(sid, { id: sid, kind: s?.kind ?? "team", staffMembers: staffM, staffOwner: !!s?.owner_id && staffIds.has(s.owner_id) && !!person.get(s.owner_id)?.active, showcase: showcaseSpace(s) });
        }
        const l: Loc = { id: r, cls: info.cls, space: info.root.space_id, owner: info.root.owner_id, live: true, old: true, kind: (space.get(info.root.space_id)?.kind ?? "team") as Kind };
        const w: JudgeWorld = { org: null, e: P, persons, spaces: spInfo, moving: movingRec };
        const j = judgeAll(l, tr, w);
        for (const reason of j.reasons) if (reason !== "unresolved_participants") codes.add(reason === "pending_participants" ? "pending" : reason === "foreign_owner" ? "foreign_row" : "staff_touch");
        if (!j.reasons.has("unresolved_participants")) codes.add("not_synthetic");
        if (j.wait) codes.add("foreign_row");
        if (codes.size) continue;
        meetingOk.add(r);
        for (const t of tr) Mids.add(t.id);
      }
      for (const r of markedMeetings.keys()) {
        const tr = treeOf(r);
        if (tr.some((t) => !P.has(t.owner_id) || !SS.has(t.space_id) || (t.people as string[]).some((p) => !P.has(p)))) continue;
        meetingOk.add(r);
        for (const t of tr) Mids.add(t.id);
      }
      const gone = new Set([...Rids, ...Mids]);
      const held = new Set([...heldIds, ...derivedIn.filter((k) => !gone.has(k.src_id) && movingTree.has(k.src_id)).map((k) => k.dst_id)]);
      orphanLoc = locs.filter((l) => !inDb.open.has(l.id) && !inDb.closed.has(l.id) && ms(l.created_at)! <= now.getTime() - 3_600_000 && !movingRec.has(l.id)
        && !held.has(l.id) && (T0.has(l.owner_id) || SS.has(l.space_id))).map((l) => l.id as string);
      const goneLoc = new Set([...gone, ...orphanLoc].filter((id) => !held.has(id)));
      K = new Set(keys.filter((k) => ((k.principal_type === "person" && T0.has(k.principal_id)) || (k.principal_type === "service" && V.has(k.principal_id))) && timeDead(k)
        && !fkKeys.has(k.id) && !ticketRows.some((t) => t.key_id === k.id && !ticketsPlan.has(t.id))).map((k) => k.id as string));
      V = new Set([...V].filter((id) => {
        const s = services.find((x) => x.id === id)!;
        if (keys.some((k) => k.principal_type === "service" && k.principal_id === id && !K.has(k.id))) { serviceKept.set(id, "live_key"); return false; }
        if (s.write_space_id && !S.has(s.write_space_id)) { serviceKept.set(id, "write_space_kept"); return false; }
        return true;
      }));
      S = new Set([...S].filter((id) => {
        if (locs.some((l) => l.space_id === id && !goneLoc.has(l.id)) || [...rows.values()].some((r) => r.space_id === id && !gone.has(r.id))
            || pl.some((x) => x.space_id === id && !gone.has(x.record_id))) { spaceKept.set(id, "live_records"); return false; }
        if (services.some((v) => v.write_space_id === id && !V.has(v.id))) { spaceKept.set(id, "service"); return false; }
        return true;
      }));
      grantsPlan = new Set(grants.filter((g) => T0.has(g.person_id) && (aged(g.revoked_at) || aged(g.valid_to) || P.has(g.person_id))
        && !members.some((m) => m.grant_id === g.id && m.person_id !== g.person_id)).map((g) => g.id as string));
      membersPlan = members.filter((m) => {
        const s = space.get(m.space_id);
        if (!s || s.kind === "personal" || !T0.has(m.person_id) || showcaseSpace(s)) return false;
        const own = !m.grant_id || grants.some((g) => g.id === m.grant_id && g.person_id === m.person_id);
        return own && (S.has(s.id) || P.has(m.person_id) || (!!m.grant_id && grantsPlan.has(m.grant_id)));
      }).map((m) => [m.space_id, m.person_id] as [string, string]);
      const memberGone = new Set(membersPlan.map(([s, p]) => `${s}:${p}`));
      const cleared = (rid: string) => gone.has(rid) || (!presentAnywhere.has(rid) && tomb.has(rid));
      const noLocator = (rid: string) => goneLoc.has(rid) || (!locNow.has(rid) && !loc.has(rid));
      tailMoves = moves.filter((m) => T0.has(m.requested_by) && ["done", "failed"].includes(m.status) && cleared(m.record_id) && noLocator(m.record_id)).map((m) => m.id as string);
      tailReqs = delreq.filter((d) => T0.has(d.owner_id) && T0.has(d.requester_id) && (goneLoc.has(d.record_id) || !reqLocs.has(d.record_id))).map((d) => d.id as string);
      tailReqSet = new Set(tailReqs);
      tailMail = mail.filter((m) => mailRule(m)).map((m) => m.id as string);
      tailPlans = aplans.filter((a) => P.has(a.person_id) && !["pending", "applying"].includes(a.status)).map((a) => a.id as string);
      const tails = { moves: new Set(tailMoves), reqs: tailReqSet, plans: new Set(tailPlans) };
      P = new Set([...P].filter((id) => {
        const code = personGuard(id, { P, S, K, gone, goneLoc, grantsPlan, memberGone, V, tails });
        if (code) { personKept.set(id, code); return false; }
        return true;
      }));
      if (before === `${P.size}|${S.size}|${V.size}|${Rids.size}|${Mids.size}|${K.size}`) break;
    }
    return { P, S, V, K, R, Rids, Mids, meetingOk, orphanLoc, grantsPlan, membersPlan, tailMoves, tailReqs, tailMail, tailPlans, tailReqSet, personKept, spaceKept, serviceKept };
  }
  function personGuard(id: string, w: { P: Set<string>; S: Set<string>; K: Set<string>; gone: Set<string>; goneLoc: Set<string>; grantsPlan: Set<string>; memberGone: Set<string>; V: Set<string>;
                                         tails: { moves: Set<string>; reqs: Set<string>; plans: Set<string> } }): string | null {
    const ps = personalOf.get(id);
    if (spaces.some((s) => s.owner_id === id && s.kind !== "personal" && !w.S.has(s.id))) return "owns_live_space";
    if (ps && ps.archived_at === null) return "personal_live";
    if (ps && (locs.some((l) => l.space_id === ps.id && !w.goneLoc.has(l.id)) || [...rows.values()].some((r) => r.space_id === ps.id && !w.gone.has(r.id))
        || pl.some((x) => x.space_id === ps.id && !w.gone.has(x.record_id)) || members.some((m) => m.space_id === ps.id)
        || services.some((v) => v.write_space_id === ps.id && !w.V.has(v.id)) || groups.some((g) => g.space_id === ps.id) || fkSpaces.has(ps.id))) return "personal_referenced";
    if (keys.some((k) => k.principal_type === "person" && k.principal_id === id && !w.K.has(k.id))) return "has_key";
    const ref =
      fkPeople.has(id)
      || keys.some((k) => k.created_by === id && !w.K.has(k.id))
      || spaces.some((s) => s.created_by === id && !w.S.has(s.id) && !(s.kind === "personal" && s.owner_id === id))
      || spaces.some((s) => s.archived_by === id && !w.S.has(s.id))
      || members.some((m) => (m.added_by === id || m.person_id === id) && !w.memberGone.has(`${m.space_id}:${m.person_id}`) && !w.S.has(m.space_id))
      || locs.some((l) => (l.owner_id === id || l.deleted_by === id) && !w.goneLoc.has(l.id))
      || moves.some((m) => m.requested_by === id && !w.tails.moves.has(m.id))
      || identities.some((i) => i.verified_by === id && i.person_id !== id && !w.P.has(i.person_id))
      || grants.some((g) => (g.person_id === id || g.revoked_by === id || g.created_by === id) && !w.grantsPlan.has(g.id))
      || sessionRows.some((s) => s.person_id === id && !sessionsPlan.has(s.id))
      || ticketRows.some((t) => t.person_id === id && !ticketsPlan.has(t.id))
      || delreq.some((d) => (d.owner_id === id || d.requester_id === id) && !w.tails.reqs.has(d.id))
      || groups.some((g) => g.added_by === id && !w.S.has(g.space_id))
      || aplans.some((a) => a.person_id === id && !w.tails.plans.has(a.id))
      || oauth.some((x) => x.person_id === id && !w.K.has(x.id))
      || linkRefs.some((l) => (l.created_by === id || l.decided_by === id) && !w.goneLoc.has(l.src_id) && !w.goneLoc.has(l.dst_id))
      || [...rows.values()].some((r) => (r.owner_id === id || r.confirmed_by === id || r.deleted_by === id) && !w.gone.has(r.id))
      || (recPeople.get(id) ?? []).some((rid) => !w.gone.has(rid))
      || pl.some((x) => x.placed_by === id && !w.gone.has(x.record_id));
    return ref ? "referenced" : null;
  }
  const cleanMeetings = new Map([...meetingInfo].filter(([, i]) => !i.codes.size).map(([r, i]) => [r, { root: r, cls: i.cls, fp: i.fp } as MeetingRef]));
  const cand = o.mode === "manual" ? solve(cleanMeetings) : null;
  const main = o.meetings === "all" ? cand! : solve(approved);
  P = main.P; S = main.S; V = main.V;
  const { K, R, Rids, Mids, meetingOk, orphanLoc, grantsPlan, membersPlan, tailMoves, tailReqs, tailMail, tailPlans, personKept } = main;
  tailReqSet = main.tailReqSet;
  const candidates = cand ? cand.meetingOk : new Set<string>();
  const gone = new Set([...Rids, ...Mids]);
  const mailPending = mail.filter((m) => !finalMail(m) && mailRule(m, false)).length;
  const mailToStaff = { count: 0, by_day: {} as Record<string, number> };
  for (const m of mail.filter((x) => tailMail.includes(x.id) && !isTestDomainLogin(x.to_address))) {
    mailToStaff.count++;
    const d = new Date(m.created_at).toISOString().slice(0, 10);
    mailToStaff.by_day[d] = (mailToStaff.by_day[d] ?? 0) + 1;
  }
  const SPf = new Set([...P].map((id) => personalOf.get(id)).filter((s): s is SRow => !!s && s.archived_at !== null).map((s) => s.id));
  for (const [id, code] of personKept) keep(kept, "people", code, id);
  for (const id of P) if (person.get(id)!.emp) keep(kept, "people", "with_employee_id_planned", id);
  for (const id of T0) if (!P.has(id) && person.get(id)!.emp) keep(kept, "people", "with_employee_id", id);
  for (const id of P) { const login = person.get(id)!.login; if (people.some((q) => q.manager_login === login && !P.has(q.id))) keep(kept, "people", "manager_of_kept", id); }
  for (const [id, code] of main.spaceKept) keep(kept, "spaces", code, id);
  for (const [id, code] of main.serviceKept) keep(kept, "services", code, id);
  void gone;

  const fkUnits = await otherFk("org_units", units.map((u) => u.id));
  const unitCand = units.filter((u) => u.attrs?.origin === "test" || markOf.has(`org_unit:${u.id}`) || approvedMark.has(`org_unit:${u.id}`) || !u.active || unitEvidence(u).length);
  const unitKept = new Map<string, string>();
  const validMark = (u: any) => { const m = markOf.get(`org_unit:${u.id}`); return !!m && ms(m.marked_at)! >= ms(u.updated_at)!; };
  const unitMarkable = (u: any) => {
    const a = approvedMark.get(`org_unit:${u.id}`);
    if (o.mode !== "manual" || !a || u.code === "demo" || u.attrs?.real === true || u.attrs?.real === "true" || staffDept(u)) return false;
    return unitEvidence(u).some((e) => STRONG.includes(e))
      || (a.owner_listed && !u.active && ms(u.updated_at)! <= week && !orgLinks.some((l) => l.org_unit_id === u.id) && !spaces.some((s) => s.org_unit_id === u.id) && !fkUnits.has(u.id));
  };
  const unitOrigin = (u: any) => u.attrs?.origin === "test" || validMark(u) || unitMarkable(u);
  const linksLeft = (u: any) => orgLinks.some((l) => l.org_unit_id === u.id && !P.has(l.person_id));
  for (const u of unitCand) {
    const ev = unitEvidence(u);
    const code = u.code === "demo" ? "demo" : u.attrs?.real === true || u.attrs?.real === "true" ? "real"
      : !unitOrigin(u) ? (ev.length === 0 ? "no_evidence" : !ev.some((e) => STRONG.includes(e)) ? "weak_only" : "unmarked")
      : staffDept(u) ? "staff_department"
      : !aged(u.updated_at) ? "young"
      : linksLeft(u) ? "links"
      : spaces.some((s) => s.org_unit_id === u.id && !S.has(s.id)) ? "space"
      : grants.some((g) => ["org_unit", "org_branch"].includes(g.scope_kind) && g.scope_ref === u.code && liveGrant(g) && !grantsPlan.has(g.id)) ? "grant_scope"
      : fkUnits.has(u.id) ? "fk_other"
      : null;
    if (code) unitKept.set(u.id, code);
  }
  let U = new Set(unitCand.filter((u) => !unitKept.has(u.id)).map((u) => u.id as string));
  for (let i = 0; i < 100; i++) {
    const n = U.size;
    U = new Set([...U].filter((id) => { const bad = units.some((ch) => ch.parent_id === id && !U.has(ch.id)); if (bad) unitKept.set(id, "child_outside"); return !bad; }));
    if (U.size === n) break;
  }
  for (const [id, code] of unitKept) keep(kept, "org_units", code, id);
  const unitsWithoutOrigin = [...U].filter((id) => { const u = units.find((x) => x.id === id)!; return !(u.attrs?.origin === "test" || validMark(u)); });
  const servicesWithoutOrigin = [...V].filter((id) => { const s = services.find((x) => x.id === id)!; return !(markOf.has(`service:${id}`) || runLabel(s.name)); });
  const planMarks: MarkRef[] = o.mode === "manual" ? [
    ...unitsWithoutOrigin.map((id) => ({ kind: "org_unit" as const, id, evidence: approvedMark.get(`org_unit:${id}`)?.evidence ?? [], owner_listed: !!approvedMark.get(`org_unit:${id}`)?.owner_listed })),
    ...servicesWithoutOrigin.map((id) => ({ kind: "service" as const, id, evidence: approvedMark.get(`service:${id}`)?.evidence ?? [], owner_listed: !!approvedMark.get(`service:${id}`)?.owner_listed })),
  ] : [];
  const approveOut = {
    org_units: units.filter((u) => unitCand.includes(u) && !(u.attrs?.origin === "test" || validMark(u)) && u.code !== "demo")
      .map((u) => ({ id: u.id, code: u.code, name: u.name, active: u.active, evidence: unitEvidence(u), guards: { demo: u.code === "demo", real: u.attrs?.real === true || u.attrs?.real === "true", staff_department: staffDept(u), links: linksLeft(u) } })),
    services: services.filter((s) => serviceCand.includes(s) && !(markOf.has(`service:${s.id}`) || runLabel(s.name)) && !s.active)
      .map((s) => ({ id: s.id, name: s.name, evidence: serviceEvidence(s) })),
  };

  const recEnt = new Set<string>();
  const entCand = entities.filter((e) => (e.kind === "person" && e.external_system === "people" && isTestDomainLogin(e.external_id) && !isShowcaseLogin(e.external_id))
    || (e.kind === "project" && e.external_system === "memory" && e.has_space));
  for (const cls of CLASSES) if (entCand.length)
    for (const r of (await dbs.records(cls).query("SELECT DISTINCT entity_id FROM record_entities WHERE entity_id = ANY($1::uuid[]) AND NOT (record_id = ANY($2::uuid[]))",
      [entCand.map((e) => e.id), [...gone]])).rows) recEnt.add(r.entity_id);
  const Epers: string[] = [], Eproj: string[] = [];
  for (const e of entCand) {
    if (recEnt.has(e.id)) { keep(kept, "entities", "referenced", e.id); continue; }
    if (e.kind === "person") {
      const p = people.find((x) => x.id === e.id || x.login.toLowerCase() === String(e.external_id).toLowerCase());
      if (p && !P.has(p.id)) continue;
      Epers.push(e.id);
    } else {
      const sp = e.space_attr ? space.get(e.space_attr) : undefined;
      if (sp && !S.has(sp.id)) continue;
      if (spaces.some((s) => s.slug === e.external_id && !S.has(s.id))) { keep(kept, "entities", "slug_taken", e.id); continue; }
      Eproj.push(e.id);
    }
  }
  for (const e of entities) {
    if (e.kind === "project" && e.external_system === "memory" && !e.has_space) keep(kept, "entities", "no_space_attr", e.id);
    else if (!["people", "memory"].includes(e.external_system)) keep(kept, "entities", "b24_or_other", e.id);
  }

  const planRec = { open: [] as string[], closed: [] as string[] };
  for (const r of R) for (const t of treeOf(r)) planRec[t.cls].push(t.id);
  const meetingsPlan = [...meetingOk].map((r) => { const info = meetingInfo.get(r) ?? markedMeetings.get(r)!; return { root: r, cls: info.cls, fp: info.fp, ids: [...info.ids].sort() }; }).sort((a, b) => a.root.localeCompare(b.root));
  const allRec = [...planRec.open, ...planRec.closed, ...meetingsPlan.flatMap((m) => m.ids), ...orphanLoc];
  const links = allRec.length ? (await c.query("SELECT id FROM record_links WHERE src_id = ANY($1::uuid[]) OR dst_id = ANY($1::uuid[])", [allRec])).rows.map((r) => r.id as string) : [];
  const derivedKeep = allRec.length ? (await c.query(
    `SELECT DISTINCT src_id::text AS id FROM record_links WHERE relation = 'derived_from' AND dst_id = ANY($1::uuid[]) AND NOT src_id = ANY($1::uuid[])
       AND NOT (status = 'rejected' AND decided_by IS NOT NULL)`, [allRec])).rows.map((r) => r.id as string) : [];
  const originals = { count: 0, bytes: 0 };
  for (const cls of CLASSES) {
    const ids = [...planRec[cls], ...meetingsPlan.filter((m) => m.cls === cls).flatMap((m) => m.ids)];
    if (!ids.length) continue;
    const x = (await dbs.records(cls).query(
      "SELECT count(*) FILTER (WHERE original_key IS NOT NULL)::int AS n, COALESCE(sum(original_bytes) FILTER (WHERE original_key IS NOT NULL), 0)::bigint AS b FROM record_content WHERE record_id = ANY($1::uuid[])", [ids])).rows[0];
    originals.count += x.n; originals.bytes += Number(x.b);
  }

  const tAll = o.tAll ?? [...T];
  const storage = await storageOrphans(inst, dbs, o.s3, { tAll: new Set([...tAll, ...T]), V, now });

  const planTreeRows = [...R, ...meetingOk].flatMap((r) => treeOf(r));
  let pgbossJobs = 0;
  if (allRec.length && (await c.query("SELECT to_regclass('pgboss.job') IS NOT NULL AS ok")).rows[0].ok)
    pgbossJobs = (await c.query("SELECT count(*)::int AS n FROM pgboss.job WHERE state IN ('created', 'retry', 'active') AND data->>'record_id' = ANY($1::text[])", [allRec])).rows[0].n;
  const work = {
    busy: planTreeRows.filter((t) => t.running).length, stale_running: planTreeRows.filter((t) => t.running_stale).length, pgboss_jobs: pgbossJobs,
    moving: allRec.filter((id) => movingRec.has(id)).length, mail_pending: mailPending, in_both_dbs: inBoth.filter((id) => allRec.includes(id)).length,
  };

  const body: PlanBody = {
    kind: "test_purge_plan", v: PLAN_V, instance: inst, at, mode: o.mode, age_minutes: age,
    t_all: sorted(tAll),
    people: sorted(P), personal: sorted(SPf), spaces: sorted(S),
    records: { open: sorted(planRec.open), closed: sorted(planRec.closed) },
    meetings: meetingsPlan,
    tickets: sorted([...ticketsPlan]), keys: sorted(K), oauth: sorted(oauth.filter((x) => K.has(x.id)).map((x) => x.id)), sessions: sorted([...sessionsPlan]),
    grants: sorted(grantsPlan), members: membersPlan.sort((a, b) => `${a[0]}:${a[1]}`.localeCompare(`${b[0]}:${b[1]}`)),
    person_attrs: sorted([...P].filter((id) => identities.some((i) => i.person_id === id) || orgLinks.some((l) => l.person_id === id) || dgm.some((d) => d.person_id === id))),
    services: sorted(V), org_units: sorted(U), marks: planMarks,
    entities: { person: sorted(Epers), project: sorted(Eproj) },
    class_moves: sorted(tailMoves), deletion_requests: sorted(tailReqs), mail: sorted(tailMail), action_plans: sorted(tailPlans), orphan_locators: sorted(orphanLoc),
    storage_orphans: { open: storage.open.sort(), closed: storage.closed.sort() },
    links: sorted(links),
    derived_keep: sorted(derivedKeep),
    guard: { owners: sorted(T0), spaces: sorted([...S, ...SPf]) },
    kept: keptOut(kept),
    mail_to_staff: mailToStaff,
    expected: await expectedOf(c, inst),
  };

  const proof = await purgeProof(inst, dbs, body);
  const stops = new Set<StopCode>();
  if (proof.non_test_person || proof.active_in_plan || proof.admin_in_plan || proof.system_keys_in_plan || proof.live_space_in_plan || proof.showcase_touched) stops.add("S1");
  if (proof.staff_readers || proof.audit_staff_touch || proof.locator_owner_mismatch || proof.members_non_t0 || proof.meeting_foreign_rows) stops.add("S2");
  if (proof.tails_touching_non_t) stops.add("S14");
  if (Object.values(proof).some((n) => n !== 0)) stops.add("S6");
  if (work.busy || work.moving || work.mail_pending || work.in_both_dbs) stops.add("S4");
  if (approved) {
    if (rejectedMeetings.bad.length) stops.add("S15");
    const cands = candidates.size;
    if (approved.size && (rejectedMeetings.missing.length || approved.size !== meetingOk.size || cands !== approved.size)) stops.add("S12");
  }
  const counters = {
    people: { t: T.size, t0: T0.size, planned: P.size, kept: keptCounts(kept, "people") },
    personal: { planned: SPf.size },
    spaces: { planned: S.size, by_kind: { team: [...S].filter((id) => space.get(id)!.kind === "team" && !space.get(id)!.org_unit_id).length, dep: [...S].filter((id) => !!space.get(id)!.org_unit_id).length, project: [...S].filter((id) => space.get(id)!.kind === "project" && !space.get(id)!.org_unit_id).length }, kept: keptCounts(kept, "spaces") },
    records: { trash: { open: planRec.open.length, closed: planRec.closed.length }, trees: R.length },
    originals,
    meetings: { candidates: candidates.size, approved: meetingOk.size, changed: rejectedMeetings.changed.length + rejectedMeetings.missing.length,
                not_synthetic: [...meetingInfo.values()].filter((i) => i.codes.has("not_synthetic")).length, staff_name: [...meetingInfo.values()].filter((i) => i.codes.has("staff_name")).length,
                pending: [...meetingInfo.values()].filter((i) => i.codes.has("pending")).length, kept: keptCounts(kept, "meetings") },
    keys: { person: [...K].filter((id) => keys.find((k) => k.id === id)!.principal_type === "person").length, service: [...K].filter((id) => keys.find((k) => k.id === id)!.principal_type === "service").length, oauth: body.oauth.length },
    sessions: sessionsPlan.size, tickets: ticketsPlan.size,
    grants: { planned: grantsPlan.size, on_org: [...grantsPlan].filter((id) => ["org_unit", "org_branch"].includes(grants.find((g) => g.id === id)!.scope_kind)).length,
              on_spaces: [...grantsPlan].filter((id) => grants.find((g) => g.id === id)!.scope_kind === "space").length },
    members: { planned: membersPlan.length, live_space: membersPlan.filter(([s]) => space.get(s)!.archived_at === null).length },
    person_attrs: { identities: identities.filter((i) => P.has(i.person_id)).length, identities_active: identities.filter((i) => P.has(i.person_id) && i.active).length,
                    org_links: orgLinks.filter((l) => P.has(l.person_id)).length, group_members: dgm.filter((d) => P.has(d.person_id)).length },
    services: { planned: V.size, kept: keptCounts(kept, "services") },
    org_units: { planned: U.size, active: [...U].filter((id) => units.find((u) => u.id === id)!.active).length, marks_to_add: planMarks.filter((m) => m.kind === "org_unit").length, kept: keptCounts(kept, "org_units") },
    entities: { person: Epers.length, project: Eproj.length, kept: keptCounts(kept, "entities") },
    tails: { class_moves: tailMoves.length, deletion_requests: tailReqs.length, mail: tailMail.length, action_plans: tailPlans.length, orphan_locators: orphanLoc.length },
    mail_to_staff: mailToStaff,
    storage_orphans: { open: storage.open.length, closed: storage.closed.length, non_test: storage.non_test, no_tombstone: storage.no_tombstone, ...(storage.unavailable ? { unavailable: storage.unavailable } : {}) },
    links: links.length,
  };
  return {
    at, now, settings: st, age, mode: o.mode, body, counters, proof, stops: STOP_CODES.filter((s) => stops.has(s)), work,
    meetingsAll: [...meetingInfo.entries()].map(([root, i]) => ({ root, cls: i.cls, fp: i.fp, ids: i.ids,
      kept: i.codes.size ? [...i.codes] : candidates.has(root) ? [] : ["foreign_row"] })),
    approveOut, originals, rejectedMeetings, unitsWithoutOrigin, servicesWithoutOrigin, storageDown: storage.unavailable_classes,
  };
}

async function expectedOf(c: Q, inst: string): Promise<Expected> {
  const p = (await c.query("SELECT login, active FROM people WHERE instance_id = $1", [inst])).rows;
  const s = (await c.query(
    `SELECT count(*) FILTER (WHERE s.archived_at IS NULL)::int AS active, count(*) FILTER (WHERE s.slug = 'demo-showcase' OR u.code = 'demo')::int AS show
     FROM spaces s LEFT JOIN org_units u ON u.id = s.org_unit_id WHERE s.instance_id = $1`, [inst])).rows[0];
  const u = (await c.query("SELECT count(*)::int AS n FROM org_units WHERE instance_id = $1 AND code = 'demo'", [inst])).rows[0].n;
  return {
    staff_active: p.filter((x) => x.active && !isTestDomainLogin(x.login)).length,
    active_spaces: s.active,
    showcase: { personas: p.filter((x) => isShowcaseLogin(x.login)).length, spaces: s.show, units: u },
  };
}

interface StorageScan { open: string[]; closed: string[]; non_test: number; no_tombstone: number; unavailable?: string;
  unavailable_classes: DataClass[] }
async function storageOrphans(inst: string, dbs: Dbs, s3: PurgeCtx["s3"] | null, w: { tAll: Set<string>; V: Set<string>; now: Date }): Promise<StorageScan> {
  const out: StorageScan = { open: [], closed: [], non_test: 0, no_tombstone: 0, unavailable_classes: [] };
  if (!s3) { out.unavailable = "no_storage"; out.unavailable_classes = [...CLASSES]; return out; }
  const found = await unreferencedObjects(inst, dbs, s3, { now: w.now, refs: "class" });
  if (found.unavailable) out.unavailable = found.unavailable;
  out.unavailable_classes = [...found.unavailable_classes];
  for (const cls of CLASSES) {
    const free = found.byClass[cls];
    if (!free.length) continue;
    const hexes = uniq(free.map((o) => o.hash));
    const liveHash = await liveHashes(dbs, hexes);
    const tombs = await purgedTombsByHash(dbs, cls, hexes);
    const movingHash = await movingHashes(dbs);
    const tombIds = tombs.map((t) => t.id as string);
    const origin = new Map<string, { test: boolean; other: boolean }>();
    if (tombIds.length)
      for (const e of (await dbs.audit.query(
        `SELECT DISTINCT x AS id, e.principal_id, e.on_behalf_of, e.service_id FROM audit_events e CROSS JOIN LATERAL unnest(e.record_ids) AS x
         WHERE e.instance_id = $1 AND e.event_type = 'write' AND e.record_ids && $2::uuid[] AND x = ANY($2::uuid[])`, [inst, tombIds])).rows) {
        const o = origin.get(e.id) ?? { test: false, other: false };
        const test = (e.principal_id && w.tAll.has(e.principal_id)) || (e.on_behalf_of && w.tAll.has(e.on_behalf_of)) || (e.service_id && w.V.has(e.service_id));
        if (test) o.test = true; else o.other = true;
        origin.set(e.id, o);
      }
    for (const obj of free) {
      const h = obj.hash;
      if (liveHash.has(h) || movingHash.has(h)) continue;
      const ts = tombs.filter((t) => t.h === h);
      if (!ts.length) { out.no_tombstone++; continue; }
      const os = ts.map((t) => origin.get(t.id)).filter(Boolean) as Array<{ test: boolean; other: boolean }>;
      if (!os.some((x) => x.test) || os.some((x) => x.other)) { out.non_test++; continue; }
      out[cls].push(obj.key);
    }
  }
  return out;
}

export async function purgeProof(inst: string, dbs: Dbs, plan: PlanBody): Promise<Record<string, number>> {
  const c = dbs.control;
  const pr: Record<string, number> = { non_test_person: 0, active_in_plan: 0, admin_in_plan: 0, system_keys_in_plan: 0, live_space_in_plan: 0, staff_readers: 0,
    audit_staff_touch: 0, showcase_touched: 0, locator_owner_mismatch: 0, grant_scope_live_foreign: 0, tails_touching_non_t: 0, members_non_t0: 0, meeting_foreign_rows: 0 };
  const planPeople = new Set(plan.people);
  const keyRows = plan.keys.length ? (await c.query("SELECT id, principal_type, principal_id FROM api_keys WHERE id = ANY($1::uuid[])", [plan.keys])).rows : [];
  const grantRows = plan.grants.length ? (await c.query("SELECT id, person_id FROM role_grants WHERE id = ANY($1::uuid[])", [plan.grants])).rows : [];
  const spaceRows = (plan.spaces.length || plan.personal.length) ? (await c.query(
    "SELECT s.id, s.slug, s.kind, s.owner_id, s.archived_at, u.code AS unit_code FROM spaces s LEFT JOIN org_units u ON u.id = s.org_unit_id WHERE s.id = ANY($1::uuid[])", [[...plan.spaces, ...plan.personal]])).rows : [];
  const refs = new Set<string>([...plan.people, ...plan.person_attrs, ...plan.guard.owners, ...plan.members.map((m) => m[1]),
    ...keyRows.filter((k) => k.principal_type === "person").map((k) => k.principal_id), ...grantRows.map((g) => g.person_id), ...spaceRows.map((s) => s.owner_id).filter(Boolean)]);
  if (plan.sessions.length || plan.tickets.length) {
    const own = new Map<string, string>();
    for (const d of (await c.query("SELECT kind, id, person_id FROM tp_dependents($1, $2::uuid[], interval '0', $3::uuid[]) WHERE kind IN ('session', 'ticket')",
      [inst, [...refs], plan.keys])).rows) own.set(`${d.kind}:${d.id}`, d.person_id);
    for (const [kind, list] of [["session", plan.sessions], ["ticket", plan.tickets]] as const)
      for (const x of list) { const p = own.get(`${kind}:${x}`); if (p) refs.add(p); else pr.non_test_person!++; }
  }
  const ppl = refs.size ? (await c.query("SELECT id, login, active FROM people WHERE id = ANY($1::uuid[])", [[...refs]])).rows : [];
  const found = new Map(ppl.map((p) => [p.id as string, p]));
  for (const id of refs) {
    const p = found.get(id);
    if (!p || !isTestDomainLogin(p.login) || isShowcaseLogin(p.login)) pr.non_test_person!++;
    if (p?.active) pr.active_in_plan!++;
  }
  if (refs.size) pr.admin_in_plan = (await c.query(
    "SELECT count(DISTINCT person_id)::int AS n FROM tp_dependents($1, $2::uuid[], interval '0', '{}'::uuid[]) WHERE kind = 'person' AND admin_user", [inst, [...refs]])).rows[0].n;
  const svcPlan = new Set(plan.services), t0 = new Set(plan.guard.owners);
  pr.system_keys_in_plan = keyRows.filter((k) => !((k.principal_type === "person" && t0.has(k.principal_id)) || (k.principal_type === "service" && svcPlan.has(k.principal_id)))).length;
  for (const s of spaceRows) {
    const isPersonal = plan.personal.includes(s.id);
    if (!s.archived_at || s.kind === "org" || (isPersonal ? s.kind !== "personal" || !planPeople.has(s.owner_id) : !["team", "project"].includes(s.kind))) pr.live_space_in_plan!++;
    if (s.slug === "demo-showcase" || s.unit_code === "demo") pr.showcase_touched!++;
  }
  const staffRows = (await c.query("SELECT id, login, active FROM people WHERE instance_id = $1", [inst])).rows.filter((p) => !isTestDomainLogin(p.login) || isShowcaseLogin(p.login));
  const staff = new Set(staffRows.map((p) => p.id as string)), activeStaff = new Set(staffRows.filter((p) => p.active).map((p) => p.id as string));
  const planSpaces = [...plan.spaces, ...plan.personal];
  if (planSpaces.length) {
    pr.staff_readers! += (await c.query("SELECT count(DISTINCT space_id)::int AS n FROM space_members WHERE space_id = ANY($1::uuid[]) AND person_id = ANY($2::uuid[])", [planSpaces, [...staff]])).rows[0].n;
    pr.staff_readers! += spaceRows.filter((s) => s.owner_id && staff.has(s.owner_id)).length;
  }
  const recIds: Record<DataClass, string[]> = { open: [...plan.records.open], closed: [...plan.records.closed] };
  for (const m of plan.meetings) recIds[m.cls].push(...m.ids);
  const inPlanSpace = new Set(planSpaces);
  const allIds: string[] = [];
  const rowOwner = new Map<string, string>(), rowIngested = new Map<string, Date>();
  for (const cls of CLASSES) if (recIds[cls].length) {
    const db = dbs.records(cls);
    for (const r of (await db.query("SELECT id, owner_id, space_id, ingested_at FROM records WHERE id = ANY($1::uuid[])", [recIds[cls]])).rows) {
      allIds.push(r.id); rowOwner.set(r.id, r.owner_id); if (r.ingested_at) rowIngested.set(r.id, new Date(r.ingested_at));
      if (!t0.has(r.owner_id) || !inPlanSpace.has(r.space_id)) pr.meeting_foreign_rows!++;
    }
    for (const x of (await db.query("SELECT record_id, person_id FROM record_people WHERE record_id = ANY($1::uuid[])", [recIds[cls]])).rows) if (!t0.has(x.person_id)) pr.meeting_foreign_rows!++;
    for (const x of (await db.query("SELECT record_id, space_id, placed_by FROM record_placements WHERE record_id = ANY($1::uuid[])", [recIds[cls]])).rows) {
      if (!inPlanSpace.has(x.space_id)) pr.staff_readers!++;
      if (x.placed_by && !t0.has(x.placed_by)) pr.meeting_foreign_rows!++;
    }
    const shown = (await c.query(
      `SELECT count(*)::int AS n FROM spaces s LEFT JOIN org_units u ON u.id = s.org_unit_id WHERE (s.slug = 'demo-showcase' OR u.code = 'demo')
         AND s.id IN (SELECT unnest($1::uuid[]))`, [(await db.query("SELECT DISTINCT space_id FROM records WHERE id = ANY($1::uuid[])", [recIds[cls]])).rows.map((r) => r.space_id)])).rows[0].n;
    pr.showcase_touched! += shown;
  }
  if (allIds.length) {
    const locs = (await c.query("SELECT record_id, owner_id FROM record_locations WHERE record_id = ANY($1::uuid[])", [allIds])).rows;
    pr.locator_owner_mismatch = locs.filter((l) => rowOwner.get(l.record_id) !== l.owner_id).length;
    if (staff.size) {
      const touches = (await dbs.audit.query(
        `SELECT DISTINCT x AS id, e.principal_id, e.on_behalf_of FROM audit_events e CROSS JOIN LATERAL unnest(e.record_ids) AS x
         WHERE e.instance_id = $1 AND e.record_ids && $2::uuid[] AND x = ANY($2::uuid[]) AND (e.principal_id = ANY($3::uuid[]) OR e.on_behalf_of = ANY($3::uuid[]))`,
        [inst, allIds, [...staff]])).rows;
      const touched = touches.filter((t) => [t.principal_id, t.on_behalf_of].some((id) => id && staff.has(id) && id !== rowOwner.get(t.id))).map((t) => t.id as string);
      // audit archive: before the newest dropped month the journal is not complete — a record that existed then may
      // have been touched by staff without a trace in the base; it counts as touched (S2), the archive is not read here
      const archived = await auditArchivedBefore(dbs.audit);
      const unprovable = archived ? allIds.filter((id) => (rowIngested.get(id)?.getTime() ?? 0) < archived.getTime()) : [];
      pr.audit_staff_touch = uniq([...touched, ...unprovable]).length;
    }
  }
  const showPeople = (await c.query(
    `SELECT DISTINCT p.id FROM people p WHERE p.id = ANY($1::uuid[]) AND (lower(p.login) = ANY($2::text[])
       OR EXISTS (SELECT 1 FROM spaces s LEFT JOIN org_units u ON u.id = s.org_unit_id WHERE (s.slug = 'demo-showcase' OR u.code = 'demo')
                    AND (s.owner_id = p.id OR EXISTS (SELECT 1 FROM space_members m WHERE m.space_id = s.id AND m.person_id = p.id))))`,
    [[...refs], [...SHOWCASE_LOGINS]])).rows;
  pr.showcase_touched! += showPeople.length;
  if (plan.org_units.length) pr.showcase_touched! += (await c.query("SELECT count(*)::int AS n FROM org_units WHERE id = ANY($1::uuid[]) AND code = 'demo'", [plan.org_units])).rows[0].n;
  const slugs = spaceRows.filter((s) => plan.spaces.includes(s.id)).map((s) => s.slug);
  const codes = plan.org_units.length ? (await c.query("SELECT code FROM org_units WHERE id = ANY($1::uuid[])", [plan.org_units])).rows.map((r) => r.code) : [];
  if (slugs.length || codes.length) pr.grant_scope_live_foreign = (await c.query(
    `SELECT count(*)::int AS n FROM role_grants g WHERE g.instance_id = $1 AND g.revoked_at IS NULL AND (g.valid_to IS NULL OR g.valid_to > now()) AND NOT (g.id = ANY($4::uuid[]))
       AND ((g.scope_kind = 'space' AND g.scope_ref = ANY($2::text[])) OR (g.scope_kind IN ('org_unit', 'org_branch') AND g.scope_ref = ANY($3::text[])))`,
    [inst, slugs, codes, plan.grants])).rows[0].n;
  const isT = async (ids: string[]) => { const m = new Map<string, boolean>(); if (ids.length) for (const p of (await c.query("SELECT id, login, active FROM people WHERE id = ANY($1::uuid[])", [uniq(ids)])).rows) m.set(p.id, isTestDomainLogin(p.login) && !isShowcaseLogin(p.login) && !p.active); return (id: string | null) => !!id && m.get(id) === true; };
  if (plan.class_moves.length) { const r = (await c.query("SELECT requested_by FROM class_moves WHERE id = ANY($1::uuid[])", [plan.class_moves])).rows; const f = await isT(r.map((x) => x.requested_by)); pr.tails_touching_non_t! += r.filter((x) => !f(x.requested_by)).length; }
  const reqs = (await c.query("SELECT owner_id, requester_id FROM deletion_requests WHERE id = ANY($1::uuid[]) OR record_id = ANY($2::uuid[])", [plan.deletion_requests, allIds])).rows;
  if (reqs.length) { const f = await isT(reqs.flatMap((x) => [x.owner_id, x.requester_id])); pr.tails_touching_non_t! += reqs.filter((x) => !f(x.owner_id) || !f(x.requester_id)).length; }
  if (plan.mail.length) {
    const ms_ = (await c.query("SELECT kind, to_address, dedupe_key, created_by FROM mail_outbox WHERE id = ANY($1::uuid[])", [plan.mail])).rows;
    pr.tails_touching_non_t! += ms_.filter((m) => !isTestDomainLogin(m.to_address) && !(m.kind === "meeting_delete" && /:admin$/.test(m.dedupe_key ?? "") && isTestDomainLogin(m.created_by ?? ""))).length;
  }
  if (plan.action_plans.length) { const r = (await c.query("SELECT person_id FROM action_plans WHERE id = ANY($1::uuid[])", [plan.action_plans])).rows; const f = await isT(r.map((x) => x.person_id)); pr.tails_touching_non_t! += r.filter((x) => !f(x.person_id)).length; }
  if (plan.members.length) { const f = await isT(plan.members.map((m) => m[1])); pr.members_non_t0 = plan.members.filter((m) => !f(m[1])).length; }
  void activeStaff;
  return pr;
}

const REC_TABLES: Array<[string, string, "rec" | "link"]> = [
  ["records", "t.id", "rec"], ["record_content", "t.record_id", "rec"], ["record_people", "t.record_id", "rec"], ["record_placements", "t.record_id", "rec"],
  ["record_entities", "t.record_id", "rec"], ["record_stages", "t.record_id", "rec"], ["chunks", "t.record_id", "rec"], ["record_tombstones", "t.id", "rec"],
  ["record_link_details", "t.link_id", "link"]];
const SHA_AGG = "encode(sha256(convert_to(COALESCE(string_agg(h, '' ORDER BY h), ''), 'UTF8')), 'hex')";

export function baselineExcl(plan: Omit<PlanBody, "kept" | "expected" | "mail_to_staff">): { control: Record<string, string[]>; records: string[]; links: string[]; keep: string[] } {
  const rec = [...plan.records.open, ...plan.records.closed, ...plan.meetings.flatMap((m) => m.ids)];
  const locIds = [...rec, ...plan.orphan_locators];
  return {
    control: {
      people: plan.people, spaces: [...plan.spaces, ...plan.personal], space_members: plan.members.map(([s, p]) => `${s}:${p}`), api_keys: plan.keys, oauth_connections: plan.oauth,
      services: plan.services, user_sessions: plan.sessions, upload_tickets: plan.tickets, role_grants: plan.grants,
      person_identities: plan.person_attrs, person_org_units: plan.person_attrs, directory_group_members: plan.person_attrs,
      org_units: plan.org_units, entities: [...plan.entities.person, ...plan.entities.project], record_links: plan.links, class_moves: plan.class_moves,
      deletion_requests: plan.deletion_requests, mail_outbox: plan.mail, action_plans: plan.action_plans, action_plan_items: plan.action_plans,
      record_locations: locIds, space_moves: locIds, test_purge_marks: uniq([...plan.org_units, ...plan.services, ...plan.marks.map((m) => m.id)]),
    },
    records: rec, links: plan.links, keep: plan.derived_keep ?? [],
  };
}

export async function baselineOf(inst: string, dbs: Dbs, excl: ReturnType<typeof baselineExcl> | null): Promise<Baseline> {
  const out: Baseline = { control: {}, open: {}, closed: {} };
  for (const r of (await dbs.control.query("SELECT tbl, n, sha FROM tp_baseline($1, $2::jsonb)", [inst, JSON.stringify(excl?.control ?? {})])).rows) out.control[r.tbl] = { n: Number(r.n), sha: r.sha };
  const keep = excl?.keep ?? [];
  for (const cls of CLASSES) {
    const db = dbs.records(cls);
    for (const [tbl, key, kind] of REC_TABLES) {
      const ids = kind === "rec" ? excl?.records ?? [] : excl?.links ?? [];
      const h = tbl === "records" && keep.length
        ? `CASE WHEN t.id = ANY($2::uuid[]) THEN md5(((to_jsonb(t) - 'updated_at') || jsonb_build_object('attrs', t.attrs - 'derived_lost' - 'derived_lost_cause'))::text) ELSE md5(t::text) END`
        : "md5(t::text)";
      const r = (await db.query(`SELECT count(*)::bigint AS n, ${SHA_AGG} AS sha FROM (SELECT ${h} AS h FROM ${tbl} t WHERE NOT (${key} = ANY($1::uuid[]))) x`,
                                tbl === "records" && keep.length ? [ids, keep] : [ids])).rows[0];
      out[cls][tbl] = { n: Number(r.n), sha: r.sha };
    }
    const e = (await db.query(
      `SELECT count(*)::bigint AS n, ${SHA_AGG} AS sha FROM (SELECT md5(e.chunk_id::text || ':' || e.embedder_id::text || ':' || e.created_at::text) AS h
        FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id WHERE NOT (c.record_id = ANY($1::uuid[]))) x`, [excl?.records ?? []])).rows[0];
    out[cls].chunk_embeddings = { n: Number(e.n), sha: e.sha };
  }
  return out;
}
const baselineSha = (b: Baseline) => sha256(canon(b));
function baselineDiff(a: Baseline, b: Baseline): string[] {
  const diff: string[] = [];
  for (const part of ["control", "open", "closed"] as const)
    for (const t of uniq([...Object.keys(a[part] ?? {}), ...Object.keys(b[part] ?? {})])) {
      const x = a[part]?.[t], y = b[part]?.[t];
      if (!x || !y || x.n !== y.n || x.sha !== y.sha) diff.push(`${part}.${t}`);
    }
  return diff;
}

export async function windowBackends(dbs: Dbs): Promise<number> {
  const names: string[] = [];
  for (const q of [dbs.control, dbs.audit, ...CLASSES.map((c) => dbs.records(c))]) names.push((await q.query("SELECT current_database() AS d")).rows[0].d);
  const own = (await dbs.control.query("SELECT current_setting('application_name') AS a")).rows[0].a as string;
  return (await dbs.control.query(
    `SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename IN ('memory_gateway', 'memory_worker', 'memory_audit_maint') AND pid <> pg_backend_pid()
       AND datname = ANY($1::text[]) AND ($2 = '' OR application_name IS DISTINCT FROM $2)`, [names, own])).rows[0].n;
}

export function backupCheck(dir: string, planSha: string, fullBaseline: Baseline, originals: number): string[] {
  const problems: string[] = [];
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [`backup directory is missing`];
  const dumps = ["memory_control.dump", "memory_open.dump", "memory_closed.dump", "memory_audit.dump"];
  for (const d of dumps) if (!existsSync(join(dir, d)) || statSync(join(dir, d)).size === 0) problems.push(`dump ${d} is missing`);
  if (!existsSync(join(dir, "globals.sql"))) problems.push("globals.sql is missing");
  const verify = existsSync(join(dir, "verify.txt")) ? readFileSync(join(dir, "verify.txt"), "utf8").split("\n").map((l) => l.trim()) : [];
  for (const d of dumps) if (!verify.includes(`${d} ok`)) problems.push(`verify.txt: missing “${d} ok”`);
  try {
    const raw = readJson(join(dir, "baseline.json"));
    const b = (raw?.result ?? raw) as { control?: unknown; open?: unknown; closed?: unknown };
    if (baselineSha({ control: b.control as any, open: b.open as any, closed: b.closed as any }) !== baselineSha(fullBaseline)) problems.push("baseline.json differs from the current baseline");
  } catch { problems.push("baseline.json is missing"); }
  const count = (p: string): number => { if (!existsSync(p)) return -1; let n = 0; for (const e of readdirSync(p, { withFileTypes: true })) n += e.isDirectory() ? Math.max(0, count(join(p, e.name))) : 1; return n; };
  const s3n = count(join(dir, "s3"));
  if (s3n < 0) problems.push("s3/ is missing"); else if (s3n < originals) problems.push("s3/ contains fewer files than the plan has originals");
  const plans = readdirSync(dir).filter((f) => /^tp-.*plan\.json$/.test(f));
  if (!plans.some((f) => { try { return readJson(join(dir, f)).sha256 === planSha; } catch { return false; } })) problems.push("no plan file with a matching sha");
  return problems;
}

async function readOnly<T>(ctx: DbCtx, fn: (dbs: Dbs) => Promise<T>): Promise<T> {
  const opened: Array<import("pg").PoolClient> = [];
  const open = async (pool: import("pg").Pool): Promise<Q> => { const c = await pool.connect(); opened.push(c); await c.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"); return c; };
  try {
    const control = await open(ctx.db.control), audit = await open(ctx.db.auditRead());
    const rec: Record<DataClass, Q> = { open: await open(recordsDb(ctx, "open")), closed: await open(recordsDb(ctx, "closed")) };
    return await fn({ control, audit, records: (cls) => rec[cls] });
  } finally {
    for (const c of opened) { await c.query("ROLLBACK").catch(() => undefined); c.release(); }
  }
}
const settingsGetter = (ctx: DbCtx) => (k: string, d: any) => { try { return ctx.settings.get(k, d); } catch { return d; } };

function finishPlan(b: Built, inputs: PurgePlan["inputs"], baseline: Baseline): PurgePlan {
  const noSha = { ...b.body, inputs, baseline } as Omit<PurgePlan, "sha256">;
  return { ...noSha, sha256: sha256(canon(noSha)) };
}
export function readPlan(file: string, inst: string, nowMs = Date.now()): PurgePlan {
  const p = readJson(file) as PurgePlan;
  const { sha256: s, ...rest } = p;
  if (p?.kind !== "test_purge_plan" || p.v !== PLAN_V) throw new TestPurgeStop(["S7"], "file is not a test_purge plan for this version");
  if (sha256(canon(rest)) !== s) throw new TestPurgeStop(["S7"], "plan sha256 does not match");
  if (p.instance !== inst) throw new TestPurgeStop(["S7"], "plan belongs to a different instance");
  if (nowMs - new Date(p.at).getTime() > PLAN_MAX_AGE_MS) throw new TestPurgeStop(["S7"], "plan is older than 24 hours");
  return p;
}

const S8_PATH = /^(staff_active|active_spaces|showcase)(\.|$)/;
function checkExpect(out: Record<string, unknown>, checks: ExpectCheck[], o: { rerun?: boolean } = {}): { codes: StopCode[]; failed: string[] } {
  const get = (path: string) => path.split(".").reduce<any>((a, k) => (a == null ? undefined : a[k]), out);
  const codes = new Set<StopCode>(), failed: string[] = [];
  for (const ch of checks) {
    const v = get(ch.path);
    const s8 = S8_PATH.test(ch.path);
    const eqAsMax = !!o.rerun && !s8 && typeof ch.eq === "number";
    const bad = (ch.max !== undefined && !(typeof v === "number" && v <= ch.max))
      || (ch.eq !== undefined && (eqAsMax ? !(typeof v === "number" && v <= (ch.eq as number)) : canon(v) !== canon(ch.eq)));
    if (!bad) continue;
    failed.push(ch.path);
    codes.add(s8 ? "S8" : "S3");
  }
  return { codes: STOP_CODES.filter((s) => codes.has(s)), failed };
}
export function expectGaps(inputs: PurgePlan["inputs"] | undefined): string[] {
  const checks = Array.isArray(inputs?.expect) ? inputs!.expect : [];
  const eq = new Set(checks.filter((c) => c && c.eq !== undefined).map((c) => c.path));
  const gaps: string[] = [];
  if (!inputs?.expect_sha || !checks.length) gaps.push("--expect");
  for (const p of ["staff_active", "active_spaces"]) if (!eq.has(p)) gaps.push(p);
  if (!eq.has("showcase") && !["showcase.personas", "showcase.spaces", "showcase.units"].every((p) => eq.has(p))) gaps.push("showcase");
  return gaps;
}

interface PreviewArgs { ageMin?: number; meetingsOut?: string; meetings?: string; approveOut?: string; approve?: string; expect?: string; ids?: string; check?: string; baseline?: string | true }
function previewArgs(args: string[]): PreviewArgs {
  const out: PreviewArgs = {};
  const val: Record<string, keyof PreviewArgs> = { "--meetings-out": "meetingsOut", "--meetings": "meetings", "--approve-out": "approveOut", "--approve": "approve", "--expect": "expect", "--ids": "ids", "--check": "check" };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!, v = args[i + 1];
    if (a === "--age-min" && v && /^\d+$/.test(v)) { out.ageMin = Number(v); i++; continue; }
    if (a === "--baseline") { if (v && !v.startsWith("--")) { out.baseline = v; i++; } else out.baseline = true; continue; }
    if (val[a] && v && !v.startsWith("--")) { (out as any)[val[a]!] = v; i++; continue; }
    throw new Error(`test_purge_preview: unknown argument “${a}”`);
  }
  if (out.check && Object.keys(out).length > 1) throw new Error("test_purge_preview: run --check separately");
  if (out.baseline && Object.keys(out).length > 1) throw new Error("test_purge_preview: run --baseline separately");
  if (out.meetingsOut && out.ids) throw new Error("test_purge_preview: run --meetings-out and --ids separately (candidates ≠ approved)");
  return out;
}

function readMeetings(file: string, inst: string): { list: MeetingRef[]; sha: string } {
  const raw = readFileSync(file, "utf8"), m = JSON.parse(raw);
  if (m?.kind !== "test_purge_meetings" || m.v !== 1 || m.instance !== inst || !Array.isArray(m.meetings)) throw new Error("--meetings: not a meeting file for this instance");
  return { list: m.meetings.map((x: any) => ({ root: String(x.root), cls: x.cls === "open" ? "open" : "closed", fp: String(x.fp) })), sha: sha256(raw) };
}
function readApprove(file: string, inst: string, expected: Built["approveOut"]): { marks: MarkRef[]; sha: string } {
  const raw = readFileSync(file, "utf8"), a = JSON.parse(raw);
  if (a?.kind !== "test_purge_approve" || a.v !== 1 || a.instance !== inst) throw new Error("--approve: not an approval file for this instance");
  const marks: MarkRef[] = [];
  for (const [kind, list, exp] of [["org_unit", a.org_units ?? [], expected.org_units], ["service", a.services ?? [], expected.services]] as const) {
    for (const x of list as any[]) {
      const e = (exp as any[]).find((y) => y.id === x.id);
      if (!e || canon([...(e.evidence ?? [])].sort()) !== canon([...(x.evidence ?? [])].sort())) throw new Error(`--approve: record ${x.id} does not match the --approve-out output`);
      if (x.approved === true || x.owner_listed === true) marks.push({ kind, id: x.id, evidence: x.evidence ?? [], owner_listed: x.owner_listed === true });
    }
  }
  return { marks, sha: sha256(raw) };
}

export async function testPurgePreview(ctx: PurgeCtx, args: string[] = []): Promise<Record<string, unknown>> {
  const a = previewArgs(args);
  return readOnly(ctx, async (dbs) => {
    if (a.check) return purgeCheck(ctx, dbs, a.check);
    if (a.baseline) {
      const b = await baselineOf(ctx.instanceId, dbs, null);
      const at = new Date((await dbs.control.query("SELECT now() AS at")).rows[0].at).toISOString();
      const out = { kind: "test_purge_baseline", at, instance: ctx.instanceId, ...b, sha: baselineSha(b) };
      if (typeof a.baseline === "string") { writeNew(a.baseline, out); return { kind: "test_purge_baseline", at, sha: out.sha, file: a.baseline }; }
      return out;
    }
    const st = await purgeSettings(dbs.control, ctx.instanceId);
    const lower = ageLowerBound(st);
    if (a.ageMin !== undefined && a.ageMin < lower) throw new Error(`--age-min ${a.ageMin} is below the minimum of ${lower}`);
    const age = a.ageMin ?? lower;
    const meetings = a.meetings ? readMeetings(a.meetings, ctx.instanceId) : null;
    const first = a.approve ? await buildPlan(ctx.instanceId, dbs, { mode: "manual", age, meetings: meetings?.list ?? null, marks: [], s3: ctx.s3 }, settingsGetter(ctx)) : null;
    const approve = a.approve ? readApprove(a.approve, ctx.instanceId, first!.approveOut) : null;
    const b = await buildPlan(ctx.instanceId, dbs, { mode: "manual", age, meetings: a.meetingsOut ? "all" : meetings?.list ?? null, marks: approve?.marks ?? [], s3: ctx.s3 }, settingsGetter(ctx));
    const excl = baselineExcl(b.body);
    const baseline = await baselineOf(ctx.instanceId, dbs, excl);
    const win = await windowBackends(dbs);
    const out = previewOut(ctx.instanceId, b, win, baselineSha(baseline), "manual");
    const expectRaw = a.expect ? readFileSync(a.expect, "utf8") : null;
    const expect = expectRaw ? JSON.parse(expectRaw) : null;
    if (expect && (expect.kind !== "test_purge_expect" || !Array.isArray(expect.checks))) throw new Error("--expect: not a limit file");
    const ex = checkExpect(out, expect?.checks ?? []);
    const stops = STOP_CODES.filter((s) => b.stops.includes(s) || ex.codes.includes(s) || (s === "S4" && b.work.pgboss_jobs > 0 && win > 0));
    out.stops = stops;
    if (ex.failed.length) out.expect_failed = ex.failed;
    if (a.meetingsOut) {
      writeNew(a.meetingsOut, { kind: "test_purge_meetings", v: 1, instance: ctx.instanceId, at: b.at, meetings: b.meetingsAll.filter((m) => !m.kept.length).map((m) => ({ root: m.root, cls: m.cls, fp: m.fp })) });
      out.meetings_file = { file: a.meetingsOut, count: b.meetingsAll.filter((m) => !m.kept.length).length };
    }
    if (a.approveOut) {
      writeNew(a.approveOut, { kind: "test_purge_approve", v: 1, instance: ctx.instanceId, at: b.at, ...b.approveOut });
      out.approve_file = { file: a.approveOut, org_units: b.approveOut.org_units.length, services: b.approveOut.services.length };
    }
    if (a.ids) {
      const plan = finishPlan(b, { meetings_sha: meetings?.sha ?? null, approve_sha: approve?.sha ?? null, expect_sha: expectRaw ? sha256(expectRaw) : null, expect: expect?.checks ?? [] }, baseline);
      writeNew(a.ids, plan);
      out.ids = { file: a.ids, sha256: plan.sha256 };
    }
    return out;
  });
}

function previewOut(inst: string, b: Built, otherBackends: number, bsha: string, mode: "manual" | "auto"): Record<string, any> {
  const ev = eventsExpected(b.body);
  return {
    kind: "test_purge_preview", v: PLAN_V, instance: inst, at: b.at, age_minutes: b.age, mode,
    settings: { purge: b.settings.purge, after_hours: b.settings.after_hours, max: b.settings.max, leftovers_scope: b.settings.leftovers_scope },
    ...b.counters,
    staff_active: b.body.expected.staff_active, active_spaces: b.body.expected.active_spaces, showcase: b.body.expected.showcase,
    work: b.work, window: { other_backends: otherBackends }, proof: b.proof, stops: b.stops, events_expected: ev, baseline_sha: bsha,
  };
}
function eventsExpected(p: PlanBody): number {
  const n = (xs: unknown[], k = TEST_PURGE_BATCH) => Math.ceil(xs.length / k);
  let e = p.meetings.length + n(p.records.open, RECORDS_BATCH) + n(p.records.closed, RECORDS_BATCH);
  for (const cls of CLASSES) e += n([...p.records[cls], ...p.meetings.filter((m) => m.cls === cls).map((m) => m.root)], TEST_PURGE_BATCH) * 2;
  for (const xs of [p.tickets, p.keys, p.sessions, p.grants, p.members, p.person_attrs, p.services, p.spaces, p.people, [...p.entities.person, ...p.entities.project],
                    p.class_moves, p.deletion_requests, p.mail, p.action_plans, p.orphan_locators]) e += n(xs);
  e += p.org_units.length ? 1 : 0;
  e += p.marks.length ? uniq(p.marks.map((m) => m.kind)).length : 0;
  e += p.storage_orphans.open.length + p.storage_orphans.closed.length ? 1 : 0;
  return e + 1;
}

type StageName = "tickets" | "keys" | "sessions" | "grants" | "members" | "person_attrs" | "services" | "spaces" | "org_units" | "people" | "entities";
const TP_FN: Record<StageName, string> = { tickets: "tp_tickets", keys: "tp_keys", sessions: "tp_sessions", grants: "tp_grants", members: "tp_members", person_attrs: "tp_person_attrs",
  services: "tp_services", spaces: "tp_spaces", org_units: "tp_org_units", people: "tp_people", entities: "tp_entities" };
export interface StageResult { stage: string; requested: number; deleted: number; busy: number; rejected: number; already_gone: number; rejected_after_pick: number; ids_deleted: string[]; rejected_ids: string[];
  ids_gone: string[] }
interface RunMeta { plan: string; basis: string | null; mode: "manual" | "auto"; age: number; window: boolean; alive?: () => Promise<void>; progress?: (stage: string, done: number) => Promise<void> }

async function callTp(c: Q, stage: StageName, inst: string, batch: string[], age: number, apply: boolean): Promise<Array<{ id: string; state: string }>> {
  if (stage === "members") {
    const pairs = batch.map((k) => k.split(":"));
    return (await c.query("SELECT space_id::text || ':' || person_id::text AS id, state FROM tp_members($1, $2::uuid[], $3::uuid[], make_interval(mins => $4), $5)",
      [inst, pairs.map((p) => p[0]), pairs.map((p) => p[1]), age, apply])).rows;
  }
  return (await c.query(`SELECT id::text AS id, state FROM ${TP_FN[stage]}($1, $2::uuid[], make_interval(mins => $3), $4)`, [inst, batch, age, apply])).rows;
}

export async function runControlStage(ctx: DbCtx, stage: StageName, ids: string[], meta: RunMeta, batchSize = TEST_PURGE_BATCH): Promise<StageResult> {
  const r: StageResult = { stage, requested: ids.length, deleted: 0, busy: 0, rejected: 0, already_gone: 0, rejected_after_pick: 0, ids_deleted: [], rejected_ids: [], ids_gone: [] };
  let done = 0;
  for (const batch of chunks(ids, batchSize)) {
    let work = batch;
    if (stage === "members") {
      const pairs = batch.map((k) => k.split(":"));
      const exist = new Set((await ctx.db.control.query(
        "SELECT m.space_id::text || ':' || m.person_id::text AS k FROM space_members m JOIN unnest($1::uuid[], $2::uuid[]) AS x(s, p) ON m.space_id = x.s AND m.person_id = x.p",
        [pairs.map((p) => p[0]), pairs.map((p) => p[1])])).rows.map((x) => x.k as string));
      work = batch.filter((k) => exist.has(k));
      r.already_gone += batch.length - work.length;
      r.ids_gone.push(...batch.filter((k) => !exist.has(k)));
    }
    if (!work.length) continue;
    const res = await tx(ctx.db.control, async (c) => {
      const pick = await callTp(c, stage, ctx.instanceId, work, meta.age, false);
      const ok = pick.filter((x) => x.state === "ok").map((x) => x.id);
      const busy = pick.filter((x) => x.state === "busy").map((x) => x.id), rejected = pick.filter((x) => x.state === "rejected").map((x) => x.id);
      if (!ok.length) return { ok, busy, rejected, deleted: [] as string[] };
      await meta.alive?.();
      try {
        await auditWorkerStrict(ctx, { event_type: "admin", details: { op: "test_purge", stage, n: ok.length, ids: ok, plan: meta.plan, basis: meta.basis, mode: meta.mode } });
      } catch (e) { throw new TestPurgeStop(["S9"], `log was not written: ${(e as Error).message.slice(0, 120)}`, { stage }); }
      await meta.alive?.();
      const del = await callTp(c, stage, ctx.instanceId, ok, meta.age, true);
      return { ok, busy, rejected, deleted: del.filter((x) => x.state === "deleted").map((x) => x.id) };
    });
    r.deleted += res.deleted.length; r.busy += res.busy.length; r.rejected += res.rejected.length;
    r.rejected_after_pick += res.ok.length - res.deleted.length;
    r.ids_deleted.push(...res.deleted); r.rejected_ids.push(...res.rejected);
    done += batch.length;
    log.info("test_purge_stage", { stage, requested: batch.length, deleted: res.deleted.length, busy: res.busy.length, rejected: res.rejected.length });
    await meta.progress?.(stage, done);
    if (meta.window && (res.rejected.length || res.ok.length - res.deleted.length))
      throw new TestPurgeStop(["S13"], `SQL rejected ${res.rejected.length + res.ok.length - res.deleted.length} IDs for stage ${stage} that the plan considers eligible`, { stage, partial: r });
  }
  return r;
}

function heldAsBusy(stages: StageResult[], held: readonly string[]): void {
  const h = new Set(held);
  if (h.size) log.info("test_purge_held_for_mark", { locators: h.size });
  for (const st of stages) {
    const busy = st.rejected_ids.filter((id) => h.has(id));
    if (!busy.length) continue;
    st.rejected_ids = st.rejected_ids.filter((id) => !h.has(id));
    st.rejected -= busy.length; st.busy += busy.length;
  }
}

async function runTails(ctx: DbCtx, plan: Pick<PurgePlan, "orphan_locators" | "class_moves" | "deletion_requests" | "mail" | "action_plans" | "guard" | "records" | "meetings">, meta: RunMeta,
                        held: Map<string, HeldLocator>): Promise<StageResult[]> {
  const out: StageResult[] = [];
  const rec = new Set([...plan.records.open, ...plan.records.closed, ...plan.meetings.flatMap((m) => m.ids)]);
  const T = "(split_part(lower(p.login), '@', 2) IN ('corp.test', 'test') OR split_part(lower(p.login), '@', 2) LIKE '%.test')";
  const step = async (stage: string, table: string, col: string, ids: string[], del: (c: Q, batch: string[]) => Promise<string[]>,
                      pre?: (batch: string[]) => Promise<string[]>) => {
    const r: StageResult = { stage, requested: ids.length, deleted: 0, busy: 0, rejected: 0, already_gone: 0, rejected_after_pick: 0, ids_deleted: [], rejected_ids: [], ids_gone: [] };
    for (const part of chunks(ids, TEST_PURGE_BATCH)) {
      const exist = new Set((await ctx.db.control.query(`SELECT ${col}::text AS id FROM ${table} WHERE ${col} = ANY($1::uuid[])`, [part])).rows.map((x) => x.id as string));
      const batch = part.filter((id) => exist.has(id));
      r.already_gone += part.length - batch.length;
      r.ids_gone.push(...part.filter((id) => !exist.has(id)));
      if (!batch.length) continue;
      const event = async () => {
        await meta.alive?.();
        try { await auditWorkerStrict(ctx, { event_type: "admin", details: { op: "test_purge", stage, n: batch.length, ids: batch, plan: meta.plan, basis: meta.basis, mode: meta.mode } }); }
        catch (e) { throw new TestPurgeStop(["S9"], `log was not written: ${(e as Error).message.slice(0, 120)}`, { stage }); }
      };
      let target = batch;
      if (pre) { await event(); target = await pre(batch); }
      const gone = !target.length ? [] : await tx(ctx.db.control, async (c) => {
        if (!pre) await event();
        await meta.alive?.();
        return del(c, target);
      });
      r.deleted += gone.length; r.ids_deleted.push(...gone);
      const left = batch.filter((id) => !gone.includes(id));
      r.rejected += left.length; r.rejected_ids.push(...left);
      await meta.progress?.(stage, r.deleted + r.rejected + r.already_gone);
    }
    log.info("test_purge_stage", { stage, requested: r.requested, deleted: r.deleted, busy: 0, rejected: r.rejected });
    out.push(r);
  };
  const present = new Set<string>();
  for (const cls of CLASSES) if (plan.orphan_locators.length)
    for (const x of (await recordsDb(ctx, cls).query("SELECT id FROM records WHERE id = ANY($1::uuid[])", [plan.orphan_locators])).rows) present.add(x.id);
  const orphans = plan.orphan_locators.filter((id) => !present.has(id));
  const orphanSql = (lock: boolean) =>
    `SELECT l.record_id::text AS id FROM record_locations l WHERE l.record_id = ANY($1::uuid[])
       AND (EXISTS (SELECT 1 FROM people p WHERE p.id = l.owner_id AND NOT p.active AND ${T}) OR l.space_id = ANY($2::uuid[]))
       AND (l.record_id = ANY($3::uuid[]) OR l.created_at < now() - interval '1 hour')
       AND NOT EXISTS (SELECT 1 FROM class_moves c WHERE c.record_id = l.record_id AND c.status IN ('pending', 'copying', 'verifying'))${lock ? "\n     FOR UPDATE OF l" : ""}`;
  await step("orphan_locators", "record_locations", "record_id", orphans, async (c, batch) => {
    const ok = (await c.query(orphanSql(true), [batch, plan.guard.spaces, [...rec]])).rows.map((x) => x.id as string);
    if (!ok.length) return [];
    await meta.alive?.();
    const r = await deleteLocators(c, ok);
    for (const id of r.deleted) held.delete(id);
    for (const h of r.held) held.set(h.id, h);
    return r.deleted;
  }, async (batch) => {
    const cand = (await ctx.db.control.query(orphanSql(false), [batch, plan.guard.spaces, [...rec]])).rows.map((x) => x.id as string);
    if (cand.length) {
      await meta.alive?.();
      await purgeLinks(ctx, cand);
    }
    return cand;
  });
  const moveRecs = plan.class_moves.length ? (await ctx.db.control.query("SELECT id, record_id FROM class_moves WHERE id = ANY($1::uuid[])", [plan.class_moves])).rows : [];
  const alive = new Set<string>();
  for (const cls of CLASSES) if (moveRecs.length)
    for (const x of (await recordsDb(ctx, cls).query("SELECT id FROM records WHERE id = ANY($1::uuid[])", [moveRecs.map((m) => m.record_id)])).rows) alive.add(x.id);
  const clearedMoves = moveRecs.filter((m) => !alive.has(m.record_id)).map((m) => m.id as string);
  await step("class_moves", "class_moves", "id", clearedMoves, async (c, batch) => (await c.query(
    `DELETE FROM class_moves c WHERE c.id = ANY($1::uuid[]) AND c.status IN ('done', 'failed')
       AND EXISTS (SELECT 1 FROM people p WHERE p.id = c.requested_by AND NOT p.active AND ${T})
       AND NOT EXISTS (SELECT 1 FROM record_locations l WHERE l.record_id = c.record_id) RETURNING id::text AS id`, [batch])).rows.map((x) => x.id));
  await step("deletion_requests", "deletion_requests", "id", plan.deletion_requests, async (c, batch) => (await c.query(
    `DELETE FROM deletion_requests d WHERE d.id = ANY($1::uuid[])
       AND EXISTS (SELECT 1 FROM people p WHERE p.id = d.owner_id AND NOT p.active AND ${T})
       AND EXISTS (SELECT 1 FROM people p WHERE p.id = d.requester_id AND NOT p.active AND ${T})
       AND NOT EXISTS (SELECT 1 FROM record_locations l WHERE l.record_id = d.record_id) RETURNING id::text AS id`, [batch])).rows.map((x) => x.id));
  const TA = (col: string) => `(split_part(lower(COALESCE(${col}, '')), '@', 2) IN ('corp.test', 'test') OR split_part(lower(COALESCE(${col}, '')), '@', 2) LIKE '%.test')`;
  await step("mail", "mail_outbox", "id", plan.mail, async (c, batch) => (await c.query(
    `DELETE FROM mail_outbox m WHERE m.id = ANY($1::uuid[]) AND m.instance_id = $2 AND m.status IN ('sent', 'failed', 'cancelled')
       AND (${TA("m.to_address")}
            OR (m.kind = 'meeting_delete' AND m.dedupe_key LIKE 'deletion:%:admin' AND ${TA("m.created_by")}
                AND EXISTS (SELECT 1 FROM mail_outbox o WHERE o.instance_id = m.instance_id AND o.dedupe_key = regexp_replace(m.dedupe_key, ':admin$', ':owner')
                              AND ${TA("o.to_address")} AND ${TA("o.created_by")})
                AND NOT EXISTS (SELECT 1 FROM deletion_requests d WHERE d.id::text = split_part(m.dedupe_key, ':', 2))))
     RETURNING id::text AS id`, [batch, ctx.instanceId])).rows.map((x) => x.id));
  await step("action_plans", "action_plans", "id", plan.action_plans, async (c, batch) => (await c.query(
    `DELETE FROM action_plans a WHERE a.id = ANY($1::uuid[]) AND a.status NOT IN ('pending', 'applying')
       AND EXISTS (SELECT 1 FROM people p WHERE p.id = a.person_id AND NOT p.active AND ${T}) RETURNING id::text AS id`, [batch])).rows.map((x) => x.id));
  return out;
}

async function runStorage(ctx: PurgeCtx, dbs: Dbs, plan: PurgePlan | { storage_orphans: PurgePlan["storage_orphans"]; t_all: Ids; services: Ids }, meta: RunMeta): Promise<StageResult> {
  const r: StageResult = { stage: "storage_orphans", requested: plan.storage_orphans.open.length + plan.storage_orphans.closed.length, deleted: 0, busy: 0, rejected: 0, already_gone: 0, rejected_after_pick: 0, ids_deleted: [], rejected_ids: [], ids_gone: [] };
  if (!r.requested) return r;
  const now = new Date((await dbs.control.query("SELECT now() AS now")).rows[0].now);
  const fresh = await storageOrphans(ctx.instanceId, dbs, ctx.s3, { tAll: new Set(plan.t_all), V: new Set(plan.services), now });
  const down = new Set(fresh.unavailable_classes);
  for (const cls of CLASSES) {
    const want = new Set(plan.storage_orphans[cls]);
    if (!want.size) continue;
    if (down.has(cls) || !ctx.s3(cls)) {
      r.busy += want.size;
      log.warn("test_purge_storage_unavailable", { class: cls, keys: want.size, error: fresh.unavailable ?? "no_storage" });
      continue;
    }
    const keys = fresh[cls].filter((k) => want.has(k));
    r.rejected += want.size - keys.length;
    const fresh_ = new Set(keys);
    r.rejected_ids.push(...[...want].filter((k) => !fresh_.has(k)));
    if (!keys.length) continue;
    await meta.alive?.();
    try { await auditWorkerStrict(ctx, { event_type: "purge", class: cls, details: { reason: "test_purge", storage_orphans: keys.length, keys_sha: sha256(keys.sort().join("\n")), plan: meta.plan, basis: meta.basis, mode: meta.mode } }); }
    catch (e) { throw new TestPurgeStop(["S9"], `log was not written: ${(e as Error).message.slice(0, 120)}`, { stage: "storage_orphans" }); }
    const t = ctx.s3(cls)!;
    for (const k of keys) {
      await meta.alive?.();
      try { await s3Remove(t, k); r.deleted++; r.ids_deleted.push(k); }
      catch (e) { r.busy++; log.warn("test_purge_storage_failed", { class: cls, error: (e as Error).message.slice(0, 120) }); }
    }
  }
  log.info("test_purge_stage", { stage: "storage_orphans", requested: r.requested, deleted: r.deleted, busy: r.busy, rejected: r.rejected });
  return r;
}

async function saveState(ctx: DbCtx, patch: Record<string, unknown>): Promise<void> {
  await ctx.db.control.query(
    `INSERT INTO maintenance_state (instance_id, key, value, updated_at) VALUES ($1, 'test_purge', $2::jsonb, now())
     ON CONFLICT (instance_id, key) DO UPDATE SET value = maintenance_state.value || EXCLUDED.value, updated_at = now()`, [ctx.instanceId, JSON.stringify(patch)]);
}

async function withLeftoversLock<T>(ctx: DbCtx, fn: (alive: () => Promise<void>) => Promise<T>): Promise<{ busy: true } | { busy: false; value: T }> {
  const lock = await ctx.db.control.connect();
  let clean = false;
  try {
    const ok = (await lock.query("SELECT pg_try_advisory_lock(hashtext('test_leftovers:' || $1)) AS ok", [ctx.instanceId])).rows[0]?.ok === true;
    if (!ok) { clean = true; return { busy: true }; }
    const watch = watchLock(lock);
    try { return { busy: false, value: await fn(watch.alive) }; }
    finally {
      try {
        if (!watch.lost()) await lock.query("SELECT pg_advisory_unlock(hashtext('test_leftovers:' || $1))", [ctx.instanceId]).then(() => { clean = true; }, () => undefined);
        if (watch.lost()) {
          clean = false;
          log.warn("lock_connection_lost", { job: "test_purge" });
        }
      } finally { watch.done(); }
    }
  } finally { lock.release(!clean); }
}

interface ApplyArgs { apply: string; basis: string; backup?: string; noBackup: boolean; noWindow: boolean }
function applyArgs(args: string[]): ApplyArgs {
  const out: Partial<ApplyArgs> = { noBackup: false, noWindow: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!, v = args[i + 1];
    if (a === "--apply" && v) { out.apply = v; i++; continue; }
    if (a === "--basis" && v !== undefined) { out.basis = v; i++; continue; }
    if (a === "--backup" && v) { out.backup = v; i++; continue; }
    if (a === "--no-backup") { out.noBackup = true; continue; }
    if (a === "--no-window") { out.noWindow = true; continue; }
    throw new Error(`test_purge: unknown argument “${a}”`);
  }
  if (!out.apply) throw new Error("test_purge: --apply <plan> is required");
  if (!out.basis || !BASIS_RE.test(out.basis)) throw new Error("test_purge: --basis is required and must follow the pattern “approval <n>; …”");
  if (!!out.backup === out.noBackup) throw new Error("test_purge: use exactly one of --backup DIR and --no-backup");
  return out as ApplyArgs;
}

export async function testPurgeApply(ctx: PurgeCtx, args: string[], env: { testHooks?: boolean } = {}): Promise<Record<string, unknown>> {
  const a = applyArgs(args);
  if ((a.noBackup || a.noWindow) && !env.testHooks) throw new TestPurgeStop([a.noBackup ? "S5" : "S16"], "--no-backup and --no-window require MEMORY_TEST_HOOKS=1");
  const file = readPlan(a.apply, ctx.instanceId);
  if (!env.testHooks) {
    const gaps = expectGaps(file.inputs);
    if (gaps.length) throw new TestPurgeStop(["S8"], `plan has no --expect or lacks exact checks: ${gaps.join(", ")}. Regenerate it with --expect (test_purge_gate.py expect)`, { expect_missing: gaps });
  }
  const r = await withLeftoversLock(ctx, (alive) => applyUnderLock(ctx, a, file, alive));
  if (r.busy) { log.info("test_purge_busy", { instance: ctx.instanceId }); throw new TestPurgeStop([], "test_leftovers: another process is running", { busy: true }); }
  return r.value;
}

async function applyUnderLock(ctx: PurgeCtx, a: ApplyArgs, file: PurgePlan, alive: () => Promise<void>): Promise<Record<string, unknown>> {
  const atStart = new Date().toISOString();
  const stages: StageResult[] = [];
  const held = new Map<string, HeldLocator>();
  const stops: StopCode[] = [];
  const window = !a.noWindow;
  const meta: RunMeta = { plan: file.sha256, basis: a.basis, mode: "manual", age: file.age_minutes, window, alive,
    progress: async (stage, done) => { await alive(); await saveState(ctx, { progress: { plan_sha: file.sha256, stage, done } }); } };
  let work: PurgePlan | null = null, dropped: Record<string, number> = {}, droppedIds: string[] = [], newSince = 0, rerun = false;
  let storageDown0 = new Set<DataClass>(CLASSES);
  const finish = async (extra: Record<string, unknown> = {}) => {
    await alive();
    const totals = Object.fromEntries(stages.map((s) => [s.stage, s.deleted]));
    const storageRejected = work ? uniq([...CLASSES.filter((cls) => !storageDown0.has(cls)).flatMap((cls) => file.storage_orphans[cls].filter((k) => !work!.storage_orphans[cls].includes(k))),
                                         ...stages.filter((s) => s.stage === "storage_orphans").flatMap((s) => s.rejected_ids)]) : [];
    const applied = { plan_sha: file.sha256, at_start: atStart, at_end: new Date().toISOString(), basis: a.basis, window, rerun, backup: a.backup ?? null, stages, totals, stops, dropped, dropped_ids: droppedIds, new_since_plan: newSince,
                      storage_rejected: storageRejected, ...extra };
    try { writeNew(appliedPath(a.apply), applied); } catch (e) { log.warn("test_purge_applied_file_failed", { error: (e as Error).message.slice(0, 120) }); }
    await saveState(ctx, { at: applied.at_end, mode: "manual", blocked: stops, last_manual: { at: applied.at_end, plan: file.sha256, totals } }).catch(() => undefined);
    return { plan_sha: file.sha256, rerun, totals, stops, dropped, new_since_plan: newSince, stages: stages.map(({ ids_deleted: _i, rejected_ids: _r, ids_gone: _g, ...s }) => s), ...extra };
  };
  try {
    const pre = await readOnly(ctx, async (dbs) => {
      const other = window ? await windowBackends(dbs) : 0;
      const b = await buildPlan(ctx.instanceId, dbs, { mode: "manual", age: file.age_minutes, meetings: file.meetings.map(({ root, cls, fp }) => ({ root, cls, fp })),
        marks: file.marks, tAll: file.t_all, s3: ctx.s3 }, settingsGetter(ctx));
      const baseNow = window ? await baselineOf(ctx.instanceId, dbs, baselineExcl(file)) : null;
      const full = a.backup ? await baselineOf(ctx.instanceId, dbs, null) : null;
      const prior = (await dbs.audit.query("SELECT count(*)::int AS n FROM audit_events WHERE instance_id = $1 AND at >= $2::timestamptz AND details->>'plan' = $3",
        [ctx.instanceId, file.at, file.sha256])).rows[0].n as number;
      return { other, b, baseNow, full, prior };
    });
    rerun = pre.prior > 0;
    if (window && pre.other > 0) { stops.push("S16"); throw new TestPurgeStop(["S16"], `maintenance window: ${pre.other} connections from other services`); }
    if (window && baselineDiff(pre.baseNow!, file.baseline).length) { stops.push("S16"); throw new TestPurgeStop(["S16"], "maintenance window: baseline has changed since the plan was created", { tables: baselineDiff(pre.baseNow!, file.baseline) }); }
    if (a.backup) {
      const probs = backupCheck(a.backup, file.sha256, pre.full!, pre.b.originals.count);
      if (probs.length && rerun) probs.push("retry after interruption: take a new TP=1 backup in a new directory and copy the plan files into it. The original backup is the rollback point");
      if (probs.length) { stops.push("S5"); throw new TestPurgeStop(["S5"], `backup: ${probs.join("; ")}`); }
    } else if (pre.b.body.expected.staff_active !== 0) { stops.push("S5"); throw new TestPurgeStop(["S5"], "--no-backup used while active employees remain"); }
    const out = previewOut(ctx.instanceId, pre.b, pre.other, "", "manual");
    const ex = checkExpect(out, file.inputs.expect ?? [], { rerun });
    const s = STOP_CODES.filter((x) => (pre.b.stops.includes(x) && x !== "S12") || ex.codes.includes(x) || (x === "S4" && !window && pre.b.work.pgboss_jobs > 0));
    if (s.length) { stops.push(...s); throw new TestPurgeStop(s, `stopped: ${s.join(", ")}`, { proof: pre.b.proof, expect_failed: ex.failed }); }
    const x = intersect(file, pre.b.body);
    storageDown0 = new Set(pre.b.storageDown);
    work = x.work; dropped = x.dropped; droppedIds = x.droppedIds; newSince = x.newSince;

    for (const kind of ["org_unit", "service"] as const) {
      const ms_ = work.marks.filter((m) => m.kind === kind);
      if (!ms_.length) continue;
      const done = await tx(ctx.db.control, async (c) => {
        const pick = (await c.query("SELECT id::text AS id, state FROM tp_mark($1, $2, $3::uuid[], $4::uuid[], $5, $6, false)",
          [ctx.instanceId, kind, ms_.map((m) => m.id), ms_.filter((m) => m.owner_listed).map((m) => m.id), file.sha256, a.basis])).rows.filter((r) => r.state === "ok").map((r) => r.id as string);
        if (!pick.length) return { pick, done: [] as string[] };
        await alive();
        try { await auditWorkerStrict(ctx, { event_type: "admin", details: { op: "test_purge_mark", kind, n: pick.length, ids: pick, plan: file.sha256, basis: a.basis } }); }
        catch (e) { throw new TestPurgeStop(["S9"], `log was not written: ${(e as Error).message.slice(0, 120)}`); }
        await alive();
        const d = (await c.query("SELECT id::text AS id, state FROM tp_mark($1, $2, $3::uuid[], $4::uuid[], $5, $6, true)",
          [ctx.instanceId, kind, pick, ms_.filter((m) => m.owner_listed && pick.includes(m.id)).map((m) => m.id), file.sha256, a.basis])).rows.filter((r) => r.state === "deleted").map((r) => r.id as string);
        return { pick, done: d };
      });
      stages.push({ stage: `marks_${kind}`, requested: ms_.length, deleted: done.done.length, busy: 0, rejected: ms_.length - done.done.length, already_gone: 0, rejected_after_pick: done.pick.length - done.done.length, ids_deleted: done.done, rejected_ids: ms_.map((m) => m.id).filter((id) => !done.done.includes(id)), ids_gone: [] });
      if (window && done.done.length !== ms_.length) { stops.push("S13"); throw new TestPurgeStop(["S13"], "tp_mark rejected marks that the plan considers eligible"); }
    }

    const P = work.people, spacesAll = work.guard.spaces;
    const meetStage: StageResult = { stage: "meetings", requested: work.meetings.length, deleted: 0, busy: 0, rejected: 0, already_gone: 0, rejected_after_pick: 0, ids_deleted: [], rejected_ids: [], ids_gone: [] };
    for (const m of work.meetings) {
      const db = recordsDb(ctx, m.cls);
      const r = await tx(db, async (c) => {
        const tree = (await c.query("SELECT id, parent_id, owner_id, space_id, deleted_at, deleted_batch, attrs -> 'participants_unresolved' AS unresolved, attrs -> 'participants_pending' AS pending FROM records WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE", [m.ids])).rows;
        const root = tree.find((t) => t.id === m.root);
        if (!root) return "changed";
        if (tree.some((t) => !P.includes(t.owner_id) || !spacesAll.includes(t.space_id))) throw new TestPurgeStop(["S2"], "meeting: record tree row is outside the guard", { root: m.root });
        const kids = (await c.query(`WITH RECURSIVE t AS (SELECT id FROM records WHERE id = $1 UNION ALL SELECT r.id FROM records r JOIN t ON r.parent_id = t.id) SELECT id FROM t`, [m.root])).rows.map((x) => x.id as string);
        const people = (await c.query("SELECT record_id, person_id FROM record_people WHERE record_id = ANY($1::uuid[])", [kids])).rows.map((x) => [x.record_id, x.person_id] as [string, string]);
        const fp = meetingFp({ root: m.root, cls: m.cls, space_id: root.space_id, owner_id: root.owner_id, ids: kids, unresolved: root.unresolved, pending: root.pending, people });
        if (fp !== m.fp) return "changed";
        if (root.deleted_at) return root.deleted_batch === m.root && tree.every((t) => t.deleted_at) ? "marked_before" : "changed";
        await alive();
        try { await auditWorkerStrict(ctx, { event_type: "forget", class: m.cls, record_ids: kids, details: { reason: "test_purge", action: "owner_decision", basis: a.basis, meetings_sha: file.inputs.meetings_sha, plan: file.sha256, affected: kids.length } }); }
        catch (e) { throw new TestPurgeStop(["S9"], `log was not written: ${(e as Error).message.slice(0, 120)}`); }
        await alive();
        await c.query("SELECT mark_deleted($1, NULL, interval '0')", [m.root]);
        const outside = (await c.query("SELECT count(*)::int AS n FROM records WHERE deleted_batch = $1 AND NOT (owner_id = ANY($2::uuid[]) AND space_id = ANY($3::uuid[]))", [m.root, P, spacesAll])).rows[0].n;
        if (outside) throw new TestPurgeStop(["S2"], "meeting: marked row is outside the guard", { root: m.root });
        return "marked";
      });
      if (r === "changed") { meetStage.rejected++; meetStage.rejected_ids.push(m.root); continue; }
      if (r === "marked_before") { meetStage.already_gone++; meetStage.ids_gone.push(m.root); continue; }
      await alive();
      await syncDeletionMarks(ctx.db.control, db, m.ids);
      meetStage.deleted++; meetStage.ids_deleted.push(m.root);
    }
    if (work.meetings.length) stages.push(meetStage);

    for (const cls of CLASSES) {
      const ids = work.records[cls];
      const st1: StageResult = { stage: `trash_${cls}`, requested: ids.length, deleted: 0, busy: 0, rejected: 0, already_gone: 0, rejected_after_pick: 0, ids_deleted: [], rejected_ids: [], ids_gone: [] };
      for (const batch of chunks(ids, RECORDS_BATCH)) {
        const db = recordsDb(ctx, cls);
        const due = (await db.query("SELECT id FROM records WHERE id = ANY($1::uuid[]) AND deleted_at IS NOT NULL AND purge_after > now()", [batch])).rows.map((x) => x.id as string);
        if (!due.length) continue;
        await alive();
        try { await auditWorkerStrict(ctx, { event_type: "forget", class: cls, record_ids: due, details: { reason: "test_purge", action: "trash_expired", affected: due.length, plan: file.sha256, basis: a.basis } }); }
        catch (e) { throw new TestPurgeStop(["S9"], `log was not written: ${(e as Error).message.slice(0, 120)}`); }
        await alive();
        const done = (await db.query(
          "UPDATE records SET purge_after = now() WHERE id = ANY($1::uuid[]) AND deleted_at IS NOT NULL AND purge_after > now() AND owner_id = ANY($2::uuid[]) AND space_id = ANY($3::uuid[]) RETURNING id",
          [due, work.guard.owners, work.guard.spaces])).rows.map((x) => x.id as string);
        await alive();
        await syncDeletionMarks(ctx.db.control, db, done);
        st1.deleted += done.length; st1.ids_deleted.push(...done);
      }
      if (ids.length) stages.push(st1);
    }

    const recIds = { open: [...work.records.open, ...work.meetings.filter((m) => m.cls === "open").flatMap((m) => m.ids)], closed: [...work.records.closed, ...work.meetings.filter((m) => m.cls === "closed").flatMap((m) => m.ids)] };
    const pStage: StageResult = { stage: "purge", requested: recIds.open.length + recIds.closed.length, deleted: 0, busy: 0, rejected: 0, already_gone: 0, rejected_after_pick: 0, ids_deleted: [], rejected_ids: [], ids_gone: [] };
    if (pStage.requested) {
      let still = await leftIn(ctx, recIds), idle = 0;
      while (still > 0) {
        await alive();
        let res;
        try { res = await purgeRetrying(ctx, { ids: recIds, guard: work.guard, strict: { reason: "test_purge", plan: file.sha256, basis: a.basis, mode: "manual" } }, { everyMs: 2_000, maxMs: PURGE_WAIT_MS }); }
        catch (e) { if (e instanceof PurgeStop) { stops.push(e.code); throw new TestPurgeStop([e.code], e.message, e.detail); } throw e; }
        if (res.busy) { stops.push("S18"); throw new TestPurgeStop(["S18"], "purge: busy for more than 5 minutes"); }
        pStage.deleted += res.purged;
        for (const h of res.held ?? []) held.set(h.id, h);
        const next = await leftIn(ctx, recIds);
        idle = next < still ? 0 : idle + 1;
        still = next;
        if (idle >= 3) { stops.push("S11"); throw new TestPurgeStop(["S11"], `${still} planned records remain after purge`); }
      }
      stages.push(pStage);
    }

    stages.push(...await runTails(ctx, work, meta, held));
    // ---- 3–8: control
    stages.push(...await runControl(ctx, work, meta));
    stages.push(await readOnly(ctx, (dbs) => runStorage(ctx, dbs, work!, meta)));
    heldAsBusy(stages, [...held.keys()]);
    const after = await readOnly(ctx, async (dbs) => buildPlan(ctx.instanceId, dbs, { mode: "manual", age: file.age_minutes, meetings: file.meetings.map(({ root, cls, fp }) => ({ root, cls, fp })), marks: file.marks, tAll: file.t_all, s3: ctx.s3, held: [...held.values()] }, settingsGetter(ctx)));
    const left = intersect(work, after.body).remaining;
    const again = planIdSet(after.body);
    const rejectedAgain = stages.flatMap((st) => st.rejected_ids).filter((id) => again.has(id));
    const totals = Object.fromEntries(stages.map((s) => [s.stage, s.deleted]));
    await alive();
    try { await auditWorkerStrict(ctx, { event_type: "admin", details: { op: "test_purge_done", totals, mail_to_staff: file.mail_to_staff, plan: file.sha256, basis: a.basis, mode: "manual" } }); }
    catch (e) { stops.push("S9"); throw new TestPurgeStop(["S9"], `log was not written: ${(e as Error).message.slice(0, 120)}`); }
    log.info("test_purge_done", { totals });
    if (rejectedAgain.length) throw new TestPurgeStop(["S13"], `SQL rejected ${rejectedAgain.length} IDs that the plan still considers eligible`);
    return await finish({ remaining: left });
  } catch (e) {
    if (e instanceof LockConnectionLost) throw e;
    if (e instanceof TestPurgeStop) {
      for (const cd of e.codes) if (!stops.includes(cd)) stops.push(cd);
      log.warn("test_purge_blocked", { codes: stops });
      const r = await finish({ error: e.message.slice(0, 200) });
      throw Object.assign(e, { result: r });
    }
    log.warn("test_purge_failed", { error: String((e as Error)?.message ?? e).slice(0, 200) });
    await finish({ error: String((e as Error)?.message ?? e).slice(0, 200) }).catch(() => undefined);
    throw e;
  }
}

async function runControl(ctx: DbCtx, p: Parameters<typeof controlStages>[0], meta: RunMeta): Promise<StageResult[]> {
  const out: StageResult[] = [];
  for (const [stage, ids] of controlStages(p)) {
    if (stage === "org_units" && ids.length > 2000) {
      const parts = await unitLevels(ctx, ids);
      const merged: StageResult = { stage, requested: ids.length, deleted: 0, busy: 0, rejected: 0, already_gone: 0, rejected_after_pick: 0, ids_deleted: [], rejected_ids: [], ids_gone: [] };
      for (const lvl of parts) {
        const r = await runControlStage(ctx, stage, lvl, meta, 2000);
        merged.deleted += r.deleted; merged.busy += r.busy; merged.rejected += r.rejected; merged.rejected_after_pick += r.rejected_after_pick;
        merged.already_gone += r.already_gone;
        merged.ids_deleted.push(...r.ids_deleted); merged.rejected_ids.push(...r.rejected_ids); merged.ids_gone.push(...r.ids_gone);
      }
      out.push(merged);
      continue;
    }
    if (stage === "entities" && ids.length) {
      const held = new Set<string>();
      for (const cls of CLASSES)
        for (const r of (await recordsDb(ctx, cls).query("SELECT DISTINCT entity_id FROM record_entities WHERE entity_id = ANY($1::uuid[])", [ids])).rows) held.add(r.entity_id);
      const r = await runControlStage(ctx, stage, ids.filter((id) => !held.has(id)), meta);
      r.requested = ids.length; r.rejected += held.size; r.rejected_ids.push(...held);
      out.push(r);
      continue;
    }
    out.push(await runControlStage(ctx, stage, ids, meta, stage === "org_units" ? 2000 : TEST_PURGE_BATCH));
  }
  return out;
}

async function unitLevels(ctx: DbCtx, ids: string[]): Promise<string[][]> {
  const rows = (await ctx.db.control.query("SELECT id, parent_id FROM org_units WHERE id = ANY($1::uuid[])", [ids])).rows as Array<{ id: string; parent_id: string | null }>;
  const parent = new Map(rows.map((r) => [r.id, r.parent_id]));
  const depth = (id: string): number => { let d = 0, cur = parent.get(id); while (cur && parent.has(cur) && d < 1000) { d++; cur = parent.get(cur); } return d; };
  const by = new Map<number, string[]>();
  for (const id of ids) { const d = depth(id); by.set(d, [...(by.get(d) ?? []), id]); }
  return [...by.keys()].sort((a, b) => b - a).flatMap((d) => chunks(by.get(d)!, 2000));
}

function controlStages(p: Pick<PurgePlan, "tickets" | "keys" | "sessions" | "grants" | "members" | "person_attrs" | "services" | "spaces" | "org_units" | "people" | "entities">): Array<[StageName, string[]]> {
  return [["tickets", p.tickets], ["keys", p.keys], ["sessions", p.sessions], ["grants", p.grants], ["members", p.members.map(([s, q]) => `${s}:${q}`)], ["person_attrs", p.person_attrs],
    ["services", p.services], ["spaces", p.spaces], ["org_units", p.org_units], ["people", p.people], ["entities", [...p.entities.person, ...p.entities.project]]];
}

async function leftIn(ctx: DbCtx, ids: { open: string[]; closed: string[] }): Promise<number> {
  let n = 0;
  for (const cls of CLASSES) if (ids[cls].length) n += (await recordsDb(ctx, cls).query("SELECT count(*)::int AS n FROM records WHERE id = ANY($1::uuid[])", [ids[cls]])).rows[0].n;
  return n;
}

function planIdSet(p: PlanBody): Set<string> {
  return new Set<string>([...LIST_KEYS.flatMap((k) => p[k] as string[]), ...p.members.map(([sp, q]) => `${sp}:${q}`), ...p.entities.person, ...p.entities.project,
    ...p.records.open, ...p.records.closed, ...p.meetings.map((m) => m.root)]);
}
const LIST_KEYS = ["people", "personal", "spaces", "tickets", "keys", "oauth", "sessions", "grants", "person_attrs", "services", "org_units", "class_moves", "deletion_requests", "mail", "action_plans", "orphan_locators", "links"] as const;
function intersect(file: PurgePlan, now: PlanBody): { work: PurgePlan; dropped: Record<string, number>; droppedIds: string[]; newSince: number; remaining: Record<string, number> } {
  const dropped: Record<string, number> = {}, remaining: Record<string, number> = {};
  let newSince = 0;
  const w: any = { ...file };
  for (const k of LIST_KEYS) {
    const a = new Set(file[k] as string[]), b = new Set(now[k] as string[]);
    w[k] = [...a].filter((x) => b.has(x));
    dropped[k] = a.size - w[k].length; remaining[k] = w[k].length;
    newSince += [...b].filter((x) => !a.has(x)).length;
  }
  for (const cls of CLASSES) { const b = new Set(now.records[cls]); w.records = { ...w.records, [cls]: file.records[cls].filter((x) => b.has(x)) }; dropped[`records_${cls}`] = file.records[cls].length - w.records[cls].length; remaining[`records_${cls}`] = w.records[cls].length; }
  const mNow = new Map(now.meetings.map((m) => [m.root, m]));
  w.meetings = file.meetings.filter((m) => mNow.get(m.root)?.fp === m.fp);
  dropped.meetings = file.meetings.length - w.meetings.length; remaining.meetings = w.meetings.length;
  const fileRec = new Set([...file.records.open, ...file.records.closed, ...file.meetings.flatMap((m) => m.ids)]);
  const ownLoc = now.orphan_locators.filter((x) => fileRec.has(x) && !w.orphan_locators.includes(x));
  if (ownLoc.length) { w.orphan_locators = [...w.orphan_locators, ...ownLoc]; remaining.orphan_locators = w.orphan_locators.length; newSince -= ownLoc.length; }
  const pairs = new Set(now.members.map(([s, p]) => `${s}:${p}`));
  w.members = file.members.filter(([s, p]) => pairs.has(`${s}:${p}`));
  dropped.members = file.members.length - w.members.length; remaining.members = w.members.length;
  for (const k of ["person", "project"] as const) { const b = new Set(now.entities[k]); w.entities = { ...w.entities, [k]: file.entities[k].filter((x) => b.has(x)) }; dropped[`entities_${k}`] = file.entities[k].length - w.entities[k].length; remaining[`entities_${k}`] = w.entities[k].length; }
  const marksNow = new Set([...now.org_units, ...now.services]);
  w.marks = file.marks.filter((m) => marksNow.has(m.id));
  for (const cls of CLASSES) { const b = new Set(now.storage_orphans[cls]); w.storage_orphans = { ...w.storage_orphans, [cls]: file.storage_orphans[cls].filter((x) => b.has(x)) }; }
  w.guard = { owners: file.guard.owners.filter((x) => now.guard.owners.includes(x)), spaces: file.guard.spaces.filter((x) => now.guard.spaces.includes(x)) };
  const kept = planIdSet(w as PurgePlan);
  const droppedIds = [...planIdSet(file)].filter((id) => !kept.has(id));
  return { work: w as PurgePlan, dropped, droppedIds, newSince, remaining };
}

export async function testPurgeAuto(ctx: PurgeCtx): Promise<Record<string, unknown>> {
  const r = await withLeftoversLock(ctx, (alive) => autoUnderLock(ctx, alive));
  if (r.busy) { log.info("test_purge_busy", { instance: ctx.instanceId }); return { busy: true }; }
  return r.value;
}

async function autoUnderLock(ctx: PurgeCtx, alive: () => Promise<void>): Promise<Record<string, unknown>> {
  const at = new Date().toISOString();
  const prev = (await ctx.db.control.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = 'test_purge'", [ctx.instanceId])).rows[0]?.value ?? {};
  const st = await purgeSettings(ctx.db.control, ctx.instanceId);
  const block = async (codes: StopCode[], extra: Record<string, unknown> = {}) => {
    await alive();
    const prevCodes = Array.isArray(prev.blocked) ? prev.blocked : [];
    if (canon([...prevCodes].sort()) !== canon([...codes].sort()) && codes.length)
      await auditWorkerStrict(ctx, { event_type: "admin", details: { op: "test_purge_blocked", codes } }).catch((e) => log.warn("test_purge_failed", { error: (e as Error).message.slice(0, 200) }));
    if (codes.length) log.warn("test_purge_blocked", { codes });
    await alive();
    await saveState(ctx, { at, mode: st.purge, blocked: codes, last_auto: { at, totals: {}, busy: 0 }, ...extra });
    return { mode: st.purge, blocked: codes, ...extra };
  };
  if (st.purge !== "auto" || st.leftovers_scope === "off") return block(["S10"]);
  const age = Math.max(st.after_hours * 60, ageLowerBound(st));
  const b = await readOnly(ctx, (dbs) => buildPlan(ctx.instanceId, dbs, { mode: "auto", age, meetings: null, marks: [], s3: ctx.s3 }, settingsGetter(ctx)));
  const codes = new Set<StopCode>(b.stops.filter((x) => x !== "S12" && x !== "S15"));
  if (b.work.pgboss_jobs > 0) codes.add("S4");
  const cats: Array<[string, number]> = [["people", b.body.people.length], ["spaces", b.body.spaces.length], ["keys", b.body.keys.length], ["sessions", b.body.sessions.length],
    ["tickets", b.body.tickets.length], ["grants", b.body.grants.length], ["members", b.body.members.length], ["services", b.body.services.length], ["org_units", b.body.org_units.length],
    ["entities", b.body.entities.person.length + b.body.entities.project.length], ["class_moves", b.body.class_moves.length], ["mail", b.body.mail.length],
    ["storage", b.body.storage_orphans.open.length + b.body.storage_orphans.closed.length]];
  if (cats.some(([, n]) => n > st.max)) codes.add("S3");
  if (b.unitsWithoutOrigin.length || b.servicesWithoutOrigin.length) codes.add("S17");
  const backlog = { people: b.body.people.length, spaces: b.body.spaces.length, keys: b.body.keys.length, sessions: b.body.sessions.length, org_units: b.body.org_units.length, services: b.body.services.length,
                    entities: b.body.entities.person.length + b.body.entities.project.length };
  const keptNums = Object.fromEntries(Object.entries(b.body.kept).map(([k, v]) => [k, Object.values(v).reduce((x, ids) => x + ids.length, 0)]));
  if (codes.size) return block(STOP_CODES.filter((x) => codes.has(x)), { backlog, kept: keptNums });
  const sha = sha256(canon(b.body));
  const meta: RunMeta = { plan: sha, basis: null, mode: "auto", age, window: false, alive };
  const stages: StageResult[] = [];
  const held = new Map<string, HeldLocator>();
  const plan = { ...b.body } as unknown as PurgePlan;
  try {
    stages.push(...await runTails(ctx, plan, meta, held));
    stages.push(...await runControl(ctx, plan, meta));
    stages.push(await readOnly(ctx, (dbs) => runStorage(ctx, dbs, plan, meta)));
  } catch (e) {
    if (e instanceof LockConnectionLost) throw e;
    if (e instanceof TestPurgeStop) return block(e.codes, { backlog, kept: keptNums });
    log.warn("test_purge_failed", { error: String((e as Error)?.message ?? e).slice(0, 200) });
    throw e;
  }
  heldAsBusy(stages, [...held.keys()]);
  const after = await readOnly(ctx, (dbs) => buildPlan(ctx.instanceId, dbs, { mode: "auto", age, meetings: null, marks: [], s3: ctx.s3, held: [...held.values()] }, settingsGetter(ctx)));
  const again = planIdSet(after.body);
  const rejectedAgain = stages.flatMap((s) => s.rejected_ids).filter((id) => again.has(id));
  const totals = Object.fromEntries(stages.map((s) => [s.stage, s.deleted]));
  const busy = stages.reduce((x, s) => x + s.busy, 0);
  const blocked: StopCode[] = rejectedAgain.length ? ["S13"] : [];
  if (Object.values(totals).some((n) => n)) {
    await alive();
    await auditWorkerStrict(ctx, { event_type: "admin", details: { op: "test_purge_done", totals, mail_to_staff: b.body.mail_to_staff, plan: sha, basis: null, mode: "auto" } })
      .catch((e) => log.warn("test_purge_failed", { error: (e as Error).message.slice(0, 200) }));
    log.info("test_purge_done", { totals });
  }
  if (blocked.length) return block(blocked, { last_auto: { at, totals, busy }, backlog, kept: keptNums });
  const newBacklog = { people: after.body.people.length, spaces: after.body.spaces.length, keys: after.body.keys.length, sessions: after.body.sessions.length, org_units: after.body.org_units.length,
                       services: after.body.services.length, entities: after.body.entities.person.length + after.body.entities.project.length };
  await alive();
  await saveState(ctx, { at, mode: "auto", blocked: [], last_auto: { at, totals, busy }, backlog: newBacklog, kept: keptNums });
  return { mode: "auto", blocked: [], totals, busy, backlog: newBacklog };
}

// ---------------------------------------------------------------- --check
async function purgeCheck(ctx: PurgeCtx, dbs: Dbs, file: string): Promise<Record<string, unknown>> {
  const plan = readJson(file) as PurgePlan;
  const { sha256: s, ...rest } = plan;
  if (plan?.kind !== "test_purge_plan" || sha256(canon(rest)) !== s || plan.instance !== ctx.instanceId) throw new Error("--check: plan belongs to a different instance or sha is invalid");
  const appliedAll = appliedFiles(file);
  const applied = appliedAll.length ? appliedAll[appliedAll.length - 1] : null;
  const dropped = new Set<string>(appliedAll.flatMap((x) => (Array.isArray(x.dropped_ids) ? x.dropped_ids : [])));
  const c = dbs.control;
  const exist = async (sql: string, ids: string[]) => (ids.length ? (await c.query(sql, [ids])).rows.map((r) => String(r.id)) : []);
  const rec = [...plan.records.open, ...plan.records.closed, ...plan.meetings.flatMap((m) => m.ids)];
  const existing: Record<string, string[]> = {
    people: await exist("SELECT id FROM people WHERE id = ANY($1::uuid[])", plan.people),
    spaces: await exist("SELECT id FROM spaces WHERE id = ANY($1::uuid[])", [...plan.spaces, ...plan.personal]),
    keys: await exist("SELECT id FROM api_keys WHERE id = ANY($1::uuid[])", plan.keys),
    oauth: await exist("SELECT id FROM oauth_connections WHERE id = ANY($1::uuid[])", plan.oauth),
    grants: await exist("SELECT id FROM role_grants WHERE id = ANY($1::uuid[])", plan.grants),
    services: await exist("SELECT id FROM services WHERE id = ANY($1::uuid[])", plan.services),
    org_units: await exist("SELECT id FROM org_units WHERE id = ANY($1::uuid[])", plan.org_units),
    entities: await exist("SELECT id FROM entities WHERE id = ANY($1::uuid[])", [...plan.entities.person, ...plan.entities.project]),
    class_moves: await exist("SELECT id FROM class_moves WHERE id = ANY($1::uuid[])", plan.class_moves),
    deletion_requests: await exist("SELECT id FROM deletion_requests WHERE id = ANY($1::uuid[])", plan.deletion_requests),
    mail: await exist("SELECT id FROM mail_outbox WHERE id = ANY($1::uuid[])", plan.mail),
    action_plans: await exist("SELECT id FROM action_plans WHERE id = ANY($1::uuid[])", plan.action_plans),
    orphan_locators: await exist("SELECT record_id AS id FROM record_locations WHERE record_id = ANY($1::uuid[])", plan.orphan_locators),
    person_attrs: await exist(`SELECT x AS id FROM unnest($1::uuid[]) x WHERE EXISTS (SELECT 1 FROM person_identities i WHERE i.person_id = x)
                                 OR EXISTS (SELECT 1 FROM person_org_units l WHERE l.person_id = x) OR EXISTS (SELECT 1 FROM directory_group_members d WHERE d.person_id = x)`, plan.person_attrs),
    members: plan.members.length ? (await c.query("SELECT m.space_id::text || ':' || m.person_id::text AS id FROM space_members m JOIN unnest($1::uuid[], $2::uuid[]) AS x(s, p) ON m.space_id = x.s AND m.person_id = x.p",
      [plan.members.map((m) => m[0]), plan.members.map((m) => m[1])])).rows.map((r) => r.id as string) : [],
    records: [],
  };
  const deps = plan.people.length || plan.guard.owners.length
    ? (await c.query("SELECT kind, id FROM tp_dependents($1, $2::uuid[], interval '0', $3::uuid[])", [ctx.instanceId, uniq([...plan.people, ...plan.guard.owners]), plan.keys])).rows : [];
  existing.sessions = deps.filter((d) => d.kind === "session" && plan.sessions.includes(d.id)).map((d) => d.id as string);
  existing.tickets = deps.filter((d) => d.kind === "ticket" && plan.tickets.includes(d.id)).map((d) => d.id as string);
  for (const cls of CLASSES) if (rec.length) existing.records!.push(...(await dbs.records(cls).query("SELECT id FROM records WHERE id = ANY($1::uuid[])", [rec])).rows.map((r) => r.id as string));
  const remainingBy = Object.fromEntries(Object.entries(existing).map(([k, ids]) => [k, ids.filter((id) => !dropped.has(id)).length]));
  const remainingIds = new Set(Object.values(existing).flat());
  const universe = planIdSet(plan);
  for (const id of rec) universe.add(id);
  for (const m of plan.marks) universe.add(m.id);
  const ev = (await dbs.audit.query(
    `SELECT event_type, record_ids, details FROM audit_events WHERE instance_id = $1 AND at > $2::timestamptz AND (details->>'reason' = 'test_purge' OR details->>'op' LIKE 'test_purge%')`,
    [ctx.instanceId, plan.at])).rows;
  let outside = 0, withoutEffect = 0;
  for (const e of ev) {
    if (e.details?.plan && e.details.plan !== plan.sha256 && e.details?.mode !== "auto") continue;
    if (e.details?.mode === "auto") continue;
    const ids: string[] = [...(e.record_ids ?? []), ...(Array.isArray(e.details?.ids) ? e.details.ids : [])];
    outside += ids.filter((id) => !universe.has(id)).length;
    if (e.details?.op === "test_purge") withoutEffect += ids.filter((id) => remainingIds.has(id)).length;
  }
  let tombsAdded = 0, purgedByOthers = 0;
  for (const cls of CLASSES) if (rec.length) tombsAdded += (await dbs.records(cls).query("SELECT count(*)::int AS n FROM record_tombstones WHERE id = ANY($1::uuid[]) AND at > $2::timestamptz", [rec, plan.at])).rows[0].n;
  const ourPurged = new Set(ev.filter((e) => e.event_type === "purge").flatMap((e) => (e.record_ids ?? []) as string[]));
  purgedByOthers = rec.filter((id) => !existing.records!.includes(id) && !ourPurged.has(id)).length;
  const base = await baselineOf(ctx.instanceId, dbs, baselineExcl(plan));
  const changed = baselineDiff(base, plan.baseline);
  const strict = appliedAll.length ? appliedAll.every((x) => x.window !== false) : true;
  const exp = await expectedOf(c, ctx.instanceId);
  const dangling: Record<string, number> = { record_entities: 0, record_people: 0, record_placements: 0, records_people: 0, record_locations: 0, grant_scope: 0 };
  for (const cls of CLASSES) {
    const db = dbs.records(cls);
    dangling.record_entities! += await countMissing(db, "SELECT DISTINCT entity_id AS id FROM record_entities", c, "entities");
    dangling.record_people! += await countMissing(db, "SELECT DISTINCT person_id AS id FROM record_people", c, "people");
    dangling.record_placements! += await countMissing(db, "SELECT DISTINCT placed_by AS id FROM record_placements WHERE placed_by IS NOT NULL", c, "people")
      + await countMissing(db, "SELECT DISTINCT space_id AS id FROM record_placements", c, "spaces");
    dangling.records_people! += await countMissing(db, "SELECT DISTINCT x AS id FROM records r CROSS JOIN LATERAL (VALUES (r.owner_id), (r.confirmed_by), (r.deleted_by)) v(x) WHERE x IS NOT NULL", c, "people");
  }
  const sps = [...plan.spaces, ...plan.personal];
  const locs = (await c.query("SELECT record_id FROM record_locations WHERE owner_id = ANY($1::uuid[]) OR space_id = ANY($2::uuid[])", [plan.guard.owners, sps])).rows.map((r) => r.record_id as string);
  if (locs.length) { let present = 0; for (const cls of CLASSES) present += (await dbs.records(cls).query("SELECT count(*)::int AS n FROM records WHERE id = ANY($1::uuid[])", [locs])).rows[0].n; dangling.record_locations = locs.length - present; }
  dangling.grant_scope = (await c.query(
    `SELECT count(*)::int AS n FROM role_grants g WHERE g.instance_id = $1 AND g.revoked_at IS NULL AND (g.valid_to IS NULL OR g.valid_to > now())
       AND ((g.scope_kind = 'space' AND NOT EXISTS (SELECT 1 FROM spaces s WHERE s.slug = g.scope_ref AND s.instance_id = g.instance_id))
         OR (g.scope_kind IN ('org_unit', 'org_branch') AND NOT EXISTS (SELECT 1 FROM org_units u WHERE u.code = g.scope_ref AND u.instance_id = g.instance_id)))`,
    [ctx.instanceId])).rows[0].n;
  const storageKept = new Set<string>(appliedAll.flatMap((x) => (Array.isArray(x.storage_rejected) ? x.storage_rejected : [])));
  let storageLeft = 0, storageUnverified = 0;
  for (const cls of CLASSES) {
    if (!plan.storage_orphans[cls].length) continue;
    const t = ctx.s3?.(cls);
    if (!t) { storageUnverified = 1; continue; }
    let listed: Awaited<ReturnType<typeof s3List>>;
    try { listed = await s3List(t, `${ctx.instanceId}/`, STORAGE_MAX); }
    catch (e) { storageUnverified = 1; log.warn("test_purge_check_storage_unavailable", { class: cls, error: (e as Error).message.slice(0, 120) }); continue; }
    const keys = new Set(listed.map((o) => o.key));
    storageLeft += plan.storage_orphans[cls].filter((k) => keys.has(k) && !storageKept.has(k)).length;
  }
  const check = {
    remaining: Object.values(remainingBy).reduce((a, n) => a + n, 0),
    events_outside_plan: outside,
    baseline_changed: strict ? changed.length : 0,
    staff_active_changed: Number(exp.staff_active !== plan.expected.staff_active),
    active_spaces_changed: Number(exp.active_spaces !== plan.expected.active_spaces),
    showcase_changed: Number(canon(exp.showcase) !== canon(plan.expected.showcase)),
    dangling: Object.values(dangling).reduce((a, n) => a + n, 0),
    storage_orphans_left: storageLeft,
    storage_unverified: storageUnverified,
  };
  return {
    kind: "test_purge_check", plan_sha: plan.sha256, check, remaining_by: remainingBy, dangling_by: dangling,
    info: { tombstones_added: tombsAdded, events_without_effect: withoutEffect, purged_by_others: purgedByOthers, baseline_changed_tables: changed, baseline_strict: strict,
            dropped: applied?.dropped ?? {}, busy_left: applied ? (applied.stages ?? []).reduce((a: number, x: any) => a + (x.busy ?? 0), 0) : null, storage_kept: storageKept.size },
    ok: Object.values(check).every((v) => v === 0),
  };
}

async function countMissing(db: Q, sql: string, control: Q, table: "people" | "spaces" | "entities"): Promise<number> {
  const ids = (await db.query(sql)).rows.map((r) => r.id as string);
  if (!ids.length) return 0;
  const found = (await control.query(`SELECT count(*)::int AS n FROM ${table} WHERE id = ANY($1::uuid[])`, [ids])).rows[0].n as number;
  return ids.length - found;
}
