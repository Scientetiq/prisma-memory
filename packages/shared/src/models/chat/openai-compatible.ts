// OpenAI-compatible chat wires. The legacy branch retains the original bytes; new connections use capabilities.
// Policy, slots, schema compilation and validation belong to the facade.
import { PlatformError } from "../../platform-error.ts";
import { withReplyDetail } from "../transport.ts";
import type { ChatAdapter, ChatWireReply, ChatWireRequest, ModelIo, ModelUsageReport, ModelConnection } from "../types.ts";
import { estimateTokens } from "../../ids.ts";
import { connectionChatCapabilities } from "../capabilities.ts";

/**
 * A 400 answer that says "no such model" (an unknown model name, no deployments): a configuration fault (outcome `config`),
 * not a bad request. The text of the answer goes no further than this test.
 */
const MODEL_MISSING = /invalid model|model .*not found|no deployments/i;

export const openAiCompatibleChat: ChatAdapter = {
  preflight(connection, req) { prepareOpenAiChat(connection, req); },
  async chat(io: ModelIo, req: ChatWireRequest): Promise<ChatWireReply> {
    // the sampling profile is spread FIRST: a setting must never override model, messages, max_tokens, seed, stream or
    // response_format, or a settings change could switch the strict schema off
    const { path, body } = prepareOpenAiChat(io.connection, req);
    const reply = await io.post(path, body, { timeoutMs: req.timeoutMs, signal: req.signal });
    const { status, json } = reply;
    const choice = json?.choices?.[0];
    io.report(chatUsage(status < 400 && Boolean(choice), json?.usage, req, choice?.message?.content));
    const code = String(json?.error?.code ?? json?.error?.type ?? "").toLowerCase();
    if (!io.connection.legacy) {
      if (status === 402 || code === "insufficient_quota") throw withReplyDetail(new PlatformError("quota", "the model provider quota or credit is exhausted", status), reply);
      if (["context_length_exceeded", "context_window_exceeded"].includes(code))
        throw withReplyDetail(new PlatformError("context_overflow", "the model provider refused the context length", status), reply);
      if (choice?.message?.refusal || choice?.finish_reason === "content_filter")
        throw new PlatformError("refusal", "the model declined to answer");
    }
    // the provider's Retry-After and short detail go with the error; kinds and messages are today's
    if (status === 429) throw withReplyDetail(new PlatformError("busy", io.texts.busy("chat"), 429), reply);
    if (status >= 400 || !choice) {
      const err = withReplyDetail(new PlatformError("http", io.texts.failed("chat", status, json), status), reply);
      if (status === 400 && MODEL_MISSING.test(String(json?.error?.message ?? json?.error ?? ""))) err.modelMissing = true;
      if (!io.connection.legacy) err.modelMissing = status === 404 || ["model_not_found", "deploymentnotfound", "model_not_available", "invalid_model"].includes(code)
        || (io.connection.params.preset ?? io.connection.preset) === "litellm" && status === 400 && MODEL_MISSING.test(String(json?.error?.message ?? ""));
      throw err;
    }
    // `content: null` (a refusal of the legacy server) stays "not JSON" for the facade, which repairs once
    return {
      text: choice.message?.content ?? "",
      finish: choice.finish_reason === "length" ? "length" : "stop",
      servedModel: json.model == null ? undefined : String(json.model),
      usage: { promptTokens: json.usage?.prompt_tokens, completionTokens: json.usage?.completion_tokens },
    };
  },
};

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/**
 * The usage of one exchange, from the `usage` object of the answer: `prompt_tokens` (they include the cached ones),
 * `prompt_tokens_details.cached_tokens`, `completion_tokens` (they include reasoning tokens) and the cost OpenRouter adds
 * (`usage.cost`, in its credits). An answered call without a count is estimated from the sizes of the messages and of the
 * answer and flagged; a failed one is counted with what it reported (nothing is estimated for it).
 */
function chatUsage(ok: boolean, usage: any, req: ChatWireRequest, content: unknown): ModelUsageReport {
  const u: ModelUsageReport = { ok, inputTokens: num(usage?.prompt_tokens), outputTokens: num(usage?.completion_tokens) };
  const cached = num(usage?.prompt_tokens_details?.cached_tokens), cost = num(usage?.cost);
  if (cached !== undefined) u.cachedInputTokens = cached;
  if (cost !== undefined) u.providerCost = cost;
  if (ok && u.inputTokens === undefined) { u.inputTokens = req.messages.reduce((n, m) => n + estimateTokens(String(m.content ?? "")), 0); u.estimated = true; }
  if (ok && u.outputTokens === undefined) { u.outputTokens = estimateTokens(typeof content === "string" ? content : ""); u.estimated = true; }
  return u;
}

/** Build and check the request before a call slot is charged. The adapter repeats this check for direct callers. */
export function prepareOpenAiChat(connection: ModelConnection, req: ChatWireRequest): { path: string; body: Record<string, unknown> } {
  const caps = req.capabilities ?? connectionChatCapabilities(connection);
  let body: Record<string, unknown>;
  if (connection.legacy) body = {
    ...req.sampling,
    model: req.model, messages: req.messages, max_tokens: req.maxTokens, seed: 0, stream: false,
    response_format: { type: "json_schema", json_schema: { name: req.schemaName, strict: true, schema: req.wireSchema } },
  };
  else {
    let messages = req.messages;
    if (["json_object", "prompt_only"].includes(caps.structured)) messages = [
      { role: "system", content: `Return only a JSON object that satisfies this JSON Schema: ${JSON.stringify(req.wireSchema)}` }, ...messages,
    ];
    body = { ...caps.sampling, ...caps.extra_body, model: req.model, messages, [caps.max_tokens_param]: req.maxTokens, stream: false };
    if (caps.seed !== "off") body[caps.seed] = 0;
    if (caps.reasoning_effort !== undefined) body.reasoning_effort = caps.reasoning_effort;
    if (caps.structured === "json_object") body.response_format = { type: "json_object" };
    else if (caps.structured !== "prompt_only") body.response_format = { type: "json_schema",
      json_schema: { name: req.schemaName, strict: caps.structured === "json_schema_strict", schema: req.wireSchema } };
    if (caps.context_window !== undefined && req.maxTokens + estimateTokens(JSON.stringify(body)) > caps.context_window)
      throw new PlatformError("context_overflow", "the request exceeds the configured context window");
  }
  return { path: connection.legacy ? "/chat/completions" : caps.path, body };
}
