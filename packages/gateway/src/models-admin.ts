// Internal API shapes, not yet in the OpenAPI contract. Persistence stays on the guarded settings API.
import type { Context, Hono } from "hono";
import pg from "pg";
import { LlmGate, resolveConnection, buildConnection, connectionKeys, dataPolicy, CHAT_PRESETS, RERANK_PRESETS,
  connectionChatCapabilities, connectionRerankCapabilities, activeEmbeddingsConnection, connectionConfigurationProblems, EMBEDDING_PROVIDERS, suggestPolicy,
  PlatformError, type ConnectionState, type ModelConnection, type ModelRole } from "@memory/shared";
import * as modelProbe from "../../shared/src/models/probe.ts";
import { failedModelProbe, type ModelProbeSlotRunner, type ModelProbeResult } from "../../shared/src/models/probe.ts";
import { parseBaseUrl, hostLocality, type ModelLookup } from "../../shared/src/models/address.ts";
import type { EmbedderProfile } from "../../shared/src/models/embeddings/profile.ts";
import type { App } from "./context.ts";

type AdminAudit = (c: Context<any>, op: string, details?: Record<string, unknown>) => Promise<void>;
type ProbeInput = { role: ModelRole; provider?: string; base_url?: string; api_key?: string | null; model?: string; params?: Record<string, unknown> };
const ROLES: readonly ModelRole[] = ["chat", "embeddings", "rerank"];
const FIELDS = new Set(["role", "provider", "base_url", "api_key", "model", "params"]);
// Probe overrides select protocol capabilities, never arbitrary text in headers, paths or payload fields.
// Full configuration remains available through the guarded settings API, with the ordinary shared validation.
const PROBE_PARAMS: Record<ModelRole, ReadonlySet<string>> = {
  chat: new Set(["preset", "structured", "schema_dialect", "max_tokens_param", "seed", "sampling", "thinking",
    "output_headroom", "max_output_tokens", "context_window", "auth_scheme", "timeout_sec"]),
  embeddings: new Set(["preset", "dims", "native_dims", "dims_param", "truncate", "normalize", "max_input_tokens",
    "batch_size", "batch_tokens", "tokenizer", "timeout_ms", "store_dims", "batch", "auth_scheme"]),
  rerank: new Set(["preset", "format", "top_param", "score", "max_documents", "usage_unit", "timeout_ms", "relevance_floor", "auth_scheme"]),
};
const PROBE_SAMPLING = new Set(["temperature", "top_p", "top_k", "min_p", "repetition_penalty", "frequency_penalty", "presence_penalty"]);
const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const error = (code: string, message: string, reason?: string) => reason === undefined ? { code, message } : { code, reason, message };

/** Validate without copying request values into errors. Input text and record content are never accepted. */
function probeInput(body: unknown): ProbeInput | null {
  if (!plain(body) || Object.keys(body).some((k) => !FIELDS.has(k)) || !ROLES.includes(body.role as ModelRole)) return null;
  for (const k of ["provider", "base_url", "model"]) {
    if (Object.hasOwn(body, k) && (typeof body[k] !== "string" || !(body[k] as string).trim() || (body[k] as string).length > 2048)) return null;
  }
  if (Object.hasOwn(body, "api_key") && body.api_key !== null && (typeof body.api_key !== "string" || body.api_key.length > 16384)) return null;
  if (Object.hasOwn(body, "params")) {
    if (!plain(body.params) || Object.keys(body.params).some((key) => !PROBE_PARAMS[body.role as ModelRole].has(key))) return null;
    if (Object.hasOwn(body.params, "sampling") && (!plain(body.params.sampling)
      || Object.entries(body.params.sampling).some(([key, value]) => !PROBE_SAMPLING.has(key) || typeof value !== "number" || !Number.isFinite(value)))) return null;
  }
  return body as ProbeInput;
}

