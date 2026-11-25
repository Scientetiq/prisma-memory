// Presets of well-known embedding models and the draft profile of a connection.
// A preset is data, not logic: the defaults of one model family (dimension, how the provider reduces it, input type,
// prefixes, input limit, token estimator). The admin needs only provider, address, key and model; anything a preset
// gets wrong is overridden by `models.embeddings[_b]_params` with the same field names. A model without a preset is
// probed once (one synthetic input) and stored in the dimension it answers with, normalised, without prefixes.
//
// Values: vendor documentation as of mid-2026 and first measurements. Entries marked `provisional` wait for
// final defaults and a live smoke test of every provider; a later defaults file may change them. The lab's field names
// (`store_dims`, `batch`, `truncate: "none" | "provider" | "client"`) are accepted in params as aliases.
import { DIMS_PARAMS, EMBEDDING_PROVIDERS, MODEL_NAME_MAX, PREFIX_MAX, SPACE_TAG_MAX, TOKENIZER_FAMILIES, canonicalProfileJson, inputTypeProblems, modelNameProblems, profileProblems, spaceTextProblems,
         type DimsParam, type EmbedderOps, type EmbedderProfile, type EmbedderSpace, type EmbeddingProvider } from "./profile.ts";

/** Space and ops of a model family; `dims: null` — not known before a probe. */
export interface EmbedderPreset {
  /** Matched against the last path segment of the model name, lower case ("BAAI/bge-m3" → "bge-m3"). */
  match: RegExp;
  /** Providers the entry applies to; absent — any. */
  providers?: readonly EmbeddingProvider[];
  space: Partial<Omit<EmbedderSpace, "model">>;
  ops: Partial<Omit<EmbedderOps, "provider">>;
  /** Waits for the lab's final defaults and a live smoke test. */
  provisional?: true;
}

/** Instruction of the instruct-type open models (e5-instruct, Qwen3-Embedding): the English text their authors publish. */
export const WEB_SEARCH_INSTRUCTION = "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ";

/** Input type and the dimension parameter each provider adapter speaks. */
const PROVIDER_DEFAULTS: Record<EmbeddingProvider, { dims_param: DimsParam; input_type: EmbedderSpace["input_type"] }> = {
  "openai-compatible": { dims_param: "dimensions", input_type: null },
  voyage: { dims_param: "output_dimension", input_type: { param: "input_type", query: "query", document: "document" } },
  cohere: { dims_param: "output_dimension", input_type: { param: "input_type", query: "search_query", document: "search_document" } },
  gemini: { dims_param: "output_dimensionality", input_type: { param: "taskType", query: "RETRIEVAL_QUERY", document: "RETRIEVAL_DOCUMENT" } },
};


