import type { BeforeModelDispatch } from "./models/transport.ts";
export type { BeforeModelDispatch } from "./models/transport.ts";
import { createHash } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { DataClass } from "./db.ts";
import type { Settings } from "./settings.ts";
import { log } from "./log.ts";
import { callKind, minPauseFor, needsTail } from "./llm-state.ts";
import type { LlmSlot } from "./llm-gate.ts";
import { EMBEDDING_QUOTA_MESSAGE, isEmbeddingQuotaExhausted, PlatformError } from "./platform-error.ts";
import { baseUrlHints, type ModelLookup } from "./models/address.ts";
import { addressProblems, configuredModel, legacyGatewayConnection, legacyGatewayModels, resolveConnection } from "./models/connection.ts";
import { dataPolicy, policyDeniedText } from "./models/policy.ts";
import { chatAdapter } from "./models/chat/index.ts";
import { rerankAdapter } from "./models/rerank/index.ts";
import { ENGLISH_MODEL_TEXTS, ModelTransport, withReplyDetail } from "./models/transport.ts";
import type { ChatWireReply, ConnectionState, ModelConnection, ModelRole, ModelTexts, ModelUsageReport } from "./models/types.ts";
import { budgetExhaustedText, isSearchStage, PROBE_STAGE, readBudget, type BudgetPeriod, type BudgetState, type UsageSink } from "./models/usage.ts";
import { estimateTokens } from "./ids.ts";
import { compile, SchemaDialectError } from "./models/schema-dialect.ts";
import { connectionConfigurationProblems, modelConfigurationText, roleConfigurationProblems, type ModelConfigurationProblem } from "./models/readiness.ts";
import { connectionChatCapabilities, connectionChatPreset } from "./models/capabilities.ts";
import { isProbeRequestOf, type ProbeShape } from "./models/embeddings/probe-body.ts";

export { PlatformError, type PlatformErrorKind } from "./platform-error.ts";

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

export interface ModelUse { dataClass: DataClass; stage?: string }
/**
 * A call to a model endpoint that is not in `models.allow_closed`, allowed or refused (the audit event `t1_fallback`). `alias`
 * — the model (the old field name is kept); `endpoint` — the host of the base URL only, never its path or a key; `reason`:
 * `allow_open` — the pair may receive open records and the call is of the open class; `open_only` — the pair may receive open
 * records only and the call is of the closed class (refused); `not_listed` — the pair is in neither list (refused).
 */
