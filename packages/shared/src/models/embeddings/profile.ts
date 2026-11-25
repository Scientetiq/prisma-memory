// Embedder profile. A registry row of `embedders` describes one vector space: the model on the wire
// and everything that changes the numbers it returns for a text (dimension, how it is reduced, normalisation, input type,
// prefixes, instruction). That part — the "space" — never changes once vectors exist: another space is another embedder
// with its own id, derived from the space itself, so "a changed profile is a new id" holds by construction. The "ops"
// part (provider adapter, input limit, batch, token estimator, timeout) changes without re-embedding.
//
// A row written before profiles existed (`embedders.profile IS NULL`) is a legacy row: its profile is put together from
// the row and today's settings, so the request on the wire stays byte-for-byte what it was (wire snapshot).
import { createHash } from "node:crypto";
import { EMBEDDER_DIMS_MAX, EMBEDDER_DIMS_MIN, EMBEDDER_ID_RE } from "../../embedding-sql.ts";

/** Wire names of the server-side Matryoshka parameter: OpenAI and compatible, Voyage and Cohere, Gemini. */
export const DIMS_PARAMS = ["dimensions", "output_dimension", "output_dimensionality"] as const;
export type DimsParam = (typeof DIMS_PARAMS)[number];
export const EMBEDDING_PROVIDERS = ["openai-compatible", "voyage", "cohere", "gemini"] as const;
export type EmbeddingProvider = (typeof EMBEDDING_PROVIDERS)[number];
/** Token estimator family; `legacy` = characters / 4, the estimate of an install upgraded from 2048 dims. */
export const TOKENIZER_FAMILIES = ["cl100k", "xlmr", "wordpiece", "gemini", "unknown", "legacy"] as const;
export type TokenizerFamily = (typeof TOKENIZER_FAMILIES)[number];

/** Immutable part: defines the vector space. */
export interface EmbedderSpace {
  /** Model name on the wire. */
  model: string;
  /** Stored dimension (after a dimension request or truncation), 8…4000 (HNSW over halfvec). */
  dims: number;
  /** What the model returns without a dimension request; null — not known. */
  native_dims: number | null;
  /** Server-side Matryoshka: the parameter that asks the provider for `dims` numbers. */
  dims_param: DimsParam | null;
  /** Client-side Matryoshka: keep the first `dims` numbers, then L2-normalise. */
  truncate: boolean;
  /** L2-normalise on the client. */
  normalize: boolean;
  /** Input type parameter of the provider (input_type, task, taskType…) and its values for a query and a document. */
  input_type: { param: string; query: string; document: string } | null;
  query_prefix: string;
  document_prefix: string;
  /** Instruction written before every query (instruct-type models); null — none. */
  query_instruction: string | null;
  /** Free text that forces a new space for the same settings (quantised weights, a fine-tune, a server change). */
  space_tag: string;
}

/** Mutable part: changes without re-embedding. */
export interface EmbedderOps {
  provider: EmbeddingProvider;
  max_input_tokens: number;
  batch_size: number;
  batch_tokens: number | null;
  tokenizer: TokenizerFamily;
  timeout_ms: number;
}

export interface EmbedderProfile { v: 1; space: EmbedderSpace; ops: EmbedderOps }

/** JSON with object keys sorted at every level and no white space: the same value gives the same text. */
export function canonicalProfileJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalProfileJson).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalProfileJson(o[k])}`).join(",")}}`;
}

/** The model name as a part of an id: lower case, runs of other characters → "-", at most `max` characters. */
export function modelSlug(model: string, max = 40): string {
  const s = model.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^[-.]+/, "").slice(0, max).replace(/[-.]+$/, "");
  return s || "model";
}

