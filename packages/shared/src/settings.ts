import { commitOrThrow } from "./db.ts";   // a COMMIT answered with ROLLBACK is an error
import type pg from "pg";
import { CONVERTER_FAST_PROFILE } from "./converter.ts";
import { CONVERTER_HOLDS_VALUES } from "./converter-gate.ts";
import { CONVERTER_DEDUP_VALUES, conversionFaultProblems } from "./converter-fault.ts";
import { CONVERTER_FORMATS_SETTING, converterFormatsProblem } from "./document-formats.ts";
import { decryptWithKey, encryptWithKey, ENC_KID, settingsKeyring, type EncryptedValue, type SettingsKeyring } from "./crypto.ts";
import { log } from "./log.ts";
import { openCheckSettingProblems } from "./open-check.ts";
import { orgReviewSettingProblems } from "./org-review.ts";
import { morningNoteSettingProblems } from "./morning-note-settings.ts";
import { agentViewSettingProblems } from "./agent-view-settings.ts";
import { PROFILE_SETTING, profileSettingProblems } from "./profile-check.ts";
import { GUIDE_SETTING, spaceGuideSettingProblems } from "./space-guide.ts";
import { derivationSettingProblems } from "./derivation.ts";
import { exportSettingProblems } from "./export/settings.ts";
import { channelSettingProblems } from "./channel-settings.ts";
import { llmSettingProblems } from "./llm-state.ts";
import { DISK_GUARD_FAULT_SETTING, diskGuardFaultProblems, PER_MINUTE_SETTING, perMinuteProblems, UPLOAD_DAILY_SETTING, uploadDailyProblems } from "./upload-limits.ts";
import { nightCapSettingProblems } from "./night-cap.ts";
import { embeddingsConnectionProblems } from "./models/embeddings/settings-rules.ts";
import { RETRIEVAL_TUNING_SETTING, retrievalTuningProblems } from "./retrieval-tuning.ts";
import { SNIPPET_WINDOWS } from "@memory/mcp-core";
import { FTS_CONFIGS_SETTING, ftsConfigsSettingProblem } from "./fts-config.ts";
import { LEGACY_CHARSET_INVALID, LEGACY_CHARSETS, legacyCharsetOrNull } from "./record-text.ts";
import { AUTHOR_RULES } from "./visibility.ts";
import { MCP_LANGUAGE_SETTING, MCP_LANGUAGES } from "./mcp-language.ts";
import { AUDIT_OPEN_READS, AUDIT_OPEN_READS_SETTING } from "./audit-outbox.ts";
import { AUDIT_ARCHIVE_KEEP_MONTHS, AUDIT_ARCHIVE_KEEP_SETTING, AUDIT_ARCHIVE_MODE_SETTING, AUDIT_ARCHIVE_MODES, AUDIT_RETENTION_MONTHS, AUDIT_RETENTION_SETTING } from "./audit-archive.ts";
import { INSTRUCTION_MARKING_SETTING, INSTRUCTION_MARKINGS } from "./instruction-marking.ts";
import { MCP_OUTPUT_SCHEMA_MODES, MCP_OUTPUT_SCHEMAS_SETTING } from "./mcp-served.ts";
import { MCP_TOOLS_PROFILE_SETTING, MCP_TOOLS_PROFILES } from "./mcp-profile.ts";
import { MCP_RESPONSE_DETAIL_SETTING, MCP_RESPONSE_DETAILS } from "./mcp-detail.ts";
import { tzValid } from "./zoned-time.ts";
import { edgeSettingProblems, runCrossChecks, RUN_MODE_USER, type SettingProblem } from "./edge-settings.ts";
import { adminSettingProblems } from "./admin-settings.ts";
import { agentAuthSettingProblems } from "./agent-auth.ts";
import { connectionSettingProblems } from "./models/connection.ts";
import { geminiModelNameProblem } from "./models/names.ts";
import { modelParamsProblems } from "./models/capabilities.ts";
import { policySettingProblems } from "./models/policy.ts";
import { usageSettingProblems } from "./models/usage.ts";
import { connectorSettingProblems } from "./connector-settings.ts";
import type { SettingsCategory } from "./enums.gen.ts";
import { invalid, MemoryError } from "./errors.ts";
import { oauthConfig, oauthProblems, type OAuthConfig } from "./oauth.ts";
import { CLOUD_AGENT_BASE_SETTING, cloudAgentBaseProblem } from "./agent-address.ts";
import { CUSTODY_AFTER_DAYS, CUSTODY_MEETINGS, CUSTODY_PERSONAL, CUSTODY_READ } from "./custody.ts";
import { LDAP_FAILURE_WINDOW_MINUTES, LDAP_GROUP_STALE_HOURS } from "./ldap.ts";
import { canonicalJson, PIN_FAIL_CLOSED, pinFailClosedValue, pinKindFor, pinMatches } from "./settings-policy.ts";
import { ADVANCED_LAYER, EXTERNAL_GATE_WOULD_BREAK, modeOf, SECURITY_MODE_SETTING, securityModeFloor, setSecurityModeDbFloor, stricterMode, type SecurityMode } from "./security-mode.ts";

export type Category = SettingsCategory;
export interface SettingRow { category: Category; key: string; value: unknown; secret: boolean; required: boolean; description: string | null; isSet: boolean; defaultValue: unknown; undecryptable: boolean }

const TTL_MS = 60_000;
const FAILED_RETRY_MS = 5_000;
export const TEST_LEFTOVERS_SCOPES = ["off", "org", "all"] as const;
export const TEST_PURGE_MODES = ["off", "auto"] as const;
/** access.promote_confirmation: human — an agent's move to a team, a project or the organisation waits for a person; off — as before. */
export const PROMOTE_CONFIRMATION_MODES = ["human", "off"] as const;
/** access.agent_member_add: workplace — an agent's key does not add space members; allow — as before. */
export const AGENT_MEMBER_ADD_MODES = ["workplace", "allow"] as const;
export const IMMUTABLE_SETTINGS: ReadonlySet<string> = new Set(["access.link_signing_key"]);
const IMMUTABLE = IMMUTABLE_SETTINGS;
/**
 * The sampling profile (models.wire_fragment) goes into the request body of the legacy gateway as it is, so it may hold
 * only token-selection parameters: everything else (model, messages, max_tokens, seed, stream, response_format, tools, …)
 * is set by the code and cannot be replaced by a setting.
 * `chat_template_kwargs` (a vLLM field) is accepted too. Inside it only
 * `enable_thinking` as a boolean is allowed: other chat-template arguments (the template itself, tools, documents, …) would
 * change what the model sees past the code.
 */
const WIRE_FRAGMENT_ALLOWED = new Set(["temperature", "top_p", "presence_penalty", "frequency_penalty", "repetition_penalty", "top_k", "min_p", "stop", "chat_template_kwargs"]);
const WIRE_TEMPLATE_KWARGS_ALLOWED = new Map<string, string>([["enable_thinking", "boolean"]]);

const jsonType = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
/**
 * Type the panel needs for a key whose seed default is NULL on purpose (listMasked): access.internal_networks is unset on a
 * fresh database and takes the default of the deploy profile, but the panel still edits it as a list.
 */
