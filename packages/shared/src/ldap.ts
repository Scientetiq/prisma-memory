import { createHash, X509Certificate } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { connect as netConnect, isIP } from "node:net";
import { connect as tlsConnect, type ConnectionOptions, type PeerCertificate, type TLSSocket } from "node:tls";
import { AndFilter, Client, EqualityFilter, InvalidCredentialsError, InvalidDNSyntaxError, NoSuchObjectError, ResultCodeError, StrongAuthRequiredError } from "ldapts";
import { log } from "./log.ts";
import { refusedKind, type RefusedAddressKind } from "./models/address.ts";
import { oidcAddressKind } from "./oidc.ts";
import type { Settings } from "./settings.ts";

export type LdapTlsMode = "ldaps" | "starttls" | "none";
export const LDAP_TLS_MODES: readonly LdapTlsMode[] = ["ldaps", "starttls", "none"];
export interface LdapAttributes { account: string; mail: string; name: string; department: string; groups: string; guid: string; employee_id: string; title: string; given_name: string }
export interface LdapConfig {
  enabled: boolean; servers: string[]; port: number; tls_mode: LdapTlsMode; insecure_ack: boolean; ca_cert: string; tls_server_name: string;
  bind_dn: string; bind_password: string; base_dn: string; user_filter: string; login_groups: string[]; nested_groups: boolean; domains: string[];
  attributes: LdapAttributes; connect_timeout_sec: number; timeout_sec: number; max_failures_per_ip: number; max_failures_per_login: number;
  failure_window_minutes: number;
  group_sync_minutes: number; group_max_members: number; project_groups_base: string;
  /**
   * Hours after the last successful verification of a group after which its members lose the membership
   * (LDAP_GROUP_STALE_HOURS; 0 — never, the old behaviour). Absent in a config built by hand — the default.
   */
  group_stale_hours?: number;
  bind_password_rev?: string;
}
export const LDAP_DEFAULT_ATTRIBUTES: LdapAttributes = {
  account: "sAMAccountName", mail: "mail", name: "displayName", department: "department", groups: "memberOf", guid: "objectGUID", employee_id: "employeeID",
  title: "title",
  given_name: "givenName",
};
export const LDAP_FAILURE_WINDOW_MINUTES = { min: 5, max: 1440, default: 30 } as const;
export const LDAP_MAX_FAILURES_PER_LOGIN_DEFAULT = 2;
/** Range and default of ldap.group_stale_hours (0 — membership from directory groups never expires). */
export const LDAP_GROUP_STALE_HOURS = { min: 0, max: 720, default: 24 } as const;
/**
 * The shortest expiry for a sync period of `minutes` — two periods plus an hour, in whole hours. Two periods
 * exactly tolerated no failed or skipped sync: the next sync is counted from the end of the previous one, so the schedule
 * slips a tick per period, and one failure (or one key skipped under another process's lock) removed every group member
 * for a tick while the directory was healthy.
 */
export const groupStaleMinHours = (minutes: number): number => Math.ceil((2 * minutes + 60) / 60);

export function ldapFailureWindowMs(cfg: Partial<Pick<LdapConfig, "failure_window_minutes">>): number {
  const { min, max, default: d } = LDAP_FAILURE_WINDOW_MINUTES;
  const m = Number(cfg.failure_window_minutes);
  return (Number.isFinite(m) ? Math.min(max, Math.max(min, m)) : d) * 60_000;
}

export function ldapFailureBudget(threshold: number): number | null {
  if (!(Number.isInteger(threshold) && threshold >= 0)) throw new RangeError("AD lockout threshold must be an integer ≥ 0");
  return threshold === 0 ? null : Math.max(0, threshold - Math.max(2, Math.ceil(threshold / 3)));
}

export const LDAP_DEFAULT_FILTER = "(&(objectCategory=person)(objectClass=user)(|(sAMAccountName={account})(userPrincipalName={upn})(mail={upn})))";
export const LDAP_IDENTITY_KEYS = new Set(["enabled", "servers", "port", "tls_mode", "ca_cert", "tls_server_name", "base_dn", "user_filter", "login_groups", "nested_groups", "domains", "attributes"]);

export function ldapConfig(s: Pick<Settings, "get">): LdapConfig {
  const str = (k: string, d = "") => { const v = s.get<unknown>(`ldap.${k}`, d); return typeof v === "string" ? v.trim() : d; };
  const num = (k: string, d: number) => { const v = Number(s.get<unknown>(`ldap.${k}`, d)); return Number.isFinite(v) ? v : d; };
  const list = (k: string) => { const v = s.get<unknown>(`ldap.${k}`, []); return Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean) : []; };
  const attrs = s.get<Partial<LdapAttributes>>("ldap.attributes", LDAP_DEFAULT_ATTRIBUTES);
  const mode = str("tls_mode", "ldaps") as LdapTlsMode;
  return {
    enabled: s.get<unknown>("ldap.enabled", false) === true, servers: list("servers"), port: num("port", 0),
    tls_mode: LDAP_TLS_MODES.includes(mode) ? mode : "ldaps", insecure_ack: s.get<unknown>("ldap.insecure_ack", false) === true,
    ca_cert: str("ca_cert"), tls_server_name: str("tls_server_name"), bind_dn: str("bind_dn"),
    bind_password: typeof s.get<unknown>("ldap.bind_password", "") === "string" ? String(s.get<unknown>("ldap.bind_password", "")) : "",
    base_dn: str("base_dn"), user_filter: str("user_filter", LDAP_DEFAULT_FILTER) || LDAP_DEFAULT_FILTER, login_groups: list("login_groups"),
    nested_groups: s.get<unknown>("ldap.nested_groups", false) === true, domains: list("domains"),
    attributes: Object.fromEntries(Object.entries(LDAP_DEFAULT_ATTRIBUTES).map(([k, d]) => [k, typeof attrs?.[k as keyof LdapAttributes] === "string" && attrs[k as keyof LdapAttributes]!.trim() ? attrs[k as keyof LdapAttributes]!.trim() : d])) as unknown as LdapAttributes,
    connect_timeout_sec: num("connect_timeout_sec", 5), timeout_sec: num("timeout_sec", 10),
    max_failures_per_ip: num("max_failures_per_ip", 5), max_failures_per_login: num("max_failures_per_login", LDAP_MAX_FAILURES_PER_LOGIN_DEFAULT),
    failure_window_minutes: num("failure_window_minutes", LDAP_FAILURE_WINDOW_MINUTES.default),
    group_sync_minutes: num("group_sync_minutes", 15), group_max_members: num("group_max_members", 500), project_groups_base: str("project_groups_base"),
    group_stale_hours: num("group_stale_hours", LDAP_GROUP_STALE_HOURS.default),
  };
}

/**
 * The expiry in force, in hours; 0 — nothing expires. Off when the setting is 0, and while the directory is on but
 * the periodic sync is off (ldap.group_sync_minutes = 0, "only by the button and at sign-in"): such an install would
 * otherwise lose every group member N hours after the last button press. A switched-off directory does expire — nobody
 * verifies membership any more. Never shorter than two sync periods plus an hour (groupStaleMinHours), even for a value
 * saved past ldapProblems.
 */
export function groupStaleHours(cfg: Pick<LdapConfig, "enabled" | "group_sync_minutes" | "group_stale_hours">): number {
  const raw = cfg.group_stale_hours ?? LDAP_GROUP_STALE_HOURS.default;
  const h = Number.isFinite(raw) ? Math.min(LDAP_GROUP_STALE_HOURS.max, Math.ceil(raw)) : LDAP_GROUP_STALE_HOURS.default;
  if (!(h > 0)) return 0;
  const m = Number.isFinite(cfg.group_sync_minutes) ? cfg.group_sync_minutes : 0;
  if (cfg.enabled && !(m > 0)) return 0;
  return cfg.enabled ? Math.max(h, groupStaleMinHours(m)) : h;
}

/**
 * "Valid until" of one group binding — its last verification (synced_at; never synced — its creation) plus the
 * expiry in force; stale — that moment has passed. hours = 0 — no term (null, never stale).
 */
export function groupValidity(b: { synced_at: string | Date | null; created_at: string | Date }, hours: number, now = Date.now()): { stale: boolean; valid_until: string | null } {
  if (!(hours > 0)) return { stale: false, valid_until: null };
  const until = new Date(new Date(b.synced_at ?? b.created_at).getTime() + hours * 3_600_000);
  return { stale: until.getTime() < now, valid_until: until.toISOString() };
}

export const ldapPort = (cfg: Pick<LdapConfig, "port" | "tls_mode">): number => (cfg.port > 0 ? cfg.port : cfg.tls_mode === "ldaps" ? 636 : 389);

const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const ATTR_RE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const DOMAIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

export function parseCaCerts(pem: string): X509Certificate[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (!blocks.length) throw new Error("missing -----BEGIN CERTIFICATE----- block");
  return blocks.map((b) => new X509Certificate(b));
}

/**
 * repair: the problems that stop a directory call — ldapProblems without the rule of ldap.group_stale_hours. That
 * rule (range; two sync periods plus an hour) guards saving the section; a stored pair that misses it (an earlier build, a
 * direct database edit) must not lock the sign-in, the lookups and the group sync — groupStaleHours clamps the expiry.
 */
export function ldapConnectProblems(cfg: LdapConfig): Array<{ key: string; message: string }> {
  return ldapProblems(cfg).filter((p) => p.key !== "group_stale_hours");
}

