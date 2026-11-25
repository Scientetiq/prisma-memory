// Pure rules of the conversion queue: poll cadence, queue position and pause, the effective window K_eff,
// the run watchdog, computed stalled, run change, the choice of
// `next_action` after a final failure, and what the stage does by error class. No DB or network — unit tests check them;
// the stage pass (jobs/convert.ts, jobs/convert-pass.ts) and admission (conversion-queue.ts) only call them.
import type { ConverterClassified, RunStatus } from "@memory/shared";

// ---------------------------------------------------------------- a record's conversion state (`records.attrs.conversion`)

/** Conversion phase: none — in the queue or finished. In window K — only `uploading` and `submitted`. */
export type ConversionPhase = "uploading" | "submitted" | "rerun_wait" | "fetching";
export const CONVERSION_PHASES: readonly ConversionPhase[] = ["uploading", "submitted", "rerun_wait", "fetching"];

/** What to do on Retry / Process now after a final failure. */
export type ConversionNextAction = "refetch" | "new_run" | "upload";

/** Intent before calling the converter: a post-crash retry sends the same bytes under the same key. */
/**
 * `dedup` — of an upload intent: before it, look for an already uploaded document with the same sha. Set only before a new
 * upload (fresh record, generation bump after 404) and dropped before the first upload request: a retry after a crash mid-
 * upload repeats it with the same keys and does not search.
 */
export interface PendingAction { kind: "upload" | "run" | "retry"; seq: number; why?: string | null; policy_release_id?: string | null; dedup?: boolean }

/** A record's earlier run — for analysis: the PRIOR_RUNS_MAX latest at most. */
export interface PriorRun { run_id: string; why: string | null; at: string }
export const PRIOR_RUNS_MAX = 5;

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const int = (v: unknown): number => Math.max(0, Math.floor(Number(v) || 0));

/** Phase from the mark as is (junk — no phase). */
export const conversionPhase = (conv: Record<string, unknown> | null | undefined): ConversionPhase | null =>
  CONVERSION_PHASES.includes(conv?.phase as ConversionPhase) ? conv!.phase as ConversionPhase : null;

/** Intent from the mark as is (junk — no intent). */
export function pendingAction(conv: Record<string, unknown> | null | undefined): PendingAction | null {
  const p = conv?.pending_action as Partial<PendingAction> | null | undefined;
  if (!p || typeof p !== "object" || (p.kind !== "upload" && p.kind !== "run" && p.kind !== "retry")) return null;
  return { kind: p.kind, seq: int(p.seq), ...(str(p.why) ? { why: str(p.why) } : {}), ...(str(p.policy_release_id) ? { policy_release_id: str(p.policy_release_id) } : {}),
           ...(p.kind === "upload" && p.dedup === true ? { dedup: true } : {}) };
}

// ---------------------------------------------------------------- poll cadence

/** Built-in wait right after sending: up to 20 s, polling every 5 s. An object, so a test need not wait. */
export const CONVERSION_INLINE_WAIT = { totalMs: 20_000, pollMs: 5_000 };

/**
 * In how many seconds to poll the run again: the current run's age (from `run_started_at`) under 10 min — 30 s,
 * under 60 min — 120 s, longer — 300 s; jitter ±20 % (`rand` ∈ [0, 1)), so polls of different records spread out.
 */
export function pollDelaySec(runAgeMs: number, rand: number = Math.random()): number {
  const base = runAgeMs < 10 * 60_000 ? 30 : runAgeMs < 60 * 60_000 ? 120 : 300;
  const r = Math.min(1, Math.max(0, Number.isFinite(rand) ? rand : 0.5));
  return Math.round(base * (0.8 + 0.4 * r));
}

// ---------------------------------------------------------------- queue and window

/** Pause of a record not let in: clamp(60 s × (position − free + 1), 60 s, 900 s). */
export function queueBackoffSec(position: number, free: number): number {
  return Math.min(900, Math.max(60, 60 * (Math.max(0, position) - free + 1)));
}

/** Queue wait code: N ahead — how many documents are ahead (already at the converter and in the queue before it). */
export const queueWaitCode = (ahead: number): string => `converter_wait:queue: ${Math.max(0, Math.floor(ahead))} ahead of this job`;

// The effective window K_eff and computed stalled are shared with the gateway (Document converter block, health):
// they live in @memory/shared (converter-queue.ts); here a re-export for old worker imports and tests.
export { effectiveWindow, stalledPreconditions, STALLED_AFTER_MS, type InFlightRun, type WindowBlock } from "@memory/shared";

// ---------------------------------------------------------------- run watchdog

/** Watchdog limits (settings `integrations.converter_*`). */
export interface WatchdogLimits { suspectMin: number; rerunMin: number; deadlineHours: number; maxReruns: number }