export interface ModelGateEvent {
  alias: string; purpose: "chat" | "embed" | "rerank"; dataClass: DataClass; stage?: string; allowed: boolean;
  role: ModelRole; endpoint: string; reason: "allow_open" | "open_only" | "not_listed";
}
const STRICT: ModelUse = { dataClass: "closed" };
export interface ChatJsonResult<T> { data: T; servedModel: string; promptTokens: number; completionTokens: number; repaired: boolean; ms: number;
  /** Contract repairs only; truncation growth is counted separately. Absent on legacy/stub results. */
  repairs?: number; schemaDialect?: string; truncations?: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export { wireSchema } from "./models/schema-dialect.ts";

export function dedupeUnique(data: unknown): unknown {
  if (Array.isArray(data)) {
    const seen = new Set<string>();
    return data.map(dedupeUnique).filter((x) => { const k = JSON.stringify(x); if (seen.has(k)) return false; seen.add(k); return true; });
  }
  if (data && typeof data === "object")
    return Object.fromEntries(Object.entries(data as Record<string, unknown>).map(([k, v]) => [k, dedupeUnique(v)]));
  return data;
}

/**
 * The configured model names that are not in `models.t0_aliases`.
 * @deprecated the name list is no longer read by the data policy (pairs of `models.allow_closed` and
 * `models.allow_open`); no caller is left in the tree, the export stays for other streams until they stop importing it.
 */
export function nonT0Aliases(settings: Settings): string[] {
  const t0 = new Set(settings.get<string[]>("models.t0_aliases", []));
  const used = [settings.str("models.llm_model"), settings.str("retrieval.embeddings_model"), settings.str("retrieval.rerank_model")];
  return [...new Set(used.filter((m): m is string => Boolean(m) && !t0.has(m as string)))];
}

function gatewayError(what: string, status: number, body: unknown): string {
  if (status >= 400) return `${what} error ${status}`;
  return body === null ? `gateway returned a non-JSON response (HTTP ${status})` : `gateway response lacked the expected fields (HTTP ${status})`;
}

// User-visible texts of failed model calls (they reach record_stages.last_error and the panel). The existing wording is
// kept byte for byte.
const ROLE_WORD: Record<ModelRole, string> = { chat: "gateway", embeddings: "semantic search model", rerank: "reranker" };
const BUSY: Record<ModelRole, string> = { chat: "gateway is busy (429)", embeddings: "semantic search model is busy (429)", rerank: "reranker is busy (429)" };
const TEXTS: ModelTexts = {
  aborted: () => "model call was aborted",
  timeout: (ms) => `gateway did not respond within ${ms} ms`,
  unreachable: (detail) => `gateway unavailable: ${detail}`,
  busy: (role) => BUSY[role],
  failed: (role, status, body) => gatewayError(ROLE_WORD[role], status, body),
};
/** The legacy "not configured" text: a legacy install without the gateway address or key. */
const LEGACY_NOT_CONFIGURED = "model gateway is not configured: models.gateway_base_url / gateway_api_key";

/**
 * What a role is connected to, for health, the panel and other streams — names and codes only, never a key or a path.
 * `off`: `disabled` (provider `none`) or `not_configured` (`missing` — keys to set; `invalid` — keys whose value is refused).
 * `hints` — advice for an accepted value (an address on 0.0.0.0).
 */
export interface RoleState {
  state: "ready" | "off";
  reason: "disabled" | "not_configured" | null;
  provider: string | null;
  model: string | null;
  endpointHost: string | null;
  legacy: boolean;
  missing: string[];
  invalid: string[];
  hints: string[];
  problems: ModelConfigurationProblem[];
}

/**
 * Why chat may not be called now: `"off"` — no usable chat connection (switched off, not configured, a refused value, or a
 * provider without an adapter); `"budget"` — the money budget is exhausted; null — chat may be called.
 */
export type ChatBlock = null | "off" | "budget";

/**
 * May chat be called now? The one rule of the worker's `Platform.chatBlock()` and of the gateway's
 * views (`llm-gate-admin.ts`), which knows stub mode from its own environment. Stub mode is always ready (nothing leaves the
 * process, nothing is paid). `budget` — the spent limit of the money budget, if any (`Platform.budgetBlock()`); "off" wins
 * over it. Settings cache only.
 */
export function chatBlockOf(settings: Pick<Settings, "get" | "str">, o: { stub?: boolean; budget?: BudgetPeriod | null } = {}): ChatBlock {
  if (o.stub) return null;
  const st = resolveConnection(settings, "chat");
  if (!(st.state === "ready" && chatAdapter(st.connection.provider))) return "off";
  if (connectionConfigurationProblems(st.connection).length) return "off";
  return o.budget ? "budget" : null;
}

declare const SEND_PROOF: unique symbol;
/**
 * The proof that the guard of an embeddings transport checked one request: an opaque
 * object that only `guard` below makes. It is bound to everything the guard's decision depended on —
 * its transport object, the connection's model, the API path, the digest of the body, the stage, the data class
 * and the money budget's rule for that stage — plus the canonical destination and the key reference, and it
 * is used once. A proof records what was checked; it never carries permission: the data
 * policy is read again at the wire, as the last step before the request is handed to `fetch` (models/transport.ts).
 */
export type SendProof = { readonly [SEND_PROOF]: true };
/** What the money budget does with a request of a stage (`Platform.budgetRule`). */
export type BudgetRule = "probe" | "search" | "unlimited" | "charged";

/**
 * The calls the embeddings facade makes: the transport of one connection, its guard and its usage sink. A send
 * needs the proof its guard gave for exactly that request — by construction, not by a scan of the
 * callers: a send without one, with a used or foreign one, or with one of another path or body is refused before the
 * network (`policy_denied`, a `model_send_refused` warning; nothing was sent, so nothing is reported as usage).
 */
export interface EmbeddingTransport {
  /**
   * `o.proof` — from `guard`. The stage (for the money budget: the probe and, by setting, search are let through after
   * exhaustion) and the data class are read from the proof, never from the caller; `o.stage` and `o.dataClass`
   * are only declarations: one that differs from the proof refuses the send.
   */
  post(path: string, body: unknown, o: { timeoutMs: number; signal?: AbortSignal; stage?: string; dataClass?: DataClass; beforeDispatch?: BeforeModelDispatch; proof: SendProof }): Promise<{ status: number; json: any; retryAfterMs?: number; providerDetail?: string }>;
  /** Report the usage of one exchange of this connection: counted by the process's usage recorder, never throws. */
  report(u: ModelUsageReport): void;
  /**
   * The data policy for one request (the pair of the connection and the class of the call), from the settings of this
   * moment — asked for every request, never once per caller or connection. Refuses a
   * model other than the connection's — in the call and in the request body — a path that is not a plain path of the
   * connection, and a probe (`PROBE_STAGE`, which the budget never stops) whose body carries anything but the probe text
   * and validated settings; then returns the proof for exactly this request, its stage, class and budget rule. A probe
   * needs `probe`, its profile: the request must be exactly `probeRequest(probe)` (one builder, the input
   * compared positionally).
   */
  guard(call: { role: "embeddings"; model: string; use: ModelUse; request: { path: string; body: unknown }; probe?: ProbeShape }): SendProof;
}

/** What a proof was given for: every input of the guard's decision. */
interface ProofBinding { owner: EmbeddingTransport; model: string; path: string; digest: string; stage: string | undefined; dataClass: DataClass; budget: BudgetRule;
                         destination: string; keyRef: string }
/** The proofs not used yet: module-private — not exported, not a property of any object, not reachable from a returned value. */
const PROOFS = new WeakMap<object, ProofBinding>();
const digestOf = (json: string): string => createHash("sha256").update(json).digest("hex");
/** A plain path of the connection: no scheme or host, no "." or ".." segment, no query or fragment, no backslash. */
const PLAIN_PATH = /^\/(?!\/)[A-Za-z0-9_\-.:/%]*$/;
const plainPath = (path: unknown): path is string =>
  typeof path === "string" && PLAIN_PATH.test(path) && !path.split("/").some((seg) => seg === "." || seg === "..");
/** The models a request body names: its `model`, or each Gemini sub-request's. */
function bodyModels(body: unknown): unknown[] {
  const b = body as Record<string, any> | null;
  if (!b || typeof b !== "object") return [];
  return Array.isArray(b.requests) ? b.requests.map((r: any) => r?.model) : [b.model];
}
const sameModel = (m: unknown, model: string): boolean =>
  typeof m === "string" && (m === model || m === `models/${model}` || `models/${m}` === model);

const usageNum = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
/**
 * The usage of one embeddings exchange: `usage.prompt_tokens`, else `usage.total_tokens` (Voyage and others report
 * only that); an answered call without either is estimated from the sizes of the inputs and flagged.
 */
function embedUsage(ok: boolean, json: any, input: readonly string[]): ModelUsageReport {
  const tokens = usageNum(json?.usage?.prompt_tokens) ?? usageNum(json?.usage?.total_tokens);
  if (tokens !== undefined || !ok) return { ok, inputTokens: tokens };
  return { ok, inputTokens: input.reduce((n, s) => n + estimateTokens(s), 0), estimated: true };
}

const PURPOSE: Record<ModelRole, ModelGateEvent["purpose"]> = { chat: "chat", embeddings: "embed", rerank: "rerank" };
/** The caller named in a refusal of the data policy. */
const SUBJECT: Record<ModelRole, string> = { chat: "the chat model", embeddings: "the embeddings model", rerank: "the reranker model" };
/** A positive whole number from params, or null. */
const positiveInt = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
/** The transport of each Platform: module-private, never a property of the instance. */
const TRANSPORTS = new WeakMap<Platform, ModelTransport>();
function transportOf(p: Platform): ModelTransport {
  const t = TRANSPORTS.get(p);
  if (!t) throw new PlatformError("not_configured", "a model call needs a Platform");
  return t;
}

/** A deep-frozen copy of a value (own enumerable properties; arrays and plain objects). */
function deepFrozen<T>(v: T): T {
  if (v !== null && typeof v === "object" && !Object.isFrozen(v)) { for (const x of Object.values(v)) deepFrozen(x); Object.freeze(v); }
  return v;
}
/**
 * The transport's own snapshot of a connection: a deep-frozen structured copy, taken once at construction.
 * The caller's object is never kept: a later change of it moves nothing — the URL, the headers and the model of every
 * request come from this snapshot only.
 */
function connectionSnapshot(c: ModelConnection): ModelConnection {
  if (!c || typeof c !== "object") throw new PlatformError("not_configured", "an embeddings transport needs an embeddings connection");
  let copy: ModelConnection;
  try { copy = structuredClone(c); } catch { throw new PlatformError("not_configured", "the embeddings connection is not a plain value"); }
  return deepFrozen(copy);
}
/** The canonical destination of a request: scheme, host, port and path (no key, no query). Null — not a URL. */
function destinationOf(c: ModelConnection, path: string): string | null {
  try {
    const u = new URL(c.baseUrl + path);
    const port = u.port || (u.protocol === "https:" ? "443" : u.protocol === "http:" ? "80" : "");
    return `${u.protocol}//${u.hostname}:${port}${u.pathname}`;
  } catch { return null; }
}
/**
 * The reference of the key a request carries — never its value: the connection keeps no settings name for its key, so
 * the reference is the role and the canonical origin whose key it is (`keyless` for a server without one).
 */
const keyRefOf = (c: ModelConnection): string => (c.apiKey === null ? "keyless" : `key of the ${c.role} connection at ${c.endpoint.origin}`);

/**
 * The model I/O the embedding adapters use for one embeddings connection: requests through the shared transport
 * (destination rules, redirects refused, the data policy at the wire) and the guard of the facade. Safe for any caller
 * by construction: it copies and deep-freezes the connection it is given and never reads the caller's
 * object again. Today only the facade (embedder.ts) and `Platform.embed` make one; no other package imports it.
 */
export function embeddingTransport(platform: Platform, connection: ModelConnection): EmbeddingTransport {
  const snap = connectionSnapshot(connection);
  if (snap.role !== "embeddings") throw new PlatformError("not_configured", `an embeddings transport needs an embeddings connection, not ${snap.role}`);
  const transport = transportOf(platform);
  const refuse = (why: string): never => {
    log.warn("model_send_refused", { role: "embeddings", host: snap.endpoint.host, why });
    throw new PlatformError("policy_denied", `the embeddings send is refused (${why}): only the embeddings facade sends, with the proof of its check`);
  };
  const et: EmbeddingTransport = {
    post: async (path, body, o) => {
      const proof = o?.proof as unknown;
      const bound = proof !== null && typeof proof === "object" ? PROOFS.get(proof) : undefined;
      if (bound) PROOFS.delete(proof as object);                        // used once, whatever follows
      let json: string | undefined;
      try { json = JSON.stringify(body); } catch { json = undefined; }
      if (!bound) return refuse("no proof, or a used or forged one");
      if (bound.owner !== et) return refuse("a proof of another transport");
      if (bound.path !== path || json === undefined || digestOf(json) !== bound.digest) return refuse("a proof of another request");
      // the checked bytes are what is sent: a copy, so a later change of the caller's object changes nothing
      const checked = JSON.parse(json) as unknown;
      const models = bodyModels(checked);
      if (bound.model !== snap.model || !models.length || !models.every((m) => sameModel(m, bound.model))) return refuse("a proof of another model");
      // the destination and the key reference of the proof are the snapshot's
      if (destinationOf(snap, path) !== bound.destination || keyRefOf(snap) !== bound.keyRef) return refuse("a proof of another destination");
      // the stage and the class come from the proof; a caller's declaration that differs is refused, as is a budget
      // rule that changed since the check (a limit set, search let through or not)
      if ("stage" in o && o.stage !== undefined && o.stage !== bound.stage) return refuse("a proof of another stage");
      if ("dataClass" in o && o.dataClass !== undefined && o.dataClass !== bound.dataClass) return refuse("a proof of another data class");
      if (platform.budgetRule(bound.stage) !== bound.budget) return refuse("the budget rule changed since the check");
      // the proof carries no permission: the transport reads the data policy again at the wire, for this pair, class and
      // stage, after the budget refresh and the host check. A request without an answer (time limit, network) is one
      // failed call of the usage count, as for the facade's own calls
      return transport.io(snap, (u) => platform.reportUsage(snap, u, bound.stage), { stage: bound.stage, dataClass: bound.dataClass, beforeDispatch: o.beforeDispatch })
        .post(path, checked, { timeoutMs: o.timeoutMs, signal: o.signal, stage: bound.stage });
    },
    report: (u) => platform.reportUsage(snap, u),
    guard: (call) => {
      if (call.role !== "embeddings" || call.model !== snap.model)
        throw new PlatformError("not_configured", "the embeddings model of the call is not the model of its connection");
      const req = call.request;
      if (!req || !plainPath(req.path)) throw new PlatformError("not_configured", "the embeddings request path is not a path of its connection");
      const destination = destinationOf(snap, req.path);
      if (destination === null) throw new PlatformError("not_configured", "the embeddings request path is not a path of its connection");
      const models = bodyModels(req.body);
      if (!models.length || !models.every((m) => sameModel(m, snap.model)))
        throw new PlatformError("not_configured", "the embeddings request names another model than its connection");
      let json: string;
      try { json = JSON.stringify(req.body); } catch { throw new PlatformError("not_configured", "the embeddings request body is not JSON"); }
      const stage = call.use?.stage;
      // the probe is never stopped by the budget: only the probe request of a valid profile earns its proof, whoever asks
      // — the ordinary builder's request with only the input replaced, compared positionally
      if (stage === PROBE_STAGE && !isProbeRequestOf(call.probe, { path: req.path, body: JSON.parse(json) }))
        throw new PlatformError("not_configured", "the probe request is not the probe request of a valid profile");
      const dataClass: DataClass = call.use?.dataClass === "open" ? "open" : "closed";
      platform.modelGuard(snap, { ...call.use, dataClass });
      const proof = Object.freeze(Object.create(null)) as SendProof;
      PROOFS.set(proof, { owner: et, model: snap.model, path: req.path, digest: digestOf(json), stage, dataClass, budget: platform.budgetRule(stage),
                          destination, keyRef: keyRefOf(snap) });
      return proof;
    },
  };
  return et;
}

export class Platform {
  /** `opts.lookup` — the resolver of model host names (default: the system resolver); tests inject one. */
  constructor(private readonly settings: Settings, opts: { lookup?: ModelLookup } = {}) {
    // the money budget is asked before every paid request of every role
    // the transport is no property of the instance: no key, spelling or Reflect call reaches it
    // the data policy is read again at the wire, the last step before every request is handed to fetch
    TRANSPORTS.set(this, new ModelTransport({ texts: TEXTS, nonLegacyTexts: ENGLISH_MODEL_TEXTS, lookup: opts.lookup, guard: (c, o) => this.budgetGuard(c, o.stage), wire: (c, use) => this.wirePolicy(c, use) }));
  }