export const EMBEDDER_PRESETS: readonly EmbedderPreset[] = [
  // OpenAI (also through OpenRouter as openai/<model>)
  { match: /^text-embedding-3-small$/, space: { native_dims: 1536, dims: 1536, dims_param: "dimensions" }, ops: { max_input_tokens: 8191, tokenizer: "cl100k", batch_size: 64 } },
  // 1024 is the size the lab found safe for Matryoshka models: no significant loss against 3072
  { match: /^text-embedding-3-large$/, space: { native_dims: 3072, dims: 1024, dims_param: "dimensions" }, ops: { max_input_tokens: 8191, tokenizer: "cl100k", batch_size: 64 }, provisional: true },
  { match: /^text-embedding-ada-002$/, space: { native_dims: 1536, dims: 1536, dims_param: null }, ops: { max_input_tokens: 8191, tokenizer: "cl100k", batch_size: 64 } },
  // Voyage: native API (provider voyage) or an OpenAI-compatible router (the lab's runs went through OpenRouter)
  { match: /^voyage-(3\.5|3\.5-lite|3-large|4|4-lite|4-large|code-3)$/, providers: ["voyage"],
    space: { native_dims: 1024, dims: 1024, dims_param: "output_dimension" }, ops: { max_input_tokens: 32000, batch_size: 64 }, provisional: true },
  { match: /^voyage-(3\.5|3\.5-lite|3-large|4|4-lite|4-large|code-3)$/, providers: ["openai-compatible"],
    space: { native_dims: 1024, dims: 1024, dims_param: "dimensions", input_type: { param: "input_type", query: "query", document: "document" } },
    ops: { max_input_tokens: 32000, batch_size: 64 }, provisional: true },
  { match: /^voyage-(3|multilingual-2)$/, providers: ["voyage"], space: { native_dims: 1024, dims: 1024, dims_param: null }, ops: { max_input_tokens: 32000, batch_size: 64 } },
  { match: /^voyage-3-lite$/, providers: ["voyage"], space: { native_dims: 512, dims: 512, dims_param: null }, ops: { max_input_tokens: 32000, batch_size: 64 } },
  // Cohere (v2 API)
  { match: /^embed-v4(\.0)?$/, providers: ["cohere"], space: { native_dims: 1536, dims: 1536, dims_param: "output_dimension" }, ops: { max_input_tokens: 128000, batch_size: 96 }, provisional: true },
  { match: /^embed-(multilingual|english)-v3\.0$/, providers: ["cohere"], space: { native_dims: 1024, dims: 1024, dims_param: null }, ops: { max_input_tokens: 512, batch_size: 96 } },
  { match: /^embed-(multilingual|english)-light-v3\.0$/, providers: ["cohere"], space: { native_dims: 384, dims: 384, dims_param: null }, ops: { max_input_tokens: 512, batch_size: 96 } },
  // Gemini: native API, or its OpenAI-compatible endpoint (no task type there)
  { match: /^gemini-embedding-001$/, providers: ["gemini"], space: { native_dims: 3072, dims: 768, dims_param: "output_dimensionality" }, ops: { max_input_tokens: 2048, tokenizer: "gemini", batch_size: 64 }, provisional: true },
  { match: /^gemini-embedding-001$/, providers: ["openai-compatible"], space: { native_dims: 3072, dims: 768, dims_param: "dimensions" }, ops: { max_input_tokens: 2048, tokenizer: "gemini", batch_size: 64 }, provisional: true },
  { match: /^text-embedding-004$/, providers: ["gemini"], space: { native_dims: 768, dims: 768, dims_param: "output_dimensionality" }, ops: { max_input_tokens: 2048, tokenizer: "gemini", batch_size: 64 } },
  // Open weights (TEI, vLLM, Ollama, llama.cpp — OpenAI-compatible /v1)
  { match: /^bge-m3$/, space: { native_dims: 1024, dims: 1024, dims_param: null }, ops: { max_input_tokens: 8192, tokenizer: "xlmr", batch_size: 32 } },
  { match: /^multilingual-e5-small$/, space: { native_dims: 384, dims: 384, dims_param: null, query_prefix: "query: ", document_prefix: "passage: " }, ops: { max_input_tokens: 512, tokenizer: "xlmr", batch_size: 32 } },
  { match: /^multilingual-e5-base$/, space: { native_dims: 768, dims: 768, dims_param: null, query_prefix: "query: ", document_prefix: "passage: " }, ops: { max_input_tokens: 512, tokenizer: "xlmr", batch_size: 32 } },
  { match: /^multilingual-e5-large$/, space: { native_dims: 1024, dims: 1024, dims_param: null, query_prefix: "query: ", document_prefix: "passage: " }, ops: { max_input_tokens: 512, tokenizer: "xlmr", batch_size: 32 } },
  { match: /^multilingual-e5-large-instruct$/, space: { native_dims: 1024, dims: 1024, dims_param: null, query_instruction: WEB_SEARCH_INSTRUCTION }, ops: { max_input_tokens: 512, tokenizer: "xlmr", batch_size: 32 } },
  { match: /^snowflake-arctic-embed-m-v2\.0$/, space: { native_dims: 768, dims: 768, dims_param: null, query_prefix: "query: " }, ops: { max_input_tokens: 8192, tokenizer: "xlmr", batch_size: 32 } },
  { match: /^snowflake-arctic-embed-l-v2\.0$/, space: { native_dims: 1024, dims: 1024, dims_param: null, query_prefix: "query: " }, ops: { max_input_tokens: 8192, tokenizer: "xlmr", batch_size: 32 } },
  { match: /^gte-multilingual-base$/, space: { native_dims: 768, dims: 768, dims_param: null }, ops: { max_input_tokens: 8192, tokenizer: "xlmr", batch_size: 32 } },
  { match: /^nomic-embed-text-v1\.5$/, space: { native_dims: 768, dims: 768, dims_param: null, query_prefix: "search_query: ", document_prefix: "search_document: " }, ops: { max_input_tokens: 8192, tokenizer: "wordpiece", batch_size: 32 } },
  { match: /^nomic-embed-text-v2-moe$/, space: { native_dims: 768, dims: 768, dims_param: null, query_prefix: "search_query: ", document_prefix: "search_document: " }, ops: { max_input_tokens: 512, tokenizer: "xlmr", batch_size: 32 } },
  { match: /^granite-embedding-107m-multilingual$/, space: { native_dims: 384, dims: 384, dims_param: null }, ops: { max_input_tokens: 512, tokenizer: "xlmr", batch_size: 32 } },
  { match: /^qwen3-embedding-0\.6b$/, space: { native_dims: 1024, dims: 1024, dims_param: null, query_instruction: WEB_SEARCH_INSTRUCTION }, ops: { max_input_tokens: 32768, batch_size: 16 }, provisional: true },
  // 2560 and 4096 numbers per vector: kept at 1024 by the client (Matryoshka); 4096 is above the index limit anyway
  { match: /^qwen3-embedding-4b$/, space: { native_dims: 2560, dims: 1024, dims_param: null, truncate: true, query_instruction: WEB_SEARCH_INSTRUCTION }, ops: { max_input_tokens: 32768, batch_size: 16 }, provisional: true },
  { match: /^qwen3-embedding-8b$/, space: { native_dims: 4096, dims: 1024, dims_param: null, truncate: true, query_instruction: WEB_SEARCH_INSTRUCTION }, ops: { max_input_tokens: 32768, batch_size: 16 }, provisional: true },
];