/** Run states with a result: phase `fetching`. */
export const RUN_FINISHED: ReadonlySet<string> = new Set<RunStatus>(["PASS_AUTOMATED", "PASS_WITH_REVIEW", "NEEDS_REVIEW", "REJECTED_AUTOMATED"]);

/** Code of a final run failure caused by the converter — after it, Retry starts a new run. */
export type WatchdogFailCode = "converter_fail_retryable" | "converter_cancelled" | "converter_stuck" | "converter_deadline";

export type WatchdogDecision =
  | { kind: "finished" }
  | { kind: "retry"; why: "fail_retryable" }
  | { kind: "new_run"; why: "accepted_stuck" | "deadline" }
  | { kind: "fail"; code: WatchdogFailCode }
  | { kind: "suspect" }
  | { kind: "wait"; clearSuspect: boolean };

/**
 * Watchdog: what to do with the current run by status and age. All terms run from `run_started_at` of the CURRENT run
 * (a run change resets them, runChange): a child run after `/retry` gets a full term, not the rest of the first one.
 * Any status but ACCEPTED clears the suspicion (record back to K). `suspect` — only when health is OK (decided by
 * the caller: bad health — no suspicion, it waits for the switch).
 */
export function watchdogDecision(o: { status: string; runStartedAt: string | null; suspectSince: string | null; reruns: number; now: Date; limits: WatchdogLimits }): WatchdogDecision {
  const started = o.runStartedAt ? Date.parse(o.runStartedAt) : NaN;
  const age = Number.isFinite(started) ? Math.max(0, o.now.getTime() - started) : 0;
  const more = o.reruns < o.limits.maxReruns;
  if (RUN_FINISHED.has(o.status)) return { kind: "finished" };
  if (o.status === "FAIL_RETRYABLE") return more ? { kind: "retry", why: "fail_retryable" } : { kind: "fail", code: "converter_fail_retryable" };
  if (o.status === "CANCELLED") return { kind: "fail", code: "converter_cancelled" };
  if (o.status === "ACCEPTED") {
    if (age > o.limits.rerunMin * 60_000) return more ? { kind: "new_run", why: "accepted_stuck" } : { kind: "fail", code: "converter_stuck" };
    if (age > o.limits.suspectMin * 60_000 && !o.suspectSince) return { kind: "suspect" };
    return { kind: "wait", clearSuspect: false };
  }
  // PROCESSING, VERIFYING and unknown interim: the current run's hard term
  if (age > o.limits.deadlineHours * 3600_000) return more ? { kind: "new_run", why: "deadline" } : { kind: "fail", code: "converter_deadline" };
  return { kind: "wait", clearSuspect: Boolean(o.suspectSince) };
}

/**
 * Run change: `/retry`, a new run on the document, a recognition repeat, a new upload — in the same fenced
 * record write as the new `run_id`: watchdog marks are reset (`run_started_at`, `dc_status`, `dc_status_since`,
 * `suspect_since`), the intent is dropped, the earlier run goes to `prior_runs` (5 latest at most).
 */
export function runChange(conv: Record<string, unknown>, next: { run_id: string; document_id?: string | null; why: string; now: Date; parent?: boolean }): Record<string, unknown> {
  const prior = Array.isArray(conv.prior_runs) ? (conv.prior_runs as PriorRun[]).filter((r) => r && typeof r.run_id === "string") : [];
  const old = str(conv.run_id);
  const at = next.now.toISOString();
  const runs = old && old !== next.run_id ? [...prior, { run_id: old, why: next.why, at }].slice(-PRIOR_RUNS_MAX) : prior.slice(-PRIOR_RUNS_MAX);
  return {
    run_id: next.run_id, ...(next.document_id ? { document_id: next.document_id } : {}),
    parent_run_id: next.parent && old && old !== next.run_id ? old : null,
    run_started_at: at, dc_status: null, dc_status_since: at, suspect_since: null, pending_action: null, prior_runs: runs,
  };
}

/** Marks of the current run: they leave with it when the record no longer has a run (retireRun). */
export const RUN_FIELDS: readonly string[] = ["run_id", "parent_run_id", "run_started_at", "dc_status", "dc_status_since", "suspect_since", "fetch_404_since"];

/**
 * A run is dropped with no new one: a new-run intent on ANOTHER document (dedup) or unlinking
 * from the document on a class move. The earlier run goes to `prior_runs` (at most 5), its marks are dropped (RUN_FIELDS):
 * else the pair new document + earlier run after a failure would give `next_action = new_run`, and Retry would query
 * a run lost long ago, and a 404 would declare a neighbour's live document lost. No run — null.
 */
