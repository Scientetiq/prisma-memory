import { derivedList } from "../i18n/runtime";
import { OIDC_GROUPS, OIDC_ENABLED, OIDC_STEP_TITLES, TEXT } from "../messages/oidc-form";
import { parseLdapField, type LdapField, type LdapFieldKind } from "./ldap-form";

const CALLBACK_PATH = "/auth/oidc/callback";

export { OIDC_GROUPS } from "../messages/oidc-form";

export { OIDC_ENABLED } from "../messages/oidc-form";

export function oidcRedirectFor(workplaceUrl: unknown): string | null {
  if (typeof workplaceUrl !== "string" || !workplaceUrl.trim()) return null;
  const u = asUrl(workplaceUrl.trim());
  return u && (u.protocol === "https:" || u.protocol === "http:") ? `${u.origin}${CALLBACK_PATH}` : null;
}

export const OIDC_FIELDS: LdapField[] = derivedList(() => [OIDC_ENABLED, ...OIDC_GROUPS.flatMap((g) => g.fields)]) as LdapField[];

export const oidcInput = (key: string): string => `oidc:${key}`;
export const OIDC_CLEAR_SECRET = "clear:client_secret";

const CLAIM_RE = /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/;
const SCOPE_RE = /^[\x21\x23-\x5b\x5d-\x7e]{1,64}$/;
const CLIENT_RE = /^[\x21-\x7e]{1,255}$/;
const CLAIM_KEYS = ["guid", "mail", "mail_verified", "name", "department", "employee_id", "groups", "username", "given_name"];
const asUrl = (s: string): URL | null => { try { return new URL(s); } catch { return null; } };

export interface OidcFormValues {
  enabled: boolean; issuer: string; client_id: string; client_secret_set: boolean; redirect_uri: string; scopes: string[]; ca_cert: string;
  login_groups: string[]; claims: Record<string, string>; timeout_sec: number; private_networks: string[];
}

function ipBytes(s: string): number[] | null {
  const v4 = (x: string): number[] | null => {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(x);
    const b = m ? m.slice(1).map((p) => (p.length > 1 && p.startsWith("0") ? -1 : Number(p))) : null;
    return b && b.every((n) => n >= 0 && n <= 255) ? b : null;
  };
  if (!s.includes(":")) return v4(s);
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const words = (h: string, v4Last: boolean): number[] | null => {
    if (!h) return [];
    const out: number[] = [], parts = h.split(":");
    for (const [i, p] of parts.entries()) {
      if (v4Last && i === parts.length - 1 && p.includes(".")) { const b = v4(p); if (!b) return null; out.push((b[0]! << 8) | b[1]!, (b[2]! << 8) | b[3]!); }
      else if (/^[0-9a-fA-F]{1,4}$/.test(p)) out.push(parseInt(p, 16));
      else return null;
    }
    return out;
  };
  const head = words(halves[0]!, halves.length === 1), tail = halves.length === 2 ? words(halves[1]!, true) : [];
  if (!head || !tail) return null;
  const n = head.length + tail.length;
  if (halves.length === 2 ? n > 7 : n !== 8) return null;
  return [...head, ...Array<number>(8 - n).fill(0), ...tail].flatMap((w) => [w >> 8, w & 255]);
}
const inNet = (b: readonly number[], net: readonly number[], bits: number): boolean => {
  if (b.length !== net.length) return false;
  for (let i = 0; i < bits; i++) if (((b[i >> 3]! ^ net[i >> 3]!) >> (7 - (i & 7))) & 1) return false;
  return true;
};
const PRIVATE4: Array<[number[], number]> = [[[10, 0, 0, 0], 8], [[172, 16, 0, 0], 12], [[192, 168, 0, 0], 16], [[100, 64, 0, 0], 10]];
const PRIVATE6: Array<[number[], number]> = [[ipBytes("fc00::")!, 7]];
function privateNetworkProblem(entry: string): string | null {
  const m = /^([^/\s]+)(?:\/(\d{1,3}))?$/.exec(entry);
  const bytes = m ? ipBytes(m[1]!) : null;
  const prefix = m && bytes ? (m[2] === undefined ? bytes.length * 8 : Number(m[2])) : -1;
  if (!bytes || prefix > bytes.length * 8) return TEXT.isNotAnIPAddressOrCIDR(entry.slice(0, 60));
  if (!(bytes.length === 4 ? PRIVATE4 : PRIVATE6).some(([net, bits]) => prefix >= bits && inNet(bytes, net, bits)))
    return TEXT.isNotAPrivateNetworkItMust(entry.slice(0, 60));
  return null;
}

