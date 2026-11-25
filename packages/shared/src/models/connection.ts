// Model connections: which adapter, address, key and model each role uses — resolved from the settings by
// rules R1–R7 below. Nothing here calls a model: the transport and the adapters receive the
// resolved `ModelConnection`.
//
// Keys are flat (`models.<role>_<field>`, the settings key pattern has one dot). The settings
// registry seeds and validates the chat and rerank keys and the keys of the two embeddings slots (`models.embeddings_*`,
// `models.embeddings_b_*`); this module reads all of them by the same rules. The legacy keys (one gateway address and key
// for all roles, a model name per role) stay in place and are only read.
//
// R1 provider: `none` → off (disabled); empty → the legacy adapter of the role, and only while a legacy address exists;
//    otherwise not configured.
// R2 base URL: the role's own key; the legacy address only for an empty provider. Never from `params`: params are an
//    operational key, the address is anchored, and a preset switch must not move a stored key to another host.
// R3 a key travels only with its address: the role's own key; otherwise the legacy key, only when the resolved origin
//    equals the origin of the legacy address; otherwise none.
// R4 model: the role's own key, then the legacy name of the role; empty → not configured.
// R5 no inheritance between roles: embeddings and rerank never reuse the chat connection.
// R6 a legacy connection without a key is not configured (as today); only other connections may be keyless.
// R7 slot b of the embeddings role: the same rules with no legacy fallback; its empty key falls back to the key of slot a
//    only when the origins of the two slots are equal.
import { canonicalJson } from "../settings-policy.ts";
import { addressLocality, apiKeySendable, ModelAddressError, parseBaseUrl, type ParsedBaseUrl } from "./address.ts";
import { geminiModelNameProblem, modelNameProblem } from "./names.ts";
import { dataPolicy, legacyT0Projection, POLICY_ANY_MODEL, policyPairs } from "./policy.ts";
import type { ConnectionKeyNames, ConnectionSettings, ConnectionState, LegacyFields, ModelConnection, ModelRole, RawConnectionFields } from "./types.ts";

export { modelNameProblem } from "./names.ts";

/** Adapter kinds of the chat role. */
export const CHAT_PROVIDERS = ["openai-compatible", "anthropic", "gemini"] as const;
/** Adapter kinds of the rerank role. */
export const RERANK_PROVIDERS = ["cohere", "voyage", "jina", "tei", "openrouter"] as const;
/** Provider value that switches a role off. */
export const MODEL_PROVIDER_NONE = "none";
/** Kinds of the embeddings role: here only the shape of the name is checked (the embeddings module validates the kind). */
const PROVIDER_NAME = /^[a-z][a-z0-9-]{0,39}$/;
/** A preset name in `params.preset`. */
const PRESET_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The adapter an empty provider means: the legacy client of the role (one OpenAI-style gateway). */
const LEGACY_ADAPTER: Record<ModelRole, { provider: string; preset: string | null }> = {
  chat: { provider: "openai-compatible", preset: "litellm" },
  rerank: { provider: "cohere", preset: null },
  embeddings: { provider: "openai-compatible", preset: null },
};

const LEGACY_BASE_URL_KEY = "models.gateway_base_url";
const LEGACY_KEY_KEY = "models.gateway_api_key";
const LEGACY_MODEL_KEY: Record<ModelRole, string> = { chat: "models.llm_model", embeddings: "retrieval.embeddings_model", rerank: "retrieval.rerank_model" };

const names = (provider: string, baseUrl: string, apiKey: string, model: string, params: string): ConnectionKeyNames => ({ provider, baseUrl, apiKey, model, params });

/** Settings keys of one connection: `models.<role>_<field>`, slot b of embeddings — `models.embeddings_b_<field>`. */
export function connectionKeys(role: ModelRole, slot?: "b"): ConnectionKeyNames {
  if (slot === "b" && role !== "embeddings") throw new Error(`model connection: slot b is a slot of the embeddings role only, not of ${role}`);
  const p = `models.${role}${slot === "b" ? "_b" : ""}_`;
  return names(`${p}provider`, `${p}base_url`, `${p}api_key`, `${p}model`, `${p}params`);
}

