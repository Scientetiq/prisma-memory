// Native Messages API. Policy, slots, schema compilation, full validation and repair belong to the facade.
import { estimateTokens } from "../../ids.ts";
import { PlatformError } from "../../platform-error.ts";
import { connectionChatCapabilities } from "../capabilities.ts";
import { withReplyDetail } from "../transport.ts";
import type { ChatAdapter, ChatWireRequest, ModelConnection, ModelUsageReport } from "../types.ts";

export const anthropicChat: ChatAdapter = {
  preflight(connection, req) { prepareAnthropicChat(connection, req); },
  async chat(io, req) {
    const body = prepareAnthropicChat(io.connection, req);
    const reply = await io.post("/v1/messages", body, { timeoutMs: req.timeoutMs, signal: req.signal });
    const { status, json } = reply;
    const answered = status >= 200 && status < 300 && Array.isArray(json?.content);
    const text = answered ? json.content.filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: { text: string }) => b.text).join("") : "";
    const usage = anthropicUsage(answered, json?.usage, req, text);
    io.report(usage);
    const type = String(json?.error?.type ?? "");
    const fail = (kind: ConstructorParameters<typeof PlatformError>[0], message: string): PlatformError =>
      withReplyDetail(new PlatformError(kind, message, status), reply);
    if (status === 402 || status >= 400 && type === "billing_error")
      throw fail("quota", "the model provider quota or credit is exhausted");
    if (status === 429 || status === 529)
      throw fail("busy", "the model provider is busy; retry later");
    if (status === 413) throw fail("context_overflow", "the model provider refused the request size");
    if (status >= 400) {
      const error = fail("http", `the model provider returned HTTP ${status}`);
      error.modelMissing = status === 404 || type === "model_not_found" || json?.error?.code === "model_not_found";
      throw error;
    }
    if (json?.stop_reason === "refusal") throw new PlatformError("refusal", "the model declined to answer");
    if (!answered || !text && json?.stop_reason !== "max_tokens")
      throw fail("bad_response", "the model provider returned no text content blocks");
    return { text, finish: json.stop_reason === "max_tokens" ? "length" : "stop",
      servedModel: typeof json.model === "string" ? json.model : undefined,
      usage: { promptTokens: usage.inputTokens, completionTokens: usage.outputTokens } };
  },
};

function prepareAnthropicChat(connection: ModelConnection, req: ChatWireRequest): Record<string, unknown> {
  const caps = req.capabilities ?? connectionChatCapabilities(connection);
  const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const body: Record<string, unknown> = { model: req.model, ...(system ? { system } : {}),
    messages: req.messages.filter((m) => m.role !== "system"), max_tokens: req.maxTokens, stream: false,
    output_config: { format: { type: "json_schema", schema: req.wireSchema },
      ...(caps.reasoning_effort !== undefined ? { effort: caps.reasoning_effort } : {}) },
    ...(caps.thinking === "disabled" ? { thinking: { type: "disabled" } } : {}) };
  if (caps.context_window !== undefined && req.maxTokens + estimateTokens(JSON.stringify(body)) > caps.context_window)
    throw new PlatformError("context_overflow", "the request exceeds the configured context window");
  return body;
}

const count = (n: unknown): number | undefined => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
/** Anthropic input_tokens excludes both cache counters. Cache creation is input, cache reads are cached input. */
function anthropicUsage(ok: boolean, usage: any, req: ChatWireRequest, text: string): ModelUsageReport {
  const input = count(usage?.input_tokens), created = count(usage?.cache_creation_input_tokens), cached = count(usage?.cache_read_input_tokens);
  const report: ModelUsageReport = { ok, inputTokens: input === undefined ? undefined : input + (created ?? 0) + (cached ?? 0),
    outputTokens: count(usage?.output_tokens) };
  if (cached !== undefined) report.cachedInputTokens = cached;
  if (ok && report.inputTokens === undefined) {
    report.inputTokens = Math.max((created ?? 0) + (cached ?? 0), req.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0));
    report.estimated = true;
  }
  if (ok && report.outputTokens === undefined) { report.outputTokens = estimateTokens(text); report.estimated = true; }
  return report;
}
