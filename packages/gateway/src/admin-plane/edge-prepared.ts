// The edge-prepared mark. A row edge_prepared that is never reset
// in the control database: after it, turning off alert mail, removing an address from admin.alert_recipients or clearing the list
// and cancelling an alert letter in the queue is only for a person in a personal session (the core group always). Why the control
// database, not the log: the perimeter lock (externalContourLock) is an advisory lock of its own database; the log is elsewhere.
// Source: the first ops event host_mode_facts with a date in edge_tls_not_after or ca_edge_tls not none in pki_roots_not_after
// (issuing certificates of the bridge roles; relay_credentials is no sign). Set by:
//   - the host's ops event job — before writing such an event, as superuser, under the same lock (the main path in a deployment);
//   - the gateway at every start (markEdgePreparedAtStart) if such an event is already in the log: a preparation from before,
//     a restored old copy of the control database. The gateway reads the log with the log read pool (memory_gateway has only
//     INSERT on audit_events); the mark is set by the function edge_prepared_mark, under the perimeter lock.
// Read by: saving PUT /settings in its transaction after the perimeter lock (contourCheck), cancelling a letter (mail-admin.ts),
// recovery on the server (cli.ts).
// The start check gave no definite outcome (the log or the database did not answer) —
// the state is unknown: while so, edgePrepared() answers prepared (the strict side: only a person turns mail
// off); the gateway repeats the check every EDGE_PREPARED_RETRY_MS; after EDGE_PREPARED_ALERT_AFTER failed tries — a medium
// alert edge_prepared_unverified once a day until the outcome is definite. The process does not stop.
import { log, raiseAlert } from "@memory/shared";
import type { App } from "../context.ts";

/** After how long to repeat the start check of the mark if it gave no outcome. */
export const EDGE_PREPARED_RETRY_MS = 60_000;
/** After how many failed repeats in a row — a medium alert edge_prepared_unverified (then once a day while unknown). */
export const EDGE_PREPARED_ALERT_AFTER = 5;

/**
 * The outcome of the start check: idle — the check did not run (tests, CLI without the gateway: the table is read as before);
 * unknown — it ran, no outcome (the strict side); known — the mark was read, set or surely not needed.
 */
let startState: "idle" | "unknown" | "known" = "idle";
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let failures = 0;

/** The outcome of the mark check at gateway start (for tests and process facts). */
export function edgePreparedStartState(): "idle" | "unknown" | "known" {
  return startState;
}

/** The perimeter lock key: saving PUT /settings, the edge-prepared mark, cancelling an alert letter and recovery
 * on the server take pg_advisory_xact_lock(hashtextextended(key, 0)) — the same as the host's ops event job. */
export const externalContourLock = (app: Pick<App, "instanceId">): string => `external-contour:${app.instanceId}`;

/** The host_mode_facts event says that the edge is prepared (as the certStep sign of the worker ops-alerts.ts). */
export const EDGE_PREPARED_EVENT_SQL = `event_type = 'ops' AND details->>'code' = 'host_mode_facts'
  AND (details->>'edge_tls_not_after' ~ '=[0-9]{4}-'
       OR (details->>'pki_roots_not_after' ~ '(^|,)ca_edge_tls=' AND details->>'pki_roots_not_after' !~ '(^|,)ca_edge_tls=none(,|$)'))`;

/**
 * Whether the edge is prepared: the edge_prepared mark. No table (an older schema) — no. inTx — read in a transaction under
 * the perimeter lock: a query error there aborts the transaction, so to_regclass first, and the error goes up. A read error
 * of the pool — yes: doubt goes to the side of a person's session. The start check still without an outcome — yes without a query
 * (a preparation event may be in the log while the mark is not set yet).
 */
export async function edgePrepared(q: Pick<App["db"]["control"], "query">, instanceId: string, o: { inTx?: boolean } = {}): Promise<boolean> {
  if (startState === "unknown") return true;
  const read = (): Promise<boolean> => readMark(q, instanceId);
  if (o.inTx) return read();
  return read().catch((e: unknown) => { log.warn("edge_prepared_read_failed", { error: ((e as Error)?.message ?? "").slice(0, 160) }); return true; });
}

