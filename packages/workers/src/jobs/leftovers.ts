import { LockConnectionLost, watchLock } from "@memory/shared";
import { commitOrThrow } from "@memory/shared";   // a COMMIT answered with ROLLBACK is an error
import { closeSync, fchmodSync, openSync, readFileSync, writeSync } from "node:fs";
import { auditArchivedBefore, isTestDomainLogin, log, SHOWCASE_LOGINS, syncDeletionMarks, tx, type DataClass } from "@memory/shared";
import { auditWorkerStrict, auditWorkerStrictMany, recordsDb, type DbCtx } from "../ctx.ts";
import { deleteLocators, dropDerivedLinks } from "./links.ts";

export const TEST_LEFTOVERS_BATCH = 500;
export const TEST_LEFTOVERS_PASSES = 40;
export const TEST_LEFTOVERS_REASONS = ["read_by_staff", "placed_by_staff", "staff_participants", "pending_participants", "unresolved_participants", "foreign_owner"] as const;

export type LeftoversScope = "off" | "org" | "all";
export type Reason = (typeof TEST_LEFTOVERS_REASONS)[number];
export type Kind = "org" | "personal" | "team" | "project" | "dep";
interface Q { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> }
type Records = (cls: DataClass) => Q;

const SCOPES: readonly LeftoversScope[] = ["off", "org", "all"];
const CLASSES: readonly DataClass[] = ["open", "closed"];
const REASON = "test_leftovers";
const OUTSIDE_GRACE = "7 days";
const TREE_CHUNK = 1000;
const LIST = 50, KEPT_ITEMS = 100;

const domainOf = (p: string) => `lower(split_part(${p}.login, '@', 2))`;
const DEMO_LOGINS = SHOWCASE_LOGINS;
const notDemoSql = (p: string) => `(COALESCE(${p}.attrs->>'demo', '') <> 'true' AND lower(${p}.login) NOT IN (${DEMO_LOGINS.map((l) => `'${l}'`).join(", ")}))`;
export const testDomainSql = (p: string) => `(${domainOf(p)} IN ('corp.test', 'test') OR ${domainOf(p)} LIKE '%.test')`;
export const orgLeftoverSql = (p: string, scope: LeftoversScope) =>
  `(NOT ${p}.active AND ${notDemoSql(p)} AND (${p}.attrs->>'test' = 'true' OR ${p}.login ILIKE '%@corp.test'${scope === "all" ? ` OR ${testDomainSql(p)}` : ""}))`;
export const leftoverPersonSql = (p: string) => `(NOT ${p}.active AND ${notDemoSql(p)} AND ${testDomainSql(p)})`;
export const staffSql = (p: string) => `(NOT ${testDomainSql(p)} AND ${notDemoSql(p)})`;
export const showcaseSql = (s: string) =>
  `(${s}.slug LIKE 'demo-%' OR EXISTS (SELECT 1 FROM org_units su WHERE su.id = ${s}.org_unit_id AND su.code = 'demo')
    OR EXISTS (SELECT 1 FROM people sd WHERE sd.id = ${s}.owner_id AND NOT ${notDemoSql("sd")}))`;
const AGED = "COALESCE(GREATEST(ps.archived_at, p.updated_at) <= now() - make_interval(mins => $2::int), false)";
const PERSONAL = "LEFT JOIN spaces ps ON ps.kind = 'personal' AND ps.owner_id = p.id";
const KIND_SQL = "CASE WHEN s.kind IN ('org', 'personal') THEN s.kind WHEN s.org_unit_id IS NOT NULL THEN 'dep' ELSE s.kind END";

export async function leftoverSettings(q: Q, instanceId: string): Promise<{ scope: LeftoversScope; grace: number }> {
  const rows = (await q.query(
    `SELECT key, COALESCE(value, default_value) AS value FROM settings
     WHERE instance_id = $1 AND category = 'access' AND key IN ('test_leftovers_scope', 'test_leftovers_grace_minutes')`, [instanceId])).rows;
  const v = (k: string) => rows.find((r) => r.key === k)?.value;
  const scope = SCOPES.includes(v("test_leftovers_scope")) ? v("test_leftovers_scope") as LeftoversScope : "org";
  const g = v("test_leftovers_grace_minutes");
  return { scope, grace: typeof g === "number" && Number.isInteger(g) && g >= 1 && g <= 10080 ? g : 60 };
}

export interface Loc { id: string; cls: DataClass; space: string; owner: string; live: boolean; old: boolean; kind: Kind }
export interface Person { id: string; login: string; active: boolean; demo: boolean; testDomain: boolean }
export interface SpaceInfo { id: string; kind: string; staffMembers: number; staffOwner: boolean; showcase: boolean }
export interface TreeRow { root: string; id: string; owner_id: string; space_id: string; live: boolean; hidden: boolean; running: boolean;
                    pending: unknown; unresolved: unknown; people: string[]; placements: Array<{ s: string; b: string | null }> }
interface Root { id: string; cls: DataClass; kind: Kind; space: string; ids: string[]; owners: string[]; verdict: "remove" | "wait" | Reason }
interface Trash { id: string; cls: DataClass; ids: string[]; owners: string[] }
interface Plan {
  scope: "org" | "all"; grace: number; org: string | null;
  eOrg: Set<string>; e: Set<string>;
  roots: Root[]; trash: Trash[]; orphans: Loc[];
  held: Array<{ id: string; cls: DataClass; ids: string[]; verdict: Exclude<Root["verdict"], "remove"> }>;
  skippedHomes: Set<string>;
}

const nonEmpty = (v: unknown): boolean =>
  Array.isArray(v) ? v.length > 0 : v !== null && typeof v === "object" ? Object.keys(v as object).length > 0 : typeof v === "string" ? v.trim() !== "" : false;
const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));