  /** The state of a role's connection (slot b: the second embeddings connection). No key, no path. */
  roleState(role: ModelRole, opts?: { slot?: "b" }): RoleState {
    const st = resolveConnection(this.settings, role, opts);
    const problems = roleConfigurationProblems(this.settings, role, opts);
    if (st.state === "ready" && !problems.length) {
      const c = st.connection;
      return { state: "ready", reason: null, provider: c.provider, model: c.model, endpointHost: c.endpoint.host, legacy: c.legacy, missing: [], invalid: [], problems: [], hints: baseUrlHints(c.baseUrl) };
    }
    return { state: "off", reason: st.state === "off" ? st.reason : "not_configured", provider: null, model: opts?.slot === "b" ? null : configuredModel(this.settings, role), endpointHost: null, legacy: false,
             missing: st.state === "off" ? [...st.missing] : [], invalid: st.state === "off" ? [...st.invalid] : [...new Set(problems.map((p) => p.setting))], problems, hints: [] };
  }

  /**
   * Advice for model addresses that are accepted but should be written otherwise (an address on 0.0.0.0),
   * over the three roles, each text once — for the readiness view (health). No key, no path.
   */
  addressHints(): string[] {
    return [...new Set((["chat", "embeddings", "rerank"] as const).flatMap((role) => this.roleState(role).hints))];
  }