/** The preset of a model for a provider, or null (unknown model: probed). */
export function presetFor(provider: string, model: string): EmbedderPreset | null {
  const name = (model.split("/").pop() ?? model).trim().toLowerCase().replace(/:latest$/, "");
  return EMBEDDER_PRESETS.find((p) => p.match.test(name) && (!p.providers || p.providers.includes(provider as EmbeddingProvider))) ?? null;
}

/** Profile fields an admin may set in `models.embeddings[_b]_params`, the lab's aliases, and `preset` (a name for the panel, read by no rule here). */
const PARAM_KEYS = new Set(["dims", "native_dims", "dims_param", "truncate", "normalize", "input_type", "query_prefix", "document_prefix", "query_instruction", "space_tag",
                            "max_input_tokens", "batch_size", "batch_tokens", "tokenizer", "timeout_ms", "preset", "store_dims", "batch"]);

// The transport reads these keys to address and authenticate requests. They never belong to the space or ops.
export const CONNECTION_PARAM_KEYS = ["auth_scheme", "headers", "path"] as const;

export function profileParams(params: unknown): unknown {
  if (params === null || typeof params !== "object" || Array.isArray(params)) return params;
  const profile = { ...params } as Record<string, unknown>;
  for (const key of CONNECTION_PARAM_KEYS) delete profile[key];
  return profile;
}

