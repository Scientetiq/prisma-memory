import { derivedList } from "../i18n/runtime";
import { LDAP_GROUPS, LDAP_ENABLED, TLS_MODES, SMTP_SECURITY_MODES, LDAP_STEP_TITLES, TEST_LOGIN_OUTCOMES, MATCHED_BY, TEXT } from "../messages/ldap-form";

export type LdapFieldKind = "bool" | "hosts" | "lines" | "text" | "multiline" | "number" | "tls" | "smtp_security" | "secret" | "json";

export type FieldCategory = "ldap" | "access" | "oidc" | "smtp";
export interface LdapField { key: string; kind: LdapFieldKind; label: string; hint?: string; placeholder?: string; category?: FieldCategory }

export const fieldCategory = (f: Pick<LdapField, "category">): FieldCategory => f.category ?? "ldap";

export { LDAP_GROUPS } from "../messages/ldap-form";

export { LDAP_ENABLED } from "../messages/ldap-form";

export const LDAP_FIELDS: LdapField[] = derivedList(() => [LDAP_ENABLED, ...LDAP_GROUPS.flatMap((g) => g.fields)]) as LdapField[];

export const ldapInput = (key: string): string => `ldap:${key}`;
export const LDAP_CLEAR_SECRET = "clear:bind_password";

export { TLS_MODES } from "../messages/ldap-form";

export { SMTP_SECURITY_MODES } from "../messages/ldap-form";

export function ldapFieldText(kind: LdapFieldKind, value: unknown): string {
  if (kind === "secret" || value === null || value === undefined) return "";
  if (kind === "hosts" || kind === "lines") return Array.isArray(value) ? value.map(String).join("\n") : String(value);
  if (kind === "json") return JSON.stringify(value, null, 2);
  if (kind === "bool") return value === true ? "on" : "";
  return String(value);
}

export type LdapParsed = { ok: true; value: unknown } | { ok: false; error: string };

export function parseLdapField(kind: LdapFieldKind, raw: string | null): LdapParsed {
  const text = (raw ?? "").trim();
  switch (kind) {
    case "bool":
      return { ok: true, value: raw === "on" || raw === "true" };
    case "hosts":
      return { ok: true, value: Array.from(new Set(text.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))) };
    case "lines":
      return { ok: true, value: Array.from(new Set(text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean))) };
    case "number": {
      if (!text) return { ok: false, error: TEXT.enterANumber2 };
      const n = Number(text.replace(",", "."));
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, error: TEXT.enterANumber };
    }
    case "json": {
      try {
        const v = JSON.parse(text || "{}");
        if (v === null || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: TEXT.aJSONObjectIsRequired };
        return { ok: true, value: v };
      } catch (e) {
        return { ok: false, error: TEXT.invalidJSON((e as Error).message) };
      }
    }
    case "tls":
      return TLS_MODES.some((m) => m.value === text) ? { ok: true, value: text } : { ok: false, error: TEXT.chooseAnEncryptionMode };
    case "smtp_security":
      return SMTP_SECURITY_MODES.some((m) => m.value === text) ? { ok: true, value: text } : { ok: false, error: TEXT.chooseEncryption };
    case "text":
    case "multiline":
      return { ok: true, value: kind === "multiline" ? (raw ?? "").replace(/\r\n/g, "\n").trim() : text };
    case "secret":
      return { ok: true, value: (raw ?? "").replace(/\r?\n$/, "") };
  }
}

const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const ATTR_RE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const DOMAIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV4_RE = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const isIpLike = (h: string): boolean => IPV4_RE.test(h) || (h.includes(":") && /^[0-9A-Fa-f:.]{2,45}$/.test(h));

const ATTRIBUTE_KEYS = ["account", "mail", "name", "department", "groups", "guid", "employee_id", "title", "given_name"];

