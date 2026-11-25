import type pg from "pg";
import { tx } from "./db.ts";
import { inProgress } from "./errors.ts";
import { chainLinkSql } from "./version-chain.ts";

export const CORRECTIONS_SUPERSEDE_SQL =
  "UPDATE record_corrections SET status = 'superseded', text = NULL, fields = NULL, quote = NULL WHERE target_id = ANY($1::uuid[]) AND status IN ('planned','proposed')";

interface Queryable { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> }

export type SpaceMoveOp = "promote" | "move_space" | "return";

export interface SpaceMoveRow {
  id: string; type: string; owner_id: string; parent_id: string | null; occurred_at: Date | string; space_id: string; audience: string | null;
  deleted_at: Date | null; deleted_by: string | null; purge_after: Date | null; deleted_batch: string | null; hidden: boolean;
  restricted: boolean;
}
export interface SpaceMoved { id: string; type: string; occurred_at: Date | string; audience: string | null; deleted: boolean; from_space: string | null }

export interface SpaceMoveArgs {
  recordId: string; cls: "open" | "closed"; toSpaceId: string; actorId: string | null; authorId: string; op: SpaceMoveOp;
  widen: boolean;
  onlyFrom?: string;
  rootOnly?: boolean;
  sameSpaceGated?: boolean;
  reown?: { from: string; to: string };
  hiddenStay?: boolean;
}
export type SpaceMoveResult<T> =
  | { status: "moved"; set: SpaceMoveRow[]; moved: SpaceMoved[]; extra: T }
  | { status: "already"; set: SpaceMoveRow[]; moved: []; extra: undefined }
  | { status: "gone"; set: SpaceMoveRow[]; moved: []; extra: undefined };

/**
 * Version chain of the root. Return to the author ($3 = true): along supersedes_id / superseded_by_id both ways, only rows of
 * the same author — the return never takes someone else's version. Ordinary move ($3 = false): the versions linked by the
 * chain rule of version-chain.ts (chainLinkSql: agent notes or documents) — the older text travels with the current one.
 */
const CHAIN = `WITH RECURSIVE chain AS (
    SELECT id, supersedes_id, superseded_by_id, parent_id, source_kind FROM records WHERE id = $1
    UNION SELECT r.id, r.supersedes_id, r.superseded_by_id, r.parent_id, r.source_kind FROM records r
      JOIN chain c ON r.id IN (c.supersedes_id, c.superseded_by_id)
       AND (($3::boolean AND r.owner_id = $2)
            OR ${chainLinkSql("c", "r")}))`;
const LOCK_ROOTS = `${CHAIN} SELECT id FROM records WHERE id IN (SELECT id FROM chain) ORDER BY id FOR UPDATE`;
const TREE_OF = `${CHAIN}, tree AS (SELECT id FROM chain UNION SELECT r.id FROM records r JOIN tree t ON r.parent_id = t.id)`;
const RESTRICTED = `COALESCE(r.attrs #>> '{access,restricted_by_source}', '') = 'true'`;
const LOCK_SET = `${TREE_OF}
  SELECT r.id, r.type, r.owner_id, r.parent_id, r.occurred_at, r.space_id, r.audience, r.deleted_at, r.deleted_by, r.purge_after,
         r.deleted_batch, r.hidden_at IS NOT NULL AS hidden, ${RESTRICTED} AS restricted
  FROM records r WHERE r.id IN (SELECT id FROM tree) ORDER BY r.id FOR UPDATE`;

export function moveTake(set: readonly SpaceMoveRow[], rootId: string, o: { rootOnly?: boolean; onlyFrom?: string } = {}): SpaceMoveRow[] {
  const root = set.find((r) => r.id === rootId);
  if (!root) return [];
  return set.filter((r) => !r.deleted_at && (r.id === rootId || (!o.rootOnly && r.space_id === root.space_id)) && (!o.onlyFrom || r.space_id === o.onlyFrom));
}