async function buildPlan(control: Q, records: Records, instanceId: string, scope: "org" | "all", grace: number): Promise<Plan> {
  const org = (await control.query("SELECT id FROM spaces WHERE kind = 'org' AND instance_id = $1", [instanceId])).rows[0]?.id ?? null;
  const people = (await control.query(
    `SELECT p.id, ${orgLeftoverSql("p", scope)} AS org_leftover, ${leftoverPersonSql("p")} AND ${AGED} AS ready
     FROM people p ${PERSONAL} WHERE p.instance_id = $1 AND (${orgLeftoverSql("p", scope)} OR ${leftoverPersonSql("p")})`, [instanceId, grace])).rows;
  const eOrg = new Set<string>(people.filter((p) => p.org_leftover).map((p) => p.id));
  const e = new Set<string>(people.filter((p) => p.ready).map((p) => p.id));
  const plan: Plan = { scope, grace, org, eOrg, e, roots: [], trash: [], orphans: [], held: [], skippedHomes: new Set() };
  if (!eOrg.size && !(scope === "all" && e.size)) return plan;
  const locs: Loc[] = (await control.query(
    `SELECT l.record_id AS id, l.class AS cls, l.space_id AS space, l.owner_id AS owner, NOT l.deleted AS live,
            l.created_at < now() - interval '1 hour' AS old, ${KIND_SQL} AS kind
     FROM record_locations l JOIN spaces s ON s.id = l.space_id
     WHERE s.instance_id = $1 AND (NOT l.deleted OR l.purge_after > now()) AND NOT ${showcaseSql("s")}
       AND ((s.kind = 'org' AND l.owner_id = ANY($2::uuid[]))
            OR ($3::boolean AND s.kind IN ('personal', 'team', 'project') AND s.owner_id = ANY($4::uuid[]) AND l.owner_id = ANY($4::uuid[])))`,
    [instanceId, [...eOrg], scope === "all", [...e]])).rows;
  if (!locs.length) return plan;

  const trees: TreeRow[] = [], trashTrees: TreeRow[] = [];
  const rootsOf = new Map<DataClass, Array<{ id: string; loc: Loc }>>(), trashOf = new Map<DataClass, Array<{ id: string; loc: Loc }>>();
  for (const cls of CLASSES) {
    const cand = locs.filter((l) => l.cls === cls);
    if (!cand.length) continue;
    const db = records(cls), loc = new Map(cand.map((l) => [l.id, l]));
    const rows = (await db.query(
      "SELECT id, parent_id, owner_id, deleted_at IS NULL AS live, (deleted_at IS NOT NULL AND purge_after > now()) AS trash FROM records WHERE id = ANY($1::uuid[])",
      [cand.map((l) => l.id)])).rows;
    const live = new Set(rows.filter((r) => r.live).map((r) => r.id as string));
    const roots = rows.filter((r) => r.live && !(r.parent_id && live.has(r.parent_id))).map((r) => ({ id: r.id as string, loc: loc.get(r.id)! }));
    rootsOf.set(cls, roots);
    const trash = rows.filter((r) => r.trash && loc.get(r.id)!.kind === "org" && eOrg.has(r.owner_id)).map((r) => ({ id: r.id as string, loc: loc.get(r.id)! }));
    trashOf.set(cls, trash);
    const trashIds = new Set(trash.map((r) => r.id));
    for (const part of chunks([...roots, ...trash].map((r) => r.id), TREE_CHUNK))
      for (const t of (await db.query(
        `WITH RECURSIVE tree AS (SELECT id, id AS root FROM records WHERE id = ANY($1::uuid[])
                                 UNION ALL SELECT r.id, t.root FROM records r JOIN tree t ON r.parent_id = t.id)
         SELECT t.root, t.id, r.owner_id, r.space_id, r.deleted_at IS NULL AS live, r.hidden_at IS NOT NULL AS hidden,
                r.attrs -> 'participants_pending' AS pending, r.attrs -> 'participants_unresolved' AS unresolved,
                EXISTS (SELECT 1 FROM record_stages st WHERE st.record_id = r.id AND st.status = 'running') AS running,
                (SELECT COALESCE(jsonb_agg(rp.person_id), '[]'::jsonb) FROM record_people rp WHERE rp.record_id = r.id) AS people,
                (SELECT COALESCE(jsonb_agg(jsonb_build_object('s', pl.space_id, 'b', pl.placed_by)), '[]'::jsonb) FROM record_placements pl WHERE pl.record_id = r.id) AS placements
         FROM tree t JOIN records r ON r.id = t.id`, [part])).rows as TreeRow[]) (trashIds.has(t.root) ? trashTrees : trees).push(t);
    if (scope === "all") {
      const present = new Set(rows.map((r) => r.id as string));
      const missing = cand.filter((l) => l.live && l.old && !present.has(l.id));
      if (missing.length) {
        const other = new Set((await records(cls === "open" ? "closed" : "open").query("SELECT id FROM records WHERE id = ANY($1::uuid[])", [missing.map((l) => l.id)])).rows.map((r) => r.id as string));
        plan.orphans.push(...missing.filter((l) => !other.has(l.id)));
      }
    }
  }

  const personIds = new Set<string>(), spaceIds = new Set<string>(), treeIds = new Set<string>(plan.orphans.map((o) => o.id));
  for (const t of [...trees, ...trashTrees]) {
    personIds.add(t.owner_id); spaceIds.add(t.space_id); treeIds.add(t.id);
    for (const p of t.people) personIds.add(p);
    for (const pl of t.placements) { spaceIds.add(pl.s); if (pl.b) personIds.add(pl.b); }
  }
  const persons = new Map<string, Person>((personIds.size ? (await control.query(
    `SELECT p.id, p.login, p.active, NOT ${notDemoSql("p")} AS demo, ${testDomainSql("p")} AS "testDomain" FROM people p WHERE p.id = ANY($1::uuid[])`,
    [[...personIds]])).rows : []).map((p) => [p.id as string, p as Person]));
  const spaces = new Map<string, SpaceInfo>((spaceIds.size ? (await control.query(
    `SELECT s.id, s.kind, ${showcaseSql("s")} AS showcase,
            (SELECT count(*) FROM space_members_effective m JOIN people q ON q.id = m.person_id WHERE m.space_id = s.id AND ${staffSql("q")})::int AS "staffMembers",
            EXISTS (SELECT 1 FROM people o WHERE o.id = s.owner_id AND o.active AND ${staffSql("o")}) AS "staffOwner"
     FROM spaces s WHERE s.id = ANY($1::uuid[])`, [[...spaceIds]])).rows : []).map((s) => [s.id as string, s as SpaceInfo]));
  const moving = new Set<string>(treeIds.size ? (await control.query(
    "SELECT DISTINCT record_id FROM class_moves WHERE status IN ('pending', 'copying', 'verifying') AND record_id = ANY($1::uuid[])", [[...treeIds]])).rows.map((r) => r.record_id as string) : []);
  plan.orphans = plan.orphans.filter((o) => !moving.has(o.id));

  const byRoot = new Map<string, TreeRow[]>();
  for (const t of [...trees, ...trashTrees]) { const list = byRoot.get(t.root); if (list) list.push(t); else byRoot.set(t.root, [t]); }
  const ownersOf = (rows: TreeRow[]) => [...new Set(rows.map((t) => t.owner_id))];
  const nested = new Set(trees.filter((t) => t.id !== t.root).map((t) => t.id));
  for (const cls of CLASSES) for (const r of rootsOf.get(cls) ?? []) {
    if (nested.has(r.id)) continue;
    const rows = byRoot.get(r.id) ?? [];
    const verdict = judge(r.loc, rows, { org, e: r.loc.kind === "org" ? eOrg : e, persons, spaces, moving });
    plan.roots.push({ id: r.id, cls, kind: r.loc.kind, space: r.loc.space, ids: rows.filter((t) => t.live).map((t) => t.id), owners: ownersOf(rows), verdict });
    if (verdict !== "remove" && verdict !== "wait" && r.loc.kind !== "org") plan.skippedHomes.add(r.loc.space);
  }
  for (const cls of CLASSES) for (const r of trashOf.get(cls) ?? []) {
    const rows = byRoot.get(r.id) ?? [];
    const verdict = judge(r.loc, rows, { org, e: eOrg, persons, spaces, moving });
    if (verdict === "remove") plan.trash.push({ id: r.id, cls, ids: rows.map((t) => t.id), owners: ownersOf(rows) });
    else plan.held.push({ id: r.id, cls, ids: rows.map((t) => t.id), verdict });
  }
  plan.roots.sort(byId);
  plan.trash.sort(byId);
  plan.held.sort(byId);
  plan.orphans.sort(byId);
  return plan;
}

function judge(loc: Loc, rows: TreeRow[], w: JudgeWorld): Root["verdict"] {
  const all = judgeAll(loc, rows, w);
  return TEST_LEFTOVERS_REASONS.find((r) => all.reasons.has(r)) ?? (all.wait ? "wait" : "remove");
}

export interface JudgeWorld { org: string | null; e: Set<string>; persons: Map<string, Person>; spaces: Map<string, SpaceInfo>; moving: Set<string> }