/** Names of the legacy keys a role falls back to: the gateway address and key, and the role's legacy model name. */
export function legacyKeys(role: ModelRole): Pick<ConnectionKeyNames, "baseUrl" | "apiKey" | "model"> {
  const apiKey = LEGACY_KEY_KEY;
  return { baseUrl: LEGACY_BASE_URL_KEY, apiKey, model: LEGACY_MODEL_KEY[role] };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** A set string value; null / "" are "not set"; another JSON type is `BAD`. */
const BAD = Symbol("bad");
function textOf(v: unknown): string | null | typeof BAD {
  if (v === null || v === undefined || v === "") return null;
  return typeof v === "string" ? v : BAD;
}

function providerKnown(role: ModelRole, provider: string): boolean {
  if (role === "chat") return (CHAT_PROVIDERS as readonly string[]).includes(provider);
  if (role === "rerank") return (RERANK_PROVIDERS as readonly string[]).includes(provider);
  return PROVIDER_NAME.test(provider) && provider !== MODEL_PROVIDER_NONE;
}


/**
 * Another source of a key for R3: used only when the resolved origin equals the origin of `baseUrl`. `keyName` — the
 * settings key the key is stored in, named when its value cannot be sent (default: the legacy gateway key).
 */
export interface KeySource { baseUrl: string | null; apiKey: string | null; keyName?: string }

/** The key of `source` for the origin `origin` (R3), or null. */
function keyFor(origin: string, source: KeySource | null): string | null {
  if (!source) return null;
  const base = textOf(source.baseUrl), key = textOf(source.apiKey);
  if (typeof base !== "string" || typeof key !== "string") return null;
  const parsed = parseBaseUrl(base);
  return "problem" in parsed || parsed.origin !== origin ? null : key;
}

const unique = (xs: string[]): string[] => [...new Set(xs)];

/**
 * A deep frozen copy of a JSON value. A read-whole setting comes back as the object of the settings cache itself, so a
 * shallow copy would let a consumer's write into a nested field change the setting for every later read. Own data
 * properties only (`__proto__` stays a plain key, as with a spread); a value nested too deep for the stack throws, and
 * the caller treats it as invalid.
 */
function frozenCopy(v: unknown): unknown {
  if (Array.isArray(v)) return Object.freeze(v.map(frozenCopy));
  if (isPlainObject(v)) return Object.freeze(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, frozenCopy(x)])));
  return v;
}

/**
 * The pure core of the rules R1–R7. `own` — the stored fields of the role (or slot); `legacy` — the legacy fields of the
 * role, null for slot b; `opts.keys` — names of the own keys (default: the role's first slot); `opts.keySource` — where
 * an empty key may come from (default: the legacy address and key; for slot b — slot a's, R7). Never throws on stored
 * values: a value that cannot be used makes the role off with its key named in `invalid`.
 */
