// The hold "Wrong / not for everyone" and the check unit of a "Company shared knowledge" record.
// A separate module without dependencies on access.ts — the read by id (loadReadable) calls it too.
//
// The hold is a filter OUTSIDE the visibility core: records whose check unit is held and whose locator is in org
// are not found by agent search and list (any key but a workplace session); by id only the author (their
// keys) and people in the workplace read them. The hold works in any position of the switch. The unit is the nearest
// record up by parent_id with an org_reviews row (the move root, a direct write, a version of one's own note); the row
// of an older version (superseded) leads to the successor — the hold holds along the version chain.
import type pg from "pg";
import type { DataClass, OrgReviewState, OrgReviewView } from "@memory/shared";
import type { App, Caller } from "./context.ts";

type Q = Pick<pg.Pool, "query">;

/** A check row (without content). */
export interface ReviewRow {
  record_id: string; state: OrgReviewState; cycle: number; entered_at: Date; entered_via: string; entered_by: string | null; entered_human: boolean; extended: boolean;
  from_space_id: string | null; from_audience: string | null; exempt_kind: string | null; return_after: Date | null; held_at: Date | null; held_by: string | null;
  disputed_at: Date | null; decided_at: Date | null; decided_by: string | null; decided_via: string | null; returned_to: string | null; returns: number; supersedes_id: string | null;
}

const orgCache = new WeakMap<object, { at: number; instance: string; row: { id: string; slug: string } | null }>();
/** The instance's org space (one); a process cache for a minute — per control pool (tests start their own bases). */
export async function orgSpace(app: Pick<App, "db" | "instanceId">): Promise<{ id: string; slug: string } | null> {
  const hit = orgCache.get(app.db.control);
  if (hit && hit.instance === app.instanceId && Date.now() - hit.at < 60_000) return hit.row;
  const row = (await app.db.control.query("SELECT id, slug FROM spaces WHERE kind = 'org' AND instance_id = $1", [app.instanceId])).rows[0] ?? null;
  orgCache.set(app.db.control, { at: Date.now(), instance: app.instanceId, row });
  return row;
}

/** A person in the workplace (a session, including the panel preview — it shows what the person sees): the hold does not hide. */
export const seesHeld = (caller: Pick<Caller, "keyKind">): boolean => caller.keyKind === "session";

/** The view for the reader (Hit.org_review, memory_list, memory_read): a held one is disputed; final ones, exceptions — none. */
export function reviewView(r: Pick<ReviewRow, "state" | "held_at"> | null | undefined): OrgReviewView | null {
  if (!r) return null;
  if (r.held_at) return "disputed";
  return r.state === "unreviewed" || r.state === "confirmed" || r.state === "community" ? r.state : null;
}

/** "Confirmed" of an org record with a check row: only confirmed and community; else the old confirmed_at. */
export function confirmedOf(r: Pick<ReviewRow, "state"> | null | undefined, confirmedAt: Date | string | null): boolean {
  if (r && (r.state === "unreviewed" || r.state === "confirmed" || r.state === "community")) return r.state !== "unreviewed";
  return confirmedAt !== null;
}

const UP = `WITH RECURSIVE up AS (
    SELECT id AS start, id, parent_id, 0 AS depth FROM records WHERE id = ANY($1::uuid[])
    UNION ALL SELECT u.start, r.id, r.parent_id, u.depth + 1 FROM records r JOIN up u ON r.id = u.parent_id WHERE u.depth < 8
  ) SELECT start, id, depth FROM up`;

/** The step limit along the version chain (a guard against a loop in data): past it the head counts as not found. */
export const CHAIN_STEPS_MAX = 10_000;

/**
 * The head of the check row chain: from row `$1` along successors (supersedes_id, with several — the later one)
 * to the first not superseded, in one recursive query, at most CHAIN_STEPS_MAX steps. The path's last row is the head;
 * if it is still superseded (no successor or the limit), the head is not found.
 */
const CHAIN_HEAD_SQL = `WITH RECURSIVE walk AS (
    SELECT r.record_id, r.state, 0 AS n FROM org_reviews r WHERE r.record_id = $1
    UNION ALL
    SELECT nx.record_id, nx.state, w.n + 1 FROM walk w
      CROSS JOIN LATERAL (SELECT x.record_id, x.state FROM org_reviews x WHERE x.supersedes_id = w.record_id ORDER BY x.entered_at DESC LIMIT 1) nx
     WHERE w.state = 'superseded' AND w.n < $2)
  SELECT o.* FROM org_reviews o JOIN (SELECT record_id FROM walk ORDER BY n DESC LIMIT 1) h ON h.record_id = o.record_id`;

