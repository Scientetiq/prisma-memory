// The `models` health check: what each model role (chat, embeddings, rerank) is
// connected to and whether it can be used, and which endpoints may receive closed records. The check names are an API —
// scripts, the panel and the contract text read them — so health.ts also keeps `platform` as the second name of this check
// and `t1_gate` for the service keys of tier T1.
//
// States of a role:
//   off            — switched off (provider none) or not configured: no AI for that role, full-text search covers it;
//   ok             — configured, allowed by the data policy and (for the legacy gateway) served by it;
//   unreachable    — the legacy model gateway does not answer its model list;
//   misconfigured  — configured but not usable: a missing or refused value, a provider without an adapter yet, a model the
//                    gateway does not serve;
//   not_allowed    — the pair "base URL + model" is in neither models.allow_closed nor models.allow_open: every call is
//                    refused, the stage waits;
//   unpinned       — anchors are in force and a key the role depends on has a value in the database but no pin: it reads as
//                    unset, every call is refused until the anchors are signed again.
// Level: models.health_strict false (the default of a new installation) — any problem of a role marks the service degraded,
// and no AI at all is ok; true (an installation of an earlier version, set by its seed) — exactly what stopped the
// service before this check stops it (fail_closed): a model key that was required and has no value (the gateway address and
// key, the chat and embeddings model of the legacy gateway) and a model the gateway does not serve. Everything else that is
// misconfigured — a value the address parser refuses, an own connection filled in half, a provider without an adapter yet —
// was degraded or did not exist before, and is degraded in both modes. Unreachable, not allowed and
// unpinned are degraded in both modes too: temporary or a decision of the data policy, not a broken configuration (an
// unpinned legacy address under anchors was fail_closed before, as an unset required key; no model call is allowed in
// either case, so this is availability reporting only).
//
// The money budget is told in the detail when a limit is set: spent (the llm check is the one that is not ok then),
// near its limit, or not enforced because the usage table is missing or cannot be read (a warning: calls go on unchecked).
//
// Pure: the settings, the budget state and the result of the legacy gateway probe (`Platform.check()`) are parameters. Texts carry host[:port],
// model names and settings key names only — never a key, a path or a full address.
import { addressProblems, roleConfigurationProblems, modelConfigurationText, chatAdapter, connectionKeys, dataPolicy, legacyKeys, parseBaseUrl, policyPairs, rerankAdapter, resolveConnection,
         type BudgetState, type ConnectionState, type ModelConfigurationProblem, type ModelConnection, type ModelRole, type Settings } from "@memory/shared";

export type ModelRoleHealthState = "off" | "ok" | "unreachable" | "misconfigured" | "not_allowed" | "unpinned";

export interface ModelRoleHealth {
  role: ModelRole;
  state: ModelRoleHealthState;
  /** host[:port] of the connection; null when the role has none. */
  endpoint: string | null;
  model: string | null;
  /** One short English phrase: what the state means for this role and what to do. */
  note: string;
  /** Diagnostics appended after the existing instruction, without replacing its wording. */
  problems?: ModelConfigurationProblem[];
  /** Under models.health_strict this state stops the service (fail_closed): what a required model key did before. */
  hard: boolean;
}

export interface ModelsHealth {
  ok: boolean;
  level?: "warn";
  detail: string;
  /** What the check does to the status of health: hard — fail_closed, soft — degraded, null — nothing. */
  severity: "hard" | "soft" | null;
  strict: boolean;
  /** Every role is off: the installation runs with no AI (full-text search only). */
  ai_off: boolean;
  roles: ModelRoleHealth[];
  /** Every pair of models.allow_closed as host[:port] and model, private or not. */
  closed_data_endpoints: Array<{ endpoint: string; model: string }>;
}

/** The answer of `Platform.check()`: the legacy gateway's model list, or why it could not be read. */
export interface LegacyGatewayProbe { ok: boolean; missing: string[]; error?: string }

/** What the check reads of the settings; `pinState` and `rawValue` only where anchors can be in force (Settings). */
export type ModelsHealthSettings = Pick<Settings, "get" | "str"> & Partial<Pick<Settings, "pinState" | "rawValue">>;

const ROLES: readonly ModelRole[] = ["chat", "embeddings", "rerank"];
const NOT_OK: ReadonlySet<ModelRoleHealthState> = new Set(["misconfigured", "unreachable", "not_allowed", "unpinned"]);
const AI_OFF = "AI is off: full-text search only";

/**
 * Does the role read the legacy gateway (no provider of its own) while a model key that was required earlier has no
 * value — the gateway address or key, the chat model (`models.llm_model`) or the embeddings model? The reranker never was
 * required. Every key is read by a literal call, so the settings registry sees each read.
 */
function requiredBeforeUnset(settings: ModelsHealthSettings, role: ModelRole): boolean {
  if (role === "rerank") return false;
  if (hasValue(role === "chat" ? settings.str("models.chat_provider") : settings.str("models.embeddings_provider"))) return false;
  const model = role === "chat" ? settings.str("models.llm_model") : settings.str("retrieval.embeddings_model");
  return [settings.str("models.gateway_base_url"), settings.str("models.gateway_api_key"), model].some((v) => !hasValue(v));
}