  /** The rerank connection for search: provider, model and the relevance floor (`params.relevance_floor`, 0…1; 0.3 by default); null when off. */
  rerankInfo(): { provider: string; model: string; relevanceFloor: number } | null {
    const st = resolveConnection(this.settings, "rerank");
    if (st.state !== "ready") return null;
    const floor = st.connection.params.relevance_floor;
    return { provider: st.connection.provider, model: st.connection.model,
             relevanceFloor: typeof floor === "number" && Number.isFinite(floor) && floor >= 0 && floor <= 1 ? floor : 0.3 };
  }

  /** The chat connection for prompt budgets: the context window and output headroom from `params` (presets); null when off. */
  chatInfo(): { context_window: number | null; output_headroom: number; provider: string; model: string } | null {
    const st = resolveConnection(this.settings, "chat");
    if (st.state !== "ready") return null;
    const c = st.connection;
    // The catalog supplies native defaults once their adapter task registers its entry.
    let p = c.params;
    try { p = { ...connectionChatCapabilities(c) }; }
    catch { /* Metadata remains readable when malformed stored params make calls unavailable. */ }
    return { context_window: positiveInt(p.context_window), output_headroom: positiveInt(p.output_headroom) ?? 0, provider: c.provider, model: c.model };
  }

  /**
   * The data policy for a call on `connection`: the pair "base URL + model" must be in `models.allow_closed`, or in
   * `models.allow_open` for a call of the open class; otherwise `PlatformError("policy_denied")` before anything is sent.
   * Every call to a pair outside `models.allow_closed`, allowed or refused, is reported to `onModelGate`.
   */
  /**
   * The data policy at the wire: the current lists for exactly this request — the connection's pair,
   * the class and the stage — called by the transport synchronously right before `fetch`. A refusal is audited like any
   * refusal of the guard (the hook, `policy_denied`) and logged as `model_send_refused`; an allowed request is not audited
   * again (the guard already recorded it).
   */
  private wirePolicy(connection: ModelConnection, use: { dataClass: DataClass; stage?: string }): void {
    const p = dataPolicy(this.settings, connection);
    if (p.reason === "allow_closed" || (p.open && use.dataClass === "open")) return;
    const reason: ModelGateEvent["reason"] = p.reason === "allow_open" ? "open_only" : "not_listed";
    try {
      this.onModelGate?.({ alias: connection.model, purpose: PURPOSE[connection.role], dataClass: use.dataClass, stage: use.stage, allowed: false,
                           role: connection.role, endpoint: connection.endpoint.host, reason });
    } catch { /* the audit hook never breaks the call */ }
    log.warn("model_send_refused", { role: connection.role, host: connection.endpoint.host, why: "the data policy at the wire" });
    throw new PlatformError("policy_denied", policyDeniedText(SUBJECT[connection.role], connection, use.dataClass));
  }

  modelGuard(connection: ModelConnection, use: ModelUse): void {
    const p = dataPolicy(this.settings, connection);
    if (p.reason === "allow_closed") return;
    const allowed = p.open && use.dataClass === "open";
    const reason: ModelGateEvent["reason"] = allowed ? "allow_open" : p.reason === "allow_open" ? "open_only" : "not_listed";
    try {
      this.onModelGate?.({ alias: connection.model, purpose: PURPOSE[connection.role], dataClass: use.dataClass, stage: use.stage, allowed,
                           role: connection.role, endpoint: connection.endpoint.host, reason });
    } catch { /* the audit hook never breaks the call */ }
    if (allowed) return;
    throw new PlatformError("policy_denied", policyDeniedText(SUBJECT[connection.role], connection, use.dataClass));
  }

  /**
   * Where a call to a pair outside `models.allow_closed` is reported (audit event `t1_fallback`). Set by the entry point of
   * the process: the shared library has no database of its own. The event carries no content: model, role, host, class,
   * stage and decision only.
   */
  onModelGate?: (e: ModelGateEvent) => void;