export function ldapProblems(cfg: LdapConfig): Array<{ key: string; message: string }> {
  const out: Array<{ key: string; message: string }> = [];
  const bad = (key: string, message: string) => out.push({ key, message });
  if (cfg.servers.length > 8) bad("servers", "at most 8 controllers");
  for (const h of cfg.servers) if (!isIP(h) && !HOST_RE.test(h)) bad("servers", `“${h.slice(0, 80)}” is neither a hostname nor an IP address. Enter the port separately`);
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) bad("port", "port must be an integer from 1 to 65535; 0 selects the mode default (636 for LDAPS, 389 for StartTLS or no encryption)");
  if (cfg.tls_mode === "none" && !cfg.insecure_ack) bad("insecure_ack", "without encryption, passwords travel as plain text: acknowledge the risk or choose LDAPS or StartTLS");
  if (cfg.ca_cert) { try { parseCaCerts(cfg.ca_cert); } catch (e) { bad("ca_cert", `could not parse the root certificate: ${(e as Error).message}`); } }
  if (cfg.tls_server_name && !HOST_RE.test(cfg.tls_server_name)) bad("tls_server_name", "the name in the certificate — a host name (for example, dc1.example.com)");
  if (/[\r\n]/.test(cfg.bind_dn) || cfg.bind_dn.length > 1024) bad("bind_dn", "the service account DN must be one line, at most 1024 characters");
  if (/[\r\n]/.test(cfg.base_dn) || cfg.base_dn.length > 1024) bad("base_dn", "base DN must be one line, at most 1024 characters");
  if (cfg.base_dn && !cfg.base_dn.includes("=")) bad("base_dn", "base DN — of the form DC=example,DC=com or OU=Users,DC=example,DC=com");
  const f = cfg.user_filter;
  if (f.length > 2000 || !f.startsWith("(") || !f.endsWith(")") || !balanced(f)) bad("user_filter", "the filter must be one LDAP expression with balanced parentheses");
  if (!/\{(account|username|upn)\}/.test(f)) bad("user_filter", "the filter needs an {account} (short name) or {upn} (name as entered) placeholder");
  if (cfg.login_groups.length > 20) bad("login_groups", "at most 20 access groups");
  for (const g of cfg.login_groups) if (g.length > 1024 || /[\r\n]/.test(g)) bad("login_groups", "each group must be a DN or name (CN) on one line, at most 1024 characters");
  for (const d of cfg.domains) if (!DOMAIN_RE.test(d)) bad("domains", `“${d.slice(0, 80)}” — not a domain (example.com) and not a NetBIOS name (EXAMPLE)`);
  for (const [k, v] of Object.entries(cfg.attributes)) if (!ATTR_RE.test(v)) bad("attributes", `attribute ${k}: “${v.slice(0, 40)}” must be an LDAP attribute name (Latin letters, digits and hyphens)`);
  if (!(cfg.connect_timeout_sec >= 1 && cfg.connect_timeout_sec <= 60)) bad("connect_timeout_sec", "connection timeout must be 1–60 seconds");
  if (!(cfg.timeout_sec >= 1 && cfg.timeout_sec <= 120)) bad("timeout_sec", "operation timeout must be 1–120 seconds");
  if (!(Number.isInteger(cfg.max_failures_per_ip) && cfg.max_failures_per_ip >= 1 && cfg.max_failures_per_ip <= 100)) bad("max_failures_per_ip", "attempts per address must be an integer from 1 to 100 per failed sign-in window");
  if (!(Number.isInteger(cfg.max_failures_per_login) && cfg.max_failures_per_login >= 1 && cfg.max_failures_per_login <= 20)) bad("max_failures_per_login", "attempts per login must be an integer from 1 to 20 per failed sign-in window, below the AD lockout threshold");
  { const { min, max } = LDAP_FAILURE_WINDOW_MINUTES;
    if (!(Number.isInteger(cfg.failure_window_minutes) && cfg.failure_window_minutes >= min && cfg.failure_window_minutes <= max))
      bad("failure_window_minutes", `failed sign-in window: an integer from ${min} to ${max} minutes, at least as long as the AD lockout window`); }
  if (!(Number.isInteger(cfg.group_sync_minutes) && cfg.group_sync_minutes >= 0 && cfg.group_sync_minutes <= 1440)) bad("group_sync_minutes", "group verification must be an integer from 0 to 1440 minutes; 0 checks only on sign-in or with the button");
  if (!(Number.isInteger(cfg.group_max_members) && cfg.group_max_members >= 1 && cfg.group_max_members <= 5000)) bad("group_max_members", "maximum group size must be an integer from 1 to 5000 people");
  if (/[\r\n]/.test(cfg.project_groups_base) || cfg.project_groups_base.length > 1024) bad("project_groups_base", "the group branch must be one line, at most 1024 characters");
  // expiry of group membership without verification — whole hours; with a periodic sync it is at least two sync
  // periods plus an hour (groupStaleMinHours), otherwise one failed sync would expire every group (an invalid sync period
  // is reported on its own key)
  if (cfg.group_stale_hours !== undefined) {
    const { min, max } = LDAP_GROUP_STALE_HOURS, h = cfg.group_stale_hours, m = cfg.group_sync_minutes;
    if (!(Number.isInteger(h) && h >= min && h <= max)) bad("group_stale_hours", `membership expiry — whole hours ${min}–${max}; 0 — membership from directory groups never expires`);
    else if (h > 0 && Number.isInteger(m) && m > 0 && m <= 1440 && h < groupStaleMinHours(m))
      bad("group_stale_hours", `membership expiry must cover two sync periods plus an hour: ${h} h is shorter than 2 × ldap.group_sync_minutes = ${m} min + 60 min (set at least ${groupStaleMinHours(m)} h, or 0 — never)`);
  }
  if (cfg.project_groups_base && !cfg.project_groups_base.includes("=")) bad("project_groups_base", "group branch — a DN like OU=Projects,DC=example,DC=com; empty — any group under the base DN");
  if (cfg.enabled) {
    if (!cfg.servers.length) bad("servers", "at least one controller is required");
    if (!cfg.bind_dn) bad("bind_dn", "the service account DN is required");
    if (!cfg.bind_password) bad("bind_password", "the service account password is required");
    if (!cfg.base_dn) bad("base_dn", "base DN is required");
    if (!cfg.login_groups.length) bad("login_groups", "an access group (memory-users) is required; without it nobody can sign in");
  }
  return out;
}

