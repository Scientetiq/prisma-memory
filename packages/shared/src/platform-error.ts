/**
 * `destination_denied` — the model transport refused the destination: the answer was a redirect, the address
 * or one of the addresses its name resolves to is of a refused kind, or the request would leave the configured origin or
 * path. Nothing was sent, or nothing more is sent after the redirect answer.
 */
/**
 * Error kinds thrown by the provider adapters, the data policy and the budget check: `quota` — the provider's
 * quota, credit or billing is exhausted (a configuration fault: outcome `config`, no retry storm); `refusal` — the model
 * declined to answer; `context_overflow` — the request does not fit the model's context window (both: an answer with an
 * error, no repair); `budget_exhausted` — the money budget of the install is spent (outcome `blocked`: the stage waits,
 * the breaker is not touched). There is no kind for a rate limit: a 429 stays `busy` and carries `retryAfterMs`.
 */
/**
 * `policy_denied` — the data policy: the pair "base URL + model" of the call is not allowed to receive records
 * of the call's class (`models.allow_closed`, `models.allow_open`). Nothing was sent; outcome `blocked`.
 */
export type PlatformErrorKind = "not_configured" | "busy" | "timeout" | "http" | "schema_error" | "bad_response" | "gate" | "gate_lost" | "aborted"
  | "destination_denied" | "quota" | "refusal" | "context_overflow" | "budget_exhausted" | "policy_denied";

export const EMBEDDING_QUOTA_MESSAGE = "the embeddings provider quota or credit is exhausted";

export function isEmbeddingQuotaExhausted(status: number, json: unknown): boolean {
  const body = json as { error?: { code?: unknown; type?: unknown }; error_type?: unknown } | null | undefined;
  return status === 402 || [body?.error?.code, body?.error?.type, body?.error_type]
    .some((code) => code === "insufficient_quota" || code === "billing_error");
}

export class PlatformError extends Error {
  modelMissing?: boolean;
  /** Allowlisted transport error code; never an exception message, URL or credential. */
  networkCode?: string;
  fake?: boolean;
  /** How long the provider asked to wait (`Retry-After`, seconds or an HTTP date), in ms, at most 10 minutes. */
  declare retryAfterMs?: number;
  /**
   * The provider's own short code and message, from the known error fields of a JSON answer only: no other field, no
   * request content, the key and token-like strings redacted, at most 200 characters. For `last_error` and the
   * connection test; the message itself stays the facade's text.
   */
  declare providerDetail?: string;
  constructor(readonly kind: PlatformErrorKind, message: string, readonly status?: number) { super(message); }
}
