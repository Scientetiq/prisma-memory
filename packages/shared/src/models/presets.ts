// Presets are templates. Their suggested address is never used to resolve a runtime connection.
import type { SchemaDialect } from "./schema-dialect.ts";

export type AuthScheme = "bearer" | "api-key" | "x-api-key" | "x-goog-api-key" | "none";
export interface ChatCapabilities {
  structured: "json_schema_strict" | "json_schema" | "json_object" | "prompt_only";
  schema_dialect: SchemaDialect;
  max_tokens_param: "max_tokens" | "max_completion_tokens";
  seed: "off" | "seed" | "random_seed";
  sampling: Readonly<Record<string, unknown>>;
  extra_body: Readonly<Record<string, unknown>>;
  reasoning_effort?: string;
  thinking?: "disabled";
  output_headroom: number;
  max_output_tokens: number;
  context_window?: number;
  auth_scheme: AuthScheme;
  headers: Readonly<Record<string, string>>;
  api_version?: string;
  timeout_sec?: number;
  path: string;
}
export interface ChatPreset {
  /** Native chat tasks add their provider's entries to this same catalog. */
  provider: string;
  baseUrl: string | null;
  capabilities: Readonly<ChatCapabilities>;
  samplingKeys: readonly string[];
  extraBodyKeys: readonly string[];
  unsupportedKeywords: readonly string[];
  modelList: boolean;
}

export const LEGACY_SAMPLING_KEYS = Object.freeze(["temperature", "top_p", "presence_penalty", "frequency_penalty", "repetition_penalty", "top_k", "min_p", "stop", "chat_template_kwargs"]);
const COMMON_SAMPLING = ["temperature", "top_p", "presence_penalty", "frequency_penalty", "stop"];
const EMPTY = Object.freeze({});
const DEFAULTS: Readonly<ChatCapabilities> = Object.freeze({ structured: "json_schema_strict", schema_dialect: "openai_strict",
  max_tokens_param: "max_tokens", seed: "off", sampling: EMPTY, extra_body: EMPTY, output_headroom: 0,
  max_output_tokens: 8000, auth_scheme: "bearer", headers: EMPTY, path: "/chat/completions" });
function preset(baseUrl: string | null, changes: Partial<ChatCapabilities> = {}, samplingKeys = COMMON_SAMPLING,
  extraBodyKeys: string[] = [], unsupportedKeywords: string[] = [], modelList = true): ChatPreset {
  return Object.freeze({ provider: "openai-compatible", baseUrl, capabilities: Object.freeze({ ...DEFAULTS, ...changes }),
    samplingKeys: Object.freeze([...samplingKeys]), extraBodyKeys: Object.freeze(extraBodyKeys),
    unsupportedKeywords: Object.freeze(unsupportedKeywords), modelList });
}
export const CHAT_PRESETS: Readonly<Record<string, ChatPreset>> = Object.freeze({
  litellm: preset(null, { schema_dialect: "passthrough", seed: "seed" }, [...LEGACY_SAMPLING_KEYS], [], ["uniqueItems"]),
  generic: preset(null),
  openai: preset("https://api.openai.com/v1", { max_tokens_param: "max_completion_tokens", output_headroom: 2000 }, []),
  "azure-openai": preset(null, { max_tokens_param: "max_completion_tokens", output_headroom: 2000, auth_scheme: "api-key" }, [], [], [], false),
  openrouter: preset("https://openrouter.ai/api/v1", { extra_body: Object.freeze({ provider: Object.freeze({ require_parameters: true }) }) }, COMMON_SAMPLING, ["provider"]),
  mistral: preset("https://api.mistral.ai/v1", { seed: "random_seed" }, ["temperature", "top_p", "presence_penalty", "frequency_penalty", "stop"]),
  "gemini-openai": preset("https://generativelanguage.googleapis.com/v1beta/openai", { schema_dialect: "gemini", output_headroom: 4000 }),
  ollama: preset("http://127.0.0.1:11434/v1", { structured: "json_schema", schema_dialect: "passthrough", auth_scheme: "none" }, COMMON_SAMPLING, [], ["uniqueItems"]),
  vllm: preset("http://127.0.0.1:8000/v1", { schema_dialect: "passthrough", seed: "seed" }, [...LEGACY_SAMPLING_KEYS].filter((k) => k !== "chat_template_kwargs"), ["chat_template_kwargs"], ["uniqueItems"]),
  lmstudio: preset("http://127.0.0.1:1234/v1"),
  anthropic: Object.freeze({ ...preset("https://api.anthropic.com", { structured: "json_schema", schema_dialect: "anthropic",
    auth_scheme: "x-api-key", api_version: "2026-10-21", output_headroom: 4000, path: "/v1/messages" }, []), provider: "anthropic" }),
  gemini: Object.freeze({ ...preset("https://generativelanguage.googleapis.com", { structured: "json_schema", schema_dialect: "gemini",
    auth_scheme: "x-goog-api-key", output_headroom: 4000, path: "/v1beta/models/{model}:generateContent" }, []), provider: "gemini" }),
});

export interface RerankCapabilities {
  format: "cohere-format" | "voyage" | "tei";
  path: string;
  top_param: "top_n" | "top_k" | null;
  score: "prob01" | "logit";
  max_documents: number;
  usage_unit: "tokens" | "search_units" | "none";
  timeout_ms: number;
  relevance_floor: number;
  extra_body: Readonly<Record<string, unknown>>;
}
export interface RerankPreset {
  provider: string;
  baseUrl: string | null;
  capabilities: Readonly<RerankCapabilities>;
}
function rerankPreset(provider: string, baseUrl: string | null, changes: Partial<RerankCapabilities> = {}): RerankPreset {
  return Object.freeze({ provider, baseUrl, capabilities: Object.freeze({ format: "cohere-format", path: "/rerank",
    top_param: "top_n", score: "prob01", max_documents: 1000, usage_unit: "tokens", timeout_ms: 5000,
    relevance_floor: 0.3, extra_body: EMPTY, ...changes }) });
}
/** Suggested addresses are for setup only; a preset cannot change a connection's destination or key. */
export const RERANK_PRESETS: Readonly<Record<string, RerankPreset>> = Object.freeze({
  cohere: rerankPreset("cohere", "https://api.cohere.com", { path: "/v2/rerank", usage_unit: "search_units" }),
  jina: rerankPreset("jina", "https://api.jina.ai", { path: "/v1/rerank" }),
  openrouter: rerankPreset("openrouter", "https://openrouter.ai/api/v1"),
  voyage: rerankPreset("voyage", "https://api.voyageai.com", { format: "voyage", path: "/v1/rerank", top_param: "top_k" }),
  tei: rerankPreset("tei", null, { format: "tei", top_param: null }),
  vllm: rerankPreset("cohere", null),
  litellm: rerankPreset("cohere", null, { timeout_ms: 60_000 }),
});
