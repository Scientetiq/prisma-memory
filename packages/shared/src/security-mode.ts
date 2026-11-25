// display names
// Stored value | Display name
// basic        | Standard
// advanced     | Hardened
import { createHash, createHmac } from "node:crypto";
import { canonicalJson, derivedKey, isWeakening, policyOf } from "./settings-policy.ts";
import { edgeSideAnchorsUnconfirmed, rootMadeOf } from "./edge-side-anchors.ts";

export type SecurityMode = "basic" | "advanced";
export const SECURITY_MODES: readonly SecurityMode[] = ["basic", "advanced"];
export const SECURITY_MODE_SETTING = "security.mode";
export const DOWNGRADE_DELAY_SETTING = "security.downgrade_delay_hours";
export const DOWNGRADE_DELAY_DEFAULT_H = 24;
export const DOWNGRADE_DELAY_MIN_H = 24;
export const DOWNGRADE_DELAY_MAX_H = 168;
export const DOWNGRADE_REASON_MIN = 20;

export const modeOf = (v: unknown): SecurityMode => (v === "advanced" ? "advanced" : "basic");

export const SECURITY_MODE_DISPLAY_NAMES = Object.freeze({
  basic: "Standard",
  advanced: "Hardened",
} as const satisfies Record<SecurityMode, string>);

export const securityModeDisplayName = (value: unknown) => SECURITY_MODE_DISPLAY_NAMES[modeOf(value)];

export const stricterMode = (a: SecurityMode, b: SecurityMode | null | undefined): SecurityMode => (a === "advanced" || b === "advanced" ? "advanced" : "basic");

interface FloorSource { floor: SecurityMode | null; serial: number | null }
let loaderFloor: FloorSource = { floor: null, serial: null };
let dbFloor: FloorSource | null = null;
export function setSecurityModeFloor(f: SecurityMode | null, serial: number | null = null): void { loaderFloor = { floor: f, serial }; }
export function setSecurityModeDbFloor(f: SecurityMode | null, serial: number | null): void { dbFloor = { floor: f, serial }; }
export function resetSecurityModeFloorForTests(): void { loaderFloor = { floor: null, serial: null }; dbFloor = null; }
export function securityModeFloor(): SecurityMode | null {
  return loaderFloor.floor === "advanced" || dbFloor?.floor === "advanced" ? "advanced" : null;
}

// ---------------------------------------------------------------- advanced closed until the role split

/** Reason of the refusal: the services do not have their own database passwords (the role split is not ported). */
export const ROLES_NOT_SPLIT = "roles_not_split";

/** Why the floor advanced is refused in this release (the draft and the loaders add what to do). */
export const ROLES_NOT_SPLIT_TEXT = "advanced is closed in this release (roles_not_split): it cannot check yet that every service has "
  + "its own database password — the gateway and the workers may still derive theirs from the shared PG_APP_PASSWORD, and then the "
  + "workers cannot confirm the anchors row independently of the gateway, so a signed floor advanced would switch advanced on "
  + "without that boundary";

let rolesSplitAssumed = false;

/**
 * The refusal of a floor advanced (ROLES_NOT_SPLIT_TEXT), or null when it may be applied. In this release it is always the
 * refusal: the check of the role split comes with the chain of memory/, which replaces this function by the real check.
 */
export function rolesSplitRefusal(): string | null {
  return rolesSplitAssumed ? null : ROLES_NOT_SPLIT_TEXT;
}

/**
 * Tests only: take the role split as proven, so the machinery of the floor stays covered until the chain
 * recipient puts the real check in place. No source of a package calls it (a unit test checks that).
 */
export function assumeRolesSplitForTests(on: boolean): void { rolesSplitAssumed = on; }

export const gateModeOf = (v: unknown, f: SecurityMode | null = securityModeFloor()): SecurityMode => (v === "basic" && f !== "advanced" ? "basic" : "advanced");

export type LdapChannel = "ldaps" | "starttls" | "plain";
export type LdapChannelLevel = "ok" | "warn" | "refuse";
export type LdapChannelReason = "ldaps_required" | "plain_unacknowledged" | "plain_in_advanced";
export interface LdapChannelVerdict { level: LdapChannelLevel; channel: LdapChannel; reason?: LdapChannelReason }
export const LDAP_CHANNELS: readonly LdapChannel[] = ["ldaps", "starttls", "plain"];
export const LDAP_CHANNEL_KEYS = ["ldap.tls_mode", "ldap.insecure_ack", "edge.ldap_require_ldaps"] as const;