export function judgeAll(loc: Loc, rows: TreeRow[], w: JudgeWorld): { reasons: Set<Reason>; wait: boolean } {
  const found = new Set<Reason>();
  let wait = false;
  const isOrg = loc.kind === "org";
  const staff = (id: string) => { const p = w.persons.get(id); return !p || (!p.testDomain && !p.demo); };
  const pendingTest = (id: string) => { const p = w.persons.get(id); return !!p && p.testDomain && !p.demo && !w.e.has(id); };
  const staffReads = (id: string) => {
    const s = w.spaces.get(id);
    return !s || s.kind === "org" || s.showcase || s.staffMembers > 0 || s.staffOwner;
  };
  for (const t of rows) {
    if (!w.e.has(t.owner_id)) { if (pendingTest(t.owner_id)) wait = true; else found.add("foreign_owner"); }
    if (t.hidden || t.running || w.moving.has(t.id)) wait = true;
    if (!(isOrg && t.space_id === loc.space) && staffReads(t.space_id)) found.add("read_by_staff");
    for (const pl of t.placements) {
      if (pl.s !== loc.space && staffReads(pl.s)) found.add("read_by_staff");
      if (pl.b && !w.e.has(pl.b)) { if (staff(pl.b)) found.add("placed_by_staff"); else if (pendingTest(pl.b)) wait = true; }
    }
    for (const id of t.people) {
      if (w.e.has(id)) continue;
      if (staff(id)) found.add("staff_participants"); else if (pendingTest(id)) wait = true;
    }
    if (nonEmpty(t.pending)) found.add("pending_participants");
    if (nonEmpty(t.unresolved)) found.add("unresolved_participants");
  }
  return { reasons: found, wait };
}

interface SpaceRow { id: string; slug: string; name: string; kind: string; dep: boolean; unit_active: boolean; service: boolean;
                     staff_records: number; demo_records: number; other_records: number; live: number; staff_members: number; members: number }
type SpaceVerdict = { archive: true } | { kept: "staff_records" | "staff_members" | "skipped_records" | "service_space" } | { wait: "unit_active" | "test" };

async function spaceCandidates(q: Q, instanceId: string, e: Set<string>, removed: string[]): Promise<SpaceRow[]> {
  return (await q.query(
    `SELECT s.id, s.slug, s.name, s.kind, s.org_unit_id IS NOT NULL AS dep, COALESCE(u.active, false) AS unit_active,
            EXISTS (SELECT 1 FROM services v WHERE v.write_space_id = s.id AND v.active) AS service,
            (SELECT count(*) FROM record_locations l JOIN people q ON q.id = l.owner_id
              WHERE l.space_id = s.id AND (NOT l.deleted OR l.purge_after > now()) AND ${staffSql("q")})::int AS staff_records,
            (SELECT count(*) FROM record_locations l JOIN people q ON q.id = l.owner_id
              WHERE l.space_id = s.id AND (NOT l.deleted OR l.purge_after > now()) AND NOT ${notDemoSql("q")})::int AS demo_records,
            (SELECT count(*) FROM record_locations l
              WHERE l.space_id = s.id AND (NOT l.deleted OR l.purge_after > now()) AND NOT (l.owner_id = ANY($2::uuid[])))::int AS other_records,
            (SELECT count(*) FROM record_locations l WHERE l.space_id = s.id AND NOT l.deleted AND NOT (l.record_id = ANY($3::uuid[])))::int AS live,
            (SELECT count(*) FROM space_members_effective m JOIN people q ON q.id = m.person_id WHERE m.space_id = s.id AND ${staffSql("q")})::int AS staff_members,
            (SELECT count(*) FROM space_members_effective m WHERE m.space_id = s.id)::int AS members
     FROM spaces s LEFT JOIN org_units u ON u.id = s.org_unit_id
     WHERE s.instance_id = $1 AND s.archived_at IS NULL AND s.kind IN ('team', 'project') AND s.owner_id = ANY($2::uuid[]) AND NOT ${showcaseSql("s")}
     ORDER BY s.created_at, s.id`, [instanceId, [...e], removed])).rows;
}

function spaceVerdict(s: SpaceRow, skippedHomes: Set<string>): SpaceVerdict {
  if (s.staff_records) return { kept: "staff_records" };
  if (s.staff_members) return { kept: "staff_members" };
  if (skippedHomes.has(s.id) || s.demo_records) return { kept: "skipped_records" };
  if (s.service) return { kept: "service_space" };
  if (s.dep && s.unit_active) return { wait: "unit_active" };
  if (s.members || s.other_records || s.live) return { wait: "test" };
  return { archive: true };
}
const spaceKind = (s: { kind: string; dep: boolean }): Kind => (s.dep ? "dep" : s.kind as Kind);
const keptItem = (s: SpaceRow, reason: string) => ({ name: s.name, slug: s.slug, kind: s.kind, reason, staff_records: s.staff_records, staff_members: s.staff_members });

type ByKind = Partial<Record<Kind, number>>;
export interface LeftoversBatch {
  scope: LeftoversScope; grace_minutes: number; more: boolean;
  retired: number; trash_expired: number; archived: number; orphans: number; roots: number;
  by_kind: { retired: ByKind; trash_expired: ByKind; archived: ByKind };
  skipped: Record<Reason, number>;
  waiting: { records: number; spaces: number; unit_active: number };
  kept: { count: number; items: Array<ReturnType<typeof keptItem>> };
}
const bump = (m: ByKind, k: Kind, n = 1) => { if (n) m[k] = (m[k] ?? 0) + n; };

export async function testLeftovers(ctx: DbCtx): Promise<LeftoversBatch> {
  return leftoversBatch(ctx);
}

async function leftoversBatch(ctx: DbCtx, alive?: () => Promise<void>): Promise<LeftoversBatch> {
  const out: LeftoversBatch = { scope: "org", grace_minutes: 60, more: false, retired: 0, trash_expired: 0, archived: 0, orphans: 0, roots: 0,
    by_kind: { retired: {}, trash_expired: {}, archived: {} }, skipped: Object.fromEntries(TEST_LEFTOVERS_REASONS.map((r) => [r, 0])) as Record<Reason, number>,
    waiting: { records: 0, spaces: 0, unit_active: 0 }, kept: { count: 0, items: [] } };
  const snap = await ctx.db.control.connect();
  let plan: Plan | null = null;
  try {
    await snap.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const s = await leftoverSettings(snap, ctx.instanceId);
    out.scope = s.scope; out.grace_minutes = s.grace;
    if (s.scope !== "off") plan = await buildPlan(snap, (cls) => recordsDb(ctx, cls), ctx.instanceId, s.scope, s.grace);
    await commitOrThrow(snap);
  } catch (e) { await snap.query("ROLLBACK").catch(() => undefined); throw e; }
  finally { snap.release(); }
  if (!plan) return out;
  for (const v of verdicts(plan)) if (v === "wait") out.waiting.records++; else if (v !== "remove") out.skipped[v]++;

  for (const cls of CLASSES) {
    const db = recordsDb(ctx, cls);
    const ready = plan.roots.filter((r) => r.cls === cls && r.verdict === "remove");
    const due = plan.trash.filter((t) => t.cls === cls), lost = plan.orphans.filter((o) => o.cls === cls);
    if (ready.length > TEST_LEFTOVERS_BATCH || due.length > TEST_LEFTOVERS_BATCH || lost.length > TEST_LEFTOVERS_BATCH) out.more = true;
    const keep = async <T extends { kind: Kind; owners: string[] }>(xs: T[]): Promise<T[]> => {
      const ok = await stillEligible(ctx.db.control, plan, xs);
      out.waiting.records += xs.length - ok.length;
      return ok;
    };
    const roots = await keep(ready.slice(0, TEST_LEFTOVERS_BATCH));
    const trashPick = await keep(due.slice(0, TEST_LEFTOVERS_BATCH).map((t) => ({ ...t, kind: "org" as Kind })));
    const orphanPick = await keep(lost.slice(0, TEST_LEFTOVERS_BATCH).map((o) => ({ ...o, owners: [o.owner] })));
    if (roots.length) {
      for (const g of eventGroups(roots)) {
        await alive?.();
        await auditWorkerStrict(ctx, { event_type: "forget", class: cls, record_ids: g.ids, space_id: g.space, details: g.details });
      }
      const batch = await keep(roots);
      const org = batch.filter((r) => r.kind === "org").map((r) => r.id), other = batch.filter((r) => r.kind !== "org").map((r) => r.id);
      await alive?.();
      const marked = !batch.length ? [] : await tx(db, async (c) => {
        if (org.length) await c.query("SELECT mark_deleted(x, NULL, interval '0') FROM unnest($1::uuid[]) AS t(x)", [org]);
        if (other.length) await c.query(`SELECT mark_deleted(x, NULL, interval '${OUTSIDE_GRACE}') FROM unnest($1::uuid[]) AS t(x)`, [other]);
        await alive?.();
        return (await c.query("SELECT id, deleted_batch FROM records WHERE deleted_batch = ANY($1::uuid[]) AND deleted_at = now()", [[...org, ...other]])).rows;
      });
      await alive?.();
      await syncDeletionMarks(ctx.db.control, db, marked.map((m) => m.id as string));
      const kindOf = new Map(batch.map((r) => [r.id, r.kind]));
      for (const m of marked) bump(out.by_kind.retired, kindOf.get(m.deleted_batch) ?? "personal");
      out.retired += marked.length; out.roots += batch.length;
    }
    if (trashPick.length) {
      await alive?.();
      await auditWorkerStrict(ctx, { event_type: "forget", class: cls, record_ids: trashPick.map((t) => t.id), space_id: plan.org, details: { reason: REASON, action: "trash_expired", affected: trashPick.length } });
      const trash = (await keep(trashPick)).map((t) => t.id);
      await alive?.();
      const done = !trash.length ? [] : (await db.query("UPDATE records SET purge_after = now() WHERE id = ANY($1::uuid[]) AND deleted_at IS NOT NULL AND purge_after > now() RETURNING id", [trash])).rows.map((r) => r.id as string);
      if (done.length) {
        await alive?.();
        await syncDeletionMarks(ctx.db.control, db, done);
      }
      bump(out.by_kind.trash_expired, "org", done.length); out.trash_expired += done.length;
    }
    if (orphanPick.length) {
      await alive?.();
      await auditWorkerStrict(ctx, { event_type: "purge", class: cls, record_ids: orphanPick.map((o) => o.id), details: { reason: REASON, orphan_locators: orphanPick.length } });
      const orphans = (await keep(orphanPick)).map((o) => o.id);
      if (orphans.length) {
        await alive?.();
        await dropDerivedLinks(ctx, orphans);
        await alive?.();
        out.orphans += (await deleteLocators(ctx.db.control, orphans, { notMoving: true })).deleted.length;
      }
    }
  }
  if (plan.scope === "all" && !out.more) await archiveSpaces(ctx, plan, out, alive);
  if (out.retired || out.trash_expired || out.archived || out.orphans)
    log.info("test_leftovers_retired", { scope: out.scope, retired: out.retired, trash_expired: out.trash_expired, roots: out.roots, orphans: out.orphans, archived: out.archived });
  return out;
}

