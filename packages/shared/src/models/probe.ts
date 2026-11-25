// Admin probes share the production adapters, destination checks and model slot. Only synthetic input
// leaves the process. No upstream text, diagnostic message, credential or connection object is returned or logged.
import { Ajv2020 } from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { estimateTokens } from "../ids.ts";
import type { LlmSlot } from "../llm-gate.ts";
import { PlatformError, type PlatformErrorKind } from "../platform-error.ts";
import { hostLocality, parseBaseUrl, type AddressLocality, type ModelLookup } from "./address.ts";
import { connectionChatCapabilities, connectionChatPreset, connectionRerankCapabilities } from "./capabilities.ts";
import { chatAdapter } from "./chat/index.ts";
import { probeEmbeddings, PROBE_TEXT } from "./embeddings/probe.ts";
import { draftProfile, type EmbedderDraft } from "./embeddings/presets.ts";
import type { EmbedderProfile } from "./embeddings/profile.ts";
import { dataPolicy, suggestPolicy, type DataPolicy } from "./policy.ts";
import { rerankAdapter } from "./rerank/index.ts";
import { compile } from "./schema-dialect.ts";
import { pinnedModelFetch, type ModelFetch } from "./pinned-fetch.ts";
import { CHAT_PRESETS, RERANK_PRESETS } from "./presets.ts";
import { ModelTransport, ENGLISH_MODEL_TEXTS } from "./transport.ts";
import type { ConnectionSettings, ModelConnection, ModelIo, ModelReply, ModelUsageReport } from "./types.ts";

export const MODEL_PROBE_TIMEOUT_MS = 15_000;
export const MODEL_PROBE_SLOT_WAIT_MS = 5000;
const SCHEMA = { type: "object", additionalProperties: false, required: ["ok", "count"],
  properties: { ok: { type: "boolean" }, count: { type: "integer" } } };
const count = (v: unknown): number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
const PARAMS = new Set(["temperature", "top_p", "top_k", "seed", "random_seed", "max_tokens", "max_completion_tokens",
  "response_format", "reasoning_effort", "thinking", "output_config", "generationConfig"]);
export interface ModelProbeCheck {
  id: string; ok: boolean | null; code: string;
  structured_ok?: boolean; served_model?: string | null; served_model_matches?: boolean;
  latency_ms?: number; input_tokens?: number; output_tokens?: number;
  dims?: number | null; normalized?: boolean | null; order_ok?: boolean;
}
export interface ModelProbeResult {
  ok: boolean; checks: ModelProbeCheck[]; locality: AddressLocality | null;
  data_policy: DataPolicy; suggested_policy: "open" | "closed";
  /** Operator measurements only; absent from ordinary connection probes. Never includes upstream text. */
  provider?: ProviderProbeFacts;
}
export interface ProviderProbeFacts {
  code: string; status?: number; retryAfterMs?: number; valid?: boolean; finish?: "stop" | "length" | "refusal";
  order?: number[]; minScore?: number; maxScore?: number;
}
export interface ProviderProbeCase {
  id: string; schemaName?: string; schema?: Record<string, unknown>; source?: string; maxTokens?: number;
  raw?: boolean; apiVersion?: string; query?: string; documents?: string[];
}
export type ModelProbeSlotRunner = <T>(fn: (slot: LlmSlot) => Promise<T>, waitMaxMs: number) => Promise<T>;
export interface ModelProbeOptions {
  settings: ConnectionSettings; lookup?: ModelLookup; runChat: ModelProbeSlotRunner;
  report?: (report: ModelUsageReport) => void; profile?: EmbedderProfile | EmbedderDraft; signal?: AbortSignal;
  /** Audit observation only; no permission is stored or returned to ordinary calls. */
  onPolicyBypass?: () => void;
  /** Tests only: replaces the network. By default every request connects to the addresses the address check accepted. */
  network?: ModelFetch;
  /** Operator-only matrix: an ID from providerProbePlan, never caller-supplied text or a schema. Each exchange
   * reserves its UTF-8 input allowance (including framing) and output cap before I/O. Throw to refuse spending. */
  providerCase?: { id: string; reserve: (inputTokens: number, outputTokens: number) => void;
    /** The operator opts into the provider's own deadline; ordinary admin probes always keep 15 seconds. */
    timeout?: "provider";
    /** Opaque token shared by one provider's matrix cases. Only successful TEI batch metadata is retained. */
    context?: object };
}