/** Problems of a `models.embeddings[_b]_params` value (save-time check; English, by field, never echoes a value). */
export function embeddingsParamsProblems(value: unknown): string[] {
  if (value === null) return [];
  if (typeof value !== "object" || Array.isArray(value)) return ["an object of profile fields is expected"];
  const p = value as Record<string, unknown>, out: string[] = [];
  const extra = Object.keys(p).filter((k) => !PARAM_KEYS.has(k));
  if (extra.length) out.push(`unknown fields ${extra.slice(0, 10).join(", ")} (allowed: ${[...PARAM_KEYS].join(", ")})`);
  const int = (k: string, lo: number, hi: number) => { if (p[k] !== undefined && p[k] !== null && !(Number.isInteger(p[k]) && (p[k] as number) >= lo && (p[k] as number) <= hi)) out.push(`${k}: an integer from ${lo} to ${hi}`); };
  int("dims", 8, 4000); int("store_dims", 8, 4000); int("native_dims", 8, 65536); int("max_input_tokens", 16, 1_000_000);
  int("batch_size", 1, 2048); int("batch", 1, 2048); int("batch_tokens", 16, 10_000_000); int("timeout_ms", 1000, 600_000);
  if (p.dims !== undefined && p.store_dims !== undefined) out.push("dims and store_dims: one of them");
  if (p.batch_size !== undefined && p.batch !== undefined) out.push("batch_size and batch: one of them");
  if (p.dims_param !== undefined && p.dims_param !== null && !(DIMS_PARAMS as readonly unknown[]).includes(p.dims_param)) out.push(`dims_param: one of ${DIMS_PARAMS.join(", ")} or null`);
  if (p.truncate !== undefined && typeof p.truncate !== "boolean" && !["none", "provider", "client"].includes(p.truncate as string)) out.push("truncate: true, false, \"none\", \"provider\" or \"client\"");
  if (p.normalize !== undefined && typeof p.normalize !== "boolean") out.push("normalize: true or false");
  // the same text rules as a registered profile (profile.ts): what the registration would refuse is refused at the save
  for (const k of ["query_prefix", "document_prefix"]) if (p[k] !== undefined) out.push(...spaceTextProblems(k, p[k], PREFIX_MAX));
  if (p.query_instruction !== undefined) out.push(...spaceTextProblems("query_instruction", p.query_instruction, PREFIX_MAX, true));
  if (p.space_tag !== undefined) out.push(...spaceTextProblems("space_tag", p.space_tag, SPACE_TAG_MAX));
  if (p.preset !== undefined && (typeof p.preset !== "string" || p.preset.length > MODEL_NAME_MAX)) out.push("preset: a name");
  if (p.tokenizer !== undefined && !(TOKENIZER_FAMILIES as readonly unknown[]).includes(p.tokenizer)) out.push(`tokenizer: one of ${TOKENIZER_FAMILIES.join(", ")}`);
  // the lab writes {query, document} without the parameter name: the provider's own name is used then
  if (p.input_type !== undefined) out.push(...inputTypeProblems("input_type", p.input_type, true));
  return out;
}

/** A connection as far as the profile needs it (ModelConnection has these fields). */
export interface EmbedderSource { provider: string; model: string; params: Readonly<Record<string, unknown>> }

/** A profile whose dimension may still be unknown (`dims` / `native_dims` null until the probe answers). */
export interface EmbedderDraft {
  space: Omit<EmbedderSpace, "dims" | "native_dims"> & { dims: number | null; native_dims: number | null };
  ops: EmbedderOps;
  /** The preset used, if any, and whether it is provisional — for the result note and the panel. */
  preset: { provisional: boolean } | null;
}

const DEFAULT_OPS: Omit<EmbedderOps, "provider"> = { max_input_tokens: 512, batch_size: 32, batch_tokens: null, tokenizer: "unknown", timeout_ms: 60_000 };

/**
 * Draft profile of a connection: provider defaults ← preset ← params. Problems (unknown provider, a bad params value) —
 * no draft. The dimension stays null when neither the preset nor params know it: then the probe decides.
 */
