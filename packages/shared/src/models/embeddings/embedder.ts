// The embeddings facade. One registry row in,
// the vectors of that row out: `embedderFor(deps, row)` takes the row's profile (its own, or the legacy profile of a row
// without one) and the live connection of the row's slot (a legacy row: the gateway keys only), copies and freezes the
// connection, and hands out an Embedder for one stage job, one backfill batch or one search request — never cached.
//
// The data policy is enforced in ONE place, `guardedSend` below — the only product code that calls
// `embeddingTransport(`, `.guard(` and `.post(` of an embeddings transport: before EVERY request it asks the platform's guard
// (Platform.modelGuard → dataPolicy, with its audit hook) for the pair "canonical base URL + model" of the frozen
// connection and the class of the content, read live; then posts through the model transport (destination rules, redirects
// refused, the money budget before the request); then reports the usage of the answered exchange with its stage. The
// class has no default: anything but the literal "open" is sent to the guard as "closed".
//
// A call is all-or-nothing. `stop: "policy"` — the guard refused a request: nothing of it was sent and the vectors of
// earlier requests of the call are dropped. `stop: "budget"` — the money budget stopped a request before it was sent
// (`budget_exhausted`): nothing more is sent. Everything else is thrown as the platform's PlatformError,
// unchanged: 429 — `busy` (documents wait `retrieval.retry_429_sec × attempt` up to five times, a query never; a
// Retry-After longer than the next pause ends the waiting), other answers of 400 and above — `http` with the status,
// an answer that is not one finite vector of the space's length per input, in order — `bad_response`. A rejected batch
// (400/413/422) of documents is sent again one input at a time, and a rejected input is cut in half up to three times
// (the sequence is pinned by the test index-budget-pg; the log lines name the caller's `ref`, never the text;
// `truncated` counts only an input a cut really shortened). A request
// that names another model or API than the frozen connection is refused before the guard; the caller's signal ends the
// call at once, a pause on 429 too. No retry of 5xx or time limits, no
// bisection, no fallback embedder, no cache, no database.
import { createHash } from "node:crypto";
import type { DataClass } from "../../db.ts";
import { estimateTokens } from "../../ids.ts";
import { log } from "../../log.ts";
import { EMBEDDING_QUOTA_MESSAGE, isEmbeddingQuotaExhausted, PlatformError } from "../../platform-error.ts";
import { embeddingTransport, type BeforeModelDispatch, type EmbeddingTransport, type Platform } from "../../platform.ts";
import { dataPolicy, dataPolicyAllows } from "../policy.ts";
import { connectionConfigurationProblems } from "../readiness.ts";
import { withReplyDetail } from "../transport.ts";
import type { ConnectionSettings, ModelConnection, ModelReply, ModelUsageReport } from "../types.ts";
import { PROBE_STAGE } from "../usage.ts";
import type { EmbedderDraft } from "./presets.ts";
import type { ProbeShape } from "./probe-body.ts";
import { probeEmbeddings, type ProbeResult } from "./probe.ts";
import { canonicalProfileJson, rowProfile, type EmbedderProfile, type EmbedderRow } from "./profile.ts";
import { rowConnection } from "./registry.ts";
import { rawVectorLength, spaceVectors } from "./transform.ts";
import { embeddingPath, embeddingRequest, embeddingRequestInputs, embeddingRequestModels, embeddingUsage, embeddingVectors, EmbeddingShapeError, geminiModel,
         type EmbedKind, type EmbeddingRequest } from "./wire.ts";

export type EmbedderState = { state: "ready"; embedder: Embedder } | { state: "off"; reason: "disabled" | "not_configured" | "mismatch"; detail: string };

export interface Embedder {
  readonly embedderId: string; readonly dims: number; readonly profile: EmbedderProfile;
  /**
   * The source of this embedder's vectors: vectorSource of the frozen connection it sends to, its space
   * and the row's vector generation. Every stored vector carries the source it was computed with (chunk_embeddings.source)
   * and its reuse hash includes it, so a vector of another source is never reused and never searched with this one.
   */
  readonly source: string;
  /** Pure pre-check for planning, coverage and the query cache: no audit event; never authorises a send. */
  allows(dataClass: DataClass): boolean;
  /**
   * `beforeDispatch` is required: every caller sends record text, and the source rule (workers embed-source.ts)
   * is read again at dispatch — a sender without it does not compile.
   * `onVectors` — called with the number of vectors of each answered request (they are paid for),
   * also when the call ends later with a stop or an error and those vectors never reach the caller.
   */
  embedDocuments(texts: readonly string[], o: { dataClass: DataClass; stage: "indexed" | "embed_backfill"; signal?: AbortSignal; beforeRequest?: () => Promise<void>; beforeDispatch: BeforeModelDispatch; ref?: string; onVectors?: (n: number) => void }): Promise<EmbedOutcome>;
  /** Stage "search_query" fixed inside; no wait on 429. */
  embedQuery(text: string, o: { dataClass: DataClass; timeoutMs: number; signal?: AbortSignal }): Promise<EmbedOutcome>;
}