const verdicts = (plan: Plan): Array<Root["verdict"]> => [...plan.roots.map((r) => r.verdict), ...plan.held.map((h) => h.verdict)];

async function stillEligible<T extends { kind: Kind; owners: string[] }>(q: Q, plan: Plan, xs: T[]): Promise<T[]> {
  if (!xs.length) return xs;
  const rows = (await q.query(
    `SELECT p.id, ${orgLeftoverSql("p", plan.scope)} AS org, ${leftoverPersonSql("p")} AND ${AGED} AS e FROM people p ${PERSONAL} WHERE p.id = ANY($1::uuid[])`,
    [[...new Set(xs.flatMap((x) => x.owners))], plan.grace])).rows;
  const org = new Set(rows.filter((r) => r.org).map((r) => r.id as string)), e = new Set(rows.filter((r) => r.e).map((r) => r.id as string));
  return xs.filter((x) => x.owners.every((id) => (x.kind === "org" ? org : e).has(id)));
}

function eventGroups(batch: Root[]): Array<{ ids: string[]; space: string | null; details: Record<string, unknown> }> {
  const org = batch.filter((r) => r.kind === "org"), personal = batch.filter((r) => r.kind === "personal");
  const out: Array<{ ids: string[]; space: string | null; details: Record<string, unknown> }> = [];
  if (org.length) { const ids = org.flatMap((r) => r.ids); out.push({ ids, space: org[0]!.space, details: { reason: REASON, affected: ids.length } }); }
  if (personal.length) {
    const ids = personal.flatMap((r) => r.ids);
    out.push({ ids, space: null, details: { reason: REASON, kind: "personal", spaces: new Set(personal.map((r) => r.space)).size, affected: ids.length } });
  }
  const bySpace = new Map<string, Root[]>();
  for (const r of batch.filter((x) => x.kind !== "org" && x.kind !== "personal")) { const list = bySpace.get(r.space); if (list) list.push(r); else bySpace.set(r.space, [r]); }
  for (const [space, rs] of bySpace) { const ids = rs.flatMap((r) => r.ids); out.push({ ids, space, details: { reason: REASON, kind: rs[0]!.kind, affected: ids.length } }); }
  return out;
}

async function archiveSpaces(ctx: DbCtx, plan: Plan, out: LeftoversBatch, alive?: () => Promise<void>): Promise<void> {
  const rows = await spaceCandidates(ctx.db.control, ctx.instanceId, plan.e, []);
  const ready: SpaceRow[] = [];
  for (const s of rows) {
    const v = spaceVerdict(s, plan.skippedHomes);
    if ("archive" in v) ready.push(s);
    else if ("kept" in v) { out.kept.count++; if (out.kept.items.length < KEPT_ITEMS) out.kept.items.push(keptItem(s, v.kept)); }
    else { out.waiting.spaces++; if (v.wait === "unit_active") out.waiting.unit_active++; }
  }
  if (ready.length > TEST_LEFTOVERS_BATCH) out.more = true;
  const ids = ready.slice(0, TEST_LEFTOVERS_BATCH).map((s) => s.id);
  if (!ids.length) return;
  const done = await tx(ctx.db.control, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext('reconcile:' || $1))", [ctx.instanceId]);
    const ready = (await c.query(
      `SELECT s.id, s.slug, s.kind, s.org_unit_id IS NOT NULL AS dep FROM spaces s WHERE s.id = ANY($1::uuid[]) AND s.archived_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM record_locations l WHERE l.space_id = s.id AND NOT l.deleted)
         AND NOT EXISTS (SELECT 1 FROM space_members_effective m WHERE m.space_id = s.id)
         AND EXISTS (SELECT 1 FROM people o WHERE o.id = s.owner_id AND NOT o.active)
       ORDER BY s.id FOR UPDATE OF s`, [ids])).rows;
    if (!ready.length) return [];
    await alive?.();
    await auditWorkerStrictMany(ctx, ready.map((s) => ({ event_type: "admin" as const, space_id: s.id, details: { op: "space_archive", space: s.id, slug: s.slug, kind: spaceKind(s), reason: REASON } })));
    await alive?.();
    await c.query("UPDATE spaces SET archived_at = now() WHERE id = ANY($1::uuid[]) AND archived_at IS NULL", [ready.map((s) => s.id)]);
    return ready;
  });
  for (const s of done) bump(out.by_kind.archived, spaceKind(s));
  out.archived += done.length;
}

async function reportStats(q: Q, instanceId: string, grace: number) {
  const p = (await q.query(
    `SELECT count(*) FILTER (WHERE p.active AND ${testDomainSql("p")} AND ${notDemoSql("p")})::int AS active_test,
            count(*) FILTER (WHERE p.active AND ${testDomainSql("p")} AND ${notDemoSql("p")} AND p.updated_at < now() - interval '24 hours')::int AS active_test_24h,
            count(*) FILTER (WHERE p.attrs->>'test' = 'true' AND NOT ${testDomainSql("p")})::int AS attr_test_other_domain,
            count(*) FILTER (WHERE ${leftoverPersonSql("p")} AND NOT ${AGED})::int AS waiting_people
     FROM people p ${PERSONAL} WHERE p.instance_id = $1`, [instanceId, grace])).rows[0];
  const w = (await q.query(
    `SELECT count(*)::int AS n FROM spaces s JOIN people p ON p.id = s.owner_id ${PERSONAL}
     WHERE s.instance_id = $1 AND s.archived_at IS NULL AND s.kind IN ('team', 'project') AND ${leftoverPersonSql("p")} AND NOT ${AGED} AND NOT ${showcaseSql("s")}`,
    [instanceId, grace])).rows[0].n as number;
  const outside = await outsideTheirSpaces(q, instanceId, grace);
  const marked = (await q.query(
    `SELECT p.login FROM people p WHERE p.instance_id = $1 AND p.attrs->>'test' = 'true' AND NOT ${testDomainSql("p")} ORDER BY p.active DESC, p.login LIMIT ${KEPT_ITEMS}`,
    [instanceId])).rows.map((r) => r.login as string);
  return { ...p, waiting_spaces: w, outside: outside.reduce((a, x) => a + x.records, 0), outside_items: outside, marked };
}

