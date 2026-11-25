// Shared decoding for new rerank profiles. The legacy adapter keeps its original response handling.
import { PlatformError } from "../../platform-error.ts";
import { estimateTokens } from "../../ids.ts";
import type { RerankCapabilities } from "../presets.ts";
import { withReplyDetail } from "../transport.ts";
import type { ModelIo, ModelReply, ModelUsageReport } from "../types.ts";

export type RerankScore = { index: number; score: number };
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/** Token counts and billed search units are distinct; an omitted unit preserves the legacy detection rules. */
export function rerankUsage(ok: boolean, json: any, query: string, documents: readonly string[], unit?: RerankCapabilities["usage_unit"]): ModelUsageReport {
  if (unit === "none") return { ok };
  const units = unit === "tokens" ? undefined : num(json?.meta?.billed_units?.search_units) ?? (unit === undefined ? undefined : num(json?.usage?.search_units));
  const tokens = unit === "search_units" ? undefined
    : num(json?.meta?.billed_units?.input_tokens) ?? num(json?.meta?.tokens?.input_tokens) ?? num(json?.usage?.total_tokens);
  const u: ModelUsageReport = { ok, searchUnits: units };
  if (tokens !== undefined) u.inputTokens = tokens;
  if (ok && units === undefined && tokens === undefined) {
    u.inputTokens = estimateTokens(query) * documents.length + documents.reduce((n, d) => n + estimateTokens(d), 0);
    u.estimated = true;
  }
  return u;
}

export function checkDocuments(documents: readonly string[], caps: RerankCapabilities): void {
  if (documents.length > caps.max_documents) throw new PlatformError("bad_response", "the rerank request exceeds max_documents");
}

/** Validate before scores enter ranking: indices must be unique and in range, numbers finite and on the chosen scale. */
export function decodeScores(rows: unknown, count: number, field: string, scale: RerankCapabilities["score"]): RerankScore[] {
  if (!Array.isArray(rows) || rows.length !== count) throw new PlatformError("bad_response", "the reranker did not score every document");
  const seen = new Set<number>();
  const scores = rows.map((row: any) => {
    const index = row?.index, score = row?.[field];
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= count || seen.has(index)
      || typeof score !== "number" || !Number.isFinite(score) || scale === "prob01" && (score < 0 || score > 1))
      throw new PlatformError("bad_response", "the reranker returned invalid indices or scores");
    seen.add(index);
    return { index, score: scale === "logit" ? 1 / (1 + Math.exp(-score)) : score };
  });
  return orderScores(scores);
}
export function orderScores(scores: RerankScore[]): RerankScore[] {
  return scores.sort((a, b) => b.score - a.score || a.index - b.index);
}

/** No retry in an adapter: search owns the RRF fallback. Details were already redacted by the transport. */
export function checkRerankReply(io: ModelIo, reply: ModelReply): void {
  const { status, json } = reply;
  if (status < 400 && !json?.error) return;
  const code = json?.error?.code ?? json?.error?.type ?? json?.error_type;
  const quota = status === 402 || code === "insufficient_quota" || code === "billing_error";
  const kind = quota ? "quota" : status === 429 ? "busy" : "http";
  const message = quota ? "the reranker quota is exhausted" : status === 429 ? io.texts.busy("rerank") : io.texts.failed("rerank", status, json);
  throw withReplyDetail(new PlatformError(kind, message, status), reply);
}
