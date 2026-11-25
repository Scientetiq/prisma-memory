// Daily reconcile of what was sent (once a day and by a panel button): the journal's events of a day
// by UTC against the sent ones (audit_ship_sent, by id). Only days the cursor has passed are reconciled: else
// missed would mean just not sent yet. A mismatch gives the high alert audit_ship_mismatch (one per day) and
// resends the missed ids in the same chain (the cursor stays: they are older). Outcome: the admin event
// op audit_ship_reconcile (day, in_db, shipped) and reconciled_day in audit_ship_state. The same lock as sending:
// passes never overlap.
// The daily reconcile goes in order over all unreconciled days — from reconciled_day + 1 to yesterday: days
// not reconciled while they were yesterday (the worker was down over midnight, the sink down over a day — cursor
// behind) would else never be reconciled. The sent list of unreconciled days is kept: cleanup only of days older
// than reconciled_day − (SENT_KEEP_DAYS − 1); days before it have nothing to compare with — refusal sent_list_expired
// (a manual reconcile of an old day would count the whole day missed and resend it). reconciled_day never goes back.
import { LockConnectionLost, log, raiseAlert } from "@memory/shared";
import { auditWorker, type DbCtx } from "../ctx.ts";
import { idsOfDay, readByIds } from "./reader.ts";
import { ShipSinkError, type ShipSink } from "./sink.ts";
import { loadShipState, noteShipFailure, shipConfig, shipEvents, sinkFor, withShipLock } from "../jobs/audit-ship.ts";

/** Days to keep the sent list after the last reconciled one (a manual reconcile of recent days stays possible). */
export const SENT_KEEP_DAYS = 3;
/** Unreconciled days per pass (the rest go in the next pass, an hour later). */
export const RECONCILE_DAYS_PER_PASS = 7;

/** Yesterday by UTC (YYYY-MM-DD). */
export const yesterdayUtc = (now = new Date()): string => new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
const shiftDay = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const nextDay = (day: string): string => shiftDay(day, 1);

export interface ReconcileResult { day: string; in_db?: number; shipped?: number; missing?: number; resent?: number; skipped?: string; error?: string }

/** Reconcile of day (yesterday by default). sink — for tests. */
export async function reconcileDay(ctx: DbCtx, o: { day?: string; sink?: ShipSink; manual?: boolean } = {}): Promise<ReconcileResult> {
  const day = o.day ?? yesterdayUtc();
  const cfg = shipConfig(ctx.settings);
  if (cfg.mode === "off") return { day, skipped: "off" };
  if (cfg.problem) return { day, skipped: cfg.problem };
  const out = await withShipLock(ctx, async (alive): Promise<ReconcileResult> => {
    let st = await loadShipState(ctx.db.control, ctx.instanceId, cfg.mode);
    // cursor still in this day (or earlier): too early
    if (!st.cursor.at || st.cursor.at < `${nextDay(day)}T00:00:00`) return { day, skipped: "cursor_behind" };
    // this day's sent list is already cleaned: nothing to compare
    if (st.reconciledDay && day < shiftDay(st.reconciledDay, -(SENT_KEEP_DAYS - 1))) return { day, skipped: "sent_list_expired" };
    // events before the start of sending are history: sending did not take them, they are not missed
    const inDb = new Set(await idsOfDay(ctx.db.auditRead(), ctx.instanceId, day, st.start));
    const sent = new Set(((await ctx.db.control.query(
      "SELECT id::text AS id FROM audit_ship_sent WHERE instance_id = $1 AND sink = $2 AND day = $3::date", [ctx.instanceId, cfg.mode, day])).rows as Array<{ id: string }>).map((r) => r.id));
    const missing = [...inDb].filter((id) => !sent.has(id));
    let resent = 0;
    if (missing.length) {
      await raiseAlert({ control: ctx.db.control, audit: ctx.db.audit }, {
        instanceId: ctx.instanceId, level: "high", code: "audit_ship_mismatch",
        summary: `Audit log reconciliation for ${day}: ${inDb.size} in the database, ${sent.size} sent. Missing events will be resent`,
        details: { day, in_db: inDb.size, shipped: sent.size }, dedupeKey: `audit_ship_mismatch:${cfg.mode}:${day}`,
      });
      const sink = o.sink ?? sinkFor(cfg);
      try {
        for (let i = 0; i < missing.length; i += cfg.batch) {
          const events = await readByIds(ctx.db.auditRead(), ctx.instanceId, day, missing.slice(i, i + cfg.batch));
          await alive();
          st = await shipEvents(ctx, sink, st, events, false);
          resent += events.length;
        }
      } catch (e) {
        if (e instanceof LockConnectionLost) throw e;
        const code = e instanceof ShipSinkError ? e.code : "internal";
        log.warn("audit_ship_reconcile_resend_failed", { sink: cfg.mode, day, code });
        await noteShipFailure(ctx, cfg.mode, code);
        return { day, in_db: inDb.size, shipped: sent.size, missing: missing.length, resent, error: code };
      }
    }
    // reconciled_day never goes back: a repeat reconcile of recent days does not undo the reconciled ones
    const reconciled = ((await ctx.db.control.query(
      `UPDATE audit_ship_state SET reconciled_day = greatest(coalesce(reconciled_day, $3::date), $3::date)
        WHERE instance_id = $1 AND sink = $2 RETURNING to_char(reconciled_day, 'YYYY-MM-DD') AS day`, [ctx.instanceId, cfg.mode, day])).rows[0]?.day as string | undefined) ?? day;
    await ctx.db.control.query("DELETE FROM audit_ship_sent WHERE instance_id = $1 AND sink = $2 AND day < $3::date - $4::int",
      [ctx.instanceId, cfg.mode, reconciled, SENT_KEEP_DAYS - 1]);
    await auditWorker(ctx, { event_type: "admin", details: { op: "audit_ship_reconcile", day, in_db: inDb.size, shipped: sent.size, missing: missing.length, resent,
                                                           sink: cfg.mode, ...(o.manual ? { manual: true } : {}) } });
    log.info("audit_ship_reconcile", { sink: cfg.mode, day, in_db: inDb.size, shipped: sent.size, missing: missing.length, resent });
    return { day, in_db: inDb.size, shipped: sent.size, missing: missing.length, resent };
  });
  return out ?? { day, skipped: "busy" };
}

/**
 * Daily reconcile (the job checks hourly): unreconciled days in order — from reconciled_day + 1 (the first time —
 * yesterday) to yesterday, at most RECONCILE_DAYS_PER_PASS per pass. A day that cannot be reconciled yet (cursor
 * behind, lock busy, resend failed) stops the pass: the days after it are not reconciled before it.
 */
export async function reconcileDue(ctx: DbCtx, o: { manual?: boolean; now?: Date } = {}): Promise<ReconcileResult[]> {
  const cfg = shipConfig(ctx.settings);
  if (cfg.mode === "off" || cfg.problem) return [];
  const last = yesterdayUtc(o.now);
  const st = await loadShipState(ctx.db.control, ctx.instanceId, cfg.mode);
  const out: ReconcileResult[] = [];
  for (let day = st.reconciledDay ? nextDay(st.reconciledDay) : last; day <= last && out.length < RECONCILE_DAYS_PER_PASS; day = nextDay(day)) {
    const r = await reconcileDay(ctx, { day, ...(o.manual ? { manual: true } : {}) });
    out.push(r);
    if (r.skipped || r.error) break;
  }
  return out;
}