export function buildConnection(role: ModelRole, own: RawConnectionFields, legacy: LegacyFields | null,
                                opts: { keys?: ConnectionKeyNames; keySource?: KeySource | null } = {}): ConnectionState {
  const keys = opts.keys ?? connectionKeys(role);
  const missing: string[] = [], invalid: string[] = [];
  const provider = textOf(own.provider);
  if (provider === MODEL_PROVIDER_NONE) return { state: "off", reason: "disabled", missing: [], invalid: [] };
  if (provider === BAD || (provider !== null && !providerKnown(role, provider))) invalid.push(keys.provider);
  const legacyMode = provider === null;
  const legacyBase = legacy ? textOf(legacy.baseUrl) : null;
  // R1: an empty provider is the legacy adapter, and only where a legacy address exists
  if (legacyMode && typeof legacyBase !== "string") missing.push(keys.provider);

  // R2: the own address; the legacy address only for an empty provider
  const ownBase = textOf(own.baseUrl);
  let parsed: ParsedBaseUrl | null = null, fromLegacy = false;
  if (ownBase === BAD) invalid.push(keys.baseUrl);
  else if (ownBase !== null) {
    const p = parseBaseUrl(ownBase);
    if ("problem" in p) invalid.push(keys.baseUrl); else parsed = p;
  } else if (legacyMode && typeof legacyBase === "string") {
    const p = parseBaseUrl(legacyBase);
    if ("problem" in p) invalid.push(LEGACY_BASE_URL_KEY); else { parsed = p; fromLegacy = true; }
  } else if (!legacyMode) missing.push(keys.baseUrl);

  // the legacy connection: the legacy adapter at the legacy address (however the address is written)
  let isLegacy = fromLegacy;
  if (legacyMode && parsed && !fromLegacy && typeof legacyBase === "string") {
    const lp = parseBaseUrl(legacyBase);
    isLegacy = !("problem" in lp) && lp.baseUrl === parsed.baseUrl;
  }

  // R4: the own model, then the legacy name of the role; no built-in name (an unset chat model is no model)
  const ownModel = textOf(own.model);
  let model: string | null = null;
  if (ownModel === BAD) invalid.push(keys.model);
  else if (ownModel !== null) model = ownModel;
  else {
    const lm = legacy ? textOf(legacy.model) : null;
    if (typeof lm === "string") model = lm;
    else missing.push(keys.model);
  }

  if (role === "chat" && provider === "gemini" && model !== null && geminiModelNameProblem(model)) invalid.push(keys.model);

  // params: an object, read whole, handed out as a deep frozen copy; never a destination
  let params: Readonly<Record<string, unknown>> = Object.freeze({});
  if (own.params !== null && own.params !== undefined) {
    if (!isPlainObject(own.params)) invalid.push(keys.params);
    else {
      try { params = frozenCopy(own.params) as Readonly<Record<string, unknown>>; }
      catch { invalid.push(keys.params); }
    }
  }

  // R3: the own key; the legacy key (or slot a's, R7) only for the same origin
  let apiKey: string | null = null;
  const ownKey = textOf(own.apiKey);
  if (ownKey === BAD) invalid.push(keys.apiKey);
  else if (ownKey !== null) apiKey = ownKey;
  else if (parsed) apiKey = keyFor(parsed.origin, opts.keySource !== undefined ? opts.keySource : legacy ? { baseUrl: legacy.baseUrl, apiKey: legacy.apiKey } : null);
  // R6: the legacy connection needs its key, as today
  if (isLegacy && apiKey === null && ownKey !== BAD) missing.push(LEGACY_KEY_KEY);
  // a key `fetch` would not send (NUL, CR or LF inside, other control characters, code points above U+00FF) makes the
  // connection not usable — the transport refuses it as well; the value itself is never named
  if (apiKey !== null && !apiKeySendable(apiKey))
    invalid.push(ownKey !== null ? keys.apiKey : opts.keySource?.keyName ?? LEGACY_KEY_KEY);

  if (missing.length || invalid.length || !parsed || model === null)
    return { state: "off", reason: "not_configured", missing: unique(missing), invalid: unique(invalid) };
  const adapter = legacyMode ? LEGACY_ADAPTER[role]
    : { provider: provider as string, preset: typeof params.preset === "string" && params.preset ? params.preset : null };
  const connection: ModelConnection = {
    role, provider: adapter.provider, preset: adapter.preset, baseUrl: parsed.baseUrl, apiKey, model, params,
    endpoint: { origin: parsed.origin, pathPrefix: parsed.pathPrefix, host: parsed.host, locality: (parsed.ipKind && addressLocality(parsed.ipKind)) || "public" },
    legacy: isLegacy,
  };
  return { state: "ready", connection };
}

/**
 * The stored fields of a connection. Every key is read by a literal call, so the settings registry
 * generator sees each read.
 */
function ownFields(s: ConnectionSettings, role: ModelRole, slot?: "b"): RawConnectionFields {
  if (role === "chat")
    return { provider: s.str("models.chat_provider"), baseUrl: s.str("models.chat_base_url"), apiKey: s.str("models.chat_api_key"),
             model: s.str("models.chat_model"), params: s.get<unknown>("models.chat_params", {}) };
  if (role === "rerank")
    return { provider: s.str("models.rerank_provider"), baseUrl: s.str("models.rerank_base_url"), apiKey: s.str("models.rerank_api_key"),
             model: s.str("models.rerank_model"), params: s.get<unknown>("models.rerank_params", {}) };
  if (slot === "b")
    return { provider: s.str("models.embeddings_b_provider"), baseUrl: s.str("models.embeddings_b_base_url"), apiKey: s.str("models.embeddings_b_api_key"),
             model: s.str("models.embeddings_b_model"), params: s.get<unknown>("models.embeddings_b_params", {}) };
  return { provider: s.str("models.embeddings_provider"), baseUrl: s.str("models.embeddings_base_url"), apiKey: s.str("models.embeddings_api_key"),
           model: s.str("models.embeddings_model"), params: s.get<unknown>("models.embeddings_params", {}) };
}

