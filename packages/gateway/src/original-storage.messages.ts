// Fixed messages only: provider replies, paths and file content never enter these slots.
import { tr } from "@memory/i18n/context";
import { ORIGINAL_STORAGE as messages } from "./messages/original-storage.ts";

export type OriginalReason = "storage_not_configured" | "storage_unavailable" | "storage_refused";
export const originalNote = (reason: OriginalReason): string => tr(messages[reason]);
export const originalRefusal = (reason: OriginalReason): string => tr(messages[reason === "storage_not_configured" ? "conversion_not_configured"
  : reason === "storage_refused" ? "conversion_refused" : "conversion_unavailable"]);
export const originalHealthDetail = (reason: OriginalReason, cls: string): string => tr(messages[reason === "storage_not_configured" ? "health_not_configured"
  : reason === "storage_refused" ? "health_refused" : "health_unavailable"], { cls });
export const originalStateUnavailable = (): string => tr(messages.state_unavailable);