const UNSET_TYPES: Readonly<Record<string, string>> = { "access.internal_networks": "array" };
const isPlainObject = (v: unknown): v is Record<string, unknown> => jsonType(v) === "object";

/**
 * Settings whose stored object Settings.get returns whole — never merged with the seed default or the caller's fallback
 * (an object of another JSON type than the default still gives the default). oauth.allowed_clients: a removed client ID
 * must not come back from the seed. agent_auth.dcr_limits: dcr_limits.per_day_trusted counts only when
 * it is stored — the seed's 100 merged into a value saved before the field (or written without it) would replace the half
 * of its own per_day; agentAuthConfig fills the absent fields from DCR_LIMITS_DEFAULT (equal to the seed by test) and the
 * absent share as floor(per_day / 2). futureSettings (gateway policy-step.ts) and the settings registry
 * tools read these keys the same way; a unit test compares them.
 * models.embeddings_params and models.embeddings_b_params: overrides of the embedder profile — a removed override
 * must not come back from the seed.
 * models.chat_params, models.rerank_params: capability overrides of a model connection — a field removed by the
 * administrator must not come back from the seed default.
 */
export const SETTINGS_READ_WHOLE: ReadonlySet<string> = new Set(["oauth.allowed_clients", "agent_auth.dcr_limits", "models.embeddings_params", "models.embeddings_b_params",
  "models.chat_params", "models.rerank_params"]);

export const SECRET_MASK = "••••••";
export const SECRET_MAX_CHARS = 4096;
const SECRET_PLACEHOLDERS = new Set([SECRET_MASK, "set — leave blank to keep it", "set — leave blank to keep it", "set, keep unchanged", "set, leave unchanged", "set"]);
export const isSecretPlaceholder = (v: string): boolean => SECRET_PLACEHOLDERS.has(v.trim()) || /^[•●]+$/.test(v.trim());

export const CORRECT_NON_PARTICIPANT = ["proposed", "deny"] as const;

export const SUPPORT_CONTACT_SETTING = "access.support_contact";
export const SUPPORT_CONTACT_MAX = 300;
export const supportContactProblem = (v: string): string | null =>
  v.length > SUPPORT_CONTACT_MAX ? `up to ${SUPPORT_CONTACT_MAX} characters` : /[\u0000-\u001f\u007f]/.test(v) ? "one line with no line breaks or control characters" : null;
export const supportContactOf = (v: unknown): string | null =>
  typeof v === "string" && v.trim() && !supportContactProblem(v.trim()) ? v.trim() : null;

/**
 * The form of a locale.timezone value: an Area/Location name, Etc/GMT±N or UTC — names PostgreSQL's AT TIME ZONE
 * and Intl read alike. PostgreSQL reads an abbreviation-like name (CET, EST, IST, PST…) as a fixed abbreviation offset or
 * does not know it, and a bare offset with the opposite sign. The seed (04-seed.sql) pins only names of this form.
 */
export const LOCALE_TIMEZONE_FORM = new RegExp("^((Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific)/[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)*|Etc/GMT[+-][0-9]{1,2}|UTC)$");

export class SettingsTypeError extends Error {}

/** Validate the stored shape before defaults can hide a misspelt lookup switch. Null resets the setting. */
function validateEntityLinking(value: unknown): void {
  const path = "processing.entity_linking";
  if (value === null || value === undefined) return;
  if (!isPlainObject(value)) throw new SettingsTypeError(`${path}: expected an object`);
  for (const [key, v] of Object.entries(value)) {
    if (key === "external_lookup") {
      if (v !== null && typeof v !== "boolean") throw new SettingsTypeError(`${path}.${key}: expected a boolean or null`);
    } else if (key === "max_lookups_per_record") {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 100)
        throw new SettingsTypeError(`${path}.${key}: expected an integer from 0 to 100`);
    } else throw new SettingsTypeError(`${path}.${key}: unknown key`);
  }
}

export function runModeConflict(e: unknown, path: string): MemoryError | null {
  const err = e as { code?: string; constraint?: string };
  if (err?.code !== "23514" || err.constraint !== "settings_run_mode") return null;
  const message = `Settings were not saved: ${path} enables a service that is running in user mode or has been unresponsive for a long time`;
  return new MemoryError("conflict", message, { reason: RUN_MODE_USER, details: { problems: [{ key: path, code: RUN_MODE_USER, message }] } });
}

export function embeddingsModelChangeProblem(o: { next: unknown; current: string | null; remembered: string | null; hasVectors: boolean; embedder: string; activeSlot?: "a" | "b" | null }): string | null {
  const allowed = o.remembered ?? o.current;
  if (!o.hasVectors || !allowed || o.next === allowed) return null;
  return `retrieval.embeddings_model: the admin panel cannot change the semantic search model while records prepared by the “${allowed}” model remain `
    + `(embedder ${o.embedder}). A different model would find those records less reliably. You can save only “${allowed}”. ${EMBEDDINGS_MODEL_SWITCH_DENIED}: `
    + `configure the new model in another embedder connection (${nextModelKeys(o.activeSlot)}). Records are prepared again in the background, and search switches when the new vectors are ready`;
}

/** The keys of the embeddings connection that does NOT hold the active row: where the next model goes. */
export function nextModelKeys(activeSlot: "a" | "b" | null | undefined): string {
  return activeSlot === "b" ? "models.embeddings_*" : "models.embeddings_b_*";
}

export const EMBEDDINGS_MODEL_SWITCH_DENIED = "The semantic search model changes only with a new embedder and recalculated vectors";

export function embeddingsModelValueProblem(value: unknown): string | null {
  return typeof value === "string" && value !== value.trim() ? "retrieval.embeddings_model: remove leading and trailing spaces from the model name" : null;
}

export interface PinSpec {
  pins: Readonly<Record<string, { value: unknown } | { hmac: string }>>;
  anchored: readonly string[];
  onProblems?: (problems: PinProblem[]) => void;
}
export interface PinProblem { key: string; code: "pin_mismatch" | "unpinned" | "pin_kind" | "pin_not_anchored" }
export interface PinState { kind: "value" | "hmac" | "none"; ok: boolean; dbDiffers: boolean }

export class Settings {
  private rows = new Map<string, SettingRow>();
  private view = this.rows;
  private pinSpec: PinSpec | null = null;
  private pinStates = new Map<string, PinState>();
  private pinProblemsKey = "";
  private loadedAt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private parent: Settings | null = null;
  private failedRead: "rows" | "mode" | null = null;
  private failedAt = 0;
  private started = 0;
  private applied = 0;

  private readonly keyring: SettingsKeyring;

  constructor(private readonly control: Pick<pg.Pool, "query">, private readonly instanceId: string, private readonly appSecret: string,
              keyring?: SettingsKeyring) {
    this.keyring = keyring ?? settingsKeyring({ appSecret });
  }

  withDatabase(control: Pick<pg.Pool, "query">): Settings {
    const s = new Settings(control, this.instanceId, this.appSecret, this.keyring);
    if (this.pinSpec) s.pinSpec = { pins: this.pinSpec.pins, anchored: this.pinSpec.anchored };
    s.parent = this.parent ?? this;
    return s;
  }

