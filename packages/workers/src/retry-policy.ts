// Smart retry of a model stage: pure rules with no DB or clock — time comes as a parameter.
// Busy and slow are no record errors: no attempt spent, the stage waits for the model (pending) with its own term or the
// instance backoff; error — a bad answer or a code fault: an attempt; past the limit it waits for a person.
import { inWindow, LLM_GATE_DEFAULTS, nextWindowStart, PlatformError, type LlmGateCfg, type LlmRetryCfg, type NightWindow, type OutcomeKind } from "@memory/shared";

export interface RetriesCfg { limit: number; delay_sec: number; backoff: boolean }
export interface PlanCfg {
  retry: LlmRetryCfg; retries: RetriesCfg; win: NightWindow;
  /** Overrides from `processing.llm_gate` for blocked calls and repeated record-check faults. */
  gate?: Partial<Pick<LlmGateCfg, "busy_backoff_cap_sec" | "busy_backoff_sec">>;
}
/** Stage row after the claim (attempts already +1). */
export interface RetryRow { attempts: number; busy_retries: number; slow_retries: number; first_busy_at: Date | null }
export interface PlanInput {
  lane: "now" | "night";
  /** record attrs->>'process_now_at': set — the record is in the now lane. */
  processNowAt: string | null;
  /**
   * When the model last answered ANOTHER record (lastOtherSuccess by llm_breaker): good parts of the same
   * meeting do not count here — else a lone long meeting during model outages would get too long.
   */
  lastSuccessAt: Date | null;
  /** What exactly was slow — for the reason text: timeout, gateway error 500, 408. */
  slowWhat?: string;
  /** Error reason text (stageErrorText) — for the error outcome. */
  errorText?: string;
  /** Why the call was blocked (`blockedBy`), for the text of the outcome `blocked`; the data policy when absent. */
  blockedBy?: "policy" | "budget";
  /**
   * Why the call was aborted (`abortedBy`), for the text of the outcome `aborted`: `record_check` — the record
   * rule at the send could not read its rows (DispatchFenceFault); a restart or a change of queue when absent.
   */
  abortedBy?: "record_check";
  /** The stage's stored `last_error` before this claim. */
  prevError?: string | null;
}
export type PlanKind = "busy" | "slow" | "too_slow" | "config" | "aborted" | "blocked" | "error";
export interface LlmPlan {
  result: "retry" | "deferred" | "failed";
  kind: PlanKind;
  status: "pending" | "failed";
  attempts: number; busy_retries: number; slow_retries: number;
  first_busy_at: Date | null; retry_at: Date | null;
  /** Why the record went to night (attrs.deferred_reason) or null. */
  defer: "model_busy" | "too_slow" | null;
  last_error: string;
}

export const MODEL_BUSY_TEXT = "model_busy: the model is busy. Processing will retry when it is available";
export const MODEL_CONFIG_TEXT = "model_config: the model is unavailable under the current settings";
export const ABORTED_TEXT = "aborted: a restart or queue change interrupted processing. Processing will resume immediately";
/**
 * The stage's call was not sent: the record rule at the send could not read its rows. The plan is the
 * one of `aborted` — pending, the attempt given back, the counters kept.
 */
export const RECORD_CHECK_TEXT = "record_check: the record could not be checked before a request to the model (database error) — that request was not sent; the stage repeats by itself";
export const TOO_SLOW_TEXT = "llm_too_slow: the model could not respond to this record within the time limit";
export const slowText = (what?: string): string => `model_slow: the model did not respond in time (${what ?? "timeout"})`;
/** The stage waits for a permitted model: the data policy does not let this pair receive the record's class. */
export const MODEL_POLICY_TEXT = "model_policy: this model endpoint is not allowed to receive records of this class";
/** The stage waits for budget: the money budget of the model calls is spent. */
export const MODEL_BUDGET_TEXT = "model_budget: the model budget is exhausted";

