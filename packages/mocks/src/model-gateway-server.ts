// Default model names: the seed names no model any more (`models.t0_aliases` is `[]`), so the mock serves
// MOCK_MODEL_FALLBACK; a seed that still lists names (`seedModelNames`) gives those. A test installation sets its model names
// (`models.llm_model`, `retrieval.embeddings_model`, `retrieval.rerank_model`) to the names the mock serves — or passes
// its own names in MOCK_MODEL_IDS — and allows their pairs in `models.allow_closed`.
//
// STRICT PROTOCOLS — gemini, mistral, cohere, jina, openrouter. Unlike openai, anthropic, voyage and tei they are strict about the
// vendor's documented path (`STRICT_PROTOCOLS`): the version segment is required and only the listed endpoints exist, so
// an adapter that builds a wrong path fails on the mock and not first on the live service. Selected by the launch
// parameter, by a path prefix (`/gemini`, `/mistral`, `/cohere`, `/jina`, `/openrouter`) or by a path no other protocol
// has (`/v1beta/models…` — gemini, `/v2/rerank` — cohere, `/api/v1/…` — openrouter). Errors use each vendor's envelope.
//   • gemini: `POST /v1beta/models/{model}:generateContent`, key only in `x-goog-api-key` (a key in the URL is ignored);
//     `contents`, `systemInstruction`, `generationConfig {responseMimeType, responseJsonSchema, maxOutputTokens,
//     thinkingConfig}` → `candidates[{content {role: "model", parts[{text}]}, finishReason, index}]`, `usageMetadata
//     {promptTokenCount, candidatesTokenCount, totalTokenCount, thoughtsTokenCount — only when thinking was asked for}`,
//     `modelVersion`, `responseId`; `GET /v1beta/models`. Errors `{error: {code, message, status}}` (google.rpc);
//   • mistral: `POST /v1/chat/completions` in the OpenAI shape with `random_seed`; the request schema is closed — an
//     unknown field (`seed`, `max_completion_tokens`) is 422 `{detail: [{type, loc, msg}]}`; `GET /v1/models`;
//   • cohere: `POST /v2/rerank` (`documents` — strings, `top_n`) → `{id, results[{index, relevance_score}], meta
//     {api_version, billed_units {search_units}}}`; errors `{id, message}`;
//   • jina: `POST /v1/rerank` (`top_n`, `return_documents`, default true) → `{model, object: "list", usage
//     {total_tokens}, results[{index, relevance_score, document {text}}]}`; errors `{detail, code}`;
//   • openrouter: `POST /api/v1/rerank` → `{id, model, provider, results[{index, relevance_score, document {text}}],
//     usage {search_units, total_tokens, cost}}`, `POST /api/v1/chat/completions` (OpenAI shape), `GET /api/v1/models`;
//     errors `{error: {code, message}}`, out of credits — 402.
// Embedding endpoints of these protocols are not served here, except `embeddings` of openrouter
// (`STRICT_PROTOCOLS[…].endpoints`).
// Faults map to each protocol: `length` — gemini `finishReason: "MAX_TOKENS"`; `refusal` — gemini `finishReason:
// "SAFETY"` and a candidate without content, mistral — a plain-text answer (it has no refusal field); the new kind
// `prompt_blocked` (chat only) — gemini `promptFeedback.blockReason` and no candidates, openai-shaped chats
// `finish_reason: "content_filter"`, anthropic `stop_reason: "refusal"`; `unauthorized` on gemini is the vendor's 400
// `API_KEY_INVALID`, a missing key — 403 `PERMISSION_DENIED`.
// What was checked against the vendors (the rest is best effort):
// request and response fields of all five from the API references; the error envelope and the missing/invalid-key
// answers of all five from live calls without a key. Not checked: the status and text of quota and unknown-model
// errors of cohere, jina and mistral, the mistral envelope outside 401 and 422, `Retry-After` on a gemini 429, the
// `models[]` wrapper of `GET /v1beta/models`.
//
// RECORD MODE IS NOT A RELAY. The upstream key belongs to the owner, so `record` forwards only what a model
// adapter sends: `POST` to a model endpoint (`RECORD_ENDPOINTS`); any other method or path is answered 404
// `record_refused` and never leaves the process. Forwarded: the path without its query, the JSON body, the upstream key
// in the header of the protocol (`x-api-key`, `x-goog-api-key`, otherwise Bearer); of the caller's headers only a
// well-formed `anthropic-version`. A 3xx answer is not followed and not saved: 502 `upstream_redirect`. A 401 or 403 of
// the upstream is passed to the caller but not saved, and the upstream key is cut out of every answer (`[upstream key]`):
// vendors repeat the key, or its tail, in the answer to a rejected key. The key is trimmed when it is read (HTTP trims
// the header, so the vendor echoes the trimmed key) and cut out of every string of the parsed answer, whatever JSON
// escapes the upstream used (`\/`, `\u…`); an answer that is not JSON is cut as text, in the plain and the `\/` spelling.
// A key shorter than `MIN_REDACTED_KEY` (8) characters is not cut out: such a key is a placeholder of a local server
// (`ollama`, `x`), not a secret, and cutting it would break ordinary words of the answer. A tail of the key is not
// caught either: still read a recorded file before committing it.
// The launcher (model-gateway.ts) listens on loopback in this mode unless a host is given (`defaultListenHost`).
// Loopback alone does not keep a web page out (a page open in the owner's browser can post to 127.0.0.1, a rebound DNS
// name can also read the answer), so in `record` mode, and only there:
//   • every request, the control endpoints included, is refused with 403 `record_refused` when it carries `Origin`, a
//     `Sec-Fetch-Site` other than `none`, or a `Host` that is not an IP address or `localhost` (`pageRequest`) — reach a
//     recording mock by address, not by a DNS or compose service name;
//   • a forwarded request must have the content type `application/json` (415 `record_refused`): a cross-site POST without
//     a preflight cannot have it;
//   • a forwarded request must carry the caller's key on every protocol, `tei` included, whenever the mock holds an
//     upstream key; only an upstream without a key (a local TEI) can be recorded by a keyless adapter. A bare
//     `Authorization: Bearer` (an adapter with an empty key) is no key;
//   • `recordToken` (launcher: `MOCK_MODEL_RECORD_TOKEN`, environment only) makes the caller's key a secret: every
//     request outside `/health` and `/mock/admin` must present exactly it. The launcher refuses to start `record` on an
//     address other than loopback without the token.
// The other modes hold no key and answer as before, whatever the headers.
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { join } from "node:path";

export type ModelProtocol = "openai" | "anthropic" | "voyage" | "tei" | "gemini" | "mistral" | "cohere" | "jina" | "openrouter";
export const MODEL_PROTOCOLS: readonly ModelProtocol[] = ["openai", "anthropic", "voyage", "tei", "gemini", "mistral", "cohere", "jina", "openrouter"];
export type ModelGatewayMode = "generate" | "record" | "replay";
export const MODEL_GATEWAY_MODES: readonly ModelGatewayMode[] = ["generate", "record", "replay"];
export type ModelFaultKind = "rate_limit" | "insufficient_quota" | "invalid_schema" | "model_missing" | "redirect" | "slow" | "length"
  | "refusal" | "prompt_blocked" | "http_500" | "unavailable" | "unauthorized";
