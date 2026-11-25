import { isIP } from "node:net";
import type pg from "pg";
import { parseCidr, wholeNetworkProblem } from "./channel-settings.ts";
import { RUN_MODES, type RunMode } from "./enums.gen.ts";
import { ALERT_MAIL_RE, DOWNGRADE_DELAY_MAX_H, DOWNGRADE_DELAY_MIN_H, EXTERNAL_GATE_WOULD_BREAK, EXTERNAL_GATE_WOULD_BREAK_TEXT, gateModeOf, gateWouldBreak,
  LDAP_CHANNEL_KEYS, LOGIN_FLAGS, ldapChannelOf, type LdapChannelReason } from "./security-mode.ts";
export { externalLdapChannel, LDAP_CHANNEL_KEYS, LDAP_CHANNELS, type LdapChannel, type LdapChannelLevel, type LdapChannelReason, type LdapChannelVerdict } from "./security-mode.ts";
export { AUTHCHECK_PDC_MAX_AGE_SEC, AUTHCHECK_READINESS_EDGE_KEYS, authcheckReadinessKey, hostInServers, readinessDigestSql, readinessRowsSql } from "./security-mode.ts";

export type EdgeRange = (
  | { type: "bool" }
  | { type: "int"; min: number; max: number; off?: number }
  | { type: "enum"; values: readonly string[] }
  | { type: "text"; max: number; line?: boolean }
  | { type: "list"; max: number; itemMax: number }
  | { type: "object"; fields: Readonly<Record<string, { min: number; max: number }>> }
  | { type: "json"; what: string }
) & {
  nullable?: boolean;
  check?: (value: unknown) => string[];
};

type Stage = "P0" | "1a" | "1b" | "1c" | "1d" | "1e" | "1f" | "S2-3" | "4" | "E2" | "5";