// Match the transport's /info cache lifetime and key, without carrying a previous probe's aborted signal,
// checked DNS answer or report sink into the next case. Contexts are private to an operator run, never permissions.
const PROVIDER_METADATA_TTL_MS = 60_000;
const providerMetadata = new WeakMap<object, Map<string, { at: number; batchSize: number }>>();

const TRANSCRIPT = "A synthetic planning meeting. The reviewer agreed to publish a draft on Friday. No personal or customer data is present.";
const DOCUMENT = "Synthetic document. The draft describes a sample process: prepare, review, publish. This document contains no personal data.";
const SCHEMAS = ["summary-v2", "events-v4", "describe-v2"];
const FACT_SCHEMA = { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "string", minLength: 3, pattern: "^[a-z]+$" } } };

/** Fresh copies for offline planning. Execution rebuilds the chosen case here, so mutating a plan cannot change input. */
export function providerProbePlan(role: "chat" | "rerank", preset: string): ProviderProbeCase[] {
  if (!Object.hasOwn(role === "chat" ? CHAT_PRESETS : RERANK_PRESETS, preset)) throw new Error("invalid provider probe preset");
  if (role === "rerank") return Array.from({ length: 10 }, (_, i) => ({ id: `L3/order/${i + 1}`,
    query: `sample process ${i + 1}`, documents: [`The sample process ${i + 1} prepares and reviews a draft.`, `An unrelated synthetic topic ${i + 1}.`] }));
  const cases: ProviderProbeCase[] = SCHEMAS.flatMap(schemaName => {
    const schema = JSON.parse(readFileSync(new URL(`../../../../contracts/pipeline/schemas/${schemaName}.json`, import.meta.url), "utf8")) as Record<string, unknown>;
    return [TRANSCRIPT, DOCUMENT].map((source, i) => ({ id: `L1/schema/${schemaName}/${i === 0 ? "transcript" : "document"}`, schemaName, schema, source, maxTokens: 1024 }));
  });
  cases.push({ id: "L1/limit-64", schemaName: "probe-fact", schema: structuredClone(FACT_SCHEMA), source: TRANSCRIPT, maxTokens: 64 });
  if (preset === "openai") cases.push({ id: "L2/openai-minLength", schemaName: "probe-fact", schema: structuredClone(FACT_SCHEMA), source: DOCUMENT, raw: true, maxTokens: 64 });
  if (preset === "anthropic") for (const apiVersion of ["2026-10-21", "2023-06-01"]) cases.push({
    // the recording fingerprint excludes headers. The fixed marker gives the versions distinct recording keys.
    id: `L2/anthropic-metadata/${apiVersion}`, apiVersion, schemaName: "probe-fact",
    source: `${DOCUMENT}\nSynthetic API-version marker: ${apiVersion}.`, raw: true, maxTokens: 64,
    schema: { ...structuredClone(FACT_SCHEMA), properties: { value: { type: "string" } }, $id: "https://example.test/probe", $schema: "https://json-schema.org/draft/2020-12/schema" },
  });
  if (["gemini", "gemini-openai", "mistral", "openrouter"].includes(preset)) cases.push({ id: `L2/${preset}-schema`,
    schemaName: "probe-fact", schema: structuredClone(FACT_SCHEMA), source: DOCUMENT, raw: true, maxTokens: 64 });
  return cases;
}

function providerFailure(e: unknown): ProviderProbeFacts {
  const facts: ProviderProbeFacts = { code: e instanceof ProbeFailure ? e.code : e instanceof PlatformError ? e.kind : "probe_error" };
  if (e instanceof PlatformError) {
    if (typeof e.status === "number" && Number.isFinite(e.status)) facts.status = e.status;
    if (typeof e.retryAfterMs === "number" && Number.isFinite(e.retryAfterMs)) facts.retryAfterMs = e.retryAfterMs;
  }
  return facts;
}