/** `cut` — the indexes of the texts whose vector is the vector of a cut text (such a vector is never reused). */
export type EmbedOutcome = { ok: true; embedderId: string; vectors: number[][]; tokens: number; tokensEstimated: boolean; truncated: number; cut?: readonly number[] } | { ok: false; stop: "policy" | "budget" };

/** `call.profile` — the probe's profile (stage "probe" only): the transport's guard rebuilds the probe request from it. */
export type GuardedSend = (req: EmbeddingRequest, call: { dataClass: DataClass; stage: "indexed" | "embed_backfill" | "search_query" | "probe"; timeoutMs: number; signal?: AbortSignal; beforeDispatch?: BeforeModelDispatch; profile?: ProbeShape }) => Promise<ModelReply>;

/** The stages documents are embedded for: a caller cannot name itself the search or the probe (budget exemptions). */
const DOCUMENT_STAGES: ReadonlySet<string> = new Set(["indexed", "embed_backfill"]);
const QUERY_STAGE = "search_query";
/** Waits on 429 within one call: documents (today's schedule of Platform.embed), a query none. */
const DOCUMENT_429_WAITS = 5;
/** Cuts in half of one rejected input. */
const INPUT_CUTS = 3;

/** The class sent to the guard: only the literal "open" is open (dataPolicyAllows reads anything else as open). */
const classOf = (c: unknown): DataClass => (c === "open" ? "open" : "closed");

/**
 * The source of a row's vectors: what decides the numbers a model gives for an input — the API, the
 * canonical base URL and the model of the connection, the row's space (dimension, prefixes, normalisation; not its ops:
 * a batch size changes no vector) — and the row's vector generation, the operator's «recompute» lever. Never the
 * key: a rotated key is the same source. 32 hex characters; the same inputs give the same source in every process.
 */
export function vectorSource(c: Pick<ModelConnection, "provider" | "baseUrl" | "model">, space: EmbedderProfile["space"], generation: number): string {
  if (!Number.isInteger(generation) || generation < 0) throw new Error("vector_generation_invalid: an embedder row read without its vector generation");
  return createHash("sha256").update(JSON.stringify(["vector-source/1", c.provider, c.baseUrl, c.model, canonicalProfileJson(space), generation])).digest("hex").slice(0, 32);
}

/** A copy of the connection that no later settings change or caller can move. */
function frozen(c: ModelConnection): ModelConnection {
  return Object.freeze({ ...c, endpoint: Object.freeze({ ...c.endpoint }), params: Object.freeze({ ...c.params }) });
}

/** The API of a connection, as the request shapes know it (a gateway speaks the OpenAI-compatible one). */
const providerOf = (c: ModelConnection): EmbedderProfile["ops"]["provider"] =>
  (c.provider === "voyage" || c.provider === "cohere" || c.provider === "gemini" ? c.provider : "openai-compatible");

/**
 * Does the request name exactly the frozen connection — its API (the path of the provider's shape) and its model (the
 * body's, or each Gemini sub-request's)? The guard is asked for the connection's pair, so a request that names another
 * model or another API would be checked for one pair and sent as another.
 */
function namesConnection(c: ModelConnection, req: EmbeddingRequest): boolean {
  const provider = providerOf(c);
  const want = provider === "gemini" ? geminiModel(c.model) : c.model;
  const models = embeddingRequestModels(req);
  return req.path === embeddingPath(provider, c.model) && models.length > 0 && models.every((m) => m === want);
}

/** The usage of one answered exchange: the provider's count, else an estimate from the inputs (flagged). */
function usageOf(provider: EmbedderProfile["ops"]["provider"], reply: ModelReply, req: EmbeddingRequest): ModelUsageReport {
  const ok = reply.status < 400;
  const tokens = embeddingUsage(provider, reply.json);
  if (tokens !== undefined || !ok) return { ok, inputTokens: tokens };
  return { ok, inputTokens: embeddingRequestInputs(req).reduce((n, s) => n + estimateTokens(s), 0), estimated: true };
}