export const widenOf = (take: readonly SpaceMoveRow[], widen: boolean): SpaceMoveRow[] => (widen ? take.filter((r) => !r.restricted) : []);

export async function widenPending(db: Queryable, recordId: string, authorId: string, spaceId: string): Promise<boolean> {
  return !!(await db.query(`${TREE_OF} SELECT 1 FROM records r WHERE r.id IN (SELECT id FROM tree) AND r.deleted_at IS NULL AND r.space_id = $4
    AND r.audience = 'people' AND NOT ${RESTRICTED} LIMIT 1`, [recordId, authorId, false, spaceId])).rowCount;
}

export async function spaceMove<T>(control: Queryable, db: pg.Pool, a: SpaceMoveArgs,
                                   inside?: (c: pg.PoolClient, moved: SpaceMoved[], set: SpaceMoveRow[]) => Promise<T>): Promise<SpaceMoveResult<T>> {
  const back = a.op === "return";
  if (back && a.reown) throw new Error("spaceMove: reown cannot be used when returning a record");
  return tx(db, async (c) => {
    const params = [a.recordId, a.authorId, back];
    await c.query(LOCK_ROOTS, params);
    const set = (await c.query(LOCK_SET, params)).rows as SpaceMoveRow[];
    const root = set.find((r) => r.id === a.recordId);
    if (!root || root.deleted_at) return { status: "gone", set, moved: [], extra: undefined };
    const ids = set.map((r) => r.id);
    const busyOf = async (rows: SpaceMoveRow[]) =>
      !!(await control.query("SELECT 1 FROM class_moves WHERE record_id = ANY($1::uuid[]) AND status IN ('pending','copying','verifying')", [rows.map((r) => r.id)])).rowCount
      || rows.some((r) => r.hidden);
    if (!a.rootOnly && !a.hiddenStay && await busyOf(set)) throw inProgress(10);

    const from = new Map<string, string | null>();
    if (back) {
      const chunkAway = new Map((await c.query("SELECT DISTINCT ON (record_id) record_id, space_id FROM chunks WHERE record_id = ANY($1::uuid[]) AND space_id <> $2",
                                               [ids, a.toSpaceId])).rows.map((r) => [r.record_id as string, r.space_id as string]));
      const locs = new Map((await control.query("SELECT record_id, space_id FROM record_locations WHERE record_id = ANY($1::uuid[])", [ids]))
        .rows.map((r) => [r.record_id as string, r.space_id as string]));
      const aways = new Map<string, string | null>();
      for (const r of set) {
        const loc = locs.get(r.id);
        aways.set(r.id, r.space_id !== a.toSpaceId ? r.space_id : chunkAway.get(r.id) ?? (loc && loc !== a.toSpaceId ? loc : null));
      }
      const awaySpaces = [...new Set([...aways.values()].filter((x): x is string => !!x))];
      const foreign = awaySpaces.length ? new Set((await control.query(
        "SELECT id FROM spaces WHERE id = ANY($1::uuid[]) AND kind = 'personal' AND owner_id IS DISTINCT FROM $2::uuid", [awaySpaces, a.authorId])).rows.map((r) => r.id as string))
        : new Set<string>();
      for (const r of set) {
        const loc = locs.get(r.id), away = aways.get(r.id) ?? null;
        if (a.onlyFrom && away !== a.onlyFrom) continue;
        if (away && foreign.has(away)) continue;
        if (away || !loc) from.set(r.id, away);
      }
      if (!from.size) return { status: "already", set, moved: [], extra: undefined };
    } else {
      if (a.hiddenStay && root.hidden) return { status: "already", set, moved: [], extra: undefined };
      for (const r of moveTake(set, a.recordId, { rootOnly: a.rootOnly, onlyFrom: a.onlyFrom })) if (!a.hiddenStay || !r.hidden) from.set(r.id, r.space_id);
      if (!from.size) return { status: "already", set, moved: [], extra: undefined };
    }
    const take = set.filter((r) => from.has(r.id));
    const widenIds = widenOf(take, a.widen).map((r) => r.id);
    if (!back && take.every((r) => r.space_id === a.toSpaceId)) {
      const grows = take.some((r) => widenIds.includes(r.id) && r.audience !== "space");
      if (!grows) return { status: "already", set, moved: [], extra: undefined };
      if (a.sameSpaceGated === false) throw inProgress(10);
    }
    if ((a.rootOnly || a.hiddenStay) && await busyOf(take)) throw inProgress(10);
    const takeIds = take.map((r) => r.id);
    const reown = a.reown ? ", owner_id = CASE WHEN owner_id = $4::uuid THEN $5::uuid ELSE owner_id END" : "";
    const moved = ((await c.query(
      `UPDATE records SET space_id = $2, audience = CASE WHEN id = ANY($3::uuid[]) THEN 'space' ELSE audience END${reown}
       WHERE id = ANY($1::uuid[]) RETURNING id, type, occurred_at, audience, deleted_at IS NOT NULL AS deleted`,
      a.reown ? [takeIds, a.toSpaceId, widenIds, a.reown.from, a.reown.to] : [takeIds, a.toSpaceId, widenIds])).rows as Array<Omit<SpaceMoved, "from_space">>)
      .map((m) => ({ ...m, from_space: from.get(m.id) ?? null }));
    await c.query(`UPDATE chunks SET space_id = $2, audience = CASE WHEN record_id = ANY($3::uuid[]) THEN 'space' ELSE audience END WHERE record_id = ANY($1::uuid[])`,
                  [takeIds, a.toSpaceId, widenIds]);
    await c.query(CORRECTIONS_SUPERSEDE_SQL, [takeIds]);
    const extra = inside ? await inside(c, moved, set) : (undefined as T);

    const byId = new Map(take.map((r) => [r.id, r]));
    const rows = moved.map((m) => byId.get(m.id)!).filter(Boolean);
    if (rows.length) {
      const ownerOf = (r: SpaceMoveRow) => (a.reown && r.owner_id === a.reown.from ? a.reown.to : r.owner_id);
      const reownLoc = a.reown ? ", owner_id = CASE WHEN record_locations.owner_id = $10::uuid THEN $11::uuid ELSE record_locations.owner_id END" : "";
      await control.query(
        `INSERT INTO record_locations (record_id, class, space_id, type, owner_id, deleted, deleted_at, deleted_by, purge_after, deleted_batch)
         SELECT m.id, $2, $3, m.type, m.owner_id, m.deleted_at IS NOT NULL, m.deleted_at, m.deleted_by, m.purge_after, m.deleted_batch
         FROM unnest($1::uuid[], $4::text[], $5::uuid[], $6::timestamptz[], $7::uuid[], $8::timestamptz[], $9::uuid[])
              AS m(id, type, owner_id, deleted_at, deleted_by, purge_after, deleted_batch)
         ON CONFLICT (record_id) DO UPDATE SET space_id = EXCLUDED.space_id${reownLoc}, updated_at = now()`,
        [rows.map((r) => r.id), a.cls, a.toSpaceId, rows.map((r) => r.type), rows.map(ownerOf), rows.map((r) => r.deleted_at),
         rows.map((r) => r.deleted_by), rows.map((r) => r.purge_after), rows.map((r) => r.deleted_batch), ...(a.reown ? [a.reown.from, a.reown.to] : [])]);
      const changed = rows.filter((r) => r.space_id !== a.toSpaceId);
      if (changed.length) await control.query(
        `INSERT INTO space_moves (record_id, from_space_id, to_space_id, from_audience, actor_id, op)
         SELECT m.id, m.from_space, $2, m.from_audience, $3, $4 FROM unnest($1::uuid[], $5::uuid[], $6::text[]) AS m(id, from_space, from_audience)`,
        [changed.map((r) => r.id), a.toSpaceId, a.actorId, a.op, changed.map((r) => r.space_id), changed.map((r) => r.audience)]);
    }
    return { status: "moved", set, moved, extra };
  });
}
