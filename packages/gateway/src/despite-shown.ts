// Shown to agents despite a not-only-yours finding (a revert stays possible): one
// rule for the revert (report-despite.ts), restore from trash (owner.ts restoreFromTrash), the count of shown items in
// the trash and the worker's class reconciler: shared SHOWN_SHARED_SQL and lastMoveShownShared (shared/despite.ts). Shown means
// the LAST non-failed move of a record over the whole version chain of its own note: a finished move into
// open by a person in the workplace with the shared scope. A close after showing (by the author, the space owner, a revert)
// is no longer a show; a failed close did not change the record (the worker rolls it back), so failed moves are skipped.
import type pg from "pg";
import { CHAIN_HEADS, CHAIN_MEMBERS, SHOWN_SHARED_SQL } from "@memory/shared";

export { lastMoveShownShared, SHOWING_SHARED_SQL, SHOWN_SHARED_SQL } from "@memory/shared";

/** The last non-failed move of each record of instance `$1`: subquery `m` (DISTINCT ON record_id, the index of the last move). */
export const LAST_LIVE_MOVES = `(SELECT DISTINCT ON (m0.record_id) m0.* FROM class_moves m0 JOIN people p0 ON p0.id = m0.requested_by AND p0.instance_id = $1
        WHERE m0.status <> 'failed'
        ORDER BY m0.record_id, m0.requested_at DESC, m0.id DESC) m`;

type Q = Pick<pg.Pool, "query">;

/**
 * The head of the version chain of its own note for each of `ids`: for a record without a chain or missing in the database,
 * the record itself. One query to the class database (CHAIN_HEADS).
 */
export async function chainHeads(db: Q, ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>(ids.map((id) => [id, id]));
  for (let i = 0; i < ids.length; i += 1000)
    for (const r of (await db.query(CHAIN_HEADS, [ids.slice(i, i + 1000)])).rows) out.set(r.id as string, r.head as string);
  return out;
}

/**
 * Heads `heads` whose chain has a not-only-yours show as the last non-failed move: an earlier
 * version of its own note keeps its old show, and the head was later closed and shown again as only-yours; such a chain does not
 * enter the revert. Versions come from the class database (CHAIN_MEMBERS), moves from control; a head without a row is itself.
 */
export async function liveSharedHeads(db: Q, control: Q, heads: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < heads.length; i += 1000) {
    const part = heads.slice(i, i + 1000), pairs = new Map<string, string>(part.map((h) => [`${h}:${h}`, h]));
    for (const r of (await db.query(CHAIN_MEMBERS, [part])).rows) pairs.set(`${r.head}:${r.id}`, r.id as string);
    const ids: string[] = [], of: string[] = [];
    for (const [k, id] of pairs) { ids.push(id); of.push(k.slice(0, k.indexOf(":"))); }
    const { rows } = await control.query(
      `SELECT m.head FROM (SELECT DISTINCT ON (x.head) x.head, m0.* FROM unnest($1::uuid[], $2::uuid[]) AS x(id, head)
          JOIN class_moves m0 ON m0.record_id = x.id AND m0.status <> 'failed'
         ORDER BY x.head, m0.requested_at DESC, m0.id DESC) m
        WHERE ${SHOWN_SHARED_SQL}`, [ids, of]);
    for (const r of rows) out.add(r.head as string);
  }
  return out;
}