function balanced(f: string): boolean {
  let depth = 0;
  for (let i = 0; i < f.length; i++) {
    if (f[i] === "\\") { i++; continue; }
    if (f[i] === "(") depth++;
    else if (f[i] === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

export interface LoginName { account: string; upn: string; domain: string | null; form: "account" | "upn" | "netbios" }
const ACCOUNT_RE = /^[A-Za-z0-9._'+-]{1,64}$/;

export function parseLoginName(raw: string): LoginName | null {
  const s = String(raw ?? "").trim();
  if (!s || s.length > 256 || !/^[\x21-\x7e]+$/.test(s)) return null;
  const bs = s.split("\\");
  if (bs.length === 2) {
    const [domain = "", account = ""] = bs;
    return DOMAIN_RE.test(domain) && ACCOUNT_RE.test(account) ? { account, upn: s, domain, form: "netbios" } : null;
  }
  if (bs.length > 2) return null;
  const at = s.split("@");
  if (at.length === 2) {
    const [account = "", domain = ""] = at;
    return DOMAIN_RE.test(domain) && ACCOUNT_RE.test(account) ? { account, upn: s, domain, form: "upn" } : null;
  }
  if (at.length > 2) return null;
  return ACCOUNT_RE.test(s) ? { account: s, upn: s, domain: null, form: "account" } : null;
}

export const loginKey = (n: LoginName): string => n.account.toLowerCase();

export const domainAllowed = (cfg: Pick<LdapConfig, "domains">, n: LoginName): boolean =>
  !n.domain || !cfg.domains.length || cfg.domains.some((d) => d.toLowerCase() === n.domain!.toLowerCase());

export const escapeFilterValue = (v: string): string =>
  v.replace(/[\\*()\u0000]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, "0")}`);

export const renderUserFilter = (filter: string, n: LoginName): string =>
  filter.split("{account}").join(escapeFilterValue(n.account)).split("{username}").join(escapeFilterValue(n.account)).split("{upn}").join(escapeFilterValue(n.upn));

export function formatObjectGuid(b: Buffer): string | null {
  if (b.length !== 16) return null;
  const rev = (x: Buffer) => Buffer.from(x).reverse().toString("hex");
  return `${rev(b.subarray(0, 4))}-${rev(b.subarray(4, 6))}-${rev(b.subarray(6, 8))}-${b.subarray(8, 10).toString("hex")}-${b.subarray(10, 16).toString("hex")}`;
}

const splitDn = (dn: string): string[] => dn.split(/(?<!\\),/).map((p) => p.trim());
const unescapeDnValue = (v: string): string =>
  v.replace(/\\([0-9a-fA-F]{2})|\\(.)/g, (_m, hex: string | undefined, ch: string | undefined) => (hex ? String.fromCharCode(parseInt(hex, 16)) : ch ?? ""));
export const normalizeDn = (dn: string): string => splitDn(dn).map((p) => p.replace(/\s*=\s*/, "=")).join(",").toLowerCase();
export const firstRdnValue = (dn: string): string => unescapeDnValue((splitDn(dn)[0] ?? "").replace(/^[^=]*=\s*/, "")).trim();

export function matchGroups(memberOf: string[], wanted: string[]): string[] {
  const dns = new Set(memberOf.map(normalizeDn)), cns = new Set(memberOf.map((g) => firstRdnValue(g).toLowerCase()));
  return wanted.filter((w) => (w.includes("=") ? dns.has(normalizeDn(w)) : cns.has(w.trim().toLowerCase())));
}

export type LdapFailureCode =
  | "ldap_disabled" | "ldap_not_configured" | "ldap_dns_failed" | "ldap_unreachable" | "ldap_tls_failed"
  | "ldap_service_bind_failed" | "ldap_base_dn_invalid" | "ldap_search_failed" | "ldap_timeout" | "ldap_attribute_missing";

export const LDAP_FAILURE_TEXT: Record<LdapFailureCode, string> = {
  ldap_disabled: "Company directory sign-in is disabled. The memory administrator can enable it under “Sign-in and LDAP” in the admin panel",
  ldap_not_configured: "Directory sign-in is not fully configured. The administrator can check “Sign-in and LDAP” in the admin panel",
  ldap_dns_failed: "The memory server cannot resolve the directory controller hostname. Enter the controller IP addresses and certificate verification name, or configure DNS on the memory server",
  ldap_unreachable: "The memory server cannot reach the directory controllers. Check the address, port and network access from the memory server",
  ldap_tls_failed: "A secure directory connection could not be established. Check the encryption mode, root certificate and certificate name",
  ldap_service_bind_failed: "The directory rejected the memory service account. Check its DN and password under “Sign-in and LDAP”",
  ldap_base_dn_invalid: "The configured base DN does not exist in the directory. Check it under “Sign-in and LDAP”",
  ldap_search_failed: "The directory could not search for the person. Check the “Who can sign in” filter and service account permissions",
  ldap_timeout: "The directory timed out. Check controller availability and timeouts under “Sign-in and LDAP”",
  ldap_attribute_missing: "The directory did not return a required attribute. Check the attribute names under “Sign-in and LDAP”",
};

export class LdapFailure extends Error {
  unansweredBind?: { settled: Promise<void> };
  resultCode?: number;
  adSubcode?: string | null;
  constructor(readonly code: LdapFailureCode, readonly detail: string) { super(LDAP_FAILURE_TEXT[code]); }
}

export const clientText = (e: unknown): string =>
  String((e as Error)?.message ?? e ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 500);

export function adBindSubcode(e: unknown): string | null {
  return /\bdata ([0-9a-f]{3,4})\b/i.exec(String((e as Error)?.message ?? ""))?.[1]?.toLowerCase() ?? null;
}
export const AD_SUBCODE_TEXT: Record<string, string> = {
  "525": "account not found", "52e": "incorrect password", "530": "sign-in is blocked at this time", "531": "sign-in from this machine is blocked",
  "532": "password expired", "533": "account disabled", "701": "account expired", "773": "password change required", "775": "account locked",
};

const TLS_CODE = /CERT|TLS|SSL|SELF_SIGNED|ALTNAME|UNABLE_TO|EPROTO|HANDSHAKE/i;
const NET_CODE = /^(ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNRESET|EADDRNOTAVAIL|EPIPE)$/;

function transportFailure(e: unknown): LdapFailure {
  const err = e as { code?: string; message?: string };
  const text = clientText(e);
  if (TLS_CODE.test(err.code ?? "") || /certificate|secure TLS|ssl|tls/i.test(text)) return new LdapFailure("ldap_tls_failed", text);
  if (NET_CODE.test(err.code ?? "") || /Connection timeout|socket/i.test(text)) return new LdapFailure("ldap_unreachable", text);
  if (/timeout/i.test(text)) return new LdapFailure("ldap_timeout", text);
  return new LdapFailure("ldap_unreachable", text);
}

export interface LdapTarget { host: string; address: string; port: number }
export interface Resolution { reachable: LdapTarget[]; unreachable: Array<LdapTarget & { error: string }>; dnsFailed: Array<{ host: string; error: string }> }
export interface LdapTransport {
  lookup(host: string): Promise<Array<{ address: string; family: number }>>;
  probe(address: string, port: number, timeoutMs: number): Promise<void>;
}
export const systemTransport: LdapTransport = {
  lookup: (host) => dnsLookup(host, { all: true, verbatim: true }),
  probe: (address, port, timeoutMs) => new Promise<void>((resolve, reject) => {
    const s = netConnect({ host: address, port });
    const done = (err?: Error) => { clearTimeout(t); s.destroy(); err ? reject(err) : resolve(); };
    const t = setTimeout(() => done(Object.assign(new Error(`TCP ${address}:${port}: no response within ${timeoutMs} ms`), { code: "ETIMEDOUT" })), timeoutMs);
    s.once("connect", () => done());
    s.once("error", (e) => done(e));
  }),
};

export function ldapRefusedKind(address: string): RefusedAddressKind | null {
  if (!isIP(address)) return "invalid";
  // An IPv6 interface zone leaves the address class unchanged. Use the underlying network class for unspecified IPv4.
  const ip = address.split("%", 1)[0]!;
  return refusedKind(oidcAddressKind(ip));
}

export async function resolveTargets(cfg: LdapConfig, t: LdapTransport = systemTransport): Promise<Resolution> {
  const port = ldapPort(cfg), out: Resolution = { reachable: [], unreachable: [], dnsFailed: [] };
  const perHost = await Promise.all(cfg.servers.map(async (host) => {
    try {
      const family = isIP(host);
      const xs = family ? [{ address: host, family }] : await t.lookup(host);
      for (const { address } of xs) {
        const kind = ldapRefusedKind(address);
        if (kind !== null) {
          out.dnsFailed.push({ host, error: `address_refused:${kind}` });
          return { host, addrs: [] };
        }
      }
      return { host, addrs: [...xs.filter((x) => x.family === 4), ...xs.filter((x) => x.family !== 4)].map((x) => x.address).filter((a, i, all) => all.indexOf(a) === i) };
    } catch (e) {
      out.dnsFailed.push({ host, error: clientText(e) });
      return { host, addrs: [] as string[] };
    }
  }));
  const probes = perHost.flatMap(({ host, addrs }) => addrs.map((address) => ({ host, address, port })));
  const results = await Promise.all(probes.map((p) => t.probe(p.address, p.port, cfg.connect_timeout_sec * 1000).then(() => null, (e: unknown) => clientText(e))));
  probes.forEach((p, i) => (results[i] === null ? out.reachable.push(p) : out.unreachable.push({ ...p, error: results[i]! })));
  return out;
}

function noTargets(r: Resolution): LdapFailure {
  if (!r.unreachable.length && r.dnsFailed.length) return new LdapFailure("ldap_dns_failed", r.dnsFailed.map((d) => `${d.host}: ${d.error}`).join("; "));
  return new LdapFailure("ldap_unreachable", [...r.unreachable.map((u) => `${u.address}:${u.port} (${u.host}): ${u.error}`), ...r.dnsFailed.map((d) => `${d.host}: ${d.error}`)].join("; ") || "no controllers are configured");
}

export function tlsOptionsFor(cfg: LdapConfig, target: LdapTarget): ConnectionOptions {
  const name = isIP(target.host) ? cfg.tls_server_name || undefined : target.host;
  return {
    host: target.address, ...(name ? { servername: name } : {}), rejectUnauthorized: true, minVersion: "TLSv1.2",
    ...(cfg.ca_cert ? { ca: parseCaCerts(cfg.ca_cert).map((c) => c.toString()) } : {}),
  };
}

const urlOf = (cfg: LdapConfig, t: LdapTarget): string => `${cfg.tls_mode === "ldaps" ? "ldaps" : "ldap"}://${isIP(t.address) === 6 ? `[${t.address}]` : t.address}:${t.port}`;

/**
 * @internal — for ldap-account.ts.
 */
export async function openClient(cfg: LdapConfig, target: LdapTarget): Promise<Client> {
  const tls = cfg.tls_mode === "none" ? undefined : tlsOptionsFor(cfg, target);
  const client = new Client({
    url: urlOf(cfg, target), timeout: cfg.timeout_sec * 1000, connectTimeout: cfg.connect_timeout_sec * 1000,
    ...(cfg.tls_mode === "ldaps" ? { tlsOptions: tls } : {}),
  });
  if (cfg.tls_mode === "starttls") {
    try { await client.startTLS(tls); }
    catch (e) { await closeClient(client); throw e instanceof ResultCodeError ? new LdapFailure("ldap_tls_failed", `StartTLS was rejected by the directory: ${clientText(e)}`) : transportFailure(e); }
  }
  return client;
}

/** @internal — for ldap-account.ts. */
export async function closeClient(c: Client): Promise<void> { await c.unbind().catch(() => undefined); }

async function serviceBind(cfg: LdapConfig, client: Client): Promise<void> {
  try { await client.bind(cfg.bind_dn, cfg.bind_password); }
  catch (e) {
    if (e instanceof StrongAuthRequiredError) throw new LdapFailure("ldap_tls_failed", `the directory requires a secure channel for sign-in (strongerAuthRequired). Enable LDAPS or StartTLS. ${clientText(e)}`);
    if (e instanceof InvalidCredentialsError) {
      const f = new LdapFailure("ldap_service_bind_failed", clientText(e));
      f.resultCode = 49;
      f.adSubcode = adBindSubcode(e);
      throw f;
    }
    if (e instanceof ResultCodeError) {
      const f = new LdapFailure("ldap_unreachable", `the directory rejected the service bind (code ${e.code}) for a reason other than the password: ${clientText(e)}`);
      f.resultCode = e.code;
      throw f;
    }
    throw transportFailure(e);
  }
}

export const SERVICE_BIND_RETRY_MS = 35 * 60_000;
export const SERVICE_BIND_CHECK_HUMAN_MS = 5 * 60_000;
const SERVICE_STOP_UNTIL_CHANGE: ReadonlySet<string | null> = new Set(["52e", "525", null]);
const SERVICE_PASSWORD_VERIFIED: ReadonlySet<string> = new Set(["530", "531", "532", "533", "701", "773"]);

interface ServiceStop { until: number | null; subcode: string | null; checkedAt: number | null }
const serviceStops = new Map<string, ServiceStop>();
const serviceProven = new Set<string>();
const serviceFirst = new Map<string, Promise<void>>();
let serviceStopClock: () => number = Date.now;

function serviceKey(cfg: LdapConfig): string {
  return createHash("sha256").update(JSON.stringify([cfg.bind_dn, cfg.bind_password, cfg.servers, cfg.port, cfg.tls_mode, cfg.bind_password_rev ?? null])).digest("hex");
}

export function serviceBindStop(cfg: LdapConfig): { until: number | null; subcode: string | null } | null {
  const key = serviceKey(cfg), s = serviceStops.get(key);
  if (!s) return null;
  if (s.until !== null && serviceStopClock() >= s.until) { serviceStops.delete(key); return null; }
  return { until: s.until, subcode: s.subcode };
}

function noteServiceBind(cfg: LdapConfig, f: LdapFailure | null, checked = false): void {
  const key = serviceKey(cfg);
  if (!f) {
    serviceStops.delete(key);
    if (serviceProven.size >= 64) serviceProven.clear();
    serviceProven.add(key);
    return;
  }
  if (f.code !== "ldap_service_bind_failed") return;
  serviceProven.delete(key);
  const subcode = f.adSubcode ?? null;
  const until = SERVICE_STOP_UNTIL_CHANGE.has(subcode) ? null : serviceStopClock() + SERVICE_BIND_RETRY_MS;
  const prev = serviceStops.get(key);
  if (!prev) log.warn("ldap_service_bind_stopped", { subcode: subcode ?? "none", retry_min: until === null ? null : SERVICE_BIND_RETRY_MS / 60_000 });
  const checkedAt = checked ? serviceStopClock() : prev?.checkedAt ?? null;
  if (prev && prev.until === null && until !== null && !(subcode !== null && SERVICE_PASSWORD_VERIFIED.has(subcode))) {
    serviceStops.set(key, { until: null, subcode: prev.subcode, checkedAt });
    return;
  }
  serviceStops.set(key, { until, subcode, checkedAt });
}

function takeCheckBypass(cfg: LdapConfig, human: boolean): number | null {
  const key = serviceKey(cfg), s = serviceStops.get(key);
  if (!s || serviceBindStop(cfg) === null) return null;
  if (!human) return s.until ?? Number.POSITIVE_INFINITY;
  const now = serviceStopClock();
  if (s.checkedAt !== null && now < s.checkedAt + SERVICE_BIND_CHECK_HUMAN_MS) return s.checkedAt + SERVICE_BIND_CHECK_HUMAN_MS;
  s.checkedAt = now;
  return null;
}

function stoppedFailure(stop: { until: number | null; subcode: string | null }): LdapFailure {
  const when = stop.until === null ? "until you change the password or account under “Sign-in and LDAP”"
    : `until at least ${new Date(stop.until).toISOString()} (resolve the AD subcode in the directory)`;
  const f = new LdapFailure("ldap_service_bind_failed", `service bind suspended after the directory rejected it${stop.subcode ? ` (data ${stop.subcode})` : ""}. No request was sent. Suspension lasts ${when}`);
  f.resultCode = 49;
  f.adSubcode = stop.subcode;
  return f;
}

export function resetServiceBindStopsForTests(): void { serviceStops.clear(); serviceProven.clear(); }
export function setServiceBindClockForTests(clock: (() => number) | null): void { serviceStopClock = clock ?? Date.now; }

/**
 * @internal — for ldap-account.ts.
 */
export async function serviceSession(cfg: LdapConfig, targets: LdapTarget[]): Promise<{ client: Client; target: LdapTarget; skipped: string[] }> {
  const turn = await serviceTurn(cfg);
  if (turn.kind === "stopped") throw stoppedFailure(turn.stop);
  try {
    return await serviceSessionOn(cfg, targets);
  } finally {
    turn.release();
  }
}

type ServiceTurn =
  | { kind: "go"; bypass: boolean; release: () => void }
  | { kind: "stopped"; stop: { until: number | null; subcode: string | null }; notBefore: number };

function stopDecision(cfg: LdapConfig, check?: { human: boolean }): { bypass: boolean } | { stop: { until: number | null; subcode: string | null }; notBefore: number } | null {
  const stop = serviceBindStop(cfg);
  if (!stop) return null;
  if (!check) return { stop, notBefore: stop.until ?? Number.POSITIVE_INFINITY };
  const notBefore = takeCheckBypass(cfg, check.human);
  return notBefore === null ? { bypass: true } : { stop, notBefore };
}

function stopNoBypass(cfg: LdapConfig, check?: { human: boolean }): { stop: { until: number | null; subcode: string | null }; notBefore: number } | null {
  const stop = serviceBindStop(cfg);
  if (!stop) return null;
  const s = serviceStops.get(serviceKey(cfg));
  if (!check?.human || !s) return { stop, notBefore: stop.until ?? Number.POSITIVE_INFINITY };
  const now = serviceStopClock();
  if (s.checkedAt === null || now >= s.checkedAt + SERVICE_BIND_CHECK_HUMAN_MS) s.checkedAt = now;
  return { stop, notBefore: s.checkedAt + SERVICE_BIND_CHECK_HUMAN_MS };
}

async function serviceTurn(cfg: LdapConfig, check?: { human: boolean }): Promise<ServiceTurn> {
  const key = serviceKey(cfg);
  const none = () => undefined;
  let waited = false;
  for (;;) {
    const d = waited ? stopNoBypass(cfg, check) : stopDecision(cfg, check);
    if (d && "stop" in d) return { kind: "stopped", stop: d.stop, notBefore: d.notBefore };
    if (d) return { kind: "go", bypass: true, release: none };
    if (serviceProven.has(key)) return { kind: "go", bypass: false, release: none };
    const pending = serviceFirst.get(key);
    if (!pending) {
      let done!: () => void;
      serviceFirst.set(key, new Promise<void>((r) => { done = r; }));
      let released = false;
      return { kind: "go", bypass: false, release: () => { if (released) return; released = true; serviceFirst.delete(key); done(); } };
    }
    await pending;
    waited = true;
  }
}

async function serviceSessionOn(cfg: LdapConfig, targets: LdapTarget[]): Promise<{ client: Client; target: LdapTarget; skipped: string[] }> {
  const skipped: string[] = [];
  let first: LdapFailure | null = null;
  for (const target of targets) {
    let client: Client | null = null;
    let halted: LdapFailure | null = null;
    try {
      client = await openClient(cfg, target);
      const stop = serviceBindStop(cfg);
      if (stop) { halted = stoppedFailure(stop); throw halted; }
      await serviceBind(cfg, client);
      noteServiceBind(cfg, null);
      return { client, target, skipped };
    } catch (e) {
      if (client) await closeClient(client);
      if (halted && e === halted) throw halted;
      const f = e instanceof LdapFailure ? e : transportFailure(e);
      if (f.code === "ldap_service_bind_failed") { noteServiceBind(cfg, f); throw f; }
      first ??= f;
      skipped.push(`${target.address}:${target.port} (${target.host}): ${f.detail}`);
    }
  }
  throw first ?? new LdapFailure("ldap_unreachable", "no controllers are configured");
}

/**
 * @internal — for ldap-account.ts.
 */
export async function withDeadline<T>(ms: number, run: (expired: () => boolean) => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined, over = false;
  try {
    return await Promise.race([run(() => over), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { over = true; reject(new LdapFailure("ldap_timeout", `no response within ${Math.round(ms / 1000)} s`)); }, ms);
    })]);
  } finally { clearTimeout(timer); }
}
function settledWithin(p: Promise<unknown>, capMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, capMs);
    t.unref();
    p.then(() => { clearTimeout(t); resolve(); }, () => { clearTimeout(t); resolve(); });
  });
}
const deadlineMs = (cfg: LdapConfig): number => (cfg.connect_timeout_sec * 2 + cfg.timeout_sec * 4) * 1000;