/** No worker-role credential is loaded in the gateway: the existing control pool's own role holds the shared slot. */
export function slotRunner(app: App): ModelProbeSlotRunner {
  return async (fn, waitMaxMs) => {
    const gate = new LlmGate({ instanceId: app.instanceId, settings: app.settings,
      connect: (applicationName) => new pg.Client(slotClientConfig(app.db.control, applicationName)),
      requireFloor: process.env.MEMORY_LLM_REQUIRE_FLOOR === "1", stub: false, purpose: "model_probe", bypassBreaker: true });
    const call = modelCall(fn);
    try { return await gate.run({ purpose: "model_probe", stage: "model_probe" }, call.fn, { waitMaxMs }); } catch (e) { throw slotFailure(e, call); }
    finally { await gate.close(); }
  };
}

/** Strict projection: raw params, headers, provider replies and credentials never enter the view. */
function capabilities(c: ModelConnection) {
  try {
    if (c.role === "chat") {
      const p = connectionChatCapabilities(c);
      return { structured: p.structured, schema_dialect: p.schema_dialect, max_tokens_param: p.max_tokens_param,
        output_headroom: p.output_headroom, max_output_tokens: p.max_output_tokens, context_window: p.context_window ?? null,
        auth_scheme: p.auth_scheme };
    }
    if (c.role === "rerank") {
      const p = connectionRerankCapabilities(c);
      return { format: p.format, score: p.score, max_documents: p.max_documents, timeout_ms: p.timeout_ms, usage_unit: p.usage_unit };
    }
    return { provider: c.provider };
  } catch { return null; }
}
async function saved(app: App, role: ModelRole): Promise<{ state: ConnectionState; slot?: "b"; legacy?: boolean; profile?: EmbedderProfile }> {
  if (role !== "embeddings") return { state: resolveConnection(app.settings, role) };
  const active = await activeEmbeddingsConnection(app.db.control, app.settings);
  if (!active) return { state: { state: "off", reason: "not_configured", missing: [], invalid: [] }, legacy: false };
  if (active.connection.state === "mismatch") return { state: { state: "off", reason: "not_configured", missing: [], invalid: ["embeddings_profile"] },
    legacy: !active.row.profile, ...(active.slot === "b" ? { slot: "b" as const } : {}) };
  return { state: active.connection, legacy: active.connection.state === "ready" ? active.connection.connection.legacy : !active.row.profile,
    ...(active.slot === "b" ? { slot: "b" as const } : {}), profile: active.profile };
}
function connectionView(app: App, c: ModelConnection, slot?: "b") {
  const keys = connectionKeys(c.role, slot);
  const masked = app.settings.listMasked();
  const set = (path: string) => masked.some((r) => `${r.category}.${r.key}` === path && r.isSet);
  return { provider: c.provider, base_url: c.baseUrl, api_key: c.apiKey === null ? null : "********", model: c.model,
    preset: c.preset, legacy: c.legacy,
    sources: { provider: c.legacy ? "legacy" : "role", base_url: set(keys.baseUrl) ? "role" : "legacy",
      api_key: c.apiKey === null ? null : set(keys.apiKey) ? "role" : slot === "b" ? "role" : "legacy",
      model: set(keys.model) ? "role" : "legacy", params: c.legacy ? "legacy" : "role" } };
}

/** Audit authority of the requested address: hostname and port only, also when the destination is refused or malformed.
 * Path, query, fragment and the userinfo before the last `@` of the authority are never copied. The host is kept only in
 * a host alphabet (letters, digits, `.`, `-`, `_`, or a bracketed IPv6 literal), otherwise it is `invalid`; an `@` after
 * the authority (userinfo the URL parser would read as host and path) also makes it `invalid`. A port is kept only as
 * digits (leading zeros dropped, at most ten), otherwise `invalid`, so text typed into the port position is never copied. */
