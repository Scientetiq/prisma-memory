// Bulk "show to agents": which of a person's own hidden records one plan
// of op `open` may take. One rule, written once, for the count on "What my agent sees", the candidate list of the creation
// route and the per-item check of the plan (at creation and again under the item's locks at apply time).
//
// The rule has two steps because its facts live in two databases:
//  1. control — the person's locators that are blocked: a finding mark of the open check (`open_check`) or a class move in
//     flight (`in_progress`) on a closed locator, or a `derived_from` link from the row (a retelling — `not_applicable`);
//  2. the closed database — `bulkOpenSql` over records_live (current, not deleted, not hidden): own root documents and
//     notes in an active personal, team or project space, not a space guide, not placed — and NO row of the record's chain
//     and tree (CHAIN_TREES: the versions of an own note and everything derived, with deleted and hidden rows, the rule
//     the open check and the class move read) is a transcript, a declared retelling, carries a meeting sign of the product
//     (MEETING_MARK_SQL: a keeper's copy, a handover, detached from a meeting, lost or unwritten provenance) or is blocked
//     in step 1. A correction of a retelling keeps its link and its declaration on the previous version:
//     a rule that read the head row alone would let such a record through.
// Never eligible: meetings and everything derived from them (type, tree, signs, links), directory cards and work profiles
// (type `profile`), the company space (`org`: opening there publishes to every agent of the company), records with a finding
// mark (a plan has no `despite_findings` path). Every item still goes through the unchanged open() at apply time.
//
// This module imports only access.ts and @memory/shared: plans.ts and agent-view.ts import it (no cycle).
import { binder, CHAIN_TREE, CHAIN_TREES, MEETING_MARK_SQL, openCheckSettings, SPACE_GUIDE_PREFIX, bulkOpenSettings, type Bind } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import type { SpaceAccess } from "./access.ts";

export const BULK_OPEN_TYPES = ["document", "note"] as const;
export type BulkOpenType = (typeof BULK_OPEN_TYPES)[number];
export type BulkOpenDenial = "open_check" | "in_progress" | "not_applicable";
export type BulkOpenOff = "bulk_open_disabled" | "open_check_disabled";

/** limits.plan_max_items with the bounds of plans.ts (1…2000; anything else reads as the seed's 1000). */
function planMaxItems(app: App): number {
  const v = Number(app.settings.get("limits.plan_max_items", 1000));
  return Number.isInteger(v) && v >= 1 && v <= 2000 ? v : 1000;
}

/**
 * Whether bulk open is available now and how many records one plan may take. Off when access.bulk_open is off, and also
 * while the open check is switched off: open() would then open without any check (nothing found), and a plan of hundreds of
 * records must not do that.
 */
export function bulkOpenState(app: App): { enabled: boolean; maxItems: number; reason: BulkOpenOff | null } {
  const s = bulkOpenSettings(app.settings);
  const reason: BulkOpenOff | null = !s.enabled ? "bulk_open_disabled" : !openCheckSettings(app.settings).enabled ? "open_check_disabled" : null;
  return { enabled: reason === null, maxItems: Math.min(s.maxItems, planMaxItems(app)), reason };
}

/** Spaces a bulk plan may take records from: readable, not archived, personal, team or project — never the company space. */
export function bulkOpenSpaces(spaces: Map<string, SpaceAccess>, spaceId?: string): string[] {
  return [...spaces.values()].filter((s) => !s.archived_at && ["personal", "team", "project"].includes(s.kind) && (!spaceId || s.id === spaceId)).map((s) => s.id);
}

/**
 * Step 1 (control): the person's locators that make a record's chain and tree ineligible, with the reason — a finding mark or
 * a class move in flight on a closed, not deleted locator; a `derived_from` link from any own row (any class, also in the
 * trash: an older version or a derived row of the tree keeps the link of a retelling). `ids` narrows the query to these rows
 * (the per-item check passes the record's chain and tree). Precedence: finding mark, then a class move in flight, then a link.
 * A link from a row of `ids` or `treeRows` counts whoever owns that row's locator (the rule of derivation.ts readBasis reads
 * the links of every tree row; final): the per-item check passes the chain and tree as `ids`, the candidate list
 * the older versions and derived rows of its records as `treeRows`.
 */