async function outsideTheirSpaces(q: Q, instanceId: string, grace: number): Promise<Array<{ slug: string; name: string; kind: string; records: number }>> {
  return (await q.query(
    `SELECT s.slug, s.name, s.kind, count(*)::int AS records
     FROM record_locations l JOIN spaces s ON s.id = l.space_id JOIN people p ON p.id = l.owner_id ${PERSONAL}
     WHERE s.instance_id = $1 AND NOT l.deleted AND ${leftoverPersonSql("p")} AND ${AGED} AND s.kind <> 'org' AND NOT ${showcaseSql("s")}
       AND NOT (s.kind IN ('personal', 'team', 'project') AND EXISTS (SELECT 1 FROM people o WHERE o.id = s.owner_id AND ${leftoverPersonSql("o")}))
     GROUP BY s.id ORDER BY count(*) DESC, s.slug`, [instanceId, grace])).rows;
}

const nonZero = (m: ByKind): ByKind => Object.fromEntries(Object.entries(m).filter(([, n]) => n)) as ByKind;
const total = (m: ByKind) => Object.values(m).reduce<number>((a, n) => a + (n ?? 0), 0);

export async function testLeftoversPass(ctx: DbCtx): Promise<Record<string, unknown>> {
  try {
    const lock = await ctx.db.control.connect();
    let clean = false;
    try {
      const ok = (await lock.query("SELECT pg_try_advisory_lock(hashtext('test_leftovers:' || $1)) AS ok", [ctx.instanceId])).rows[0]?.ok === true;
      if (!ok) { clean = true; log.info("test_leftovers_busy", { instance: ctx.instanceId }); return { busy: true }; }
      const watch = watchLock(lock);
      try { return await passUnderLock(ctx, watch.alive); }
      finally {
        try {
          if (!watch.lost()) await lock.query("SELECT pg_advisory_unlock(hashtext('test_leftovers:' || $1))", [ctx.instanceId]).then(() => { clean = true; }, () => undefined);
          if (watch.lost()) {
            clean = false;
            log.warn("lock_connection_lost", { job: "test_leftovers" });
          }
        } finally { watch.done(); }
      }
    } finally { lock.release(!clean); }
  } catch (e) {
    if (!(e instanceof LockConnectionLost)) log.warn("test_leftovers_failed", { error: String((e as Error)?.message ?? e).slice(0, 200) });
    throw e;
  }
}