/** Uses only a case reconstructed from this module's catalog, through the probe's guarded, pinned I/O. */
async function runProviderCase(c: ModelConnection, test: ProviderProbeCase, base: ModelIo,
  o: ModelProbeOptions, signal: AbortSignal, check: () => void, timeoutMs: number): Promise<ProviderProbeFacts> {
  const facts: ProviderProbeFacts = { code: "ok" };
  const caps = c.role === "chat" ? connectionChatCapabilities(c) : null;
  const outputLimit = caps ? Math.min(caps.max_output_tokens, (test.maxTokens ?? 1024) + (test.id === "L1/limit-64" ? 0 : caps.output_headroom)) : 0;
  const reserve = (body: unknown) => { check(); o.providerCase!.reserve(Buffer.byteLength(JSON.stringify(body) ?? "", "utf8") + 1024, outputLimit); };
  const io: ModelIo = { ...base,
    post: (path, body, options) => {
      reserve(body);
      return bounded(base.post(path, body, { ...options, signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal,
        timeoutMs: Math.min(options.timeoutMs, timeoutMs) }), signal);
    },
    get: async (path, options) => {
      reserve(null);
      const context = o.providerCase?.context;
      let metadata = context ? providerMetadata.get(context) : undefined;
      const key = `${c.baseUrl}\0${c.apiKey ?? ""}`;
      const cached = path === "/info" ? metadata?.get(key) : undefined;
      if (cached && performance.now() - cached.at < PROVIDER_METADATA_TTL_MS)
        return { status: 200, json: { max_client_batch_size: cached.batchSize } };
      const reply = await bounded(base.get(path, { ...options, signal, timeoutMs: Math.min(options.timeoutMs, timeoutMs) }), signal);
      const size = reply.json?.max_client_batch_size;
      if (context && path === "/info" && reply.status === 200 && Number.isSafeInteger(size) && size > 0) {
        if (!metadata) { metadata = new Map(); providerMetadata.set(context, metadata); }
        if (metadata.size >= 256) metadata.clear();
        metadata.set(key, { at: performance.now(), batchSize: size });
      }
      return reply;
    },
  };
  if (c.role === "chat") {
    const compiled = compile(test.schema!, caps!.schema_dialect);
    const adapter = chatAdapter(c.provider);
    if (!adapter) throw new ProbeFailure("not_available");
    await acquire(o.runChat, async slot => {
      check();
      if (!slot.held) throw new ProbeFailure("skipped");
      const req = { model: c.model, capabilities: caps!, schemaName: test.schemaName!, wireSchema: test.raw ? test.schema! : compiled.wire,
        maxTokens: outputLimit, messages: [{ role: "user" as const, content: `Return JSON matching the schema. Use only this synthetic input.\n<source>${test.source}</source>` }],
        sampling: {}, timeoutMs: MODEL_PROBE_TIMEOUT_MS, signal: AbortSignal.any([signal, slot.signal]) };
      adapter.preflight?.(c, req);
      await slot.beforeCall({ maxTokens: req.maxTokens });
      try {
        check();
        const reply = await adapter.chat(io, req);
        facts.finish = reply.finish;
        let answer: unknown;
        try { answer = compiled.restore(JSON.parse(reply.text)); } catch { facts.code = "invalid_json"; }
        if (facts.code === "ok") {
          const { $id: _id, ...anonymous } = test.schema!;
          facts.valid = !!new Ajv2020({ strict: false }).compile(anonymous)(answer);
          if (!facts.valid) facts.code = "schema_error";
        }
        if (reply.finish !== "stop") facts.code = reply.finish;
      } finally { await slot.afterCall("error").catch(() => undefined); }
    });
  } else {
    const adapter = rerankAdapter(c.provider);
    if (!adapter) throw new ProbeFailure("not_available");
    const scores = await adapter.rerank(io, { model: c.model, query: test.query!, documents: test.documents!, timeoutMs: 5000 });
    facts.order = [...scores].sort((a, b) => b.score - a.score || a.index - b.index).map(r => r.index);
    facts.minScore = Math.min(...scores.map(r => r.score)); facts.maxScore = Math.max(...scores.map(r => r.score));
  }
  return facts;
}
function failureKind(code: string, status?: number): PlatformErrorKind {
  if (code === "timeout") return "timeout";
  if (code === "skipped") return "gate";
  if (code === "quota") return "quota";
  if (code === "policy_denied") return "policy_denied";
  if (code === "destination_denied" || code === "redirect") return "destination_denied";
  if (code === "auth_failed" || code === "model_not_found") return "not_configured";
  if (code === "rate_limited") return "busy";
  if (status !== undefined) return "http";
  if (code === "schema_rejected") return "schema_error";
  if (code.startsWith("parameter_rejected")) return "not_configured";
  return "bad_response";
}
class ProbeFailure extends PlatformError {
  constructor(readonly code: string, reply?: Pick<ModelReply, "status" | "retryAfterMs">) {
    super(failureKind(code, reply?.status), "model probe failed", reply?.status);
    if (reply?.retryAfterMs !== undefined) this.retryAfterMs = reply.retryAfterMs;
  }
}
export function failedModelProbe(code: string): ModelProbeResult {
  return { ok: false, checks: [{ id: "connection", ok: false, code }], locality: null,
    data_policy: { open: false, closed: false, reason: "not_listed" }, suggested_policy: "open" };
}
/** Machine codes only. Exception messages and provider details are deliberately excluded from this boundary. */
export function probeErrorCode(e: unknown): string {
  if (e instanceof ProbeFailure) return e.code;
  if (!(e instanceof PlatformError)) return "not_a_model_api";
  if (e.networkCode === "ECONNREFUSED") return "connection_refused";
  if (e.networkCode === "ENOTFOUND" || e.networkCode === "EAI_AGAIN") return "dns_error";
  if (e.networkCode === "ETIMEDOUT") return "timeout";
  if (e.networkCode) return "tls_error";
  if (e.kind === "destination_denied") return e.message.includes("redirect answer") ? "redirect" : "destination_denied";
  if (e.kind === "policy_denied") return "policy_denied";
  if (e.kind === "timeout" || e.kind === "aborted") return "timeout";
  if (e.kind === "quota") return "quota";
  if (e.kind === "gate" || e.kind === "gate_lost") return "skipped";
  if (e.status === 401 || e.status === 403) return "auth_failed";
  if (e.status === 404 || e.modelMissing) return "model_not_found";
  if (e.status === 429) return "rate_limited";
  if (e.kind === "schema_error") return "schema_rejected";
  if (e.kind === "not_configured") return "parameter_rejected";
  return "not_a_model_api";
}
function replyCode(r: ModelReply): string | null {
  const error = r.json?.error;
  const code = error?.code ?? error?.type ?? r.json?.error_type;
  if (r.status === 402 || code === "insufficient_quota" || code === "billing_error" || code === "RESOURCE_EXHAUSTED") return "quota";
  if (r.status === 401 || r.status === 403 || code === "API_KEY_INVALID") return "auth_failed";
  if (r.status === 404 || code === "model_not_found" || code === "NOT_FOUND") return "model_not_found";
  if (r.status === 429) return "rate_limited";
  if (r.status >= 400 || error) {
    if (typeof code === "string" && /schema|structured_output/i.test(code)) return "schema_rejected";
    const param = error?.param;
    if (typeof param === "string" && PARAMS.has(param)) return `parameter_rejected:${param}`;
    return r.status === 400 ? "parameter_rejected" : "not_a_model_api";
  }
  return null;
}
function bounded<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new ProbeFailure("timeout"));
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