export async function bulkOpenBlocked(app: App, me: string, ids?: string[], treeRows: readonly string[] = []): Promise<Map<string, BulkOpenDenial>> {
  const args: unknown[] = [me], b = binder(args);
  const only = ids ? ` AND l.record_id = ANY(${b(ids)}::uuid[])` : "";
  const live = "l.class = 'closed' AND NOT l.deleted";
  const moving = "EXISTS (SELECT 1 FROM class_moves m WHERE m.record_id = l.record_id AND m.status IN ('pending','copying','verifying'))";
  const rows = (await app.db.control.query(
    `SELECT l.record_id AS id,
            CASE WHEN ${live} AND l.open_check IS NOT NULL THEN 'open_check'
                 WHEN ${live} AND ${moving} THEN 'in_progress'
                 ELSE 'not_applicable' END AS reason
       FROM record_locations l
      WHERE l.owner_id = $1${only}
        AND ((${live} AND (l.open_check IS NOT NULL OR ${moving}))
             OR EXISTS (SELECT 1 FROM record_links k WHERE k.src_id = l.record_id AND k.relation = 'derived_from'))`, args)).rows as Array<{ id: string; reason: BulkOpenDenial }>;
  const blocked = new Map(rows.map((r) => [r.id, r.reason]));
  const linkRows = [...new Set([...(ids ?? []), ...treeRows])];
  if (linkRows.length) {
    const links = (await app.db.control.query("SELECT DISTINCT src_id FROM record_links WHERE src_id = ANY($1::uuid[]) AND relation = 'derived_from'", [linkRows])).rows;
    for (const k of links) if (!blocked.has(k.src_id as string)) blocked.set(k.src_id as string, "not_applicable");
  }
  return blocked;
}

/** Step 2 (closed database): the predicate over records_live `alias`. Values are bound through `b`; nothing is inlined. */
export function bulkOpenRecordSql(b: Bind, o: { me: string; spaceIds: string[]; types: readonly string[]; blocked: Iterable<string> }, alias = "r"): string {
  const r = alias;
  return [
    `${r}.owner_id = ${b(o.me)}`,
    `${r}.parent_id IS NULL`,
    `${r}.type = ANY(${b([...o.types])}::record_type[])`,
    `${r}.space_id = ANY(${b(o.spaceIds)}::uuid[])`,
    `${r}.id <> ALL(${b([...o.blocked])}::uuid[])`,
    // the map "How we work" of a space (space guide): its owner changes it on its own page
    `NOT (${r}.source_kind = 'agent' AND starts_with(COALESCE(${r}.source_ref, ''), ${b(SPACE_GUIDE_PREFIX)}))`,
    // a declared retelling: its sources decide who may read it, the person opens it one by one
    `COALESCE(${r}.attrs->>'derived_declared', '0') = '0'`,
    // a placed record is read in more spaces than its own: the readers line of the preview would not be exact
    `NOT EXISTS (SELECT 1 FROM record_placements pl WHERE pl.record_id = ${r}.id)`,
  ].join(" AND ");
}

/** CHAIN_TREES (`chain`, `tree`) started from the rows of records_live that `base` accepts (by default bulkOpenRecordSql with nothing blocked). */
function chainTreesOf(b: Bind, o: { me: string; spaceIds: string[]; types: readonly string[] }, base?: (alias: string) => string): string {
  const where = base ? base("r0") : bulkOpenRecordSql(b, { ...o, blocked: [] }, "r0");
  const trees = CHAIN_TREES.replace("ANY($1::uuid[])", `ANY(ARRAY(SELECT r0.id FROM records_live r0 WHERE ${where}))`);
  if (trees === CHAIN_TREES) throw new Error("bulk-open: the chain rule CHAIN_TREES changed its start; update bulkOpenSql");
  return trees;
}

/** A row `z` of a record's chain and tree that makes the record ineligible: meeting, retelling, meeting sign, blocked locator. */
function treeRowDenied(b: Bind, blocked: Iterable<string>, z: string): string {
  return `(${z}.type = 'transcript' OR COALESCE(${z}.attrs->>'derived_declared', '0') <> '0' OR ${MEETING_MARK_SQL(z)}
           OR ${z}.id = ANY(${b([...blocked])}::uuid[]))`;
}