  onUsage?: (u: { promptTokens: number; completionTokens: number; use: ModelUse }) => void;

  /**
   * Where the usage of every exchange with a model of any role goes: the process's `UsageRecorder`, set by the entry
   * point (the shared library has no database of its own); null — not counted. Additional to `onUsage`, which keeps its
   * meaning (stage tokens, night and day caps).
   */
  usage: UsageSink | null = null;

  /** Count one exchange of `connection` (stage: of the report, else `stage`). Never breaks the call. */
  reportUsage(connection: ModelConnection, u: ModelUsageReport, stage?: string): void {
    try { this.usage?.record(connection, u.stage === undefined && stage !== undefined ? { ...u, stage } : u); }
    catch { /* counting never breaks the call */ }
  }

  /**
   * The connection of a role, or the reason it is not usable as `not_configured`. A legacy install without the gateway
   * address or key keeps the legacy text; anything else names the keys (never their values) and, for a refused address,
   * its reason code.
   */
  private need(role: ModelRole, st: ConnectionState): ModelConnection {
    // the connection the data policy checked is the object that is sent: callers resolve it once
    if (st.state === "ready") {
      const problems = connectionConfigurationProblems(st.connection);
      if (problems.length) throw new PlatformError("not_configured", `model connection is not usable: ${modelConfigurationText(problems)}`);
      return st.connection;
    }
    if (st.reason === "disabled") throw new PlatformError("not_configured", `the ${role} model is switched off (models.${role}_provider is none)`);
    // the legacy client (empty provider) without the gateway address or key: today's text, whatever else is missing
    const legacySignal = [`models.${role}_provider`, "models.gateway_api_key"];
    const legacyOnly = new Set([...legacySignal, `models.${role}_model`]);
    if (!st.invalid.length && st.missing.some((k) => legacySignal.includes(k)) && st.missing.every((k) => legacyOnly.has(k)))
      throw new PlatformError("not_configured", LEGACY_NOT_CONFIGURED);
    const codes = addressProblems(this.settings, role);
    const refused = st.invalid.map((k) => (codes[k] ? `${k} (${codes[k]})` : k));
    const parts = [...(st.missing.length ? [`set ${st.missing.join(", ")}`] : []), ...(refused.length ? [`refused ${refused.join(", ")}`] : [])];
    throw new PlatformError("not_configured", `model connection "${role}" is not usable: ${parts.join("; ")}`);
  }

  beforeChat?: (a: { schemaName: string; maxTokens: number; slot: LlmSlot }) => Promise<ChatJsonResult<unknown> | null>;

  /**
   * Stub mode (`MEMORY_LLM_STUB=1`, set by the worker's `installLlmHooks`): every chat call is answered by `beforeChat`
   * with a canned answer. Chat counts as ready with no model connection at all; `chatJson` resolves no connection and
   * evaluates no data policy, because nothing leaves the process.
   */
  stubChat = false;

  /**
   * May chat be called now? `null` — yes; `"off"` — the chat connection is not usable (switched off, not
   * configured, a refused value, or a provider without an adapter); `"budget"` — the money budget is spent: no slot should
   * be taken and no stage started for it. From the settings cache and the cached spent amount, no waiting (a stale amount
   * is read again in the background; no limit set — nothing is read). Stub mode is always ready.
   */
  chatBlock(): ChatBlock {
    return chatBlockOf(this.settings, { stub: this.stubChat, budget: this.stubChat ? null : this.budgetBlock() });
  }

  /** The spent limit of the money budget by the cached amount; null — none, no limit set, or no usage recorder. */
  budgetBlock(): BudgetPeriod | null {
    try { return this.usage?.budgetBlock?.() ?? null; } catch { return null; }
  }

  /** The same after reading the spent amount when the cached one is older than 10 s. Never throws: a failed read lets calls go. */
  async budgetFresh(): Promise<BudgetPeriod | null> {
    try { return (await this.usage?.budgetFresh?.()) ?? null; } catch { return null; }
  }

  /** The money budget now (for health and the panel); null — no limit set or no usage recorder. Does not wait for a read. */
  budgetState(): BudgetState | null {
    try { return this.usage?.budgetState?.() ?? null; } catch { return null; }
  }

  /**
   * What the money budget does with a request of this stage now: `probe` and `search` (with `search: "allow"`)
   * are let through, `unlimited` — no limit is set, `charged` — the spent amount is asked before sending. A proof of the
   * embeddings guard is bound to it. Reads the settings only.
   */
  budgetRule(stage: string | undefined): BudgetRule {
    if (stage === PROBE_STAGE) return "probe";
    const b = readBudget(this.settings);
    if (!b) return "unlimited";
    return b.search === "allow" && isSearchStage(stage) ? "search" : "charged";
  }

  /**
   * The money budget before a paid request of any role: a spent limit throws `PlatformError("budget_exhausted")`
   * and nothing is sent. Not stopped: the probe of "test connection" (it is how the administrator checks the setup; it is
   * counted) and, with `search: "allow"`, the calls of search. No limit set — nothing is read.
   */
  private async budgetGuard(c: ModelConnection, stage: string | undefined): Promise<void> {
    if (this.budgetRule(stage) !== "charged") return;
    const b = readBudget(this.settings);
    if (!b) return;
    const period = await this.budgetFresh();
    if (period) throw new PlatformError("budget_exhausted", budgetExhaustedText(period, b));
  }

