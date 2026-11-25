// May this record's text be given to a model now? The one record rule of every sender of record text to a model (
//): the chat stages of the workers (common.ts handedOff → loadRecordForModel / modelDispatchFence), the
// embeddings senders (workers embed-source.ts: sourceFence, the backfill, the warm-up) and the search's reranker
// (gateway rerank-fence.ts). moved the rule here unchanged from workers embed-source.ts, so the gateway asks
// the same function instead of a copy of its logic; embed-source.ts re-exports it.
// The rule: the record is live and current, not a hidden copy of a class move (`hidden_at`), of this class in its records
// database and by the locator, and no class move is in flight for the record or for a record above it — its parents and,
// for an agent's note, its version chain (the tree a close hides, version-chain.ts CHAIN_TREE).
import type pg from "pg";
import type { DataClass } from "./db.ts";

/** The records-database half of the rule (alias `r`). */
export const EMBEDDABLE_SQL = "r.deleted_at IS NULL AND r.is_current AND r.hidden_at IS NULL";

type Q = Pick<pg.PoolClient, "query">;

/**
 * The ids of `ids` whose text must not reach a model now for class `cls` (`q` — the records database of `cls`, whose rows
 * carry its class by the trigger records_class_guard): the locator (control database) names another class or marks the
 * record deleted; a class move of the record or of any record above it — parent chain and an agent note's version chain,
 * as CHAIN_TREE hides — is pending, copying or verifying.
 * The rule is asked for the whole chain with one set query, however long the chain is: the moves in flight are
 * read (usually none — then nothing is walked), and one walk upwards in the records database returns only the ids
 * of `ids` whose chain meets a moving record. No row of the walk is fetched and there is no bound: a note rewritten a
 * thousand times is held only while a move of its chain is in flight (before: past 256 rows it was refused for ever).
 * The walk ends on a cycle too (UNION drops a row seen already).
 */
export async function heldBack(ctx: { db: { control: Q } }, q: Q, cls: DataClass, ids: readonly string[], { holdDirectMoves = false } = {}): Promise<Set<string>> {
  const held = new Set<string>();
  if (!ids.length) return held;
  // The moves in flight are read BEFORE the locator. A move's last control transaction switches the
  // locator and sets the move `done` at once: read in the other order, a check whose locator read fell before that commit
  // and whose moves read fell after it saw neither the move nor the new class. In this order a move read as not in flight
  // has committed, so the locator read after it already names the new class.
  const moving = (await ctx.db.control.query(
    "SELECT DISTINCT record_id::text AS id FROM class_moves WHERE status IN ('pending','copying','verifying')")).rows.map((r) => r.id as string);
  for (const r of (await ctx.db.control.query("SELECT record_id::text AS id, class, deleted FROM record_locations WHERE record_id = ANY($1::uuid[])", [ids])).rows)
    if (r.deleted || r.class !== cls) held.add(r.id);
  if (!moving.length) return held;
  // Chat can hold text loaded before the move deleted its source row. A direct move needs no walk from that row.
  if (holdDirectMoves) {
    for (const id of ids) if (moving.includes(id)) held.add(id);
    if (ids.every((id) => held.has(id))) return held;
  }
  // a close is entered on the head of a note's chain and hides the chain's derived records too
  for (const r of (await q.query(HELD_UP_SQL, [ids, moving])).rows) held.add(r.id as string);
  return held;
}

/** The ids of $1 with a record of $2 among the records above them (with themselves): parents and an agent note's versions. */
const HELD_UP_SQL = `WITH RECURSIVE up(id, of, parent_id, supersedes_id, superseded_by_id, source_kind) AS (
    SELECT id, id, parent_id, supersedes_id, superseded_by_id, source_kind FROM records WHERE id = ANY($1::uuid[])
  UNION SELECT p.id, up.of, p.parent_id, p.supersedes_id, p.superseded_by_id, p.source_kind FROM records p JOIN up
    ON p.id = up.parent_id OR (p.id IN (up.supersedes_id, up.superseded_by_id) AND up.source_kind = 'agent' AND up.parent_id IS NULL
                               AND p.source_kind = 'agent' AND p.parent_id IS NULL))
  SELECT DISTINCT of::text AS id FROM up WHERE id = ANY($2::uuid[])`;

/**
 * The whole rule for a set of records of class `cls` (`q` — its records database): the ids that may not go to a model now —
 * not a live current row of this database (EMBEDDABLE_SQL), or held back (`heldBack`). An unlocked read, like the chat
 * stages' check: a close that commits between this read and the send is not seen.
 */
export async function modelSourceHeld(ctx: { db: { control: Q } }, q: Q, cls: DataClass, ids: readonly string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const live = new Set((await q.query(`SELECT r.id::text AS id FROM records r WHERE r.id = ANY($1::uuid[]) AND ${EMBEDDABLE_SQL}`, [ids])).rows.map((r) => r.id as string));
  const held = await heldBack(ctx, q, cls, ids.filter((id) => live.has(id)));
  for (const id of ids) if (!live.has(id)) held.add(id);
  return held;
}
