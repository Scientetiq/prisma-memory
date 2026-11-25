// Cleanup of connectors, every 10 minutes, with the grants of memory_worker only (the
// worker never deletes connectors or items: it clears staged_key and deletes events and runs):
//   - staged bodies of items in a final state (delivered, unchanged, skipped, deleted_at_source) are removed from the
//     closed bucket and the row forgets the key; bodies of failed and held items after 7 days (the item then needs a
//     new delivery from the source); bodies no row names (an item staged again writes a new object; a deleted
//     connector leaves its objects) once they are an hour old — a staging writes the body before its row;
//   - connector_events older than 7 days;
//   - connector_runs older than 30 days, except the last 20 of each connector and its last pass (PASS_SQL of connectors-run.ts:
//     it decides whether the next run is a backfill); runs left `running` by a worker that died are closed as `interrupted`.
// The row forgets a key only while it still names that object: an item staged again in the meantime keeps its new one.
import { failureClass, STAGING_PREFIX, writeCoreDiag } from "@memory/connectors";
import { log } from "@memory/shared";
import { PASS_SQL, WEBHOOK_REQUEUE_MAX, type ConnectorRunDeps } from "./connectors-run.ts";

export const STAGED_KEEP_FAILED_DAYS = 7;
export const EVENTS_KEEP_DAYS = 7;
export const RUNS_KEEP_DAYS = 30;
export const RUNS_KEEP_LAST = 20;
/** Age of an object no row names before it is removed (a staging puts the body first and its row a moment later). */
export const ORPHAN_GRACE_MS = 3_600_000;
/** A test or a run that has been `running` this long without its worker is closed. */
export const RUNNING_STALE_MIN = 10;
/** Objects one pass removes at most (the next pass continues). */
const PASS_MAX = 1000;
/** Objects of the staging prefix one pass lists at most; a longer list skips the orphan sweep of this pass. */
const LIST_MAX = 50_000;

export interface CleanupResult { bodies: number; orphans: number; events: number; runs: number; interrupted: number; failed: number }