export const MODEL_FAULT_KINDS: readonly ModelFaultKind[] = ["rate_limit", "insufficient_quota", "invalid_schema", "model_missing", "redirect",
  "slow", "length", "refusal", "prompt_blocked", "http_500", "unavailable", "unauthorized"];

/** Address the launcher listens on when none is given: `record` holds the owner's upstream key, so it stays on loopback;
 *  `generate` and `replay` keep the previous default (compose installations reach the mock by its service name). */
export function defaultListenHost(mode: ModelGatewayMode): string {
  return mode === "record" ? "127.0.0.1" : "0.0.0.0";
}

/** A listen address only this machine can reach. */
export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** Why a request looks like one made by a web page — `null` when it does not. Record mode refuses such requests (see the
 *  header): a model adapter sends neither `Origin` nor `Sec-Fetch-Site` and addresses the mock by IP or as `localhost`. */
export function pageRequest(headers: IncomingMessage["headers"]): string | null {
  if (headers.origin !== undefined) return "a request with an Origin header";
  const site = headers["sec-fetch-site"];
  if (site !== undefined && String(site).trim().toLowerCase() !== "none") return "a request with Sec-Fetch-Site other than none";
  // exactly `host` or `host:port`, the host written as a browser would send it: no userinfo, no other spelling of an address
  const host = /^(\[[^\]]+\]|[^:/@?#\s]+)(?::\d{1,5})?$/.exec(String(headers.host ?? "").trim())?.[1] ?? "";
  const name = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (name !== "localhost" && !isIP(name)) return "a request whose Host is not an IP address or localhost";
  return null;
}

export interface ModelGatewayFault {
  kind: ModelFaultKind;
  path?: string;
  method?: string;
  times?: number;
  after?: number;
  retryAfter?: number;
  retryAfterDate?: boolean;
  delayMs?: number;
  location?: string;
  status?: number;
}

export interface ModelGatewayMockOptions {
  protocol: ModelProtocol;
  /** Read the caller's key according to the protocol or only from the `api-key` header. */
  keyHeader: "protocol" | "api-key";
  /** Accept requests without a key outside record mode. */
  keyless: boolean;
  models: string[];
  strictModels: boolean;
  embedDims: number;
  fill: number;
  mode: ModelGatewayMode;
  fixturesDir: string | null;
  upstream: string | null;
  upstreamKey: string | null;
  /** record: when set, the key every caller must present (see the header); never forwarded, saved or logged. */
  recordToken: string | null;
  slowMs: number;
}

/** The model names of `models.t0_aliases` in the schema seed; null when there is no seed, no such row or an empty list. */
export function seedModelNames(seed: string | URL = new URL("../../../contracts/schema/04-seed.sql", import.meta.url)): string[] | null {
  try {
    const m = /\(:'instance',\s*'models',\s*'t0_aliases',\s*'(\[[^']*\])'/.exec(readFileSync(seed, "utf8"));
    const names: unknown = m ? JSON.parse(m[1]!) : null;
    return Array.isArray(names) && names.length > 0 && names.every((x) => typeof x === "string" && x) ? names as string[] : null;
  } catch {
    return null;
  }
}

/** The default names when the seed lists none (the tree's seed) or there is no seed (an image without contracts/). */
export const MOCK_MODEL_FALLBACK: readonly string[] = ["mock-chat", "mock-embed", "mock-rerank"];

export const MODEL_GATEWAY_MOCK_DEFAULTS: ModelGatewayMockOptions = {
  protocol: "openai", keyHeader: "protocol", keyless: false,
  models: seedModelNames() ?? [...MOCK_MODEL_FALLBACK], strictModels: false, embedDims: 2048, fill: 0,
  mode: "generate", fixturesDir: null, upstream: null, upstreamKey: null, recordToken: null, slowMs: 2000,
};

export interface ModelGatewayLogEntry { at: string; method: string; protocol: ModelProtocol; endpoint: string; model: string | null; status: number; fault: ModelFaultKind | null; ms: number; bytes_in: number }

type Schema = Record<string, unknown>;
interface Reply { status: number; body: unknown; headers?: Record<string, string> }

const TEXT = "answer of the model simulator";
/** Plain answer of the strict protocols (the generator's filler inside schema answers stays `TEXT`). */
const TEXT_EN = "mock model answer";
const QUOTE_FIELD = /quote|excerpt|evidence|citation|цитат/i;
const CHAT_ENDPOINTS = ["chat/completions", "messages", "generateContent"];
const MODEL_ENDPOINTS = [...CHAT_ENDPOINTS, "embeddings", "rerank"];
/** What `record` may forward (with `POST`): the calls of a model adapter and nothing else. */
const RECORD_ENDPOINTS: readonly string[] = MODEL_ENDPOINTS;
const CHAT_ONLY_FAULTS: readonly ModelFaultKind[] = ["length", "refusal", "prompt_blocked", "invalid_schema"];
const PROTOCOL_PREFIX = /^\/(openai|anthropic|voyage|tei|gemini|mistral|cohere|jina|openrouter)(?=\/)/;
/** Protocols with the vendor's exact path: the version segment is required, other endpoints do not exist. */
const STRICT_PROTOCOLS: Partial<Record<ModelProtocol, { version: RegExp; endpoints: readonly string[] }>> = {
  gemini: { version: /^\/v1beta(?=\/)/, endpoints: ["generateContent", "batchEmbedContents", "models"] },
  mistral: { version: /^\/v1(?=\/)/, endpoints: ["chat/completions", "models"] },
  cohere: { version: /^\/v2(?=\/)/, endpoints: ["rerank"] },
  jina: { version: /^\/v1(?=\/)/, endpoints: ["rerank"] },
  openrouter: { version: /^\/api\/v1(?=\/)/, endpoints: ["chat/completions", "embeddings", "rerank", "models"] },
};
/** Request fields of Mistral chat completions (the vendor's schema is closed: anything else is 422). */
const MISTRAL_CHAT_FIELDS: ReadonlySet<string> = new Set(["model", "temperature", "top_p", "max_tokens", "stream", "stop", "random_seed", "metadata", "messages",
  "response_format", "tools", "tool_choice", "presence_penalty", "frequency_penalty", "min_tokens", "repetition_penalty", "top_k", "logprobs", "top_logprobs",
  "prompt_logprobs", "top_prompt_logprobs", "n", "prediction", "parallel_tool_calls", "reasoning_effort", "prompt_mode", "guardrails", "prompt_cache_key",
  "service_tier", "safe_prompt"]);
/** The strict protocols speak English on every branch; the other four keep their own texts. */
const say = (protocol: ModelProtocol, ru: string, en: string): string => (STRICT_PROTOCOLS[protocol] ? en : ru);
const sameSecret = (a: string, b: string): boolean => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
const REFUSAL_TEXT = "I cannot help with this request.";
/** Shorter upstream keys are not cut out of recorded answers (see the header). */
export const MIN_REDACTED_KEY = 8;
const KEY_MARK = "[upstream key]";

/** The answer with every spelling of `key` replaced by `[upstream key]` — in strings and in object keys, at any depth.
 *  A short key (below `MIN_REDACTED_KEY`) or none leaves the answer as it is. */