export interface DirectoryPerson {
  dn: string; account: string | null; guid: string; mail: string | null; name: string | null; department: string | null;
  employeeId: string | null; groups: string[]; matchedGroups: string[];
  givenName?: string | null;
}

const firstValue = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);
const textValue = (v: unknown, max: number): string | null => {
  const x = firstValue(v);
  const s = Buffer.isBuffer(x) ? x.toString("utf8") : typeof x === "string" ? x : null;
  const one = s?.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return one ? one : null;
};

const pick = (e: Record<string, unknown>, name: string): unknown =>
  e[name] ?? e[Object.keys(e).find((k) => k.toLowerCase() === name.toLowerCase()) ?? ""];
const bufferNames = (a: LdapAttributes): string[] => [...new Set([a.guid, a.guid.toLowerCase(), "objectGUID"])];

function guidOf(cfg: LdapConfig, e: Record<string, unknown>): string | null {
  const raw = firstValue(pick(e, cfg.attributes.guid));
  return Buffer.isBuffer(raw) ? (formatObjectGuid(raw) ?? raw.toString("hex")) : typeof raw === "string" && raw.trim() ? raw.trim().toLowerCase() : null;
}

function personOf(cfg: LdapConfig, e: Record<string, unknown> & { dn: string }): DirectoryPerson {
  const a = cfg.attributes, guid = guidOf(cfg, e);
  if (!guid) throw new LdapFailure("ldap_attribute_missing", `the directory entry lacks attribute ${a.guid} (the person’s persistent ID)`);
  const groups = ([] as unknown[]).concat(pick(e, a.groups) ?? []).map((g) => (Buffer.isBuffer(g) ? g.toString("utf8") : String(g))).filter(Boolean);
  return {
    dn: e.dn, account: textValue(pick(e, a.account), 64), guid, mail: textValue(pick(e, a.mail), 254)?.toLowerCase() ?? null, name: textValue(pick(e, a.name), 200),
    department: textValue(pick(e, a.department), 200), employeeId: textValue(pick(e, a.employee_id), 64), groups, matchedGroups: [],
    givenName: textValue(pick(e, a.given_name), 100),
  };
}