/**
 * Check units of records of one class: record → the row of the nearest ancestor with a row (the record itself is depth 0); a
 * superseded row → the head of the successor chain (supersedes_id) of any length (before, up to 50 steps, and after them
 * an intermediate row without a hold let an agent reach an old version of a held note). Head not found — the row with
 * `unresolved: true` (the last reached): heldFromReader then refuses (fail closed), others see it as before.
 * No row — the record is not in the map (outside the check: from before the check or the switch).
 */
export async function orgUnitsOf(control: Q, db: Q, ids: readonly string[]): Promise<Map<string, ReviewRow & { unresolved?: boolean }>> {
  const out = new Map<string, ReviewRow & { unresolved?: boolean }>();
  if (!ids.length) return out;
  const up = (await db.query(UP, [[...new Set(ids)]])).rows as Array<{ start: string; id: string; depth: number }>;
  const rows = new Map<string, ReviewRow>((await control.query("SELECT * FROM org_reviews WHERE record_id = ANY($1::uuid[])", [[...new Set(up.map((u) => u.id))]])).rows.map((r) => [r.record_id, r]));
  const best = new Map<string, { depth: number; row: ReviewRow }>();
  for (const u of up) {
    const row = rows.get(u.id);
    if (!row) continue;
    const cur = best.get(u.start);
    if (!cur || u.depth < cur.depth) best.set(u.start, { depth: u.depth, row });
  }
  for (const [start, { row }] of best) out.set(start, await successorOf(control, row));
  return out;
}

/**
 * A superseded row → the head of the successor chain of any length (CHAIN_HEAD_SQL; before, up to 50
 * steps here); head not found — the last reached with `unresolved: true`; others — as they are.
 */
async function successorOf(control: Q, row: ReviewRow): Promise<ReviewRow & { unresolved?: boolean }> {
  if (row.state !== "superseded") return row;
  const head = (await control.query(CHAIN_HEAD_SQL, [row.record_id, CHAIN_STEPS_MAX])).rows[0] as ReviewRow | undefined ?? row;
  return head.state === "superseded" ? { ...head, unresolved: true } : head;
}

/**
 * Check units of ALL ancestors of a record by parent_id (without itself): nearest first, superseded → successor, no
 * repeats. A meeting part moved into org separately is checked against each: a decision "above"
 * does not hide behind the nearest row — the curator returned the meeting, and a middle decision has its own "left" row (an
 * agent once took it away): the agent still does not take the part out, a hold of any ancestor passes to it.
 */
export async function orgAncestorUnits(control: Q, db: Q, id: string): Promise<Array<ReviewRow & { unresolved?: boolean }>> {
  const above = ((await db.query(UP, [[id]])).rows as Array<{ id: string; depth: number }>).filter((u) => u.depth > 0).sort((a, b) => a.depth - b.depth);
  if (!above.length) return [];
  const rows = new Map<string, ReviewRow>((await control.query("SELECT * FROM org_reviews WHERE record_id = ANY($1::uuid[])", [above.map((u) => u.id)])).rows.map((r) => [r.record_id, r]));
  const out: Array<ReviewRow & { unresolved?: boolean }> = [], seen = new Set<string>();
  for (const u of above) {
    const row = rows.get(u.id);
    if (!row) continue;
    const r = await successorOf(control, row);
    if (!seen.has(r.record_id)) { seen.add(r.record_id); out.push(r); }
  }
  return out;
}

// ---------------------------------------------------------------- the set hidden by the hold (search and list)
const heldCache = new WeakMap<object, Map<DataClass, { at: number; ids: string[] }>>();
const HELD_TTL_MS = 5_000;

/** Reset the held cache (a mark, a removal, a curator decision in this process): the next search sees the change at once. */
export function invalidateHeld(app: object): void { heldCache.delete(app); }

/**
 * Records of a class hidden by the hold from non-sessions: held units with an org locator and their derivatives in org (the tree
 * down). Empty — almost always (the partial index org_reviews_held_idx). A process cache for 5 s; the final
 * check in search and list is by the units of hits, so the cache only affects the number of candidates.
 */
