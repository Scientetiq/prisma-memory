import { formatNumber } from "../../i18n/format";
import { pluralEn, type Messages } from "../../i18n/core";
import { formatCount } from "../../i18n/format";

export const ORPHAN_WHY: Record<string, string> = {
  purge: "the record was deleted permanently",
  open_check_refused: "the document was not accepted into a shared space",
  open_check_fallback: "the document was moved to closed records; the record now has another copy",
};

export const PHASE_TEXT: Record<string, string> = { uploading: "uploading to the converter", submitted: "at the converter", rerun_wait: "waiting for recognition to retry", fetching: "retrieving the result" };

export const STAGE_TEXT: Record<string, string> = { done: "done", failed: "failed", running: "running", pending: "waiting", skipped: "not needed" };

export const DC_TEXT: Record<string, string> = {
  ACCEPTED: "accepted", PROCESSING: "processing", VERIFYING: "verifying", PASS_AUTOMATED: "ready", PASS_WITH_REVIEW: "ready",
  NEEDS_REVIEW: "ready", REJECTED_AUTOMATED: "ready (draft)", CANCELLED: "cancelled", FAILED: "error",
};

export const WAIT_TEXT: Record<"queue" | "at_converter" | "doc_error" | "unavailable" | "config" | "hold" | "ocr_rerun" | "shaky" | "storage" | "other", string> = {
  queue: "queued", at_converter: "at the converter", doc_error: "the converter has not returned a result yet", unavailable: "converter unavailable",
  config: "the converter rejects the account", hold: "paused by an administrator", ocr_rerun: "waiting for recognition to retry", shaky: "converter interruptions",
  storage: "storage unavailable", other: "waiting",
};

export const converterState = {
  since: (when: string) => `since ${when.replace(/^at /, "")}`,
  bytes: (n: string) => `${n} B`,
  units: ["KB", "MB", "GB", "TB"],
  health: (detail: string) => `Health check: ${detail}`,
  caps: (fast: boolean, version: string, when: string) => `${fast ? "Fast mode is available" : "Fast mode is unavailable"}${version ? `, converter version ${version}` : ""} (checked ${when})`,
  unchecked: "Converter capabilities have not been checked yet. Click “Check connection”",
  window: (k: number, effective: number, flight: number, suspect: number) => `Up to ${k} ${pluralEn(k, "document", "documents")} at the converter at once${effective !== k ? ` (currently ${effective} allowed)` : ""}; in progress: ${flight}${suspect ? `; accepted but not started for too long: ${suspect}` : ""}`,
  queue: (n: number, since: string, kinds: string) => `Waiting for text conversion: ${formatCount(n)}${since ? `, the oldest has been waiting ${since}` : ""}${kinds ? ` — ${kinds}` : ""}`,
  empty: "The queue is empty: no documents are waiting for text conversion",
  uploads: (n: number, bytes: string) => `Sent to the converter in 30 days: ${formatCount(n)} ${pluralEn(n, "document", "documents")}${n ? `, ${bytes}` : ""}`,
  noUploads: "The log could not be read: the number of documents sent in 30 days is unavailable",
  orphans: (n: number) => `Copies no longer needed by memory remain at the converter: ${formatCount(n)} (over a year). Remove them manually at the converter; their IDs are below`,
  noOrphans: "The log could not be read: unused converter copies are unavailable",
  reruns: (n: number) => `recognition retries: ${n}`,
  newRuns: (n: number) => `new runs: ${n}`,
  terminal: (state: string) => `${state} — retrying will produce the same rejection`,
  other: "other",
  missingRoles: (roles: string) => `Memory’s account lacks converter permissions: ${roles}`,
  woken: (n: number) => `Waiting documents will continue now: ${n}`,
  byteSize: (n: number): string => {
    if (n < 1024) return converterState.bytes(formatCount(n));
    let value = n / 1024, unit = 0;
    while (value >= 1024 && unit < converterState.units.length - 1) { value /= 1024; unit++; }
    return `${formatNumber(value, { maximumFractionDigits: value < 10 ? 1 : 0 })} ${converterState.units[unit]}`;
  },
  queueDetails: (n: number, when: string, kinds: Array<{ title: string; count: number }>): string => converterState.queue(n, when ? converterState.since(when) : "", kinds.map((kind) => `${kind.title}: ${kind.count}`).join(", ")),
  uploadsWithBytes: (n: number, bytes: number): string => converterState.uploads(n, converterState.byteSize(bytes)),
  repeatSummary: (reruns: number, newRuns: number): string => [reruns ? converterState.reruns(reruns) : "", newRuns ? converterState.newRuns(newRuns) : ""].filter(Boolean).join(", ") || "—",
  recentState: (phase: string | null, status: string, wait: keyof typeof WAIT_TEXT | null, terminal: boolean): string => {
    const state = phase && PHASE_TEXT[phase] ? PHASE_TEXT[phase]! : status === "pending" && wait ? WAIT_TEXT[wait] : STAGE_TEXT[status] ?? status;
    return terminal ? converterState.terminal(state) : state;
  },
};