export function draftProfile(src: EmbedderSource): { draft: EmbedderDraft; problems?: undefined } | { draft?: undefined; problems: string[] } {
  if (!(EMBEDDING_PROVIDERS as readonly string[]).includes(src.provider)) return { problems: [`provider: one of ${EMBEDDING_PROVIDERS.join(", ")}`] };
  const provider = src.provider as EmbeddingProvider;
  const params = profileParams(src.params ?? {}) as Record<string, any>;
  const problems = embeddingsParamsProblems(params);
  problems.push(...modelNameProblems(src.model).map((m) => `model: ${m}`));
  if (problems.length) return { problems };
  const preset = presetFor(provider, src.model);
  const pd = PROVIDER_DEFAULTS[provider];
  const ps = preset?.space ?? {};
  let dimsParam: DimsParam | null = ps.dims_param ?? null;
  let truncate = ps.truncate ?? false;
  if (params.truncate !== undefined) {
    if (params.truncate === "client" || params.truncate === true) { truncate = true; dimsParam = null; }
    else if (params.truncate === "provider") { truncate = false; dimsParam ??= pd.dims_param; }
    else truncate = false;
  }
  if (params.dims_param !== undefined) dimsParam = params.dims_param;
  const inputType = params.input_type === null ? null
    : params.input_type ? { param: params.input_type.param ?? pd.input_type?.param ?? "input_type", query: params.input_type.query, document: params.input_type.document }
    : ps.input_type !== undefined ? ps.input_type : pd.input_type;
  const native = params.native_dims ?? ps.native_dims ?? null;
  const dims = params.dims ?? params.store_dims ?? ps.dims ?? native ?? null;
  const space: EmbedderDraft["space"] = {
    model: src.model, dims, native_dims: native, dims_param: dimsParam, truncate,
    normalize: params.normalize ?? ps.normalize ?? true,
    input_type: inputType,
    query_prefix: params.query_prefix ?? ps.query_prefix ?? "", document_prefix: params.document_prefix ?? ps.document_prefix ?? "",
    query_instruction: params.query_instruction !== undefined ? params.query_instruction : (ps.query_instruction ?? null),
    space_tag: params.space_tag ?? ps.space_tag ?? "",
  };
  const ops: EmbedderOps = { ...DEFAULT_OPS, ...(preset?.ops ?? {}), provider };
  if (params.max_input_tokens !== undefined) ops.max_input_tokens = params.max_input_tokens;
  if ((params.batch_size ?? params.batch) !== undefined) ops.batch_size = params.batch_size ?? params.batch;
  if (params.batch_tokens !== undefined) ops.batch_tokens = params.batch_tokens;
  if (params.tokenizer !== undefined) ops.tokenizer = params.tokenizer;
  if (params.timeout_ms !== undefined) ops.timeout_ms = params.timeout_ms;
  return { draft: { space, ops, preset: preset ? { provisional: preset.provisional === true } : null } };
}

/** The number of values a provider must answer for the probe request of the draft (null — any: the probe tells). */
export function expectedLength(d: EmbedderDraft): number | null {
  if (d.space.truncate) return d.space.native_dims;          // the provider answers in full, the client cuts
  if (d.space.dims_param && d.space.dims !== null) return d.space.dims;
  return d.space.dims ?? d.space.native_dims;
}

/**
 * The final profile: the draft with the dimension from the probe where it was unknown. `probed` — the length of the
 * probe vector (null — no probe). A length that does not fit the draft, or a profile that breaks a rule, is a problem.
 */
export function finishProfile(d: EmbedderDraft, probed: number | null): { profile: EmbedderProfile; problems?: undefined } | { profile?: undefined; problems: string[] } {
  const want = expectedLength(d);
  if (probed !== null && want !== null && probed !== want)
    return { problems: [`the model answered ${probed} numbers per vector, the profile expects ${want}: set dims (and dims_param or truncate) in params`] };
  let { dims, native_dims } = d.space;
  if (probed !== null) {
    if (native_dims === null && !(d.space.dims_param && dims !== null)) native_dims = probed;
    if (dims === null) dims = probed;
  }
  if (dims === null) return { problems: ["the dimension of the model is not known: the probe must answer first"] };
  const profile: EmbedderProfile = { v: 1, space: { ...d.space, dims, native_dims }, ops: d.ops };
  const problems = profileProblems(profile);
  return problems.length ? { problems } : { profile };
}

/**
 * Does a registered space belong to the draft? Every field equal; a dimension the draft does not know yet takes the
 * row's value. So an unknown model already in the registry needs no new probe at every settings reload.
 */
export function spaceMatches(d: EmbedderDraft, space: EmbedderSpace): boolean {
  const filled = { ...d.space, dims: d.space.dims ?? space.dims, native_dims: d.space.native_dims ?? space.native_dims };
  return canonicalProfileJson(filled) === canonicalProfileJson(space);
}