/**
 * The only place a request of the embeddings role leaves the product (module-private). Per request: the data policy of
 * the frozen pair for the class of the content (live lists, audit hook), the model transport with the stage (the budget asks
 * before sending), one usage report per answered exchange. The transport is made at the first request, so a state
 * without one (no Platform) fails there as `not_configured`, never inside `embedderFor`.
 */
function guardedSend(platform: Platform, connection: ModelConnection): GuardedSend {
  const provider = providerOf(connection);
  let transport: EmbeddingTransport | null = null;
  return async (req, call) => {
    // the pair checked is the pair that receives: a request naming another model or API is refused before the guard
    if (!namesConnection(connection, req)) throw new PlatformError("not_configured", "the embeddings request does not match its connection (another model or API)");
    // the base's readiness rule (models/readiness.ts — a key required by an explicit auth scheme or a hosted
    // preset host, an adapter, the capabilities) refuses before any request, as `Platform.embed` did through need(): never
    // a keyless POST of record text that the provider answers with 401. Codes only: the slot's setting names are health's
    const problems = connectionConfigurationProblems(connection);
    if (problems.length) throw new PlatformError("not_configured", `the embeddings connection is not usable: ${[...new Set(problems.map((p) => p.code))].join(", ")}`);
    if (call.signal?.aborted) throw abortedBy(call.signal);
    transport ??= embeddingTransport(platform,
      connection.role === "embeddings" && connection.provider === "gemini" && connection.params.auth_scheme === undefined
        ? { ...connection, params: { ...connection.params, auth_scheme: "x-goog-api-key" } }
        : connection);
    // the guard's proof is bound to exactly this request (path, body digest), its stage, class and budget rule, and the
    // transport sends nothing without it; the probe (open class, never stopped by the budget) gets one only for the
    // probe request of its validated profile (platform.ts → probe-body.ts); the policy itself is read again at the wire
    const dataClass = classOf(call.dataClass);
    const proof = transport.guard({ role: "embeddings", model: connection.model, use: { dataClass, stage: call.stage }, request: req, ...(call.stage === PROBE_STAGE ? { probe: call.profile } : {}) });
    const reply = await transport.post(req.path, req.body, { timeoutMs: call.timeoutMs, signal: call.signal, stage: call.stage, dataClass, proof, beforeDispatch: call.beforeDispatch });
    transport.report({ ...usageOf(provider, reply, req), stage: call.stage });
    return reply;
  };
}

/** A stop of the call (an outcome, not an error), or null. */
function stopOf(e: unknown): "policy" | "budget" | null {
  if (!(e instanceof PlatformError)) return null;
  return e.kind === "policy_denied" ? "policy" : e.kind === "budget_exhausted" ? "budget" : null;
}
/**
 * The statuses of a rejected input (too long or not acceptable: 400, 413, and 422 of TEI and other pydantic servers), not
 * a passing fault — a repeat of the same batch does not help. One list for the split of a batch and for `embedFailure`.
 */
const REJECTED_STATUSES: ReadonlySet<number> = new Set([400, 413, 422]);
const rejected = (e: unknown): boolean => e instanceof PlatformError && e.kind === "http" && e.status !== undefined && REJECTED_STATUSES.has(e.status);
/** The caller's abort as an error: its reason when that is a PlatformError (as the model transport does), else `aborted`. */
const abortedBy = (signal: AbortSignal): PlatformError =>
  (signal.reason instanceof PlatformError ? signal.reason : new PlatformError("aborted", "the embeddings call was cancelled"));
