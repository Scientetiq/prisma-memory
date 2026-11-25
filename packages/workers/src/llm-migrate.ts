// Move to smart retry — worker start steps before the scheduler and the dispatcher.
import { log, type DataClass } from "@memory/shared";
import { recordsDb, type DbCtx } from "./ctx.ts";
import { LLM_QUEUES } from "./scheduler.ts";

/**
 * Model stage jobs queued by the old code were retried by pg-boss itself (retryLimit 3): a retry past record_stages
 * would call the model again without wait rules. Retries are now led by the stage — old jobs lose their retry.
 */
export async function fixLlmJobs(ctx: Pick<DbCtx, "db">): Promise<number> {
  const r = await ctx.db.control.query(
    "UPDATE pgboss.job SET retry_limit = 0 WHERE name = ANY($1) AND state IN ('created','retry','active') AND retry_limit <> 0", [LLM_QUEUES]);
  if (r.rowCount) log.info("llm_jobs_fixed", { jobs: r.rowCount });
  return r.rowCount ?? 0;
}

const MARK = "migr_39_llm_retry";

/**
 * A one-off move of the stuck: model stages failed by the old code due to a busy model or a timeout are not record
 * errors. They return to the model wait (pending, attempts from zero, wait start —
 * failure time); the scheduler queues them by the new rules. A maintenance_state mark prevents a second move after
 * a rollback to the old image and a redeploy. New code creates no such failed.
 */
export async function migrateStuckLlmFailures(ctx: DbCtx): Promise<{ migrated: boolean; open: number; closed: number }> {
  const done = await ctx.db.control.query("SELECT 1 FROM maintenance_state WHERE instance_id = $1 AND key = $2", [ctx.instanceId, MARK]);
  if (done.rowCount) return { migrated: false, open: 0, closed: 0 };
  const n: Record<DataClass, number> = { open: 0, closed: 0 };
  for (const cls of ["open", "closed"] as DataClass[]) {
    const r = await recordsDb(ctx, cls).query(
      `UPDATE record_stages SET status = 'pending', attempts = 0, busy_retries = GREATEST(busy_retries, attempts),
              first_busy_at = COALESCE(first_busy_at, updated_at), retry_at = NULL,
              last_error = left('model_busy: ' || last_error, 200), updated_at = now()
        WHERE status = 'failed' AND NOT terminal AND stage IN ('summary','events','described')
          AND (last_error LIKE 'platform_busy%' OR last_error LIKE 'llm_timeout%')`);
    n[cls] = r.rowCount ?? 0;
  }
  await ctx.db.control.query(
    `INSERT INTO maintenance_state (instance_id, key, value) VALUES ($1, $2, jsonb_build_object('at', now(), 'open', $3::int, 'closed', $4::int))
     ON CONFLICT (instance_id, key) DO NOTHING`, [ctx.instanceId, MARK, n.open, n.closed]);
  log.info("llm_migration_39", { open: n.open, closed: n.closed });
  return { migrated: true, ...n };
}