  applyPins(spec: PinSpec | null): void {
    this.pinSpec = spec;
    this.pinProblemsKey = "";
    this.recomputePins();
  }

  pinsActive(): boolean { return this.pinSpec !== null; }

  pinState(path: string): PinState | null { return this.pinStates.get(path) ?? null; }

  rawValue(path: string): unknown { return this.rows.get(path)?.value ?? null; }

  meta(path: string): { exists: boolean; secret: boolean; required: boolean; defaultValue: unknown } {
    const r = this.rows.get(path);
    return { exists: !!r, secret: r?.secret ?? false, required: r?.required ?? false, defaultValue: r?.defaultValue ?? null };
  }

  securityMode(): SecurityMode {
    return stricterMode(stricterMode(this.securityModeSetting(), securityModeFloor()), this.failedRead ? "advanced" : null);
  }

  readFailed(): boolean { return this.failedRead !== null; }

  securityModeSetting(): SecurityMode {
    const row = this.rows.get(SECURITY_MODE_SETTING);
    return row ? modeOf(row.value ?? row.defaultValue ?? null) : this.modeWithoutRow;
  }
  private modeWithoutRow: SecurityMode = "basic";

  private applyModeLayer(view: Map<string, SettingRow>): Map<string, SettingRow> {
    if (this.securityMode() !== "advanced") return view;
    const out = view === this.rows ? new Map(this.rows) : view;
    for (const [path, strict] of Object.entries(ADVANCED_LAYER)) {
      const row = out.get(path);
      if (!row) {
        const dot = path.indexOf(".");
        out.set(path, { category: path.slice(0, dot) as Category, key: path.slice(dot + 1), value: strict(null), secret: false, required: false, description: null,
                        isSet: true, defaultValue: null, undecryptable: false });
        continue;
      }
      const v = strict(row.isSet ? row.value : row.defaultValue);
      out.set(path, { ...row, value: v, isSet: true, undecryptable: false });
    }
    return out;
  }

  private recomputePins(): void {
    const spec = this.pinSpec;
    this.pinStates = new Map();
    if (!spec) { this.view = this.applyModeLayer(this.rows); return; }
    const view = new Map(this.rows);
    const problems: PinProblem[] = [];
    const anchored = new Set(spec.anchored);
    for (const path of Object.keys(spec.pins)) if (!anchored.has(path)) problems.push({ key: path, code: "pin_not_anchored" });
    for (const path of spec.anchored) {
      const row = this.rows.get(path);
      if (!row) continue;
      const pin = spec.pins[path];
      const unset = () => view.set(path, { ...row, value: null, isSet: false });
      if (!pin) {
        unset();
        this.pinStates.set(path, { kind: "none", ok: false, dbDiffers: false });
        problems.push({ key: path, code: "unpinned" });
      } else if ("value" in pin) {
        if (pinKindFor(path, row.secret) === "hmac") {
          unset();
          this.pinStates.set(path, { kind: "value", ok: false, dbDiffers: false });
          problems.push({ key: path, code: "pin_kind" });
          continue;
        }
        view.set(path, { ...row, value: pin.value, isSet: pin.value !== null && pin.value !== "", undecryptable: false });
        this.pinStates.set(path, { kind: "value", ok: true, dbDiffers: canonicalJson(row.value) !== canonicalJson(pin.value) });
      } else {
        const ok = !row.undecryptable && pinMatches(this.appSecret, path, row.value, pin.hmac);
        if (!ok) { unset(); problems.push({ key: path, code: "pin_mismatch" }); }
        this.pinStates.set(path, { kind: "hmac", ok, dbDiffers: !ok });
      }
    }
    for (const [path, target] of Object.entries(PIN_FAIL_CLOSED)) {
      const st = this.pinStates.get(path), row = this.rows.get(target);
      if (st && !st.ok && row) view.set(target, { ...row, value: pinFailClosedValue(target), isSet: true, undecryptable: false });
    }
    this.view = this.applyModeLayer(view);
    const key = problems.map((p) => `${p.code}:${p.key}`).sort().join(",");
    if (key !== this.pinProblemsKey) {
      this.pinProblemsKey = key;
      try { spec.onProblems?.(problems); } catch (e) { log.warn("settings_pins_callback_failed", { error: (e as Error).message.slice(0, 200) }); }
    }
  }

  async load(force = false): Promise<void> {
    const readStartedAt = Date.now();
    if (!force && readStartedAt - this.loadedAt < TTL_MS) return;
    const n = ++this.started;
    let rows: any[];
    try {
      ({ rows } = await this.control.query(
        "SELECT category, key, value, secret, enc_kid, required, description, default_value FROM settings WHERE instance_id = $1", [this.instanceId]));
    } catch (e) {
      if (n >= this.applied) {
        this.failedRead = "rows";
        this.failedAt = Math.max(this.failedAt, n);
        log.warn("settings_read_failed", { retry_ms: FAILED_RETRY_MS, error: ((e as Error)?.message ?? "").slice(0, 160) });
        this.scheduleRetry();
        this.recomputePins();
        this.parent?.childReadFailed("rows");
      }
      throw e;
    }
    const next = new Map<string, SettingRow>();
    for (const r of rows) {
      let value: unknown = r.value, undecryptable = false;
      if (r.secret && r.value !== null) {
        const key = this.keyring.byKid(r.enc_kid ?? ENC_KID);
        try {
          if (!key) throw new Error("key is missing");
          value = decryptWithKey(key, r.value as EncryptedValue);
        } catch { value = null; undecryptable = true; }
      }
      next.set(`${r.category}.${r.key}`, { category: r.category, key: r.key, value, secret: r.secret, required: r.required, description: r.description,
                                            isSet: value !== null && value !== "", defaultValue: r.default_value ?? null, undecryptable });
    }
    let failed = false;
    const strict = (e?: unknown): "error" => {
      if (this.parent) {
        this.failedRead = "mode"; setSecurityModeDbFloor("advanced", null); this.parent.childReadFailed("mode"); throw e;
      }
      failed = true; return "error";
    };
    let modeWithoutRow: SecurityMode = "basic";
    if (!next.has(SECURITY_MODE_SETTING) && [...next.keys()].some((k) => k.startsWith("security."))) {
      const has = await this.control.query("SELECT to_regprocedure('security_mode(text)') IS NOT NULL AS ok")
        .then((r) => (r.rows[0] as { ok?: unknown } | undefined)?.ok === true, strict);
      if (has === "error") modeWithoutRow = "advanced";
      else if (has)
        modeWithoutRow = await this.control.query("SELECT security_mode($1) AS m", [this.instanceId])
          .then((r) => modeOf((r.rows[0] as { m?: unknown } | undefined)?.m ?? null), (e: unknown) => { strict(e); return "advanced" as SecurityMode; });
    }
    let dbFloor: { floor: SecurityMode | null; serial: number | null } | null = null;
    if ([...next.keys()].some((k) => k.startsWith("security."))) {
      const has = await this.control.query("SELECT to_regprocedure('security_mode_floor(text)') IS NOT NULL AS ok")
        .then((r) => (r.rows[0] as { ok?: unknown } | undefined)?.ok === true, strict);
      if (has === "error") dbFloor = { floor: "advanced", serial: null };
      else if (has)
        dbFloor = await this.control.query(
          "SELECT security_mode_floor($1) AS f, (SELECT max(a.serial) FROM anchors_applied a WHERE a.instance_id = $1 AND a.kind = 'inner') AS s", [this.instanceId])
          .then((r) => { const row = r.rows[0] as { f?: unknown; s?: unknown } | undefined;
                         return { floor: row?.f === "advanced" ? "advanced" as const : null, serial: row?.s === null || row?.s === undefined ? null : Number(row.s) }; },
                (e: unknown) => { strict(e); return { floor: "advanced" as const, serial: null }; });
    }
    if (n < this.applied) return;
    if (dbFloor) setSecurityModeDbFloor(dbFloor.floor, dbFloor.serial);
    if (failed) log.warn("settings_security_mode_read_failed", { retry_ms: FAILED_RETRY_MS });
    this.modeWithoutRow = modeWithoutRow;
    this.rows = next;
    // Start the cache lifetime with the first read; later forced refreshes must not defer minute polling.
    // Query time must not extend the cache lifetime past the next minute tick.
    if (!force || this.applied === 0) this.loadedAt = readStartedAt;
    this.applied = n;
    if (failed) { this.failedRead = "mode"; this.failedAt = Math.max(this.failedAt, n); }
    else if (n > this.failedAt) this.failedRead = null;
    if (this.failedRead) this.scheduleRetry();
    this.recomputePins();
    if (this.parent) {
      if (failed) this.parent.childReadFailed("mode");
      else if (dbFloor) this.parent.recomputePins();
    }
  }