export function oidcFormProblems(v: OidcFormValues): Record<string, string> {
  const out: Record<string, string> = {};
  const bad = (key: string, message: string) => { if (!out[key]) out[key] = message; };
  const issuer = v.issuer;                       // exact, as the gateway reads it (oidcConfig)
  if (issuer) {
    const u = asUrl(issuer);
    if (!u || u.protocol !== "https:" || u.search || u.hash || u.username || u.password || issuer.length > 500)
      bad("issuer", TEXT.theIssuerURLMustBeHttpsServer);
  }
  if (v.client_id && !CLIENT_RE.test(v.client_id)) bad("client_id", TEXT.clientIDMustUseLatinLettersDigits);
  if (v.redirect_uri) {
    const u = asUrl(v.redirect_uri);
    if (v.redirect_uri.length > 500) bad("redirect_uri", TEXT.theReturnURLMustBeAtMost);
    else if (!u || (u.protocol !== "http:" && u.protocol !== "https:") || u.hash || u.search || u.username || u.password)
      bad("redirect_uri", TEXT.theReturnURLMustBeHttpS(CALLBACK_PATH));
    else if (u.pathname !== CALLBACK_PATH) bad("redirect_uri", TEXT.theReturnURLPathMustBeHandled(CALLBACK_PATH));
  }
  if (!v.scopes.includes("openid")) bad("scopes", TEXT.openidIsRequiredInTheListOtherwise);
  if (v.scopes.length > 20) bad("scopes", TEXT.atMostScopes);
  for (const s of v.scopes) if (!SCOPE_RE.test(s)) bad("scopes", TEXT.isNotAScopeNameSpaceSeparated(s.slice(0, 40)));
  if (v.ca_cert && (v.ca_cert.length > 64_000 || (v.ca_cert.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length > 10))
    bad("ca_cert", TEXT.theRootCertificateMustBeAtMost);
  if (v.ca_cert && !/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.test(v.ca_cert)) bad("ca_cert", TEXT.theRootCertificateCouldNotBeParsed);
  if (v.login_groups.length > 20) bad("login_groups", TEXT.atMostAccessGroups);
  for (const g of v.login_groups) if (g.length > 255 || /[\r\n]/.test(g)) bad("login_groups", TEXT.eachGroupMustBeANameOr);
  for (const [k, c] of Object.entries(v.claims)) if (CLAIM_KEYS.includes(k) && typeof c === "string" && c.trim() && !CLAIM_RE.test(c.trim())) bad("claims", TEXT.claimMustBeAClaimNameLatin(k, c.slice(0, 40)));
  if (!(v.timeout_sec >= 1 && v.timeout_sec <= 60)) bad("timeout_sec", TEXT.timeoutMustBeSeconds);
  if (v.private_networks.length > 20) bad("private_networks", TEXT.atMostPrivateNetworks);
  for (const n of v.private_networks) { const why = privateNetworkProblem(n); if (why) bad("private_networks", why); }
  if (v.enabled) {
    if (!issuer) bad("issuer", TEXT.anIssuerURLIsRequiredHttpsAuth);
    if (!v.client_id) bad("client_id", TEXT.aClientIDIsRequiredTheCompany);
    if (!v.client_secret_set) bad("client_secret", TEXT.aClientSecretIsRequiredForThe);
    if (!v.redirect_uri) bad("redirect_uri", TEXT.aReturnURLIsRequiredHttpWorkspace(CALLBACK_PATH));
    if (!v.login_groups.length) bad("login_groups", TEXT.anAccessGroupMemoryUsersIsRequired);
  }
  return out;
}

export function oidcFormValues(get: (key: string) => string | null, secretSet: boolean): OidcFormValues {
  const val = (key: string, kind: LdapFieldKind): unknown => { const r = parseLdapField(kind, get(key)); return r.ok ? r.value : Number.NaN; };
  const text = (key: string, kind: LdapFieldKind = "text") => String(val(key, kind) ?? "");
  const claims = val("claims", "json");
  return {
    enabled: get("enabled") === "on", issuer: text("issuer"), client_id: text("client_id"), client_secret_set: secretSet || (get("client_secret") ?? "").trim() !== "",
    redirect_uri: text("redirect_uri"), scopes: [...new Set(text("scopes").split(/\s+/).filter(Boolean))], ca_cert: text("ca_cert", "multiline"),
    login_groups: ((x) => (Array.isArray(x) ? x.map(String) : []))(val("login_groups", "lines")),
    claims: claims && typeof claims === "object" ? Object.fromEntries(Object.entries(claims as Record<string, unknown>).map(([k, x]) => [k, String(x ?? "")])) : {},
    timeout_sec: Number(val("timeout_sec", "number")),
    private_networks: ((x) => (Array.isArray(x) ? x.map(String) : []))(val("private_networks", "hosts")),
  };
}

export { OIDC_STEP_TITLES } from "../messages/oidc-form";