const RANGES_BY_STAGE: Readonly<Record<Stage, Readonly<Record<string, EdgeRange>>>> = {
  P0: {},
  "1a": {
    "admin.sso_login_enabled": { type: "bool" },
    "admin.oidc_client_id": { type: "text", max: 200, line: true },
    "admin.oidc_client_secret": { type: "text", max: 4096, line: true, nullable: true },
    "admin.oidc_redirect_uri": { type: "text", max: 2048, line: true },
    "admin.ad_admin_group": { type: "text", max: 1024, line: true },
    "admin.oidc_username_form": { type: "enum", values: ["any", "account", "upn"] },
    "admin.networks": { type: "list", max: 20, itemMax: 64 },
    "admin.webauthn_rp_id": { type: "text", max: 253, line: true },
    "admin.webauthn_origins": { type: "list", max: 10, itemMax: 300 },
    "admin.webauthn_uv": { type: "enum", values: ["required", "preferred"] },
    "admin.webauthn_required": { type: "bool" },
    "admin.webauthn_min_keys": { type: "int", min: 1, max: 5 },
    "admin.stepup_max_min": { type: "int", min: 1, max: 15 },
    "admin.session_max_min": { type: "int", min: 15, max: 480 },
    "admin.session_idle_min": { type: "int", min: 5, max: 120 },
    "admin.tool_sessions": { type: "bool" },
    "admin.tool_session_max_min": { type: "int", min: 5, max: 60 },
    "admin.second_signature": { type: "enum", values: ["off", "on"] },
    "admin.second_signature_ttl_hours": { type: "int", min: 1, max: 72 },
    "admin.system_key_admin": { type: "bool" },
    "admin.local_login": { type: "enum", values: ["open", "breakglass", "off"] },
    "admin.local_totp_required": { type: "bool" },
    "admin.auditor_key_access": { type: "bool" },
    "admin.service_keys_by_fingerprint": { type: "bool" },
    "admin.breakglass_max_hours": { type: "int", min: 1, max: 2 },
    "admin.bastion_cidrs": { type: "list", max: 10, itemMax: 64 },
    "admin.alert_recipients": { type: "list", max: 10, itemMax: 254,
                                check: (v) => (v as string[]).filter((x) => !ALERT_MAIL_RE.test(x)).map((x) => `${JSON.stringify(x.slice(0, 80))}: use an e-mail address accepted by the mail queue (without “:”, “\\”, “[” or “]”)`) },
    "admin.alert_digest_hour": { type: "int", min: 0, max: 23 },
    "admin.audit_show_personal_titles": { type: "bool" },
    "admin.search_quality_query_texts": { type: "bool" },
    "access.obo_read_consent": { type: "enum", values: ["legacy", "consent", "off"] },
    "access.obo_read_consent_days": { type: "int", min: 1, max: 365 },
    "access.obo_read_alert_people_day": { type: "int", min: 1, max: 10_000 },
    "observability.audit_ship_mode": { type: "enum", values: ["off", "file", "syslog_tls"] },
    "observability.audit_ship_batch": { type: "int", min: 50, max: 5000 },
    "observability.audit_ship_interval_sec": { type: "int", min: 5, max: 300 },
    "observability.audit_ship_lag_sec": { type: "int", min: 30, max: 900 },
    "security.mode": { type: "enum", values: ["basic", "advanced"] },
    "security.downgrade_delay_hours": { type: "int", min: DOWNGRADE_DELAY_MIN_H, max: DOWNGRADE_DELAY_MAX_H },
    "admin.webauthn_aaguids": { type: "list", max: 50, itemMax: 36 },
  },
  "1b": {
    "edge.export_enabled": { type: "bool" },
    "edge.deadman_theta_sec": { type: "int", min: 60, max: 600 },
    "edge.revoke_lag_warn_sec": { type: "int", min: 5, max: 300 },
    "edge.revoke_lag_alarm_sec": { type: "int", min: 30, max: 900 },
    "edge.reconcile_light_min": { type: "int", min: 5, max: 60 },
    "edge.reconcile_full_hour": { type: "int", min: 0, max: 23 },
    "edge.projection_refresh_sec": { type: "int", min: 60, max: 3600 },
    "edge.originals_max_mib": { type: "int", min: 1, max: 20 },
    "edge.max_concurrent_per_connection": { type: "int", min: 1, max: 8 },
    "edge.connection_expiry_warn_days": { type: "int", min: 1, max: 14 },
    "edge.bridge_url": { type: "text", max: 2048, line: true },
  },
  "1c": {
    "edge.ldap_require_ldaps": { type: "bool" },
    "access.https_port": { type: "int", min: 1024, max: 65535, off: 0 },
  },
  "1d": {
    "edge.quota_mode": { type: "enum", values: ["observe", "enforce"] },
    "edge.quota_daily": { type: "json", what: "integer fields search, read, list, text_tokens, originals, originals_mib, c2_items and c2_mib, plus tz for the time zone", check: (v) => quotaDailyProblems(v) },
    "edge.max_new_connections_alert_day": { type: "int", min: 1, max: 100 },
    "edge.geo_alert_enabled": { type: "bool" },
    "edge.probe_enabled": { type: "bool" },
    "edge.probe_base_url": { type: "text", max: 2048, line: true, check: (v) => (v === "" || isHttpsUrl(v as string) ? [] : ["an https://… URL without a username or password, or leave empty"]) },
    "edge.probe_connect_addr": { type: "text", max: 300, line: true,
      check: (v) => (v === "" || isConnectAddress(v as string) ? [] : ["IP address or hostname with the port after a colon (203.0.113.10, [2001:db8::1]:443, proxy.example.test:8443), or leave empty"]) },
    "edge.probe_inner_hosts": { type: "list", max: 20, itemMax: 253, check: (v) => listForm(v, isDnsName, "DNS hostname containing a dot, without an IP address or port") },
    "edge.probe_interval_min": { type: "int", min: 1, max: 60 },
    "edge.synthetic_login_enabled": { type: "bool" },
    "edge.synthetic_login_account": { type: "text", max: 254, line: true, check: (v) => (v === "" || isLoginName(v as string) ? [] : ["the account’s e-mail address or login, or leave empty"]) },
    "edge.synthetic_login_interval_min": { type: "int", min: 15, max: 1440 },
    "edge.geoip_db_path": { type: "text", max: 1024, line: true, check: (v) => (v === "" || isAbsolutePath(v as string) ? [] : ["absolute file path (/…), without “..”, or leave empty"]) },
    "admin.alert_work_hours": { type: "json", what: "fields weekdays (“09:00-19:00”) and tz (time zone)", check: (v) => workHoursProblems(v) },
    "admin.alert_cooldown_min": { type: "int", min: 5, max: 1440 },
  },
  "1e": {
    "edge.login_enabled": { type: "bool" },
    "edge.login_groups": { type: "list", max: 50, itemMax: 1024, check: unique },
    "edge.deny_groups": { type: "list", max: 50, itemMax: 1024, check: unique },
    "edge.deny_admin_count": { type: "bool" },
    "edge.decoy_guids": { type: "list", max: 10, itemMax: 36, check: (v) => listForm(v, isGuid, "objectGUID such as 01234567-89ab-cdef-0123-456789abcdef") },
    "edge.login_domain": { type: "text", max: 189, line: true, check: (v) => (v === "" || isDomain(v as string) ? [] : ["domain name (example.test), or leave empty"]) },
    "edge.optin_fresh_login_min": { type: "int", min: 1, max: 60 },
    "edge.optin_idle_days": { type: "int", min: 14, max: 365 },
    "edge.optin_first_confirm": { type: "enum", values: ["office_or_support", "none"] },
    "edge.office_networks": { type: "list", max: 50, itemMax: 64, check: (v) => networksForm(v, NETWORK_WIDEST_1E) },
    "edge.ad_lockout_threshold": { type: "int", min: 0, max: 999, off: -1 },
    "edge.ad_lockout_window_min": { type: "int", min: 1, max: 1440, off: -1 },
    "edge.ad_pdc": { type: "text", max: 253, line: true, check: (v) => (v === "" || isHost(v as string) ? [] : ["controller hostname or IP address, or leave empty"]) },
    "edge.ad_state_max_age_hours": { type: "int", min: 1, max: 72 },
    "edge.ad_sweep_min": { type: "int", min: 1, max: 60 },
    "edge.ad_pso_visible": { type: "bool" },
    "edge.badpwd_reserve_min": { type: "int", min: 2, max: 10 },
    "edge.password_failures_per_window": { type: "int", min: 1, max: 3 },
    "edge.password_window_min": { type: "int", min: 15, max: 1440 },
    "edge.password_failures_per_day": { type: "int", min: 1, max: 20 },
    "edge.global_binds_per_min": { type: "int", min: 5, max: 600 },
    "edge.spray_alert_accounts_10min": { type: "int", min: 1, max: 10000 },
    "edge.spray_pause_accounts_10min": { type: "int", min: 1, max: 10000 },
    "edge.spray_auto_pause": { type: "bool" },
    "edge.login_step_floor_ms": { type: "int", min: 500, max: 10000 },
    "edge.login_check_timeout_sec": { type: "int", min: 2, max: 20 },
    "edge.check_unhealthy_queue": { type: "int", min: 10, max: 200 },
    "edge.login_ip_limits": { type: "object", fields: {
      failed_per_15min: { min: 1, max: 10000 }, logins_per_hour: { min: 1, max: 10000 }, login_steps_per_15min: { min: 1, max: 10000 },
      token_per_min: { min: 1, max: 10000 }, authorize_per_min: { min: 1, max: 10000 }, nat_multiplier: { min: 1, max: 100 } } },
    "edge.nat_cidrs": { type: "list", max: 50, itemMax: 64, check: (v) => networksForm(v, NETWORK_WIDEST_1E) },
    "edge.mfa_mode": { type: "enum", values: ["off", "optional", "required"] },
    "edge.access_token_min": { type: "int", min: 5, max: 60 },
    "edge.connection_idle_days": { type: "int", min: 1, max: 30 },
    "edge.connection_max_days": { type: "int", min: 1, max: 30 },
    "edge.max_active_connections": { type: "int", min: 1, max: 20 },
    "edge.login_session_hours": { type: "int", min: 1, max: 24 },
    "edge.login_session_hours_no_mfa": { type: "int", min: 1, max: 12 },
    "edge.grant_ttl_min": { type: "int", min: 1, max: 30 },
    "edge.refresh_reuse_grace_sec": { type: "int", min: 0, max: 60 },
    "edge.refresh_reuse_action": { type: "enum", values: ["revoke_connection", "reject_only"] },
    "edge.account_page_enabled": { type: "bool" },
    "edge.disabled_clients": { type: "list", max: 50, itemMax: 64, check: (v) => listForm(v, (s) => /^[a-z0-9][a-z0-9-]{1,63}$/.test(s), "program client_id from the anchors (Latin letters, digits and hyphens)") },
  },
  "1f": {
    "edge.mfa_provider": { type: "enum", values: ["totp"] },
    "edge.mfa_required_grace_days": { type: "int", min: 0, max: 60 },
    "edge.code_failures_per_window": { type: "int", min: 1, max: 20 },
    "edge.code_failures_per_day": { type: "int", min: 5, max: 100 },
    "edge.code_failures_window_min": { type: "int", min: 5, max: 120 },
    "edge.code_lock_min": { type: "int", min: 15, max: 1440 },
    "edge.mfa_fresh_login_min": { type: "int", min: 2, max: 60 },
    "edge.mfa_pending_ttl_min": { type: "int", min: 5, max: 60 },
    "edge.mfa_issuer_label": { type: "text", max: 40, line: true, check: (v) => issuerLabelProblems(v as string) },
    "edge.recovery_low_threshold": { type: "int", min: 0, max: 5 },
  },
  // [S2-3]
  "S2-3": {},
  // [4]
  "4": {},
  // [E2]
  E2: {},
  // [5]
  "5": {},
};