async function findPerson(cfg: LdapConfig, client: Client, filter: string): Promise<Array<Record<string, unknown> & { dn: string }>> {
  const a = cfg.attributes;
  try {
    const r = await client.search(cfg.base_dn, {
      scope: "sub", filter, sizeLimit: 2, timeLimit: cfg.timeout_sec, derefAliases: "never",
      attributes: [a.account, a.mail, a.name, a.department, a.groups, a.guid, a.employee_id, a.given_name], explicitBufferAttributes: bufferNames(a),
    });
    return r.searchEntries as Array<Record<string, unknown> & { dn: string }>;
  } catch (e) {
    if (e instanceof NoSuchObjectError) throw new LdapFailure("ldap_base_dn_invalid", clientText(e));
    if (e instanceof ResultCodeError) throw new LdapFailure("ldap_search_failed", clientText(e));
    if (/filter/i.test(clientText(e)) && !(e as { code?: string }).code) throw new LdapFailure("ldap_not_configured", `could not parse the “Who can sign in” filter: ${clientText(e)}`);
    throw transportFailure(e);
  }
}

async function nestedMatches(cfg: LdapConfig, client: Client, dn: string): Promise<string[]> {
  const out: string[] = [];
  for (const g of cfg.login_groups.filter((x) => x.includes("="))) {
    const r = await client.search(dn, { scope: "base", filter: `(${cfg.attributes.groups}:1.2.840.113556.1.4.1941:=${escapeFilterValue(g)})`, attributes: ["1.1"], sizeLimit: 1 })
      .catch((e: unknown) => { throw e instanceof ResultCodeError ? new LdapFailure("ldap_search_failed", clientText(e)) : transportFailure(e); });
    if (r.searchEntries.length) out.push(g);
  }
  return out;
}

export interface DirectoryHit { display_name: string; login: string; department: string | null; title: string | null }

export function searchTokens(q: string): string[] {
  return q.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().split(/\s+/).map((t) => t.replace(/\.+$/, "")).filter(Boolean).slice(0, 5);
}

function groupClause(cfg: LdapConfig, byName: string[] = []): string {
  const g = cfg.attributes.groups;
  const parts = [
    ...cfg.login_groups.filter((x) => x.includes("=")).flatMap((x) => [`(${g}=${escapeFilterValue(x)})`, ...(cfg.nested_groups ? [`(${g}:1.2.840.113556.1.4.1941:=${escapeFilterValue(x)})`] : [])]),
    ...byName.map((x) => `(${g}=${escapeFilterValue(x)})`),
  ];
  if (!parts.length) return "";
  return parts.length === 1 ? parts[0]! : `(|${parts.join("")})`;
}

export function directorySearchFilter(cfg: LdapConfig, tokens: string[], byName: string[] = []): string {
  const a = cfg.attributes;
  const words = tokens.map((t) => { const v = escapeFilterValue(t); return `(|(${a.name}=*${v}*)(${a.mail}=${v}*)(${a.account}=${v}*))`; }).join("");
  return `(&(objectCategory=person)(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2))(${a.mail}=*)${groupClause(cfg, byName)}${words})`;
}

const GROUP_NAME_DNS_MAX = 10;

export function domainRootDn(dn: string): string {
  const parts = splitDn(dn).filter(Boolean);
  let i = parts.length;
  while (i > 0 && /^dc\s*=/i.test(parts[i - 1]!)) i--;
  return i < parts.length ? parts.slice(i).join(",") : dn.trim();
}

export function groupNameBases(cfg: Pick<LdapConfig, "base_dn" | "project_groups_base">): string[] {
  const root = domainRootDn(cfg.base_dn);
  return [root, ...(cfg.project_groups_base && !dnUnder(cfg.project_groups_base, root) ? [cfg.project_groups_base] : [])];
}

const GROUP_WARN_EVERY_MS = 3_600_000;
const groupWarnedAt = new Map<string, number>();
function warnUnresolvedGroup(name: string, bases: string[]): void {
  const key = name.trim().toLowerCase(), now = Date.now();
  if (now - (groupWarnedAt.get(key) ?? 0) < GROUP_WARN_EVERY_MS) return;
  groupWarnedAt.set(key, now);
  log.warn("directory_group_name_unresolved", { name: name.trim().slice(0, 128), bases });
}

async function groupDnsByName(cfg: LdapConfig, client: Client, names: string[]): Promise<string[]> {
  const out: string[] = [], bases = groupNameBases(cfg);
  for (const name of names) {
    let found = false;
    for (const base of bases) {
      const r = await client.search(base, { scope: "sub", filter: `(&(objectClass=group)(cn=${escapeFilterValue(name.trim())}))`, attributes: ["1.1"],
                                            sizeLimit: GROUP_NAME_DNS_MAX, timeLimit: cfg.timeout_sec, derefAliases: "never" })
        .catch((e: unknown) => {
          if (e instanceof NoSuchObjectError) throw new LdapFailure("ldap_base_dn_invalid", clientText(e));
          if (e instanceof ResultCodeError) throw new LdapFailure("ldap_search_failed", clientText(e));
          throw transportFailure(e);
        });
      for (const e of r.searchEntries) { found = true; if (!out.some((x) => normalizeDn(x) === normalizeDn(e.dn))) out.push(e.dn); }
    }
    if (!found) warnUnresolvedGroup(name, bases);
  }
  return out;
}

export async function directorySearch(cfg: LdapConfig, tokens: string[], o: { limit: number; transport?: LdapTransport }): Promise<{ items: DirectoryHit[]; truncated: boolean; server: string }> {
  if (!cfg.enabled) throw new LdapFailure("ldap_disabled", "ldap.enabled = false");
  const problems = ldapConnectProblems(cfg);
  if (problems.length) throw new LdapFailure("ldap_not_configured", problems.map((p) => `${p.key}: ${p.message}`).join("; "));
  const cnGroups = cfg.login_groups.filter((g) => !g.includes("="));
  const byMemberOf = cnGroups.length > 0 && cnGroups.length === cfg.login_groups.length;
  const a = cfg.attributes;
  return withDeadline(deadlineMs(cfg), async () => {
    const resolved = await resolveTargets(cfg, o.transport);
    if (!resolved.reachable.length) throw noTargets(resolved);
    const svc = await serviceSession(cfg, resolved.reachable);
    try {
      const byName = cnGroups.length && !byMemberOf ? await groupDnsByName(cfg, svc.client, cnGroups) : [];
      const r = await svc.client.search(cfg.base_dn, {
        scope: "sub", filter: directorySearchFilter(cfg, tokens, byName), sizeLimit: byMemberOf ? 200 : o.limit + 1, timeLimit: cfg.timeout_sec, derefAliases: "never",
        attributes: [a.account, a.mail, a.name, a.department, a.title, a.groups],
      }).catch((e: unknown) => {
        if (e instanceof NoSuchObjectError) throw new LdapFailure("ldap_base_dn_invalid", clientText(e));
        if (e instanceof ResultCodeError) throw new LdapFailure("ldap_search_failed", clientText(e));
        throw transportFailure(e);
      });
      const hits: DirectoryHit[] = [];
      for (const e of r.searchEntries as Array<Record<string, unknown> & { dn: string }>) {
        if (byMemberOf) {
          const memberOf = ([] as unknown[]).concat(pick(e, a.groups) ?? []).map((g) => (Buffer.isBuffer(g) ? g.toString("utf8") : String(g)));
          if (!matchGroups(memberOf, cfg.login_groups).length) continue;
        }
        const login = textValue(pick(e, a.mail), 254)?.toLowerCase();
        if (!login) continue;
        hits.push({ display_name: textValue(pick(e, a.name), 200) ?? login, login, department: textValue(pick(e, a.department), 200), title: textValue(pick(e, a.title), 200) });
      }
      hits.sort((x, y) => x.display_name.localeCompare(y.display_name, "ru"));
      return { items: hits.slice(0, o.limit), truncated: hits.length > o.limit, server: `${svc.target.address}:${svc.target.port}` };
    } finally { await closeClient(svc.client); }
  });
}

export const projectGroupsBase = (cfg: Pick<LdapConfig, "project_groups_base" | "base_dn">): string => cfg.project_groups_base || cfg.base_dn;

export function dnUnder(dn: string, base: string): boolean {
  const d = normalizeDn(dn), b = normalizeDn(base);
  return b.length > 0 && (d === b || d.endsWith(`,${b}`));
}

export interface DirectoryGroup { dn: string; name: string; guid: string | null }
export interface GroupMember { guid: string | null; mail: string | null; employeeId: string | null }
export type GroupMembership =
  | { status: "ok"; group: DirectoryGroup; members: GroupMember[] }
  | { status: "too_large"; group: DirectoryGroup; seen: number }
  | { status: "missing" };

export const groupSearchFilter = (tokens: string[]): string =>
  `(&(objectClass=group)${tokens.map((t) => `(cn=*${escapeFilterValue(t)}*)`).join("")})`;

export function groupMembersFilter(cfg: Pick<LdapConfig, "attributes" | "nested_groups">, groupDn: string): string {
  const a = cfg.attributes;
  return `(&(objectCategory=person)(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2))(${a.mail}=*)` +
         `(${a.groups}${cfg.nested_groups ? ":1.2.840.113556.1.4.1941:" : ""}=${escapeFilterValue(groupDn)}))`;
}

export function objectGuidBytes(guid: string): Buffer | null {
  const m = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i.exec(guid);
  if (!m) return null;
  const rev = (h: string) => Buffer.from(h, "hex").reverse();
  return Buffer.concat([rev(m[1]!), rev(m[2]!), rev(m[3]!), Buffer.from(m[4]!, "hex"), Buffer.from(m[5]!, "hex")]);
}

