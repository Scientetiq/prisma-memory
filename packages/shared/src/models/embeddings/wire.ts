// Request and answer shapes of the four embedding APIs (the adapters of batch, retry and bisect
// are on top of these). One function builds the body from a profile, one reads the vectors out of the answer and refuses
// anything that is not exactly one finite vector of the expected length per input. Paths are relative to the base
// address of the connection: OpenAI-compatible servers are configured with their `/v1` base; Voyage, Cohere and Gemini
// with the bare host of their API (the values the presets write into `models.<role>_base_url`).
import type { EmbedderDraft } from "./presets.ts";
import type { EmbedderProfile } from "./profile.ts";

export type EmbedKind = "query" | "document";
export interface EmbeddingRequest { path: string; body: Record<string, unknown> }

/** A profile, or a draft whose dimension is not known yet (no dimension parameter is sent then). */
type Shape = Pick<EmbedderProfile | EmbedderDraft, "space" | "ops">;

/** The text that goes to the model: instruction and prefix of the query, prefix of the document. */
export function embeddingInput(p: Shape, text: string, kind: EmbedKind): string {
  return kind === "query" ? `${p.space.query_instruction ?? ""}${p.space.query_prefix}${text}` : `${p.space.document_prefix}${text}`;
}

/**
 * The request of one batch. The OpenAI-compatible body of a legacy profile is `{model, input}` — key for key the body
 * Platform.embed sends today (wire snapshot): the dimension and input type appear only when the profile asks.
 */
/** The model a Gemini request names (`models/<name>`). */
export const geminiModel = (model: string): string => (model.startsWith("models/") ? model : `models/${model}`);

/** The path of a provider's embeddings API for a model (only Gemini names the model in the path). */
export function embeddingPath(provider: EmbedderProfile["ops"]["provider"], model: string): string {
  switch (provider) {
    case "voyage": return "/v1/embeddings";
    case "cohere": return "/v2/embed";
    // each segment encoded on its own: a model name never changes the path, the query or the fragment of the request
    case "gemini": return `/v1beta/${geminiModel(model).split("/").map(encodeURIComponent).join("/")}:batchEmbedContents`;
    default: return "/embeddings";
  }
}

/** The models a request names: the body's `model`, or each Gemini sub-request's. */
export function embeddingRequestModels(req: EmbeddingRequest): unknown[] {
  const b = req.body as Record<string, any>;
  return Array.isArray(b.requests) ? b.requests.map((r: any) => r?.model) : [b.model];
}

/** Where an input sits in a request body: the keys and indexes from the body down to the input string. */
export type InputSlot = readonly (string | number)[];
/** A request and the positions of its inputs, as the builder put them there (one slot per input, in input order). */
export interface BuiltEmbeddingRequest { request: EmbeddingRequest; inputs: readonly InputSlot[] }

export function embeddingRequest(p: Shape, texts: readonly string[], kind: EmbedKind): EmbeddingRequest {
  return embeddingBuild(p, texts, kind).request;
}

/**
 * The one request builder of the embeddings role (ordinary embedding and the probe alike), which also states where each
 * input sits — the positions the probe check compares with the probe text, never a key name.
 */
export function embeddingBuild(p: Shape, texts: readonly string[], kind: EmbedKind): BuiltEmbeddingRequest {
  const s = p.space, input = texts.map((t) => embeddingInput(p, t, kind));
  const it = s.input_type ? { [s.input_type.param]: kind === "query" ? s.input_type.query : s.input_type.document } : {};
  const dims = s.dims_param && s.dims !== null ? s.dims : null;
  switch (p.ops.provider) {
    case "voyage":
      return { request: { path: embeddingPath("voyage", s.model), body: { model: s.model, input, ...it, ...(dims !== null ? { [s.dims_param!]: dims } : {}) } },
               inputs: input.map((_x, i) => ["input", i]) };
    case "cohere":
      return { request: { path: embeddingPath("cohere", s.model), body: { model: s.model, texts: input, ...it, embedding_types: ["float"], ...(dims !== null ? { [s.dims_param!]: dims } : {}) } },
               inputs: input.map((_x, i) => ["texts", i]) };
    case "gemini": {
      const model = geminiModel(s.model);
      const requests = input.map((text) => ({ model, content: { parts: [{ text }] }, ...it, ...(dims !== null ? { outputDimensionality: dims } : {}) }));
      return { request: { path: embeddingPath("gemini", s.model), body: { requests } }, inputs: input.map((_x, i) => ["requests", i, "content", "parts", 0, "text"]) };
    }
    default:
      return { request: { path: embeddingPath("openai-compatible", s.model), body: { model: s.model, input, ...(dims !== null ? { [s.dims_param!]: dims } : {}), ...it } },
               inputs: input.map((_x, i) => ["input", i]) };
  }
}