export async function heldIds(app: App, caller: Caller, cls: DataClass): Promise<string[]> {
  if (seesHeld(caller)) return [];
  const org = await orgSpace(app);
  if (!org) return [];
  let byCls = heldCache.get(app);
  const hit = byCls?.get(cls);
  if (hit && Date.now() - hit.at < HELD_TTL_MS) return hit.ids;
  const units = (await app.db.control.query(
    `SELECT r.record_id FROM org_reviews r JOIN record_locations l ON l.record_id = r.record_id AND NOT l.deleted AND l.class = $2
      WHERE r.instance_id = $1 AND r.held_at IS NOT NULL AND r.state <> 'superseded' AND l.space_id = $3`, [app.instanceId, cls, org.id])).rows.map((r) => r.record_id as string);
  const ids = units.length ? (await app.db.records(cls, caller.scope).query(
    `WITH RECURSIVE t AS (SELECT id FROM records WHERE id = ANY($1::uuid[]) UNION SELECT r.id FROM records r JOIN t ON r.parent_id = t.id)
     SELECT t.id FROM t JOIN records x ON x.id = t.id WHERE x.space_id = $2`, [units, org.id])).rows.map((r) => r.id as string) : [];
  if (!byCls) { byCls = new Map(); heldCache.set(app, byCls); }
  byCls.set(cls, { at: Date.now(), ids });
  return ids;
}

/**
 * Derivative records (memory_read, record status) without parts held as "Wrong" in org:
 * an agent, except the author's keys, gets no titles of held parts — as search and list do not list them. A person in the
 * workplace and the author see everything. An empty list and an empty hold — no extra queries (the heldIds cache is 5 s).
 */
export async function dropHeldDerived<T extends { id: string }>(app: App, caller: Caller, parent: { owner_id: string; class: DataClass }, rows: T[]): Promise<T[]> {
  if (!rows.length || seesHeld(caller) || parent.owner_id === caller.person?.id) return rows;
  const held = new Set(await heldIds(app, caller, parent.class));
  return held.size ? rows.filter((r) => !held.has(r.id)) : rows;
}

/**
 * Held units of a class by locators — control only (the invariant: a key without the closed class does not get the closed base
 * opened). For the list of hidden closed records (memory_list for the space owner): derivatives of a held unit
 * stay there as a row without a title — that is metadata, not content.
 */
export async function heldUnitIds(app: App, caller: Caller, cls: DataClass): Promise<string[]> {
  if (seesHeld(caller)) return [];
  return (await app.db.control.query(
    `SELECT r.record_id FROM org_reviews r JOIN record_locations l ON l.record_id = r.record_id AND NOT l.deleted AND l.class = $2
       JOIN spaces s ON s.id = l.space_id AND s.kind = 'org'
      WHERE r.instance_id = $1 AND r.held_at IS NOT NULL AND r.state <> 'superseded'`, [app.instanceId, cls])).rows.map((r) => r.record_id as string);
}

/**
 * Read by id (loadReadable): a record in org, a caller that is neither a session nor the author, a held unit → "no record" (by id
 * only the author and people in the workplace read it). Other records — no queries.
 *
 * A part with its own row (a summary moved into org separately, the meeting later, and it was marked "Wrong") is not held
 * by its own row, but the source above it by parent_id is held and lies in org — also "no record" ("a part
 * inherits the hold of its source"): just as search and list hide it through heldIds (held units in org and their
 * derivatives in org). A held source outside org (taken away or returned with a hold) does not hide the part — as in heldIds.
 */
export async function heldFromReader(app: App, caller: Caller, db: Q, rec: { id: string; owner_id: string; space_id: string; parent_id?: string | null }): Promise<boolean> {
  if (seesHeld(caller) || rec.owner_id === caller.person?.id) return false;
  const org = await orgSpace(app);
  if (!org || rec.space_id !== org.id) return false;
  const unit = (await orgUnitsOf(app.db.control, db, [rec.id])).get(rec.id);
  // the head of the version chain is not found (a break or a loop in data) — the hold cannot be checked: a refusal, not a pass
  if (unit?.held_at || unit?.unresolved) return true;
  if (rec.parent_id === null) return false;                    // no sources — no extra queries
  const above = await orgAncestorUnits(app.db.control, db, rec.id);
  // the same for the source above by parent_id (the hold of ancestors, the head of the chain)
  if (above.some((r) => r.unresolved)) return true;
  const heldAbove = above.filter((r) => r.held_at && r.state !== "superseded").map((r) => r.record_id);
  if (!heldAbove.length) return false;
  return ((await app.db.control.query("SELECT 1 FROM record_locations WHERE record_id = ANY($1::uuid[]) AND NOT deleted AND space_id = $2 LIMIT 1",
                                      [heldAbove, org.id])).rowCount ?? 0) > 0;
}