/** host[:port] of a canonical origin. */
const endpointOf = (c: ModelConnection): string => c.endpoint.origin.replace(/^https?:\/\//, "");

/**
 * The live embeddings connection. A future `activeEmbeddingsConnection(db, settings)` is the source of truth (the active
 * embedder may live in slot b after a switch); until it exists this is a one-line stand-in: slot a.
 */
const embeddingsConnection = (settings: ModelsHealthSettings): ConnectionState => resolveConnection(settings, "embeddings");

const stateOf = (settings: ModelsHealthSettings, role: ModelRole): ConnectionState =>
  role === "embeddings" ? embeddingsConnection(settings) : resolveConnection(settings, role);

/**
 * Has the role an adapter in this version? The rules of the facade: chat and rerank by their registries; embeddings — the
 * OpenAI-style wire of `Platform.embed` (its adapters are added there).
 */
function adapterKnown(c: ModelConnection): boolean {
  if (c.role === "chat") return chatAdapter(c.provider) !== null;
  if (c.role === "rerank") return rerankAdapter(c.provider) !== null;
  return c.provider === "openai-compatible";
}

const hasValue = (v: unknown): boolean =>
  v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0) && !(typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);

/** Keys of the role that have a value in the database but read as unset because anchors are in force and they have no pin. */
function unpinnedKeys(settings: ModelsHealthSettings, role: ModelRole): string[] {
  if (typeof settings.pinState !== "function") return [];
  const own = connectionKeys(role), legacy = legacyKeys(role);
  const keys = [own.baseUrl, own.apiKey, legacy.baseUrl, legacy.apiKey, "models.allow_closed", "models.allow_open"];
  return [...new Set(keys)].filter((k) => settings.pinState!(k)?.ok === false && hasValue(settings.rawValue?.(k)));
}

/** Is any role on the legacy gateway ready, so that its model list is worth one probe? */
export function legacyProbeNeeded(settings: ModelsHealthSettings): boolean {
  return ROLES.some((role) => { const st = stateOf(settings, role); return st.state === "ready" && st.connection.legacy; });
}

function roleHealth(settings: ModelsHealthSettings, role: ModelRole, o: { strict: boolean; probe: LegacyGatewayProbe | null; stub: boolean }): ModelRoleHealth {
  const st = stateOf(settings, role);
  const ready = st.state === "ready" ? st.connection : null;
  const base = { role, endpoint: ready ? endpointOf(ready) : null, model: ready?.model ?? null, hard: false };
  // the role reads the legacy gateway (no provider of its own) and a key that was required before has no value: fail_closed
  // under strict, as the required key did
  const legacyUnset = requiredBeforeUnset(settings, role);
  if (role === "chat" && o.stub) return { ...base, state: "ok", note: "stub mode: canned answers, no model is called" };
  if (st.state === "off" && st.reason === "disabled") return { ...base, state: "off", note: `switched off (models.${role}_provider is none)` };
  const unpinned = (): ModelRoleHealth | null => {
    const keys = unpinnedKeys(settings, role);
    return keys.length ? { ...base, state: "unpinned", note: `anchors in force: ${keys.join(", ")} not pinned — every call is refused until the anchors are signed again` } : null;
  };
  if (st.state === "off") {
    const u = unpinned();
    if (u) return u;
    const keys = connectionKeys(role);
    if (st.invalid.length) {
      const codes = addressProblems(settings, role);
      const refused = st.invalid.map((k) => (codes[k] ? `${k} (${codes[k]})` : k));
      return { ...base, state: "misconfigured", hard: legacyUnset, note: `refused ${refused.join(", ")}${st.missing.length ? `; set ${st.missing.join(", ")}` : ""}` };
    }
    // nothing chosen for the role (no provider and no legacy gateway address)
    if (st.missing.includes(keys.provider)) {
      if (o.strict && role !== "rerank")
        return { ...base, state: "misconfigured", hard: true, note: `not configured, required by models.health_strict: set ${legacyKeys(role).baseUrl} or ${keys.provider}` };
      return { ...base, state: "off", note: "not configured" };
    }
    const problems = roleConfigurationProblems(settings, role);
    // an address but no model: no reranking (as it has always meant), and no semantic search unless strict asks for it
    if (!problems.length && st.missing.every((k) => k === keys.model)) {
      if (role === "rerank") return { ...base, state: "off", note: "no reranker model" };
      if (role === "embeddings" && !o.strict) return { ...base, state: "off", note: "no embeddings model" };
    }
    return { ...base, state: "misconfigured", hard: legacyUnset, note: `set ${st.missing.join(", ")}`, problems };
  }
  const c = ready!;
  const problems = roleConfigurationProblems(settings, role);
  if (!adapterKnown(c)) return { ...base, state: "misconfigured", note: `no ${role} adapter for provider ${c.provider} yet`, problems };
  if (problems.length) return { ...base, state: "misconfigured", note: modelConfigurationText(problems) };
  // a model the gateway does not serve first: it stopped the service before the pairs existed, listed or not
  if (c.legacy && o.probe && !o.probe.ok && o.probe.missing.includes(c.model))
    return { ...base, state: "misconfigured", hard: true, note: `the model gateway does not serve ${c.model}` };
  const policy = dataPolicy(settings, c);
  if (policy.reason === "not_listed")
    return unpinned() ?? { ...base, state: "not_allowed",
      note: `${base.endpoint} · ${c.model} may receive no records: add the pair to models.allow_closed, or to models.allow_open for open records only` };
  if (c.legacy && o.probe && !o.probe.ok && !o.probe.missing.length)
    return { ...base, state: "unreachable", note: `the model gateway does not answer: ${(o.probe.error ?? "no answer").slice(0, 160)}` };
  return { ...base, state: "ok", note: `${base.endpoint} · ${c.model}${policy.reason === "allow_open" ? ", open records only" : ""}` };
}