/** The value at a slot of a body (undefined when the path does not exist). */
export function valueAt(body: unknown, slot: InputSlot): unknown {
  let v: unknown = body;
  for (const k of slot) {
    if (v === null || typeof v !== "object" || !Object.prototype.hasOwnProperty.call(v, k)) return undefined;
    v = (v as Record<string | number, unknown>)[k];
  }
  return v;
}

/** Why an answer was refused — a configuration problem (wrong model, wrong dimension), never retried. */
export class EmbeddingShapeError extends Error {}

/**
 * The vectors of an answer, in input order (`o.ordered` — only when the answer already is in input order). Refused: another number of vectors, an index out of order or twice, a
 * vector of another length (`length` null — any, but all equal), a value that is not a finite number.
 */
export function embeddingVectors(provider: EmbedderProfile["ops"]["provider"], json: any, count: number, length: number | null, o: { ordered?: boolean } = {}): number[][] {
  let vectors: unknown[];
  if (provider === "cohere") vectors = Array.isArray(json?.embeddings?.float) ? json.embeddings.float : [];
  else if (provider === "gemini") vectors = Array.isArray(json?.embeddings) ? json.embeddings.map((e: any) => e?.values) : [];
  else {
    const data: any[] = Array.isArray(json?.data) ? json.data : [];
    const seen = new Set<number>();
    for (const [i, d] of data.entries()) {
      if (!Number.isInteger(d?.index) || d.index < 0 || d.index >= count || seen.has(d.index)) throw new EmbeddingShapeError("the answer numbers its vectors wrongly");
      // `ordered` (the facade): the i-th vector must carry index i — a shuffled answer is refused, not re-sorted
      if (o.ordered && d.index !== i) throw new EmbeddingShapeError("the answer numbers its vectors out of order");
      seen.add(d.index);
    }
    vectors = [...data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
  if (vectors.length !== count) throw new EmbeddingShapeError(`the answer has ${vectors.length} vectors for ${count} inputs`);
  const want = length ?? (Array.isArray(vectors[0]) ? (vectors[0] as unknown[]).length : -1);
  for (const v of vectors) {
    if (!Array.isArray(v) || v.length !== want || want < 1) throw new EmbeddingShapeError(`a vector of another length than ${want}`);
    if (!v.every((x) => typeof x === "number" && Number.isFinite(x))) throw new EmbeddingShapeError("a vector value is not a finite number");
  }
  return vectors as number[][];
}

/** L2 norm of a vector. */
export const l2norm = (v: readonly number[]): number => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

const usageNumber = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/**
 * The input tokens an answered embeddings exchange reports (usage): `usage.prompt_tokens`, else
 * `usage.total_tokens` (OpenAI-compatible servers, Voyage), `meta.billed_units.input_tokens` (Cohere v2); undefined — the
 * answer reports none (Gemini's batchEmbedContents), and the caller estimates.
 */
export function embeddingUsage(provider: EmbedderProfile["ops"]["provider"], json: any): number | undefined {
  if (provider === "cohere") return usageNumber(json?.meta?.billed_units?.input_tokens);
  if (provider === "gemini") return undefined;
  return usageNumber(json?.usage?.prompt_tokens) ?? usageNumber(json?.usage?.total_tokens);
}

/** The texts a request built by `embeddingRequest` carries, in order (for a usage estimate; never logged). */
export function embeddingRequestInputs(req: EmbeddingRequest): string[] {
  const b = req.body as Record<string, any>;
  const raw: unknown[] = Array.isArray(b.input) ? b.input : Array.isArray(b.texts) ? b.texts
    : Array.isArray(b.requests) ? b.requests.map((r: any) => r?.content?.parts?.[0]?.text) : [];
  return raw.map((t) => (typeof t === "string" ? t : ""));
}
