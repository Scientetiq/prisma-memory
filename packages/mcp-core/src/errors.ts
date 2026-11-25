// One error format for MCP and REST: codes, body and error class — shared by the gateway and the edge. Here
// also not_found and invalid_argument: the range read (read-range.ts) and cursor parse (paging-cursor.ts) use them.
// The gateway's other refusals are in @memory/shared (errors.ts) on top of this class: one `instanceof MemoryError`
// check for both packages. Foreign and missing look alike: the same not_found.
export type ErrorCode =
  | "not_found" | "invalid_argument" | "too_large" | "rate_limited" | "never_open" | "class_denied" | "in_progress"
  | "unauthorized" | "forbidden" | "not_empty"    // unauthorized and not_empty — REST only; forbidden — tools too: an action for a person only
  | "open_check"                                  // a write to the open class failed the content check
  | "conflict";                                   // REST admin API only: taken by another owner (permission and check-queue registration)

export interface ErrorBody { code: ErrorCode; message: string; hint?: string; retry_after?: number; reason?: string; details?: Record<string, unknown> }

const HTTP: Record<ErrorCode, number> = {
  not_found: 404, invalid_argument: 400, too_large: 413, rate_limited: 429, never_open: 409, class_denied: 403, in_progress: 409,
  unauthorized: 401, forbidden: 403, not_empty: 409, open_check: 422, conflict: 409,
};

export class MemoryError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly extra: Omit<ErrorBody, "code" | "message"> = {}) { super(message); }
  get status(): number { return HTTP[this.code]; }
  body(): ErrorBody { return { ...this.extra, code: this.code, message: this.message }; }
}

// The not_found message is fixed: its text must not depend on whether the record exists.
export const notFound = (): MemoryError =>
  new MemoryError("not_found", "The record, path or space was not found or is not available", { hint: "Check the identifier or path; find the record with memory_search or memory_list" });
export const invalid = (message: string, details?: Record<string, unknown>): MemoryError => new MemoryError("invalid_argument", message, details ? { details } : {});