/** Every pair of models.allow_closed (as it reads now: an unpinned list reads empty) as host[:port] and model. */
function closedEndpoints(settings: ModelsHealthSettings): Array<{ endpoint: string; model: string }> {
  return policyPairs(settings).closed.map((e) => {
    const p = parseBaseUrl(e.base_url);
    return { endpoint: "problem" in p ? "(not a valid address)" : p.hostPort, model: e.model };
  });
}

/** The money budget in the detail; null — nothing to tell (no limit set, or neither spent nor near). */
function budgetText(b: BudgetState | null | undefined): string | null {
  if (!b) return null;
  const amount = (v: number) => Number(v.toFixed(2)).toString();
  const of = (p: "daily" | "monthly") => p === "daily" ? `${amount(b.spent_day)} of ${b.daily} ${b.currency} today (UTC)` : `${amount(b.spent_month)} of ${b.monthly} ${b.currency} this month (UTC)`;
  if (b.exhausted) return `money budget: the ${b.exhausted} limit is spent, ${of(b.exhausted)}; model calls wait`;
  if (!b.enforced && b.unenforced === "read_failed") return "money budget: not enforced — the spent amount cannot be read from model_usage_daily, model calls are not stopped";
  if (!b.enforced) return "money budget: not enforced — the usage table model_usage_daily is missing, model calls are not counted";
  if (b.warning) return `money budget: ${of(b.warning)}`;
  return null;
}

/** Keep the complete instruction in parentheses: existing consumers pin it, including the closing parenthesis. */
const roleText = (r: ModelRoleHealth): string => `${r.role}: ${r.state} (${r.note})${r.problems?.length ? `; ${modelConfigurationText(r.problems)}` : ""}`;

/**
 * The models check. `probe` — the legacy gateway's answer (null when no legacy role is ready or it was not asked); `stub` —
 * stub mode of the process (MEMORY_LLM_STUB); `hints` — advice for accepted addresses (`Platform.addressHints()`); `budget`
 * — the money budget (`Platform.budgetState()`).
 */
export function modelsHealth(settings: ModelsHealthSettings, o: { probe?: LegacyGatewayProbe | null; stub?: boolean; hints?: string[]; budget?: BudgetState | null } = {}): ModelsHealth {
  const strict = settings.get<unknown>("models.health_strict", false) === true;
  const roles = ROLES.map((role) => roleHealth(settings, role, { strict, probe: o.probe ?? null, stub: o.stub === true }));
  const closed = closedEndpoints(settings);
  const aiOff = roles.every((r) => r.state === "off");
  const bad = roles.filter((r) => NOT_OK.has(r.state));
  const severity = strict && roles.some((r) => r.hard) ? "hard" : bad.length ? "soft" : null;
  const closedText = closed.length ? closed.map((e) => `${e.endpoint} · ${e.model}`).join(", ") : "no endpoint";
  const parts = aiOff ? [AI_OFF, ...(closed.length ? [`closed data may go to: ${closedText}`] : [])]
    : [...roles.map(roleText), `closed data may go to: ${closedText}`];
  const hints = bad.length ? [] : o.hints ?? [];
  // a budget that cannot be enforced is a warning (calls go on); spent or near — told only (the llm check carries the fault)
  const budget = o.stub ? null : budgetText(o.budget);
  const warn = hints.length > 0 || (o.budget?.enforced === false && !o.stub);
  return {
    ok: bad.length === 0, ...(warn && bad.length === 0 ? { level: "warn" as const } : {}), detail: [...parts, ...(budget ? [budget] : []), ...hints].join("; "),
    severity, strict, ai_off: aiOff, roles, closed_data_endpoints: closed,
  };
}

/** The `models` entry of health (the contract's check shape: ok, detail, level only; the roles go into the text for now). */
export function modelsCheck(m: ModelsHealth): { ok: boolean; level?: "warn"; detail: string } {
  return { ok: m.ok, ...(m.level ? { level: m.level } : {}), detail: m.detail };
}

/** The first role that is not ok, as in the detail (for the `platform` alias). */
export function firstProblem(m: ModelsHealth): string | null {
  const r = m.roles.find((x) => NOT_OK.has(x.state));
  return r ? roleText(r) : null;
}

export { AI_OFF as MODELS_AI_OFF_TEXT };
