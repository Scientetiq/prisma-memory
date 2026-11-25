// Audit of model calls outside `models.allow_closed`. The facade reports every such
// call to `Platform.onModelGate` (allowed: an open record to a pair of `models.allow_open`; refused: everything else). How
// it reaches the audit log is `models.audit_calls`:
//   each   — one event per call (the earlier behaviour; the code fallback, so an unset key or an unpinned anchor
//            keeps the full journal);
//   hourly — the allowed calls are summed in memory per role, host, model, data class and hour (UTC) and written as an
//            event of the same type with `count` and `hour`, when the next hour starts and on shutdown; every refusal is
//            still written at once, one by one.
// The sums are per process and per run: the gateway and the workers keep their own, a restart inside the hour and the
// memory cap write further rows, so one pair may have SEVERAL summary rows for the same `hour` — a reader sums `count`.
// A summary whose write fails is put back (same hour) and written again after GATE_AUDIT_RETRY_MS or at the next stop, at
// most GATE_AUDIT_MAX_ATTEMPTS times; then it is given up with the error line `t1_gate_audit_lost` naming its count. A
// single event (each mode, a refusal) is not retried — as before. `stop()` waits for the writes at most
// GATE_AUDIT_STOP_WAIT_MS: an audit database that does not answer never holds the shutdown. A crash of the process loses
// at most the open hour of allowed-call counts (refusals are never held back). At the memory cap a new key is written as
// a single event instead of being dropped.
import { log } from "../log.ts";
import type { ModelGateEvent } from "../platform.ts";
import type { ConnectionSettings } from "./types.ts";
import { POLICY_AUDIT_CALLS } from "./policy.ts";

/** A value of `models.audit_calls`. */
export type AuditCallsMode = (typeof POLICY_AUDIT_CALLS)[number];
/** Keys of one hour held in memory at most; a call of a new key beyond it is written as a single event. */
export const GATE_AUDIT_MAX_KEYS = 10_000;
/** `stop()` waits this long at most for the writes it started; the rest goes on in the background. */
export const GATE_AUDIT_STOP_WAIT_MS = 3_000;
/** A summary whose write failed is written again after this delay (or at the next `stop()`). */
export const GATE_AUDIT_RETRY_MS = 60_000;
/** Failed writes of one summary before it is given up (with the error line `t1_gate_audit_lost`). */
export const GATE_AUDIT_MAX_ATTEMPTS = 5;
const HOUR_MS = 3_600_000;
/** The timer fires this long after the hour starts, so that a call of the last millisecond of the hour is in its sum. */
const TIMER_SLACK_MS = 1_000;

/**
 * The mode of the audit of model calls: `hourly` only when the setting says so; unset or cleared, unpinned under anchors
 * (the code fallback) or any other string — `each`, the strict side. A stored value of a wrong JSON type (reachable only
 * past the API, which refuses it) reads as the seed default, as for every key of `Settings.get`.
 */
export function auditCallsMode(settings: Pick<ConnectionSettings, "get">): AuditCallsMode {
  return settings.get<unknown>("models.audit_calls", "each") === "hourly" ? "hourly" : "each";
}

/**
 * What is written: a call as the facade reported it, or the summary of one hour — the fields of the calls (without
 * `stage`) plus `count` (allowed calls in the hour) and `hour` (its start, ISO 8601 UTC, e.g. `2026-11-15T10:00:00Z`).
 */
export type ModelGateAuditEvent = ModelGateEvent | (Omit<ModelGateEvent, "stage"> & { count: number; hour: string });

export interface ModelGateAuditOptions {
  settings: Pick<ConnectionSettings, "get">;
  /**
   * Writes one event to the audit log; a returned promise is awaited by `stop()` (for a bounded time). It must throw or
   * reject when the write failed (after logging it): a failed summary is then put back and written again. Must not depend
   * on the caller.
   */
  write: (e: ModelGateAuditEvent) => void | Promise<unknown>;
  /** The longest wait of `stop()` for the writes it started (tests). */
  stopWaitMs?: number;
  /** Clock (tests). */
  now?: () => number;
}

interface Bucket { hourStart: number; event: Omit<ModelGateEvent, "stage">; count: number; attempts: number; retryAt: number }

const hourOf = (t: number) => Math.floor(t / HOUR_MS) * HOUR_MS;
const hourIso = (t: number) => new Date(t).toISOString().replace(/\.000Z$/, "Z");

/** One per process: receives every `onModelGate` report and writes the audit events by `models.audit_calls`. */
export class ModelGateAudit {
  private readonly buckets = new Map<string, Bucket>();
  private readonly pending = new Set<Promise<unknown>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;