/** The legacy fields of a role. */
function legacyFields(s: ConnectionSettings, role: ModelRole): LegacyFields {
  const model = role === "chat" ? s.str("models.llm_model") : role === "rerank" ? s.str("retrieval.rerank_model") : s.str("retrieval.embeddings_model");
  return { baseUrl: s.str("models.gateway_base_url"), apiKey: s.str("models.gateway_api_key"), model };
}

/** The address and key slot a uses (its own, or the legacy ones for an empty provider, R2/R3) — the key source of slot b. */
function slotAKeySource(s: ConnectionSettings): KeySource {
  const own = ownFields(s, "embeddings"), legacy = legacyFields(s, "embeddings");
  const ownBase = textOf(own.baseUrl), ownKey = textOf(own.apiKey), legacyBase = textOf(legacy.baseUrl);
  const base = typeof ownBase === "string" ? ownBase : textOf(own.provider) === null && typeof legacyBase === "string" ? legacyBase : null;
  if (base === null) return { baseUrl: null, apiKey: null };
  if (typeof ownKey === "string") return { baseUrl: base, apiKey: ownKey, keyName: connectionKeys("embeddings").apiKey };
  const parsed = parseBaseUrl(base);
  return { baseUrl: base, apiKey: "problem" in parsed ? null : keyFor(parsed.origin, legacy), keyName: LEGACY_KEY_KEY };
}

/**
 * The connection of a role from the settings. `{ slot: "b" }` — the second embeddings connection (the next-model
 * slot; no legacy fallback). For the live embeddings connection use `activeEmbeddingsConnection`: after a
 * switch the active embedder may live in slot b.
 */
export function resolveConnection(settings: ConnectionSettings, role: ModelRole, opts?: { slot?: "b" }): ConnectionState {
  const slot = opts?.slot;
  const keys = connectionKeys(role, slot);
  if (slot === "b") return buildConnection(role, ownFields(settings, role, "b"), null, { keys, keySource: slotAKeySource(settings) });
  return buildConnection(role, ownFields(settings, role), legacyFields(settings, role), { keys });
}

/**
 * The model name a role is configured with — rule R4 without the address: the role's own model key, then the role's
 * legacy model name; null — none (there is no built-in name). The facade
 * passes it to the data-policy gate also when the connection itself is not usable (today's order of checks).
 */
export function configuredModel(settings: ConnectionSettings, role: ModelRole): string | null {
  const own = ownFields(settings, role);
  const ownModel = textOf(own.model);
  if (typeof ownModel === "string") return ownModel;
  const legacyModel = textOf(legacyFields(settings, role).model);
  return typeof legacyModel === "string" ? legacyModel : null;
}

/**
 * The model names of the roles that are ready on the legacy gateway (`resolveConnection` ready and `legacy`), in the order
 * chat, embeddings, rerank, each once. The name is the role's by rule R4 — its own model key, then its legacy name — so a
 * name given only in `models.chat_model` / `models.embeddings_model` / `models.rerank_model` with an empty provider counts
 * too. These are the names the gateway check asks the gateway's model list for.
 */
export function legacyGatewayModels(settings: ConnectionSettings): string[] {
  const out: string[] = [];
  for (const role of ["chat", "embeddings", "rerank"] as const) {
    const st = resolveConnection(settings, role);
    if (st.state === "ready" && st.connection.legacy && !out.includes(st.connection.model)) out.push(st.connection.model);
  }
  return out;
}