/** What blocked a call: an exhausted budget, otherwise the data policy. */
export function blockedBy(e: unknown): "policy" | "budget" {
  return e instanceof PlatformError && e.kind === "budget_exhausted" ? "budget" : "policy";
}

/** What aborted a call: the record rule at the send failed to read (a DispatchFenceFault), otherwise undefined. */
export function abortedBy(e: unknown): "record_check" | undefined {
  return e instanceof PlatformError && e.kind === "aborted" && (e as { recordCheck?: unknown }).recordCheck === true ? "record_check" : undefined;
}

/** Pause after the n-th slow in a row: base · 2^(n−1), capped. */
export function slowDelaySec(n: number, r: Pick<LlmRetryCfg, "base_sec" | "cap_sec">): number {
  return Math.min(r.cap_sec, r.base_sec * 2 ** Math.max(0, n - 1));
}

/** Night term: in the window as is; past its end — the next window's start (a temporary outcome at night is no error). */
export const nightAt = (win: NightWindow, at: Date): Date => nextWindowStart(win, at);

/**
 * Now lane patience: only outside the window (inside it night processing runs anyway). Counted from entering now
 * (process_now_at); unparsable — from the start of the model wait. 0 — the old rule: on first busy, to the night.
 */
export function patienceExceeded(o: { processNowAt: string | null; firstBusyAt: Date | null; now: Date; patienceMin: number; win: NightWindow }): boolean {
  if (inWindow(o.win, o.now)) return false;
  if (o.patienceMin <= 0) return true;
  const t = o.processNowAt ? Date.parse(o.processNowAt) : NaN;
  const from = Number.isFinite(t) ? t : o.firstBusyAt?.getTime() ?? o.now.getTime();
  return from < o.now.getTime() - o.patienceMin * 60_000;
}

/**
 * The limit of work on one record: after poison_after × TOO_SLOW_CAP_FACTOR slow in a row the record is too
 * long, even without others' model answers. With a 30-min pause cap that is about two hours of tries (defaults: 9 slow),
 * so a lone meeting during model outages does not take the whole night.
 */
export const TOO_SLOW_CAP_FACTOR = 3;

/**
 * A too long record: n slow in a row while the model managed to answer other records meanwhile
 * (lastSuccessAt — the last answer to ANOTHER record); or the limit of work on the record is spent.
 */
export function tooSlow(slowNew: number, poisonAfter: number, lastSuccessAt: Date | null, firstBusyAt: Date | null): boolean {
  if (slowNew >= poisonAfter * TOO_SLOW_CAP_FACTOR) return true;
  return slowNew >= poisonAfter && !!lastSuccessAt && !!firstBusyAt && lastSuccessAt.getTime() > firstBusyAt.getTime();
}

/** Retry term after an error: attempts left — delay_sec (backoff doubles it); past the limit — null, a person decides. */
export function errorRetryAt(attempts: number, r: RetriesCfg, now: Date): Date | null {
  if (attempts >= r.limit) return null;
  const sec = r.backoff ? r.delay_sec * 2 ** Math.max(0, attempts - 1) : r.delay_sec;
  return new Date(now.getTime() + sec * 1000);
}