function auditHost(baseUrl: string | null): string | null {
  const text = baseUrl ? baseUrl.slice(0, 4096).trim() : "";
  const match = /^[a-z][a-z0-9+.-]{0,31}:\/\/([^/?#\\]*)/i.exec(text);
  if (!match?.[1]) return null;
  const authority = match[1];
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  const parts = /^(\[[^\]]*\]|[^:]*)(?::(.*))?$/s.exec(hostPort);
  if (!parts?.[1] || parts[1].length > 255 || /[\x00-\x20\x7f]/.test(parts[1])) return null;
  let host: string;
  try { host = new URL(`http://${parts[1]}`).hostname; } catch { return null; }
  if (!host) return null;
  if (text.slice(match[0].length).includes("@") || !/^(?:[a-z0-9._-]{1,255}|\[[0-9a-f:.]{2,64}\])$/.test(host)) host = "invalid";
  const raw = parts[2];
  if (raw === undefined || raw === "") return host;
  const digits = /^[0-9]+$/.test(raw) ? raw.replace(/^0+(?=[0-9])/, "") : null;
  return `${host}:${digits !== null && digits.length <= 10 ? digits : "invalid"}`;
}

function candidate(app: App, body: ProbeInput, state: ConnectionState, slot?: "b"): { state: ConnectionState; baseUrl: string | null } {
  if (state.state !== "ready") {
    // A test can supply the missing key or model of an incomplete connection. Resolve the other saved fields through
    // the normal resolver, with an in-memory overlay; the stored settings and their anchored view are never changed.
    const keys = connectionKeys(body.role, slot);
    const ownBase = app.settings.str(keys.baseUrl);
    const ownProvider = app.settings.str(keys.provider);
    const savedBase = ownBase || (!slot && !ownProvider ? app.settings.str("models.gateway_base_url") : null);
    const before = savedBase ? parseBaseUrl(savedBase) : null;
    const after = body.base_url ? parseBaseUrl(body.base_url) : before;
    const same = before && after && !("problem" in before) && !("problem" in after) && before.origin === after.origin;
    const sameProvider = body.provider === undefined || body.provider === (ownProvider || (body.role === "rerank" ? "cohere" : "openai-compatible"));
    const values = new Map<string, unknown>();
    for (const [field, key] of [["provider", keys.provider], ["model", keys.model], ["params", keys.params]] as const)
      if (Object.hasOwn(body, field)) values.set(key, body[field]);
    if (body.params === undefined && (!same || !sameProvider)) values.set(keys.params, {});
    if (body.base_url ?? savedBase) values.set(keys.baseUrl, body.base_url ?? savedBase);
    if (!same || Object.hasOwn(body, "api_key")) {
      values.set(keys.apiKey, body.api_key ?? null);
      values.set("models.gateway_api_key", null);
      if (slot === "b") values.set("models.embeddings_api_key", null);
    }
    const resolved = resolveConnection({
      get: <T>(path: string, fallback: T): T => values.has(path) ? values.get(path) as T : app.settings.get<T>(path, fallback),
      str: (path: string) => values.has(path) ? typeof values.get(path) === "string" ? values.get(path) as string : null : app.settings.str(path),
    }, body.role, slot ? { slot } : undefined);
    return { state: resolved, baseUrl: body.base_url ?? savedBase };
  }
  const prior = state.connection;
  const baseUrl = body.base_url ?? prior.baseUrl;
  const parsed = parseBaseUrl(baseUrl);
  const same = !("problem" in parsed) && parsed.origin === prior.endpoint.origin;
  const apiKey = Object.hasOwn(body, "api_key") ? body.api_key ?? null : same ? prior.apiKey : null;
  // Saved wire options belong to the same origin and provider. A new pair uses its provider's preset defaults.
  const inheritParams = same && (body.provider === undefined || body.provider === prior.provider);
  return { state: buildConnection(body.role, { provider: body.provider ?? prior.provider, baseUrl, apiKey,
    model: body.model ?? prior.model,
    params: body.params ?? (inheritParams ? { ...prior.params, ...(prior.preset ? { preset: prior.preset } : {}) } : {}) }, null), baseUrl };
}

const GROUPS = { day: "day", role: "role", model: "model", stage: "stage" } as const;
const validDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d;

export function registerModelsAdmin(r: Hono<any>, app: App, adminAudit: AdminAudit,
  options: { lookup?: ModelLookup; runChat?: ModelProbeSlotRunner; network?: modelProbe.ModelProbeOptions["network"] } = {}): void {
  // Bounded, per-router session state; credentials themselves are never keys of this map.
  const attempts = new Map<string, { start: number; count: number }>();
  r.get("/models", async (ctx) => {
    const roles = await Promise.all(ROLES.map(async (role) => {
      const live = await saved(app, role), st = live.state;
      const keys = connectionKeys(role, live.slot);
      // Names are write targets, independent of identical endpoint pairs and of legacy read fallbacks.
      const binding = role === "embeddings" ? { slot: live.slot ?? "a", legacy: live.legacy ?? false,
        settings_keys: { provider: keys.provider, base_url: keys.baseUrl, api_key: keys.apiKey, model: keys.model, params: keys.params } } : {};
      if (st.state !== "ready") return { role, ...binding, state: st.state, reason: st.reason, missing: st.missing, invalid: st.invalid,
        connection: null, capabilities: null,
        data_policy: { open: false, closed: false, reason: "not_listed" }, suggested_policy: "open" };
      const c = st.connection, problems = connectionConfigurationProblems(c);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let suggested_policy: "closed" | "open" = "open";
      try {
        const hint = await Promise.race([hostLocality(c.endpoint.host, { lookup: options.lookup }),
          new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 2000); })]);
        suggested_policy = hint ? suggestPolicy(hint) : "open";
      } finally { if (timer) clearTimeout(timer); }
      return { role, ...binding, state: problems.length ? "misconfigured" : "ready", problems, connection: connectionView(app, c, live.slot),
        capabilities: capabilities(c), data_policy: dataPolicy(app.settings, c),
        suggested_policy };
    }));
    return ctx.json({ roles });
  });
  r.get("/models/presets", (ctx) => ctx.json({ presets: [
    ...Object.entries(CHAT_PRESETS).map(([id, p]) => ({ id, role: "chat", provider: p.provider, base_url: p.baseUrl,
      capabilities: p.capabilities, model_list: p.modelList, fields: ["provider", "base_url", "api_key", "model", "params"] })),
    ...EMBEDDING_PROVIDERS.map((provider) => ({ id: provider, role: "embeddings", provider,
      base_url: provider === "openai-compatible" ? CHAT_PRESETS.openai!.baseUrl : provider === "gemini" ? CHAT_PRESETS.gemini!.baseUrl : RERANK_PRESETS[provider]?.baseUrl ?? null,
      capabilities: { provider }, model_list: false, fields: ["provider", "base_url", "api_key", "model", "params"] })),
    ...Object.entries(RERANK_PRESETS).map(([id, p]) => ({ id, role: "rerank", provider: p.provider, base_url: p.baseUrl,
      capabilities: p.capabilities, model_list: false, fields: ["provider", "base_url", "api_key", "model", "params"] })),
  ] }));
  r.post("/models/test", async (ctx) => {
    const caller = ctx.get("caller");
    const session = caller?.admin?.sessionId ?? "legacy-admin";
    const now = Date.now();
    for (const [key, value] of attempts) if (now - value.start >= 60_000) attempts.delete(key);
    const value = attempts.get(session) ?? { start: now, count: 0 };
    if (value.count >= 6 || !attempts.has(session) && attempts.size >= 10_000) {
      await adminAudit(ctx, "models_test", { role: "unknown", host: null, code: "rate_limited", data_policy_bypassed: null });
      return ctx.json(error("rate_limited", "At most six connection tests are allowed per minute."), 429);
    }
    value.count++; attempts.set(session, value);
    const input = probeInput(await ctx.req.json().catch(() => null));
    if (!input) {
      await adminAudit(ctx, "models_test", { role: "unknown", host: null, code: "invalid_argument", data_policy_bypassed: null });
      return ctx.json(error("invalid_argument", "Expected a model role and optional connection fields."), 400);
    }
    // The response deadline starts before the active-embedder query and also covers the audit sink.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ctl = new AbortController();
    let host = auditHost(input.base_url ?? null);
    let dataPolicyBypassed: boolean | null = null;
    const operation = async (): Promise<ModelProbeResult> => {
      const live = await saved(app, input.role);
      if (ctl.signal.aborted) return failedModelProbe("timeout");
      const requested = candidate(app, input, live.state, live.slot);
      host = auditHost(requested.baseUrl);
      if (input.base_url !== undefined && "problem" in parseBaseUrl(input.base_url)) return failedModelProbe("destination_denied");
      const st = requested.state;
      if (st.state !== "ready") return failedModelProbe(st.invalid.some((k) => k.endsWith("base_url")) ? "destination_denied" : "not_available");
      dataPolicyBypassed = !dataPolicy(app.settings, st.connection).open;
      const changed = ["provider", "base_url", "model", "params"].some((k) => Object.hasOwn(input, k));
      return modelProbe.probeModel(st.connection, { settings: app.settings, lookup: options.lookup, runChat: options.runChat ?? slotRunner(app),
        onPolicyBypass: () => { dataPolicyBypassed = true; },
        report: (report) => app.platform.reportUsage(st.connection, { ...report, stage: "model_probe" }),
        ...(!changed && live.profile ? { profile: live.profile } : {}), signal: ctl.signal, network: options.network });
    };
    const work = operation().catch(() => failedModelProbe("not_available"));
    const timeout = new Promise<ModelProbeResult>((resolve) => {
      timer = setTimeout(() => { ctl.abort(); resolve(failedModelProbe("timeout")); }, 15_000);
    });
    try {
      const result = await Promise.race([work, timeout]);
      const code = result.checks.at(-1)?.code ?? "not_available";
      // Audit is bounded by the same request deadline; its values contain no candidate credentials or fingerprints.
      await Promise.race([adminAudit(ctx, "models_test", { role: input.role, host, code,
        data_policy_bypassed: dataPolicyBypassed }).catch(() => undefined), timeout]);
      return ctx.json(result);
    } finally { if (timer) clearTimeout(timer); ctl.abort(); }
  });
  r.get("/models/usage", async (ctx) => {
    const today = new Date().toISOString().slice(0, 10);
    const from = ctx.req.query("from") ?? new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
    const to = ctx.req.query("to") ?? today;
    const group = ctx.req.query("group") ?? "day";
    if (!Object.hasOwn(GROUPS, group) || !validDay(from) || !validDay(to) || from > to || Date.parse(to) - Date.parse(from) > 366 * 86_400_000)
      return ctx.json(error("invalid_argument", "Use valid dates within 366 days and group day, role, model or stage."), 400);
    const column = GROUPS[group as keyof typeof GROUPS];
    // pg parses dates at local midnight; return calendar keys as text before JSON serialization.
    const groupKey = column === "day" ? "to_char(day, 'YYYY-MM-DD')" : column;
    try {
      const rows = (await app.db.control.query(`SELECT ${groupKey} AS group_key, SUM(calls)::text AS calls,
        SUM(input_tokens)::text AS input_tokens, SUM(cached_input_tokens)::text AS cached_input_tokens,
        SUM(output_tokens)::text AS output_tokens, SUM(search_units)::text AS search_units,
        SUM(estimated_calls)::text AS estimated_calls, SUM(cost_micros)::text AS cost_micros,
        SUM(unpriced_calls)::text AS unpriced_calls FROM model_usage_daily
        WHERE instance_id = $1 AND day >= $2::date AND day <= $3::date GROUP BY ${column} ORDER BY ${column}`,
        [app.instanceId, from, to])).rows;
      await app.platform.budgetFresh();
      return ctx.json({ from, to, group, rows, budget: app.platform.budgetState() });
    } catch {
      return ctx.json(error("internal", "Model usage is not available.", "usage_unavailable"), 503);
    }
  });
}

/** The lock connection of the model probe: the control pool's own options with the password passed
 * explicitly. pg-pool keeps the password of `pool.options` non-enumerable, so a spread copy alone carries none. */
export function slotClientConfig(pool: pg.Pool, applicationName: string): pg.ClientConfig {
  return { ...pool.options, password: pool.options.password, application_name: applicationName,
    connectionTimeoutMillis: 1500, query_timeout: 1500, ssl: pool.options.ssl };
}
/** The model call of a slot, wrapped so that its own error can be told apart from an error of the runner. */
function modelCall<S, T>(fn: (slot: S) => Promise<T>): { fn: (slot: S) => Promise<T>; thrown: unknown[] } {
  const thrown: unknown[] = [];
  return { thrown, fn: async (slot) => { try { return await fn(slot); } catch (e) { thrown.push(e); throw e; } } };
}
/** A failure of the runner itself (the lock connection, the lock query) is the gate's, never "not a model API"; an error
 * of the model call passes unchanged. No text of the original error is kept. */
function slotFailure(e: unknown, call: { thrown: unknown[] }): unknown {
  return call.thrown.includes(e) || e instanceof PlatformError ? e : new PlatformError("gate", "the model slot could not be taken");
}