/**
 * The legacy gateway as one connection, whatever the role keys say: the address and key of `models.gateway_base_url` /
 * `models.gateway_api_key` and a model name — the first legacy name that is set (chat, embeddings, rerank), else the first
 * name of a role ready on the legacy gateway (`legacyGatewayModels`, which reads the role keys too).: there is no
 * built-in chat name; the gateway check lists the models and sends none, so any configured name will do. The gateway
 * check of the facade (`check()`) talks to it; with no name at all it is not configured, as the chat role is.
 */
export function legacyGatewayConnection(settings: ConnectionSettings): ConnectionState {
  const fields = legacyFields(settings, "chat");
  const name = [fields.model, legacyFields(settings, "embeddings").model, legacyFields(settings, "rerank").model].find((m) => typeof textOf(m) === "string")
    ?? legacyGatewayModels(settings)[0];
  return buildConnection("chat", EMPTY_FIELDS, { ...fields, model: name ?? fields.model });
}

/**
 * Stable reasons of the address keys of a role that are refused (`BaseUrlProblem` codes), by key name: the own base URL
 * of the role and, for an empty provider, the legacy gateway address. For messages and the readiness view; no values.
 */
export function addressProblems(settings: ConnectionSettings, role: ModelRole, opts?: { slot?: "b" }): Record<string, string> {
  const keys = connectionKeys(role, opts?.slot);
  const own = ownFields(settings, role, opts?.slot);
  const out: Record<string, string> = {};
  const problemOf = (raw: string | null | typeof BAD): string | null => {
    if (raw === BAD) return "not_a_url";
    if (raw === null) return null;
    const p = parseBaseUrl(raw);
    return "problem" in p ? p.problem : null;
  };
  const ownProblem = problemOf(textOf(own.baseUrl));
  if (ownProblem) out[keys.baseUrl] = ownProblem;
  if (opts?.slot !== "b" && textOf(own.provider) === null && textOf(own.baseUrl) === null) {
    const legacyProblem = problemOf(textOf(legacyFields(settings, role).baseUrl));
    if (legacyProblem) out[LEGACY_BASE_URL_KEY] = legacyProblem;
  }
  return out;
}

// ---------------------------------------------------------------- validation at save (Settings.validate)

const M_KEY = /^models\.(chat|rerank)_(provider|base_url|model|params)$/;

/**
 * Problems of a value of one of the connection keys (`models.chat_*`, `models.rerank_*`, and the type of the legacy
 * `models.llm_model`); [] for other keys and for null or "" (a reset). The secret rules of Settings apply to the `_api_key`
 * keys; the embeddings keys are checked by models/embeddings/settings-rules.ts.
 */
export function connectionSettingProblems(path: string, value: unknown): string[] {
  // the legacy chat model: its seed default is NULL since, so the type check the default gave is kept here
  if (path === "models.llm_model") return value === null || value === undefined || typeof value === "string" ? [] : ["a string is expected"];
  const m = M_KEY.exec(path);
  if (!m || value === null || value === undefined) return [];
  const role = m[1] as "chat" | "rerank", field = m[2]!;
  if (field === "params") {
    if (!isPlainObject(value)) return ["an object of capability overrides is expected"];
    if (Object.hasOwn(value, "preset") && !(typeof value.preset === "string" && PRESET_NAME.test(value.preset)))
      return ["preset — a preset name in lower-case letters, digits and dashes (for example openai)"];
    return [];
  }
  if (value === "") return [];
  if (typeof value !== "string") return ["a string is expected"];
  if (field === "provider") {
    const list: readonly string[] = role === "chat" ? CHAT_PROVIDERS : RERANK_PROVIDERS;
    return value === MODEL_PROVIDER_NONE || list.includes(value) ? []
      : [`allowed ${[...list, MODEL_PROVIDER_NONE].map((x) => `"${x}"`).join(", ")} or empty (the legacy gateway keys)`];
  }
  if (field === "base_url") {
    const parsed = parseBaseUrl(value);
    return "problem" in parsed ? [new ModelAddressError(parsed.problem, parsed.detail).message] : [];
  }
  const problem = modelNameProblem(value);
  return problem ? [problem] : [];
}

// ---------------------------------------------------------------- rollback to the previous version

