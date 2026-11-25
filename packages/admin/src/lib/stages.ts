import { conversionHasAdvice } from "./labels";
import {
  STAGES_TEXT, CONVERTER_WAIT_TEXT, STAGE_TITLES, STAGE_STATUS_TITLES
} from "../messages/stages";
export {
  STAGES_TEXT, CONVERTER_WAIT_TEXT, STAGE_TITLES, STAGE_STATUS_TITLES
};
import { clockTime, retryWhen } from "./meeting-state";
import { PROCESS_STATE } from "./process-state";

export interface StageLike { stage: string; status: string; attempts?: number; last_error?: string | null;
  updated_at?: string | null;
  terminal?: boolean;
  retry_at?: string | null; busy_retries?: number; slow_retries?: number; first_busy_at?: string | null }

export const LLM_STAGES: readonly string[] = ["summary", "events", "described"];

export const isWaitingModel = (s: StageLike): boolean =>
  LLM_STAGES.includes(s.stage) && s.status === "pending" &&
  ((s.busy_retries ?? 0) > 0 || (s.slow_retries ?? 0) > 0 || !!s.retry_at || (s.last_error ?? "").startsWith("model_"));

export const isTooSlow = (s: StageLike): boolean => s.status === "failed" && (s.last_error ?? "").startsWith("llm_too_slow:");
/** Texts of this module that other sections read; one dictionary, so that it can follow the interface language. */

export function waitingLine(s: StageLike, now: Date = new Date()): string {
  return STAGES_TEXT.waitingLine(s.busy_retries ?? 0, s.slow_retries ?? 0,
    s.first_busy_at ? clockTime(s.first_busy_at) : null,
    s.retry_at && Date.parse(s.retry_at) > now.getTime() ? retryWhen(s.retry_at, now) : null);
}

const waitAt = (tail: string): string | null => (/^\d{4}-\d{2}-\d{2}T/.test(tail) && Number.isFinite(Date.parse(tail)) ? tail : null);


export const isConverterWait = (s: Pick<StageLike, "stage" | "status" | "last_error">): boolean =>
  s.stage === "converted" && s.status === "pending" && (s.last_error ?? "").startsWith("converter_wait:");

/**
 * Wait code of the converter in words: waiting for conversion with N documents ahead, at the converter since 14:05 (upload,
 * polling and waiting for the result look the same to the converter), some pages not recognised yet with the next try at
 * 15:30, unreachable, paused by an administrator, outages. Times on the clock of the installation; an unknown code: waiting.
 */
export function converterWaitLine(lastError: string, now: Date = new Date()): string {
  const body = lastError.startsWith("converter_wait:") ? lastError.slice("converter_wait:".length) : lastError;
  const i = body.indexOf(":");
  const why = (i < 0 ? body : body.slice(0, i)).trim(), tail = i < 0 ? "" : body.slice(i + 1).trim();
  const at = waitAt(tail);
  switch (why) {
    case "queue": {
      const n = Number(/(\d+)/.exec(tail)?.[1] ?? Number.NaN);
      return Number.isFinite(n) && n > 0 ? STAGES_TEXT.queueAhead(n) : CONVERTER_WAIT_TEXT.queue;
    }
    case "poll": case "publish": case "doc_error":
      return at ? STAGES_TEXT.converterSince(clockTime(at)) : CONVERTER_WAIT_TEXT.at;
    case "ocr_rerun":
      return STAGES_TEXT.ocrRetry(at ? retryWhen(at, now) : null);
    case "rerun":
      return STAGES_TEXT.converterRetry(at ? retryWhen(at, now) : null);
    case "unavailable": case "throttled": case "locked": return CONVERTER_WAIT_TEXT.unavailable;
    case "config": return CONVERTER_WAIT_TEXT.config;
    case "hold": case "hold_new": return CONVERTER_WAIT_TEXT.hold;
    case "mismatch": case "stalled": return CONVERTER_WAIT_TEXT.shaky;
    case "storage": return CONVERTER_WAIT_TEXT.storage;
    default: return CONVERTER_WAIT_TEXT.queue;
  }
}

