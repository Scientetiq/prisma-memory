// Native generateContent wire. The facade owns policy, slots, schema compilation, validation and repair.
import { estimateTokens } from "../../ids.ts";
import { PlatformError } from "../../platform-error.ts";
import { connectionChatCapabilities } from "../capabilities.ts";
import { geminiModelNameProblem } from "../names.ts";
import { withReplyDetail } from "../transport.ts";
import type { ChatAdapter, ChatWireRequest, ModelConnection, ModelUsageReport } from "../types.ts";

const REFUSALS = new Set(["SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "IMAGE_SAFETY"]);

export const geminiChat: ChatAdapter = {
  preflight(connection, req) { prepareGeminiChat(connection, req); },
  async chat(io, req) {
    const body = prepareGeminiChat(io.connection, req);
    const reply = await io.post(`/v1beta/models/${req.model}:generateContent`, body, { timeoutMs: req.timeoutMs, signal: req.signal });
    const { status, json } = reply;
    const candidate = Array.isArray(json?.candidates) ? json.candidates[0] : undefined;
    const blocked = Boolean(json?.promptFeedback?.blockReason) || REFUSALS.has(candidate?.finishReason);
    const answered = status >= 200 && status < 300 && Boolean(blocked || candidate && typeof candidate === "object");
    const text = answered && Array.isArray(candidate?.content?.parts) ? candidate.content.parts
      .filter((p: any) => p?.thought !== true && typeof p?.text === "string").map((p: { text: string }) => p.text).join("") : "";
    const usage = geminiUsage(answered, json?.usageMetadata, req, text);
    io.report(usage);
    const fail = (kind: ConstructorParameters<typeof PlatformError>[0], message: string): PlatformError =>
      withReplyDetail(new PlatformError(kind, message, status), reply);
    const reasons: unknown[] = Array.isArray(json?.error?.details) ? json.error.details
      .filter((d: any) => d?.["@type"] === "type.googleapis.com/google.rpc.ErrorInfo").map((d: any) => d.reason) : [];
    if (status === 400 && reasons.includes("API_KEY_INVALID")) throw fail("not_configured", "the Gemini API key is not valid");
    // RESOURCE_EXHAUSTED alone also means a transient rate limit. Only machine-readable quota reasons select quota.
    const quota = reasons.some((reason) => typeof reason === "string" && ["QUOTA_EXCEEDED", "BILLING_DISABLED", "INSUFFICIENT_QUOTA"].includes(reason));
    if (status === 402 || status >= 400 && quota) throw fail("quota", "the model provider quota or credit is exhausted");
    if (status === 429 || status === 503) throw fail("busy", "the model provider is busy; retry later");
    if (status === 413) throw fail("context_overflow", "the model provider refused the request size");
    if (status >= 400) {
      const error = fail("http", `the model provider returned HTTP ${status}`);
      error.modelMissing = status === 404 || json?.error?.status === "NOT_FOUND";
      throw error;
    }
    if (blocked) throw new PlatformError("refusal", "the model declined to answer");
    if (!answered || !["STOP", "MAX_TOKENS"].includes(candidate?.finishReason) || !text && candidate?.finishReason !== "MAX_TOKENS")
      throw fail("bad_response", "the model provider returned no usable text candidate");
    return { text, finish: candidate.finishReason === "MAX_TOKENS" ? "length" : "stop",
      servedModel: typeof json.modelVersion === "string" ? json.modelVersion : undefined,
      usage: { promptTokens: usage.inputTokens, completionTokens: usage.outputTokens } };
  },
};

function prepareGeminiChat(connection: ModelConnection, req: ChatWireRequest): Record<string, unknown> {
  const problem = typeof req.model === "string" ? geminiModelNameProblem(req.model) : "the Gemini model must be a simple name";
  if (problem) throw new PlatformError("not_configured", problem);
  const caps = req.capabilities ?? connectionChatCapabilities(connection);
  const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const body = { ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: req.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    generationConfig: { responseMimeType: "application/json", responseJsonSchema: req.wireSchema, maxOutputTokens: req.maxTokens,
      ...(caps.seed === "seed" ? { seed: 0 } : {}) } };
  if (caps.context_window !== undefined && req.maxTokens + estimateTokens(JSON.stringify(body)) > caps.context_window)
    throw new PlatformError("context_overflow", "the request exceeds the configured context window");
  return body;
}

const count = (n: unknown): number | undefined => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
/** Prompt tokens already include cached input; totalTokenCount already includes thoughts. Never add either twice. */
function geminiUsage(ok: boolean, usage: any, req: ChatWireRequest, text: string): ModelUsageReport {
  const input = count(usage?.promptTokenCount), cached = count(usage?.cachedContentTokenCount);
  const output = count(usage?.candidatesTokenCount), thoughts = count(usage?.thoughtsTokenCount) ?? 0;
  const report: ModelUsageReport = { ok, inputTokens: input, outputTokens: output === undefined ? undefined : output + thoughts };
  if (cached !== undefined) report.cachedInputTokens = cached;
  if (ok && input === undefined) {
    report.inputTokens = Math.max(cached ?? 0, req.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0));
    report.estimated = true;
  }
  if (ok && output === undefined) { report.outputTokens = (text ? estimateTokens(text) : 0) + thoughts; report.estimated = true; }
  return report;
}