/** Why a rollback to the previous version would change what a role does. Stable codes; key names only, never values. */
export interface RollbackProblem {
  code: "role_own_connection" | "second_embeddings_slot" | "trusted_name_without_pair" | "open_name_without_pair" | "pair_without_trusted_name";
  /** The role concerned; null for a problem of the installation as a whole (the name list). */
  role: ModelRole | null;
  /** The new keys that are set and that the previous version does not read. */
  keys: string[];
  message: string;
}

const ROLL_ROLES: readonly ModelRole[] = ["chat", "embeddings", "rerank"];
const EMPTY_FIELDS: RawConnectionFields = { provider: null, baseUrl: null, apiKey: null, model: null, params: {} };

/** Comparable form of a state: everything but the key itself (compared apart, in memory only). */
function stateShape(s: ConnectionState): string {
  if (s.state === "off") return canonicalJson({ state: s.state, reason: s.reason });
  const { apiKey: _key, ...rest } = s.connection;
  return canonicalJson({ state: s.state, ...rest });
}
const sameKey = (a: ConnectionState, b: ConnectionState): boolean =>
  a.state !== "ready" || b.state !== "ready" || a.connection.apiKey === b.connection.apiKey;

/** Names of the own keys that hold a value (params: a non-empty object or a value of another type). */
function setKeys(fields: RawConnectionFields, keys: ConnectionKeyNames): string[] {
  const out: string[] = [];
  if (textOf(fields.provider) !== null) out.push(keys.provider);
  if (textOf(fields.baseUrl) !== null) out.push(keys.baseUrl);
  if (textOf(fields.apiKey) !== null) out.push(keys.apiKey);
  if (textOf(fields.model) !== null) out.push(keys.model);
  if (fields.params !== null && fields.params !== undefined && !(isPlainObject(fields.params) && Object.keys(fields.params).length === 0)) out.push(keys.params);
  return out;
}

/**
 * What a rollback to the previous version cannot express (it reads only the legacy keys and sends every role to the
 * legacy gateway): a role whose own keys change its connection — another address, provider, key, model or parameters, or
 * the role switched off — and a filled second embeddings connection. Pure over the settings; for the rollback
 * contract. The data policy adds two cases where the previous version — its name list
 * `models.t0_aliases` and its T1 switch `access.t1_providers`, every role on the legacy gateway — would send records wider
 * than the pairs allow now: a name of the list without its pair of the gateway address in `models.allow_closed`
 * (`trusted_name_without_pair`: closed records), and, with T1 open, a configured legacy model name whose gateway pair is in
 * neither list (`open_name_without_pair`: open records; also every name when the gateway address does not parse).
 */
export function rollbackConfigProblems(settings: ConnectionSettings): RollbackProblem[] {
  const out: RollbackProblem[] = [];
  for (const role of ROLL_ROLES) {
    const keys = connectionKeys(role);
    const own = ownFields(settings, role);
    const set = setKeys(own, keys);
    if (!set.length) continue;
    const legacy = legacyFields(settings, role);
    const now = buildConnection(role, own, legacy, { keys });
    const before = buildConnection(role, EMPTY_FIELDS, legacy, { keys });
    if (stateShape(now) === stateShape(before) && sameKey(now, before)) continue;
    out.push({ code: "role_own_connection", role, keys: set,
               message: `${role}: the role has its own connection (${set.join(", ")}); the previous version reads only the legacy gateway keys, so after a rollback this role would use the legacy gateway or stop working` });
  }
  const b = connectionKeys("embeddings", "b");
  const setB = setKeys(ownFields(settings, "embeddings", "b"), b);
  if (setB.length)
    out.push({ code: "second_embeddings_slot", role: "embeddings", keys: setB,
               message: `embeddings: the second embeddings connection is set (${setB.join(", ")}); the previous version has no second connection and ignores it` });
  out.push(...policyRollbackProblems(settings));
  return out;
}