function mergeRanges(): Readonly<Record<string, EdgeRange>> {
  const out: Record<string, EdgeRange> = {};
  for (const [stage, ranges] of Object.entries(RANGES_BY_STAGE)) {
    for (const [path, range] of Object.entries(ranges)) {
      if (Object.hasOwn(out, path)) throw new Error(`edge-settings: limit ${path} is defined in two sections (the second is ${stage})`);
      out[path] = range;
    }
  }
  return out;
}

export const EDGE_RANGES: Readonly<Record<string, EdgeRange>> = mergeRanges();

export const EDGE_NULL_PROBLEM = "an empty value is not allowed. Set the default value to reset it";

export function edgeSettingProblems(path: string, value: unknown): string[] {
  const r = EDGE_RANGES[path];
  return r ? edgeValueProblems(r, value) : [];
}

export function edgeValueProblems(r: EdgeRange, value: unknown): string[] {
  if (value === null || value === undefined) return r.nullable ? [] : [EDGE_NULL_PROBLEM];
  return rangeProblems(r, value);
}

export function rangeProblems(r: EdgeRange, value: unknown): string[] {
  const base = typeProblems(r, value);
  return base.length || !r.check ? base : r.check(value);
}

function typeProblems(r: EdgeRange, value: unknown): string[] {
  switch (r.type) {
    case "bool":
      return typeof value === "boolean" ? [] : ["yes or no (true or false)"];
    case "int":
      if (typeof value === "number" && Number.isInteger(value) && (value === r.off || (value >= r.min && value <= r.max))) return [];
      return [`an integer from ${r.min} to ${r.max}${r.off !== undefined ? ` or ${r.off} (disabled)` : ""}`];
    case "enum":
      return typeof value === "string" && r.values.includes(value) ? [] : [`allowed values: ${r.values.map((v) => `"${v}"`).join(", ")}`];
    case "text":
      if (typeof value !== "string") return ["line"];
      if (value.length > r.max) return [`at most ${r.max} characters`];
      if (r.line && /[\r\n]/.test(value)) return ["on one line"];
      return [];
    case "list":
      if (!Array.isArray(value) || value.some((x) => typeof x !== "string")) return ["list of strings"];
      if (value.length > r.max) return [`at most ${r.max} values`];
      if (value.some((x: string) => x.length > r.itemMax)) return [`values up to ${r.itemMax} characters long`];
      return [];
    case "json":
      return value && typeof value === "object" && !Array.isArray(value) ? [] : [`object: ${r.what}`];
    case "object": {
      const names = Object.keys(r.fields);
      if (!value || typeof value !== "object" || Array.isArray(value)) return [`object with fields ${names.join(", ")}`];
      const v = value as Record<string, unknown>;
      const extra = Object.keys(v).filter((k) => !Object.hasOwn(r.fields, k));
      if (extra.length) return [`unexpected fields: ${extra.join(", ")}`];
      return Object.entries(r.fields).flatMap(([k, f]) => {
        const x = v[k];
        return typeof x === "number" && Number.isInteger(x) && x >= f.min && x <= f.max ? [] : [`${k}: an integer from ${f.min} to ${f.max}`];
      });
    }
  }
}