/** A pause that the caller's signal ends at once. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortedBy(signal)); return; }
    const done = () => { signal?.removeEventListener("abort", stop); resolve(); };
    const timer = setTimeout(done, ms);
    const stop = () => { clearTimeout(timer); reject(abortedBy(signal!)); };
    signal?.addEventListener("abort", stop, { once: true });
  });
}

interface CallState { tokens: number; estimated: boolean; truncated: number; cut: number[] }
interface RequestOpts { kind: EmbedKind; stage: "indexed" | "embed_backfill" | "search_query"; dataClass: DataClass; timeoutMs: number; waits: number; signal?: AbortSignal; beforeRequest?: () => Promise<void>; beforeDispatch?: BeforeModelDispatch }

class FacadeEmbedder implements Embedder {
  private readonly send: GuardedSend;
  readonly source: string;
  constructor(platform: Platform, private readonly settings: ConnectionSettings, readonly embedderId: string, readonly profile: EmbedderProfile,
              private readonly connection: ModelConnection, generation: number) {
    this.send = guardedSend(platform, connection);
    this.source = vectorSource(connection, profile.space, generation);
  }
  get dims(): number { return this.profile.space.dims; }

  allows(dataClass: DataClass): boolean {
    return dataPolicyAllows(dataPolicy(this.settings, this.connection), classOf(dataClass));
  }

  async embedDocuments(texts: readonly string[], o: Parameters<Embedder["embedDocuments"]>[1]): Promise<EmbedOutcome> {
    if (!DOCUMENT_STAGES.has(o?.stage as string)) throw new PlatformError("not_configured", "documents are embedded only for the stages indexed and embed_backfill");
    // the type requires the dispatch fence; a caller that slips past the type (an `as never`, plain
    // JavaScript) is refused here too — before any request, so record text never leaves unfenced
    if (typeof o?.beforeDispatch !== "function") throw new PlatformError("not_configured", "documents are embedded only behind the source fence at dispatch (beforeDispatch)");
    const st: CallState = { tokens: 0, estimated: false, truncated: 0, cut: [] };
    if (!texts.length) return this.ok([], st);
    const r: RequestOpts = { kind: "document", stage: o.stage, dataClass: classOf(o.dataClass), timeoutMs: this.profile.ops.timeout_ms, waits: DOCUMENT_429_WAITS,
                             signal: o.signal, beforeRequest: o.beforeRequest, beforeDispatch: o.beforeDispatch };
    const batch = Math.max(1, Math.floor(this.profile.ops.batch_size) || 1), out: number[][] = [];
    try {
      for (let i = 0; i < texts.length; i += batch) {
        const part = texts.slice(i, i + batch);
        try { const got = await this.request(part, r, st); out.push(...got); o.onVectors?.(got.length); }
        catch (e) {
          if (!rejected(e)) throw e;
          log.warn("embed_batch_rejected", { ref: o.ref, status: (e as PlatformError).status, inputs: part.length });
          for (const text of part) { out.push(await this.single(text, r, st, o.ref, out.length)); o.onVectors?.(1); }
        }
      }
    } catch (e) {
      const stop = stopOf(e);
      if (stop) return { ok: false, stop };
      throw e;
    }
    return this.ok(out, st);
  }

  async embedQuery(text: string, o: Parameters<Embedder["embedQuery"]>[1]): Promise<EmbedOutcome> {
    const st: CallState = { tokens: 0, estimated: false, truncated: 0, cut: [] };
    try {
      return this.ok(await this.request([text], { kind: "query", stage: QUERY_STAGE, dataClass: classOf(o?.dataClass), timeoutMs: o.timeoutMs, waits: 0, signal: o.signal }, st), st);
    } catch (e) {
      const stop = stopOf(e);
      if (stop) return { ok: false, stop };
      throw e;
    }
  }

  private ok(vectors: number[][], st: CallState): EmbedOutcome {
    return { ok: true, embedderId: this.embedderId, vectors, tokens: st.tokens, tokensEstimated: st.estimated, truncated: st.truncated, ...(st.cut.length ? { cut: st.cut } : {}) };
  }

  /** One input alone; a rejection cuts it in half by the token estimate (code points / 4), up to three times. */
  private async single(input: string, r: RequestOpts, st: CallState, ref: string | undefined, at: number): Promise<number[]> {
    let text = input;
    for (let cut = 0; ; cut++) {
      try {
        const [v] = await this.request([text], r, st);
        // counted only when a cut shortened the text (a text under 64 code points is sent whole again: today's sequence)
        if (text.length < input.length) { st.truncated++; st.cut.push(at); }
        return v!;
      } catch (e) {
        if (!rejected(e) || cut >= INPUT_CUTS) throw e;
        const keep = Math.max(16, Math.floor(estimateTokens(text) / 2)) * 4;
        text = [...text].slice(0, keep).join("");
        log.warn("embed_input_truncated", { ref, cut: cut + 1, tokens: estimateTokens(text) });
      }
    }
  }

  /** One request of ≤ batch_size inputs, with the in-call waits on 429; the checked vectors of the space. */
  private async request(texts: readonly string[], r: RequestOpts, st: CallState): Promise<number[][]> {
    const req = embeddingRequest(this.profile, texts, r.kind);
    const space = this.profile.space, provider = this.profile.ops.provider;
    for (let attempt = 0; ; attempt++) {
      await r.beforeRequest?.();
      const reply = await this.send(req, { dataClass: r.dataClass, stage: r.stage, timeoutMs: r.timeoutMs, signal: r.signal, beforeDispatch: r.beforeDispatch });
      if (isEmbeddingQuotaExhausted(reply.status, reply.json))
        throw withReplyDetail(new PlatformError("quota", EMBEDDING_QUOTA_MESSAGE, reply.status), reply);
      if (reply.status === 429) {
        const wait = Number(this.settings.get("retrieval.retry_429_sec", 2)) * 1000 * (attempt + 1);
        // a provider that asks for a longer pause than ours is not hammered: the call ends and the stage's own retry waits
        if (attempt < r.waits && Number.isFinite(wait) && !(reply.retryAfterMs !== undefined && reply.retryAfterMs > wait)) { await pause(wait, r.signal); continue; }
        throw withReplyDetail(new PlatformError("busy", "the embeddings model is busy (429)", 429), reply);
      }
      if (reply.status >= 400) throw withReplyDetail(new PlatformError("http", `the embeddings model answered HTTP ${reply.status}`, reply.status), reply);
      let vectors: number[][];
      try { vectors = spaceVectors(space, embeddingVectors(provider, reply.json, texts.length, rawVectorLength(space), { ordered: true })); }
      catch (e) {
        if (e instanceof EmbeddingShapeError) throw new PlatformError("bad_response", `the embeddings answer is not usable: ${e.message} (HTTP ${reply.status})`, reply.status);
        throw e;
      }
      const tokens = embeddingUsage(provider, reply.json);
      if (tokens === undefined) { st.tokens += texts.reduce((n, s) => n + estimateTokens(s), 0); st.estimated = true; }
      else st.tokens += tokens;
      return vectors;
    }
  }
}