async function acquire<T>(run: ModelProbeSlotRunner, fn: (slot: LlmSlot) => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => { expired = true; reject(new ProbeFailure("skipped")); }, MODEL_PROBE_SLOT_WAIT_MS);
  });
  const work = run((slot) => {
    if (expired) throw new ProbeFailure("skipped");
    if (timer) clearTimeout(timer);
    return fn(slot);
  }, MODEL_PROBE_SLOT_WAIT_MS);
  try { return await Promise.race([work, timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

export async function probeModel(c: ModelConnection, o: ModelProbeOptions): Promise<ModelProbeResult> {
  const timeoutMs = o.providerCase?.timeout === "provider" && c.role === "rerank"
    ? connectionRerankCapabilities(c).timeout_ms : MODEL_PROBE_TIMEOUT_MS;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const signal = o.signal ? AbortSignal.any([ctl.signal, o.signal]) : ctl.signal;
  const started = Date.now();
  const result = failedModelProbe("not_available"); result.checks = [];
  let phase = "connection";
  const check = () => {
    if (signal.aborted) throw new ProbeFailure("timeout");
    // The embeddings profile determines the model and protocol on the wire. It must describe exactly the checked connection.
    if (c.role === "embeddings" && o.profile && (o.profile.space.model !== c.model || o.profile.ops.provider !== c.provider))
      throw new ProbeFailure("parameter_rejected");
    // Spec M /: this synthetic probe alone is outside the data-policy gate. It grants no permission.
    if (!dataPolicy(o.settings, c).open) o.onPolicyBypass?.();
  };
  const execute = async () => {
    let providerCase: ProviderProbeCase | undefined;
    if (o.providerCase) {
      if (c.role === "embeddings" || !c.preset || !Object.hasOwn(c.role === "chat" ? CHAT_PRESETS : RERANK_PRESETS, c.preset))
        throw new ProbeFailure("parameter_rejected");
      providerCase = providerProbePlan(c.role, c.preset).find(test => test.id === o.providerCase!.id);
      if (!providerCase || typeof o.providerCase.reserve !== "function") throw new ProbeFailure("parameter_rejected");
      if (providerCase.apiVersion) c = { ...c, params: { ...c.params, api_version: providerCase.apiVersion } };
    }
    const parsed = parseBaseUrl(c.baseUrl);
    if ("problem" in parsed) throw new ProbeFailure("destination_denied");
    result.data_policy = dataPolicy(o.settings, c);
    check();
    const locality = await bounded(hostLocality(c.endpoint.host, { lookup: o.lookup }), signal);
    if (locality.status === "refused") throw new ProbeFailure("destination_denied");
    if (locality.status === "unresolved") throw new ProbeFailure("dns_error");
    result.locality = locality.locality; result.suggested_policy = suggestPolicy(locality);
    result.checks.push({ id: "address", ok: true, code: "ok" });
    // Lead (condition 1): the name is resolved once, by the check above. The transport's own check
    // classifies that same answer again (it is given no resolver of its own), and every socket connects to those
    // addresses with the name kept for Host and TLS. A later DNS answer is never asked for.
    const checked = locality.addresses.map((a) => ({ address: a.address }));
    const transport = new ModelTransport({ texts: ENGLISH_MODEL_TEXTS, lookup: async () => checked, guard: () => check(),
      send: o.network ?? pinnedModelFetch(c.endpoint.host, locality.addresses) });
    // E supplies the embedding wire/profile; native Gemini authentication is an option of the common transport.
    const wireConnection = c.role === "embeddings" && c.provider === "gemini" && c.params.auth_scheme === undefined
      ? { ...c, params: { ...c.params, auth_scheme: "x-goog-api-key" } } : c;
    const base = transport.io(wireConnection, o.report, { stage: o.providerCase ? "provider_probe" : "model_probe" });
    if (providerCase) {
      phase = c.role;
      result.provider = await runProviderCase(c, providerCase, base, o, signal, check, timeoutMs);
      result.ok = result.provider.code === "ok";
      result.checks.push({ id: phase, ok: result.ok, code: result.provider.code });
      return;
    }
    const io: ModelIo = { ...base,
      get: async (path, opts) => {
        check(); const r = await bounded(base.get(path, { ...opts, signal, timeoutMs: Math.min(opts.timeoutMs, MODEL_PROBE_TIMEOUT_MS) }), signal);
        const code = replyCode(r); if (code) throw new ProbeFailure(code, r); return r;
      },
      post: async (path, body, opts) => {
        check(); const r = await bounded(base.post(path, body, { ...opts, signal: opts.signal ? AbortSignal.any([signal, opts.signal]) : signal,
          timeoutMs: Math.min(opts.timeoutMs, MODEL_PROBE_TIMEOUT_MS) }), signal);
        const code = replyCode(r); if (code) { o.report?.({ ok: false }); throw new ProbeFailure(code, r); } return r;
      },
    };
    if (c.role === "chat" && connectionChatPreset(c).modelList) {
      phase = "models";
      try {
        const path = c.provider === "anthropic" ? "/v1/models" : c.provider === "gemini" ? "/v1beta/models" : "/models";
        const r = await io.get(path, { timeoutMs: 3000 });
        const list = r.json?.data ?? r.json?.models;
        const known = Array.isArray(list);
        const found = known && list.some((m: any) => m?.id === c.model || m?.name === c.model || m?.name === `models/${c.model}`);
        result.checks.push({ id: "models", ok: known ? found : null, code: !known ? "not_a_model_api" : found ? "ok" : "model_not_found" });
      } catch (e) {
        const code = probeErrorCode(e);
        if (["redirect", "destination_denied", "policy_denied"].includes(code) || signal.aborted) throw e;
        result.checks.push({ id: "models", ok: null, code });
      }
    }
    phase = c.role;
    if (c.role === "chat") {
      const adapter = chatAdapter(c.provider);
      if (!adapter) throw new ProbeFailure("not_available");
      const caps = connectionChatCapabilities(c);
      const schema = compile(SCHEMA, caps.schema_dialect, { unsupportedKeywords: connectionChatPreset(c).unsupportedKeywords });
      const validate = new Ajv2020({ strict: false }).compile(SCHEMA);
      await acquire(o.runChat, async (slot) => {
        check();
        if (!slot.held) throw new ProbeFailure("skipped");
        const request = { capabilities: caps, model: c.model, messages: [{ role: "user" as const, content: "Return a JSON object with a boolean ok and an integer count." }],
          maxTokens: Math.min(64 + caps.output_headroom, caps.max_output_tokens), schemaName: "connection_probe", wireSchema: schema.wire,
          sampling: {}, timeoutMs: MODEL_PROBE_TIMEOUT_MS, signal: AbortSignal.any([signal, slot.signal]) };
        adapter.preflight?.(c, request);
        await slot.beforeCall({ maxTokens: request.maxTokens });
        try {
          check();
          const reply = await adapter.chat(io, request);
          let valid = false;
          try { valid = reply.finish === "stop" && !!validate(schema.restore(JSON.parse(reply.text))); } catch { /* no response text escapes */ }
          if (!valid) throw new ProbeFailure("schema_rejected");
          // A hostile endpoint may put a credential in any string field, including its served-model name.
          const matches = reply.servedModel === undefined || reply.servedModel === c.model;
          result.checks.push({ id: "chat", ok: true, code: "ok", structured_ok: true,
            served_model: matches ? c.model : null, served_model_matches: matches, latency_ms: Date.now() - started,
            input_tokens: count(reply.usage.promptTokens), output_tokens: count(reply.usage.completionTokens) });
        } finally {
          // The slot serializes probes with ordinary calls; a candidate's success, error or timeout says nothing
          // about the saved connection. Clear its call marker without changing the shared breaker or dirty hold.
          await slot.afterCall("error").catch(() => undefined);
        }
      });
    } else if (c.role === "rerank") {
      const adapter = rerankAdapter(c.provider);
      if (!adapter) throw new ProbeFailure("not_available");
      const scores = await adapter.rerank(io, { model: c.model, query: "blue sky",
        documents: ["The sky is blue.", "A bicycle has two wheels."], timeoutMs: Math.min(5000, connectionRerankCapabilities(c).timeout_ms) });
      const valid = scores.length === 2 && scores.every((s) => Number.isFinite(s.score) && s.score >= 0 && s.score <= 1)
        && scores[0]?.index === 0 && scores[1]?.index === 1 && scores[0].score > scores[1].score;
      result.checks.push({ id: "rerank", ok: valid, code: valid ? "ok" : "not_a_model_api", order_ok: valid, latency_ms: Date.now() - started });
    } else {
      let failure: unknown;
      let usage: ModelUsageReport | undefined;
      let profile = o.profile;
      if (!profile) {
        const { auth_scheme: _auth, headers: _headers, path: _path, ...params } = c.params;
        const draft = draftProfile({ provider: c.provider, model: c.model, params });
        if (!draft.draft) throw new ProbeFailure("parameter_rejected");
        profile = draft.draft;
      }
      // The ordinary embeddings request builder still owns the wire. A saved prefix must not turn synthetic input into install content.
      const syntheticProfile = structuredClone(profile);
      syntheticProfile.space.document_prefix = "";
      const probe = await probeEmbeddings(c, { profile: syntheticProfile, timeoutMs: MODEL_PROBE_TIMEOUT_MS, signal,
        send: async (req, call) => { try {
            const reply = await io.post(req.path, req.body, { timeoutMs: call.timeoutMs, signal: call.signal });
            const tokens = reply.json?.usage?.prompt_tokens ?? reply.json?.usage?.total_tokens
              ?? reply.json?.meta?.billed_units?.input_tokens ?? reply.json?.usageMetadata?.promptTokenCount;
            const known = typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0;
            usage = { ok: true, inputTokens: known ? tokens : estimateTokens(PROBE_TEXT), ...(!known ? { estimated: true } : {}) };
            return reply;
          } catch (e) { failure = e; throw e; } } });
      if (failure) throw failure;
      if (usage) o.report?.({ ...usage, ok: probe.ok });
      result.checks.push({ id: "embeddings", ok: probe.ok, code: probe.ok ? "ok" : "not_a_model_api",
        dims: probe.dims, normalized: probe.normalized, latency_ms: probe.latency_ms });
    }
    result.ok = result.checks.at(-1)?.ok === true;
  };
  try { await bounded(execute(), signal); }
  catch (e) {
    if (o.providerCase) result.provider = providerFailure(e);
    const code = result.provider?.code ?? probeErrorCode(e);
    result.checks.push({ id: phase, ok: code === "skipped" ? null : false, code });
    result.ok = false;
  } finally { clearTimeout(timer); ctl.abort(); }
  // A timed-out operation may settle later. Return a detached result it cannot mutate after the deadline.
  return { ...result, checks: result.checks.map((c) => ({ ...c })) };
}