  constructor(private readonly o: ModelGateAuditOptions) { this.now = o.now ?? Date.now; }

  /** One call reported by the facade. Never throws. */
  record(e: ModelGateEvent): void {
    if (!e.allowed || auditCallsMode(this.o.settings) === "each") { this.emit(e); return; }
    const t = this.now(), hourStart = hourOf(t);
    this.flushBefore(hourStart);
    const key = JSON.stringify([hourStart, e.role, e.endpoint, e.alias, e.dataClass, e.purpose, e.reason]);
    const held = this.buckets.get(key);
    if (held) { held.count++; return; }
    if (this.buckets.size >= GATE_AUDIT_MAX_KEYS) { this.emit(e); return; }
    const { stage: _stage, ...event } = e;
    this.buckets.set(key, { hourStart, event, count: 1, attempts: 0, retryAt: 0 });
  }

  /** Writes the sums of the hours that are over. */
  flush(): void { this.flushBefore(hourOf(this.now())); }

  /** Starts the timer that writes the sums when an hour starts (does not keep the process alive). */
  start(): void {
    if (this.timer) return;
    const arm = () => {
      const t = this.now();
      this.timer = setTimeout(() => { this.flush(); arm(); }, hourOf(t) + HOUR_MS - t + TIMER_SLACK_MS);
      (this.timer as { unref?: () => void }).unref?.();
    };
    arm();
  }

  /**
   * Shutdown: stops the timers, writes every sum held (the open hour too, and the ones put back after a failed write) and
   * waits for the writes started — at most `stopWaitMs`. May be called again (calls that arrive after it are summed and
   * written by the next call). Never rejects.
   */
  async stop(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.flushBefore(Infinity, true);
    if (!this.pending.size) return;
    let wait: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      Promise.allSettled([...this.pending]).then(() => false),
      new Promise<boolean>((r) => { wait = setTimeout(() => r(true), this.o.stopWaitMs ?? GATE_AUDIT_STOP_WAIT_MS); (wait as { unref?: () => void }).unref?.(); }),
    ]);
    clearTimeout(wait);
    if (timedOut) log.warn("t1_gate_audit_stop_timeout", { pending: this.pending.size });
  }

  private flushBefore(hourStart: number, force = false): void {
    const t = this.now(), due: Array<[string, Bucket]> = [];
    for (const [key, b] of this.buckets) if (b.hourStart < hourStart && (force || b.retryAt <= t)) due.push([key, b]);
    // taken out first, written after: a write that throws at once puts its sum back without being retried in this loop
    for (const [key] of due) this.buckets.delete(key);
    for (const [key, b] of due) this.emit({ ...b.event, count: b.count, hour: hourIso(b.hourStart) }, () => this.putBack(key, b));
  }

  /** A summary whose write failed: back into its bucket (same hour, counts added), or given up after the last attempt. */
  private putBack(key: string, b: Bucket): void {
    const attempts = b.attempts + 1;
    if (attempts >= GATE_AUDIT_MAX_ATTEMPTS) {
      log.error("t1_gate_audit_lost", { count: b.count, hour: hourIso(b.hourStart), role: b.event.role, endpoint: b.event.endpoint, alias: b.event.alias, attempts });
      return;
    }
    const retryAt = this.now() + GATE_AUDIT_RETRY_MS;
    const held = this.buckets.get(key);
    // a key put back may go past the memory cap: it was held before, and it is given up after GATE_AUDIT_MAX_ATTEMPTS
    if (held) { held.count += b.count; held.attempts = Math.max(held.attempts, attempts); held.retryAt = retryAt; }
    else this.buckets.set(key, { ...b, attempts, retryAt });
    if (this.timer && !this.retryTimer) {
      this.retryTimer = setTimeout(() => { this.retryTimer = null; this.flush(); }, GATE_AUDIT_RETRY_MS + TIMER_SLACK_MS);
      (this.retryTimer as { unref?: () => void }).unref?.();
    }
  }

  private emit(e: ModelGateAuditEvent, onFail?: () => void): void {
    const failed = () => { try { onFail?.(); } catch { /* never breaks the caller */ } };
    try {
      const r = this.o.write(e);
      if (r && typeof (r as Promise<unknown>).then === "function") {
        const p: Promise<unknown> = Promise.resolve(r).catch(failed).finally(() => { this.pending.delete(p); });
        this.pending.add(p);
      }
    } catch { failed(); /* the audit never breaks a model call */ }
  }
}