export const errorsLine = (attempts: number, max: number): string | null =>
  attempts <= 0 ? null : STAGES_TEXT.errorsLine(attempts, max);

export function stageErrors(s: StageLike): number {
  const n = s.attempts ?? 0;
  if (s.status === "pending" || s.status === "failed") return n;
  if (s.status === "running") return Math.max(0, n - 1);
  return 0;
}

export type StageTone = "green" | "amber" | "blue" | "red" | "muted";
export const STAGE_TONES: Record<string, StageTone> = { done: "green", pending: "amber", running: "blue", failed: "red", skipped: "muted" };

export {
  PROCESS_STATE
};

export const INDEX_RETRY_GRACE_MS = 15 * 60_000;

export const employeeStatus = (s: Pick<StageLike, "stage" | "status" | "last_error" | "terminal" | "retry_at">, now: number = Date.now()): string =>
  s.status === "pending" && (s.last_error ?? "").startsWith("reextract:") ? "done"
    : s.stage === "indexed" && s.status === "failed" && s.terminal !== true && !!s.retry_at && Date.parse(s.retry_at) + INDEX_RETRY_GRACE_MS > now ? "pending"
    : s.status;

export type StagesState = "empty" | "done" | "queued" | "running" | "waiting" | "failed";
export interface StagesSummary { state: StagesState; done: number; total: number; failed: string[];
  label: string;
  detail: string;
  tone: StageTone; terminal: boolean;
  tooSlow?: boolean;
  converterWait?: string }

export const stageTitle = (stage: string): string => STAGE_TITLES[stage] ?? stage;

const busy = (what: string, done: number, total: number): { label: string; detail: string } =>
  ({ label: STAGES_TEXT.busyLabel(PROCESS_STATE.busy, what, Math.min(done + 1, total), total), detail: STAGES_TEXT.busyDetail(what, Math.min(done + 1, total), total) });

export function summarizeStages(stages: readonly StageLike[] | null | undefined, now: number = Date.now()): StagesSummary {
  const list = (stages ?? []).map((s) => ({ ...s, status: employeeStatus(s, now) }));
  const total = list.length;
  const done = list.filter((s) => s.status === "done" || s.status === "skipped").length;
  const failed = list.filter((s) => s.status === "failed").map((s) => s.stage);
  const terminal = list.some((s) => s.status === "failed" && s.terminal === true);
  if (!total) return { state: "empty", done: 0, total: 0, failed: [], label: STAGES_TEXT.empty, detail: STAGES_TEXT.empty, tone: "muted", terminal: false };
  if (failed.length) {
    const tooSlow = list.filter((s) => s.status === "failed").every(isTooSlow);
    const label = STAGES_TEXT.failed(PROCESS_STATE.failed, failed.map(stageTitle));
    return { state: "failed", done, total, failed, label, detail: label, tone: "red", terminal, ...(tooSlow ? { tooSlow } : {}) };
  }
  if (list.some((s) => s.status === "running")) return { state: "running", done, total, failed, ...busy(STAGES_TEXT.running, done, total), tone: "blue", terminal: false };
  if (list.some(isWaitingModel)) return { state: "waiting", done, total, failed, ...busy(STAGES_TEXT.waiting, done, total), tone: "amber", terminal: false };
  if (done === total) return { state: "done", done, total, failed, label: PROCESS_STATE.done, detail: PROCESS_STATE.done, tone: "green", terminal: false };
  const conv = list.find(isConverterWait);
  if (conv) {
    const line = converterWaitLine(conv.last_error ?? "", new Date(now));
    return { state: "queued", done, total, failed, ...busy(line, done, total), tone: "amber", terminal: false, converterWait: line };
  }
  return { state: "queued", done, total, failed, ...busy(STAGES_TEXT.queued, done, total), tone: "amber", terminal: false };
}