const guidText = (raw: unknown): string | null =>
  Buffer.isBuffer(raw) ? (formatObjectGuid(raw) ?? raw.toString("hex")) : typeof raw === "string" && raw.trim() ? raw.trim().toLowerCase() : null;

function groupOf(cfg: LdapConfig, e: Record<string, unknown> & { dn: string }): DirectoryGroup {
  return { dn: e.dn, name: textValue(pick(e, "cn"), 256) ?? firstRdnValue(e.dn), guid: guidText(firstValue(pick(e, cfg.attributes.guid))) };
}

const searchFailure = (e: unknown): LdapFailure =>
  e instanceof LdapFailure ? e : e instanceof ResultCodeError ? new LdapFailure("ldap_search_failed", clientText(e)) : transportFailure(e);

async function findGroup(cfg: LdapConfig, client: Client, dn: string, guid: string | null): Promise<DirectoryGroup | null> {
  const a = cfg.attributes;
  const opts = { attributes: ["cn", a.guid], explicitBufferAttributes: bufferNames(a), sizeLimit: 2, timeLimit: cfg.timeout_sec, derefAliases: "never" as const };
  const byDn = await client.search(dn, { ...opts, scope: "base", filter: "(objectClass=group)" })
    .then((r) => (r.searchEntries[0] as (Record<string, unknown> & { dn: string }) | undefined) ?? null,
          (e: unknown) => { if (e instanceof NoSuchObjectError || e instanceof InvalidDNSyntaxError) return null; throw searchFailure(e); });
  if (byDn) {
    const found = groupOf(cfg, byDn);
    if (!guid || !found.guid || found.guid === guid.trim().toLowerCase()) return found;
  }
  const bytes = guid ? objectGuidBytes(guid) : null;
  if (!bytes) return null;
  const r = await client.search(projectGroupsBase(cfg), {
    ...opts, scope: "sub",
    filter: new AndFilter({ filters: [new EqualityFilter({ attribute: "objectClass", value: "group" }), new EqualityFilter({ attribute: a.guid, value: bytes })] }),
  }).catch((e: unknown) => { throw e instanceof NoSuchObjectError ? new LdapFailure("ldap_base_dn_invalid", `group branch ${projectGroupsBase(cfg)}: ${clientText(e)}`) : searchFailure(e); });
  return r.searchEntries.length === 1 ? groupOf(cfg, r.searchEntries[0] as Record<string, unknown> & { dn: string }) : null;
}

async function groupMembers(cfg: LdapConfig, client: Client, groupDn: string, max: number): Promise<Array<Record<string, unknown> & { dn: string }>> {
  const a = cfg.attributes;
  try {
    const r = await client.search(cfg.base_dn, {
      scope: "sub", filter: groupMembersFilter(cfg, groupDn), sizeLimit: max + 1, timeLimit: cfg.timeout_sec, derefAliases: "never",
      paged: { pageSize: Math.min(500, max + 1) }, attributes: [a.mail, a.guid, a.employee_id], explicitBufferAttributes: bufferNames(a),
    });
    return r.searchEntries as Array<Record<string, unknown> & { dn: string }>;
  } catch (e) {
    if (e instanceof NoSuchObjectError) throw new LdapFailure("ldap_base_dn_invalid", clientText(e));
    throw searchFailure(e);
  }
}

const memberOfEntry = (cfg: LdapConfig, e: Record<string, unknown>): GroupMember => ({
  guid: guidText(firstValue(pick(e, cfg.attributes.guid))), mail: textValue(pick(e, cfg.attributes.mail), 254)?.toLowerCase() ?? null,
  employeeId: textValue(pick(e, cfg.attributes.employee_id), 64),
});

function groupsReady(cfg: LdapConfig): void {
  if (!cfg.enabled) throw new LdapFailure("ldap_disabled", "ldap.enabled = false");
  const problems = ldapConnectProblems(cfg);
  if (problems.length) throw new LdapFailure("ldap_not_configured", problems.map((p) => `${p.key}: ${p.message}`).join("; "));
}

export async function directoryGroupMembers(cfg: LdapConfig, groups: Array<{ dn: string; guid: string | null }>, o: { max: number; transport?: LdapTransport }): Promise<GroupMembership[]> {
  if (!groups.length) return [];
  groupsReady(cfg);
  return withDeadline(deadlineMs(cfg) + groups.length * cfg.timeout_sec * 2000, async () => {
    const resolved = await resolveTargets(cfg, o.transport);
    if (!resolved.reachable.length) throw noTargets(resolved);
    const svc = await serviceSession(cfg, resolved.reachable);
    try {
      const out: GroupMembership[] = [];
      for (const g of groups) {
        const group = await findGroup(cfg, svc.client, g.dn, g.guid);
        if (!group) { out.push({ status: "missing" }); continue; }
        const entries = await groupMembers(cfg, svc.client, group.dn, o.max);
        out.push(entries.length > o.max ? { status: "too_large", group, seen: entries.length } : { status: "ok", group, members: entries.map((e) => memberOfEntry(cfg, e)) });
      }
      return out;
    } finally { await closeClient(svc.client); }
  });
}

export async function directoryGroupsFind(cfg: LdapConfig, groups: Array<{ dn: string; guid: string | null }>, o: { transport?: LdapTransport } = {}): Promise<Array<DirectoryGroup | null>> {
  if (!groups.length) return [];
  groupsReady(cfg);
  return withDeadline(deadlineMs(cfg) + groups.length * cfg.timeout_sec * 1000, async () => {
    const resolved = await resolveTargets(cfg, o.transport);
    if (!resolved.reachable.length) throw noTargets(resolved);
    const svc = await serviceSession(cfg, resolved.reachable);
    try {
      const out: Array<DirectoryGroup | null> = [];
      for (const g of groups) out.push(await findGroup(cfg, svc.client, g.dn, g.guid));
      return out;
    } finally { await closeClient(svc.client); }
  });
}

export interface GuidLookupOptions {
  attributes: string[];
  target?: LdapTarget;
  scope?: { base: string; depth?: "sub" | "one" | "base" };
  transport?: LdapTransport;
}
export interface DirectoryEntry { dn: string; attrs: Record<string, unknown> }

export async function directoryEntryByGuid(cfg: LdapConfig, guid: string, o: GuidLookupOptions): Promise<DirectoryEntry | null> {
  const bytes = objectGuidBytes(guid.trim());
  if (!bytes) throw new LdapFailure("ldap_attribute_missing", "objectGUID must use the 8-4-4-4-12 format");
  if (!cfg.enabled) throw new LdapFailure("ldap_disabled", "ldap.enabled = false");
  const problems = ldapConnectProblems(cfg);
  if (problems.length) throw new LdapFailure("ldap_not_configured", problems.map((p) => `${p.key}: ${p.message}`).join("; "));
  const a = cfg.attributes, base = o.scope?.base ?? cfg.base_dn;
  return withDeadline(deadlineMs(cfg), async () => {
    let targets: LdapTarget[];
    if (o.target) targets = [o.target];
    else {
      const resolved = await resolveTargets(cfg, o.transport);
      if (!resolved.reachable.length) throw noTargets(resolved);
      targets = resolved.reachable;
    }
    const svc = await serviceSession(cfg, targets);
    try {
      const r = await svc.client.search(base, {
        scope: o.scope?.depth ?? "sub", filter: new EqualityFilter({ attribute: a.guid, value: bytes }), sizeLimit: 2, timeLimit: cfg.timeout_sec,
        derefAliases: "never", attributes: [...new Set([...o.attributes, a.guid])], explicitBufferAttributes: bufferNames(a),
      }).catch((e: unknown) => {
        if (e instanceof NoSuchObjectError) throw new LdapFailure("ldap_base_dn_invalid", clientText(e));
        throw searchFailure(e);
      });
      const entries = r.searchEntries as Array<Record<string, unknown> & { dn: string }>;
      if (entries.length > 1) throw new LdapFailure("ldap_search_failed", "more than one entry matched a single objectGUID");
      const e = entries[0];
      if (!e) return null;
      const { dn, ...attrs } = e;
      return { dn, attrs };
    } finally { await closeClient(svc.client); }
  });
}

export interface DirectoryAccount { dn: string; sAMAccountName: string | null; upn: string | null; enabled: boolean; memberOf: string[] }

export const UF_ACCOUNTDISABLE = 0x2;

const FILETIME_NEVER = 0x7fffffffffffffffn;
const EPOCH_1601_MS = 11644473600000n;

export function accountExpired(raw: string | null, now = Date.now()): boolean {
  if (raw === null) return false;
  if (!/^\d{1,19}$/.test(raw)) return true;
  const v = BigInt(raw);
  if (v === 0n || v >= FILETIME_NEVER) return false;
  return Number(v / 10000n - EPOCH_1601_MS) <= now;
}

export async function directoryAccountByGuid(cfg: LdapConfig, guid: string, o: { transport?: LdapTransport; target?: LdapTarget; now?: number } = {}): Promise<DirectoryAccount | null> {
  const groupsAttr = cfg.attributes.groups || LDAP_DEFAULT_ATTRIBUTES.groups;
  const e = await directoryEntryByGuid(cfg, guid, {
    attributes: ["sAMAccountName", "userPrincipalName", "userAccountControl", "accountExpires", groupsAttr], transport: o.transport, target: o.target });
  if (!e) return null;
  const uacRaw = textValue(pick(e.attrs, "userAccountControl"), 20);
  const uac = uacRaw !== null && /^-?\d{1,11}$/.test(uacRaw) ? Number(uacRaw) : null;
  const expired = accountExpired(textValue(pick(e.attrs, "accountExpires"), 40), o.now);
  const groups = pick(e.attrs, groupsAttr);
  const memberOf = (Array.isArray(groups) ? groups : groups === undefined || groups === null ? [] : [groups])
    .map((g) => (Buffer.isBuffer(g) ? g.toString("utf8") : typeof g === "string" ? g : "")).filter((g) => g && g.length <= 1024).slice(0, 2000);
  return {
    dn: e.dn,
    sAMAccountName: textValue(pick(e.attrs, "sAMAccountName"), 256),
    upn: textValue(pick(e.attrs, "userPrincipalName"), 256),
    enabled: uac !== null && (uac & UF_ACCOUNTDISABLE) === 0 && !expired,
    memberOf,
  };
}