export function externalLdapChannel(mode: unknown, ldap: { tls_mode?: unknown; insecure_ack?: unknown }, requireLdaps: unknown): LdapChannelVerdict {
  const required = requireLdaps !== false;
  if (ldap.tls_mode === "ldaps") return { level: "ok", channel: "ldaps" };
  if (ldap.tls_mode === "starttls") return required ? { level: "refuse", channel: "starttls", reason: "ldaps_required" } : { level: "warn", channel: "starttls" };
  if (ldap.insecure_ack !== true) return { level: "refuse", channel: "plain", reason: "plain_unacknowledged" };
  if (mode !== "basic") return { level: "refuse", channel: "plain", reason: "plain_in_advanced" };
  if (required) return { level: "refuse", channel: "plain", reason: "ldaps_required" };
  return { level: "warn", channel: "plain" };
}

export const ldapChannelOf = (get: (path: string) => unknown, mode: unknown): LdapChannelVerdict =>
  externalLdapChannel(mode, { tls_mode: get("ldap.tls_mode"), insecure_ack: get("ldap.insecure_ack") }, get("edge.ldap_require_ldaps"));

export const LDAP_CHANNEL_WORDS: Readonly<Record<LdapChannel, string>> = { ldaps: "LDAPS", starttls: "StartTLS", plain: "no encryption" };

export const LDAP_PLAIN_RISK_TEXT =
  "Without encryption, the memory server sends an employee’s external sign-in password to the domain controller as plain text, "
  + "so anyone who sees traffic on that part of the internal network can read it. Without TLS, the memory also cannot verify that the controller is genuine. The same person could "
  + "substitute a “password correct” response and sign in from outside as another employee because the second factor is off in basic mode. The only protection is "
  + "only encryption to the directory: LDAPS or StartTLS.";

export interface SettingsReader { get<T>(path: string, fallback: T): T; securityMode?(): SecurityMode }

export function effectiveMode(s: SettingsReader, f: SecurityMode | null = securityModeFloor()): SecurityMode {
  const own = typeof s.securityMode === "function" ? s.securityMode() : modeOf(s.get<unknown>(SECURITY_MODE_SETTING, "basic"));
  return stricterMode(own, f);
}

export function approvalsRequired(app: { settings: SettingsReader }): boolean {
  return effectiveMode(app.settings) === "advanced";
}

export const ADVANCED_SESSION_MAX_MIN = 60;
export const ADVANCED_SESSION_IDLE_MIN = 15;

const atMost = (limit: number) => (v: unknown): unknown => (typeof v === "number" && Number.isFinite(v) && v < limit ? v : limit);

export const ADVANCED_LAYER: Readonly<Record<string, (v: unknown) => unknown>> = {
  "admin.webauthn_required": () => true,
  "admin.system_key_admin": () => false,
  "admin.local_login": (v) => (v === "off" ? "off" : "breakglass"),
  "admin.second_signature": () => "on",
  "admin.auditor_key_access": () => false,
  "admin.service_keys_by_fingerprint": () => true,
  "admin.session_max_min": atMost(ADVANCED_SESSION_MAX_MIN),
  "admin.session_idle_min": atMost(ADVANCED_SESSION_IDLE_MIN),
};

export const ADVANCED_SET_VALUES: ReadonlyArray<{ category: "admin"; key: string; value: unknown }> = [
  { category: "admin", key: "webauthn_required", value: true },
  { category: "admin", key: "system_key_admin", value: false },
  { category: "admin", key: "local_login", value: "breakglass" },
  { category: "admin", key: "second_signature", value: "on" },
  { category: "admin", key: "auditor_key_access", value: false },
  { category: "admin", key: "service_keys_by_fingerprint", value: true },
  { category: "admin", key: "session_max_min", value: ADVANCED_SESSION_MAX_MIN },
  { category: "admin", key: "session_idle_min", value: ADVANCED_SESSION_IDLE_MIN },
];

export function advancedTargets(get: (path: string) => unknown): Array<{ category: "admin"; key: string; value: unknown }> {
  return ADVANCED_SET_VALUES.map((v) => ({ ...v, value: ADVANCED_LAYER[`${v.category}.${v.key}`]!(get(`${v.category}.${v.key}`) ?? null) }));
}

export interface HumanSessionCaller {
  sessionId: string | null;
  personId: string | null;
  authMethod: string;
  breakglassWindowId: string | null;
}

export function isHumanSession(a: HumanSessionCaller | null | undefined): boolean {
  return !!a && !!a.sessionId && !!a.personId && (a.authMethod === "sso" || a.authMethod === "sso_webauthn") && !a.breakglassWindowId;
}

export const HUMAN_SESSION_REQUIRED_TEXT =
  "Only an administrator in a personal session through the identity provider makes this change: the system key, a tool session, emergency access and admin@local do not qualify";

export const EXTERNAL_FLAGS = ["edge.export_enabled", "edge.login_enabled", "edge.c2_enabled"] as const;
export type ExternalFlag = (typeof EXTERNAL_FLAGS)[number];
export const LOGIN_FLAGS: readonly ExternalFlag[] = ["edge.login_enabled", "edge.c2_enabled"];

