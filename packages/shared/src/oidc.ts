import { createHash, randomBytes } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions, type LookupOptions } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { compactVerify, decodeProtectedHeader, importJWK, type JWK } from "jose";
import { formatObjectGuid, objectGuidBytes, parseCaCerts, type LdapStep } from "./ldap.ts";
import type { Settings } from "./settings.ts";

export interface OidcClaimNames { guid: string; mail: string; mail_verified: string; name: string; department: string; employee_id: string; groups: string; username: string; given_name: string }
export const OIDC_DEFAULT_CLAIMS: OidcClaimNames = {
  guid: "LDAP_ID", mail: "email", mail_verified: "email_verified", name: "name", department: "department", employee_id: "employee_id", groups: "groups", username: "preferred_username",
  given_name: "given_name",
};
export const OIDC_DEFAULT_SCOPES = "openid profile email";
export const OIDC_CALLBACK_PATH = "/auth/oidc/callback";
export const OIDC_IDENTITY_KEYS = new Set(["enabled", "issuer", "client_id", "ca_cert", "login_groups", "claims"]);
export const OIDC_LOGIN_TTL_SEC = 600;
export const OIDC_CLOCK_SKEW_SEC = 300;
export const MAX_JWS_CHARS = 32_768;

export interface OidcConfig {
  enabled: boolean; issuer: string; client_id: string; client_secret: string; redirect_uri: string; scopes: string[]; ca_cert: string;
  login_groups: string[]; claims: OidcClaimNames; timeout_sec: number; private_networks: string[];
}
export type OidcProviderConfig = Pick<OidcConfig, "issuer" | "ca_cert" | "timeout_sec"> & { private_networks?: readonly string[] };

const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean) : []);
export const oidcPrivateNetworks = (s: Pick<Settings, "get">): string[] => listOf(s.get<unknown>("oidc.private_networks", []));

export function oidcConfig(s: Pick<Settings, "get">): OidcConfig {
  const str = (k: string, d = "") => { const v = s.get<unknown>(`oidc.${k}`, d); return typeof v === "string" ? v.trim() : d; };
  const num = (k: string, d: number) => { const v = Number(s.get<unknown>(`oidc.${k}`, d)); return Number.isFinite(v) ? v : d; };
  const claims = s.get<Partial<OidcClaimNames>>("oidc.claims", OIDC_DEFAULT_CLAIMS);
  const secret = s.get<unknown>("oidc.client_secret", "");
  return {
    enabled: s.get<unknown>("oidc.enabled", false) === true,
    // the issuer is an exact string (OpenID Connect Discovery 1.0 §4.3, RFC 8414 §3.3): Keycloak publishes «…/realms/name»,
    // Auth0 «https://tenant/» — kept as written, only surrounding whitespace trimmed
    issuer: str("issuer"),
    client_id: str("client_id"), client_secret: typeof secret === "string" ? secret : "", redirect_uri: str("redirect_uri"),
    scopes: [...new Set(str("scopes", OIDC_DEFAULT_SCOPES).split(/\s+/).filter(Boolean))], ca_cert: str("ca_cert"), login_groups: listOf(s.get<unknown>("oidc.login_groups", [])),
    claims: Object.fromEntries(Object.entries(OIDC_DEFAULT_CLAIMS).map(([k, d]) => {
      const v = claims?.[k as keyof OidcClaimNames];
      return [k, typeof v === "string" && v.trim() ? v.trim() : d];
    })) as unknown as OidcClaimNames,
    timeout_sec: num("timeout_sec", 10), private_networks: oidcPrivateNetworks(s),
  };
}

const CLAIM_RE = /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/;
const SCOPE_RE = /^[\x21\x23-\x5b\x5d-\x7e]{1,64}$/;
const CLIENT_RE = /^[\x21-\x7e]{1,255}$/;

const asUrl = (s: string): URL | null => { try { return new URL(s); } catch { return null; } };

