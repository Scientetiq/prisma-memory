// Capability validation is shared by settings saves and calls: malformed stored JSON cannot bypass it.
import { PlatformError } from "../platform-error.ts";
import { CHAT_PRESETS, RERANK_PRESETS, type ChatCapabilities, type ChatPreset, type RerankCapabilities } from "./presets.ts";
import type { ModelConnection, ModelRole } from "./types.ts";

const own = (o: object, k: string): boolean => Object.hasOwn(o, k);
const object = (x: unknown): x is Record<string, unknown> => Boolean(x) && typeof x === "object" && !Array.isArray(x);
const KEYS = new Set(["preset", "structured", "schema_dialect", "max_tokens_param", "seed", "sampling", "extra_body", "reasoning_effort",
  "output_headroom", "max_output_tokens", "context_window", "auth_scheme", "headers", "api_version", "timeout_sec", "path"]);
const HEADERS = new Set(["http-referer", "x-title"]);
const CHOICES: Record<string, readonly string[]> = {
  structured: ["json_schema_strict", "json_schema", "json_object", "prompt_only"],
  schema_dialect: ["passthrough", "openai_strict", "anthropic", "gemini", "minimal"],
  max_tokens_param: ["max_tokens", "max_completion_tokens"], seed: ["off", "seed", "random_seed"],
  auth_scheme: ["bearer", "api-key", "x-api-key", "x-goog-api-key", "none"],
};
/** Same path rules as the transport, checked early at save time. */
export function modelPathValid(path: unknown): path is string {
  return typeof path === "string" && path.startsWith("/") && !path.startsWith("//")
    && !/[\\?#\s\u0000-\u001f\u007f]|%2f|%5c|%2e/i.test(path)
    && !path.split("/").some((s) => s === "." || s === "..");
}
function templateProblems(value: unknown): boolean {
  return !object(value) || Object.keys(value).some((k) => k !== "enable_thinking" || typeof value[k] !== "boolean");
}
function samplingProblems(value: unknown, preset: ChatPreset): string[] {
  if (!object(value)) return ["sampling: an object is expected"];
  const problems: string[] = [];
  for (const [key, v] of Object.entries(value)) {
    if (!preset.samplingKeys.includes(key)) problems.push(`sampling.${key}: not allowed by the preset`);
    else if (key === "chat_template_kwargs") { if (templateProblems(v)) problems.push(`sampling.${key}: only enable_thinking (boolean) is allowed`); }
    else if (key === "stop") {
      if (!(typeof v === "string" || Array.isArray(v) && v.every((s) => typeof s === "string"))) problems.push("sampling.stop: a string or string array is expected");
    } else if (typeof v !== "number" || !Number.isFinite(v)) problems.push(`sampling.${key}: a finite number is expected`);
    else if (["top_p", "min_p"].includes(key) && (v < 0 || v > 1)
      || ["temperature", "repetition_penalty"].includes(key) && v < 0
      || key === "top_k" && (!Number.isSafeInteger(v) || v < 0)) problems.push(`sampling.${key}: out of range`);
  }
  return problems;
}
/** Unknown fields of other adapter families are owned by their adapter tasks. Common transport fields are checked here. */
export function modelParamsProblems(role: ModelRole, provider: string, value: unknown): string[] {
  if (value === null) return [];
  if (!object(value)) return ["params: an object is expected"];
  const problems: string[] = [];
  if (own(value, "path") && !modelPathValid(value.path)) problems.push("path: a same-origin absolute path without dot segments, query or fragment is expected");
  if (own(value, "headers")) {
    if (!object(value.headers)) problems.push("headers: an object is expected");
    else {
      const seen = new Set<string>();
      for (const [k, v] of Object.entries(value.headers)) {
        const name = k.toLowerCase();
        if (!HEADERS.has(name) || seen.has(name) || typeof v !== "string" || /[^\x20-\x7e\x80-\xff]/.test(v))
          problems.push(`headers.${k}: header not allowed or invalid value`);
        seen.add(name);
      }
    }
  }
  if (own(value, "auth_scheme") && !CHOICES.auth_scheme!.includes(String(value.auth_scheme))) problems.push("auth_scheme: unsupported value");
  if (role === "rerank") return [...problems, ...rerankParamsProblems(provider, value)];
  if (role !== "chat" || provider && !["openai-compatible", "anthropic", "gemini"].includes(provider)) return problems;
  const native = provider === "anthropic";
  const gemini = provider === "gemini";
  for (const k of Object.keys(value)) if (!KEYS.has(k) && !(native && k === "thinking")) problems.push(`${k}: unknown capability`);
  const name = own(value, "preset") ? value.preset : native || gemini ? provider : "generic";
  if (typeof name !== "string" || !own(CHAT_PRESETS, name)) return [...problems, "preset: unknown chat preset"];
  const preset = CHAT_PRESETS[name]!;
  if (provider && preset.provider !== provider) problems.push("preset: does not match the chat provider");
  if (native) {
    for (const key of ["structured", "max_tokens_param", "seed", "path"] as const)
      if (own(value, key) && value[key] !== CHAT_PRESETS.anthropic!.capabilities[key]) problems.push(`${key}: fixed by the native Messages API`);
    if (own(value, "thinking") && value.thinking !== "disabled") problems.push("thinking: only disabled is supported");
    if (own(value, "api_version") && (typeof value.api_version !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.api_version)))
      problems.push("api_version: a YYYY-MM-DD API version is expected");
  }
  if (gemini) {
    for (const key of ["structured", "max_tokens_param", "path"] as const)
      if (own(value, key) && value[key] !== CHAT_PRESETS.gemini!.capabilities[key]) problems.push(`${key}: fixed by the native Gemini API`);
    if (own(value, "seed") && !["off", "seed"].includes(String(value.seed))) problems.push("seed: only off or seed is supported by Gemini");
    if (own(value, "auth_scheme") && !["x-goog-api-key", "none"].includes(String(value.auth_scheme)))
      problems.push("auth_scheme: Gemini keys use x-goog-api-key");
    for (const key of ["reasoning_effort", "api_version"]) if (own(value, key)) problems.push(`${key}: not supported by the native Gemini API`);
  }
  for (const [key, choices] of Object.entries(CHOICES)) if (own(value, key) && (typeof value[key] !== "string" || !choices.includes(value[key] as string)))
    problems.push(`${key}: unsupported value`);
  for (const key of ["output_headroom", "max_output_tokens", "context_window"]) if (own(value, key)
    && (typeof value[key] !== "number" || !Number.isSafeInteger(value[key]) || (value[key] as number) < (key === "output_headroom" ? 0 : 1)))
    problems.push(`${key}: a ${key === "output_headroom" ? "nonnegative" : "positive"} safe integer is expected`);
  if (own(value, "timeout_sec") && (typeof value.timeout_sec !== "number" || !Number.isFinite(value.timeout_sec) || value.timeout_sec <= 0 || value.timeout_sec > 2147483))
    problems.push("timeout_sec: a positive bounded number is expected");
  for (const key of ["reasoning_effort", "api_version"]) if (own(value, key) && (typeof value[key] !== "string" || !/^[A-Za-z0-9_.-]{1,80}$/.test(value[key] as string)))
    problems.push(`${key}: a short identifier is expected`);
  if (own(value, "sampling")) problems.push(...samplingProblems(value.sampling, preset));
  if (own(value, "extra_body")) {
    if (!object(value.extra_body)) problems.push("extra_body: an object is expected");
    else for (const [k, v] of Object.entries(value.extra_body)) {
      if (!preset.extraBodyKeys.includes(k)) problems.push(`extra_body.${k}: not allowed by the preset`);
      else if (k === "chat_template_kwargs" && templateProblems(v)) problems.push("extra_body.chat_template_kwargs: only enable_thinking (boolean) is allowed");
      else if (k === "provider" && (!object(v) || Object.keys(v).some((n) => n !== "require_parameters" || typeof v[n] !== "boolean")))
        problems.push("extra_body.provider: only require_parameters (boolean) is allowed");
    }
  }
  return problems;
}
/** Pure resolution; legacy callers keep the frozen profile regardless of newly stored params. */
export function chatCapabilities(params: Readonly<Record<string, unknown>> = {}, legacy = false, provider = "openai-compatible"): ChatCapabilities {
  if (legacy) return { ...CHAT_PRESETS.litellm!.capabilities };
  const problems = modelParamsProblems("chat", provider, params);
  if (problems.length) throw new PlatformError("not_configured", `invalid chat capabilities: ${problems.join("; ")}`);
  const name = String(params.preset ?? (provider === "openai-compatible" ? "generic" : provider));
  const preset = own(CHAT_PRESETS, name) ? CHAT_PRESETS[name] : undefined;
  if (!preset || preset.provider !== provider) throw new PlatformError("not_configured", "the chat preset does not match the provider");
  const { preset: _name, ...over } = params;
  return { ...preset.capabilities, ...over,
    sampling: { ...preset.capabilities.sampling, ...(params.sampling as object ?? {}) },
    extra_body: { ...preset.capabilities.extra_body, ...(params.extra_body as object ?? {}) },
    headers: { ...preset.capabilities.headers, ...(params.headers as object ?? {}) },
  } as ChatCapabilities;
}
export function connectionChatCapabilities(c: ModelConnection): ChatCapabilities {
  const caps = chatCapabilities(c.preset && !own(c.params, "preset") ? { ...c.params, preset: c.preset } : c.params, c.legacy, c.provider);
  // Ollama may be keyless, but an administrator-supplied key must reach an authenticating proxy.
  if (!c.legacy && (c.params.preset ?? c.preset) === "ollama" && !own(c.params, "auth_scheme") && c.apiKey !== null)
    return { ...caps, auth_scheme: "bearer" };
  return caps;
}
export function connectionChatPreset(c: ModelConnection): ChatPreset {
  return CHAT_PRESETS[c.legacy ? "litellm" : String(c.params.preset ?? c.preset ?? (c.provider === "openai-compatible" ? "generic" : c.provider))]!;
}

