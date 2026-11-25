// Reading the journal to send it out — pool memory_audit_reader (db.auditRead()). The cursor is a pair (at, id):
// events of one time differ by id and are not lost. Time is text with microseconds in UTC: a JS Date holds only
// milliseconds, and a cursor from a Date would pick the same-millisecond event again. Delay lag: younger events wait,
// so late transactions can commit (what still lands behind the cursor the reconcile sends, reconcile.ts).
// details are cut to the allow list in the DB: query_text and details content never reach the process.
// Bound before (exclusive) — the time of the oldest row of the interim journal audit_spool that the worker has not yet
// moved (audit-ship.ts, spoolHold): a moved row lands in audit_events with its old time, and a cursor
// gone past it would no longer see it.
// Days by UTC (as audit_ship_sent.day and file names): bounds are set in UTC explicitly, not by casting date to timestamptz —
// that follows the session zone: a TimeZone other than UTC shifts days (the reconcile sees a false gap each day).
import type pg from "pg";
import { SHIP_DETAIL_KEYS, type ShipEvent } from "./line.ts";

type Queryable = Pick<pg.Pool, "query">;
export interface ShipCursor { at: string | null; id: string | null }

/** Event time as text: ISO 8601 UTC with microseconds (as the cursor is written). */
export const AT_TEXT = (col = "at"): string => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const COLS = `id::text AS id, ${AT_TEXT()} AS at, event_type, principal_type, principal_id::text AS principal_id, service_id::text AS service_id,
  on_behalf_of::text AS on_behalf_of, key_id::text AS key_id, tier, class, result_count, cardinality(record_ids) AS records,
  (SELECT coalesce(jsonb_object_agg(k, v), '{}'::jsonb) FROM jsonb_each(details) AS d(k, v) WHERE k = ANY($2::text[])) AS details`;

/** Start of day (YYYY-MM-DD) by UTC and start of the next — SQL for parameter $n. */
const dayFrom = (n: number) => `($${n}::date)::timestamp AT TIME ZONE 'UTC'`;
const dayTo = (n: number) => `($${n}::date + 1)::timestamp AT TIME ZONE 'UTC'`;

/** Next batch after the cursor: older than lag s, earlier than `before` (if set), by (at, id). */
export async function readAfter(pool: Queryable, instanceId: string, cursor: ShipCursor,
                                o: { lagSec: number; batch: number; before?: string | null }): Promise<ShipEvent[]> {
  const args: unknown[] = [instanceId, [...SHIP_DETAIL_KEYS], o.lagSec, o.batch];
  let after = "";
  if (cursor.at && cursor.id) {
    args.push(cursor.at, cursor.id);
    // at >= for the partitions and audit_events_at_idx; the pair: exact bound
    after = ` AND at >= $${args.length - 1}::timestamptz AND (at, id) > ($${args.length - 1}::timestamptz, $${args.length}::uuid)`;
  }
  if (o.before) {
    args.push(o.before);
    after += ` AND at < $${args.length}::timestamptz`;
  }
  const { rows } = await pool.query(
    `SELECT ${COLS} FROM audit_events
      WHERE instance_id = $1 AND at < now() - make_interval(secs => $3::int)${after}
      ORDER BY at, id LIMIT $4`, args);
  return rows as ShipEvent[];
}

/** Events by id of a day (resending what reconcile missed); order (at, id). */
export async function readByIds(pool: Queryable, instanceId: string, day: string, ids: readonly string[]): Promise<ShipEvent[]> {
  if (!ids.length) return [];
  const { rows } = await pool.query(
    `SELECT ${COLS} FROM audit_events
      WHERE instance_id = $1 AND at >= ${dayFrom(3)} AND at < ${dayTo(3)} AND id = ANY($4::uuid[])
      ORDER BY at, id`, [instanceId, [...SHIP_DETAIL_KEYS], day, [...ids]]);
  return rows as ShipEvent[];
}

/**
 * Event ids of a day by UTC — for the reconcile (ids only). from is where sending started: before its
 * time is history the sending did not take; the reconcile does not count it missed. Bound by time, as for the cursor
 * of the start (it is a microsecond earlier): events in the same microsecond as the start are fresh.
 */
export async function idsOfDay(pool: Queryable, instanceId: string, day: string, from?: ShipCursor | null): Promise<string[]> {
  const args: unknown[] = [instanceId, day];
  let since = "";
  if (from?.at) { args.push(from.at); since = " AND at >= $3::timestamptz"; }
  const { rows } = await pool.query(
    `SELECT id::text AS id FROM audit_events WHERE instance_id = $1 AND at >= ${dayFrom(2)} AND at < ${dayTo(2)}${since}`, args);
  return rows.map((r: { id: string }) => r.id);
}

/** Age in seconds of the oldest event after the cursor that may already be sent (older than lag); null — none. */
export async function pendingAgeSec(pool: Queryable, instanceId: string, cursor: ShipCursor, lagSec: number): Promise<number | null> {
  const args: unknown[] = [instanceId, lagSec];
  let after = "";
  if (cursor.at && cursor.id) { args.push(cursor.at, cursor.id); after = " AND at >= $3::timestamptz AND (at, id) > ($3::timestamptz, $4::uuid)"; }
  const { rows } = await pool.query(
    `SELECT extract(epoch FROM now() - min(at))::int AS age FROM audit_events
      WHERE instance_id = $1 AND at < now() - make_interval(secs => $2::int)${after}`, args);
  const age = rows[0]?.age;
  return age === null || age === undefined ? null : Number(age);
}