export function oidcProblems(cfg: OidcConfig): Array<{ key: string; message: string }> {
  const out: Array<{ key: string; message: string }> = [];
  const bad = (key: string, message: string) => out.push({ key, message });
  if (cfg.issuer) {
    const u = asUrl(cfg.issuer);
    if (!u || u.protocol !== "https:" || u.search || u.hash || u.username || u.password || cfg.issuer.length > 500)
      bad("issuer", "the issuer URL must be https://server/realms/name, without ? or # (client secrets and tokens require HTTPS)");
  }
  if (cfg.client_id && !CLIENT_RE.test(cfg.client_id)) bad("client_id", "client ID must use Latin letters, digits and symbols without spaces, at most 255 characters");
  if (cfg.redirect_uri) {
    const u = asUrl(cfg.redirect_uri);
    if (cfg.redirect_uri.length > 500) bad("redirect_uri", "the return URL must be at most 500 characters");
    else if (!u || (u.protocol !== "http:" && u.protocol !== "https:") || u.hash || u.search || u.username || u.password)
      bad("redirect_uri", `callback URL: http(s)://workspace-address${OIDC_CALLBACK_PATH}, without ? or #`);
    else if (u.pathname !== OIDC_CALLBACK_PATH) bad("redirect_uri", `callback URL path: ${OIDC_CALLBACK_PATH} (handled by the workspace)`);
  }
  if (!cfg.scopes.includes("openid")) bad("scopes", "openid is required in the list; otherwise the identity provider issues no ID token");
  if (cfg.scopes.length > 20) bad("scopes", "at most 20 scopes");
  for (const s of cfg.scopes) if (!SCOPE_RE.test(s)) bad("scopes", `“${s.slice(0, 40)}” is not a scope name (separate names with spaces: openid profile email)`);
  if (cfg.ca_cert) {
    if (cfg.ca_cert.length > 64_000 || (cfg.ca_cert.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length > 10)
      bad("ca_cert", "the root certificate must be at most 64000 characters, with at most 10 certificates in the chain");
    else try { parseCaCerts(cfg.ca_cert); } catch (e) { bad("ca_cert", `could not parse the root certificate: ${(e as Error).message}`); }
  }
  if (cfg.login_groups.length > 20) bad("login_groups", "at most 20 access groups");
  for (const g of cfg.login_groups) if (g.length > 255 || /[\r\n]/.test(g)) bad("login_groups", "each group must be a name or path (/memory-users) on one line, at most 255 characters");
  for (const [k, v] of Object.entries(cfg.claims)) if (!CLAIM_RE.test(v)) bad("claims", `claim ${k}: “${v.slice(0, 40)}” must be a claim name (Latin letters, digits, _ . : -)`);
  if (!(cfg.timeout_sec >= 1 && cfg.timeout_sec <= 60)) bad("timeout_sec", "timeout must be 1–60 seconds");
  if (cfg.private_networks.length > 20) bad("private_networks", "at most 20 private networks");
  for (const n of cfg.private_networks) { const why = privateNetworkProblem(n); if (why) bad("private_networks", why); }
  if (cfg.enabled) {
    if (!cfg.issuer) bad("issuer", "an issuer URL is required (https://auth.example.com/realms/example)");
    if (!cfg.client_id) bad("client_id", "a client ID is required (the client at the identity provider, for example memory)");
    if (!cfg.client_secret) bad("client_secret", "a client secret is required for the confidential client at the identity provider");
    if (!cfg.redirect_uri) bad("redirect_uri", `redirect URI required (http://example.com${OIDC_CALLBACK_PATH}), matching the one in the client at the identity provider`);
    if (!cfg.login_groups.length) bad("login_groups", "an access group (memory-users) is required; without it nobody can sign in");
  }
  return out;
}

export type OidcFailureCode =
  | "oidc_disabled" | "oidc_not_configured" | "oidc_dns_failed" | "oidc_unreachable" | "oidc_tls_failed" | "oidc_timeout" | "oidc_bad_response"
  | "oidc_address_blocked" | "oidc_discovery_invalid" | "oidc_client_rejected" | "oidc_code_invalid" | "oidc_token_invalid" | "oidc_claim_missing"
  | "oidc_claim_invalid" | "oidc_state_invalid" | "oidc_provider_error"
  | "oidc_rate_limited" | "oidc_request_invalid" | "oidc_internal";

export const OIDC_FAILURE_TEXT: Record<OidcFailureCode, string> = {
  oidc_disabled: "Sign-in through the identity provider is off. A memory administrator can turn it on under “Single sign-on” in the admin panel",
  oidc_not_configured: "Setup of sign-in through the identity provider is incomplete. The administrator can finish it under “Single sign-on” in the admin panel",
  oidc_dns_failed: "The memory server cannot resolve the host name of the identity provider. Check the issuer address and the memory server’s DNS",
  oidc_unreachable: "The memory server cannot reach the identity provider. Check the issuer address and network access from the memory server (port 443)",
  oidc_tls_failed: "Could not establish a secure connection to the identity provider. Check the root certificate under “Single sign-on”",
  oidc_timeout: "The identity provider did not respond in time. Check its availability and the timeout under “Single sign-on”",
  oidc_bad_response: "The identity provider did not return a valid OpenID Connect response. Check the issuer address (in Keycloak: …/realms/ followed by the realm name)",
  oidc_address_blocked: "A network rule on the memory server blocks the address of the identity provider. Check “Provider private networks” under “Single sign-on”",
  oidc_discovery_invalid: "The identity provider metadata is invalid for sign-in. See “Check provider” under “Single sign-on”",
  oidc_client_rejected: "The identity provider rejected the memory client. Check the client ID and client secret under “Single sign-on”",
  oidc_code_invalid: "Sign-in was not completed. The sign-in code expired or was already used. Start again",
  oidc_token_invalid: "The identity provider returned a token that failed validation. Sign-in was denied",
  oidc_claim_missing: "The identity provider token is missing a required claim. Check the claims the client issues (LDAP_ID, email, groups) and the claim names under “Single sign-on”",
  oidc_claim_invalid: "The identity provider account data contains invalid characters. Contact the memory administrator",
  oidc_state_invalid: "The sign-in attempt expired or was already completed. Start again",
  oidc_provider_error: "The identity provider could not complete sign-in",
  oidc_rate_limited: "Too many sign-in attempts through the identity provider. Wait a minute",
  oidc_request_invalid: "The sign-in response of the identity provider has an invalid format. Start again",
  oidc_internal: "Sign-in through the identity provider failed because of an internal error in the memory. Try again or sign in with your username and password",
};

export class OidcFailure extends Error {
  constructor(readonly code: OidcFailureCode, readonly detail: string) { super(OIDC_FAILURE_TEXT[code]); }
}

const logText = (s: unknown): string => String(s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
const HIDDEN = /[\p{Cc}\p{Cf}]/u;

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
const v6 = (s: string): number[] => ipBytes(s)!;

export type OidcAddressKind = "public" | "private" | "loopback" | "unspecified" | "link_local" | "multicast" | "broadcast" | "reserved" | "metadata" | "invalid";
const RULES4: Array<[OidcAddressKind, number[], number]> = [
  ["unspecified", [0, 0, 0, 0], 8], ["loopback", [127, 0, 0, 0], 8], ["link_local", [169, 254, 0, 0], 16], ["multicast", [224, 0, 0, 0], 4],
  ["broadcast", [255, 255, 255, 255], 32], ["reserved", [240, 0, 0, 0], 4],
  ["private", [10, 0, 0, 0], 8], ["private", [172, 16, 0, 0], 12], ["private", [192, 168, 0, 0], 16], ["private", [100, 64, 0, 0], 10],
];
const RULES6: Array<[OidcAddressKind, number[], number]> = [
  ["unspecified", v6("::"), 128], ["loopback", v6("::1"), 128], ["reserved", v6("::"), 96],
  ["link_local", v6("fe80::"), 10], ["reserved", v6("fec0::"), 10], ["multicast", v6("ff00::"), 8], ["private", v6("fc00::"), 7],
];
/** Private ranges: every entry of the provider's private networks (oidc.private_networks) must lie inside them. */
const PRIVATE4 = RULES4.filter(([k]) => k === "private"), PRIVATE6 = RULES6.filter(([k]) => k === "private");
const METADATA = ["169.254.169.254", "100.100.100.200", "fd00:ec2::254", "fd20:ce::254", "fd00:c1::a9fe:a9fe"].map((a) => ipBytes(a)!);
const MAPPED = v6("::ffff:0:0"), NAT64 = v6("64:ff9b::");

const effective = (b: number[]): number[] => (b.length === 16 && (inNet(b, MAPPED, 96) || inNet(b, NAT64, 96)) ? b.slice(12) : b);
function kindOf(bytes: number[]): OidcAddressKind {
  const b = effective(bytes);
  if (METADATA.some((m) => m.length === b.length && m.every((x, i) => x === b[i]))) return "metadata";
  for (const [kind, net, bits] of b.length === 4 ? RULES4 : RULES6) if (inNet(b, net, bits)) return kind;
  return "public";
}
export function oidcAddressKind(ip: string): OidcAddressKind { const b = ipBytes(ip); return b ? kindOf(b) : "invalid"; }

function parseNetwork(entry: string): { bytes: number[]; prefix: number } | null {
  const m = /^([^/\s]+)(?:\/(\d{1,3}))?$/.exec(entry);
  const bytes = m ? ipBytes(m[1]!) : null;
  if (!m || !bytes) return null;
  const prefix = m[2] === undefined ? bytes.length * 8 : Number(m[2]);
  return prefix <= bytes.length * 8 ? { bytes, prefix } : null;
}
export function privateNetworkProblem(entry: string): string | null {
  const n = parseNetwork(entry);
  if (!n) return `“${entry.slice(0, 60)}” is not an IP address or CIDR block (for example, 10.0.0.5/32)`;
  if (!(n.bytes.length === 4 ? PRIVATE4 : PRIVATE6).some(([, net, bits]) => n.prefix >= bits && inNet(n.bytes, net, bits)))
    return `“${entry.slice(0, 60)}” is not a private network. Use a range within 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, fc00::/7`;
  return null;
}

const ipText = (b: readonly number[]): string =>
  b.length === 4 ? b.join(".") : Array.from({ length: 8 }, (_, i) => ((b[2 * i]! << 8) | b[2 * i + 1]!).toString(16)).join(":");
function allowList(entries: readonly string[]): BlockList {
  const list = new BlockList();
  for (const e of entries) {
    const n = parseNetwork(e);
    if (n) list.addSubnet(ipText(n.bytes), n.prefix, n.bytes.length === 4 ? "ipv4" : "ipv6");
  }
  return list;
}

export interface OidcNetPolicy { privateNetworks?: readonly string[]; allowLoopback?: boolean }
const KIND_TEXT: Record<Exclude<OidcAddressKind, "public" | "private">, string> = {
  loopback: "loopback (the memory server itself)", unspecified: "unspecified address", link_local: "link-local", multicast: "multicast",
  broadcast: "broadcast address", reserved: "reserved address", metadata: "cloud metadata address", invalid: "not an IP address",
};

export function oidcAddressRefusal(ip: string, policy: OidcNetPolicy = {}): string | null {
  const bytes = ipBytes(ip), kind = bytes ? kindOf(bytes) : "invalid";
  if (kind === "public" || (kind === "loopback" && policy.allowLoopback)) return null;
  if (kind === "private") {
    const nets = policy.privateNetworks ?? [], b = effective(bytes!);
    if (!nets.length) return `private address and “Provider private networks” is empty. If this is the identity provider, enter ${ipText(b)}/${b.length * 8}`;
    return allowList(nets).check(ipText(b), b.length === 4 ? "ipv4" : "ipv6") ? null : "private address outside “Provider private networks”";
  }
  return `${KIND_TEXT[kind]} — always blocked`;
}

const addressBlocked = (where: string, why: string): Error => Object.assign(new Error(`${where}: ${why}`), { code: "OIDC_ADDRESS_BLOCKED" });
type Resolve = (hostname: string, options: LookupAllOptions, callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;
/** The DNS step oidcLookup checks (dns.lookup with all: true); tests pass their own answers (a mixed answer). */
export type OidcResolve = Resolve;
const systemResolve: Resolve = (hostname, options, callback) => dnsLookup(hostname, options, callback);

export function oidcLookup(policy: OidcNetPolicy = {}, resolve: Resolve = systemResolve): LookupFunction {
  return (hostname, options, callback) => {
    const o: LookupOptions = options && typeof options === "object" ? options : {};
    const fail = (e: NodeJS.ErrnoException) => (o.all ? callback(e, []) : callback(e, "", 0));
    const done = (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => {
      if (err) return fail(err);
      if (!Array.isArray(addresses) || !addresses.length) return fail(Object.assign(new Error(`${hostname}: DNS returned no addresses`), { code: "ENOTFOUND" }));
      for (const a of addresses) {
        const why = oidcAddressRefusal(a.address, policy);
        if (why) return fail(addressBlocked(`${hostname} → ${a.address}`, why));
      }
      return o.all ? callback(null, addresses) : callback(null, addresses[0]!.address, addresses[0]!.family);
    };
    try { resolve(hostname, { ...o, all: true }, done); } catch (e) { fail(e as NodeJS.ErrnoException); }
  };
}

/**
 * cacheControl — the Cache-Control header of the reply when the server sent one (client metadata documents use it for the
 * cache lifetime); absent otherwise.
 */
export interface HttpReply { status: number; contentType: string; text: string; cacheControl?: string }
/**
 * onLookup — told of every DNS lookup of this request when it starts, with a promise that settles when the resolver has
 * really answered (the system resolver cannot be cancelled, a deadline ends the request but not its
 * lookup — the client metadata fetcher holds its download slot until the lookup is over); a transport without DNS of its
 * own (a stand-in of tests) never calls it.
 */
export interface OidcRequestOptions { method: "GET" | "POST"; headers?: Record<string, string>; body?: string; ca?: string; timeoutMs: number; privateNetworks?: readonly string[]; maxBytes?: number;
  onLookup?: (settled: Promise<void>) => void }
export interface OidcTransport {
  request(url: URL, o: OidcRequestOptions): Promise<HttpReply>;
}
const MAX_BODY = 1_000_000;
// the default limit keeps its former error text; a custom limit names itself
const bodyTooLarge = (limit: number): Error =>
  Object.assign(new Error(limit === MAX_BODY ? "provider response exceeds 1 MB" : `response body is larger than ${limit} bytes`), { bodyLimit: limit });
const timeoutError = (ms: number): Error => Object.assign(new Error(`no response within ${Math.round(ms / 1000)} s`), { code: "OIDC_TIMEOUT" });

/** The resolver that reports each lookup to onLookup: started — a promise, settled once the resolver calls back or throws. */
function reportedLookups(resolve: Resolve, onLookup: (settled: Promise<void>) => void): Resolve {
  return (hostname, options, callback) => {
    let settle!: () => void;
    onLookup(new Promise<void>((r) => { settle = r; }));
    try {
      resolve(hostname, options, (err, addresses) => { settle(); callback(err, addresses); });
    } catch (e) {
      settle();
      throw e;
    }
  };
}

export function makeSystemHttp(opts: { allowLoopback?: boolean; resolve?: OidcResolve } = {}): OidcTransport {
  return {
    request(url, o) {
      return new Promise<HttpReply>((resolve, reject) => {
        const limit = o.maxBytes ?? MAX_BODY;
        if (!Number.isSafeInteger(limit) || limit <= 0) { reject(new TypeError(`maxBytes must be a positive integer, got ${String(o.maxBytes)}`)); return; }
        const policy: OidcNetPolicy = { privateNetworks: o.privateNetworks ?? [], allowLoopback: opts.allowLoopback === true };
        const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
        if (isIP(host)) { const why = oidcAddressRefusal(host, policy); if (why) { reject(addressBlocked(host, why)); return; } }
        const send = url.protocol === "https:" ? httpsRequest : httpRequest;
        const req = send(url, { method: o.method, headers: { accept: "application/json", ...(o.headers ?? {}) }, ...(o.ca ? { ca: o.ca } : {}), rejectUnauthorized: true, timeout: o.timeoutMs,
                               lookup: oidcLookup(policy, o.onLookup ? reportedLookups(opts.resolve ?? systemResolve, o.onLookup) : opts.resolve), agent: false }, (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          // Over the limit: reject at once. When the overflowing chunk is also the last one, "end" fires before the error of
          // destroy() arrives, and a reply without that chunk used to resolve (a truncated body); "end" after an overflow
          // therefore resolves nothing.
          res.on("data", (c: Buffer) => {
            if (size > limit) return;
            size += c.length;
            if (size > limit) { const e = bodyTooLarge(limit); reject(e); req.destroy(e); return; }
            chunks.push(c);
          });
          res.on("end", () => {
            clearTimeout(deadline);
            if (size > limit) return;
            const cc = res.headers["cache-control"];
            resolve({ status: res.statusCode ?? 0, contentType: String(res.headers["content-type"] ?? ""), text: Buffer.concat(chunks).toString("utf8"),
                      ...(cc !== undefined ? { cacheControl: String(cc) } : {}) });
          });
          res.on("error", (e) => { clearTimeout(deadline); reject(e); });
        });
        const deadline = setTimeout(() => req.destroy(timeoutError(o.timeoutMs)), o.timeoutMs);
        req.on("timeout", () => req.destroy(timeoutError(o.timeoutMs)));
        req.on("error", (e) => { clearTimeout(deadline); reject(e); });
        req.on("close", () => clearTimeout(deadline));
        if (o.body !== undefined) req.write(o.body);
        req.end();
      });
    },
  };
}
export const systemHttp: OidcTransport = makeSystemHttp();

const TLS_CODE = /CERT|TLS|SSL|SELF_SIGNED|ALTNAME|UNABLE_TO|EPROTO|HANDSHAKE/i;
const NET_CODE = /^(ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNRESET|EADDRNOTAVAIL|EPIPE)$/;

export function transportFailure(e: unknown, url: URL): OidcFailure {
  const err = e as { code?: string; message?: string };
  const text = `${url.host}: ${logText(err.message ?? e)}${err.code ? ` (${err.code})` : ""}`;
  if (err.code === "OIDC_ADDRESS_BLOCKED") return new OidcFailure("oidc_address_blocked", text);
  if (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN") return new OidcFailure("oidc_dns_failed", text);
  if (err.code === "OIDC_TIMEOUT") return new OidcFailure("oidc_timeout", text);
  if (TLS_CODE.test(err.code ?? "") || /certificate|ssl|tls/i.test(err.message ?? "")) return new OidcFailure("oidc_tls_failed", text);
  if (NET_CODE.test(err.code ?? "")) return new OidcFailure("oidc_unreachable", text);
  return new OidcFailure("oidc_unreachable", text);
}

async function call(cfg: OidcProviderConfig, t: OidcTransport, url: string, o: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string } = {}): Promise<HttpReply> {
  const u = asUrl(url);
  if (!u || u.protocol !== "https:") throw new OidcFailure("oidc_discovery_invalid", `provider address is not https: ${logText(url).slice(0, 200)}`);
  try {
    return await t.request(u, { method: o.method ?? "GET", headers: o.headers, body: o.body, ca: cfg.ca_cert || undefined, timeoutMs: cfg.timeout_sec * 1000,
                                privateNetworks: cfg.private_networks ?? [] });
  } catch (e) {
    throw e instanceof OidcFailure ? e : transportFailure(e, u);
  }
}

function parseJson(r: HttpReply, what: string): Record<string, unknown> {
  if (!/json/i.test(r.contentType)) throw new OidcFailure("oidc_bad_response", `${what}: HTTP ${r.status}, response type “${logText(r.contentType).slice(0, 80) || "unspecified"}” is not JSON`);
  try {
    const v = JSON.parse(r.text) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { }
  throw new OidcFailure("oidc_bad_response", `${what}: HTTP ${r.status}, expected a JSON object (${logText(r.contentType) || "no type"})`);
}

export interface OidcDiscovery {
  issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; userinfo_endpoint: string | null;
  end_session_endpoint: string | null; code_challenge_methods: string[] | null; token_auth_methods: string[] | null; signing_algs: string[] | null;
  iss_parameter: boolean;
}

export const OIDC_SIGNING_ALGS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512"] as const;
type SigningAlg = (typeof OIDC_SIGNING_ALGS)[number];

const strList = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null);
const optStr = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/**
 * Metadata address of an issuer (OpenID Connect Discovery 1.0 §4.1): any terminating «/» removed, then
 * «/.well-known/openid-configuration» appended — «https://tenant/» and «https://tenant» are read from one address, without a
 * double slash. The issuer itself stays exact: the metadata must name it byte for byte (discoveryProblems).
 */
export const oidcDiscoveryUrl = (issuer: string): string => `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;

/**
 * Hint for an issuer that differs from the published one only by the trailing «/» (both are read from one metadata address):
 * the value to write, first — health cuts the joined problems at 300 characters (gateway/src/health.ts). Other
 * differences — empty string.
 */
export function issuerSlashHint(configured: string, published: string): string {
  return configured !== published && configured.replace(/\/+$/, "") === published.replace(/\/+$/, "")
    ? ` — set it to "${logText(published).slice(0, 200)}": only the trailing "/" differs from the metadata, and the issuer must match exactly (OpenID Connect Discovery 1.0 §4.3)`
    : "";
}

export async function fetchDiscovery(cfg: OidcProviderConfig, t: OidcTransport = systemHttp): Promise<OidcDiscovery> {
  if (!cfg.issuer) throw new OidcFailure("oidc_not_configured", "issuer address is missing (oidc.issuer)");
  const url = oidcDiscoveryUrl(cfg.issuer);
  const r = await call(cfg, t, url);
  if (r.status !== 200) throw new OidcFailure("oidc_bad_response", `metadata: HTTP ${r.status} at ${url}. For the issuer address, use an HTTPS server address followed by /realms/ and the realm name`);
  const j = parseJson(r, "metadata");
  return {
    issuer: String(j.issuer ?? ""), authorization_endpoint: String(j.authorization_endpoint ?? ""), token_endpoint: String(j.token_endpoint ?? ""),
    jwks_uri: String(j.jwks_uri ?? ""), userinfo_endpoint: optStr(j.userinfo_endpoint), end_session_endpoint: optStr(j.end_session_endpoint),
    code_challenge_methods: strList(j.code_challenge_methods_supported), token_auth_methods: strList(j.token_endpoint_auth_methods_supported),
    signing_algs: strList(j.id_token_signing_alg_values_supported), iss_parameter: j.authorization_response_iss_parameter_supported === true,
  };
}

export function discoveryProblems(cfg: OidcProviderConfig, d: OidcDiscovery): string[] {
  const out: string[] = [];
  const slash = issuerSlashHint(cfg.issuer, d.issuer);   // the hint already names the published value: not repeated
  if (d.issuer !== cfg.issuer) out.push(slash ? `issuer “${cfg.issuer}”${slash}` : `metadata issuer “${logText(d.issuer).slice(0, 200)}” does not match the configured issuer “${cfg.issuer}”`);
  const host = asUrl(cfg.issuer)?.host ?? "";
  const endpoints: Array<[string, string | null, boolean]> = [["authorization_endpoint", d.authorization_endpoint, true], ["token_endpoint", d.token_endpoint, true],
    ["jwks_uri", d.jwks_uri, true], ["userinfo_endpoint", d.userinfo_endpoint, false], ["end_session_endpoint", d.end_session_endpoint, false]];
  for (const [k, v, required] of endpoints) {
    if (!v) { if (required) out.push(`missing ${k}`); continue; }
    const u = asUrl(v);
    if (!u) out.push(`${k} is not a valid address: ${logText(v).slice(0, 200)}`);
    else if (u.protocol !== "https:") out.push(`${k} does not use HTTPS: ${logText(v).slice(0, 200)}`);
    else if (u.username || u.password || u.hash) out.push(`${k} contains a username, password or # in the address`);
    else if (u.host !== host) out.push(`${k} is on host “${logText(u.host).slice(0, 100)}” and the issuer is on “${host}”. Provider addresses must be on the issuer host`);
  }
  if (d.code_challenge_methods && !d.code_challenge_methods.includes("S256")) out.push("provider does not advertise PKCE S256 (code_challenge_methods_supported)");
  if (d.token_auth_methods && !d.token_auth_methods.some((m) => m === "client_secret_basic" || m === "client_secret_post"))
    out.push("provider does not accept a client secret (token_endpoint_auth_methods_supported has neither client_secret_basic nor client_secret_post)");
  if (d.signing_algs && !d.signing_algs.some((a) => (OIDC_SIGNING_ALGS as readonly string[]).includes(a))) out.push("no supported ID token signing algorithm (RS256, PS256, ES256…)");
  return out;
}

export interface Jwk { kty?: string; kid?: string; use?: string; alg?: string; crv?: string; n?: string; e?: string; x?: string; y?: string; key_ops?: string[] }
const MAX_JWKS_KEYS = 100;

export async function fetchJwks(cfg: OidcProviderConfig, d: OidcDiscovery, t: OidcTransport = systemHttp): Promise<Jwk[]> {
  const r = await call(cfg, t, d.jwks_uri);
  if (r.status !== 200) throw new OidcFailure("oidc_bad_response", `JWKS keys: HTTP ${r.status}`);
  const keys = parseJson(r, "JWKS keys").keys;
  if (!Array.isArray(keys)) throw new OidcFailure("oidc_bad_response", "JWKS keys: missing keys array");
  if (keys.length > MAX_JWKS_KEYS) throw new OidcFailure("oidc_bad_response", `JWKS keys: ${keys.length} keys, exceeding the limit of ${MAX_JWKS_KEYS}`);
  return keys.filter((k): k is Jwk => !!k && typeof k === "object" && !Array.isArray(k));
}

const CACHE_MAX = 16;
function remember<V>(m: Map<string, V>, k: string, v: V): void {
  m.delete(k);
  m.set(k, v);
  while (m.size > CACHE_MAX) m.delete(m.keys().next().value as string);
}

export const PROVIDER_FAILURE_TTL_MS = 5_000;

export class ProviderCache {
  private disco = new Map<string, { at: number; d: OidcDiscovery }>();
  private keys = new Map<string, { at: number; keys: Jwk[] }>();
  private inflight = new Map<string, Promise<unknown>>();
  private failed = new Map<string, { at: number; e: unknown }>();
  constructor(private readonly t: OidcTransport = systemHttp, private readonly discoTtlMs = 300_000, private readonly keysTtlMs = 600_000,
              private readonly failureTtlMs = PROVIDER_FAILURE_TTL_MS) {}
  private shared<T>(key: string, load: () => Promise<T>): Promise<T> {
    const fail = this.failed.get(key);
    if (fail && Date.now() - fail.at < this.failureTtlMs) return Promise.reject(fail.e);
    const running = this.inflight.get(key) as Promise<T> | undefined;
    if (running) return running;
    const p = load()
      .then((v) => { this.failed.delete(key); return v; }, (e: unknown) => { remember(this.failed, key, { at: Date.now(), e }); throw e; })
      .finally(() => { if (this.inflight.get(key) === p) this.inflight.delete(key); });
    this.inflight.set(key, p);
    return p;
  }
  private id = (cfg: OidcProviderConfig): string =>
    `${cfg.issuer}\n${createHash("sha256").update(cfg.ca_cert).digest("hex")}\n${(cfg.private_networks ?? []).join(" ")}`;
  get transport(): OidcTransport { return this.t; }
  async discovery(cfg: OidcProviderConfig, fresh = false, validate = discoveryProblems): Promise<OidcDiscovery> {
    const k = this.id(cfg), hit = this.disco.get(k);
    const cached = !fresh && hit && Date.now() - hit.at < this.discoTtlMs;
    const d = cached ? hit.d : await this.shared(`d\n${k}`, () => fetchDiscovery(cfg, this.t));
    const problems = validate(cfg, d);
    if (problems.length) { this.disco.delete(k); throw new OidcFailure("oidc_discovery_invalid", problems.join("; ")); }
    if (!cached) remember(this.disco, k, { at: Date.now(), d });
    return d;
  }
  async jwks(cfg: OidcProviderConfig, d: OidcDiscovery, fresh = false): Promise<Jwk[]> {
    const k = `${this.id(cfg)}\n${d.jwks_uri}`, hit = this.keys.get(k);
    if (hit && !fresh && Date.now() - hit.at < this.keysTtlMs) return hit.keys;
    if (hit && fresh && Date.now() - (this.forced.get(k) ?? 0) < 30_000) return hit.keys;
    if (fresh) remember(this.forced, k, Date.now());
    const keys = await this.shared(`k\n${k}`, () => fetchJwks(cfg, d, this.t));
    remember(this.keys, k, { at: Date.now(), keys });
    return keys;
  }
  private forced = new Map<string, number>();
  clear(): void { this.disco.clear(); this.keys.clear(); this.forced.clear(); this.inflight.clear(); this.failed.clear(); }
}

export interface PendingLogin { state: string; nonce: string; verifier: string; redirect_uri: string; fresh?: boolean; started_at?: number }
const token = (bytes = 32): string => randomBytes(bytes).toString("base64url");
export const pkceChallenge = (verifier: string): string => createHash("sha256").update(verifier).digest("base64url");

export function authorizationRequest(cfg: OidcConfig, d: OidcDiscovery, o: { fresh?: boolean; now?: number } = {}): { url: string; pending: PendingLogin } {
  const pending: PendingLogin = { state: token(), nonce: token(), verifier: token(48), redirect_uri: cfg.redirect_uri,
                                  ...(o.fresh ? { fresh: true, started_at: o.now ?? Date.now() } : {}) };
  const u = new URL(d.authorization_endpoint);
  const params: Record<string, string> = {
    response_type: "code", client_id: cfg.client_id, redirect_uri: pending.redirect_uri, scope: cfg.scopes.join(" "),
    state: pending.state, nonce: pending.nonce, code_challenge: pkceChallenge(pending.verifier), code_challenge_method: "S256",
    ...(o.fresh ? { prompt: "login", max_age: "0" } : {}),
  };
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return { url: u.toString(), pending };
}

const formEncode = (s: string): string => encodeURIComponent(s).replace(/%20/g, "+").replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface TokenSet { idToken: string; accessToken: string | null; clientAuth: "client_secret_basic" | "client_secret_post" }

function oauthError(r: HttpReply): { error: string; text: string } | null {
  if (!/json/i.test(r.contentType)) return null;
  let j: unknown;
  try { j = JSON.parse(r.text); } catch { return null; }
  if (!j || typeof j !== "object" || typeof (j as { error?: unknown }).error !== "string") return null;
  const error = logText((j as { error: string }).error).slice(0, 60), desc = logText((j as { error_description?: unknown }).error_description).slice(0, 200);
  return { error, text: desc ? `${error}: ${desc}` : error };
}

export async function exchangeCode(cfg: OidcConfig, d: OidcDiscovery, code: string, pending: Pick<PendingLogin, "verifier" | "redirect_uri">, t: OidcTransport = systemHttp): Promise<TokenSet> {
  const basic = !d.token_auth_methods || d.token_auth_methods.includes("client_secret_basic");
  const fields: Record<string, string> = { grant_type: "authorization_code", code, redirect_uri: pending.redirect_uri, code_verifier: pending.verifier };
  if (!basic) Object.assign(fields, { client_id: cfg.client_id, client_secret: cfg.client_secret });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (basic) headers.authorization = `Basic ${Buffer.from(`${formEncode(cfg.client_id)}:${formEncode(cfg.client_secret)}`).toString("base64")}`;
  const r = await call(cfg, t, d.token_endpoint, { method: "POST", headers, body: Object.entries(fields).map(([k, v]) => `${k}=${formEncode(v)}`).join("&") });
  if (r.status !== 200) {
    if (r.status === 401) throw new OidcFailure("oidc_client_rejected", `code exchange: HTTP 401 ${oauthError(r)?.text ?? "no OAuth error"}`);
    const e = oauthError(r);
    if (e?.error === "invalid_client" || e?.error === "unauthorized_client") throw new OidcFailure("oidc_client_rejected", `code exchange: HTTP ${r.status} ${e.text}`);
    if (e && r.status >= 400 && r.status < 500) throw new OidcFailure(e.error === "invalid_grant" ? "oidc_code_invalid" : "oidc_token_invalid", `code exchange: HTTP ${r.status} ${e.text}`);
    throw new OidcFailure("oidc_bad_response", `code exchange: HTTP ${r.status} ${e?.text ?? `response type “${logText(r.contentType).slice(0, 80) || "unspecified"}” is not an OAuth error`}`);
  }
  const j = parseJson(r, "code exchange response");
  if (typeof j.id_token !== "string" || !j.id_token) throw new OidcFailure("oidc_bad_response", "code exchange response is missing id_token (is openid missing from scope?)");
  return { idToken: j.id_token, accessToken: typeof j.access_token === "string" ? j.access_token : null, clientAuth: basic ? "client_secret_basic" : "client_secret_post" };
}

const MAX_AGE_SEC = 600;
const CURVE: Record<string, string> = { ES256: "P-256", ES384: "P-384", ES512: "P-521" };

function keysFor(keys: Jwk[], alg: SigningAlg, kid: string | null): Jwk[] {
  const kty = alg.startsWith("ES") ? "EC" : "RSA";
  return keys.filter((k) => k.kty === kty && (!k.use || k.use === "sig") && (k.key_ops === undefined || (Array.isArray(k.key_ops) && k.key_ops.includes("verify")))
    && (!k.alg || k.alg === alg) && (!kid || k.kid === kid) && (kty !== "EC" || k.crv === CURVE[alg]));
}

const joseReason = (e: unknown): string => {
  const code = (e as { code?: unknown })?.code;
  if (code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED") return "signature does not match the issuer’s key";
  return `signature could not be verified: ${logText((e as Error)?.message ?? e).slice(0, 120)}${typeof code === "string" ? ` (${code})` : ""}`;
};

export async function verifyJws(jws: string, keys: () => Promise<Jwk[]>, refresh: () => Promise<Jwk[]>, allowed: readonly string[] = OIDC_SIGNING_ALGS): Promise<{ header: Record<string, unknown>; payload: Record<string, unknown> }> {
  const bad = (why: string): never => { throw new OidcFailure("oidc_token_invalid", why); };
  if (typeof jws !== "string" || jws.length > MAX_JWS_CHARS) bad(`token exceeds ${MAX_JWS_CHARS} characters`);
  const parts = jws.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p))) bad("not a three-part JWS");
  let header: Record<string, unknown> = {};
  try { header = decodeProtectedHeader(jws) as unknown as Record<string, unknown>; } catch { bad("token header could not be parsed"); }
  const alg = String(header.alg ?? "");
  const algs = OIDC_SIGNING_ALGS.filter((a) => allowed.includes(a)) as readonly string[];
  if (!algs.includes(alg)) bad(`signing algorithm “${logText(alg).slice(0, 20)}” is not accepted (only ${algs.join(", ") || "RS/PS/ES"})`);
  if (header.crit !== undefined) bad("crit header is unsupported");
  if (header.kid !== undefined && typeof header.kid !== "string") bad("kid in the header is not a string");
  const kid = typeof header.kid === "string" ? header.kid : null;
  let candidates = keysFor(await keys(), alg as SigningAlg, kid);
  if (!candidates.length) candidates = keysFor(await refresh(), alg as SigningAlg, kid);
  if (!candidates.length) bad(`no key ${kid ? `kid=${logText(kid).slice(0, 60)}` : "without kid"} for ${alg} in the issuer’s JWKS`);
  if (!kid && candidates.length > 1) bad(`token without kid, and the issuer’s JWKS holds ${alg} keys: ${candidates.length}; a key is not picked at random`);
  let body: Uint8Array | null = null, why = "signature does not match the issuer’s key";
  for (const k of candidates) {
    try {
      const key = await importJWK(k as JWK, alg);
      const bits = (key as unknown as { algorithm?: { modulusLength?: unknown } }).algorithm?.modulusLength;
      if (alg[0] !== "E" && !(typeof bits === "number" && bits >= 2048)) { why = "issuer’s RSA key is shorter than 2048 bits and is untrusted"; continue; }
      body = (await compactVerify(jws, key, { algorithms: [alg] })).payload;
      break;
    } catch (e) { why = joseReason(e); }
  }
  if (!body) return bad(why);
  let payload: unknown = null;
  try { payload = JSON.parse(Buffer.from(body).toString("utf8")); } catch { }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) bad("token payload is not a JSON object");
  return { header, payload: payload as Record<string, unknown> };
}