const RERANK_KEYS = new Set(["preset", "format", "path", "top_param", "score", "max_documents", "usage_unit", "timeout_ms",
  "relevance_floor", "extra_body", "headers", "auth_scheme"]);
function rerankParamsProblems(provider: string, value: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const k of Object.keys(value)) if (!RERANK_KEYS.has(k)) problems.push(`${k}: unknown rerank capability`);
  const name = value.preset ?? (provider === "none" ? "cohere" : provider || "cohere");
  const preset = typeof name === "string" && own(RERANK_PRESETS, name) ? RERANK_PRESETS[name] : undefined;
  if (!preset || provider && provider !== "none" && preset.provider !== provider) return [...problems, "preset: unknown or mismatched rerank preset"];
  if (own(value, "format") && value.format !== preset.capabilities.format) problems.push("format: does not match the provider");
  for (const [key, choices] of Object.entries({ score: ["prob01", "logit"], usage_unit: ["tokens", "search_units", "none"], top_param: ["top_n", "top_k", null] }))
    if (own(value, key) && !choices.includes(value[key] as never)) problems.push(`${key}: unsupported value`);
  for (const key of ["max_documents", "timeout_ms"]) if (own(value, key)
    && (typeof value[key] !== "number" || !Number.isSafeInteger(value[key]) || (value[key] as number) < 1 || (value[key] as number) > (key === "timeout_ms" ? 2_147_483_647 : 100_000)))
    problems.push(`${key}: a positive bounded safe integer is expected`);
  if (own(value, "relevance_floor") && (typeof value.relevance_floor !== "number" || !Number.isFinite(value.relevance_floor) || value.relevance_floor < 0 || value.relevance_floor > 1))
    problems.push("relevance_floor: a number between zero and one is expected");
  if (own(value, "extra_body")) {
    if (!object(value.extra_body)) problems.push("extra_body: an object is expected");
    else for (const [k, v] of Object.entries(value.extra_body)) {
      if (preset.provider !== "openrouter" || k !== "provider" || !object(v)) problems.push(`extra_body.${k}: only the OpenRouter provider object is allowed`);
      else for (const [field, item] of Object.entries(v)) {
        if (["zdr", "require_parameters", "allow_fallbacks"].includes(field) ? typeof item !== "boolean"
          : ["order", "only", "ignore"].includes(field) ? !Array.isArray(item) || !item.every((s) => typeof s === "string" && s.length > 0)
          : field === "data_collection" ? !["allow", "deny"].includes(String(item))
          : field === "sort" ? !["price", "throughput", "latency"].includes(String(item)) : true)
          problems.push(`extra_body.provider.${field}: unsupported field or value`);
      }
    }
  }
  return problems;
}
/** The frozen legacy profile ignores new overrides; all new calls validate before any network request. */
export function connectionRerankCapabilities(c: ModelConnection): RerankCapabilities {
  if (c.legacy) return { ...RERANK_PRESETS.litellm!.capabilities };
  const params = c.preset && !own(c.params, "preset") ? { ...c.params, preset: c.preset } : c.params;
  const problems = modelParamsProblems("rerank", c.provider, params);
  if (problems.length) throw new PlatformError("not_configured", `invalid rerank capabilities: ${problems.join("; ")}`);
  const preset = RERANK_PRESETS[String(params.preset ?? c.provider)]!;
  return { ...preset.capabilities,
    ...(c.provider === "cohere" && c.endpoint.host !== "api.cohere.com" ? { usage_unit: "tokens" as const } : {}),
    ...params } as RerankCapabilities;
}