export interface SettingProblem { key: string; code: string; message: string }

export interface CrossCheckContext {
  db: Pick<pg.Pool, "query">;
  instanceId: string;
  future: (path: string) => unknown;
  current: (path: string) => unknown;
  changed: ReadonlySet<string>;
}

export type CrossCheck = (ctx: CrossCheckContext) => Promise<SettingProblem[]> | SettingProblem[];

const CROSS_CHECKS: CrossCheck[] = [];

export function registerCrossCheck(fn: CrossCheck): () => void {
  if (!CROSS_CHECKS.includes(fn)) CROSS_CHECKS.push(fn);
  return () => { const i = CROSS_CHECKS.indexOf(fn); if (i >= 0) CROSS_CHECKS.splice(i, 1); };
}

export async function runCrossChecks(ctx: CrossCheckContext): Promise<SettingProblem[]> {
  const out: SettingProblem[] = [];
  for (const fn of [...CROSS_CHECKS]) out.push(...(await fn(ctx)));
  return out;
}

function listForm(v: unknown, ok: (s: string) => boolean, what: string): string[] {
  const bad = (v as string[]).find((s) => !ok(s));
  return bad === undefined ? unique(v) : [`${JSON.stringify(bad.slice(0, 80))}: expected ${what}`];
}

function unique(v: unknown): string[] {
  const list = v as string[];
  const dup = list.find((s, i) => list.indexOf(s) !== i);
  return dup === undefined ? [] : [`${JSON.stringify(dup.slice(0, 80))}: duplicate value`];
}