export async function verifyIdToken(cfg: OidcConfig, d: OidcDiscovery, idToken: string, nonce: string, cache: ProviderCache, nowSec = Math.floor(Date.now() / 1000)): Promise<Record<string, unknown>> {
  const allowed = OIDC_SIGNING_ALGS.filter((a) => !d.signing_algs || d.signing_algs.includes(a));
  const { payload: c } = await verifyJws(idToken, () => cache.jwks(cfg, d), () => cache.jwks(cfg, d, true), allowed);
  const bad = (why: string): never => { throw new OidcFailure("oidc_token_invalid", why); };
  if (c.iss !== cfg.issuer) bad(`token issuer “${logText(c.iss).slice(0, 200)}” ≠ “${cfg.issuer}”`);
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(cfg.client_id)) bad(`token was not issued for ${cfg.client_id} (aud: ${logText(JSON.stringify(c.aud)).slice(0, 200)})`);
  if (c.azp !== undefined && c.azp !== cfg.client_id) bad(`azp «${logText(c.azp).slice(0, 100)}» ≠ ${cfg.client_id}`);
  if (aud.length > 1 && c.azp === undefined) bad("multiple audiences without azp");
  if (typeof c.exp !== "number" || c.exp + OIDC_CLOCK_SKEW_SEC < nowSec) bad("token expired");
  if (typeof c.iat !== "number" || c.iat - OIDC_CLOCK_SKEW_SEC > nowSec) bad("token was issued “in the future”. Check the clocks on the memory server and the identity provider");
  else if (nowSec - c.iat > MAX_AGE_SEC + OIDC_CLOCK_SKEW_SEC) bad("token was issued too long ago");
  if (typeof c.nonce !== "string" || c.nonce !== nonce) bad("nonce does not match the sign-in attempt (replayed or substituted response)");
  if (typeof c.sub !== "string" || !c.sub || c.sub.length > 255) bad("missing sub");
  if (HIDDEN.test(c.sub as string)) bad("sub contains control or format characters");
  return c;
}

