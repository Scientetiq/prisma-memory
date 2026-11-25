import {
  STAGE_ERROR_INFO, text as text_MESSAGES
} from "../messages/stage-errors";
export {
  STAGE_ERROR_INFO
};
import { conversionFailedReason, CONVERSION_ERROR_TITLES } from "./labels";
import type { Conversion } from "./types";
import { VERSIONS_TEXT } from "./versions.messages";

export interface StageErrorInfo { title: string; advice: string }

export const stageErrorCode = (lastError: string | null | undefined): string => (lastError ?? "").split(":", 1)[0]!.trim();

export function stageErrorInfo(code: string): StageErrorInfo {
  if (!code) return { title: text_MESSAGES.missing, advice: text_MESSAGES.retry };
  return STAGE_ERROR_INFO[code] ?? { title: code, advice: text_MESSAGES.fallback };
}

export function stageErrorTitle(raw: string): { title: string | null; code: string | null } {
  const m = /^([a-z][a-z0-9_]{2,40}):/.exec(raw.trim());
  const code = m ? m[1]! : /^[a-z][a-z0-9_]{2,40}$/.test(raw.trim()) ? raw.trim() : null;
  return { title: code ? STAGE_ERROR_INFO[code]?.title ?? null : null, code };
}

export function failedStageReason(stage: { stage: string; status: string; last_error?: string | null }, conversion?: Partial<Conversion> | null): string {
  if (stage.stage !== "converted" || stage.status !== "failed") return stage.last_error ?? "";
  return conversionFailedReason(conversion) ?? stageErrorTitle(stage.last_error ?? "").title ?? text_MESSAGES.failed;
}

export function reasonHref(r: { stage: string; code: string; terminal: boolean }): string {
  const q = new URLSearchParams({ status: "failed", stage: r.stage });
  if (r.code) q.set("error_code", r.code);
  q.set("terminal", String(r.terminal));
  return `/admin/unprocessed?${q.toString()}#items`;
}

export function onlyTerminal(r: { stages: ReadonlyArray<{ status: string; terminal?: boolean }> }): boolean {
  const failed = r.stages.filter((s) => s.status === "failed");
  return failed.length > 0 && failed.every((s) => s.terminal === true);
}