  async chatJson<T>(args: { messages: ChatMessage[]; schemaName: string; schema: object; maxTokens: number; use?: ModelUse; slot: LlmSlot; beforeDispatch?: BeforeModelDispatch;
    wireEnums?: Readonly<Record<string, readonly string[]>>;
    repairText?: { length?: string; schema?: (problem: string) => string } }): Promise<ChatJsonResult<T>> {
    const slot = args.slot;
    if (!slot?.held) throw new PlatformError("gate", "model call without a slot: a model can be called only while holding a gate slot");
    // stub mode: no connection, no data policy — the hook answers under the slot (nothing leaves the process)
    const stub = this.stubChat;
    // the connection is resolved once per call: a settings change between an attempt and its repair does not move it. Not
    // usable → not_configured before the slot: no beforeCall, no afterCall, the instance breaker is not opened; the
    // worker's dispatcher does not start chat stages while chatBlock() says so, this is for a call that raced in
    const conn = stub ? null : this.need("chat", resolveConnection(this.settings, "chat"));
    const adapter = conn ? chatAdapter(conn.provider) : null;
    if (conn && !adapter) throw new PlatformError("not_configured", `no chat adapter for provider ${conn.provider} yet`);
    const model = conn?.model ?? configuredModel(this.settings, "chat");
    // the sampling profile of the legacy gateway goes to the legacy gateway only, never to another address
    const sampling = conn?.legacy ? this.settings.get<Record<string, unknown>>("models.wire_fragment", {}) : {};
    const caps = conn ? connectionChatCapabilities(conn) : null;
    const legacy = !conn || conn.legacy;
    const timeoutMs = (caps?.timeout_sec ?? this.settings.get("models.timeout_sec", 300)) * 1000;
    const retries = this.settings.get("models.repair_retries", 1);
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const { $id: _id, ...anonymous } = args.schema as Record<string, unknown>;
    const validate = ajv.compile(anonymous);
    let compiled;
    try {
      compiled = compile(args.schema, caps?.schema_dialect ?? "passthrough", {
        unsupportedKeywords: legacy ? this.settings.get<string[]>("models.schema_unsupported_keywords", ["uniqueItems"])
          : conn ? connectionChatPreset(conn).unsupportedKeywords : [],
        wireEnums: args.wireEnums,
      });
    } catch (e) {
      if (e instanceof SchemaDialectError) throw new PlatformError("not_configured", e.message);
      throw e;
    }
    const wire = compiled.wire;
    let messages = args.messages, repaired = false, maxTokens = legacy ? args.maxTokens
      : Math.min(args.maxTokens + (caps?.output_headroom ?? 0), caps?.max_output_tokens ?? 8000);
    let repairs = 0, truncations = 0;
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      // the money budget before every attempt, the repair too, and before the slot is used: a spent limit is no
      // call (outcome `blocked`; no beforeCall, no afterCall). A stage that holds the slot does not go on paying, part after part
      // the data policy before every attempt, the repair too, from the settings of this moment
      // and before the slot is used: a refusal is no call (outcome `blocked`; no beforeCall, no afterCall)
      if (conn) this.modelGuard(conn, args.use ?? STRICT);
      if (conn) await this.budgetGuard(conn, args.use?.stage);
      const request = { model: conn?.model ?? "", messages, maxTokens, schemaName: args.schemaName, wireSchema: wire, sampling, timeoutMs, signal: slot.signal,
        ...(caps ? { capabilities: caps } : {}) };
      if (conn) adapter?.preflight?.(conn, request);
      await slot.beforeCall({ maxTokens });
      let reply: ChatWireReply;
      try {
        const hooked = this.beforeChat ? await this.beforeChat({ schemaName: args.schemaName, maxTokens, slot }) : null;
        if (hooked) { await slot.afterCall("ok"); return hooked as ChatJsonResult<T>; }
        // stub mode without a canned answer: an answered error, never a request
        if (!conn || !adapter) throw new PlatformError("bad_response", `stub mode: no canned answer for schema ${args.schemaName}`);
        reply = await adapter.chat(transportOf(this).io(conn, (u) => this.reportUsage(conn, u, args.use?.stage), { stage: args.use?.stage, dataClass: (args.use ?? STRICT).dataClass, beforeDispatch: args.beforeDispatch }), request);
      } catch (e) {
        // the provider's Retry-After as the breaker's minimum pause; passed only when it can lengthen a pause
        const minPauseMs = minPauseFor(e);
        await slot.afterCall(callKind(e), minPauseMs === undefined ? { tail: needsTail(e) } : { tail: needsTail(e), minPauseMs }).catch(() => undefined);
        throw e;
      }
      try { this.onUsage?.({ promptTokens: reply.usage.promptTokens ?? 0, completionTokens: reply.usage.completionTokens ?? 0, use: args.use ?? STRICT }); }
      catch { }
      const content: string = reply.text;
      const truncated = reply.finish === "length";
      let data: unknown, problem: string | null = null;
      try { data = dedupeUnique(compiled.restore(JSON.parse(content))); } catch { problem = legacy
        ? truncated ? `response was truncated at the limit of ${maxTokens} tokens` : "response is not JSON"
        : truncated ? `the answer was truncated at ${maxTokens} tokens` : "the answer is not JSON"; }
      if (!problem && !validate(data)) problem = legacy ? ajv.errorsText(validate.errors, { separator: "; " })
        : validate.errors!.map((e) => `${e.instancePath || "/"}: ${e.keyword}`).join("; ");
      if (!legacy && truncated) problem = `the answer was truncated at ${maxTokens} tokens`;
      await slot.afterCall(problem ? "answered_error" : "ok").catch(() => undefined);
      if (!problem) {
        const ms = Date.now() - started;
        const stats = legacy ? {} : { repairs, schemaDialect: compiled.dialect, truncations };
        log.info("llm_call", { schema: args.schemaName, served_model: reply.servedModel, prompt_tokens: reply.usage.promptTokens, completion_tokens: reply.usage.completionTokens, repaired, ms, ...stats });
        return { data: data as T, servedModel: String(reply.servedModel ?? model), promptTokens: reply.usage.promptTokens ?? 0, completionTokens: reply.usage.completionTokens ?? 0, repaired, ms, ...stats };
      }
      log.warn("llm_invalid_output", { schema: args.schemaName, attempt, truncated, completion_tokens: reply.usage.completionTokens, max_tokens: maxTokens });
      if (!legacy) {
        if (truncated) {
          const grown = Math.min(Math.max(maxTokens * 4, 4000), caps?.max_output_tokens ?? 8000);
          if (grown <= maxTokens) throw new PlatformError("schema_error", `the model answer failed schema ${args.schemaName}: ${problem}`);
          maxTokens = grown;
          truncations++;
        } else {
          if (repairs >= retries) throw new PlatformError("schema_error", `the model answer failed schema ${args.schemaName}: ${problem}`);
          repairs++;
        }
        repaired = true;
        messages = [...args.messages, { role: "user", content: truncated
          ? args.repairText?.length ?? "The previous answer was truncated. Return the JSON again within the output limit."
          : args.repairText?.schema?.(problem) ?? `The previous answer failed JSON Schema validation: ${problem}. Return only valid JSON matching the schema.` }];
        continue;
      }
      if (attempt >= retries) throw new PlatformError("schema_error", `model response did not match schema ${args.schemaName}: ${problem}`);
      if (truncated) maxTokens = Math.min(Math.max(maxTokens * 4, 4000), 8000);
      repaired = true;
      messages = [...args.messages, { role: "user", content: truncated
        ? args.repairText?.length ?? "The previous response exceeded the limit and was cut off. Return the same JSON using the schema, but shorter: use fewer points and concise wording."
        : args.repairText?.schema?.(problem) ?? `The previous response did not match the schema: ${problem}. Return only valid JSON that matches the schema.` }];
    }
  }