export async function fetchUserinfo(cfg: OidcProviderConfig, d: OidcDiscovery, accessToken: string, sub: string, t: OidcTransport = systemHttp): Promise<Record<string, unknown>> {
  if (!d.userinfo_endpoint) return {};
  const r = await call(cfg, t, d.userinfo_endpoint, { headers: { authorization: `Bearer ${accessToken}` } });
  if (r.status !== 200 || !/json/i.test(r.contentType)) return {};
  const j = parseJson(r, "userinfo");
  if (j.sub !== sub) throw new OidcFailure("oidc_token_invalid", "userinfo sub does not match the ID token");
  return j;
}

export interface SsoPerson {
  sub: string; guid: string | null; mail: string | null; mailVerified: boolean; name: string | null; department: string | null;
  employeeId: string | null; username: string | null; groups: string[]; matchedGroups: string[]; invalidClaims: string[];
  givenName?: string | null;
}

const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);
const claimText = (v: unknown, max: number): string | null => {
  const x = first(v);
  const s = typeof x === "string" ? x : typeof x === "number" ? String(x) : null;
  const one = s?.replace(/\p{Cf}/gu, "").replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);
  return one ? one : null;
};
const claimList = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).filter((x): x is string => typeof x === "string").map((x) => x.trim())
    .filter((x) => x && x.length <= 255).slice(0, 500);