export function summarizeStageCounts(c: { done: number; total: number; failed: number } | null | undefined): StagesSummary {
  const of = (label: string) => ({ label, detail: label });
  if (!c) return { state: "empty", done: 0, total: 0, failed: [], ...of(STAGES_TEXT.missing), tone: "muted", terminal: false };
  const { done, total } = c;
  if (!total) return { state: "empty", done: 0, total: 0, failed: [], ...of(STAGES_TEXT.noStages), tone: "muted", terminal: false };
  if (c.failed > 0) return { state: "failed", done, total, failed: [], ...of(STAGES_TEXT.failedCount(c.failed, total)), tone: "red", terminal: false };
  if (done >= total) return { state: "done", done, total, failed: [], ...of(STAGES_TEXT.done), tone: "green", terminal: false };
  return { state: "queued", done, total, failed: [], ...of(STAGES_TEXT.incomplete(done, total)), tone: "amber", terminal: false };
}

export const stillProcessing = (s: StagesSummary): boolean => s.state === "queued" || s.state === "running" || s.state === "waiting";

export const PROCESS_NOW_AFTER_MIN = 30;
export interface QueueLike { lane: "now" | "night"; reason?: string | null }
export type ProcessNowOffer = "night" | "slow" | "retry";

export function processNowOffer(stages: readonly StageLike[] | null | undefined, o: { queue?: QueueLike | null; now?: number } = {}): ProcessNowOffer | null {
  const now = o.now ?? Date.now();
  const s = summarizeStages(stages, now);
  if (s.state === "failed") return !s.terminal || s.tooSlow === true ? "retry" : null;
  if (s.state !== "queued" && s.state !== "waiting") return null;
  const list = stages ?? [];
  const next = list.find((x) => { const st = employeeStatus(x, now); return st !== "done" && st !== "skipped"; });
  if (o.queue?.lane === "night" && next && LLM_STAGES.includes(next.stage) && employeeStatus(next, now) === "pending") return "night";
  const moved = list.map((x) => (x.updated_at ? Date.parse(x.updated_at) : Number.NaN)).filter(Number.isFinite);
  if (moved.length && now - Math.max(...moved) >= PROCESS_NOW_AFTER_MIN * 60_000) return "slow";
  return null;
}

export const failedFinal = (stages: readonly StageLike[] | null | undefined, o: { now?: number } = {}): boolean => {
  const s = summarizeStages(stages, o.now ?? Date.now());
  return s.state === "failed" && s.terminal && s.tooSlow !== true;
};

export const conversionFailed = (s: Pick<StagesSummary, "state" | "failed">): boolean =>
  s.state === "failed" && s.failed.length > 0 && s.failed.every((x) => x === "converted");

export const processNowLabel = (offer: ProcessNowOffer | null, s?: Pick<StagesSummary, "state" | "failed"> | null): string =>
  (offer === "retry" && !(s && conversionFailed(s)) ? STAGES_TEXT.retry : STAGES_TEXT.processNow);

export function stagesAdvice(s: StagesSummary, offer?: ProcessNowOffer | null, conversionWhy?: string | null): string | null {
  if (s.state === "failed" && s.tooSlow) return STAGES_TEXT.tooSlowAdvice;
  if (conversionFailed(s)) {
    const tail = s.terminal ? STAGES_TEXT.conversionFinalAdvice : STAGES_TEXT.conversionRetryAdvice;
    if (!conversionWhy) return s.terminal ? STAGES_TEXT.conversionFinalWithReason : tail;
    return conversionHasAdvice(conversionWhy) ? conversionWhy : STAGES_TEXT.adviceWithReason(conversionWhy, tail);
  }
  if (s.state === "failed" && s.terminal) return STAGES_TEXT.finalAdvice;
  if (s.state === "failed") return STAGES_TEXT.failedAdvice;
  const known = offer !== undefined;
  if (known && offer === "night") return STAGES_TEXT.nightAdvice;
  if (known && offer === "slow") return STAGES_TEXT.slowAdvice;
  if (s.state === "waiting") return STAGES_TEXT.waitingAdvice;
  if (s.state === "queued" && s.converterWait) return STAGES_TEXT.converterWaitAdvice;
  if (s.state === "queued") return known ? STAGES_TEXT.busyAdvice : STAGES_TEXT.nightAdvice;
  if (s.state === "running") return known ? STAGES_TEXT.busyAdvice : null;
  return null;
}