export type Getter = (path: string) => unknown;

const nonEmptyList = (v: unknown): boolean => Array.isArray(v) && v.length > 0;

export const ALERT_MAIL_RE = /^[^\s@<>()",;:\\[\]]{1,64}@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;
export function deliverableRecipients(v: unknown): string[] {
  const list = (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase()).filter((x) => ALERT_MAIL_RE.test(x));
  return [...new Set(list)];
}
const setNumber = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v !== -1;

export function hostInServers(servers: unknown, host: unknown): boolean {
  const h = typeof host === "string" ? host.trim().toLowerCase() : "";
  return h !== "" && Array.isArray(servers) && servers.some((x) => typeof x === "string" && x.trim().toLowerCase() === h);
}
function pdcOk(g: Getter): boolean {
  const pdc = g("edge.ad_pdc");
  return typeof pdc === "string" && pdc.trim() !== "" && hostInServers(g("ldap.servers"), pdc);
}

export interface GateSettingCondition { id: string; keys: readonly string[]; ok: (get: Getter) => boolean; title: string; failTitle?: (get: Getter) => string }

const LDAP_REFUSE_TITLES: Readonly<Record<LdapChannelReason, string>> = {
  ldaps_required: "the directory connection does not use LDAPS, but “LDAPS only” is enabled (edge.ldap_require_ldaps). Set ldap.tls_mode = ldaps before enabling the flag, or turn it off",
  plain_unacknowledged: "the directory connection is unencrypted and “I understand the risk” is unchecked (ldap.tls_mode = none without ldap.insecure_ack)",
  plain_in_advanced: "advanced mode disallows an unencrypted directory connection (ldap.tls_mode = none)",
};

const HEAD: readonly GateSettingCondition[] = [
  { id: "alerts_mail", keys: ["smtp.enabled"], ok: (g) => g("smtp.enabled") === true, title: "alert e-mail is enabled (smtp.enabled)" },
  { id: "alert_recipients", keys: ["admin.alert_recipients"], ok: (g) => deliverableRecipients(g("admin.alert_recipients")).length > 0, title: "alert recipients are set (admin.alert_recipients)" },
];
const ADVANCED_LDAP: readonly GateSettingCondition[] = [
  { id: "ldaps", keys: ["ldap.tls_mode"], ok: (g) => g("ldap.tls_mode") === "ldaps", title: "directory uses LDAPS only (ldap.tls_mode = ldaps)" },
  { id: "require_ldaps", keys: ["edge.ldap_require_ldaps"], ok: (g) => g("edge.ldap_require_ldaps") === true, title: "external sign-in requires LDAPS (edge.ldap_require_ldaps)" },
];
const BASIC_LDAP: readonly GateSettingCondition[] = [
  { id: "ldap_channel", keys: LDAP_CHANNEL_KEYS, ok: (g) => ldapChannelOf(g, "basic").level !== "refuse",
    title: "the directory channel is allowed by the mode (ldap.tls_mode, ldap.insecure_ack, edge.ldap_require_ldaps)",
    failTitle: (g) => { const v = ldapChannelOf(g, "basic"); return v.reason ? LDAP_REFUSE_TITLES[v.reason] : "the mode does not allow the directory connection"; } },
];
const TAIL: readonly GateSettingCondition[] = [
  { id: "lockout_threshold", keys: ["edge.ad_lockout_threshold"], ok: (g) => setNumber(g("edge.ad_lockout_threshold")), title: "AD lockout threshold is set (edge.ad_lockout_threshold)" },
  { id: "lockout_window", keys: ["edge.ad_lockout_window_min"], ok: (g) => setNumber(g("edge.ad_lockout_window_min")), title: "AD lockout window is set (edge.ad_lockout_window_min)" },
  { id: "pdc", keys: ["edge.ad_pdc", "ldap.servers"], ok: pdcOk, title: "PDC is set and matches a controller in ldap.servers (edge.ad_pdc)",
    failTitle: (g) => typeof g("edge.ad_pdc") === "string" && (g("edge.ad_pdc") as string).trim() !== ""
      ? "PDC (edge.ad_pdc) does not match a controller in ldap.servers (same name or IP). The sign-in check will not contact it and will refuse everyone"
      : "PDC is set (edge.ad_pdc)" },
  { id: "spray_auto_pause", keys: ["edge.spray_auto_pause"], ok: (g) => g("edge.spray_auto_pause") === true, title: "automatic pause on password spraying is enabled (edge.spray_auto_pause)" },
  { id: "deny_admin_count", keys: ["edge.deny_admin_count"], ok: (g) => g("edge.deny_admin_count") === true, title: "AD administrators cannot sign in from outside (edge.deny_admin_count)" },
  { id: "login_groups", keys: ["edge.login_groups"], ok: (g) => nonEmptyList(g("edge.login_groups")), title: "sign-in groups are set (edge.login_groups)" },
  { id: "admin_sso", keys: ["admin.sso_login_enabled"], ok: (g) => g("admin.sso_login_enabled") === true, title: "Single sign-on is enabled for administrators (admin.sso_login_enabled)" },
];

export const LOGIN_SETTING_CONDITIONS: readonly GateSettingCondition[] = [...HEAD, ...ADVANCED_LDAP, ...TAIL];
export const BASIC_LOGIN_SETTING_CONDITIONS: readonly GateSettingCondition[] = [...HEAD, ...BASIC_LDAP, ...TAIL];

export const settingConditionsOf = (flag: ExternalFlag, mode: SecurityMode): readonly GateSettingCondition[] =>
  flag === "edge.export_enabled" ? [] : mode === "basic" ? BASIC_LOGIN_SETTING_CONDITIONS : LOGIN_SETTING_CONDITIONS;

export interface GateWarning { id: "ldap_plain" | "ldap_starttls"; title: string; detail?: string }
export const LDAP_PLAIN_WARNING = "sign-in passwords from outside go to the domain controller unencrypted";
export const LDAP_STARTTLS_WARNING = "sign-in passwords from outside go to the domain controller over StartTLS, not LDAPS: “LDAPS only” (edge.ldap_require_ldaps) is off";

export const LDAP_REPORTED_PLAIN_WARNING = "the sign-in check service reports: sign-in passwords from outside go to the domain controller unencrypted, although the settings require encryption";
export const LDAP_REPORTED_STARTTLS_WARNING = "the sign-in check service reports: sign-in passwords from outside go to the domain controller over StartTLS, although the settings say LDAPS";
const CHANNEL_RANK: Readonly<Record<LdapChannel, number>> = { plain: 0, starttls: 1, ldaps: 2 };

export function gateWarnings(get: Getter, flag: ExternalFlag, mode: SecurityMode, reported?: unknown): GateWarning[] {
  if (flag === "edge.export_enabled" || mode !== "basic") return [];
  const v = ldapChannelOf(get, "basic");
  const out: GateWarning[] = [];
  const said = typeof reported === "string" ? (LDAP_CHANNEL_WORDS as Record<string, string>)[reported] ?? "unrecognized" : null;
  if (v.level === "warn")
    out.push({ id: v.channel === "plain" ? "ldap_plain" : "ldap_starttls", title: v.channel === "plain" ? LDAP_PLAIN_WARNING : LDAP_STARTTLS_WARNING,
               ...(said ? { detail: `sign-in check service reports connection: ${said}` } : {}) });
  const rep = reported === "plain" || reported === "starttls" ? reported : null;
  if (rep && CHANNEL_RANK[rep] < CHANNEL_RANK[v.channel])
    out.push({ id: rep === "plain" ? "ldap_plain" : "ldap_starttls", title: rep === "plain" ? LDAP_REPORTED_PLAIN_WARNING : LDAP_REPORTED_STARTTLS_WARNING,
               detail: `sign-in check service reports connection ${LDAP_CHANNEL_WORDS[rep]}, but the settings specify ${LDAP_CHANNEL_WORDS[v.channel]}. It has not applied the settings yet (it reloads them once a minute) or could not reload them` });
  return out;
}

export interface HeartbeatFact {
  run_mode: string; fresh: boolean; detail: Record<string, unknown>;
  age_sec?: number;
}
export interface GateFacts {
  heartbeats: Readonly<Record<string, HeartbeatFact | undefined>>;
  reconcile: Record<string, unknown> | null;
  alertMailOk: boolean;
  adminListenerUnix: boolean;
  edgeAnchorsSerial: number | null;
  e5HostileBridge?: boolean;
  authcheckSettingsDigest?: string | null | typeof AUTHCHECK_SETTINGS_UNREAD;
  authcheckSettingsPending?: readonly string[];
}

export const AUTHCHECK_PDC_MAX_AGE_SEC = 600;
export const AUTHCHECK_SETTINGS_UNREAD = "unread" as const;
export const AUTHCHECK_READINESS_EDGE_KEYS: readonly string[] = ["ad_pdc", "ad_lockout_threshold", "ad_lockout_window_min", "badpwd_reserve_min",
  "password_failures_per_window", "password_window_min", "ldap_require_ldaps"];
export function authcheckReadinessKey(path: string): boolean {
  if (path.startsWith("ldap.")) return true;
  return path.startsWith("edge.") && AUTHCHECK_READINESS_EDGE_KEYS.includes(path.slice(5));
}
export const readinessRowsSql = (t: string, param: string): string => `(${t}.category = 'ldap' OR (${t}.category = 'edge' AND ${t}.key = ANY(${param}::text[])))`;
export const readinessDigestSql = (t: string): string =>
  `encode(sha256(convert_to(coalesce(string_agg(${t}.category || '.' || ${t}.key || '=' || coalesce(${t}.value::text, 'null') || '/' || coalesce(${t}.enc_kid, ''), chr(10) ORDER BY ${t}.category, ${t}.key), ''), 'UTF8')), 'hex')`;

const DIGEST = /^[0-9a-f]{64}$/;
function authcheckNotReady(ac: HeartbeatFact | undefined, facts: GateFacts, mode: SecurityMode): { title: string; keys?: readonly string[] } | null {
  const d = ac?.detail ?? {};
  const closed = d.closed_reason ?? null;
  if (!ac?.fresh || d.sweep_ok !== true || d.pdc_emulator !== true || d.budgets_ok !== true || (closed !== null && closed !== "login_disabled"))
    return { title: "the sign-in check has not confirmed the PDC emulator and budgets (pdc_emulator, budgets_ok in the memory-authcheck heartbeat)" };
  const age = d.pdc_checked_age_sec;
  const row = typeof ac.age_sec === "number" && Number.isFinite(ac.age_sec) ? Math.max(0, ac.age_sec) : 0;
  const total = typeof age === "number" && Number.isFinite(age) && age >= 0 ? age + row : Number.NaN;
  if (!(total <= AUTHCHECK_PDC_MAX_AGE_SEC))
    return { title: "the sign-in check’s PDC role response is over 10 minutes old or has no age (pdc_checked_age_sec in the memory-authcheck heartbeat plus the row’s age). The directory is not responding, the check took too long or the service is unresponsive" };
  if (d.security_mode !== mode)
    return { title: "the sign-in check reports on the directory connection for another security mode or reports no mode (security_mode in the memory-authcheck heartbeat). It has not reloaded the settings yet" };
  const pending = facts.authcheckSettingsPending ?? [];
  if (pending.length)
    return { title: "this batch also changes directory, PDC or budget settings. Save them first, wait for the sign-in check to apply them (up to a minute and a half), then enable sign-in", keys: pending };
  const want = facts.authcheckSettingsDigest;
  if (want !== undefined && want !== null) {
    const seen = d.settings_digest;
    if (want === AUTHCHECK_SETTINGS_UNREAD || !DIGEST.test(want) || typeof seen !== "string" || seen !== want)
      return { title: "the sign-in check has not applied the current directory, PDC or budget settings yet (settings_digest in the memory-authcheck heartbeat differs from the settings fingerprint)" };
  }
  return null;
}

export interface GateFailure { flag: ExternalFlag; reason: string; title: string; keys?: readonly string[] }

export const EXPORT_SERVICES = ["exporter", "intake", "reconciler"] as const;

export function reconcileClean(r: Record<string, unknown> | null): boolean {
  if (!r) return true;
  const n = (k: string) => (typeof r[k] === "number" ? (r[k] as number) : 0);
  return !r.error_code && n("extra") === 0 && n("missing") === 0 && n("canary") === 0 && r.revoke !== "failed";
}

export function externalGate(get: Getter, facts: GateFacts, flag: ExternalFlag, mode: SecurityMode): GateFailure[] {
  const out: GateFailure[] = [];
  const hb = (s: string) => facts.heartbeats[s];
  const container = (s: string) => { const h = hb(s); return !!h && h.fresh && h.run_mode === "container"; };
  const services = flag === "edge.export_enabled" ? [...EXPORT_SERVICES] : [...EXPORT_SERVICES, "memory-authcheck"];
  const notContainer = services.filter((s) => !container(s));
  if (notContainer.length) out.push({ flag, reason: "run_mode_user", title: `services are outside the container or unresponsive: ${notContainer.join(", ")}` });
  const ex = hb("exporter");
  const serial = typeof ex?.detail?.anchors_serial === "number" ? (ex.detail.anchors_serial as number) : null;
  if (!ex?.fresh || serial === null || (facts.edgeAnchorsSerial !== null && serial < facts.edgeAnchorsSerial))
    out.push({ flag, reason: "anchors_unknown", title: "exporter has not confirmed the current anchors (anchors_serial in the heartbeat must be at least the applied serial)" });
  const side = edgeSideAnchorsUnconfirmed(facts.heartbeats, facts.edgeAnchorsSerial);
  if (side.length) out.push({ flag, reason: "anchors_unknown", title: `edge and bridge have not confirmed the current anchors (heartbeats need recent rows for ${side.join(", ")} and anchors_serial at least as high as the applied serial)` });
  if (!reconcileClean(facts.reconcile)) out.push({ flag, reason: "reconcile_dirty", title: "the latest edge reconciliation did not pass cleanly" });
  for (const c of settingConditionsOf(flag, mode)) if (!c.ok(get)) out.push({ flag, reason: `setting_${c.id}`, title: c.failTitle?.(get) ?? c.title, keys: c.keys });
  if (flag !== "edge.export_enabled") {
    if (!facts.alertMailOk) out.push({ flag, reason: "alert_mail_stale", title: "no high alert e-mail was delivered successfully in the last 7 days" });
    const nr = authcheckNotReady(hb("memory-authcheck"), facts, mode);
    if (nr) out.push({ flag, reason: "authcheck_not_ready", title: nr.title, ...(nr.keys ? { keys: [...nr.keys] } : {}) });
    if (!facts.adminListenerUnix) out.push({ flag, reason: "admin_listener", title: "the admin listener is not isolated on a Unix socket (MEMORY_ADMIN_LISTEN)" });
    if (facts.e5HostileBridge !== true) out.push({ flag, reason: "setting_e5_hostile_bridge", title: E5_GATE_TITLE });
  }
  return out;
}

export const E5_GATE_TITLE = "hostile bridge check failed";

export function gateWouldBreak(future: Getter, current: Getter, changed: ReadonlySet<string>, mode: SecurityMode): Array<{ key: string; flag: ExternalFlag; condition: string }> {
  const out: Array<{ key: string; flag: ExternalFlag; condition: string }> = [];
  for (const flag of EXTERNAL_FLAGS) {
    if (future(flag) !== true || current(flag) !== true) continue;
    for (const c of settingConditionsOf(flag, mode)) {
      const touched = c.keys.filter((k) => changed.has(k));
      if (touched.length && !c.ok(future)) for (const key of touched) out.push({ key, flag, condition: c.id });
    }
  }
  return out;
}
export const EXTERNAL_GATE_WOULD_BREAK = "external_gate_would_break";
export const EXTERNAL_GATE_WOULD_BREAK_TEXT = "while the external perimeter is open, this change would weaken a condition for opening it. Close the perimeter first";

export const GROUP1_KEYS: readonly string[] = ["edge.login_enabled", "edge.export_enabled", "edge.c2_enabled", "edge.login_groups", "edge.deny_groups", "edge.deny_admin_count"];

interface CoreEntry { key: string | RegExp; rule?: string }

const CORE_WHILE_LOGIN: readonly CoreEntry[] = [
  { key: "ldap.tls_mode" }, { key: "edge.ldap_require_ldaps" }, { key: "edge.ad_lockout_threshold" }, { key: "edge.ad_lockout_window_min" },
  { key: "edge.badpwd_reserve_min" }, { key: /^edge\.password_failures_/ }, { key: "edge.global_binds_per_min" },
  { key: /^edge\.spray_/ }, { key: /^edge\.code_failures_/ }, { key: /^edge\.device_/ }, { key: "edge.mfa_mode" }, { key: "edge.refresh_reuse_action" },
  { key: "edge.optin_first_confirm" }, { key: "edge.office_networks" }, { key: "edge.decoy_guids" }, { key: "edge.disabled_clients" },
  { key: "edge.passkey_enabled" }, { key: "edge.cimd_enabled" },
  { key: "admin.alert_recipients", rule: "list_remove" },
  { key: "ldap.insecure_ack", rule: "any" },
];
const CORE_WHILE_EXPORT: readonly CoreEntry[] = [{ key: /^open_check\./ }, { key: "access.external_channel_off" }];
const CORE_WHILE_ANY: readonly CoreEntry[] = [{ key: "edge.bridge_url" }];
/**
 * Group «while built-in agent sign-in»: the current agent_auth.mode is builtin. The workplace address is where every
 * agent sign-in redirects people, the agents' addresses are the issuer: an agent with a system key changing them would send
 * employees to a foreign sign-in page (LDAP and SSO passwords) or revoke every connection at once by changing the issuer. In
 * external these keys behave as before. The group is not in a flag profile (coreKeysFor) and not in recovery
 * (alwaysKeysOf): first recover agent_auth.mode, then the addresses.
 */
const CORE_WHILE_BUILTIN: readonly CoreEntry[] = [{ key: /^access\.(workplace_url|cloud_agent_base_url|public_base_url)$/, rule: "any" }];

const CORE_ALWAYS: readonly CoreEntry[] = [
  { key: "access.internal_networks", rule: "list_add" }, { key: "access.trusted_proxies", rule: "list_add" },
  { key: /^oidc\.(issuer|ca_cert|claims|private_networks)$/, rule: "any" },
  { key: /^admin\.(oidc_client_id|oidc_client_secret|oidc_redirect_uri|ad_admin_group)$/, rule: "any" },
  { key: /^ldap\.(servers|port|ca_cert|tls_server_name|base_dn)$/, rule: "any" },
  { key: "edge.ad_pdc", rule: "any" },
  { key: /^smtp\.(host|port|security|insecure_ack|ca_cert|username|password|from_address)$/, rule: "any" },
  // who signs agents in through the browser and how (built-in sign-in): mode, apps, client metadata documents and
  // automatic registration are a human decision; an agent with a system key under a closed contour would admit its own app
  { key: /^agent_auth\.(mode|clients|cimd_hosts|cimd_any_https|dcr_enabled)$/, rule: "any" },
];

const CORE_AFTER_EDGE: readonly CoreEntry[] = [{ key: "smtp.enabled", rule: "bool_true_to_false" }, { key: "admin.alert_recipients", rule: "list_remove" }];

export const SMTP_TRANSPORT_RE = /^smtp\.(host|port|security|insecure_ack|ca_cert|username|password|from_address)$/;

export interface CoreContext { edgePrepared?: boolean; humanSessions?: boolean }

const matches = (k: string | RegExp, path: string): boolean => (typeof k === "string" ? k === path : k.test(path));

export function coreAlways(path: string, ctx: CoreContext = {}): boolean {
  if (ctx.humanSessions === false) return false;
  return CORE_ALWAYS.some((e) => matches(e.key, path)) || (ctx.edgePrepared === true && CORE_AFTER_EDGE.some((e) => matches(e.key, path)));
}

export function coreRule(path: string): string | null {
  for (const e of [...CORE_ALWAYS, ...CORE_AFTER_EDGE, ...CORE_WHILE_LOGIN, ...CORE_WHILE_EXPORT, ...CORE_WHILE_ANY, ...CORE_WHILE_BUILTIN]) if (matches(e.key, path)) return e.rule ?? policyOf(path)?.weaken ?? null;
  return null;
}

/** A key of the group «while built-in agent sign-in»: the current mode is builtin, human sessions exist (as for «always»). */
export function coreWhileBuiltin(path: string, current: Getter, ctx: CoreContext = {}): boolean {
  return ctx.humanSessions !== false && current("agent_auth.mode") === "builtin" && CORE_WHILE_BUILTIN.some((e) => matches(e.key, path));
}

export function coreKeyActive(path: string, current: Getter, ctx: CoreContext = {}): boolean {
  if (coreAlways(path, ctx)) return true;
  if (coreWhileBuiltin(path, current, ctx)) return true;
  const login = LOGIN_FLAGS.some((f) => current(f) === true), exp = current("edge.export_enabled") === true;
  if ((login || exp) && CORE_WHILE_ANY.some((e) => matches(e.key, path))) return true;
  if (login && CORE_WHILE_LOGIN.some((e) => matches(e.key, path))) return true;
  if (login && ctx.humanSessions === false && CORE_ALWAYS.some((e) => matches(e.key, path))) return true;
  if (exp && CORE_WHILE_EXPORT.some((e) => matches(e.key, path))) return true;
  return false;
}

export function alwaysKeysOf(all: readonly string[]): string[] {
  return all.filter((p) => CORE_ALWAYS.some((e) => matches(e.key, p)) || CORE_AFTER_EDGE.some((e) => matches(e.key, p)));
}

export function coreKeysFor(flag: ExternalFlag, all: readonly string[]): string[] {
  const groups = flag === "edge.export_enabled" ? [...CORE_WHILE_EXPORT, ...CORE_WHILE_ANY, ...CORE_ALWAYS, ...CORE_AFTER_EDGE]
    : [...CORE_WHILE_LOGIN, ...CORE_WHILE_ANY, ...CORE_ALWAYS, ...CORE_AFTER_EDGE];
  const circle = flag === "edge.export_enabled" ? [] : GROUP1_KEYS.filter((k) => !(EXTERNAL_FLAGS as readonly string[]).includes(k));
  return all.filter((p) => circle.includes(p) || groups.some((e) => matches(e.key, p)));
}

export interface CoreChange { key: string; group: "1" | "1b" | "always"; before: unknown; after: unknown }

export function coreChanges(changes: ReadonlyArray<{ path: string; before: unknown; after: unknown }>, current: Getter, ctx: CoreContext = {}): CoreChange[] {
  const out: CoreChange[] = [];
  const loginOpen = LOGIN_FLAGS.some((f) => current(f) === true);
  for (const ch of changes) {
    if (GROUP1_KEYS.includes(ch.path)) {
      const flag = (EXTERNAL_FLAGS as readonly string[]).includes(ch.path);
      if ((flag || loginOpen) && isWeakening(policyOf(ch.path)?.weaken ?? null, ch.before, ch.after)) out.push({ key: ch.path, group: "1", before: ch.before, after: ch.after });
      continue;
    }
    if (!coreKeyActive(ch.path, current, ctx)) continue;
    const rule = coreRule(ch.path);
    const always = coreAlways(ch.path, ctx) || coreWhileBuiltin(ch.path, current, ctx);
    if (isWeakening(rule, ch.before, ch.after)) out.push({ key: ch.path, group: always ? "always" : "1b", before: ch.before, after: ch.after });
  }
  return out;
}

export function openingFlags(changes: ReadonlyArray<{ path: string; before: unknown; after: unknown }>): ExternalFlag[] {
  return EXTERNAL_FLAGS.filter((f) => changes.some((ch) => ch.path === f && ch.before !== true && ch.after === true));
}

export function profileWeakenings(flag: ExternalFlag, keys: readonly string[], value: Getter, seedDefault: Getter,
                                  skip: (key: string) => boolean = () => false): Array<{ key: string; value: unknown; seed: unknown }> {
  const out: Array<{ key: string; value: unknown; seed: unknown }> = [];
  for (const key of coreKeysFor(flag, keys)) {
    if (skip(key)) continue;
    const rule = GROUP1_KEYS.includes(key) ? policyOf(key)?.weaken ?? null : coreRule(key);
    if (rule === null) continue;
    const v = value(key), d = seedDefault(key);
    if (isWeakening(rule, d, v)) out.push({ key, value: v, seed: d });
  }
  return out;
}

export function valueDigest(v: unknown): string {
  return createHash("sha256").update(canonicalJson(v ?? null)).digest("hex");
}

export function secretValueDigest(appSecret: string, path: string, v: unknown): string {
  return createHmac("sha256", derivedKey(appSecret, "memory-profile-attest")).update(`${path}\n${canonicalJson(v ?? null)}`).digest("hex");
}

export function profileDigest(appSecret: string, path: string, v: unknown, secret: boolean): string {
  return secret ? secretValueDigest(appSecret, path, v) : valueDigest(v);
}

export const HUMAN_ONLY_ACTIONS: ReadonlySet<string> = new Set(["edge.unkill", "mfa.factor_reset"]);

export const deviceBoundKey = (backupEligible: boolean | null | undefined): boolean => backupEligible === false;
export const DEVICE_BOUND_SQL = "backup_eligible IS FALSE";

export interface CompletionFacts {
  floorAdvanced: boolean;
  roots: ReadonlyArray<{ service: string; root: string | null }>;
  humanSigners: ReadonlySet<string>;
  attested: ReadonlySet<string>;
}

export interface CompletionItem { id: "inner_anchors" | "roots" | "machine_keys" | "host" | "release_signers"; ok: boolean; title: string; detail?: string; missing: string }

export const ROOT_SERVICES_MIN = 4;

export function advancedCompletion(f: CompletionFacts): CompletionItem[] {
  const humans = new Set([...f.humanSigners].map((x) => x.toLowerCase()));
  const reported = f.roots.filter((r) => typeof r.root === "string" && r.root !== "").map((r) => (r.root as string).toLowerCase());
  const rootsOk = reported.length >= ROOT_SERVICES_MIN && new Set(reported).size === 1 && rootMadeOf(reported[0]!, [...humans]);
  return [
    f.floorAdvanced ? { id: "inner_anchors", ok: true, title: "Internal anchors with an advanced security floor are applied", missing: "security floor in the anchors" }
      : { id: "inner_anchors", ok: false, title: "2-of-3 internal anchors with an advanced security floor have not been applied",
          detail: "Sign the document on the inner perimeter with security_mode_min: advanced (memory-admin-cli anchors draft --floor advanced) and apply it", missing: "security floor in the anchors" },
    rootsOk ? { id: "roots", ok: true, title: "The trust roots for the edge, bridge, authcheck and edge-sync use human-held keys", missing: "trust roots" }
      : { id: "roots", ok: false, title: "Trust roots have not switched to human-held keys", detail: `Services reporting a root fingerprint: ${reported.length} of ${ROOT_SERVICES_MIN}`, missing: "trust roots" },
    f.attested.has("machine_keys_destroyed") ? { id: "machine_keys", ok: true, title: "Basic machine keys destroyed", missing: "basic machine keys" }
      : { id: "machine_keys", ok: false, title: "Destruction of the basic machine keys has not been confirmed", missing: "basic machine keys" },
    f.attested.has("host_hardened") ? { id: "host", ok: true, title: "Accounts have been removed from docker and sudo, and the VM has no runner", missing: "host accounts" }
      : { id: "host", ok: false, title: "IT has not confirmed removal of the accounts from docker and sudo", missing: "host accounts" },
    f.attested.has("release_signers_human") ? { id: "release_signers", ok: true, title: "Releases are signed with human-held keys, and machine release signatures are rejected", missing: "human-held release key" }
      : { id: "release_signers", ok: false, title: "Switching release signing to human-held keys has not been confirmed",
          detail: "Follow the --release-signers step in admin-anchors.md and verify that the old machine signature is rejected. Then confirm release_signers_human", missing: "human-held release key" },
  ];
}