  private childReadFailed(kind: "rows" | "mode"): void {
    if (this.parent) { this.parent.childReadFailed(kind); return; }
    this.failedRead ??= kind;
    this.failedAt = Math.max(this.failedAt, this.started);
    log.warn("settings_tx_read_failed", { what: kind, retry_ms: FAILED_RETRY_MS });
    this.scheduleRetry();
    this.recomputePins();
  }

  private scheduleRetry(): void {
    if (this.parent) { this.parent.scheduleRetry(); return; }
    this.loadedAt = Math.min(this.loadedAt, Date.now() - TTL_MS + FAILED_RETRY_MS);
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.load(true).catch((e: unknown) => log.warn("settings_security_mode_retry_failed", { error: ((e as Error)?.message ?? "").slice(0, 160) }));
    }, FAILED_RETRY_MS);
    this.retryTimer.unref?.();
  }

  get<T>(path: string, fallback: T): T {
    const row = this.view.get(path);
    if (!row || !row.isSet) return fallback;
    const ref = row.defaultValue ?? fallback;
    if (ref !== null && ref !== undefined && jsonType(ref) !== jsonType(row.value)) {
      log.warn("setting_type_mismatch", { key: path, expected: jsonType(ref), got: jsonType(row.value) });
      return (row.defaultValue ?? fallback) as T;
    }
    // the stored object whole, never merged with the seed or the fallback (SETTINGS_READ_WHOLE: oauth.allowed_clients,
    // agent_auth.dcr_limits)
    if (SETTINGS_READ_WHOLE.has(path)) return row.value as T;
    if (isPlainObject(row.value) && isPlainObject(ref)) {
      const seed = isPlainObject(row.defaultValue) ? row.defaultValue : {};
      return { ...(fallback as object), ...seed, ...row.value } as T;
    }
    return row.value as T;
  }

  str(path: string): string | null { return this.get<string | null>(path, null); }

  missingRequired(): string[] {
    return [...this.view.entries()].filter(([, r]) => r.required && !r.isSet).map(([k]) => k).sort();
  }

  undecryptable(): string[] {
    return [...this.rows.entries()].filter(([, r]) => r.undecryptable).map(([k]) => k).sort();
  }

  listMasked(): Array<Omit<SettingRow, "value" | "undecryptable"> & { value: unknown; type: string; pinned?: boolean; db_differs?: boolean }> {
    return [...this.view.values()].map(({ undecryptable: _u, ...r }) => {
      const pin = this.pinStates.get(`${r.category}.${r.key}`);
      const type = jsonType(r.defaultValue ?? r.value);
      return { ...r, value: r.secret ? (r.isSet ? SECRET_MASK : null) : r.value, type: type === "null" ? (UNSET_TYPES[`${r.category}.${r.key}`] ?? type) : type,
               ...(pin ? { pinned: pin.kind !== "none", db_differs: pin.dbDiffers } : {}) };
    }).sort((a, b) => (a.category + a.key).localeCompare(b.category + b.key));
  }

  async set(category: Category, key: string, value: unknown, updatedBy: string | null, futureOAuth?: OAuthConfig): Promise<boolean> {
    const path = `${category}.${key}`, row = this.rows.get(path);
    if (!row) return false;
    this.validate(category, key, value, futureOAuth);
    await this.write(this.control, row, value, updatedBy);
    await this.load(true);
    return true;
  }

  private async write(q: Pick<pg.Pool, "query">, row: SettingRow, value: unknown, updatedBy: string | null): Promise<void> {
    const { kid, key } = this.keyring.current;
    const stored = value === null ? null : row.secret ? encryptWithKey(key, value) : value;
    await q.query(
      "UPDATE settings SET value = $4::jsonb, enc_kid = $5, updated_by = $6, updated_at = now() WHERE instance_id = $1 AND category = $2 AND key = $3",
      [this.instanceId, row.category, row.key, stored === null ? null : JSON.stringify(stored), row.secret && stored !== null ? kid : null, updatedBy])
      .catch((e: unknown) => { throw runModeConflict(e, `${row.category}.${row.key}`) ?? e; });
  }

  async setMany(items: ReadonlyArray<{ category: Category; key: string; value: unknown }>,
                o: { updatedBy?: string | null; approvalId?: string | null; futureOAuth?: OAuthConfig } = {}): Promise<void> {
    const rows = items.map((it) => {
      const row = this.rows.get(`${it.category}.${it.key}`);
      if (!row || !this.validate(it.category, it.key, it.value ?? null, o.futureOAuth)) throw new SettingsTypeError(`${it.category}.${it.key}: this setting does not exist`);
      return { row, value: it.value ?? null };
    });
    if (o.approvalId !== undefined && o.approvalId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(o.approvalId))
      throw new SettingsTypeError("approvalId must be a request ID (uuid)");
    const run = async (q: Pick<pg.Pool, "query">) => {
      if (o.approvalId) await q.query("SELECT set_config('memory.approval_id', $1, true)", [o.approvalId]);
      for (const x of rows) await this.write(q, x.row, x.value, o.updatedBy ?? null);
    };
    const c = this.control as Partial<pg.Pool> & Partial<pg.PoolClient>;
    if (typeof c.connect === "function" && typeof c.release !== "function") {
      const client = await (this.control as pg.Pool).connect();
      try {
        await client.query("BEGIN");
        await run(client);
        await commitOrThrow(client);
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally { client.release(); }
    } else await run(this.control);
    await this.load(true);
  }

  async validateBatch(future: (path: string) => unknown, ctx: { db: Pick<pg.Pool, "query">; instanceId: string; changed?: ReadonlySet<string> }): Promise<SettingProblem[]> {
    if (!ctx.changed || ctx.changed.has("processing.entity_linking")) validateEntityLinking(future("processing.entity_linking"));
    const eff = (path: string, v: unknown): unknown => (v === null || v === undefined ? this.rows.get(path)?.defaultValue ?? null : v);
    return runCrossChecks({ db: ctx.db, instanceId: ctx.instanceId, future: (path) => eff(path, future(path)), current: (path) => eff(path, this.get<unknown>(path, null)),
                            changed: ctx.changed ?? new Set() });
  }

  effective(path: string): unknown {
    const v = this.get<unknown>(path, null);
    return v === null || v === undefined ? this.rows.get(path)?.defaultValue ?? null : v;
  }

  async assertBatch(items: ReadonlyArray<{ category: string; key: string; value?: unknown }>, ctx: { db: Pick<pg.Pool, "query">; instanceId: string }): Promise<void> {
    const next = new Map<string, unknown>(items.map((i) => [`${i.category}.${i.key}`, i.value ?? null]));
    const problems = await this.validateBatch((path) => (next.has(path) ? next.get(path) : this.get<unknown>(path, null)), { ...ctx, changed: new Set(next.keys()) });
    if (!problems.length) return;
    const message = `Settings were not saved: ${problems.map((p) => `${p.key} — ${p.message}`).join("; ")}`;
    const details = { problems: problems.map(({ key, code, message: m }) => ({ key, code, message: m })) };
    if (problems.some((p) => p.code === RUN_MODE_USER)) throw new MemoryError("conflict", message, { reason: RUN_MODE_USER, details });
    if (problems.every((p) => p.code === EXTERNAL_GATE_WOULD_BREAK)) throw new MemoryError("conflict", message, { reason: EXTERNAL_GATE_WOULD_BREAK, details });
    throw invalid(message, details);
  }

  validate(category: Category, key: string, value: unknown, futureOAuth?: OAuthConfig): boolean {
    const path = `${category}.${key}`, row = this.rows.get(path);
    if (!row) return false;
    if (IMMUTABLE.has(path) && (row.isSet || row.undecryptable)) throw new SettingsTypeError(`${path} cannot be changed through the API`);
    if (value !== null && row.defaultValue !== null && row.defaultValue !== undefined && jsonType(row.defaultValue) !== jsonType(value))
      throw new SettingsTypeError(`${path}: expected ${jsonType(row.defaultValue)}, got ${jsonType(value)}`);
    if (value !== null && row.secret && typeof value !== "string") throw new SettingsTypeError(`${path}: the secret must be a string`);
    if (row.secret && typeof value === "string") {
      if (isSecretPlaceholder(value)) throw new SettingsTypeError(`${path}: this is a mask for the secret on file. Enter the actual value or leave the field unchanged`);
      if (value.length > SECRET_MAX_CHARS) throw new SettingsTypeError(`${path}: the secret exceeds ${SECRET_MAX_CHARS} characters. Check the pasted value`);
    }
    if (path === "processing.entity_linking") validateEntityLinking(value);
    if (path === "models.wire_fragment" && value !== null) {
      const extra = Object.keys(value as Record<string, unknown>).filter((k) => !WIRE_FRAGMENT_ALLOWED.has(k));
      const kwargs = (value as Record<string, unknown>).chat_template_kwargs;
      if (kwargs !== undefined) {
        if (!isPlainObject(kwargs)) extra.push("chat_template_kwargs (expected an object)");
        else extra.push(...Object.keys(kwargs).filter((k) => WIRE_TEMPLATE_KWARGS_ALLOWED.get(k) !== jsonType(kwargs[k])).map((k) => `chat_template_kwargs.${k}`));
      }
      if (extra.length) throw new SettingsTypeError(`${path}: only sampling parameters are allowed (${[...WIRE_FRAGMENT_ALLOWED].join(", ")}; in chat_template_kwargs — ${[...WIRE_TEMPLATE_KWARGS_ALLOWED].map(([k, t]) => `${k}: ${t}`).join(", ")}); unexpected: ${extra.join(", ")}`);
    }
    if (category === "processing" && value !== null) {
      const merged = isPlainObject(value) ? { ...(isPlainObject(row.defaultValue) ? row.defaultValue : {}), ...value } : value;
      const problems = llmSettingProblems(key, merged);
      if (problems?.length) throw new SettingsTypeError(problems.join("; "));
    }
    { const problems = nightCapSettingProblems(path, value); if (problems.length) throw new SettingsTypeError(`${path}: ${problems.join("; ")}`); }
    if (category === "open_check") {
      const problems = openCheckSettingProblems(key, value);
      if (problems.length) throw new SettingsTypeError(`${path}: ${problems.join("; ")}`);
    }
    if (category === "oauth") {
      const candidate = oauthConfig({ get: <T>(requested: string, fallback: T): T => requested === path ? (value ?? row.defaultValue ?? fallback) as T
        : futureOAuth && requested.startsWith("oauth.") ? (futureOAuth[requested.slice(6) as keyof OAuthConfig] ?? fallback) as T : this.get(requested, fallback) });
      const problems = oauthProblems(candidate);
      if (problems.length) throw new SettingsTypeError(`${path}: ${problems.map((p) => `${p.key}: ${p.message}`).join("; ")}`);
    }
    if (path === "retrieval.embeddings_model") { const p = embeddingsModelValueProblem(value); if (p) throw new SettingsTypeError(p); }
    // the two embeddings connections: provider, address, model name and profile overrides
    { const problems = embeddingsConnectionProblems(path, value); if (problems.length) throw new SettingsTypeError(`${path}: ${problems.join("; ")}`); }
    // search numbers: checked on the merged object (seed default with the value on top), as the search reads it
    if (path === RETRIEVAL_TUNING_SETTING && value !== null) {
      const merged = isPlainObject(value) ? { ...(isPlainObject(row.defaultValue) ? row.defaultValue : {}), ...value } : value;
      const problems = retrievalTuningProblems(merged);
      if (problems.length) throw new SettingsTypeError(`${path}: ${problems.join("; ")}`);
    }
    if (path === "retrieval.query_cache" && value !== null) {
      if (!isPlainObject(value)) throw new SettingsTypeError(`${path}: expected an object`);
      const merged = { size: 2000, ttl_sec: 600, ...(isPlainObject(row.defaultValue) ? row.defaultValue : {}), ...value };
      for (const key of Object.keys(value))
        if (key !== "size" && key !== "ttl_sec") throw new SettingsTypeError(`${path}: unknown field ${key}`);
      if (!Number.isSafeInteger(merged.size) || merged.size < 0) throw new SettingsTypeError(`${path}: size must be a non-negative integer`);
      if (!Number.isSafeInteger(merged.ttl_sec) || merged.ttl_sec < 1) throw new SettingsTypeError(`${path}: ttl_sec must be a positive integer`);
    }
    // model connections of chat and rerank: a provider of the role, an address by the model address rules, a model
    // name without spaces at the ends — a typo must not send a key to another address or a name the server does not know
    { const problems = connectionSettingProblems(path, value); if (problems.length) throw new SettingsTypeError(`${path}: ${problems.join("; ")}`); }
    if ((path === "storage.s3_endpoint" || path === "storage.s3_endpoint_closed") && typeof value === "string") {
      let url: URL | undefined;
      try { url = new URL(value); } catch { /* Ignore URL parse errors. */ }
      if (url?.hostname.toLowerCase().replace(/\.$/, "") === "s3.amazonaws.com") {
        throw new SettingsTypeError(`${path}: the global Amazon S3 name is not supported as a storage address — use the regional name of the bucket's region (s3.<region>.amazonaws.com) and set storage.s3_region to the same region`);
      }
    }
    // Gemini names become URL path segments. Check both model saves and a switch of provider, including legacy fallback.
    if (["models.chat_model", "models.llm_model", "models.chat_provider"].includes(path)) {
      const provider = path === "models.chat_provider" ? value : this.str("models.chat_provider");
      if (provider === "gemini") {
        const ownModel = path === "models.chat_model" ? value : this.str("models.chat_model");
        const legacyModel = path === "models.llm_model" ? value : this.str("models.llm_model");
        const model = path === "models.llm_model" ? value : ownModel || legacyModel;
        if (typeof model === "string" && model !== "") {
          const problem = geminiModelNameProblem(model);
          if (problem) throw new SettingsTypeError(`${path}: ${problem}`);
        }
      }
    }
    if (path === "models.chat_params" || path === "models.rerank_params") {
      const role = path === "models.chat_params" ? "chat" : "rerank";
      const provider = role === "chat" ? this.str("models.chat_provider") : this.str("models.rerank_provider");
      const problems = modelParamsProblems(role, provider ?? "", value);
      if (problems.length) throw new SettingsTypeError(`${path}: ${problems.join("; ")}`);
    }
    // data policy on the pair "base URL + model": only exact {base_url, model} pairs with an address by the model
    // address rules — an entry that does not parse would never match, so it would look like a permission that is not there
    { const problems = policySettingProblems(path, value); if (problems.length) throw new SettingsTypeError(`${path}: ${problems.join("; ")}`); }
    // usage and prices: a price entry that does not parse would silently leave its model unpriced
    { const problems = usageSettingProblems(path, value); if (problems.length) throw new SettingsTypeError(`${path}: ${problems.join("; ")}`); }
    const planRanges: Record<string, [number, number]> = { "access.plan_agent_max_items": [0, 2000], "access.plan_ttl_minutes": [1, 120], "limits.plan_max_items": [1, 2000],
                                                           // how long an agent's move request waits for the person: up to a week
                                                           "access.promote_confirmation_ttl_hours": [1, 168],
                                                           // read budget of memory_read without max_tokens, over MCP too:
                                                           // 0 or 0.5 would make every default read one character long; the bounds of max_tokens
                                                           "limits.read_default_tokens": [1000, 64000],
                                                           "limits.process_now_per_hour": [1, 1000], "limits.upload_max_bytes": [1024 * 1024, 20 * 1024 * 1024],
                                                           "limits.service_key_multiplier": [1, 100],
                                                           "open_check.recheck_batch": [10, 1000],
                                                           "access.test_leftovers_grace_minutes": [1, 10080],
                                                           "access.test_purge_after_hours": [1, 8760], "access.test_purge_max": [1, 100000],
                                                           "access.dismissed_retention_days": [0, 3650], "access.dismissed_custody_after_days": [CUSTODY_AFTER_DAYS[0], CUSTODY_AFTER_DAYS[1]],
                                                           "storage.backup_retention_days": [7, 3650],
                                                           "integrations.converter_result_max_bytes": [1024 * 1024, 1024 * 1024 * 1024],
                                                           "integrations.converter_text_max_bytes": [0, 512 * 1024 * 1024],
                                                           "integrations.converter_max_reruns": [0, 5],
                                                           "integrations.converter_window": [1, 8], "integrations.converter_run_deadline_hours": [9, 72],
                                                           "integrations.converter_accepted_suspect_min": [5, 720], "integrations.converter_accepted_rerun_min": [10, 1440],
                                                           "integrations.converter_ocr_rerun_delay_min": [1, 1440], "integrations.converter_doc_error_max": [1, 50],
                                                           "integrations.converter_patience_hours": [0, 720],
                                                           "ldap.failure_window_minutes": [LDAP_FAILURE_WINDOW_MINUTES.min, LDAP_FAILURE_WINDOW_MINUTES.max],
                                                           // expiry of directory-group membership without verification, 0 — never;
                                                           // the ratio to the sync period is ldapProblems' (it needs the whole section)
                                                           "ldap.group_stale_hours": [LDAP_GROUP_STALE_HOURS.min, LDAP_GROUP_STALE_HOURS.max],
                                                           // audit archive: the floor 3 is also enforced by audit_archive_drop in the database
                                                           [AUDIT_RETENTION_SETTING]: [AUDIT_RETENTION_MONTHS.min, AUDIT_RETENTION_MONTHS.max],
                                                           // archive retention: 0 keeps the archive forever
                                                           [AUDIT_ARCHIVE_KEEP_SETTING]: [AUDIT_ARCHIVE_KEEP_MONTHS.min, AUDIT_ARCHIVE_KEEP_MONTHS.max] };
    if (path in planRanges && value !== null) {
      const [min, max] = planRanges[path]!;
      if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new SettingsTypeError(`${path}: expected an integer from ${min} to ${max}`);
    }
    if (path === PER_MINUTE_SETTING && value !== null) {
      const problems = perMinuteProblems(value);
      if (problems.length) throw new SettingsTypeError(`${path}: ${problems.join("; ")}`);
    }
    if (path === UPLOAD_DAILY_SETTING && value !== null) {
      const merged = isPlainObject(value) ? { ...(isPlainObject(row.defaultValue) ? row.defaultValue : {}), ...value } : value;
      const problems = uploadDailyProblems(merged);
      if (problems.length) throw new SettingsTypeError(`${path}: ${problems.join("; ")}`);
    }
    if (path === DISK_GUARD_FAULT_SETTING && value !== null) {
      const problems = diskGuardFaultProblems(value);
      if (problems.length) throw new SettingsTypeError(`${path}: ${problems.join("; ")}`);
    }
    if (path === "access.mass_deactivation_share" && value !== null && !(typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1))
      throw new SettingsTypeError(`${path}: expected a proportion from 0 to 1 (0.2 is one fifth of active employees)`);
    { const problems = orgReviewSettingProblems(path, value); if (problems.length) throw new SettingsTypeError(`${path}: ${problems.join("; ")}`); }
    { const problems = morningNoteSettingProblems(path, value); if (problems.length) throw new SettingsTypeError(`${path}: ${problems.join("; ")}`); }
    { const problems = agentViewSettingProblems(path, value); if (problems.length) throw new SettingsTypeError(`${path}: ${problems.join("; ")}`); }
    if (path === PROFILE_SETTING && value !== null) {
      const merged = isPlainObject(value) ? { ...(isPlainObject(row.defaultValue) ? row.defaultValue : {}), ...value } : value;
      const problems = profileSettingProblems(path, merged);
      if (problems.length) throw new SettingsTypeError(`${path}: ${problems.join("; ")}`);
    }
    if (path === GUIDE_SETTING && value !== null) {
      const merged = isPlainObject(value) ? { ...(isPlainObject(row.defaultValue) ? row.defaultValue : {}), ...value } : value;
      const problems = spaceGuideSettingProblems(path, merged);
      if (problems.length) throw new SettingsTypeError(`${path}: ${problems.join("; ")}`);
    }
    { const problems = derivationSettingProblems(path, value); if (problems.length) throw new SettingsTypeError(`${path}: ${problems.join("; ")}`); }
    // space export: the switch, the role that may export, the daily limit — a typo must not widen who exports
    { const problems = exportSettingProblems(path, value); if (problems.length) throw new SettingsTypeError(`${path}: ${problems.join("; ")}`); }
    { const problems = channelSettingProblems(path, value); if (problems.length) throw new SettingsTypeError(`${path}: ${problems.join("; ")}`); }
    { const problems = edgeSettingProblems(path, value); if (problems.length) throw new SettingsTypeError(`${path}: ${problems.join("; ")}`); }
    { const problems = adminSettingProblems(path, value); if (problems.length) throw new SettingsTypeError(`${path}: ${problems.join("; ")}`); }
    // built-in agent sign-in (category agent_auth): mode, registry clients, document hosts, DCR switch and limits,
    // lifetimes. A typo must neither admit an app nor lock agents out silently; dcr_limits — on the merged object (seed
    // default with the value on top): an absent per_day_trusted is checked as the seed's share, stricter than the read
    // (agentAuthConfig takes the stored object whole and an absent share as floor(per_day / 2)), so
    // {per_day: 50} without the share is refused while the seed's share is 100
    if (category === "agent_auth" && value !== null) {
      const v = path === "agent_auth.dcr_limits" && isPlainObject(value) ? { ...(isPlainObject(row.defaultValue) ? row.defaultValue : {}), ...value } : value;
      const problems = agentAuthSettingProblems(path, v);
      if (problems.length) throw new SettingsTypeError(`${path}: ${problems.join("; ")}`);
    }
    if (path === "processing.events" && isPlainObject(value) && Object.hasOwn(value, "suppress_corrected") && typeof value.suppress_corrected !== "boolean")
      throw new SettingsTypeError(`${path}: suppress_corrected must be true or false (exclude model-generated events that a person corrected)`);
    if (path === "access.correct_non_participant" && value !== null && !(CORRECT_NON_PARTICIPANT as readonly unknown[]).includes(value))
      throw new SettingsTypeError(`${path}: allowed values are ${CORRECT_NON_PARTICIPANT.map((x) => `"${x}"`).join(" or ")}`);
    if (path === CLOUD_AGENT_BASE_SETTING && value !== null) {
      const problem = cloudAgentBaseProblem(value);
      if (problem) throw new SettingsTypeError(`${path}: ${problem}`);
    }
    if (path === SUPPORT_CONTACT_SETTING && typeof value === "string" && supportContactProblem(value)) throw new SettingsTypeError(`${path}: ${supportContactProblem(value)}`);
    // language of the MCP texts: a typo must not silently switch agents to another language
    if (path === MCP_LANGUAGE_SETTING && value !== null && !(MCP_LANGUAGES as readonly unknown[]).includes(value))
      throw new SettingsTypeError(`${path}: allowed ${MCP_LANGUAGES.map((x) => `"${x}"`).join(" or ")}`);
    // marking of instruction-like lines: a typo must not silently pick a mode (the reader takes inline for it)
    if (path === INSTRUCTION_MARKING_SETTING && value !== null && !(INSTRUCTION_MARKINGS as readonly unknown[]).includes(value))
      throw new SettingsTypeError(`${path}: allowed ${INSTRUCTION_MARKINGS.map((x) => `"${x}"`).join(", ")}`);
    // output schemas of tools/list: a typo must not silently pick a mode (the reader takes open for it)
    if (path === MCP_OUTPUT_SCHEMAS_SETTING && value !== null && !(MCP_OUTPUT_SCHEMA_MODES as readonly unknown[]).includes(value))
      throw new SettingsTypeError(`${path}: allowed ${MCP_OUTPUT_SCHEMA_MODES.map((x) => `"${x}"`).join(", ")}`);
    // tool profile of tools/list: a typo must not silently pick a profile (the reader takes core for it)
    if (path === MCP_TOOLS_PROFILE_SETTING && value !== null && !(MCP_TOOLS_PROFILES as readonly unknown[]).includes(value))
      throw new SettingsTypeError(`${path}: allowed ${MCP_TOOLS_PROFILES.map((x) => `"${x}"`).join(" or ")}`);
    // detail of the structured answers of MCP tools: a typo must not silently pick a detail (the reader takes lean for it)
    if (path === MCP_RESPONSE_DETAIL_SETTING && value !== null && !(MCP_RESPONSE_DETAILS as readonly unknown[]).includes(value))
      throw new SettingsTypeError(`${path}: allowed ${MCP_RESPONSE_DETAILS.map((x) => `"${x}"`).join(" or ")}`);
    // language and time zone of the installation: a typo must not silently switch the language or move every
    // day boundary (the readers fall back on an unknown value, so a saved typo would look accepted and do nothing)
    if (path === "locale.language" && value !== null && !(MCP_LANGUAGES as readonly unknown[]).includes(value))
      throw new SettingsTypeError(`${path}: allowed ${MCP_LANGUAGES.map((x) => `"${x}"`).join(" or ")}`);
    // audit of open reads: a typo such as "Strict" must not silently mean "spool"
    if (path === AUDIT_OPEN_READS_SETTING && value !== null && !(AUDIT_OPEN_READS as readonly unknown[]).includes(value))
      throw new SettingsTypeError(`${path}: allowed ${AUDIT_OPEN_READS.map((x) => `"${x}"`).join(" or ")}`);
    // audit archive: a typo must not silently switch the archive off or on
    if (path === AUDIT_ARCHIVE_MODE_SETTING && value !== null && !(AUDIT_ARCHIVE_MODES as readonly unknown[]).includes(value))
      throw new SettingsTypeError(`${path}: allowed ${AUDIT_ARCHIVE_MODES.map((x) => `"${x}"`).join(", ")}`);
    // an Area/Location name, Etc/GMT±N or UTC (LOCALE_TIMEZONE_FORM): PostgreSQL's AT TIME ZONE reads a bare offset with the
    // opposite sign (Intl takes "+05:00" as UTC+5, PostgreSQL as UTC−5), reads CET, EST, IST or PST as a fixed abbreviation
    // offset (no summer time, IST as UTC+2) or does not know the name (AET, SystemV/…) — the days of the code and of the
    // queries would differ; a fixed offset is written as its Etc/GMT name (Etc/GMT-5 = UTC+5)
    if (path === "locale.timezone" && value !== null && !(tzValid(value) && LOCALE_TIMEZONE_FORM.test(value)))
      throw new SettingsTypeError(`${path}: an IANA time zone is expected, such as "UTC", "Europe/Berlin" or "America/New_York"`);
    // fallback code page of legacy text: a typo would silently read every such file in the default page
    if (path === "locale.legacy_charset" && value !== null && legacyCharsetOrNull(value) !== value)
      throw new SettingsTypeError(`${LEGACY_CHARSET_INVALID}: ${LEGACY_CHARSETS.map((x) => `"${x}"`).join(", ")}`);
    // who confirms an agent's move and an agent's member add: a typo must not silently switch the gate (the readers
    // gate on anything but the exact "off" / "allow", so a saved typo would look accepted and change nothing)
    if (path === "access.promote_confirmation" && value !== null && !(PROMOTE_CONFIRMATION_MODES as readonly unknown[]).includes(value))
      throw new SettingsTypeError(`${path}: allowed ${PROMOTE_CONFIRMATION_MODES.map((x) => `"${x}"`).join(" or ")}`);
    if (path === "access.agent_member_add" && value !== null && !(AGENT_MEMBER_ADD_MODES as readonly unknown[]).includes(value))
      throw new SettingsTypeError(`${path}: allowed ${AGENT_MEMBER_ADD_MODES.map((x) => `"${x}"`).join(" or ")}`);
    // snippet window: a typo would read as "density", so the earlier window asked for would silently not come back
    if (path === "search.snippet_window" && value !== null && !(SNIPPET_WINDOWS as readonly unknown[]).includes(value))
      throw new SettingsTypeError(`${path}: allowed ${SNIPPET_WINDOWS.map((x) => `"${x}"`).join(" or ")}`);
    // full-text language: a name that is not a configuration name would never be applied, and silently so
    if (path === FTS_CONFIGS_SETTING) { const p = ftsConfigsSettingProblem(value); if (p) throw new SettingsTypeError(p); }
    // connectors to external systems: private networks, folder roots and packs a connector may use, and the limits
    // of the webhooks and the scheduler — a typo must neither open a network or a directory nor remove a limit silently
    { const problems = connectorSettingProblems(path, value); if (problems.length) throw new SettingsTypeError(`${path}: ${problems.join("; ")}`); }
    if (path === "access.author_rule" && value !== null && !(AUTHOR_RULES as readonly unknown[]).includes(value))
      throw new SettingsTypeError(`${path}: allowed values are ${AUTHOR_RULES.map((x) => `"${x}"`).join(" or ")}`);
    if (path === "access.test_leftovers_scope" && value !== null && !(TEST_LEFTOVERS_SCOPES as readonly unknown[]).includes(value))
      throw new SettingsTypeError(`${path}: use “off”, “org” or “all”`);
    if (path === "access.test_purge" && value !== null && !(TEST_PURGE_MODES as readonly unknown[]).includes(value))
      throw new SettingsTypeError(`${path}: use “off” or “auto”`);
    const custodyValues: Record<string, readonly string[]> = { "access.dismissed_personal": CUSTODY_PERSONAL, "access.dismissed_meetings": CUSTODY_MEETINGS, "access.dismissed_custody": CUSTODY_READ };
    if (path in custodyValues && value !== null && !(custodyValues[path] as readonly unknown[]).includes(value))
      throw new SettingsTypeError(`${path}: allowed values are ${custodyValues[path]!.map((x) => `"${x}"`).join(", ")}`);
    if (path === "processing.converter_holds" && value !== null && !(CONVERTER_HOLDS_VALUES as readonly unknown[]).includes(value))
      throw new SettingsTypeError(`${path}: use “new” to pause new documents, “all” to pause everything or leave blank to keep processing`);
    if (path === "integrations.converter_dedup" && value !== null && !(CONVERTER_DEDUP_VALUES as readonly unknown[]).includes(value))
      throw new SettingsTypeError(`${path}: use “document” to look for an uploaded document with the same content, or “off” to upload again`);
    // lane of uploaded documents: a typo must not silently move documents to the night or keep them in the day
    if (path === "processing.documents_lane" && value !== null && value !== "now" && value !== "night")
      throw new SettingsTypeError(`${path}: allowed "now" (right after upload) or "night" (in the night window)`);
    if (path === "processing.conversion_fault" && value !== null) {
      const problems = conversionFaultProblems(value);
      if (problems.length) throw new SettingsTypeError(problems.join("; "));
    }
    if (path === CONVERTER_FORMATS_SETTING && value !== null) {
      const problem = converterFormatsProblem(value);
      if (problem) throw new SettingsTypeError(`${path}: ${problem}`);
    }
    if ((path === "integrations.converter_accepted_suspect_min" || path === "integrations.converter_accepted_rerun_min") && typeof value === "number") {
      const suspect = path === "integrations.converter_accepted_suspect_min" ? value : this.get("integrations.converter_accepted_suspect_min", 30);
      const rerun = path === "integrations.converter_accepted_rerun_min" ? value : this.get("integrations.converter_accepted_rerun_min", 90);
      if (rerun <= suspect) throw new SettingsTypeError(`${path}: the rerun (currently ${rerun} min) must happen after the run is flagged as stalled (currently ${suspect} min)`);
    }
    if (path === "integrations.converter_profile" && value !== null && value !== CONVERTER_FAST_PROFILE)
      throw new SettingsTypeError(`${path}: only fast mode “${CONVERTER_FAST_PROFILE}” is allowed. The memory does not use the converter’s full mode`);
    return true;
  }
}