/** Embedder id from the space: `<model slug>-<dims>-<first 8 hex of sha256(canonical space)>` (fits EMBEDDER_ID_RE). */
export function embedderId(space: EmbedderSpace): string {
  const hash = createHash("sha256").update(canonicalProfileJson(space)).digest("hex").slice(0, 8);
  return `${modelSlug(space.model)}-${space.dims}-${hash}`;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Limits of the free-text fields of a space: long enough for any known instruction, short enough to be a setting. */
export const MODEL_NAME_MAX = 200, PREFIX_MAX = 500, SPACE_TAG_MAX = 100, INPUT_TYPE_VALUE_MAX = 100;

/**
 * Names an input type parameter may not take: the fields the request bodies of the four APIs are built from (wire.ts) —
 * an input type named `model` or `input` would replace the model or the texts on the wire — and the names that mean
 * something to a JavaScript object.
 */
export const INPUT_TYPE_RESERVED: ReadonlySet<string> = new Set(["model", "input", "texts", "content", "parts", "requests", "dimensions", "output_dimension",
  "output_dimensionality", "outputDimensionality", "embedding_types", "encoding_format", "__proto__", "constructor", "prototype"]);
const INPUT_TYPE_PARAM_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * Problems of a model name — one rule for the settings save, the draft and the registered profile: 1 to 200 characters,
 * no spaces at the ends, no control characters, and nothing that would change a request path (Gemini names the model
 * in the path): no "?", "#", "\" and no "." or ".." segment.
 */
export function modelNameProblems(model: unknown): string[] {
  const ok = typeof model === "string" && model.length > 0 && model.length <= MODEL_NAME_MAX && model === model.trim() && !/[\u0000-\u001f\u007f?#\\]/.test(model)
    && !model.split("/").some((seg) => seg === "." || seg === "..");
  return ok ? [] : [`a model name of 1 to ${MODEL_NAME_MAX} characters without spaces at the ends, control characters, "?", "#", "\\" or a "." or ".." path segment`];
}

/** Problems of a free text of a space (prefix, instruction, tag): at most `max` characters, no control characters but tab and line breaks. */
export function spaceTextProblems(field: string, value: unknown, max: number, nullable = false): string[] {
  if (nullable && value === null) return [];
  return isStr(value) && value.length <= max && !CONTROL.test(value) ? [] : [`${field}: ${nullable ? "null or " : ""}text of at most ${max} characters without control characters`];
}

/**
 * Problems of an input type {param, query, document}; `paramOptional` — the params form of the settings, where the
 * provider's own parameter name is taken when it is absent. Values: 1 to 100 characters, no control characters.
 */
export function inputTypeProblems(field: string, value: unknown, paramOptional = false): string[] {
  if (value === null) return [];
  const it = value as Record<string, unknown>;
  const fine = !!it && typeof it === "object" && !Array.isArray(it) && Object.keys(it).every((k) => ["param", "query", "document"].includes(k))
    && ["query", "document"].every((k) => { const v = it[k]; return isStr(v) && v.length > 0 && v.length <= INPUT_TYPE_VALUE_MAX && !CONTROL.test(v); })
    && ((paramOptional && it.param === undefined) || (isStr(it.param) && INPUT_TYPE_PARAM_RE.test(it.param) && !INPUT_TYPE_RESERVED.has(it.param)));
  return fine ? [] : [`${field}: null or {${paramOptional ? "param?" : "param"}, query, document} — a parameter name that is not a field of the request `
    + `(such as model, input, texts, content, dimensions) and two values of 1 to ${INPUT_TYPE_VALUE_MAX} characters`];
}

/** What is wrong with a profile (English, names the field; never echoes a value). Empty — the profile is valid. */
export function profileProblems(p: unknown): string[] {
  const out: string[] = [];
  if (!p || typeof p !== "object") return ["profile: an object is expected"];
  const { v, space: s, ops: o } = p as Partial<EmbedderProfile>;
  if (v !== 1) out.push("profile.v: 1 is expected");
  if (!s || typeof s !== "object") out.push("profile.space: an object is expected");
  else {
    out.push(...modelNameProblems(s.model).map((p) => `space.model: ${p}`));
    if (!isInt(s.dims) || s.dims < EMBEDDER_DIMS_MIN || s.dims > EMBEDDER_DIMS_MAX)
      out.push(`space.dims: an integer from ${EMBEDDER_DIMS_MIN} to ${EMBEDDER_DIMS_MAX} (the vector index limit); a larger model needs dims_param or truncate`);
    if (s.native_dims !== null && (!isInt(s.native_dims) || s.native_dims < EMBEDDER_DIMS_MIN || s.native_dims > 65536))
      out.push("space.native_dims: an integer or null");
    if (s.dims_param !== null && !(DIMS_PARAMS as readonly unknown[]).includes(s.dims_param)) out.push(`space.dims_param: one of ${DIMS_PARAMS.join(", ")} or null`);
    if (typeof s.truncate !== "boolean") out.push("space.truncate: true or false");
    if (typeof s.normalize !== "boolean") out.push("space.normalize: true or false");
    if (s.truncate === true && s.dims_param !== null && s.dims_param !== undefined) out.push("space.truncate: either the provider (dims_param) or the client (truncate) reduces the dimension, not both");
    if (isInt(s.dims) && isInt(s.native_dims) && s.dims > s.native_dims) out.push("space.dims: larger than the model returns (native_dims)");
    if (isInt(s.dims) && isInt(s.native_dims) && s.dims < s.native_dims && !s.dims_param && s.truncate !== true)
      out.push("space.dims: smaller than the model returns — set dims_param (the provider reduces it) or truncate (the client does)");
    out.push(...inputTypeProblems("space.input_type", s.input_type === undefined ? {} : s.input_type));
    for (const k of ["query_prefix", "document_prefix"] as const) out.push(...spaceTextProblems(`space.${k}`, s[k], PREFIX_MAX));
    out.push(...spaceTextProblems("space.query_instruction", s.query_instruction === undefined ? 0 : s.query_instruction, PREFIX_MAX, true));
    out.push(...spaceTextProblems("space.space_tag", s.space_tag, SPACE_TAG_MAX));
    const extra = Object.keys(s).filter((k) => !SPACE_KEYS.includes(k as keyof EmbedderSpace));
    if (extra.length) out.push(`profile.space: unknown fields ${extra.join(", ")}`);
  }
  if (!o || typeof o !== "object") out.push("profile.ops: an object is expected");
  else {
    if (!(EMBEDDING_PROVIDERS as readonly unknown[]).includes(o.provider)) out.push(`ops.provider: one of ${EMBEDDING_PROVIDERS.join(", ")}`);
    if (!isInt(o.max_input_tokens) || o.max_input_tokens < 16 || o.max_input_tokens > 1_000_000) out.push("ops.max_input_tokens: an integer from 16 to 1000000");
    if (!isInt(o.batch_size) || o.batch_size < 1 || o.batch_size > 2048) out.push("ops.batch_size: an integer from 1 to 2048");
    if (o.batch_tokens !== null && (!isInt(o.batch_tokens) || o.batch_tokens < 16 || o.batch_tokens > 10_000_000)) out.push("ops.batch_tokens: null or an integer from 16 to 10000000");
    if (!(TOKENIZER_FAMILIES as readonly unknown[]).includes(o.tokenizer)) out.push(`ops.tokenizer: one of ${TOKENIZER_FAMILIES.join(", ")}`);
    if (!isInt(o.timeout_ms) || o.timeout_ms < 1000 || o.timeout_ms > 600_000) out.push("ops.timeout_ms: an integer from 1000 to 600000");
    const extra = Object.keys(o).filter((k) => !OPS_KEYS.includes(k as keyof EmbedderOps));
    if (extra.length) out.push(`profile.ops: unknown fields ${extra.join(", ")}`);
  }
  if (!out.length && !EMBEDDER_ID_RE.test(embedderId(s as EmbedderSpace))) out.push("profile: the id made from it breaks the id rule");
  return out;
}

/**
 * Problems of a profile, or of a draft whose dimension is not known yet (no `v`; `dims` / `native_dims` may be null, a
 * `preset` note may be present): the rules of profileProblems, one rule for every profile wherever it comes from — the
 * probe validates what it is handed with it. Never echoes a value.
 */
export function shapeProblems(p: unknown): string[] {
  if (!p || typeof p !== "object" || Array.isArray(p)) return ["profile: an object is expected"];
  if ("v" in p) return profileProblems(p);
  const { space: s, ops } = p as { space?: Record<string, unknown>; ops?: unknown };
  if (!s || typeof s !== "object") return profileProblems({ v: 1, space: s, ops });
  const native = s.native_dims === null || s.native_dims === undefined ? null : s.native_dims;
  const dims = s.dims === null || s.dims === undefined ? (isInt(native) ? Math.min(native, EMBEDDER_DIMS_MAX) : EMBEDDER_DIMS_MIN) : s.dims;
  return profileProblems({ v: 1, space: { ...s, dims, native_dims: native }, ops });
}

export const SPACE_KEYS: ReadonlyArray<keyof EmbedderSpace> = ["model", "dims", "native_dims", "dims_param", "truncate", "normalize", "input_type", "query_prefix", "document_prefix", "query_instruction", "space_tag"];
export const OPS_KEYS: ReadonlyArray<keyof EmbedderOps> = ["provider", "max_input_tokens", "batch_size", "batch_tokens", "tokenizer", "timeout_ms"];

/** A registry row as the code reads it (`embedders`). */
export interface EmbedderRow {
  id: string; model: string; dims: number; query_instruction: string | null; max_tokens: number;
  profile: EmbedderProfile | null; connection_slot: "a" | "b";
  active: boolean; candidate: boolean; retire_at: string | Date | null; closed_at: string | Date | null;
  /**
   * Required — a reader without the column must not compute the identity of generation 0:
   * the operator's «recompute» lever, part of the vector source (vectorSource).
   */
  vector_generation: number;
}

/** Space tag of a profile put together for a legacy row: the row keeps its id, the tag only marks the origin. */
export const LEGACY_SPACE_TAG = "legacy";

/**
 * Profile of a legacy row (`profile IS NULL`): the model from `retrieval.embeddings_model`, dimension and
 * query instruction from the row, no normalisation, no prefixes, batches of `retrieval.batch`, characters / 4. The
 * request it gives is the request of today (Platform.embed); the row keeps its id.
 */
export function legacyProfile(row: Pick<EmbedderRow, "dims" | "query_instruction" | "max_tokens">, settings: { get<T>(path: string, fallback: T): T; str(path: string): string | null }): EmbedderProfile {
  return {
    v: 1,
    space: { model: settings.str("retrieval.embeddings_model") ?? "", dims: row.dims, native_dims: row.dims, dims_param: null, truncate: false, normalize: false,
             input_type: null, query_prefix: "", document_prefix: "", query_instruction: row.query_instruction ?? null, space_tag: LEGACY_SPACE_TAG },
    ops: { provider: "openai-compatible", max_input_tokens: row.max_tokens, batch_size: settings.get("retrieval.batch", 16), batch_tokens: null, tokenizer: "legacy", timeout_ms: 120_000 },
  };
}

/** The profile a row is served with: its own, or the legacy one put together from the row and the settings. */
export function rowProfile(row: Pick<EmbedderRow, "profile" | "dims" | "query_instruction" | "max_tokens">, settings: Parameters<typeof legacyProfile>[1]): EmbedderProfile {
  return row.profile ?? legacyProfile(row, settings);
}
