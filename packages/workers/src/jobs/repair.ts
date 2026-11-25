// One-off pass (run-job.ts repair_restored): fixes what got broken before the fix.
//  1) Stages of records restored from trash, skipped by the handler while the record was in trash — pending again
//     in the night lane. Before, a trashed record's stage stayed skipped for good, and after restore summary and
//     index never appeared. Restored — by the journal: event forget with action = restore (owner.ts
//     restoreFromTrash; record_ids has the whole batch: root and derived), and the skip is no later than the restore
//     (live records with no restore are left alone). A skip with no reason (status skipped, last_error NULL) of a live
//     current record is either the trash or empty text: a retry finishes the work or skips again with no model call.
//     Skips for a new version or a person's fix (superseded, suppressed — with last_error) are left alone. Waiting
//     for restore (pending, in_trash) on an already restored record — no in-trash reason.
//     At night: affected records lose process_now_at (transcriber meetings get it on intake and
//     keep it forever) — fixing old records does not hold the model by day. As in reextract, the mark stays if the record
//     has another stage that will run on its own: a fresh process-now request is not lost.
//  2) Search fragments whose space or visibility differs from the record: indexing that ran during a record move
//     wrote the old space, and text search missed the record in the new one.
// Idempotent: the mark maintenance_state.repair_restored keeps the first pass time, and a repeat touches only stages
// skipped before it (skipped again later — a lawful skip). Only counters go to the log and answer.
import { log, type DataClass } from "@memory/shared";
import { recordsDb, type DbCtx } from "../ctx.ts";
import { TOO_SLOW_PREFIX } from "../stages.ts";

const MARK = "repair_restored";

export interface RepairRestored { since: string; first: boolean; restored: number; stages: Record<DataClass, number>; night: Record<DataClass, number>; chunks: Record<DataClass, number> }

/**
 * Records restored from the trash and when (the last restore): event forget with action = restore. The journal is read
 * by memory_audit_reader (Databases.auditRead): workers have no SELECT on audit_events.
 */
async function restoredAt(ctx: DbCtx): Promise<Map<string, string>> {
  const { rows } = await ctx.db.auditRead().query(
    `SELECT x AS id, max(e.at) AS at FROM audit_events e CROSS JOIN LATERAL unnest(e.record_ids) AS x
      WHERE e.instance_id = $1 AND e.event_type = 'forget' AND e.details->>'action' = 'restore'
      GROUP BY x`, [ctx.instanceId]);
  return new Map(rows.map((r) => [r.id as string, new Date(r.at).toISOString()]));
}

export async function repairRestored(ctx: DbCtx): Promise<RepairRestored> {
  const prev = (await ctx.db.control.query("SELECT value->>'at' AS at FROM maintenance_state WHERE instance_id = $1 AND key = $2", [ctx.instanceId, MARK])).rows[0]?.at as string | undefined;
  const since = prev ?? new Date((await ctx.db.control.query("SELECT now() AS at")).rows[0].at).toISOString();
  const restored = await restoredAt(ctx);
  const ids = [...restored.keys()], ats = ids.map((id) => restored.get(id)!);
  const limit = ctx.settings.get<{ limit: number }>("processing.retries", { limit: 3 }).limit;
  const out: RepairRestored = { since, first: !prev, restored: ids.length, stages: { open: 0, closed: 0 }, night: { open: 0, closed: 0 }, chunks: { open: 0, closed: 0 } };
  for (const cls of ["open", "closed"] as DataClass[]) {
    const db = recordsDb(ctx, cls);
    // the CTE snapshot predates the updates: reset stages are still skipped or pending in-trash there, so another stage that
    // will run is sought past reset ones
    const r = (await db.query(
      `WITH restored AS (SELECT * FROM unnest($1::uuid[], $2::timestamptz[]) AS x(id, at)),
            reset AS (
              UPDATE record_stages s SET status = 'pending', attempts = 0, last_error = NULL, version = NULL, terminal = false, retry_at = NULL, updated_at = now()
                FROM records r
               WHERE r.id = s.record_id AND r.deleted_at IS NULL AND r.is_current AND r.hidden_at IS NULL
                 AND ((s.status = 'skipped' AND s.last_error IS NULL AND s.updated_at < $3::timestamptz
                       AND EXISTS (SELECT 1 FROM restored x WHERE x.id = r.id AND s.updated_at <= x.at))
                      OR (s.status = 'pending' AND COALESCE(s.last_error, '') LIKE 'in_trash:%'))
              RETURNING s.record_id, s.stage),
            calm AS (
              UPDATE records r SET attrs = r.attrs - 'process_now_at'
               WHERE r.id IN (SELECT record_id FROM reset) AND r.attrs ? 'process_now_at'
                 AND NOT EXISTS (SELECT 1 FROM record_stages o
                                  WHERE o.record_id = r.id AND NOT EXISTS (SELECT 1 FROM reset t WHERE t.record_id = o.record_id AND t.stage = o.stage)
                                    AND (o.status IN ('pending','running')
                                         OR (o.status = 'failed' AND NOT o.terminal AND o.attempts < $4 AND COALESCE(o.last_error, '') NOT LIKE '${TOO_SLOW_PREFIX}%')))
              RETURNING r.id)
       SELECT (SELECT count(*) FROM reset)::int AS stages, (SELECT count(*) FROM calm)::int AS night`, [ids, ats, since, limit])).rows[0];
    out.stages[cls] = Number(r?.stages ?? 0);
    out.night[cls] = Number(r?.night ?? 0);
    out.chunks[cls] = (await db.query(
      `UPDATE chunks c SET space_id = r.space_id, audience = r.audience
         FROM records r
        WHERE r.id = c.record_id AND (c.space_id IS DISTINCT FROM r.space_id OR c.audience IS DISTINCT FROM r.audience)`)).rowCount ?? 0;
  }
  if (!prev)
    await ctx.db.control.query(
      `INSERT INTO maintenance_state (instance_id, key, value, updated_at) VALUES ($1, $2, $3::jsonb, now()) ON CONFLICT (instance_id, key) DO NOTHING`,
      [ctx.instanceId, MARK, JSON.stringify({ at: since, restored: out.restored, stages: out.stages, night: out.night, chunks: out.chunks })]);
  log.info("repair_restored", { first: out.first, restored: out.restored, stages: out.stages, night: out.night, chunks: out.chunks });
  return out;
}