export function canonicalObjectGuid(v: unknown): string | null {
  const b = typeof v === "string" ? objectGuidBytes(v) : null;
  return b && b.some((x) => x !== 0) ? formatObjectGuid(b) : null;
}
const MAIL_MAX = 254;
function invalidClaims(n: OidcClaimNames, c: Record<string, unknown>): string[] {
  const out: string[] = [], mail = first(c[n.mail]), user = first(c[n.username]);
  if (typeof mail === "string") {
    const m = mail.trim(), at = m.lastIndexOf("@");
    if (HIDDEN.test(mail) || /\s/.test(m) || m.length > MAIL_MAX || /[^\x00-\x7f]/.test(at > 0 ? m.slice(0, at) : m)) out.push("mail");
  }
  if (typeof user === "string" && HIDDEN.test(user)) out.push("username");
  return out;
}
function employeeIdOf(v: unknown): string | null {
  const x = first(v);
  if (typeof x === "string" && HIDDEN.test(x)) return null;
  const s = typeof x === "string" ? x.trim() : typeof x === "number" && Number.isFinite(x) ? String(x) : null;
  return s && s.length <= 64 ? s : null;
}

export function matchSsoGroups(groups: string[], wanted: string[]): string[] {
  const have = new Set(groups.map((g) => g.trim()));
  return wanted.filter((w) => {
    const x = w.trim();
    return !!x && (have.has(x) || (!x.startsWith("/") && have.has(`/${x}`)));
  });
}