export interface LdapFormValues {
  enabled: boolean; servers: string[]; port: number; tls_mode: string; insecure_ack: boolean; ca_cert: string; tls_server_name: string;
  bind_dn: string; bind_password_set: boolean; base_dn: string; user_filter: string; login_groups: string[]; domains: string[];
  attributes: Record<string, string>; connect_timeout_sec: number; timeout_sec: number; max_failures_per_ip: number; max_failures_per_login: number;
  failure_window_minutes: number; group_sync_minutes: number; group_max_members: number; project_groups_base: string;
  /** Absent — the field is not in the form (the gateway checks the stored value). */
  group_stale_hours?: number;
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

export function ldapFormProblems(v: LdapFormValues): Record<string, string> {
  const out: Record<string, string> = {};
  const bad = (key: string, message: string) => { if (!out[key]) out[key] = message; };
  if (v.servers.length > 8) bad("servers", TEXT.atMostControllers);
  for (const h of v.servers) if (!isIpLike(h) && !HOST_RE.test(h)) bad("servers", TEXT.isNotAHostNameOrIP(h.slice(0, 80)));
  if (!Number.isInteger(v.port) || v.port < 0 || v.port > 65535) bad("port", TEXT.portMustBeAnIntegerFromTo);
  if (v.tls_mode === "none" && !v.insecure_ack) bad("insecure_ack", TEXT.withoutEncryptionPasswordsTravelAsPlainText);
  if (v.ca_cert && !/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.test(v.ca_cert)) bad("ca_cert", TEXT.theRootCertificateCouldNotBeParsed);
  if (v.tls_server_name && !HOST_RE.test(v.tls_server_name)) bad("tls_server_name", TEXT.theCertificateNameMustBeAHost);
  if (/[\r\n]/.test(v.bind_dn) || v.bind_dn.length > 1024) bad("bind_dn", TEXT.theServiceAccountDNMustBeOne);
  if (/[\r\n]/.test(v.base_dn) || v.base_dn.length > 1024) bad("base_dn", TEXT.baseDNMustBeOneLineAt);
  if (v.base_dn && !v.base_dn.includes("=")) bad("base_dn", TEXT.baseDNMustLookLikeDCCorp);
  const f = v.user_filter;
  if (f) {
    if (f.length > 2000 || !f.startsWith("(") || !f.endsWith(")") || !balanced(f)) bad("user_filter", TEXT.theFilterMustBeOneLDAPExpression);
    if (!/\{(account|username|upn)\}/.test(f)) bad("user_filter", TEXT.theFilterNeedsAnShortNameOr);
  }
  if (v.login_groups.length > 20) bad("login_groups", TEXT.atMostAccessGroups);
  for (const g of v.login_groups) if (g.length > 1024 || /[\r\n]/.test(g)) bad("login_groups", TEXT.eachGroupMustBeADNOr);
  for (const d of v.domains) if (!DOMAIN_RE.test(d)) bad("domains", TEXT.isNotADomainExampleComOr(d.slice(0, 80)));
  for (const [k, a] of Object.entries(v.attributes)) if (ATTRIBUTE_KEYS.includes(k) && typeof a === "string" && a.trim() && !ATTR_RE.test(a.trim())) bad("attributes", TEXT.attributeMustBeAnLDAPAttributeName(k, a.slice(0, 40)));
  if (!(v.connect_timeout_sec >= 1 && v.connect_timeout_sec <= 60)) bad("connect_timeout_sec", TEXT.connectionTimeoutMustBeSeconds);
  if (!(v.timeout_sec >= 1 && v.timeout_sec <= 120)) bad("timeout_sec", TEXT.operationTimeoutMustBeSeconds);
  if (!(Number.isInteger(v.max_failures_per_ip) && v.max_failures_per_ip >= 1 && v.max_failures_per_ip <= 100)) bad("max_failures_per_ip", TEXT.attemptsPerAddressMustBeAnInteger);
  if (!(Number.isInteger(v.max_failures_per_login) && v.max_failures_per_login >= 1 && v.max_failures_per_login <= 20)) bad("max_failures_per_login", TEXT.attemptsPerLoginMustBeAnInteger);
  if (!(Number.isInteger(v.failure_window_minutes) && v.failure_window_minutes >= 5 && v.failure_window_minutes <= 1440)) bad("failure_window_minutes", TEXT.theFailedSignInWindowMustBe);
  if (!(Number.isInteger(v.group_sync_minutes) && v.group_sync_minutes >= 0 && v.group_sync_minutes <= 1440)) bad("group_sync_minutes", TEXT.groupVerificationMustBeAnIntegerFrom);
  if (!(Number.isInteger(v.group_max_members) && v.group_max_members >= 1 && v.group_max_members <= 5000)) bad("group_max_members", TEXT.maximumGroupSizeMustBeAnInteger);
  if (/[\r\n]/.test(v.project_groups_base) || v.project_groups_base.length > 1024) bad("project_groups_base", TEXT.theGroupBranchMustBeOneLine);
  if (v.project_groups_base && !v.project_groups_base.includes("=")) bad("project_groups_base", TEXT.theGroupBranchMustBeADN);
  // the same rule as ldapProblems — whole hours 0–720, at least two sync periods plus an hour while both are positive
  if (v.group_stale_hours !== undefined) {
    const h = v.group_stale_hours, m = v.group_sync_minutes, least = Math.ceil((2 * m + 60) / 60);
    if (!(Number.isInteger(h) && h >= 0 && h <= 720)) bad("group_stale_hours", TEXT.membershipExpiry);
    else if (h > 0 && Number.isInteger(m) && m > 0 && m <= 1440 && h < least)
      bad("group_stale_hours", `membership expiry must cover two sync periods plus an hour: ${h} h is shorter than 2 × ldap.group_sync_minutes = ${m} min + 60 min (set at least ${least} h, or 0 — never)`);
  }
  if (v.enabled) {
    if (!v.servers.length) bad("servers", TEXT.atLeastOneControllerIsRequired);
    if (!v.bind_dn) bad("bind_dn", TEXT.theServiceAccountDNIsRequired);
    if (!v.bind_password_set) bad("bind_password", TEXT.theServiceAccountPasswordIsRequired);
    if (!v.base_dn) bad("base_dn", TEXT.baseDNIsRequired);
    if (!v.login_groups.length) bad("login_groups", TEXT.anAccessGroupMemoryUsersIsRequired);
  }
  return out;
}

export function ldapFormValues(get: (key: string) => string | null, secretSet: boolean): LdapFormValues {
  const val = (key: string, kind: LdapFieldKind): unknown => { const r = parseLdapField(kind, get(key)); return r.ok ? r.value : Number.NaN; };
  const list = (key: string, kind: LdapFieldKind) => { const x = val(key, kind); return Array.isArray(x) ? x.map(String) : []; };
  const attrs = val("attributes", "json");
  return {
    enabled: get("enabled") === "on", servers: list("servers", "hosts"), port: Number(val("port", "number")), tls_mode: String(get("tls_mode") ?? "ldaps"),
    insecure_ack: get("insecure_ack") === "on", ca_cert: String(val("ca_cert", "multiline") ?? ""), tls_server_name: String(val("tls_server_name", "text") ?? ""),
    bind_dn: String(val("bind_dn", "text") ?? ""), bind_password_set: secretSet || (get("bind_password") ?? "").trim() !== "", base_dn: String(val("base_dn", "text") ?? ""),
    user_filter: String(val("user_filter", "multiline") ?? ""), login_groups: list("login_groups", "lines"), domains: list("domains", "hosts"),
    attributes: attrs && typeof attrs === "object" ? Object.fromEntries(Object.entries(attrs as Record<string, unknown>).map(([k, x]) => [k, String(x ?? "")])) : {},
    connect_timeout_sec: Number(val("connect_timeout_sec", "number")), timeout_sec: Number(val("timeout_sec", "number")),
    max_failures_per_ip: Number(val("max_failures_per_ip", "number")), max_failures_per_login: Number(val("max_failures_per_login", "number")),
    failure_window_minutes: Number(val("failure_window_minutes", "number")),
    group_sync_minutes: Number(val("group_sync_minutes", "number")), group_max_members: Number(val("group_max_members", "number")),
    project_groups_base: String(val("project_groups_base", "text") ?? ""),
    ...(get("group_stale_hours") === null ? {} : { group_stale_hours: Number(val("group_stale_hours", "number")) }),
  };
}

export function problemsToFieldErrors(details: unknown): Record<string, string> {
  const problems = (details as { problems?: unknown } | null)?.problems;
  const out: Record<string, string> = {};
  if (!Array.isArray(problems)) return out;
  for (const p of problems) {
    const key = typeof p?.key === "string" ? p.key : null, message = typeof p?.message === "string" ? p.message : null;
    if (key && message) out[key] = out[key] ? `${out[key]}; ${message}` : message;
  }
  return out;
}

export type StepStatus = "ok" | "fail" | "warn" | "skip";
export interface StepView { status: StepStatus; title: string; message: string }

export { LDAP_STEP_TITLES } from "../messages/ldap-form";

interface RawStep { step?: unknown; status?: unknown; message?: unknown }

export function stepViews(steps: unknown, titles: Record<string, string> = LDAP_STEP_TITLES): StepView[] {
  if (!Array.isArray(steps)) return [];
  return (steps as RawStep[]).map((s) => {
    const code = String(s?.step ?? "?");
    const status = (["ok", "fail", "warn", "skip"] as const).find((x) => x === s?.status) ?? "warn";
    return { status, title: titles[code] ?? code, message: String(s?.message ?? "") };
  });
}

export { TEST_LOGIN_OUTCOMES } from "../messages/ldap-form";

interface TestLoginBody {
  ok?: boolean; outcome?: string; message?: string; ad_code?: string | null; ad_text?: string | null; login?: string | null;
  attributes?: { dn?: string; account?: string | null; mail?: string | null; name?: string | null; given_name?: string | null; department?: string | null; employee_id?: string | null; matched_groups?: string[] } | null;
  card?: { matched_by?: string | null; candidates?: string[]; login?: string | null; renamed_to?: string | null; guid_link_inactive?: boolean } | null;
  rights?: { base?: string; roles?: Array<{ role_code?: string; scope_kind?: string; scope_ref?: string | null }>; note?: string; member_of_spaces?: number | null } | null;
}



export function testLoginLines(b: TestLoginBody): string[] {
  const out: string[] = [];
  if (b.ad_code) out.push(TEXT.adSubcodeThePersonSeesOnlyIncorrect(b.ad_code, b.ad_text ? ` — ${b.ad_text}` : ""));
  if (b.message) out.push(b.message);
  const a = b.attributes;
  if (a) {
    out.push(TEXT.directoryRecord(a.dn ?? "?"));
    out.push(TEXT.memoryLoginEmailFullNameGivenName(a.mail ?? TEXT.noEmail, a.name ?? "—", a.given_name ?? TEXT.fromFullName, a.department ?? "—", a.employee_id ?? "—"));
    out.push(TEXT.matchingAccessGroups(a.matched_groups?.length ? a.matched_groups.join("; ") : TEXT.none));
  }
  const c = b.card;
  if (c) {
    if ((c.candidates?.length ?? 0) > 1) out.push(TEXT.matchingCardsConflict(c.candidates!.length));
    else if (c.login) out.push(TEXT.cardMatched(c.login, MATCHED_BY[c.matched_by ?? ""] ?? c.matched_by));
    else out.push(TEXT.noPersonSCardExistsOneWill);
    if (c.renamed_to) out.push(TEXT.theCardSLoginWillChangeTo(c.renamed_to));
    if (c.guid_link_inactive) out.push(TEXT.thePreviousDirectoryLinkWasDisabledSign);
  }
  const r = b.rights;
  if (r) {
    if (r.base) out.push(TEXT.defaultPermissions(r.base));
    out.push(r.roles?.length ? TEXT.roles(r.roles.map((x) => `${x.role_code}${x.scope_kind ? ` (${x.scope_kind}${x.scope_ref ? `: ${x.scope_ref}` : ""})` : ""}`).join(", ")) : TEXT.rolesNone(r.note ? ` — ${r.note}` : ""));
    if (typeof r.member_of_spaces === "number") out.push(TEXT.memberOfSpaces(r.member_of_spaces));
  }
  out.push(TEXT.noSessionWasCreatedNoPersonS);
  return out;
}

export function testLoginHeadline(b: TestLoginBody): string {
  return TEST_LOGIN_OUTCOMES[b.outcome ?? ""] ?? b.message ?? TEXT.outcome(b.outcome ?? TEXT.notSpecified);
}