export async function connectorsCleanup(d: Pick<ConnectorRunDeps, "db" | "instanceId" | "storage">, now: () => number = Date.now): Promise<CleanupResult> {
  const out: CleanupResult = { bodies: 0, orphans: 0, events: 0, runs: 0, interrupted: 0, failed: 0 };
  const store = d.storage();
  if (store) {
    const { rows } = await d.db.query(
      `SELECT i.id, i.staged_key FROM connector_items i JOIN connectors c ON c.id = i.connector_id
        WHERE c.instance_id = $1 AND i.staged_key IS NOT NULL
          AND (i.status IN ('delivered', 'unchanged', 'skipped', 'deleted_at_source')
               OR (i.status IN ('failed', 'held') AND i.received_at < now() - make_interval(days => $2)))
        LIMIT $3`, [d.instanceId, STAGED_KEEP_FAILED_DAYS, PASS_MAX]);
    for (const r of rows as Array<{ id: string; staged_key: string }>) {
      try {
        await store.remove(r.staged_key);
      } catch {
        out.failed++;
        continue;
      }
      await d.db.query("UPDATE connector_items SET staged_key = NULL WHERE id = $1 AND staged_key = $2", [r.id, r.staged_key]);
      out.bodies++;
    }
    out.orphans = await orphans(d, store, now).catch((e) => {
      log.warn("connectors_cleanup_orphans_failed", { error: failureClass(e) });   // a class, never the exception
      return 0;
    });
  }
  out.events = (await d.db.query(
    `DELETE FROM connector_events e USING connectors c
      WHERE c.id = e.connector_id AND c.instance_id = $1 AND e.received_at < now() - make_interval(days => $2)`, [d.instanceId, EVENTS_KEEP_DAYS])).rowCount ?? 0;
  // a webhook refetch closed this way is queued again (all its ids: which were fetched is unknown; a refetch twice is
  // harmless), at most WEBHOOK_REQUEUE_MAX times, as a cut run of a live worker does it
  out.interrupted = (await d.db.query(
    `WITH closed AS (
       UPDATE connector_runs r SET status = 'failed', error = 'interrupted', finished_at = now()
         FROM connectors c
        WHERE c.id = r.connector_id AND c.instance_id = $1 AND r.status = 'running'
          AND r.started_at < now() - make_interval(mins => $2)
          AND NOT (r.kind <> 'test' AND COALESCE(c.lease_until > now(), false) AND COALESCE(c.lease_by, '') LIKE ('%:' || r.id::text))
        RETURNING r.connector_id, r.kind, r.detail),
     again AS (
       INSERT INTO connector_runs (id, connector_id, kind, status, detail)
       SELECT gen_random_uuid(), connector_id, 'webhook', 'queued',
              jsonb_build_object('refetch', detail -> 'refetch', 'requeued', n + 1)
         FROM (SELECT connector_id, detail, CASE WHEN jsonb_typeof(detail -> 'requeued') = 'number' THEN (detail ->> 'requeued')::numeric ELSE 0 END AS n
                 FROM closed WHERE kind = 'webhook' AND jsonb_typeof(detail -> 'refetch') = 'array' AND jsonb_array_length(detail -> 'refetch') > 0) x
        WHERE n < $3
       RETURNING 1)
     SELECT (SELECT count(*) FROM closed)::int AS closed`, [d.instanceId, RUNNING_STALE_MIN, WEBHOOK_REQUEUE_MAX])).rows[0]?.closed ?? 0;
  out.runs = (await d.db.query(
    `WITH ranked AS (
       SELECT r.id, r.created_at, r.status,
              row_number() OVER (PARTITION BY r.connector_id ORDER BY r.created_at DESC, r.id DESC) AS n,
              row_number() OVER (PARTITION BY r.connector_id, ${PASS_SQL} ORDER BY r.created_at DESC, r.id DESC) AS m,
              ${PASS_SQL} AS pass
         FROM connector_runs r JOIN connectors c ON c.id = r.connector_id WHERE c.instance_id = $1)
     DELETE FROM connector_runs x USING ranked
      WHERE x.id = ranked.id AND ranked.created_at < now() - make_interval(days => $2) AND ranked.n > $3
        AND ranked.status IN ('ok', 'failed') AND NOT (ranked.pass AND ranked.m = 1)`, [d.instanceId, RUNS_KEEP_DAYS, RUNS_KEEP_LAST])).rowCount ?? 0;
  if (out.bodies || out.orphans || out.events || out.runs || out.interrupted || out.failed) writeCoreDiag("connectors_cleanup", out);   // the closed schema of the event (counts saturate at 100 000)
  return out;
}

/** Objects of the staging prefix that no item row of this installation names, older than the grace period. */
async function orphans(d: Pick<ConnectorRunDeps, "db" | "instanceId">, store: NonNullable<ReturnType<ConnectorRunDeps["storage"]>>, now: () => number): Promise<number> {
  const list = await store.list(STAGING_PREFIX, LIST_MAX);
  const old = list.filter((o) => o.key.startsWith(STAGING_PREFIX) && o.lastModified !== null && now() - o.lastModified.getTime() > ORPHAN_GRACE_MS);
  let removed = 0;
  for (let i = 0; i < old.length && removed < PASS_MAX; i += 500) {
    const keys = old.slice(i, i + 500).map((o) => o.key);
    // a key is named by a row of any installation, or by a connector of another installation: never touched here
    const { rows } = await d.db.query(
      `SELECT k FROM unnest($1::text[]) AS k
        WHERE NOT EXISTS (SELECT 1 FROM connector_items i WHERE i.staged_key = k)
          AND NOT EXISTS (SELECT 1 FROM connectors c WHERE c.instance_id <> $2 AND k LIKE $3 || c.id::text || '/%')`,
      [keys, d.instanceId, STAGING_PREFIX]);
    for (const r of rows as Array<{ k: string }>) {
      if (removed >= PASS_MAX) break;
      try { await store.remove(r.k); removed++; } catch { /* the next pass retries */ }
    }
  }
  return removed;
}