/** Why a connection state is not usable, by key names only (never a value). */
function offDetail(st: { reason: "disabled" | "not_configured"; missing: string[]; invalid: string[] }, id: string): string {
  if (st.reason === "disabled") return `the embeddings connection of ${id} is switched off (provider none)`;
  const parts = [...(st.missing.length ? [`set ${st.missing.join(", ")}`] : []), ...(st.invalid.length ? [`refused ${st.invalid.join(", ")}`] : [])];
  return `the embeddings connection of ${id} is not usable${parts.length ? `: ${parts.join("; ")}` : ""}`;
}

/**
 * The embedder of one registry row, or why there is none. Sync, no I/O. A legacy row (profile NULL) is served by the
 * gateway connection only, with the legacy profile (today's wire); a profile row by its slot, and `mismatch` when the
 * slot now names another space than the row. Never cached: one per stage job, per backfill batch, per search request.
 */
export function embedderFor(deps: { platform: Platform; settings: ConnectionSettings }, row: EmbedderRow): EmbedderState {
  const profile = rowProfile(row, deps.settings);
  const st = rowConnection(deps.settings, row);
  if (st.state === "mismatch") return { state: "off", reason: "mismatch", detail: st.detail };
  if (st.state === "off") return { state: "off", reason: st.reason, detail: offDetail(st, row.id) };
  if (st.connection.role !== "embeddings" || st.connection.model !== profile.space.model)
    return { state: "off", reason: "mismatch", detail: `the embeddings connection names another model than ${row.id}` };
  return { state: "ready", embedder: new FacadeEmbedder(deps.platform, deps.settings, row.id, profile, frozen(st.connection), row.vector_generation) };
}

/**
 * The dimension probe of a connection (registration of embedders, "test connection"): only PROBE_TEXT, class open,
 * stage PROBE_STAGE (never stopped by the budget, always counted), through the same guarded send.
 */
export function probeConnection(deps: { platform: Platform }, connection: ModelConnection, o: { profile?: EmbedderProfile | EmbedderDraft; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ProbeResult> {
  const c = frozen(connection);
  return probeEmbeddings(c, { send: guardedSend(deps.platform, c), profile: o.profile, timeoutMs: o.timeoutMs, signal: o.signal });
}

/**
 * What a thrown error of the facade means for its caller: `provider` — busy, a time limit, a server fault or no answer
 * (408, 5xx, no status); `input` — the input was rejected (400/413/422 after the single inputs and the cuts); `config` —
 * the setup (not configured, a refused destination, the provider's quota, 401/403/404 and other 4xx, a broken answer);
 * `aborted` — the caller's signal; `other` — anything else (a lost stage claim, a code fault).
 */
export function embedFailure(e: unknown): "provider" | "input" | "config" | "aborted" | "other" {
  if (!(e instanceof PlatformError)) return "other";
  switch (e.kind) {
    case "busy": case "timeout": return "provider";
    case "aborted": return "aborted";
    case "not_configured": case "destination_denied": case "quota": case "bad_response": return "config";
    case "http":
      if (e.status === undefined || e.status >= 500 || e.status === 408 || e.status === 429) return "provider";
      if (REJECTED_STATUSES.has(e.status)) return "input";
      return "config";
    default: return "other";
  }
}