const isGuid = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const isDomain = (s: string): boolean => s.length <= 189 && /^(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+[\p{L}\p{N}]{2,63}$/u.test(s);
const isHost = (s: string): boolean =>
  isIP(s) !== 0 || (s.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(s));

export const NETWORK_WIDEST_1E: Readonly<{ ipv4: number; ipv6: number }> = { ipv4: 16, ipv6: 48 };

export function cidrProblem(s: string, widest: Readonly<{ ipv4: number; ipv6: number }>): string | null {
  const net = parseCidr(s);
  if (!net) return "use address/length notation with no host bits set beyond the mask";
  const whole = wholeNetworkProblem(net);
  if (whole) return whole;
  return net.bits < widest[net.family] ? `broader than /${widest[net.family]}` : null;
}

function networksForm(v: unknown, widest: Readonly<{ ipv4: number; ipv6: number }>): string[] {
  for (const s of v as string[]) {
    const why = cidrProblem(s, widest);
    if (why) return [`${JSON.stringify(s.slice(0, 80))}: ${why} (use a network like 192.0.2.0/24 no broader than /${widest.ipv4}, or 2001:db8::/48 no broader than /${widest.ipv6})`];
  }
  return unique(v);
}

export const SPRAY_THRESHOLDS = "spray_thresholds";

export const sprayThresholdProblems: CrossCheck = (ctx) => {
  const alert = ctx.future("edge.spray_alert_accounts_10min"), pause = ctx.future("edge.spray_pause_accounts_10min");
  if (!ctx.changed.has("edge.spray_alert_accounts_10min") && !ctx.changed.has("edge.spray_pause_accounts_10min")) return [];
  if (typeof alert !== "number" || typeof pause !== "number" || pause >= alert) return [];
  return [{ key: "edge.spray_pause_accounts_10min", code: SPRAY_THRESHOLDS,
            message: `the automatic pause threshold (${pause}) is lower than the alert threshold (${alert}), so the pause would come before the alert` }];
};

registerCrossCheck(sprayThresholdProblems);

export const RUN_MODE_USER = "run_mode_user";
export const HEARTBEAT_FRESH_SEC = 120;
export const RUN_MODES_ALLOWED: readonly RunMode[] = RUN_MODES.filter((m) => m !== "user");

export const RUN_MODE_FLAGS: Readonly<Record<string, string>> = {
  // [P0]
  "edge.export_enabled": "exporter",
  "edge.login_enabled": "memory-authcheck",
  "edge.synthetic_login_enabled": "memory-probe",
  "edge.probe_enabled": "memory-probe",
  "edge.c2_enabled": "intake",
  // [S2-3]
  // [4]
  // [E2]
  // [5]
};

const RUN_MODE_TEXT = "the service enabled by this setting is running in user mode or has been unresponsive for some time. External access requires running the services in containers";

export const runModeProblems: CrossCheck = async (ctx) => {
  const turningOn = Object.entries(RUN_MODE_FLAGS).filter(([flag]) => ctx.future(flag) === true && ctx.current(flag) !== true);
  if (!turningOn.length) return [];
  const beats = new Map<string, { run_mode: string; fresh: boolean }>();
  const { rows: [t] } = await ctx.db.query("SELECT to_regclass('service_heartbeats') IS NOT NULL AS ok");
  if (t?.ok) {
    const { rows } = await ctx.db.query(
      "SELECT service, run_mode, at >= now() - make_interval(secs => $2::int) AS fresh FROM service_heartbeats WHERE instance_id = $1",
      [ctx.instanceId, HEARTBEAT_FRESH_SEC]);
    for (const r of rows as Array<{ service: string; run_mode: string; fresh: boolean }>) beats.set(r.service, r);
  }
  const out: SettingProblem[] = [];
  for (const [flag, service] of turningOn) {
    const hb = beats.get(service);
    if (hb && hb.fresh && (RUN_MODES_ALLOWED as readonly string[]).includes(hb.run_mode)) continue;
    out.push({ key: flag, code: RUN_MODE_USER, message: `${RUN_MODE_TEXT} (service ${service})` });
  }
  return out;
};

registerCrossCheck(runModeProblems);

export const QUOTA_KINDS = ["search", "read", "list", "text_tokens", "originals", "originals_mib", "c2_items", "c2_mib"] as const;
export const QUOTA_DAILY_MAX: Readonly<Record<(typeof QUOTA_KINDS)[number], number>> = {
  search: 1_000_000, read: 1_000_000, list: 1_000_000, text_tokens: 1_000_000_000,
  originals: 100_000, originals_mib: 1_000_000, c2_items: 100_000, c2_mib: 100_000,
};

/**
 * An IANA time zone name (Area/City or UTC): the same form as in edge-meta.schema.json (the edge checks it too), known to Node.
 * null means valid.
 */
export function timeZoneProblem(tz: unknown): string | null {
  if (typeof tz !== "string" || tz.length > 64 || !/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz)) return "tz: an IANA time zone name such as UTC or Area/City";
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { return `tz: unknown time zone ${JSON.stringify(tz.slice(0, 64))}`; }
  return null;
}