export function retireRun(conv: Record<string, unknown>, why: string, now: Date): { prior_runs: PriorRun[] } | null {
  const old = str(conv.run_id);
  if (!old) return null;
  const prior = Array.isArray(conv.prior_runs) ? (conv.prior_runs as PriorRun[]).filter((r) => r && typeof r.run_id === "string" && r.run_id !== old) : [];
  return { prior_runs: [...prior, { run_id: old, why, at: now.toISOString() }].slice(-PRIOR_RUNS_MAX) };
}

/**
 * Unlinking a record copy from the converter document on a class move. Dedup ties one
 * document to records of one class, and a move copies `attrs.conversion` as is: without unlinking, Close (or the fallback
 * path to closed) would leave the document shared by an open and a closed record. `shared` — documents still referenced by
 * a record of the source class (current or lost). Lost ones from `shared` leave the copy's list (they stay with the
 * neighbour). Current document in `shared`: the copy is unlinked; document, run and its marks drop (the run goes to
 * `prior_runs`), generation +1: the next upload uses new keys (old ones would return the same document); the loss counter
 * does not grow: no loss. A ready document (`done`) keeps text and result; an unfinished one: phase, intent and admission
 * are dropped, `next_action = upload`: its own copy goes through admission (dedup will not tie it to a document of another
 * class). Nothing to unlink — null.
 */
