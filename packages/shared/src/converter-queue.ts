import type { ConverterGateState, ConverterHolds } from "./converter-gate.ts";

export const CONVERTER_WINDOW_DEFAULT = 1;
export const CONVERTER_WINDOW_MAX = 8;

export function converterWindowOf(settings: { get<T>(path: string, def: T): T }): number {
  const v = Math.trunc(Number(settings.get<unknown>("integrations.converter_window", CONVERTER_WINDOW_DEFAULT)));
  return Number.isFinite(v) ? Math.min(CONVERTER_WINDOW_MAX, Math.max(1, v)) : CONVERTER_WINDOW_DEFAULT;
}

export type WindowBlock = "hold_new" | "mismatch" | "stalled" | "gate";

export function effectiveWindow(o: { k: number; gate: Pick<ConverterGateState, "state" | "new_block" | "recovering">; holds: ConverterHolds; stalled: boolean }): { k: number; block: WindowBlock | null } {
  if (o.holds === "new" || o.holds === "all") return { k: 0, block: "hold_new" };
  if (o.gate.new_block === "mismatch") return { k: 0, block: "mismatch" };
  if (o.stalled) return { k: 0, block: "stalled" };
  if (o.gate.state === "open") return { k: 0, block: "gate" };
  if (o.gate.state === "half_open" || o.gate.recovering) return { k: Math.min(1, o.k), block: null };
  return { k: o.k, block: null };
}

export const STALLED_AFTER_MS = 3 * 3600_000;

export interface InFlightRun { dc_status: string | null; run_started_at: string | null; suspect_since: string | null }

export function stalledPreconditions(runs: readonly InFlightRun[], gate: Pick<ConverterGateState, "last_result_at" | "stalled_ignore_until">, now: Date): boolean {
  const t = now.getTime();
  const ignore = gate.stalled_ignore_until ? Date.parse(gate.stalled_ignore_until) : NaN;
  if (Number.isFinite(ignore) && ignore > t) return false;
  const last = gate.last_result_at ? Date.parse(gate.last_result_at) : NaN;
  if (Number.isFinite(last) && t - last < STALLED_AFTER_MS) return false;
  return runs.some((r) => {
    const started = r.run_started_at ? Date.parse(r.run_started_at) : NaN;
    if (!Number.isFinite(started) || t - started <= STALLED_AFTER_MS) return false;
    return (r.dc_status === "ACCEPTED" && !r.suspect_since) || r.dc_status === "PROCESSING" || r.dc_status === "VERIFYING";
  });
}

export const CONVERTER_RESUME_STALLED_IGNORE_MS = 3 * 3600_000;

export const CONVERTER_WAIT_CODE_PREFIX = "converter_wait:";

export type ConverterWaitKind = "queue" | "at_converter" | "doc_error" | "unavailable" | "config" | "hold" | "ocr_rerun" | "shaky" | "storage" | "other";
export const CONVERTER_WAIT_KINDS: readonly ConverterWaitKind[] = ["queue", "at_converter", "doc_error", "unavailable", "config", "hold", "ocr_rerun", "shaky", "storage", "other"];

const WAIT_KIND: Readonly<Record<string, ConverterWaitKind>> = {
  queue: "queue",
  poll: "at_converter", publish: "at_converter", wait: "at_converter",
  doc_error: "doc_error",
  unavailable: "unavailable", throttled: "unavailable", locked: "unavailable",
  config: "config",
  hold: "hold", hold_new: "hold",
  ocr_rerun: "ocr_rerun", rerun: "ocr_rerun",
  mismatch: "shaky", stalled: "shaky",
  storage: "storage",
};

export function converterWaitWhy(lastError: string | null | undefined): string | null {
  const s = lastError ?? "";
  if (!s.startsWith(CONVERTER_WAIT_CODE_PREFIX)) return null;
  const body = s.slice(CONVERTER_WAIT_CODE_PREFIX.length);
  const i = body.indexOf(":");
  return (i < 0 ? body : body.slice(0, i)).trim();
}

export function converterWaitKind(lastError: string | null | undefined): ConverterWaitKind | null {
  const why = converterWaitWhy(lastError);
  if (why === null) return null;
  return WAIT_KIND[why] ?? "other";
}

export const CONVERTER_WAIT_WARN_HOURS = 6;
export const CONVERTER_WAIT_FAIL_HOURS = 24;
