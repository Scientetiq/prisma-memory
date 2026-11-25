import { MemoryError } from "@memory/mcp-core";
export { asData, invalid, mcpTexts, MemoryError, notFound, type ErrorBody, type ErrorCode, type McpTexts } from "@memory/mcp-core";

export const tooLarge = (message: string): MemoryError => new MemoryError("too_large", message);
export const rateLimited = (retryAfter: number): MemoryError =>
  new MemoryError("rate_limited", "Request limit exceeded", { retry_after: Math.max(0, Math.ceil(retryAfter)), hint: "Retry after retry_after seconds" });
export const inProgress = (retryAfter = 5): MemoryError =>
  new MemoryError("in_progress", "The record is moving between classes or spaces", { retry_after: retryAfter });
export const neverOpen = (reason: string): MemoryError =>
  new MemoryError("never_open", "An installation rule prevents making the record open", { reason });
export const classDenied = (message: string): MemoryError => new MemoryError("class_denied", message);
export const openCheckRefused = (message: string, hint: string, details: Record<string, unknown>): MemoryError =>
  new MemoryError("open_check", message, { hint, details: { open_check: details } });
export const notEmpty = (message: string, details: Record<string, unknown>): MemoryError => new MemoryError("not_empty", message, { details });
export const conflict = (message: string, details?: Record<string, unknown>): MemoryError => new MemoryError("conflict", message, details ? { details } : {});

export const archivedDenied = (slug: string, since: Date | string | null, message?: string): MemoryError => {
  const at = since === null ? null : new Date(since);
  const iso = at && !Number.isNaN(at.getTime()) ? at.toISOString() : null;
  const day = iso ? iso.slice(0, 10) : "an unknown date";
  return new MemoryError("class_denied",
    message ?? `Space ${slug} has been archived since ${day} and is read-only. You cannot write, open or restore records there or move them in or out. The space owner can restore it in the workspace, or the memory administrator can restore it.`,
    { hint: "Do not write to another space on your own: ask the person where to save it (memory_me — active spaces).", details: { archived: { space: slug, since: iso } } });
};
export const isArchivedDenied = (e: unknown): boolean =>
  e instanceof MemoryError && e.code === "class_denied" && !!(e.extra.details as { archived?: unknown } | undefined)?.archived;