export const SECURITY_MODE_CHANNEL = "security_mode";
const LISTEN_RETRY_MS = 30_000;

export function listenSecurityMode(pool: Pick<pg.Pool, "connect">, settings: Pick<Settings, "load">): { stop(): Promise<void> } {
  let client: pg.PoolClient | null = null, stopped = false, timer: NodeJS.Timeout | null = null;
  const retry = () => { if (!stopped && !timer) { timer = setTimeout(() => { timer = null; void start(); }, LISTEN_RETRY_MS); timer.unref?.(); } };
  const drop = (c: pg.PoolClient) => {
    if (client === c) client = null;
    try { c.release(true); } catch { }
    retry();
  };
  async function start(): Promise<void> {
    if (stopped || client) return;
    let c: pg.PoolClient;
    try { c = await pool.connect(); } catch { log.warn("security_mode_listen_failed", { stage: "connect" }); retry(); return; }
    c.on("notification", (n) => { if (n.channel === SECURITY_MODE_CHANNEL) void settings.load(true).catch(() => undefined); });
    c.on("error", () => drop(c));
    try {
      await c.query(`LISTEN ${SECURITY_MODE_CHANNEL}`);
      client = c;
      if (stopped) { client = null; c.release(true); }
    } catch { log.warn("security_mode_listen_failed", { stage: "listen" }); drop(c); }
  }
  void start();
  return {
    async stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      const c = client;
      client = null;
      if (c) { await c.query(`UNLISTEN ${SECURITY_MODE_CHANNEL}`).catch(() => undefined); try { c.release(true); } catch { } }
    },
  };
}