/** LLM stage outcome plan: kind is the call outcome (callKind); "answered_error" and "error" mean error. */
export function planLlmOutcome(kind: OutcomeKind, row: RetryRow, cfg: PlanCfg, now: Date, input: PlanInput): LlmPlan {
  const down = Math.max(row.attempts - 1, 0);                     // a temporary outcome gives back the claim's attempt
  const keep = { busy_retries: row.busy_retries, slow_retries: row.slow_retries, first_busy_at: row.first_busy_at };
  if (kind === "config") return { result: "retry", kind, status: "pending", attempts: down, ...keep, retry_at: null, defer: null, last_error: MODEL_CONFIG_TEXT };
  if (kind === "aborted") {
    const recordCheck = input.abortedBy === "record_check";
    const repeat = recordCheck && input.prevError === RECORD_CHECK_TEXT.slice(0, 200);
    const sec = cfg.gate?.busy_backoff_sec ?? LLM_GATE_DEFAULTS.busy_backoff_sec;
    return { result: "retry", kind, status: "pending", attempts: down, ...keep,
             retry_at: repeat ? new Date(now.getTime() + sec * 1000) : null, defer: null,
             last_error: recordCheck ? RECORD_CHECK_TEXT : ABORTED_TEXT };
  }
  // blocked: nothing was asked of the model — the stage waits with a term of its own (the scheduler re-queues it at
  // retry_at, so it does not spin), the attempt is returned, the counters stay; never to the night lane: defer moves the
  // record there and the night would not change the policy or the budget
  if (kind === "blocked") {
    const sec = cfg.gate?.busy_backoff_cap_sec ?? LLM_GATE_DEFAULTS.busy_backoff_cap_sec;
    return { result: "retry", kind, status: "pending", attempts: down, ...keep, retry_at: new Date(now.getTime() + sec * 1000), defer: null,
             last_error: input.blockedBy === "budget" ? MODEL_BUDGET_TEXT : MODEL_POLICY_TEXT };
  }
  if (kind === "busy" || kind === "slow") {
    const first = row.first_busy_at ?? now;
    const windowNow = inWindow(cfg.win, now);
    if (kind === "slow") {
      const slow = row.slow_retries + 1;
      if (tooSlow(slow, cfg.retry.poison_after, input.lastSuccessAt, first)) {
        const counters = { busy_retries: row.busy_retries, slow_retries: slow, first_busy_at: first };
        // daytime now lane — night is calmer; at night or in the window waiting is pointless: until the admin's Retry
        if (input.lane === "now" && !windowNow)
          return { result: "deferred", kind: "too_slow", status: "pending", attempts: down, ...counters, retry_at: null, defer: "too_slow", last_error: slowText(input.slowWhat) };
        return { result: "failed", kind: "too_slow", status: "failed", attempts: row.attempts, ...counters, retry_at: null, defer: null, last_error: TOO_SLOW_TEXT };
      }
      const at = new Date(now.getTime() + slowDelaySec(slow, cfg.retry) * 1000);
      const retryAt = input.lane === "night" ? nightAt(cfg.win, at) : at;
      const defer = patienceOver(input, first, now, cfg) ? "model_busy" as const : null;
      return { result: defer ? "deferred" : "retry", kind, status: "pending", attempts: down, busy_retries: row.busy_retries, slow_retries: slow, first_busy_at: first,
               retry_at: retryAt, defer, last_error: slowText(input.slowWhat) };
    }
    // busy: no own term — the instance backoff holds the stage (one for all, grows by itself)
    const defer = patienceOver(input, first, now, cfg) ? "model_busy" as const : null;
    return { result: defer ? "deferred" : "retry", kind, status: "pending", attempts: down, busy_retries: row.busy_retries + 1, slow_retries: 0, first_busy_at: first,
             retry_at: null, defer, last_error: MODEL_BUSY_TEXT };
  }
  // error: bad model answer (failed the schema, 4xx) or code fault — the attempt counts, retry by processing.retries
  return { result: "failed", kind: "error", status: "failed", attempts: row.attempts, ...keep, retry_at: errorRetryAt(row.attempts, cfg.retries, now), defer: null,
           last_error: input.errorText ?? "error: stage failed" };
}

/** Patience out — only a record in the now lane (something to drop). */
function patienceOver(input: PlanInput, first: Date, now: Date, cfg: PlanCfg): boolean {
  return input.lane === "now" && !!input.processNowAt && patienceExceeded({ processNowAt: input.processNowAt, firstBusyAt: first, now, patienceMin: cfg.retry.now_patience_min, win: cfg.win });
}