/** Read the mark bypassing the start state (the start check itself is the source of the outcome). */
async function readMark(q: Pick<App["db"]["control"], "query">, instanceId: string): Promise<boolean> {
  const has = (await q.query("SELECT to_regclass('edge_prepared') IS NOT NULL AS ok")).rows[0]?.ok === true;
  if (!has) return false;
  return ((await q.query("SELECT 1 FROM edge_prepared WHERE instance_id = $1", [instanceId])).rowCount ?? 0) > 0;
}

/**
 * At gateway start: the log has an edge preparation event but there is no mark — set it (edge_prepared_mark, via
 * gateway_start). Result: true — set now. A definite outcome (the mark exists, set, no function, no event in the
 * log) — state known; a database or log error — unknown (the strict side until the next check) and a log line.
 */
export async function markEdgePreparedAtStart(app: Pick<App, "db" | "instanceId">): Promise<boolean> {
  try {
    if (await readMark(app.db.control, app.instanceId)) { startState = "known"; return false; }
    const has = (await app.db.control.query("SELECT to_regprocedure('edge_prepared_mark(text,text)') IS NOT NULL AS ok")).rows[0]?.ok === true;
    if (!has) { startState = "known"; return false; }
    const ev = await app.db.auditRead().query(`SELECT 1 FROM audit_events WHERE instance_id = $1 AND ${EDGE_PREPARED_EVENT_SQL} LIMIT 1`, [app.instanceId]);
    if (!(ev.rowCount ?? 0)) { startState = "known"; return false; }
    const r = await app.db.control.query("SELECT edge_prepared_mark($1, 'gateway_start') AS ok", [app.instanceId]);
    const marked = r.rows[0]?.ok === true;
    if (marked) log.info("edge_prepared_marked", { via: "gateway_start" });
    startState = "known";
    return marked;
  } catch (e) {
    startState = "unknown";
    log.warn("edge_prepared_mark_failed", { error: ((e as Error)?.message ?? "").slice(0, 200) });
    return false;
  }
}

/**
 * Gateway start (index.ts): the mark check before taking requests; no outcome — a repeat every intervalMs (an unref timer,
 * not holding the process) until there is an outcome; after alertAfter failed tries — a medium alert edge_prepared_unverified,
 * once a day (a repeat key with the date) while the outcome is unknown. Result — as markEdgePreparedAtStart of the first try.
 */
export async function retryEdgePreparedUntilKnown(app: Pick<App, "db" | "instanceId">,
                                                  o: { intervalMs?: number; alertAfter?: number } = {}): Promise<boolean> {
  const intervalMs = o.intervalMs ?? EDGE_PREPARED_RETRY_MS, alertAfter = o.alertAfter ?? EDGE_PREPARED_ALERT_AFTER;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  failures = 0;
  startState = "unknown";   // until the first answer — the strict side
  const marked = await markEdgePreparedAtStart(app);
  const again = (): void => {
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void markEdgePreparedAtStart(app).then(async () => {
        if (edgePreparedStartState() === "known") { log.info("edge_prepared_known", { retries: failures + 1 }); failures = 0; return; }
        failures += 1;
        if (failures >= alertAfter)
          await raiseAlert({ control: app.db.control, audit: app.db.audit }, {
            instanceId: app.instanceId, level: "medium", code: "edge_prepared_unverified",
            summary: `The gateway could not verify the “edge prepared” marker ${failures + 1} times in a row. Until the check passes, a person must use their own session to turn off alert e-mail`,
            details: { retries: failures, interval_ms: intervalMs }, dedupeKey: `edge_prepared_unverified:${new Date().toISOString().slice(0, 10)}`,
          }).catch(() => undefined);
        again();
      });
    }, intervalMs);
    retryTimer.unref?.();
  };
  if (edgePreparedStartState() !== "known") again();
  return marked;
}

/** For tests: forget the start check outcome and stop the repeat. */
export function resetEdgePreparedStateForTests(): void {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  startState = "idle";
  failures = 0;
}