function quotaDailyProblems(v: unknown): string[] {
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== "tz" && !(QUOTA_KINDS as readonly string[]).includes(k));
  if (extra.length) return [`unexpected fields: ${extra.join(", ")}`];
  const out = QUOTA_KINDS.flatMap((k) => {
    const x = o[k];
    return typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= QUOTA_DAILY_MAX[k] ? [] : [`${k}: an integer from 0 to ${QUOTA_DAILY_MAX[k]}`];
  });
  const tz = timeZoneProblem(o.tz);
  return tz ? [...out, tz] : out;
}

function workHoursProblems(v: unknown): string[] {
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== "weekdays" && k !== "tz");
  if (extra.length) return [`unexpected fields: ${extra.join(", ")}`];
  const out: string[] = [];
  const m = typeof o.weekdays === "string" ? /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(o.weekdays) : null;
  if (!m || Number(m[1]) * 60 + Number(m[2]) >= Number(m[3]) * 60 + Number(m[4])) out.push("weekdays: “09:00-19:00” — start must come before end");
  const tz = "tz" in o ? timeZoneProblem(o.tz) : null;
  return tz ? [...out, tz] : out;
}

function isHttpsUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "https:" && u.hostname !== "" && u.username === "" && u.password === "";
  } catch { return false; }
}