export function cutKey(answer: unknown, key: string | null): unknown {
  if (!key || key.length < MIN_REDACTED_KEY) return answer;
  const escaped = JSON.stringify(key).slice(1, -1);
  const spellings = [...new Set([key, escaped, escaped.replace(/\//g, "\\/")])].sort((a, b) => b.length - a.length);
  const cut = (s: string): string => spellings.reduce((t, k) => t.split(k).join(KEY_MARK), s);
  const walk = (x: unknown): unknown => {
    if (typeof x === "string") return cut(x);
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(x)) Object.defineProperty(out, cut(k), { value: walk(v), enumerable: true, writable: true, configurable: true });
      return out;
    }
    return x;
  };
  return walk(answer);
}

/** Protocol a path names by itself (prefix or a path only one protocol has) — `null` when the path does not say. */
function pathProtocol(pathname: string): ModelProtocol | null {
  const path = pathname.replace(/^\/moved(?=\/)/, "");
  const pre = PROTOCOL_PREFIX.exec(path);
  if (pre) return pre[1] as ModelProtocol;
  if (/^\/api\/v1\//.test(path)) return "openrouter";
  if (path === "/v2/rerank") return "cohere";
  if (/^\/v1beta\/models(?:\/|$)/.test(path)) return "gemini";
  return null;
}
const PATTERN_CANDIDATES = ["ru", "en", "2026-01-01", "0:00", "00:00", "00:00:00", "a", "0", "x", "mock"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));


export function sourceText(text: string): string {
  const last = (rx: RegExp): string | null => {
    let out: string | null = null;
    for (const m of text.matchAll(rx)) out = m[1] ?? "";
    return out;
  };
  return last(/<source\s[^>]*>([\s\S]*?)<\/source>/g) ?? last(/<source>([\s\S]*?)<\/source>/g) ?? text;
}

export function sourceQuote(source: string, min = 10, max = 600): string | null {
  for (const raw of source.split("\n")) {
    const line = raw.replace(/^\s*(\[[^\]\n]{1,20}\]\s*)?([^:\n]{1,40}:\s+)?/, "").trim();
    if (line.length < min) continue;
    if (line.length <= max) return line;
    const cut = line.slice(0, max), sp = cut.lastIndexOf(" ");
    const q = sp >= min ? cut.slice(0, sp) : cut;
    return q.trimEnd().length >= min ? q.trimEnd() : q;
  }
  return null;
}

function fitText(base: string, min: number, max: number): string {
  let t = base;
  while (t.length < min) t += " text";
  return t.slice(0, Math.max(min, Math.min(max, t.length)));
}

export function generateBySchema(schema: unknown, o: { source?: string; fill?: number } = {}): unknown {
  const root = (schema ?? {}) as Schema;
  const ctx = { source: o.source ?? "", fill: Math.max(0, o.fill ?? 0), root };
  return gen(root, "", 0, ctx);
}

function resolveRef(ref: string, root: Schema): Schema {
  if (!ref.startsWith("#/")) return {};
  let cur: unknown = root;
  for (const part of ref.slice(2).split("/")) cur = (cur as Record<string, unknown> | undefined)?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  return (cur ?? {}) as Schema;
}

function gen(s: Schema, name: string, index: number, ctx: { source: string; fill: number; root: Schema }): unknown {
  if (!s || typeof s !== "object") return null;
  if (typeof s.$ref === "string") return gen(resolveRef(s.$ref, ctx.root), name, index, ctx);
  if ("const" in s) return s.const;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum.find((x) => x !== null) ?? s.enum[0];
  const variants = (s.anyOf ?? s.oneOf) as Schema[] | undefined;
  if (Array.isArray(variants) && variants.length) return gen(variants.find((v) => v.type !== "null") ?? variants[0]!, name, index, ctx);
  if (Array.isArray(s.allOf) && s.allOf.length) return gen(Object.assign({}, ...(s.allOf as Schema[])), name, index, ctx);
  // lower-cased: Gemini's `responseSchema` (OpenAPI subset) spells the types `OBJECT`, `STRING`…
  const types = (Array.isArray(s.type) ? s.type as string[] : typeof s.type === "string" ? [s.type] : s.properties ? ["object"] : s.items ? ["array"] : ["string"])
    .map((x) => String(x).toLowerCase());
  if (types.includes("null") && !(ctx.fill > 0 && QUOTE_FIELD.test(name))) return null;
  const t = types.find((x) => x !== "null") ?? "null";
  switch (t) {
    case "object": {
      const props = (s.properties ?? {}) as Record<string, Schema>, out: Record<string, unknown> = {};
      for (const k of (s.required ?? []) as string[]) out[k] = gen(props[k] ?? {}, k, index, ctx);
      return out;
    }
    case "array": {
      const min = Number(s.minItems ?? 0), max = s.maxItems === undefined ? Infinity : Number(s.maxItems);
      const n = Math.max(min, Math.min(ctx.fill, max));
      return Array.from({ length: n }, (_, i) => gen((s.items ?? {}) as Schema, name, i, ctx));
    }
    case "string": {
      const min = Number(s.minLength ?? 0), max = s.maxLength === undefined ? 4000 : Number(s.maxLength);
      // Non-passthrough dialects retain dropped patterns in the description. The mock sees the same hints as a model.
      const describedPattern = typeof s.description === "string"
        ? /Constraints: .*?must match the regular expression (.*?)(?:; in the .* format)?\.$/s.exec(s.description)?.[1] : undefined;
      const pattern = typeof s.pattern === "string" ? s.pattern : describedPattern;
      if (pattern !== undefined) {
        const rx = new RegExp(pattern, "u");
        const hit = PATTERN_CANDIDATES.find((c) => rx.test(c) && c.length >= min && c.length <= max);
        if (hit) return hit;
      }
      if (QUOTE_FIELD.test(name)) { const q = sourceQuote(ctx.source, Math.max(min, 1), max); if (q) return q; }
      return fitText(index ? `${TEXT} ${index + 1}` : TEXT, min, max);
    }
    case "integer":
    case "number": {
      const lo = s.minimum !== undefined ? Number(s.minimum) : s.exclusiveMinimum !== undefined ? Number(s.exclusiveMinimum) + 1 : 0;
      return t === "integer" ? Math.ceil(lo) : lo;
    }
    case "boolean": return false;
    default: return null;
  }
}


const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

export function embedText(text: string, dims: number): number[] {
  const v = new Float64Array(dims);
  for (const w of words(text)) {
    const h = createHash("sha256").update(w).digest();
    v[h.readUInt32BE(0) % dims] += (h[4]! & 1) ? 1 : -1;
  }
  let norm = Math.hypot(...v);
  if (!norm) { v[0] = 1; norm = 1; }
  return Array.from(v, (x) => Math.round((x / norm) * 1e6) / 1e6);
}

export function overlapScore(query: string, doc: string): number {
  const q = new Set(words(query)), d = new Set(words(doc));
  if (!q.size || !d.size) return 0;
  let common = 0;
  for (const w of q) if (d.has(w)) common++;
  return Math.round((common / Math.sqrt(q.size * d.size)) * 1e6) / 1e6;
}


const ERROR_STATUS: Record<string, number> = { authentication_error: 401, billing_error: 402, permission_error: 403, not_found_error: 404,
  unprocessable_error: 422, rate_limit_error: 429, api_error: 500, internal_error: 500, overloaded_error: 503 };
const GOOGLE_RPC_STATUS: Record<number, string> = { 400: "INVALID_ARGUMENT", 401: "UNAUTHENTICATED", 403: "PERMISSION_DENIED", 404: "NOT_FOUND",
  429: "RESOURCE_EXHAUSTED", 500: "INTERNAL", 503: "UNAVAILABLE", 504: "DEADLINE_EXCEEDED" };

/** Error body in the envelope of the protocol. `status` matters where the envelope repeats it (gemini, openrouter);
 *  without it — the usual status of the error type. */
function errorBody(protocol: ModelProtocol, type: string, message: string, code?: string, status: number = ERROR_STATUS[type] ?? 400): unknown {
  switch (protocol) {
    case "anthropic": return { type: "error", error: { type, message } };
    case "gemini": return { error: { code: status, message, status: GOOGLE_RPC_STATUS[status] ?? "UNKNOWN" } };
    case "cohere": return { id: "mock-error", message };
    case "jina": return { detail: message, ...(code ? { code } : {}) };
    case "mistral": return status === 401 ? { detail: message } : { object: "error", message, type, param: null, code: code ?? null };
    case "openrouter": return { error: { code: status, message } };
    default: return { error: { message, type, ...(code ? { code } : {}) } };
  }
}

/** `errorBody` with its status, for the checks of the strict protocols. */
function refuse(protocol: ModelProtocol, status: number, type: string, message: string, code?: string): Reply {
  return { status, body: errorBody(protocol, type, message, code, status) };
}

const tokens = (s: string) => Math.max(1, Math.ceil(s.length / 4));

function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(",")}]`;
  if (x && typeof x === "object") return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canonical((x as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(x);
}

function messagesText(body: Record<string, any>): string {
  const parts: string[] = [];
  if (typeof body.system === "string") parts.push(body.system);
  else if (Array.isArray(body.system)) for (const b of body.system) if (typeof b?.text === "string") parts.push(b.text);
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (typeof m?.content === "string") parts.push(m.content);
    else if (Array.isArray(m?.content)) for (const b of m.content) if (typeof b?.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

/** Text of a Gemini request: `systemInstruction` (also spelled `system_instruction`) and every text part of `contents`. */
function geminiText(body: Record<string, any>): string {
  const parts: string[] = [];
  for (const c of [body.systemInstruction ?? body.system_instruction, ...(Array.isArray(body.contents) ? body.contents : [])])
    for (const p of Array.isArray(c?.parts) ? c.parts : []) if (typeof p?.text === "string") parts.push(p.text);
  return parts.join("\n");
}

const hash12 = (x: unknown) => createHash("sha256").update(canonical(x)).digest("hex").slice(0, 12);

export class ModelGatewayMock {
  readonly opts: ModelGatewayMockOptions;
  private readonly server: Server;
  private faults: Array<ModelGatewayFault & { left: number; skip: number }> = [];
  private readonly seenModels = new Set<string>();
  private readonly counts = new Map<string, number>();
  private entries: ModelGatewayLogEntry[] = [];

  constructor(opts: Partial<ModelGatewayMockOptions> = {}) {
    // the key as HTTP will carry it (headers are trimmed): the same string is what the upstream may echo back
    this.opts = { ...MODEL_GATEWAY_MOCK_DEFAULTS, ...opts, models: [...(opts.models ?? MODEL_GATEWAY_MOCK_DEFAULTS.models)],
                  upstreamKey: opts.upstreamKey?.trim() || null };
    if (this.opts.keyHeader === "api-key" && this.opts.protocol !== "openai") throw new TypeError();
    if (this.opts.keyless && (this.opts.mode === "record" || opts.upstreamKey != null || opts.recordToken != null)) throw new TypeError();
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((e: Error) => {
        if (!res.headersSent) this.send(res, { status: 500, body: errorBody(this.opts.protocol, "internal_error", e.message.slice(0, 200)) });
      });
    });
  }

  listen(port: number, host = "127.0.0.1"): Promise<number> {
    return new Promise((resolve) => this.server.listen(port, host, () => resolve((this.server.address() as { port: number }).port)));
  }

  close(): Promise<void> {
    this.server.closeAllConnections?.();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  inject(fault: ModelGatewayFault): void {
    if (!MODEL_FAULT_KINDS.includes(fault.kind)) throw new Error(`unknown fault kind: ${String(fault.kind)}`);
    this.faults.push({ ...fault, left: fault.times ?? 1, skip: fault.after ?? 0 });
  }

  clearFaults(): void { this.faults = []; }

  reset(): void { this.faults = []; this.counts.clear(); this.entries = []; this.seenModels.clear(); }

  state(): { protocol: ModelProtocol; mode: ModelGatewayMode; models: string[]; fill: number; strict_models: boolean; requests: Record<string, number>; faults_pending: number } {
    return { protocol: this.opts.protocol, mode: this.opts.mode, models: this.modelList(), fill: this.opts.fill, strict_models: this.opts.strictModels,
             requests: Object.fromEntries(this.counts), faults_pending: this.faults.length };
  }

  log(): ModelGatewayLogEntry[] { return [...this.entries]; }

  private modelList(): string[] { return [...new Set([...this.opts.models, ...this.seenModels])]; }

  private send(res: ServerResponse, r: Reply): void {
    const payload = Buffer.from(JSON.stringify(r.body ?? {}), "utf8");
    res.writeHead(r.status, { "content-type": "application/json", "content-length": payload.length, ...(r.headers ?? {}) });
    res.end(payload);
  }

  private static applies(f: ModelGatewayFault, method: string, endpoint: string): boolean {
    if (f.method && f.method.toUpperCase() !== method) return false;
    if (f.path ? !new RegExp(f.path).test(endpoint) : !MODEL_ENDPOINTS.includes(endpoint)) return false;
    return !CHAT_ONLY_FAULTS.includes(f.kind) || CHAT_ENDPOINTS.includes(endpoint);
  }

  private takeFault(method: string, endpoint: string): ModelGatewayFault | null {
    for (const f of this.faults) {
      if (!ModelGatewayMock.applies(f, method, endpoint)) continue;
      if (f.skip > 0) { f.skip--; continue; }
      if (f.left > 0 && --f.left === 0) this.faults = this.faults.filter((x) => x !== f);
      return f;
    }
    return null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", "http://mock");
    const method = (req.method ?? "GET").toUpperCase();
    const record = this.opts.mode === "record";
    if (record) {   // the process holds the owner's key: nothing a web page sends is looked at, the control endpoints included
      const why = pageRequest(req.headers);
      if (why) return this.send(res, refuse(this.opts.protocol, 403, "permission_error", `record mode refuses ${why}`, "record_refused"));
    }
    let body: Record<string, any> = {};
    if (raw.length) {
      try { body = JSON.parse(raw.toString("utf8")) as Record<string, any>; }
      catch {
        // a path of a strict protocol answers in its own envelope and in English; other paths — as before, by the launch protocol
        const named = pathProtocol(url.pathname), p = named && STRICT_PROTOCOLS[named] ? named : this.opts.protocol;
        return this.send(res, { status: 400, body: errorBody(p, "invalid_request_error", say(p, "the body is not JSON", "the body is not JSON"), undefined, 400) });
      }
    }
    if (url.pathname === "/health") return this.send(res, { status: 200, body: { ok: true } });
    if (url.pathname.startsWith("/mock/admin/")) return this.send(res, this.admin(method, url.pathname.slice("/mock/admin/".length), body));

    const redirected = /^\/moved(?=\/)/.test(url.pathname);
    let path = url.pathname.replace(/^\/moved(?=\/)/, "");
    const asCalled = path;
    let protocol = this.opts.protocol;
    const pre = PROTOCOL_PREFIX.exec(path);
    if (pre) { protocol = pre[1] as ModelProtocol; path = path.slice(pre[0].length); }
    else if (/^\/api\/v1\//.test(path)) protocol = "openrouter";            // paths no other protocol has
    else if (path === "/v2/rerank") protocol = "cohere";
    else if (/^\/v1beta\/models(?:\/|$)/.test(path)) protocol = "gemini";
    let model = typeof body.model === "string" ? body.model : null;
    let endpoint: string, known = true;
    const strict = STRICT_PROTOCOLS[protocol];
    if (strict) {
      const version = strict.version.exec(path);
      endpoint = (version ? path.slice(version[0].length) : path).replace(/^\/+|\/+$/g, "");
      // the model segment is a plain name: an encoded slash or dots only would let a recorded request leave the model path
      const gemini = protocol === "gemini" ? /^models\/([A-Za-z0-9][\w.-]*):(generateContent|batchEmbedContents)$/.exec(endpoint) : null;
      known = version !== null && (gemini ? strict.endpoints.includes(gemini[2]!)
        : endpoint !== "generateContent" && endpoint !== "batchEmbedContents" && strict.endpoints.includes(endpoint));
      if (gemini) { endpoint = gemini[2]!; model = gemini[1]!; }
    } else {
      endpoint = path.replace(/^\/v1(?=\/)/, "").replace(/^\/+|\/+$/g, "");
      if (endpoint === "messages") protocol = "anthropic";
      if (endpoint === "rerank" && Array.isArray(body.texts)) protocol = "tei";
    }

    let fault: ModelFaultKind | null = null;
    const done = (r: Reply) => {
      this.counts.set(endpoint, (this.counts.get(endpoint) ?? 0) + 1);
      this.entries.push({ at: new Date(started).toISOString(), method, protocol, endpoint, model, status: r.status, fault, ms: Date.now() - started, bytes_in: raw.length });
      if (this.entries.length > 500) this.entries.shift();
      this.send(res, r);
    };

    // record: a bare `Bearer` is an empty key, not the key "Bearer"; generate and replay read it as before
    const bearer = String(req.headers.authorization ?? "").replace(record ? /^Bearer(?:\s+|$)/i : /^Bearer\s+/i, "");
    const key = this.opts.keyHeader === "api-key" ? String(req.headers["api-key"] ?? "")
      : protocol === "anthropic" ? String(req.headers["x-api-key"] ?? "") || bearer
      : protocol === "gemini" ? String(req.headers["x-goog-api-key"] ?? "") : bearer;
    // tei has no key of its own; while recording with an upstream key the caller's key is required there too, and a record
    // token must match on every protocol (an absent key does not match)
    const token = record ? this.opts.recordToken : null;
    if ((record || !this.opts.keyless) && (protocol !== "tei" || (record && this.opts.upstreamKey)) && !key.trim())
      return done(ModelGatewayMock.noKey(protocol));
    if (token && !sameSecret(key, token)) return done(this.faultReply({ kind: "unauthorized" }, protocol, asCalled, model)!);
    if (!known) return done(refuse(protocol, 404, "not_found_error", `no such path in the ${protocol} protocol: ${method} ${path}`));

    const f = redirected ? null : this.takeFault(method, endpoint);
    if (f) {
      fault = f.kind;
      const quick = this.faultReply(f, protocol, asCalled, model);
      if (quick) return done(quick);
      if (f.kind === "slow") await sleep(f.delayMs ?? this.opts.slowMs);
    }
    if (model) {
      if (this.opts.strictModels && !this.opts.models.includes(model)) return done(ModelGatewayMock.modelMissing(protocol, model));
      this.seenModels.add(model);
    }
    if (this.opts.mode !== "generate" && !(method === "GET" && endpoint === "models")) {
      // record is not a relay: only the calls of a model adapter leave the process (see the header)
      if (record && !(method === "POST" && RECORD_ENDPOINTS.includes(endpoint) && (endpoint !== "generateContent" || protocol === "gemini")))
        return done(refuse(protocol, 404, "not_found_error", "record mode forwards only POST requests to model endpoints", "record_refused"));
      if (record && !/^application\/json\s*(?:;|$)/i.test(String(req.headers["content-type"] ?? "").trim()))
        return done(refuse(protocol, 415, "invalid_request_error", "record mode forwards only bodies with the content type application/json", "record_refused"));
      return done(await this.recorded(protocol, path, endpoint, method, body, model, req.headers));
    }

    if (method === "GET" && endpoint === "models") return done({ status: 200, body: protocol === "anthropic"
      ? { data: this.modelList().map((id) => ({ id, type: "model", display_name: id, created_at: "2026-01-01T00:00:00Z" })), has_more: false }
      : protocol === "gemini"
      ? { models: this.modelList().map((id) => ({ name: `models/${id}`, baseModelId: id, version: "001", displayName: id, inputTokenLimit: 1_048_576, outputTokenLimit: 65_536,
          supportedGenerationMethods: ["generateContent", "countTokens"] })) }
      : { object: "list", data: this.modelList().map((id) => ({ id, object: "model", created: 0, owned_by: "mock" })) } });
    const noPath = { status: 404, body: errorBody(protocol, "not_found_error", say(protocol, `no path ${method} ${path}`, `no such path in the ${protocol} protocol: ${method} ${path}`)) };
    if (method !== "POST") return done(noPath);
    switch (endpoint === "generateContent" && protocol !== "gemini" ? "" : endpoint) {   // the gemini answer exists only in its protocol
      case "chat/completions": return done(this.chat(body, fault, protocol));
      case "messages": return done(this.messages(body, fault));
      case "generateContent": return done(this.generateContent(body, model ?? "mock-chat", fault));
      case "embeddings": return done(this.embeddings(protocol, body));
      case "batchEmbedContents": return done(protocol === "gemini" && model !== null ? this.batchEmbedContents(body, model) : noPath);
      case "rerank": return done(this.rerank(protocol, body));
      default: return done(noPath);
    }
  }

  /** A request without a key, as each vendor answers it (gemini — 403, the others — 401). */
  private static noKey(protocol: ModelProtocol): Reply {
    switch (protocol) {
      case "gemini": return refuse(protocol, 403, "permission_error",
        "Method doesn't allow unregistered callers (callers without established identity). Please use API Key or other form of API consumer identity to call this API.");
      case "cohere": return refuse(protocol, 401, "authentication_error", "no api key supplied");
      case "jina": return refuse(protocol, 401, "authentication_error", "Invalid API key. Verify your API key or generate a new one.", "AUTH_INVALID_API_KEY");
      case "mistral": return refuse(protocol, 401, "authentication_error", "Invalid API Key");
      case "openrouter": return refuse(protocol, 401, "authentication_error", "No auth credentials found");
      default: return { status: 401, body: errorBody(protocol, "authentication_error", "key is missing", "invalid_api_key") };
    }
  }

  /** An unknown model, as each vendor answers it. */
  private static modelMissing(protocol: ModelProtocol, model: string | null): Reply {
    const name = model ?? "";
    switch (protocol) {
      case "gemini": return refuse(protocol, 404, "not_found_error", `models/${name} is not found for API version v1beta, or is not supported for generateContent.`);
      case "cohere": return refuse(protocol, 404, "not_found_error", `model '${name}' not found, make sure the correct model ID was used and that you have access to the model.`);
      case "jina": return refuse(protocol, 422, "unprocessable_error", `Model ${name} is not supported by this endpoint.`);
      case "mistral": return refuse(protocol, 400, "invalid_model", `Invalid model: ${name}`, "1500");
      case "openrouter": return refuse(protocol, 400, "invalid_request_error", `${name} is not a valid model ID`);
      default: return { status: 400, body: errorBody(protocol, "invalid_request_error", `Invalid model name passed in model=${name}`, "model_not_found") };
    }
  }

  private faultReply(f: ModelGatewayFault, protocol: ModelProtocol, path: string, model: string | null): Reply | null {
    switch (f.kind) {
      case "rate_limit": {
        const sec = Math.max(0, f.retryAfter ?? 1);
        return { status: 429, headers: { "retry-after": f.retryAfterDate ? new Date(Date.now() + sec * 1000).toUTCString() : String(sec) },
                 body: errorBody(protocol, "rate_limit_error", "Rate limit reached, please retry later", "rate_limit_exceeded") };
      }
      case "insufficient_quota": switch (protocol) {
        case "anthropic": return { status: 429, body: errorBody(protocol, "billing_error", "Your credit balance is too low") };
        case "gemini": return refuse(protocol, 429, "rate_limit_error", "You exceeded your current quota, please check your plan and billing details.");
        case "openrouter": return refuse(protocol, 402, "billing_error", "Insufficient credits. Add more credits to continue.");
        case "jina": return refuse(protocol, 402, "billing_error", "Insufficient account balance.", "INSUFFICIENT_BALANCE");
        case "cohere": case "mistral": return refuse(protocol, 429, "insufficient_quota", "You exceeded your current quota for this key.", "insufficient_quota");
        default: return { status: 429, body: { error: { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" } } };
      }
      case "invalid_schema": switch (protocol) {
        case "anthropic": return { status: 400, body: errorBody(protocol, "invalid_request_error", "output_config.format.schema: invalid schema") };
        case "gemini": return refuse(protocol, 400, "invalid_request_error", "Invalid JSON payload received: the response schema is too complex or not supported.");
        case "mistral": case "openrouter": return refuse(protocol, 400, "invalid_request_error", "Invalid schema for response_format: invalid schema", "invalid_json_schema");
        default: return { status: 400, body: { error: { message: "Invalid schema for response_format: invalid schema", type: "invalid_request_error", param: "response_format", code: "invalid_json_schema" } } };
      }
      case "model_missing": return ModelGatewayMock.modelMissing(protocol, model);
      case "redirect": return { status: [301, 302, 307, 308].includes(f.status ?? 0) ? f.status! : 307, headers: { location: f.location ?? `/moved${path}` }, body: {} };
      case "http_500": return { status: 500, body: errorBody(protocol, "api_error", "internal server error") };
      case "unavailable": return { status: 503, body: errorBody(protocol, "overloaded_error", "service unavailable") };
      case "unauthorized": switch (protocol) {
        // a wrong key on Gemini is a 400 with the reason in `details`, not a 401
        case "gemini": return { status: 400, body: { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT",
          details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID", domain: "googleapis.com" }] } } };
        case "cohere": case "jina": case "mistral": case "openrouter": return ModelGatewayMock.noKey(protocol);
        default: return { status: 401, body: errorBody(protocol, "authentication_error", "invalid api key", "invalid_api_key") };
      }
      default: return null;
    }
  }

  private answerData(name: string, schema: unknown, source: string): string {
    const file = this.opts.fixturesDir ? join(this.opts.fixturesDir, "chat", `${name}.json`) : null;
    if (file && name && /^[\w.-]+$/.test(name) && existsSync(file)) return JSON.stringify(JSON.parse(readFileSync(file, "utf8")));
    return JSON.stringify(generateBySchema(schema, { source, fill: this.opts.fill }));
  }

  private chat(body: Record<string, any>, fault: ModelFaultKind | null, protocol: ModelProtocol = "openai"): Reply {
    if (protocol === "mistral") {
      const extra = Object.keys(body).filter((k) => !MISTRAL_CHAT_FIELDS.has(k));
      if (extra.length) return { status: 422, body: { detail: extra.map((k) => ({ type: "extra_forbidden", loc: ["body", k], msg: "Extra inputs are not permitted" })) } };
    }
    const text = messagesText(body);
    const rf = body.response_format;
    let content = rf?.type === "json_schema" ? this.answerData(String(rf.json_schema?.name ?? ""), rf.json_schema?.schema ?? {}, sourceText(text))
      : rf?.type === "json_object" ? "{}" : say(protocol, TEXT, TEXT_EN);
    let finish = "stop";
    if (fault === "length") { content = content.slice(0, Math.max(1, Math.floor(content.length / 2))); finish = "length"; }
    let message: Record<string, unknown> = { role: "assistant", content };
    if (fault === "refusal" || fault === "prompt_blocked") {
      // Mistral has neither a refusal field nor a filter finish reason: the model just answers in prose
      if (protocol === "mistral") { content = REFUSAL_TEXT; message = { role: "assistant", content }; }
      else if (fault === "refusal") message = { role: "assistant", content: null, refusal: say(protocol, "I cannot help with this request", REFUSAL_TEXT) };
      else { message = { role: "assistant", content: null }; finish = "content_filter"; }
    }
    const pt = tokens(text), ct = tokens(content);
    return { status: 200, body: { id: `chatcmpl-mock-${createHash("sha256").update(canonical(body)).digest("hex").slice(0, 12)}`, object: "chat.completion", created: 0,
      model: body.model ?? "mock-chat", choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct } } };
  }

  private messages(body: Record<string, any>, fault: ModelFaultKind | null): Reply {
    const text = messagesText(body);
    const format = body.output_config?.format ?? body.output_format;
    let content = format?.type === "json_schema" ? this.answerData(String(format.name ?? ""), format.schema ?? {}, sourceText(text)) : TEXT;
    let stop = "end_turn";
    if (fault === "length") { content = content.slice(0, Math.max(1, Math.floor(content.length / 2))); stop = "max_tokens"; }
    const refused = fault === "refusal" || fault === "prompt_blocked";
    if (refused) stop = "refusal";
    return { status: 200, body: { id: `msg_mock_${createHash("sha256").update(canonical(body)).digest("hex").slice(0, 12)}`, type: "message", role: "assistant",
      model: body.model ?? "mock-chat", content: refused ? [] : [{ type: "text", text: content }], stop_reason: stop, stop_sequence: null,
      usage: { input_tokens: tokens(text), output_tokens: tokens(content) } } };
  }

  /** Gemini `generateContent` (see the header). The schema has no name on this wire: a recorded answer is looked up by
   *  the `title` of the schema, when it has one. */
  private generateContent(body: Record<string, any>, model: string, fault: ModelFaultKind | null): Reply {
    const invalid = (m: string) => refuse("gemini", 400, "invalid_request_error", m);
    if (!Array.isArray(body.contents) || body.contents.length === 0) return invalid("Invalid value at 'contents': at least one content is required.");
    const config = (body.generationConfig ?? {}) as Record<string, any>;
    const schema = config.responseJsonSchema ?? config.responseSchema;
    if (schema !== undefined && config.responseMimeType !== "application/json")
      return invalid("Invalid value at 'generation_config': a response schema requires response_mime_type 'application/json'.");
    const text = geminiText(body);
    let answer = schema !== undefined ? this.answerData(String((schema as Schema)?.title ?? ""), schema, sourceText(text))
      : config.responseMimeType === "application/json" ? "{}" : TEXT_EN;
    const thinking = config.thinkingConfig as Record<string, any> | undefined;
    const thoughts = thinking && thinking.thinkingBudget !== 0 ? Math.min(64, Math.max(1, Number(thinking.thinkingBudget) > 0 ? Number(thinking.thinkingBudget) : 32)) : 0;
    const prompt = tokens(text);
    const usage = (out: number) => ({ promptTokenCount: prompt, ...(out ? { candidatesTokenCount: out } : {}), totalTokenCount: prompt + out + thoughts,
      ...(thoughts ? { thoughtsTokenCount: thoughts } : {}) });
    const tail = { modelVersion: model, responseId: `mock-${hash12([model, body])}` };
    if (fault === "prompt_blocked") return { status: 200, body: { promptFeedback: { blockReason: "SAFETY" }, usageMetadata: { promptTokenCount: prompt, totalTokenCount: prompt }, ...tail } };
    if (fault === "refusal") return { status: 200, body: { candidates: [{ finishReason: "SAFETY", index: 0 }], usageMetadata: usage(0), ...tail } };
    let finishReason = "STOP";
    if (fault === "length") { answer = answer.slice(0, Math.max(1, Math.floor(answer.length / 2))); finishReason = "MAX_TOKENS"; }
    return { status: 200, body: { candidates: [{ content: { role: "model", parts: [{ text: answer }] }, finishReason, index: 0 }], usageMetadata: usage(tokens(answer)), ...tail } };
  }

  private embeddings(protocol: ModelProtocol, body: Record<string, any>): Reply {
    const input: string[] = Array.isArray(body.input) ? body.input.map(String) : [String(body.input ?? "")];
    const dims = Number(body.dimensions ?? body.output_dimension ?? this.opts.embedDims);
    if (!Number.isInteger(dims) || dims < 1 || dims > 16384) return { status: 400, body: errorBody(protocol, "invalid_request_error", say(protocol, `invalid dimensions ${String(dims)}`, `invalid dimensions: ${String(dims)}`)) };
    const data = input.map((t, index) => ({ object: "embedding", index, embedding: embedText(t, dims) }));
    const total = input.reduce((n, t) => n + tokens(t), 0);
    return { status: 200, body: protocol === "voyage" ? { object: "list", data, model: body.model ?? "mock-embed", usage: { total_tokens: total } }
      : { object: "list", data, model: body.model ?? "mock-embed", usage: { prompt_tokens: total, total_tokens: total } } };
  }

  private batchEmbedContents(body: Record<string, any>, model: string): Reply {
    const invalid = () => refuse("gemini", 400, "invalid_request_error", GOOGLE_RPC_STATUS[400]!);
    if (!Array.isArray(body.requests) || body.requests.length === 0) return invalid();
    const embeddings: Array<{ values: number[] }> = [];
    for (const request of body.requests) {
      if (request?.model !== `models/${model}`) return invalid();
      const parts = request.content?.parts;
      if (!Array.isArray(parts)) return invalid();
      const texts: string[] = [];
      for (const part of parts) {
        if (typeof part?.text === "string") texts.push(part.text);
      }
      if (texts.length === 0) return invalid();
      const dims = request.outputDimensionality === undefined ? this.opts.embedDims : request.outputDimensionality;
      if (!Number.isInteger(dims) || dims < 1 || dims > 16384) return invalid();
      embeddings.push({ values: embedText(texts.join("\n"), dims) });
    }
    return { status: 200, body: { embeddings } };
  }

  private rerank(protocol: ModelProtocol, body: Record<string, any>): Reply {
    const query = String(body.query ?? "");
    if (protocol === "tei") {
      const texts: string[] = Array.isArray(body.texts) ? body.texts.map(String) : [];
      return { status: 200, body: texts.map((t, index) => ({ index, score: overlapScore(query, t) })).sort((a, b) => b.score - a.score) };
    }
    if (protocol === "cohere" || protocol === "jina" || protocol === "openrouter") {
      // request checks of the strict protocols: required fields, a non-empty list, documents as strings (cohere v2) or strings and {text}
      const status = protocol === "jina" ? 422 : 400;
      const invalid = (m: string) => refuse(protocol, status, status === 422 ? "unprocessable_error" : "invalid_request_error", `invalid request: ${m}`);
      if (typeof body.model !== "string" || !body.model) return invalid("model is required");
      if (typeof body.query !== "string") return invalid("query is required");
      if (!Array.isArray(body.documents) || body.documents.length === 0) return invalid("documents must be a non-empty list");
      if (!body.documents.every((d: unknown) => typeof d === "string" || (protocol !== "cohere" && typeof (d as { text?: unknown } | null)?.text === "string")))
        return invalid(protocol === "cohere" ? "documents must be a list of strings" : "each document must be a string or an object with text");
      if (body.top_n !== undefined && body.top_n !== null && !(Number.isInteger(body.top_n) && body.top_n >= 1)) return invalid("top_n must be an integer of at least 1");
    }
    const docs: string[] = (Array.isArray(body.documents) ? body.documents : []).map((d: unknown) => typeof d === "string" ? d : String((d as { text?: unknown })?.text ?? ""));
    // `top_k` is Voyage's name of the limit (the gateway-style path keeps taking both); the strict protocols know only `top_n`
    const top = Number((STRICT_PROTOCOLS[protocol] ? body.top_n : body.top_n ?? body.top_k) ?? docs.length);
    const ranked = docs.map((d, index) => ({ index, relevance_score: overlapScore(query, d) })).sort((a, b) => b.relevance_score - a.relevance_score).slice(0, top);
    const total = docs.reduce((n, d) => n + tokens(query) + tokens(d), 0);
    switch (protocol) {
      case "voyage": return { status: 200, body: { object: "list", data: ranked, model: body.model ?? "mock-rerank", usage: { total_tokens: tokens(query) * Math.max(1, docs.length) } } };
      case "cohere": return { status: 200, body: { id: `mock-rerank-${hash12(body)}`, results: ranked,
        meta: { api_version: { version: "2" }, billed_units: { search_units: Math.max(1, Math.ceil(docs.length / 100)) } } } };
      case "jina": return { status: 200, body: { model: body.model, object: "list", usage: { total_tokens: total },
        results: ranked.map((r) => ({ index: r.index, relevance_score: r.relevance_score, ...(body.return_documents === false ? {} : { document: { text: docs[r.index]! } }) })) } };
      case "openrouter": return { status: 200, body: { id: `gen-rerank-mock-${hash12(body)}`, model: body.model, provider: "Mock",
        results: ranked.map((r) => ({ document: { text: docs[r.index]! }, index: r.index, relevance_score: r.relevance_score })),
        usage: { search_units: 1, total_tokens: total, cost: (total * 5) / 1e8 } } };
      default: return { status: 200, body: { id: "rerank-mock", results: ranked, meta: { billed_units: { search_units: 1 } } } };
    }
  }

  static fingerprint(protocol: ModelProtocol, endpoint: string, body: unknown): string {
    return createHash("sha256").update(`${protocol} ${endpoint} ${canonical(body)}`).digest("hex").slice(0, 24);
  }

  private async recorded(protocol: ModelProtocol, path: string, endpoint: string, method: string, body: Record<string, any>, model: string | null,
                         callerHeaders: IncomingMessage["headers"]): Promise<Reply> {
    const dir = this.opts.fixturesDir ? join(this.opts.fixturesDir, "recorded") : null;
    if (!dir) return { status: 500, body: errorBody(protocol, "api_error", say(protocol, "record and replay modes without a fixtures folder", "record and replay modes need a fixtures folder"), "fixtures_unset") };
    // a model named in the path (gemini) is not in the body: it joins the endpoint of the fingerprint
    const file = join(dir, `${ModelGatewayMock.fingerprint(protocol, protocol === "gemini" && model ? `${endpoint}:${model}` : endpoint, body)}.json`);
    if (this.opts.mode === "replay") {
      if (!existsSync(file)) return { status: 404, body: errorBody(protocol, "not_found_error", say(protocol, "no recorded answer for this request", "no recorded answer for this request"), "fixture_missing") };
      const saved = JSON.parse(readFileSync(file, "utf8")) as { status: number; body: unknown };
      return { status: saved.status, body: saved.body };
    }
    if (!this.opts.upstream) return { status: 500, body: errorBody(protocol, "api_error", say(protocol, "record mode without an upstream address", "record mode needs an upstream address"), "upstream_unset") };
    // Only what `handle` let through gets here in record mode: POST to a model endpoint. Nothing of the caller travels on
    // except the path (no query), the JSON body and a well-formed `anthropic-version`; the key is the upstream's own.
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (protocol === "anthropic") {
      const version = String(callerHeaders["anthropic-version"] ?? "");
      headers["x-api-key"] = this.opts.upstreamKey ?? "";
      headers["anthropic-version"] = /^\d{4}-\d{2}-\d{2}$/.test(version) ? version : "2023-06-01";
    } else if (protocol === "gemini") { if (this.opts.upstreamKey) headers["x-goog-api-key"] = this.opts.upstreamKey; }
    else if (this.opts.upstreamKey) headers.authorization = `Bearer ${this.opts.upstreamKey}`;
    const base = new URL(this.opts.upstream), target = new URL(this.opts.upstream.replace(/\/+$/, "") + path);
    if (method !== "POST" || target.origin !== base.origin) return refuse(protocol, 404, "not_found_error", "record mode forwards only POST requests to model endpoints", "record_refused");
    const r = await fetch(target, { method: "POST", headers, body: JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(300_000) });
    if (r.status >= 300 && r.status < 400) {
      await r.body?.cancel();
      return refuse(protocol, 502, "api_error", `the upstream answered ${r.status}: record mode does not follow redirects`, "upstream_redirect");
    }
    // the upstream key never reaches a file or the caller, even when the upstream repeats it in its answer
    // (in every JSON spelling: the answer is parsed first, then each string is cut; see the header)
    const answer = await r.text();
    let parsed: unknown;
    try { parsed = cutKey(JSON.parse(answer), this.opts.upstreamKey); }
    catch { parsed = { text: (cutKey(answer, this.opts.upstreamKey) as string).slice(0, 2000) }; }
    // an answer to a rejected key is not a fixture: vendors repeat parts of the key there (the caller still gets the answer)
    if (r.status === 401 || r.status === 403) return { status: r.status, body: parsed };
    mkdirSync(dir, { recursive: true });
    const schemaName = body.response_format?.json_schema?.name ?? body.output_config?.format?.name ?? body.generationConfig?.responseJsonSchema?.title ?? null;
    writeFileSync(file, JSON.stringify({ protocol, endpoint, model, schema_name: schemaName, status: r.status, body: parsed }, null, 1) + "\n");
    return { status: r.status, body: parsed };
  }

  private admin(method: string, what: string, body: Record<string, any>): Reply {
    const bad = (m: string): Reply => ({ status: 400, body: { error: { message: m } } });
    if (method === "GET" && what === "state") return { status: 200, body: this.state() };
    if (method === "GET" && what === "log") return { status: 200, body: { entries: this.log() } };
    if (method !== "POST") return { status: 404, body: { error: { message: "no such path" } } };
    if (what === "reset") { this.reset(); return { status: 200, body: { ok: true } }; }
    if (what === "faults/clear") { this.clearFaults(); return { status: 200, body: { ok: true } }; }
    if (what === "fault") {
      if (!MODEL_FAULT_KINDS.includes(body.kind)) return bad(`kind — one of ${MODEL_FAULT_KINDS.join(", ")}`);
      if (body.path !== undefined) { try { new RegExp(String(body.path)); } catch { return bad("path — a regular expression"); } }
      this.inject({ kind: body.kind as ModelFaultKind, ...(body.path !== undefined ? { path: String(body.path) } : {}), ...(body.method ? { method: String(body.method) } : {}),
        ...(Number.isInteger(body.times) && body.times >= 0 ? { times: body.times as number } : {}), ...(Number.isInteger(body.after) && body.after > 0 ? { after: body.after as number } : {}),
        ...(Number.isFinite(body.retry_after) ? { retryAfter: Number(body.retry_after) } : {}), ...(body.retry_after_date === true ? { retryAfterDate: true } : {}),
        ...(Number.isFinite(body.delay_ms) ? { delayMs: Number(body.delay_ms) } : {}), ...(typeof body.location === "string" ? { location: body.location } : {}),
        ...(Number.isInteger(body.status) ? { status: body.status as number } : {}) });
      return { status: 200, body: { ok: true, faults_pending: this.faults.length } };
    }
    if (what === "config") {
      if (body.protocol !== undefined) { if (!MODEL_PROTOCOLS.includes(body.protocol)) return bad(`protocol — ${MODEL_PROTOCOLS.join(", ")}`); this.opts.protocol = body.protocol; }
      if (body.fill !== undefined) { if (!Number.isInteger(body.fill) || body.fill < 0 || body.fill > 50) return bad("fill — an integer 0–50"); this.opts.fill = body.fill; }
      if (body.models !== undefined) { if (!Array.isArray(body.models) || body.models.some((m: unknown) => typeof m !== "string")) return bad("models — a list of strings"); this.opts.models = body.models; }
      if (body.strict_models !== undefined) this.opts.strictModels = body.strict_models === true;
      return { status: 200, body: this.state() };
    }
    return { status: 404, body: { error: { message: "no such path" } } };
  }
}