export function detachForMove(conv: Record<string, unknown>, shared: ReadonlySet<string>, now: Date): { patch: Record<string, unknown>; drop: string[] } | null {
  const lost = Array.isArray(conv.lost_document_ids) ? (conv.lost_document_ids as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const keptLost = lost.filter((d) => !shared.has(d));
  const doc = str(conv.document_id);
  const detach = doc !== null && shared.has(doc);
  if (!detach && keptLost.length === lost.length) return null;
  const patch: Record<string, unknown> = {}, drop: string[] = [];
  if (keptLost.length !== lost.length) { if (keptLost.length) patch.lost_document_ids = keptLost; else drop.push("lost_document_ids"); }
  if (!detach) return { patch, drop };
  Object.assign(patch, retireRun(conv, "class_move", now) ?? {}, { gen: int(conv.gen) + 1 });
  drop.push(...RUN_FIELDS, "document_id", "doc_gen", "dedup_from");
  if (conv.status !== "done") {
    patch.next_action = "upload";
    if (conv.status !== "failed") patch.status = "pending";
    drop.push("phase", "pending_action", "admitted_at", "rerun_at", "stuck", "submitted_at");
  }
  return { patch, drop: [...new Set(drop)] };
}

// ---------------------------------------------------------------- next_action

/** Codes of a converter failure — after them, Retry starts a new run on the document. */
const NEW_RUN_CODES: ReadonlySet<string> = new Set(["converter_fail_retryable", "converter_cancelled", "converter_stuck", "converter_deadline", "result_missing"]);
/** Codes for a document or copy gone at the converter: a new upload is needed. */
const UPLOAD_CODES: ReadonlySet<string> = new Set(["copies_limit", "document_not_found", "profile_not_fast", "original_changed", "original_missing"]);

/**
 * What to do after a final failure: the run at DC finished, but fetching or our applying broke —
 * `refetch`; DC failed (FAIL_RETRYABLE spent, CANCELLED, term, ACCEPTED stuck, code `failed` after a retry) —
 * `new_run`; no document at DC — `upload`. `dcFailed`: fast-lane result `failed` (converter code).
 */
export function nextActionFor(o: { phase: ConversionPhase | null; pendingKind: PendingAction["kind"] | null; code: string | null; runId: string | null; dcFailed?: boolean }): ConversionNextAction {
  const code = o.code ?? "";
  if (UPLOAD_CODES.has(code)) return "upload";
  if (NEW_RUN_CODES.has(code) || o.dcFailed) return o.runId ? "new_run" : "upload";
  if (code === "run_control_conflict") return o.pendingKind === "run" ? "upload" : o.runId ? "new_run" : "upload";
  if (o.phase === "fetching" || o.phase === "submitted" || o.phase === "rerun_wait") return o.runId ? "refetch" : "upload";
  if (o.phase === "uploading") return o.pendingKind === "upload" || !o.runId ? "upload" : "new_run";
  return o.runId ? "refetch" : "upload";
}

/** An old record without `next_action`: has `run_id` — fetch the result again, else upload. */
export const legacyNextAction = (conv: Record<string, unknown> | null | undefined): ConversionNextAction => {
  const n = conv?.next_action;
  if (n === "refetch" || n === "new_run" || n === "upload") return n;
  return str(conv?.run_id) ? "refetch" : "upload";
};

/** Retry cycle counters: a new cycle starts them over; `gen` and `action_seq` are never reset. */
export const CYCLE_RESET: Readonly<Record<string, unknown>> = {
  reruns: 0, gen_bumps: 0, doc_errors: 0, ocr_reruns: 0, failed_reruns: 0, doc_error_limit_at: null, first_doc_error_at: null, doc_error_code: null,
  fetch_404_since: null, rerun_at: null, rerun_why: null, suspect_since: null, waiting_since: null, wait_alerted_at: null,
};

/**
 * Retry cycle start mark (`conversion.cycle_started_at`): counters reset ONCE — by the first pass after
 * a final failure or a ready document, not by every pass waiting for admission (else waiting in
 * the queue erased `waiting_since`, and the alert waiting over 6 h never came). The cycle end drops it (CYCLE_END_DROP;
 * a `done` result replaces the mark).
 */
export const CYCLE_MARK = "cycle_started_at";

/** Is a cycle counter reset needed: a final failure or a ready document, and the cycle not started yet. */
export const cycleStartDue = (conv: Record<string, unknown> | null | undefined): boolean =>
  (conv?.status === "failed" || conv?.status === "done") && !str(conv?.[CYCLE_MARK]);

/** What a final failure drops: phase, intent, suspicion, retry term, admission and the cycle start mark. */
export const CYCLE_END_DROP: readonly string[] = ["stuck", "phase", "pending_action", "suspect_since", "rerun_at", "admitted_at", CYCLE_MARK];

/**
 * The generation that got the current `document_id` (`conversion.doc_gen`; for old marks — `gen` itself). A new upload
 * after Retry takes a fresh generation if the current one gave a document: the same keys would return at the
 * converter the old document and the very first run.
 */
export function uploadNeedsFreshGen(conv: Record<string, unknown> | null | undefined): boolean {
  if (!str(conv?.document_id)) return false;
  const docGen = conv?.doc_gen === undefined || conv?.doc_gen === null ? int(conv?.gen) : int(conv?.doc_gen);
  return docGen >= int(conv?.gen);
}

// ---------------------------------------------------------------- soft wait term

/** After how many hours of waiting for a document the administrator gets an alert (over 6 hours). */
export const LONG_WAIT_ALERT_HOURS = 6;
/** At most one such alert an hour per memory: a mass upload does not flood the journal with a hundred equal events. */
export const LONG_WAIT_ALERT_EVERY_MS = 3600_000;

/**
 * Soft wait term: the document waits in the queue or at the converter over 6 h. Counted from the cycle's first send
 * (`submitted_at`, not the current run); for a document not yet sent — from the start of its wait in the cycle
 * (`waiting_since`; none — `start`: mark it now). The alert — once per cycle (`wait_alerted_at`). Health `converter`
 * (warn at 6 h, fail at 24 h) is separate; here: log and journal event.
 */
export function longWaitCheck(conv: Record<string, unknown> | null | undefined, now: Date): { start: boolean; alert: boolean; hours: number } {
  const since = str(conv?.submitted_at) ?? str(conv?.waiting_since);
  const at = since ? Date.parse(since) : NaN;
  if (!Number.isFinite(at)) return { start: true, alert: false, hours: 0 };
  const hours = Math.max(0, now.getTime() - at) / 3600_000;
  return { start: false, alert: !str(conv?.wait_alerted_at) && hours >= LONG_WAIT_ALERT_HOURS, hours: Math.floor(hours) };
}

// ---------------------------------------------------------------- error class → what the stage does

/** What the stage does with a pass error: wait (switch, document, storage, retry), a step error or a final refusal. */
export interface ClassAction { effect: "gate" | "doc_wait" | "storage_wait" | "throttle_wait" | "abort_wait" | "job_error" | "terminal"; spendsAttempt: boolean; busy: boolean; mismatch: boolean }

/** The table by error class (classifyConverterError): is an attempt spent, does the stage wait, is a mismatch count needed. */
export function classAction(c: ConverterClassified): ClassAction {
  switch (c.cls) {
    case "unavailable": case "config": return { effect: "gate", spendsAttempt: false, busy: true, mismatch: false };
    case "locked": return c.short ? { effect: "throttle_wait", spendsAttempt: false, busy: false, mismatch: false } : { effect: "gate", spendsAttempt: false, busy: true, mismatch: false };
    case "doc_error": return { effect: "doc_wait", spendsAttempt: false, busy: false, mismatch: false };
    case "storage": return { effect: "storage_wait", spendsAttempt: false, busy: true, mismatch: false };
    case "aborted": return { effect: "abort_wait", spendsAttempt: false, busy: false, mismatch: false };
    case "terminal": return { effect: "terminal", spendsAttempt: true, busy: false, mismatch: false };
    default: return { effect: "job_error", spendsAttempt: true, busy: false, mismatch: c.mismatch === true };
  }
}