function isConnectAddress(s: string): boolean {
  const v6 = /^\[([0-9A-Fa-f:.]+)\](?::(\d{1,5}))?$/.exec(s);
  const portOk = (p: string | undefined) => p === undefined || (Number(p) >= 1 && Number(p) <= 65535);
  if (v6) return isIP(v6[1]!) === 6 && portOk(v6[2]);
  if (s.includes("%")) return false;
  if (isIP(s) === 6) return true;
  const m = /^([A-Za-z0-9.-]{1,253})(?::(\d{1,5}))?$/.exec(s);
  if (!m || !portOk(m[2])) return false;
  return isIP(m[1]!) === 4 || m[1]!.split(".").every((l) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(l));
}

const isDnsName = (s: string): boolean =>
  isIP(s) === 0 && s.length <= 253 && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(s);

const isLoginName = (s: string): boolean => /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/.test(s) || /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(s);

const isAbsolutePath = (s: string): boolean =>
  s.startsWith("/") && s.length > 1 && !/[\u0000-\u001f]/.test(s) && s.slice(1).split("/").every((p) => p !== "" && p !== "." && p !== "..");

function issuerLabelProblems(s: string): string[] {
  if (s.trim() === "") return ["nonempty name"];
  if (s.includes(":") || /[\u0000-\u001f]/.test(s)) return ["no colons or control characters"];
  return [];
}

export const EXTERNAL_LOGIN_LDAP_TLS = "external_login_ldap_tls";

const LDAP_TLS_CHECK_KEYS: readonly string[] = [...LOGIN_FLAGS, ...LDAP_CHANNEL_KEYS];

const LDAP_TLS_OPEN_TEXT: Readonly<Record<LdapChannelReason, string>> = {
  ldaps_required: "Sign-in from outside is unavailable while “LDAPS only” (edge.ldap_require_ldaps) is on and directory sign-in does not use LDAPS. Enable LDAPS under “Sign-in and LDAP” or turn off “LDAPS only”",
  plain_unacknowledged: "Sign-in from outside is unavailable while directory sign-in is unencrypted and “I understand the risk” is unchecked. Enable LDAPS or StartTLS under “Sign-in and LDAP”, or acknowledge the risk",
  plain_in_advanced: "In advanced mode, sign-in from outside requires encrypted directory sign-in. Enable LDAPS under “Sign-in and LDAP”",
};
const LDAP_TLS_KEEP_TEXT: Readonly<Record<LdapChannelReason, string>> = {
  ldaps_required: "While sign-in from outside and “LDAPS only” (edge.ldap_require_ldaps) are enabled, directory sign-in requires LDAPS. Turn off sign-in from outside or “LDAPS only” first",
  plain_unacknowledged: "While sign-in from outside is enabled, you must acknowledge the risk to use unencrypted directory sign-in. Acknowledge it or turn off sign-in from outside first",
  plain_in_advanced: "In advanced mode, sign-in from outside requires encrypted directory sign-in. Turn off sign-in from outside first",
};