  async embed(texts: string[], opts: { kind: "query" | "document"; queryInstruction?: string | null; dims: number; timeoutMs?: number; retries?: number; use?: ModelUse }): Promise<number[][]> {
    const model = configuredModel(this.settings, "embeddings");
    if (!model) throw new PlatformError("not_configured", "retrieval.embeddings_model is not set");
    // resolved once: the connection the data policy checks is the one every batch is sent to
    const st = resolveConnection(this.settings, "embeddings");
    const use = opts.use ?? STRICT;
    // nothing to send: the policy is still asked once, so a pair that is not allowed is refused for an empty input too
    if (st.state === "ready" && texts.length === 0) this.modelGuard(st.connection, use);
    const batch = this.settings.get("retrieval.batch", 16), pause = this.settings.get("retrieval.retry_429_sec", 2) * 1000;
    const timeoutMs = opts.timeoutMs ?? 120_000, retries = opts.retries ?? 5;
    const input = opts.kind === "query" && opts.queryInstruction ? texts.map((t) => opts.queryInstruction + t) : texts;
    const out: number[][] = [];
    const started = Date.now();
    // the connection is taken at the first request: an empty input needs no address, as before
    let conn: ModelConnection | null = null, et: EmbeddingTransport | null = null;
    for (let i = 0; i < input.length; i += batch) {
      const part = input.slice(i, i + batch);
      for (let attempt = 0; ; attempt++) {
        conn ??= this.embeddingsConnection(st);
        et ??= embeddingTransport(this, conn);
        // the data policy for EVERY send — each batch and each repeat on 429 — at the moment of sending, from the settings
        // of this moment, through the guard of the embeddings transport: each send has its own proof.
        // A permission revoked between two batches refuses the second, whoever holds this method
        const body = { model: conn.model, input: part };
        const proof = et.guard({ role: "embeddings", model: conn.model, use, request: { path: "/embeddings", body } });
        const reply = await et.post("/embeddings", body, { timeoutMs, proof });
        const { status, json } = reply;
        this.reportUsage(conn, embedUsage(status < 400 && Array.isArray(json?.data), json, part), opts.use?.stage);
        if (isEmbeddingQuotaExhausted(status, json))
          throw withReplyDetail(new PlatformError("quota", EMBEDDING_QUOTA_MESSAGE, status), reply);
        if (status === 429 && attempt < retries) {
          await sleep(embeddingRetryDelayMs({ legacy: conn.legacy || conn.preset === "litellm", baseMs: pause, attempt, retryAfterMs: reply.retryAfterMs }));
          continue;
        }
        if (status === 429) throw withReplyDetail(new PlatformError("busy", TEXTS.busy("embeddings"), 429), reply);
        if (status >= 400 || !Array.isArray(json?.data)) throw withReplyDetail(new PlatformError("http", TEXTS.failed("embeddings", status, json), status), reply);
        const vectors = [...json.data].sort((a: any, b: any) => a.index - b.index).map((d: any) => d.embedding as number[]);
        if (vectors.length !== part.length || vectors.some((v) => !Array.isArray(v) || v.length !== opts.dims))
          throw new PlatformError("bad_response", `semantic search model did not return ${part.length} × ${opts.dims}`);
        out.push(...vectors);
        break;
      }
    }
    log.info("embed_call", { kind: opts.kind, inputs: texts.length, ms: Date.now() - started });
    return out;
  }

  /** The embeddings connection; the legacy wire (`openai-compatible`) is the only one this client speaks. */
  private embeddingsConnection(st: ConnectionState): ModelConnection {
    const conn = this.need("embeddings", st);
    if (conn.provider !== "openai-compatible") throw new PlatformError("not_configured", `no embeddings adapter for provider ${conn.provider} in this client`);
    return conn;
  }

  async rerank(query: string, documents: string[], use?: ModelUse, o?: { beforeDispatch?: BeforeModelDispatch }): Promise<Array<{ index: number; score: number }>> {
    const model = configuredModel(this.settings, "rerank");
    if (!model) throw new PlatformError("not_configured", "reranker is not set");
    const st = resolveConnection(this.settings, "rerank");
    if (st.state === "ready") this.modelGuard(st.connection, use ?? STRICT);
    const started = Date.now();
    const conn = this.need("rerank", st);
    const adapter = rerankAdapter(conn.provider);
    if (!adapter) throw new PlatformError("not_configured", `no rerank adapter for provider ${conn.provider} yet`);
    const circuit = this.rerankCircuitOf(conn), probe = circuit.begin(performance.now());
    try {
      const results = await adapter.rerank(transportOf(this).io(conn, (u) => this.reportUsage(conn, u, use?.stage), { stage: use?.stage, dataClass: (use ?? STRICT).dataClass, beforeDispatch: o?.beforeDispatch }), { model: conn.model, query, documents, timeoutMs: 60_000 });
      circuit.end(performance.now(), probe);
      log.info("rerank_call", { documents: documents.length, ms: Date.now() - started });
      return results;
    } catch (e) {
      circuit.end(performance.now(), probe, e);
      throw e;
    }
  }

