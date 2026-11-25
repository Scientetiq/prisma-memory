// Admin-plane worker jobs. index.ts calls registerAdminPlaneJobs once at start:
//   audit_ship            — journal shipping out: a check every 5 s, a pass once per observability.audit_ship_interval_sec;
//                           after a sink failure — backoff doubling up to 5 min, reset by the first success;
//   audit_ship_reconcile  — reconcile unreconciled days in order up to yesterday: hourly check (each day reconciled
//                           once) and by a panel button (pg-boss queue audit_ship_reconcile; nothing
//                           to catch up — yesterday again);
//   alert_mail            — mails about high alerts, every 15 s;
//   alert_digest          — digest of medium alerts, checked hourly (the mail at admin.alert_digest_hour);
//   obo_read_watch        — on-behalf reads of many people, hourly;
//   security_mode_watch   — security mode: too few admins, an unfinished switch-on, a pending rollback, hourly;
//   admin_plane_gc        — admin-plane table terms and orphans, hourly;
//   obo_consent_sweep     — consents of off services and inactive people, every minute.
// Passes of one job never overlap in a process (a chain); between processes — locks inside the passes (shipping and
// reconcile — audit_ship:<instance>, mails — FOR UPDATE SKIP LOCKED). All that is off by default stays off:
// audit_ship_mode = off — no shipping or reconcile; no recipients or mail — no mails, alerts only in the panel.
import { ALERT_MAIL_EVERY_MS, log } from "@memory/shared";
import type { Ctx, DbCtx } from "../ctx.ts";
import { alertDigestPass, alertMailPass } from "./alert-digest.ts";
import { adminPlaneGc, oboConsentSweep } from "./admin-plane-gc.ts";
import { auditShipPass, closeShipSink, SHIP_BACKOFF_MAX_MS, shipConfig } from "./audit-ship.ts";
import { oboReadWatch } from "./obo-read-watch.ts";
import { securityModeWatch } from "./security-mode-watch.ts";
import { reconcileDay, reconcileDue } from "../audit-ship/reconcile.ts";

/** Registrar of a periodic job (as every in index.ts): interval, log name, pass. */
export type Every = (ms: number, name: string, fn: () => Promise<unknown>) => unknown;

/** How often to check if the journal is due (the pass itself goes by audit_ship_interval_sec). */
export const SHIP_TICK_MS = 5_000;
const HOUR_MS = 3_600_000;
/** How often to close consents of off services and inactive people (beyond the hourly admin_plane_gc). */
export const CONSENT_SWEEP_MS = 60_000;
/** Reconcile-now queue (gateway: POST /api/v1/admin/audit-ship/reconcile). */
export const RECONCILE_QUEUE = "audit_ship_reconcile";

/** Pass chain in a process: each waits for the previous; one failure does not break it. */
function chain(): (fn: () => Promise<unknown>) => Promise<unknown> {
  let run: Promise<unknown> = Promise.resolve();
  return (fn) => (run = run.catch(() => undefined).then(fn));
}

/** Manual passes for run-job (white box and operations): the same as the jobs do, at once. */
// a syslog sink connection would keep run-job alive after the pass — it is closed at once
const once = <T>(p: () => Promise<T>) => async (): Promise<T> => { try { return await p(); } finally { await closeShipSink(); } };
export const ADMIN_PLANE_JOBS: Record<string, (ctx: DbCtx, args: string[]) => Promise<unknown>> = {
  audit_ship: (ctx) => once(() => auditShipPass(ctx))(),
  // audit_ship_reconcile [YYYY-MM-DD] — reconcile that day; no date: unreconciled days in order, none — yesterday
  audit_ship_reconcile: (ctx, args) => once(async () => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(args[0] ?? "")) return reconcileDay(ctx, { manual: true, day: args[0] });
    const due = await reconcileDue(ctx, { manual: true });
    return due.length ? due : [await reconcileDay(ctx, { manual: true })];
  })(),
  alert_mail: (ctx) => alertMailPass(ctx),
  // alert_digest [--force] — digest now, not waiting for admin.alert_digest_hour
  alert_digest: (ctx, args) => alertDigestPass(ctx, { force: args.includes("--force") }),
  obo_read_watch: (ctx) => oboReadWatch(ctx),
  security_mode_watch: (ctx) => securityModeWatch(ctx),
  obo_consent_sweep: (ctx) => oboConsentSweep(ctx),
  admin_plane_gc: (ctx) => adminPlaneGc(ctx),
};

export function registerAdminPlaneJobs(ctx: Ctx, every: Every): void {
  // shipping: 5 s tick, pass by the settings interval; backoff after failure
  const ship = chain();
  let nextAt = 0, backoffMs = 0;
  every(SHIP_TICK_MS, "audit_ship", () => ship(async () => {
    const cfg = shipConfig(ctx.settings);
    if (cfg.mode === "off" || Date.now() < nextAt) return;
    const intervalMs = (cfg.problem ? 60 : cfg.intervalSec) * 1000;
    const r = await auditShipPass(ctx);
    if (r.error) backoffMs = Math.min(SHIP_BACKOFF_MAX_MS, Math.max(intervalMs, backoffMs * 2));
    else backoffMs = 0;
    nextAt = Date.now() + (r.error ? backoffMs : intervalMs);
  }));

  const reconcile = chain();
  every(HOUR_MS, "audit_ship_reconcile", () => reconcile(() => reconcileDue(ctx)));
  void (async () => {
    const cur = await ctx.boss.getQueue(RECONCILE_QUEUE);
    if (cur?.policy !== "stately") {
      if (cur) await ctx.boss.deleteQueue(RECONCILE_QUEUE);
      await ctx.boss.createQueue(RECONCILE_QUEUE, { policy: "stately" });
    }
    // reconcile now: unreconciled days in order, and if there are none — yesterday again
    await ctx.boss.work(RECONCILE_QUEUE, { batchSize: 1 } as any, async () => {
      await reconcile(async () => { if (!(await reconcileDue(ctx, { manual: true })).length) await reconcileDay(ctx, { manual: true }); });
    });
  })().catch((e: unknown) => log.warn("audit_ship_reconcile_queue_failed", { error: ((e as Error)?.message ?? "").slice(0, 200) }));

  const mail = chain();
  every(ALERT_MAIL_EVERY_MS, "alert_mail", () => mail(() => alertMailPass(ctx)));
  const digest = chain();
  every(HOUR_MS, "alert_digest", () => digest(() => alertDigestPass(ctx)));
  const watch = chain();
  every(HOUR_MS, "obo_read_watch", () => watch(() => oboReadWatch(ctx)));
  every(HOUR_MS, "security_mode_watch", () => watch(() => securityModeWatch(ctx)));
  const gc = chain();
  every(HOUR_MS, "admin_plane_gc", () => gc(() => adminPlaneGc(ctx)));
  // consents of off services and departed people — every minute (same chain as the terms): else turning obo_read off and
  // on again between two hourly passes would bring all old consents back into force
  every(CONSENT_SWEEP_MS, "obo_consent_sweep", () => gc(() => oboConsentSweep(ctx)));
}