export const externalLoginLdapTlsProblems: CrossCheck = (ctx) => {
  if (!LDAP_TLS_CHECK_KEYS.some((k) => ctx.changed.has(k))) return [];
  const on = LOGIN_FLAGS.filter((f) => ctx.future(f) === true);
  if (!on.length) return [];
  const v = ldapChannelOf(ctx.future, gateModeOf(ctx.future("security.mode")));
  if (v.level !== "refuse") return [];
  const reason = v.reason ?? "ldaps_required";
  const opening = on.find((f) => ctx.changed.has(f) && ctx.current(f) !== true);
  if (opening) return [{ key: opening, code: EXTERNAL_LOGIN_LDAP_TLS, message: LDAP_TLS_OPEN_TEXT[reason] }];
  const key = LDAP_CHANNEL_KEYS.find((k) => ctx.changed.has(k)) ?? on[0];
  return [{ key, code: EXTERNAL_LOGIN_LDAP_TLS, message: LDAP_TLS_KEEP_TEXT[reason] }];
};

registerCrossCheck(externalLoginLdapTlsProblems);

export const PROBE_NO_CONNECT_ADDR = "probe_no_connect_addr";

const PROBE_FLAGS = ["edge.probe_enabled", "edge.synthetic_login_enabled"] as const;
const PROBE_ADDR = "edge.probe_connect_addr";

export const probeConnectProblems: CrossCheck = (ctx) => {
  if (!ctx.changed.has(PROBE_ADDR) && !PROBE_FLAGS.some((f) => ctx.changed.has(f))) return [];
  const addr = ctx.future(PROBE_ADDR);
  if (typeof addr === "string" && addr.trim() !== "") return [];
  const on = PROBE_FLAGS.filter((f) => ctx.future(f) === true);
  if (!on.length) return [];
  const turnedOn = on.filter((f) => ctx.changed.has(f));
  const keys: string[] = turnedOn.length ? turnedOn : ctx.changed.has(PROBE_ADDR) ? [PROBE_ADDR] : [];
  return keys.map((key) => ({ key, code: PROBE_NO_CONNECT_ADDR, message: key === PROBE_ADDR
    ? "The shared proxy has no external address. You cannot clear its address while the probe or synthetic sign-in is enabled. Turn them off first"
    : "The shared proxy has no external address. Set “External listener for the shared proxy” (row 13 in the IT list) to enable the probe and synthetic sign-in. Without it, run probes from an external machine" }));
};

registerCrossCheck(probeConnectProblems);

export const externalGateProblems: CrossCheck = (ctx) =>
  gateWouldBreak(ctx.future, ctx.current, ctx.changed, gateModeOf(ctx.future("security.mode"))).map((x) => ({
    key: x.key, code: EXTERNAL_GATE_WOULD_BREAK, message: `${EXTERNAL_GATE_WOULD_BREAK_TEXT} (${x.flag}, condition ${x.condition})`,
  }));

registerCrossCheck(externalGateProblems);

export const MFA_MODE_BELOW_FLOOR = "mfa_mode_below_floor";
const MFA_MODE_ORDER = ["off", "optional", "required"] as const;
const MFA_MODE_TEXT: Readonly<Record<string, string>> = { off: "“Off”", optional: "“Optional”", required: "“Required”" };

export const mfaModeFloorProblems: CrossCheck = async (ctx) => {
  if (!ctx.changed.has("edge.mfa_mode")) return [];
  const want = ctx.future("edge.mfa_mode");
  const { rows: [t] } = await ctx.db.query(
    `SELECT to_regprocedure('mfa_mode_floor(text)') IS NOT NULL
            AND has_function_privilege(to_regprocedure('mfa_mode_floor(text)'), 'EXECUTE') AS ok`);
  if (!(t as { ok?: boolean } | undefined)?.ok) return [];
  const { rows: [f] } = await ctx.db.query("SELECT mfa_mode_floor($1) AS f", [ctx.instanceId]);
  const floor = String((f as { f?: unknown } | undefined)?.f ?? "off");
  const rank = (m: unknown): number => { const i = (MFA_MODE_ORDER as readonly unknown[]).indexOf(m); return i < 0 ? MFA_MODE_ORDER.length - 1 : i; };
  if (rank(want) >= rank(floor)) return [];
  return [{ key: "edge.mfa_mode", code: MFA_MODE_BELOW_FLOOR,
            message: `the mode cannot be lower than ${MFA_MODE_TEXT[floor] ?? floor}. The signed edge anchors set that minimum` }];
};

registerCrossCheck(mfaModeFloorProblems);
