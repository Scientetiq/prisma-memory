import { formatCount } from "../../i18n/format";
import { pluralEn } from "../../i18n/core";
export const STAGES_TEXT = {
    tooSlowText: "The model cannot respond to this record in time — click “Retry” at night or contact the developers",
    converterWaitAdvice: "No action is needed: text conversion will continue automatically.",
    tooSlowAdvice: "The model cannot respond to this record in time. Click “Retry” to try again; if it fails again, contact your administrator.",
    waitingAdvice: "No action is needed: processing will retry automatically when the model is available.",
    conversionRetryAdvice: "You can click “Process now” to convert the document again (up to 10 times per hour). If it fails again, an administrator will investigate.",
    conversionFinalAdvice: "This file cannot be processed again: retrying will give the same result.",
    busyAdvice: "Usually a few minutes; no action is needed.",
    waitingLine: (busy: number, slow: number, first: string | null, retry: string | null): string => {
      const n = busy + slow;
      const what = busy && slow ? "it was busy or did not respond in time" : slow ? "it did not respond in time" : "it was busy";
      const since = first ? ` since ${first}` : "";
      const next = retry ? `next attempt ${retry}` : "we will try again when the model is available";
      return n ? `waiting for the model: ${what} ${formatCount(n)} ${pluralEn(n, "time", "times")}${since}, ${next}` : `waiting for the model: ${next}`;
    },
    queueAhead: (n: number): string => `Waiting for text conversion: ${formatCount(n)} ${pluralEn(n, "document", "documents")} ahead`,
    converterSince: (time: string): string => `With the converter since ${time}`,
    ocrRetry: (time: string | null): string => `Some pages have not been recognised yet — we will try again${time ? ` ${time}` : ""}`,
    converterRetry: (time: string | null): string => `The converter could not process the file on the first attempt — we will try again${time ? ` ${time}` : ""}`,
    errorsLine: (attempts: number, max: number): string => attempts >= max ? `attempts: ${formatCount(attempts)} — automatic retries exhausted (limit ${formatCount(max)})` : `errors: ${formatCount(attempts)} of ${formatCount(max)}`,
    busyLabel: (state: string, what: string, step: number, total: number): string => `${state} · ${what.toLowerCase()}, step ${formatCount(step)} of ${formatCount(total)}`,
    busyDetail: (what: string, step: number, total: number): string => `${what} · step ${formatCount(step)} of ${formatCount(total)}`,
    failed: (state: string, stages: readonly string[]): string => `${state}: ${stages.join(", ")}`,
    empty: "no processing information",
    running: "Processing in progress",
    waiting: "Waiting for the model",
    queued: "Queued for processing",
    missing: "no data: data class move or cleanup",
    noStages: "no stages",
    failedCount: (failed: number, total: number): string => `error: ${formatCount(failed)} of ${formatCount(total)} stages`,
    done: "done",
    incomplete: (done: number, total: number): string => `incomplete (${formatCount(done)} of ${formatCount(total)})`,
    retry: "Retry",
    processNow: "Process now",
    conversionFinalWithReason: "This file cannot be processed again: retrying will give the same result. See the record page for the reason.",
    adviceWithReason: (why: string, advice: string): string => `${why} ${advice}`,
    finalAdvice: "Processing failed permanently: retrying will give the same result. Contact your administrator to check the file or document processing.",
    failedAdvice: "Click “Retry” to retry failed stages. If the error persists, contact your administrator.",
    nightAdvice: "Full processing will run at night. Need it sooner? Click “Process now” (up to 10 times per hour).",
    slowAdvice: "Processing is taking longer than usual. Click “Process now” to move the record to the front of the queue (up to 10 times per hour).",

};

export const CONVERTER_WAIT_TEXT = {
    queue: "Waiting for text conversion",
    at: "With the converter",
    unavailable: "The converter is unavailable — we will continue automatically; no action is needed",
    config: "The converter is temporarily unavailable — the administrator can already see why",
    hold: "Conversion paused by the administrator",
    shaky: "The converter is unreliable — the administrator can already see this",
    storage: "Storage is temporarily unavailable — we will continue automatically",
} as const;

export const STAGE_TITLES: Record<string, string> = { converted: "file processing", indexed: "search preparation", summary: "summary", events: "decisions and tasks", entities: "finding links", described: "description", moved: "move when opening or closing" };

export const STAGE_STATUS_TITLES: Record<string, string> = { pending: "waiting", running: "in progress", failed: "error", done: "done", skipped: "skipped" };