async function passUnderLock(ctx: DbCtx, alive: () => Promise<void>): Promise<Record<string, unknown>> {
  const at = new Date().toISOString();
  const sum = { retired: {} as ByKind, trash_expired: {} as ByKind, archived: {} as ByKind, orphans: 0 };
  let last: LeftoversBatch | null = null, failure: unknown = null;
  try {
    for (let i = 0; i < TEST_LEFTOVERS_PASSES; i++) {
      last = await leftoversBatch(ctx, alive);
      for (const k of ["retired", "trash_expired", "archived"] as const) for (const [kind, n] of Object.entries(last.by_kind[k])) bump(sum[k], kind as Kind, n);
      sum.orphans += last.orphans;
      if (!last.more) break;
    }
  } catch (e) {
    if (e instanceof LockConnectionLost) throw e;
    failure = e;
  }
  const s = last ? { scope: last.scope, grace: last.grace_minutes } : await leftoverSettings(ctx.db.control, ctx.instanceId).catch(() => ({ scope: "org" as LeftoversScope, grace: 60 }));
  let state: Record<string, unknown> = { at, scope: s.scope, grace_minutes: s.grace, more: failure ? true : last?.more ?? false };
  try {
    const prev = (await ctx.db.control.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = 'test_leftovers'", [ctx.instanceId])).rows[0]?.value?.total;
    const st = await reportStats(ctx.db.control, ctx.instanceId, s.grace);
    state = {
      ...state,
      pass: { retired: nonZero(sum.retired), trash_expired: nonZero(sum.trash_expired), archived: nonZero(sum.archived), orphans: sum.orphans },
      total: { since: typeof prev?.since === "string" ? prev.since : at, retired: (Number(prev?.retired) || 0) + total(sum.retired), archived: (Number(prev?.archived) || 0) + total(sum.archived) },
      waiting: { people: st.waiting_people, records: last?.waiting.records ?? 0, spaces: (last?.waiting.spaces ?? 0) + st.waiting_spaces, unit_active: last?.waiting.unit_active ?? 0 },
      skipped: last?.skipped ?? Object.fromEntries(TEST_LEFTOVERS_REASONS.map((r) => [r, 0])),
      kept: last?.kept ?? { count: 0, items: [] },
      outside_their_spaces: st.outside,
      attr_test_other_domain: st.attr_test_other_domain,
      attr_test_other_domain_logins: st.marked,
      active_test: { count: st.active_test, older_than_24h: st.active_test_24h },
      ...(failure ? { error: String((failure as Error)?.message ?? failure).slice(0, 200) } : {}),
    };
    await alive();
    await ctx.db.control.query(
      `INSERT INTO maintenance_state (instance_id, key, value, updated_at) VALUES ($1, 'test_leftovers', $2, now())
       ON CONFLICT (instance_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [ctx.instanceId, JSON.stringify(state)]);
  } catch (e) {
    if (e instanceof LockConnectionLost || !failure) throw e;
    log.warn("test_leftovers_state_failed", { error: String((e as Error)?.message ?? e).slice(0, 200) });
  }
  if (failure) throw failure;
  if (total(sum.retired) || total(sum.trash_expired) || total(sum.archived) || sum.orphans)
    log.info("test_leftovers_pass", { scope: s.scope, retired: total(sum.retired), trash_expired: total(sum.trash_expired), archived: total(sum.archived), orphans: sum.orphans, more: state.more });
  return state;
}

interface PreviewArgs { ids?: string; check?: string }
function previewArgs(args: string[]): PreviewArgs {
  const out: PreviewArgs = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!, v = args[i + 1];
    if ((a === "--ids" || a === "--check") && v && !v.startsWith("--")) { out[a === "--ids" ? "ids" : "check"] = v; i++; continue; }
    throw new Error(`test_leftovers_preview: unknown argument “${a}”. Use --ids <file> or --check <file>`);
  }
  if (out.ids && out.check) throw new Error("test_leftovers_preview: run --ids and --check separately");
  return out;
}

export async function testLeftoversPreview(ctx: DbCtx, args: string[] = []): Promise<Record<string, unknown>> {
  const opts = previewArgs(args);
  const opened: Array<import("pg").PoolClient> = [];
  const open = async (pool: import("pg").Pool): Promise<Q> => {
    const c = await pool.connect();
    opened.push(c);
    await c.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    return c;
  };
  try {
    const control = await open(ctx.db.control), audit = await open(ctx.db.auditRead());
    const rec: Record<DataClass, Q> = { open: await open(recordsDb(ctx, "open")), closed: await open(recordsDb(ctx, "closed")) };
    return opts.check ? await checkPlan(ctx.instanceId, control, audit, opts.check) : await preview(ctx.instanceId, control, (cls) => rec[cls], audit, opts.ids);
  } finally {
    for (const c of opened) { await c.query("ROLLBACK").catch(() => undefined); c.release(); }
  }
}

const domain = (login: string) => (login.split("@")[1] ?? "").toLowerCase();
const testDomainJs = isTestDomainLogin;
const logins = (xs: Array<{ login: string }>) => ({ count: xs.length, logins: xs.slice(0, LIST).map((x) => x.login) });

async function preview(instanceId: string, control: Q, records: Records, audit: Q, idsFile?: string): Promise<Record<string, unknown>> {
  const at = new Date((await control.query("SELECT now() AS at")).rows[0].at).toISOString();
  const s = await leftoverSettings(control, instanceId);
  const plan = await buildPlan(control, records, instanceId, "all", s.grace);
  const current = s.scope === "all" ? plan : s.scope === "org" ? await buildPlan(control, records, instanceId, "org", s.grace) : null;

  const ppl = (await control.query(
    `SELECT p.id, p.login, p.active, NOT ${notDemoSql("p")} AS demo, p.attrs->>'test' = 'true' AS marked, ${testDomainSql("p")} AS test_domain,
            ${leftoverPersonSql("p")} AS leftover, ${AGED} AS aged, p.updated_at < now() - interval '24 hours' AS day_old
     FROM people p ${PERSONAL}
     WHERE p.instance_id = $1 AND (p.active OR ${leftoverPersonSql("p")} OR NOT ${notDemoSql("p")} OR p.attrs->>'test' = 'true')
     ORDER BY p.login`, [instanceId, s.grace])).rows;
  const leftover = ppl.filter((p) => p.leftover), ready = leftover.filter((p) => p.aged);
  const activeTest = ppl.filter((p) => p.active && p.test_domain && !p.demo);
  const staffActive = ppl.filter((p) => p.active && !p.test_domain && !p.demo);
  const demo = ppl.filter((p) => p.demo), personas = new Set<string>(DEMO_LOGINS);
  const demoOthers = demo.filter((p) => !personas.has(p.login.toLowerCase())).sort((a, b) => Number(b.active) - Number(a.active));
  const people = {
    leftover: leftover.length, ready: ready.length, waiting_grace: leftover.length - ready.length,
    by_marker: { attr_test: leftover.filter((p) => p.marked).length, example_corp: leftover.filter((p) => domain(p.login) === "corp.test").length,
                 dot_test: leftover.filter((p) => domain(p.login) !== "corp.test").length },
    dot_test_logins: logins(leftover.filter((p) => domain(p.login) !== "corp.test")),
    attr_test_other_domain: logins(ppl.filter((p) => p.marked && !p.test_domain)),
    demo: {
      count: demo.length, active: demo.filter((p) => p.active).length,
      showcase_personas: DEMO_LOGINS.map((l) => { const p = demo.find((x) => x.login.toLowerCase() === l); return { login: l, exists: !!p, active: !!p?.active }; }),
      others: { count: demoOthers.length, active: demoOthers.filter((p) => p.active).length, items: demoOthers.slice(0, LIST).map((p) => ({ login: p.login, active: p.active })) },
    },
    active_test: { ...logins(activeTest), older_than_24h: activeTest.filter((p) => p.day_old).length },
    staff_active: logins(staffActive),
  };

  const remove = plan.roots.filter((r) => r.verdict === "remove");
  const retireIds = remove.flatMap((r) => r.ids), trashIds = plan.trash.flatMap((t) => t.ids), orphanIds = plan.orphans.map((o) => o.id);
  const byClass = <T extends { cls: DataClass }>(xs: T[], n: (x: T) => number = () => 1) => ({ open: xs.filter((x) => x.cls === "open").reduce((a, x) => a + n(x), 0), closed: xs.filter((x) => x.cls === "closed").reduce((a, x) => a + n(x), 0) });
  const retire: Record<string, { open: number; closed: number }> = {};
  for (const k of ["org", "personal", "team", "project", "dep"] as Kind[]) retire[k] = byClass(remove.filter((r) => r.kind === k), (r) => r.ids.length);
  const skipped = Object.fromEntries(TEST_LEFTOVERS_REASONS.map((x) => [x, verdicts(plan).filter((v) => v === x).length]));
  const outside = await outsideTheirSpaces(control, instanceId, s.grace);
  const originals = { count: 0, bytes: 0 };
  for (const cls of CLASSES) {
    const ids = [...remove.filter((r) => r.cls === cls).flatMap((r) => r.ids), ...plan.trash.filter((t) => t.cls === cls).flatMap((t) => t.ids)];
    if (!ids.length) continue;
    const o = (await records(cls).query(
      "SELECT count(*) FILTER (WHERE original_key IS NOT NULL)::int AS n, COALESCE(sum(original_bytes) FILTER (WHERE original_key IS NOT NULL), 0)::bigint AS bytes FROM record_content WHERE record_id = ANY($1::uuid[])", [ids])).rows[0];
    originals.count += o.n; originals.bytes += Number(o.bytes);
  }
  const planIds = [...retireIds, ...trashIds, ...orphanIds];
  const links = planIds.length ? (await control.query(
    `SELECT count(*)::int AS n FROM record_links WHERE (src_id = ANY($1::uuid[]) AND NOT (dst_id = ANY($1::uuid[]))) OR (dst_id = ANY($1::uuid[]) AND NOT (src_id = ANY($1::uuid[])))`,
    [planIds])).rows[0].n as number : 0;
  const recordsOut = {
    retire, trash_expire: byClass(plan.trash), orphan_locators: byClass(plan.orphans),
    skipped, busy: verdicts(plan).filter((v) => v === "wait").length,
    outside_their_spaces: { count: outside.reduce((a, x) => a + x.records, 0), spaces: outside.length, items: outside.slice(0, LIST) },
    originals, links_broken: links,
  };

  const cands = await spaceCandidates(control, instanceId, plan.e, [...retireIds, ...orphanIds]);
  const archive: SpaceRow[] = [], kept: Array<ReturnType<typeof keptItem>> = [], service: SpaceRow[] = [];
  let waiting = 0, unitActive = 0;
  for (const sp of cands) {
    const v = spaceVerdict(sp, plan.skippedHomes);
    if ("archive" in v) archive.push(sp);
    else if ("kept" in v) { kept.push(keptItem(sp, v.kept)); if (v.kept === "service_space") service.push(sp); }
    else { waiting++; if (v.wait === "unit_active") unitActive++; }
  }
  const archiveBy: ByKind = {};
  for (const sp of archive) bump(archiveBy, spaceKind(sp));
  const st = await reportStats(control, instanceId, s.grace);
  const frozen = (await control.query(
    `SELECT count(*) FILTER (WHERE ps.archived_at IS NULL)::int AS not_frozen FROM people p JOIN spaces ps ON ps.kind = 'personal' AND ps.owner_id = p.id
     WHERE p.instance_id = $1 AND ${leftoverPersonSql("p")}`, [instanceId])).rows[0].not_frozen as number;
  const already: ByKind = {};
  for (const r of (await control.query(
    `SELECT ${KIND_SQL} AS kind, count(*)::int AS n FROM spaces s JOIN people p ON p.id = s.owner_id
     WHERE s.instance_id = $1 AND s.archived_at IS NOT NULL AND ${leftoverPersonSql("p")} GROUP BY 1`, [instanceId])).rows) bump(already, r.kind, r.n);
  const show = (await control.query(
    `SELECT s.slug, ${KIND_SQL} AS kind, s.archived_at IS NOT NULL AS archived,
            (s.slug = 'demo-showcase' OR EXISTS (SELECT 1 FROM org_units su WHERE su.id = s.org_unit_id AND su.code = 'demo')
             OR EXISTS (SELECT 1 FROM people so WHERE so.id = s.owner_id AND lower(so.login) = ANY($2::text[]))) AS roles,
            (SELECT count(*) FROM record_locations l WHERE l.space_id = s.id AND NOT l.deleted)::int AS records
     FROM spaces s WHERE s.instance_id = $1 AND ${showcaseSql("s")} ORDER BY s.archived_at IS NOT NULL, s.slug`, [instanceId, [...DEMO_LOGINS]])).rows;
  const showOther = show.filter((x) => !x.roles), showOtherBy: ByKind = {};
  for (const x of showOther) if (!x.archived) bump(showOtherBy, x.kind);
  const item = (x: { slug: string; kind: string; archived: boolean; records: number }) => ({ slug: x.slug, kind: x.kind, archived: x.archived, records: x.records });
  const showcase = {
    count: show.length,
    roles: show.filter((x) => x.roles).slice(0, LIST).map(item),
    others: { count: showOther.length, active: showOther.filter((x) => !x.archived).length, active_by_kind: showOtherBy,
              records: showOther.reduce((a, x) => a + x.records, 0), items: showOther.slice(0, LIST).map(item) },
  };
  const spacesOut = {
    archive: archiveBy, kept: { count: kept.length, items: kept.slice(0, LIST) }, waiting: { count: waiting + st.waiting_spaces, unit_active: unitActive },
    service_spaces: { count: service.length, items: service.slice(0, LIST).map((x) => ({ slug: x.slug, name: x.name })) },
    personal_not_frozen: frozen, already_archived: already, showcase,
  };

  let events = archive.length;
  for (const cls of CLASSES) {
    for (const part of chunks(remove.filter((r) => r.cls === cls), TEST_LEFTOVERS_BATCH)) events += eventGroups(part).length;
    events += chunks(plan.trash.filter((t) => t.cls === cls), TEST_LEFTOVERS_BATCH).length + chunks(plan.orphans.filter((o) => o.cls === cls), TEST_LEFTOVERS_BATCH).length;
  }
  const active = (await control.query(
    `SELECT (SELECT count(*) FROM spaces WHERE instance_id = $1 AND archived_at IS NULL)::int AS spaces, (SELECT count(*) FROM people WHERE instance_id = $1 AND active)::int AS people`,
    [instanceId])).rows[0];
  const baseline = (await control.query(
    `SELECT l.record_id FROM record_locations l JOIN spaces s ON s.id = l.space_id WHERE s.instance_id = $1 AND NOT l.deleted AND NOT (l.record_id = ANY($2::uuid[]))`,
    [instanceId, planIds])).rows.map((r) => r.record_id as string);
  const { proof, orgSeenByStaff } = await proofOf(instanceId, control, records, audit, plan, archive.map((x) => x.id));
  const later = {
    people: leftover.filter((p) => !p.aged).map((p) => p.id as string),
    records: [...plan.roots.filter((r) => r.verdict === "wait").flatMap((r) => r.ids), ...plan.held.filter((h) => h.verdict === "wait").flatMap((h) => h.ids)],
  };

  if (idsFile) {
    const fd = openSync(idsFile, "w", 0o600);
    try { fchmodSync(fd, 0o600); writeSync(fd, JSON.stringify({ at, records: planIds, spaces: archive.map((x) => x.id), baseline, later })); }
    finally { closeSync(fd); }
  }
  const currentOut = !current ? { scope: s.scope, retire: 0, trash_expire: 0, archive: 0 }
    : { scope: s.scope, retire: current.roots.filter((r) => r.verdict === "remove").reduce((a, r) => a + r.ids.length, 0), trash_expire: current.trash.length,
        archive: current === plan ? archive.length : 0 };
  return {
    job: "test_leftovers_preview", at, scope_setting: s.scope, grace_minutes: s.grace, plan_scope: "all", current: currentOut,
    people, records: recordsOut, spaces: spacesOut, events_expected: events,
    expected_after: { spaces_active: active.spaces - archive.length, people_active: active.people },
    proof, guard_pre: skipped, baseline: { live_locators_other: baseline.length },
    org_seen_by_staff: orgSeenByStaff,
    ...(idsFile ? { ids: {
      file: idsFile, records: planIds.length, spaces: archive.length, baseline: baseline.length, later_people: later.people.length, later_records: later.records.length,
      ...(later.people.length || later.records.length ? { warning: "the plan was taken before everything was ready: people are in the waiting period or records are marked “until the next pass” — the next pass will handle them; the exact plan comes after the waiting period with the worker stopped" } : {}),
    } } : {}),
  };
}

async function proofOf(instanceId: string, control: Q, records: Records, audit: Q, plan: Plan, archiveIds: string[]) {
  const ids = { open: [] as string[], closed: [] as string[] };
  for (const r of plan.roots) if (r.verdict === "remove") ids[r.cls].push(...r.ids);
  for (const t of plan.trash) ids[t.cls].push(...t.ids);
  const rows: Array<{ id: string; owner_id: string; space_id: string; ingested_at?: Date | string }> = [], people: Array<{ record_id: string; person_id: string }> = [], placed: Array<{ record_id: string; space_id: string }> = [];
  for (const cls of CLASSES) if (ids[cls].length) {
    const db = records(cls);
    rows.push(...(await db.query("SELECT id, owner_id, space_id, ingested_at FROM records WHERE id = ANY($1::uuid[])", [ids[cls]])).rows);
    people.push(...(await db.query("SELECT record_id, person_id FROM record_people WHERE record_id = ANY($1::uuid[])", [ids[cls]])).rows);
    placed.push(...(await db.query("SELECT record_id, space_id FROM record_placements WHERE record_id = ANY($1::uuid[])", [ids[cls]])).rows);
  }
  for (const o of plan.orphans) rows.push({ id: o.id, owner_id: o.owner, space_id: o.space });
  const everyone = new Map<string, { login: string; active: boolean; demo: boolean }>((await control.query(
    "SELECT id, login, active, attrs->>'demo' = 'true' OR lower(login) = ANY($2::text[]) AS demo FROM people WHERE instance_id = $1", [instanceId, [...DEMO_LOGINS]])).rows.map((p) => [p.id as string, p]));
  const isStaff = (id: string) => { const p = everyone.get(id); return !p || (!p.demo && !testDomainJs(p.login)); };
  const activeStaff = (id: string) => { const p = everyone.get(id); return !!p && p.active && !p.demo && !testDomainJs(p.login); };
  const spaceIds = [...new Set([...rows.map((r) => r.space_id), ...placed.map((p) => p.space_id), ...archiveIds])];
  const spaces = new Map<string, { kind: string; owner_id: string | null }>((spaceIds.length ? (await control.query(
    "SELECT id, kind, owner_id FROM spaces WHERE id = ANY($1::uuid[])", [spaceIds])).rows : []).map((x) => [x.id as string, x]));
  const group = <T>(xs: T[], key: (x: T) => string, val: (x: T) => string) => {
    const out = new Map<string, string[]>();
    for (const x of xs) { const list = out.get(key(x)); if (list) list.push(val(x)); else out.set(key(x), [val(x)]); }
    return out;
  };
  const members = group(spaceIds.length ? (await control.query("SELECT space_id, person_id FROM space_members_effective WHERE space_id = ANY($1::uuid[])", [spaceIds])).rows : [],
                        (m) => m.space_id as string, (m) => m.person_id as string);
  const placedIn = group(placed, (p) => p.record_id, (p) => p.space_id), peopleOf = group(people, (p) => p.record_id, (p) => p.person_id);
  const readByStaff = (spaceId: string) => {
    const sp = spaces.get(spaceId);
    return !sp || sp.kind === "org" || (!!sp.owner_id && activeStaff(sp.owner_id)) || (members.get(spaceId) ?? []).some(activeStaff);
  };
  const locs = new Map<string, string>(rows.length ? (await control.query(
    "SELECT record_id, owner_id FROM record_locations WHERE record_id = ANY($1::uuid[])", [rows.map((r) => r.id)])).rows.map((l) => [l.record_id as string, l.owner_id as string]) : []);
  const byDomain = { org: {} as Record<string, number>, outside: {} as Record<string, number> };
  let nonTest = 0, mismatch = 0, readers = 0, staffRecords = 0;
  for (const r of rows) {
    const inOrg = spaces.get(r.space_id)?.kind === "org", p = everyone.get(r.owner_id);
    const d = p ? domain(p.login) || "(no domain)" : "(no person)";
    const bucket = inOrg ? byDomain.org : byDomain.outside;
    bucket[d] = (bucket[d] ?? 0) + 1;
    if (!p || p.active || p.demo || (!inOrg && !testDomainJs(p.login))) nonTest++;
    if (locs.get(r.id) !== r.owner_id) mismatch++;
    if (activeStaff(r.owner_id)) staffRecords++;
    if (!inOrg && (readByStaff(r.space_id) || (placedIn.get(r.id) ?? []).some(readByStaff) || (peopleOf.get(r.id) ?? []).some(activeStaff))) readers++;
  }
  const staff = new Set([...everyone.keys()].filter(isStaff));
  const planIds = rows.map((r) => r.id), rowOf = new Map(rows.map((r) => [r.id, r]));
  const touches = planIds.length && staff.size ? (await audit.query(
    `SELECT DISTINCT x AS id, e.principal_id, e.on_behalf_of FROM audit_events e CROSS JOIN LATERAL unnest(e.record_ids) AS x
     WHERE e.instance_id = $1 AND e.record_ids && $2::uuid[] AND x = ANY($2::uuid[]) AND (e.principal_id = ANY($3::uuid[]) OR e.on_behalf_of = ANY($3::uuid[]))`,
    [instanceId, planIds, [...staff]])).rows : [];
  const touched = new Set<string>(), orgSeen = new Set<string>();
  for (const t of touches) {
    const r = rowOf.get(t.id);
    if (!r || ![t.principal_id, t.on_behalf_of].some((id) => !!id && staff.has(id) && id !== r.owner_id)) continue;
    (spaces.get(r.space_id)?.kind === "org" ? orgSeen : touched).add(r.id);
  }
  // audit archive: before the newest dropped month the journal is not complete — a record ingested then may have been
  // touched by staff without a trace in the base, so it counts as touched. An orphan locator has no record row (no ingestion
  // time) and no content to protect; it is judged by the journal alone, as before.
  const archived = planIds.length ? await auditArchivedBefore(audit) : null;
  if (archived) for (const r of rows) {
    if (r.ingested_at === undefined || new Date(r.ingested_at).getTime() >= archived.getTime()) continue;
    (spaces.get(r.space_id)?.kind === "org" ? orgSeen : touched).add(r.id);
  }
  const spacesTouched = archiveIds.filter((id) => { const sp = spaces.get(id); return (!!sp?.owner_id && activeStaff(sp.owner_id)) || (members.get(id) ?? []).some(activeStaff); }).length;
  const shown = new Set<string>(spaceIds.length ? (await control.query(
    `SELECT s.id FROM spaces s LEFT JOIN org_units u ON u.id = s.org_unit_id LEFT JOIN people o ON o.id = s.owner_id
     WHERE s.id = ANY($1::uuid[]) AND (s.slug LIKE 'demo-%' OR u.code = 'demo' OR o.attrs->>'demo' = 'true' OR lower(o.login) = ANY($2::text[]))`,
    [spaceIds, [...DEMO_LOGINS]])).rows.map((x) => x.id as string) : []);
  const showcaseTouched = archiveIds.filter((id) => shown.has(id)).length
    + rows.filter((r) => shown.has(r.space_id) || (placedIn.get(r.id) ?? []).some((sp) => shown.has(sp)) || !!everyone.get(r.owner_id)?.demo).length;
  return {
    proof: { owners_by_domain: byDomain, non_test_owner: nonTest, locator_owner_mismatch: mismatch, staff_readers: readers, audit_staff_touch: touched.size,
             staff_active: { records_touched: staffRecords, spaces_touched: spacesTouched }, showcase_touched: showcaseTouched },
    orgSeenByStaff: orgSeen.size,
  };
}

async function checkPlan(instanceId: string, control: Q, audit: Q, file: string): Promise<Record<string, unknown>> {
  const plan = JSON.parse(readFileSync(file, "utf8")) as { at?: string; records?: string[]; spaces?: string[]; baseline?: string[]; later?: { people?: string[]; records?: string[] } };
  if (typeof plan.at !== "string" || !Array.isArray(plan.records) || !Array.isArray(plan.spaces) || !Array.isArray(plan.baseline))
    throw new Error("test_leftovers_preview --check: file is not a preview plan (requires at, records, spaces, baseline)");
  const recs = new Set(plan.records), spaces = new Set(plan.spaces);
  const laterPeople = new Set(plan.later?.people ?? []), laterRecords = new Set(plan.later?.records ?? []);
  const ev = (await audit.query(
    `SELECT event_type, record_ids, details FROM audit_events WHERE instance_id = $1 AND at > $2::timestamptz AND (details->>'reason' = $3 OR event_type IN ('forget', 'purge'))`,
    [instanceId, plan.at, REASON])).rows;
  const outside = new Set<string>(), archived = new Set<string>(), archivedOut = new Set<string>(), ours = new Set<string>(), others = new Set<string>();
  let events = 0;
  for (const e of ev) {
    if (e.details?.reason !== REASON) { for (const id of e.record_ids ?? []) others.add(id); continue; }
    events++;
    if (e.event_type === "admin" && e.details?.op === "space_archive") { const sp = String(e.details.space); archived.add(sp); if (!spaces.has(sp)) archivedOut.add(sp); continue; }
    for (const id of e.record_ids ?? []) { ours.add(id); if (!recs.has(id)) outside.add(id); }
  }
  const lost = plan.baseline.length ? (await control.query(
    "SELECT b.id FROM unnest($1::uuid[]) AS b(id) LEFT JOIN record_locations l ON l.record_id = b.id WHERE l.record_id IS NULL OR l.deleted", [plan.baseline])).rows.map((r) => r.id as string) : [];
  const recIds = [...new Set([...outside, ...lost])];
  const ownerOf = new Map<string, string>(recIds.length ? (await control.query(
    "SELECT record_id, owner_id FROM record_locations WHERE record_id = ANY($1::uuid[])", [recIds])).rows.map((r) => [r.record_id as string, r.owner_id as string]) : []);
  const spaceOwner = new Map<string, string>(archivedOut.size ? (await control.query(
    "SELECT id, owner_id FROM spaces WHERE id = ANY($1::uuid[])", [[...archivedOut]])).rows.map((r) => [r.id as string, r.owner_id as string]) : []);
  const notApplied = archived.size ? (await control.query(
    "SELECT count(*)::int AS n FROM spaces WHERE id = ANY($1::uuid[]) AND archived_at IS NULL", [[...archived]])).rows[0].n as number : 0;
  const later = (id: string) => laterRecords.has(id) || laterPeople.has(ownerOf.get(id) ?? "");
  const outsidePlan = [...outside].filter((id) => !later(id)), laterRecs = outside.size - outsidePlan.length;
  const archivedOutside = [...archivedOut].filter((id) => !laterPeople.has(spaceOwner.get(id) ?? ""));
  const byOthers = lost.filter((id) => others.has(id) && !ours.has(id));
  const baselineLost = lost.filter((id) => !(others.has(id) && !ours.has(id)) && !(ours.has(id) && later(id)));
  return { job: "test_leftovers_preview", plan_at: plan.at, check: {
    events, outside_plan: outsidePlan.length, archived_outside_plan: archivedOutside.length, baseline_lost: baselineLost.length, archive_not_applied: notApplied,
    expected_later: { records: laterRecs, spaces: archivedOut.size - archivedOutside.length }, baseline_deleted_by_others: byOthers.length,
  } };
}