/**
 * Step 2 (closed database), the whole query: the rows of records_live `r` that `bulkOpenRecordSql` accepts and whose chain
 * and tree has no denied row. `only` narrows to one record (the per-item check). The chain rule is CHAIN_TREES of
 * @memory/shared, so it follows any change of the version rule. Selects `r.id` and `total` (all eligible rows); `tail` is
 * appended (ORDER BY, LIMIT).
 */
export function bulkOpenSql(b: Bind, o: { me: string; spaceIds: string[]; types: readonly string[]; blocked: Iterable<string>; only?: string }, tail = ""): string {
  const blocked = [...o.blocked];
  const base = (a: string) => `${bulkOpenRecordSql(b, { ...o, blocked }, a)}${o.only ? ` AND ${a}.id = ${b(o.only)}::uuid` : ""}`;
  return `${chainTreesOf(b, o, base)}
    SELECT r.id, count(*) OVER () AS total FROM records_live r
     WHERE ${base("r")}
       AND NOT EXISTS (SELECT 1 FROM tree t JOIN records z ON z.id = t.id WHERE t.start = r.id AND ${treeRowDenied(b, blocked, "z")})${tail}`;
}

const typesOf = (types?: readonly string[]): string[] => (types?.length ? [...types] : [...BULK_OPEN_TYPES]).filter((t) => (BULK_OPEN_TYPES as readonly string[]).includes(t));

/**
 * The records one plan would take, newest first, and how many there are in all. `spaceId` narrows to one space, `types` to
 * some of BULK_OPEN_TYPES. Counts are not content: no audit read event (the plan audits the titles it shows).
 */
export async function bulkOpenCandidates(app: App, caller: Caller, spaces: Map<string, SpaceAccess>, o: { spaceId?: string; types?: readonly string[]; limit: number }): Promise<{ ids: string[]; total: number }> {
  const me = caller.person!.id, spaceIds = bulkOpenSpaces(spaces, o.spaceId), types = typesOf(o.types);
  if (!spaceIds.length || !types.length) return { ids: [], total: 0 };
  const db = app.db.records("closed", caller.scope);
  // the older versions and derived rows of the records the plan may take: their links count whoever owns their locators
  const targs: unknown[] = [], tb = binder(targs);
  const treeRows = (await db.query(`${chainTreesOf(tb, { me, spaceIds, types })} SELECT DISTINCT t.id FROM tree t WHERE t.id <> t.start`, targs)).rows.map((x) => x.id as string);
  const blocked = await bulkOpenBlocked(app, me, undefined, treeRows);
  const args: unknown[] = [], b = binder(args);
  const tail = ` ORDER BY r.occurred_at DESC, r.id LIMIT ${b(Math.max(1, o.limit))}`;
  const rows = (await db.query(bulkOpenSql(b, { me, spaceIds, types, blocked: blocked.keys() }, tail), args)).rows;
  return { ids: rows.map((x) => x.id as string), total: rows.length ? Number(rows[0].total) : 0 };
}

/**
 * The per-item rule of a plan item (creation, and apply under the item's locks): null — the record may be opened by the
 * plan; otherwise the reason. The same SQL as the count and the candidate list.
 */
export async function bulkOpenDenied(app: App, caller: Caller, id: string, spaces: Map<string, SpaceAccess>): Promise<BulkOpenDenial | null> {
  const me = caller.person!.id;
  const db = app.db.records("closed", caller.scope);
  // the locators of the record's whole chain and tree: a link or a mark on an older version or a derived row counts too
  const tree = (await db.query(`${CHAIN_TREE} SELECT id FROM tree`, [id])).rows.map((r) => r.id as string);
  const blocked = await bulkOpenBlocked(app, me, tree.includes(id) ? tree : [id, ...tree]);
  const why = blocked.get(id) ?? blocked.values().next().value;
  if (why) return why;
  const loc = (await app.db.control.query("SELECT 1 FROM record_locations WHERE record_id = $1 AND owner_id = $2 AND class = 'closed' AND NOT deleted", [id, me])).rowCount;
  if (!loc) return "not_applicable";
  const spaceIds = bulkOpenSpaces(spaces);
  if (!spaceIds.length) return "not_applicable";
  const args: unknown[] = [], b = binder(args);
  const ok = (await db.query(bulkOpenSql(b, { me, spaceIds, types: BULK_OPEN_TYPES, blocked: blocked.keys(), only: id }), args)).rowCount;
  return ok ? null : "not_applicable";
}