export function ssoGroupNearMisses(groups: string[], wanted: string[]): string[] {
  const exact = new Set(matchSsoGroups(groups, wanted));
  return wanted.filter((w) => !exact.has(w) && matchSsoGroups(groups.map((g) => g.toLowerCase()), [w.toLowerCase()]).length > 0);
}

export function ssoPerson(cfg: OidcConfig, c: Record<string, unknown>): SsoPerson {
  const n = cfg.claims, groups = claimList(c[n.groups]), invalid = invalidClaims(n, c);
  const verified = c[n.mail_verified];
  return {
    sub: String(c.sub), guid: canonicalObjectGuid(c[n.guid]), mail: invalid.includes("mail") ? null : claimText(c[n.mail], MAIL_MAX)?.toLowerCase() ?? null,
    mailVerified: verified === true || verified === "true", name: claimText(c[n.name], 200), department: claimText(c[n.department], 200),
    employeeId: employeeIdOf(c[n.employee_id]), username: claimText(c[n.username], 100), groups, matchedGroups: matchSsoGroups(groups, cfg.login_groups),
    invalidClaims: invalid, givenName: claimText(c[n.given_name], 100),
  };
}

export async function checkProvider(cfg: OidcConfig, t: OidcTransport = systemHttp): Promise<{ ok: boolean; steps: LdapStep[] }> {
  const steps: LdapStep[] = [];
  const step = (s: LdapStep) => { steps.push(s); return s.status !== "fail"; };
  const problems = oidcProblems({ ...cfg, enabled: true });
  step(problems.length ? { step: "config", status: cfg.issuer ? "warn" : "fail", code: "oidc_not_configured", message: `missing or invalid settings: ${problems.map((p) => `${p.key} — ${p.message}`).join("; ")}` }
                       : { step: "config", status: "ok", message: "settings are complete" });
  if (!cfg.issuer) return { ok: false, steps };
  const where = (u: string): URL => asUrl(u) ?? new URL("https://invalid.invalid");
  let d: OidcDiscovery;
  try {
    d = await fetchDiscovery(cfg, t);
    step({ step: "discovery", status: "ok", message: `metadata received: ${oidcDiscoveryUrl(cfg.issuer)}` });
  } catch (e) {
    const f = e instanceof OidcFailure ? e : transportFailure(e, where(cfg.issuer));
    step({ step: "discovery", status: "fail", code: f.code, message: `${f.message}. ${f.detail}` });
    return { ok: false, steps };
  }
  const probs = discoveryProblems(cfg, d);
  if (!step(d.issuer === cfg.issuer ? { step: "issuer", status: "ok", message: `issuer matches: ${d.issuer}` }
                                    : { step: "issuer", status: "fail", code: "oidc_discovery_invalid", message: probs[0]! })) return { ok: false, steps };
  const rest = probs.filter((p) => !p.startsWith("issuer ") && !p.startsWith("metadata issuer "));
  if (!step(rest.length ? { step: "endpoints", status: "fail", code: "oidc_discovery_invalid", message: rest.join("; ") }
                        : { step: "endpoints", status: "ok", message: `sign-in page, code exchange and keys use HTTPS on the issuer host; PKCE S256${d.code_challenge_methods ? "" : " (not advertised; the identity provider must support it)"}; client secret — ${!d.token_auth_methods || d.token_auth_methods.includes("client_secret_basic") ? "client_secret_basic" : "client_secret_post"}`,
                            detail: { authorization_endpoint: d.authorization_endpoint, token_endpoint: d.token_endpoint, jwks_uri: d.jwks_uri, userinfo_endpoint: d.userinfo_endpoint } })) return { ok: false, steps };
  try {
    const keys = await fetchJwks(cfg, d, t);
    const usable = keys.filter((k) => (k.kty === "RSA" || k.kty === "EC") && (!k.use || k.use === "sig") && (k.key_ops === undefined || (Array.isArray(k.key_ops) && k.key_ops.includes("verify"))));
    step(usable.length ? { step: "jwks", status: "ok", message: `signing keys: ${usable.length} (${[...new Set(usable.map((k) => k.alg ?? k.kty))].join(", ")})` }
                       : { step: "jwks", status: "fail", code: "oidc_discovery_invalid", message: "JWKS contains no RSA or EC signing keys" });
  } catch (e) {
    const f = e instanceof OidcFailure ? e : transportFailure(e, where(d.jwks_uri));
    step({ step: "jwks", status: "fail", code: f.code, message: `${f.message}. ${f.detail}` });
  }
  const ru = asUrl(cfg.redirect_uri);
  step(!ru ? { step: "redirect_uri", status: "fail", code: "oidc_not_configured", message: `redirect URI is missing (…${OIDC_CALLBACK_PATH}). It must also be set in the client at the identity provider` }
           : ru.protocol === "http:" ? { step: "redirect_uri", status: "warn", message: `the return URL uses HTTP, accepted as an exception: ${cfg.redirect_uri}. It must be among the client’s redirect URIs at the identity provider (in Keycloak: Valid redirect URIs)` }
           : { step: "redirect_uri", status: "ok", message: `redirect URI: ${cfg.redirect_uri}. Use the same URI in the client’s Valid redirect URIs` });
  step({ step: "client", status: cfg.client_secret ? "ok" : "fail", ...(cfg.client_secret ? {} : { code: "oidc_not_configured" }),
         message: cfg.client_secret ? `client ${cfg.client_id || "?"}: secret is set (verified on first sign-in because the provider check does not issue tokens)` : "client secret is missing" });
  const bare = cfg.login_groups.filter((g) => !g.startsWith("/"));
  if (cfg.login_groups.length)
    step(bare.length ? { step: "groups", status: "warn", message: `access groups without a path (${bare.slice(0, 5).join(", ")}) also match a nested group with the same name. Ask IAM to configure the client’s Group Membership mapper with the full path (full.path), then specify /${bare[0]}` }
                     : { step: "groups", status: "ok", message: `access groups use full paths: ${cfg.login_groups.slice(0, 5).join(", ")}` });
  return { ok: steps.every((s) => s.status !== "fail"), steps };
}