export async function directoryNestedMember(cfg: LdapConfig, dn: string, groupDn: string, o: { transport?: LdapTransport } = {}): Promise<boolean> {
  if (!cfg.enabled) throw new LdapFailure("ldap_disabled", "ldap.enabled = false");
  const problems = ldapConnectProblems(cfg);
  if (problems.length) throw new LdapFailure("ldap_not_configured", problems.map((p) => `${p.key}: ${p.message}`).join("; "));
  const attr = cfg.attributes.groups || LDAP_DEFAULT_ATTRIBUTES.groups;
  return withDeadline(deadlineMs(cfg), async () => {
    const resolved = await resolveTargets(cfg, o.transport);
    if (!resolved.reachable.length) throw noTargets(resolved);
    const svc = await serviceSession(cfg, resolved.reachable);
    try {
      const r = await svc.client.search(dn, {
        scope: "base", filter: `(${attr}:1.2.840.113556.1.4.1941:=${escapeFilterValue(groupDn)})`, attributes: ["1.1"], sizeLimit: 1, timeLimit: cfg.timeout_sec,
        derefAliases: "never",
      }).catch((e: unknown) => {
        if (e instanceof NoSuchObjectError || e instanceof InvalidDNSyntaxError) return null;
        throw searchFailure(e);
      });
      return !!r && r.searchEntries.length > 0;
    } finally { await closeClient(svc.client); }
  });
}

export type KeycloakUsernameForm = "account" | "upn" | "any";

export function guidAccountMatches(account: Pick<DirectoryAccount, "sAMAccountName" | "upn">, preferredUsername: string | null | undefined,
                                   form: KeycloakUsernameForm = "any"): boolean {
  const want = String(preferredUsername ?? "").trim().toLowerCase();
  if (!want || want.includes("\\")) return false;
  const same = (v: string | null) => { const x = String(v ?? "").trim().toLowerCase(); return x !== "" && x === want; };
  return want.includes("@") ? form !== "account" && same(account.upn) : form !== "upn" && same(account.sAMAccountName);
}

export async function directoryGroupSearch(cfg: LdapConfig, tokens: string[], o: { limit: number; transport?: LdapTransport }): Promise<{ items: Array<{ dn: string; name: string }>; truncated: boolean }> {
  groupsReady(cfg);
  const base = projectGroupsBase(cfg);
  return withDeadline(deadlineMs(cfg), async () => {
    const resolved = await resolveTargets(cfg, o.transport);
    if (!resolved.reachable.length) throw noTargets(resolved);
    const svc = await serviceSession(cfg, resolved.reachable);
    try {
      const r = await svc.client.search(base, { scope: "sub", filter: groupSearchFilter(tokens), sizeLimit: o.limit + 1, timeLimit: cfg.timeout_sec, derefAliases: "never", attributes: ["cn"] })
        .catch((e: unknown) => { throw e instanceof NoSuchObjectError ? new LdapFailure("ldap_base_dn_invalid", `group branch ${base}: ${clientText(e)}`) : searchFailure(e); });
      const items = (r.searchEntries as Array<Record<string, unknown> & { dn: string }>).map((e) => ({ dn: e.dn, name: textValue(pick(e, "cn"), 256) ?? firstRdnValue(e.dn) }));
      items.sort((x, y) => x.name.localeCompare(y.name, "ru"));
      return { items: items.slice(0, o.limit), truncated: items.length > o.limit };
    } finally { await closeClient(svc.client); }
  });
}

export type LoginFailureReason = "not_found" | "ambiguous" | "bad_password" | "empty_password" | "account_state" | "domain_not_allowed";
export type LoginOutcome =
  | { ok: true; person: DirectoryPerson; server: string }
  | { ok: false; kind: "invalid_credentials"; reason: LoginFailureReason; adCode: string | null; matches: number }
  | { ok: false; kind: "not_in_group"; person: DirectoryPerson; server: string }
  | { ok: false; kind: "held" };

export interface DirectoryEntryRef { dn: string; guid: string | null }

export interface LdapStep { step: string; status: "ok" | "fail" | "warn" | "skip"; code?: string; message: string; detail?: unknown }

type BindGate = { transport?: LdapTransport; beforeBind?: (entry: DirectoryEntryRef) => boolean };
type PasswordState = { counted: boolean; settled: Promise<void> | null };

export async function directoryLogin(cfg: LdapConfig, name: LoginName, password: string,
                                     o: BindGate & { trace?: LdapStep[] } = {}): Promise<LoginOutcome> {
  const step = (s: LdapStep) => o.trace?.push(s);
  if (!cfg.enabled) throw new LdapFailure("ldap_disabled", "ldap.enabled = false");
  const problems = ldapConnectProblems(cfg);
  if (problems.length) throw new LdapFailure("ldap_not_configured", problems.map((p) => `${p.key}: ${p.message}`).join("; "));
  if (!domainAllowed(cfg, name)) return { ok: false, kind: "invalid_credentials", reason: "domain_not_allowed", adCode: null, matches: 0 };
  if (!password) return { ok: false, kind: "invalid_credentials", reason: "empty_password", adCode: null, matches: 0 };

  const pw: PasswordState = { counted: false, settled: null };
  try {
    return await withDeadline(deadlineMs(cfg), (expired) => loginFlow(cfg, name, password, o, step, expired, pw));
  } catch (e) {
    if (pw.counted && pw.settled) {
      const f = e instanceof LdapFailure ? e : transportFailure(e);
      f.unansweredBind = { settled: pw.settled };
      throw f;
    }
    throw e;
  }
}

async function loginFlow(cfg: LdapConfig, name: LoginName, password: string, o: BindGate, step: (s: LdapStep) => void,
                         expired: () => boolean, pw: PasswordState): Promise<LoginOutcome> {
  const resolved = await resolveTargets(cfg, o.transport);
  step({ step: "addresses", status: resolved.reachable.length ? (resolved.unreachable.length || resolved.dnsFailed.length ? "warn" : "ok") : "fail",
         message: `reachable addresses: ${resolved.reachable.map((r) => r.address).join(", ") || "no"}`, detail: resolved });
  if (!resolved.reachable.length) throw noTargets(resolved);
  const svc = await serviceSession(cfg, resolved.reachable);
  const server = `${svc.target.address}:${svc.target.port}`;
  try {
    step({ step: "service_bind", status: "ok", message: `service account accepted (${server})`, detail: svc.skipped.length ? { skipped: svc.skipped } : undefined });
    const filter = renderUserFilter(cfg.user_filter, name);
    const entries = await findPerson(cfg, svc.client, filter);
    step({ step: "user_search", status: entries.length === 1 ? "ok" : "fail", message: `filter matches: ${entries.length}${entries.length > 1 ? " (exactly one match is required. Sign-in is rejected before checking the password)" : ""}`,
           detail: { filter, base_dn: cfg.base_dn, entries: entries.map((e) => e.dn) } });
    if (entries.length !== 1) return { ok: false, kind: "invalid_credentials", reason: entries.length ? "ambiguous" : "not_found", adCode: null, matches: entries.length };
    const entry = entries[0]!;
    const user = await openClient(cfg, svc.target);
    try {
      if (expired()) throw new LdapFailure("ldap_timeout", "the overall sign-in deadline expired before the password check. The password was not sent to the directory");
      if (o.beforeBind && !o.beforeBind({ dn: entry.dn, guid: guidOf(cfg, entry) })) {
        step({ step: "user_bind", status: "skip", message: "the password was not checked because this directory account had too many consecutive failed attempts" });
        return { ok: false, kind: "held" };
      }
      const sent = user.bind(entry.dn, password);
      pw.counted = true;
      pw.settled = settledWithin(sent, (cfg.connect_timeout_sec + cfg.timeout_sec + 1) * 1000);
      try { await sent; pw.counted = false; }
      catch (e) {
        if (e instanceof InvalidCredentialsError) {
          const adCode = adBindSubcode(e);
          step({ step: "user_bind", status: "fail", code: adCode ?? undefined, message: `the directory rejected the password${adCode ? `: ${AD_SUBCODE_TEXT[adCode] ?? `subcode ${adCode}`}` : ""}`, detail: clientText(e) });
          return { ok: false, kind: "invalid_credentials", reason: adCode && adCode !== "52e" && adCode !== "525" ? "account_state" : "bad_password", adCode, matches: 1 };
        }
        if (e instanceof ResultCodeError) pw.counted = false;
        if (e instanceof StrongAuthRequiredError) throw new LdapFailure("ldap_tls_failed", `the directory requires a secure channel for sign-in (strongerAuthRequired). Enable LDAPS or StartTLS. ${clientText(e)}`);
        if (e instanceof ResultCodeError) throw new LdapFailure("ldap_search_failed", `user bind: ${clientText(e)}`);
        throw transportFailure(e);
      }
    } finally { await closeClient(user); }
    step({ step: "user_bind", status: "ok", message: "password accepted by the directory" });
    const person = personOf(cfg, entry);
    person.matchedGroups = matchGroups(person.groups, cfg.login_groups);
    if (!person.matchedGroups.length && cfg.nested_groups) person.matchedGroups = await nestedMatches(cfg, svc.client, entry.dn);
    step({ step: "group_check", status: person.matchedGroups.length ? "ok" : "fail",
           message: person.matchedGroups.length ? `access group: ${person.matchedGroups.join(", ")}` : "the person belongs to no access group, so sign-in was rejected",
           detail: { groups: person.groups, login_groups: cfg.login_groups, nested: cfg.nested_groups } });
    if (!person.matchedGroups.length) return { ok: false, kind: "not_in_group", person, server };
    return { ok: true, person, server };
  } finally { await closeClient(svc.client); }
}