/** The two rollback cases of the data policy (see rollbackConfigProblems). Names of keys only, never a model name or value. */
function policyRollbackProblems(settings: ConnectionSettings): RollbackProblem[] {
  const out: RollbackProblem[] = [];
  // without a gateway address the previous version sends nothing at all
  const gwRaw = textOf(legacyFields(settings, "chat").baseUrl);
  if (typeof gwRaw !== "string") return out;
  const listed = settings.get<unknown>("models.t0_aliases", []);
  const names = Array.isArray(listed) ? [...new Set(listed.filter((x): x is string => typeof x === "string" && x !== "" && x !== POLICY_ANY_MODEL))] : [];
  const projected = new Set(legacyT0Projection(settings));
  const untrusted = names.filter((n) => !projected.has(n)).length;
  if (untrusted)
    out.push({ code: "trusted_name_without_pair", role: null, keys: ["models.t0_aliases", "models.allow_closed"],
               message: `${untrusted} of the names in models.t0_aliases have no pair of the gateway address (models.gateway_base_url) in models.allow_closed; after a rollback the previous version would send closed records to them` });
  const t1 = settings.get<unknown>("access.t1_providers", []);
  if (!Array.isArray(t1) || t1.length === 0) return out;
  const gw = parseBaseUrl(gwRaw);
  for (const role of ROLL_ROLES) {
    const key = LEGACY_MODEL_KEY[role];
    const raw = textOf(legacyFields(settings, role).model);
    const model = typeof raw === "string" ? raw : null;
    // no chat model: the previous version sends open records under its built-in chat name, which no pair here can name
    if (model === null && role === "chat") {
      out.push({ code: "open_name_without_pair", role, keys: [key, "access.t1_providers", "models.allow_open"],
                 message: `chat: access.t1_providers is not empty and ${key} is not set; after a rollback the previous version would send open records to its built-in chat model name, which no pair in models.allow_open can be checked against — set ${key}` });
      continue;
    }
    if (model === null) continue;
    const allowed = !("problem" in gw) && dataPolicy(settings, { baseUrl: gw.baseUrl, model }).open;
    if (!allowed)
      out.push({ code: "open_name_without_pair", role, keys: [key, "access.t1_providers", "models.allow_open"],
                 message: `${role}: access.t1_providers is not empty and the model name in ${key} has no pair of the gateway address in models.allow_open or models.allow_closed; after a rollback the previous version would send open records to it` });
  }
  return out;
}

/**
 * The opposite direction: back on this version after a rollback (the rollback contract). The pairs were
 * migrated once and are not rebuilt from the name list, so a name removed from `models.t0_aliases` while the previous version
 * ran — the only way to revoke trust there — still has its pair of the gateway address in `models.allow_closed`, and that
 * pair keeps receiving closed records. Reported, not fixed: the pairs are the permission of this version, and the name list
 * is not written back from them (`legacyT0Projection`), so a pair added here is reported too — the administrator reads the
 * list and removes what the previous version revoked. Code `pair_without_trusted_name`: entries of `models.allow_closed` at
 * the legacy gateway address whose model (or `*`) is not in a non-empty `models.t0_aliases`. An empty list or no parsable
 * gateway address — nothing to compare with, nothing is reported (a list emptied in the previous version is not seen).
 * Names of keys only, never a model name, an address or a value.
 */
export function upgradeAfterRollbackProblems(settings: ConnectionSettings): RollbackProblem[] {
  const gwRaw = textOf(legacyFields(settings, "chat").baseUrl);
  if (typeof gwRaw !== "string") return [];
  const gw = parseBaseUrl(gwRaw);
  if ("problem" in gw) return [];
  const listed = settings.get<unknown>("models.t0_aliases", []);
  const names = new Set(Array.isArray(listed) ? listed.filter((x): x is string => typeof x === "string" && x !== "" && x !== POLICY_ANY_MODEL) : []);
  if (names.size === 0) return [];
  const sameAddress = (base: string): boolean => { const p = parseBaseUrl(base); return !("problem" in p) && p.baseUrl === gw.baseUrl; };
  const wider = policyPairs(settings).closed.filter((e) => sameAddress(e.base_url) && (e.model === POLICY_ANY_MODEL || !names.has(e.model))).length;
  if (!wider) return [];
  return [{ code: "pair_without_trusted_name", role: null, keys: ["models.allow_closed", "models.t0_aliases"],
            message: `${wider} of the pairs of the gateway address (models.gateway_base_url) in models.allow_closed have no name in models.t0_aliases; if the name was removed there while the previous version ran, remove the pair from models.allow_closed too: until then it keeps receiving closed records` }];
}