  async check(): Promise<{ ok: boolean; missing: string[]; error?: string }> {
    try {
      const conn = this.need("chat", legacyGatewayConnection(this.settings));
      const res = await transportOf(this).modelFetch(conn, { method: "GET", path: "/models", signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return { ok: false, missing: [], error: `gateway responded with ${res.status}` };
      const ids = new Set<string>(((await res.json()) as any).data?.map((m: any) => m.id) ?? []);
      // the names of the roles on the legacy gateway, also from the role keys; a role on its own connection is not asked of it
      const want = legacyGatewayModels(this.settings);
      const missing = want.filter((m) => !ids.has(m));
      return { ok: missing.length === 0, missing };
    } catch (e) {
      return { ok: false, missing: [], error: (e as Error).message };
    }
  }

  private rerankMonitor: { key: string; circuit: RerankCircuit } | null = null;
  private rerankCircuitOf(conn: ModelConnection): RerankCircuit {
    const key = createHash("sha256").update(JSON.stringify([conn.provider, conn.baseUrl, conn.model, conn.apiKey, conn.params])).digest("hex");
    if (this.rerankMonitor?.key !== key) this.rerankMonitor = { key, circuit: new RerankCircuit() };
    return this.rerankMonitor.circuit;
  }
  /** Local operational history, without provider text or request content; readiness never sends a probe for this. */
  rerankHealth(): RerankHealth {
    const st = resolveConnection(this.settings, "rerank");
    return st.state === "ready" ? this.rerankCircuitOf(st.connection).health(performance.now())
      : { ok: true, detail: "reranker is off" };
  }
}

/** Shared background retry policy; can use it without adding a transport or weakening its facade guard. */
export function embeddingRetryDelayMs(o: { legacy: boolean; baseMs: number; attempt: number; retryAfterMs?: number }, random = Math.random): number {
  const base = Number.isFinite(o.baseMs) && o.baseMs >= 0 ? o.baseMs : 2000;
  const after = Number.isFinite(o.retryAfterMs) ? Math.max(0, o.retryAfterMs!) : 0;
  if (o.legacy) return Math.max(base * (o.attempt + 1), Math.min(600_000, after));
  const jitter = 0.5 + Math.max(0, Math.min(1, random()));
  const backoff = base * 2 ** Math.min(20, Math.max(0, o.attempt)) * jitter;
  return Math.min(600_000, Math.max(backoff, after));
}

// Internal limits pending a settings contract: three failures in five minutes, a one-minute pause.
// State is per connection and process. It does not claim to enforce the installation's daily call budget.
const RERANK_LIMITS = { failures: 3, windowMs: 300_000, cooldownMs: 60_000, warnRatio: 0.5 } as const;
export interface RerankHealth { ok: true; level?: "warn"; detail: string }

class RerankPaused extends PlatformError {
  constructor(ms: number) {
    super("busy", "the reranker is paused after repeated failures");
    this.retryAfterMs = Math.ceil(ms);
  }
}
const sharedTokenLimit = (e: unknown): boolean => e instanceof PlatformError && e.status === 429
  && /\bTPM\b|tokens?\s+per\s+min(?:ute)?|token[_ -](?:rate[_ -])?limit/i.test(e.providerDetail ?? "");

/** Extra search advice uses only known error classes/codes; remote text never enters the note. */
export function rerankFallbackNote(e: unknown): string | null {
  if (e instanceof RerankPaused) return "Reranker paused after repeated failures: order by RRF";
  return sharedTokenLimit(e) ? "Reranker channel token limit reached (429): order by RRF" : null;
}

class RerankCircuit {
  private failures: number[] = [];
  private until = 0;
  private probing = false;
  // Second buckets bound memory at 3601 entries even under sustained load; only counts and durations are kept.
  private hour = new Map<number, { calls: number; failed: number; tpm: number }>();
  private prune(now: number): void {
    this.failures = this.failures.filter((t) => now - t <= RERANK_LIMITS.windowMs);
    for (const second of this.hour.keys()) if (second * 1000 < now - 3_600_000) this.hour.delete(second);
  }
  begin(now: number): boolean {
    this.prune(now);
    if (now < this.until || this.probing) throw new RerankPaused(Math.max(1, this.until - now));
    const probe = this.until > 0;
    if (probe) this.probing = true;
    return probe;
  }
  end(now: number, probe: boolean, error?: unknown): void {
    this.prune(now);
    if (probe) this.probing = false;
    // A refusal before dispatch is not a failed upstream exchange.
    if (error instanceof PlatformError && (
      ["policy_denied", "budget_exhausted", "not_configured", "destination_denied"].includes(error.kind)
      || (error.kind === "aborted" && error.fake === true)
    )) return;
    const second = Math.floor(now / 1000), n = this.hour.get(second) ?? { calls: 0, failed: 0, tpm: 0 };
    n.calls++; n.failed += error === undefined ? 0 : 1; n.tpm += sharedTokenLimit(error) ? 1 : 0;
    this.hour.set(second, n);
    if (error === undefined) {
      // A late answer to a call started before the hold must not close it. Only the single recovery probe may do so.
      if (probe) { this.until = 0; this.failures = []; }
    } else if (error instanceof PlatformError && (error.kind === "busy" || error.kind === "http")) {
      this.failures.push(now);
      this.failures = this.failures.slice(-RERANK_LIMITS.failures);
      if (probe || this.failures.length >= RERANK_LIMITS.failures) {
        const retry = Number.isFinite(error.retryAfterMs) ? Math.min(600_000, Math.max(0, error.retryAfterMs!)) : 0;
        this.until = Math.max(this.until, now + Math.max(RERANK_LIMITS.cooldownMs, retry));
      }
    }
  }
  health(now: number): RerankHealth {
    this.prune(now);
    let calls = 0, failed = 0, tpm = 0;
    for (const n of this.hour.values()) { calls += n.calls; failed += n.failed; tpm += n.tpm; }
    const held = now < this.until || this.probing;
    return { ok: true, ...(held || calls > 0 && failed / calls > RERANK_LIMITS.warnRatio ? { level: "warn" as const } : {}),
      detail: `reranker: ${failed}/${calls} calls failed in the last hour; shared token limit: ${tpm}${held ? "; paused, search uses RRF" : ""} (this process)` };
  }
}