interface TlsInfo { authorized: boolean; error: string | null; protocol: string | null; subject: string | null; issuer: string | null; valid_to: string | null; altnames: string | null; checked_name?: string }

function tlsReason(info: TlsInfo): string {
  const e = info.error ?? "";
  if (/ALTNAME|does not match/i.test(e))
    return `the certificate is for ${info.altnames ?? info.subject ?? "other names"}, and the name checked was “${info.checked_name ?? "?"}”. Use a controller name from the certificate or set “Certificate name” (${e})`;
  if (/SELF_SIGNED|UNABLE_TO_GET_ISSUER|UNABLE_TO_VERIFY|signature failure/i.test(e))
    return `the “${info.subject ?? "?"}” certificate was issued by “${info.issuer ?? "?"}”, which the memory does not trust. Paste the directory root certificate into “Root certificate” (${e})`;
  if (/EXPIRED/i.test(e)) return `certificate “${info.subject ?? "?"}” expired on ${info.valid_to ?? ""} (${e})`;
  return e;
}

function certInfo(s: TLSSocket): TlsInfo {
  const c = s.getPeerCertificate() as PeerCertificate | null;
  const cn = (x: unknown) => (x && typeof x === "object" ? String((x as Record<string, unknown>).CN ?? "") || null : null);
  return { authorized: s.authorized, error: s.authorizationError ? String(s.authorizationError) : null, protocol: s.getProtocol(),
           subject: cn(c?.subject), issuer: cn(c?.issuer), valid_to: c?.valid_to ?? null, altnames: c?.subjectaltname ?? null };
}

function ldapsProbe(cfg: LdapConfig, target: LdapTarget): Promise<TlsInfo> {
  return new Promise((resolve) => {
    const opts = tlsOptionsFor(cfg, target), checked = String(opts.servername ?? opts.host ?? "");
    const s = tlsConnect({ ...opts, port: target.port, rejectUnauthorized: false });
    const t = setTimeout(() => { s.destroy(); resolve({ authorized: false, error: "no TLS response", protocol: null, subject: null, issuer: null, valid_to: null, altnames: null }); }, cfg.connect_timeout_sec * 1000);
    s.once("secureConnect", () => { clearTimeout(t); const info = { ...certInfo(s), checked_name: checked }; s.destroy(); resolve(info); });
    s.once("error", (e) => { clearTimeout(t); resolve({ authorized: false, error: clientText(e), protocol: null, subject: null, issuer: null, valid_to: null, altnames: null }); });
  });
}

export async function checkConnection(cfg: LdapConfig, o: { transport?: LdapTransport; human?: boolean } = {}): Promise<{ ok: boolean; steps: LdapStep[] }> {
  const steps: LdapStep[] = [];
  const finish = () => ({ ok: !steps.some((s) => s.status === "fail"), steps });
  try {
    const problems = ldapConnectProblems({ ...cfg, enabled: true });
    steps.push(problems.length
      ? { step: "config", status: "fail", code: "ldap_not_configured", message: "settings are incomplete or contain errors", detail: problems }
      : { step: "config", status: cfg.enabled ? "ok" : "warn", message: cfg.enabled ? "settings are complete" : "settings are complete, but directory sign-in is disabled (ldap.enabled)" });
    if (problems.some((p) => ["servers", "port", "ca_cert", "tls_server_name"].includes(p.key)) || !cfg.servers.length) return finish();
    if (cfg.tls_mode === "none") steps.push({ step: "tls", status: "warn", message: "without encryption, passwords travel over the network in plain text (administrator acknowledgment is recorded: ldap.insecure_ack)" });

    const r = await resolveTargets(cfg, o.transport);
    steps.push({ step: "dns", status: r.dnsFailed.length ? (r.reachable.length || r.unreachable.length ? "warn" : "fail") : "ok", code: r.dnsFailed.length ? "ldap_dns_failed" : undefined,
                 message: r.dnsFailed.length ? `${LDAP_FAILURE_TEXT.ldap_dns_failed}. Could not resolve: ${r.dnsFailed.map((d) => d.host).join(", ")}` : "controller hostnames resolve from the memory server",
                 detail: { dns_failed: r.dnsFailed, addresses: [...r.reachable, ...r.unreachable].map((x) => `${x.host} → ${x.address}`) } });
    steps.push({ step: "tcp", status: r.reachable.length ? (r.unreachable.length ? "warn" : "ok") : "fail", code: r.reachable.length ? undefined : "ldap_unreachable",
                 message: r.reachable.length ? `responding: ${r.reachable.map((x) => `${x.address}:${x.port}`).join(", ")}${r.unreachable.length ? `; skipped: ${r.unreachable.map((x) => `${x.address}:${x.port}`).join(", ")}` : ""}` : LDAP_FAILURE_TEXT.ldap_unreachable,
                 detail: { reachable: r.reachable, unreachable: r.unreachable } });
    if (!r.reachable.length) return finish();
    const target = r.reachable[0]!;
    if (cfg.tls_mode === "ldaps") {
      const info = await ldapsProbe(cfg, target);
      steps.push({ step: "tls", status: info.authorized ? "ok" : "fail", code: info.authorized ? undefined : "ldap_tls_failed",
                   message: info.authorized ? `LDAPS: certificate “${info.subject ?? "?"}” from “${info.issuer ?? "?"}” verified (${info.protocol})` : `${LDAP_FAILURE_TEXT.ldap_tls_failed}: ${tlsReason(info)}`, detail: info });
      if (!info.authorized) return finish();
    }
    const check = { human: o.human === true };
    const stopped = (stop: { until: number | null; subcode: string | null }, notBefore: number) => {
      const f = stoppedFailure(stop);
      steps.push({ step: "service_bind", status: "fail", code: f.code, message: f.message,
                   detail: `${f.detail}; ${check.human ? `“Check LDAP” can run during the suspension no earlier than ${new Date(notBefore).toISOString()}`
                     : "during suspension, only a person in a personal session can use “Check LDAP”, at most once every 5 min. System keys, tool sessions and emergency sessions cannot use it"}` });
      return finish();
    };
    const turn = await serviceTurn(cfg, check);
    if (turn.kind === "stopped") return stopped(turn.stop, turn.notBefore);
    let client: Client | null = null;
    try {
      client = await openClient(cfg, target);
      if (cfg.tls_mode === "starttls") {
        const sock = (client as unknown as { socket?: TLSSocket }).socket;
        steps.push({ step: "tls", status: "ok", message: "StartTLS: secure channel established and certificate verified", detail: sock?.getPeerCertificate ? certInfo(sock) : undefined });
      }
      if (!turn.bypass) {
        const again = stopNoBypass(cfg, check);
        if (again) { turn.release(); return stopped(again.stop, again.notBefore); }
      }
      try { await serviceBind(cfg, client); } catch (e) { if (e instanceof LdapFailure) noteServiceBind(cfg, e, true); turn.release(); throw e; }
      noteServiceBind(cfg, null);
      turn.release();
      steps.push({ step: "service_bind", status: "ok", message: `service account accepted (${target.address}:${target.port})` });
      try {
        await client.search(cfg.base_dn, { scope: "base", filter: "(objectClass=*)", attributes: ["1.1"], sizeLimit: 1 });
        steps.push({ step: "base_dn", status: "ok", message: `base DN found: ${cfg.base_dn}` });
      } catch (e) {
        steps.push({ step: "base_dn", status: "fail", code: e instanceof NoSuchObjectError ? "ldap_base_dn_invalid" : "ldap_search_failed",
                     message: e instanceof NoSuchObjectError ? LDAP_FAILURE_TEXT.ldap_base_dn_invalid : LDAP_FAILURE_TEXT.ldap_search_failed, detail: clientText(e) });
        return finish();
      }
      for (const g of cfg.login_groups) {
        const byDn = g.includes("=");
        const res = await client.search(byDn ? g : cfg.base_dn, { scope: byDn ? "base" : "sub", filter: byDn ? "(objectClass=group)" : `(&(objectClass=group)(cn=${escapeFilterValue(g)}))`, attributes: ["1.1"], sizeLimit: 2 })
          .then((x) => x.searchEntries.length, (e: unknown) => (e instanceof NoSuchObjectError ? 0 : Promise.reject(e)));
        steps.push({ step: "groups", status: res === 1 ? "ok" : "warn", message: res === 1 ? `access group found: ${g}` : res ? `More than one group matches the name “${g}”. Specify the DN` : `access group “${g}” was not found in the directory`, detail: { group: g, found: res } });
      }
    } catch (e) {
      const f = e instanceof LdapFailure ? e : e instanceof ResultCodeError ? new LdapFailure("ldap_search_failed", clientText(e)) : transportFailure(e);
      steps.push({ step: f.code === "ldap_service_bind_failed" || f.resultCode !== undefined ? "service_bind" : f.code === "ldap_tls_failed" ? "tls" : "connection", status: "fail", code: f.code, message: f.message, detail: f.detail });
    } finally {
      turn.release();
      if (client) await closeClient(client);
    }
  } catch (e) {
    const f = e instanceof LdapFailure ? e : transportFailure(e);
    steps.push({ step: "unexpected", status: "fail", code: f.code, message: f.message, detail: f.detail });
  }
  return finish();
}
