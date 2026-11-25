// Model endpoint addresses: one canonical form of a base URL, and where the host is — on this machine, in a private
// network or on the internet. The data policy compares stored pairs by the canonical form, and the model
// transport refuses service addresses (link-local, cloud metadata, unspecified, multicast, broadcast, reserved) before
// any request.
//
// Classification is NOT done here: every IP address goes through `oidcAddressKind` (oidc.ts), the single IP parser of
// the product, so the model transport, the OIDC client and the egress client of the connectors agree on every address,
// including IPv4-mapped IPv6 and NAT64 forms. The URL parser (WHATWG `URL`) already rewrites decimal, octal, hex and
// percent-encoded IPv4 hosts to dotted form and IPv6 hosts to their compressed lower-case form.
//
// Locality is a hint, never a permission: trust is bound to an explicit "base URL + model" pair confirmed by the
// administrator. A private address is often a proxy to a cloud service.
//
// One exception to the kinds of `oidcAddressKind` (lead): the IPv4 address 0.0.0.0 is read as "this
// host" — the class of 127.0.0.1 — so an install that stored `http://0.0.0.0:<port>` keeps working. It gives no trust (the
// pair stays explicit), and `baseUrlHints` advises 127.0.0.1 or the service name. Every other unspecified address (`::`,
// the rest of 0.0.0.0/8, 0.0.0.0 inside IPv6) stays refused.
import { lookup as dnsLookup } from "node:dns/promises";
import { oidcAddressKind, type OidcAddressKind } from "../oidc.ts";

/** Kinds a model endpoint may live at. */
export type AddressLocality = "loopback" | "private" | "public";
/** Kinds that are refused always, for IP literals and for any address a host name resolves to. */
export type RefusedAddressKind = Exclude<OidcAddressKind, AddressLocality>;

/** Why a base URL is not accepted. Stable codes: settings validation and the "test connection" route show them. */
export type BaseUrlProblem = "not_a_url" | "scheme" | "userinfo" | "query" | "fragment" | "path" | "host" | "port" | "refused_address";

const PROBLEM_TEXT: Record<BaseUrlProblem, string> = {
  not_a_url: "not a valid URL (at most 2048 characters; spaces and control characters are not allowed)",
  scheme: "only http:// and https:// addresses are allowed",
  userinfo: "a user name or password in the address is not allowed; put the key into the API key field",
  query: "a query string (?…) is not allowed in a base address",
  fragment: "a fragment (#…) is not allowed in a base address",
  path: "the path must not contain '.' or '..' segments, backslashes or encoded slashes",
  host: "the address has no host",
  port: "the port must be between 1 and 65535",
  refused_address: "this address is never allowed for a model (link-local, cloud metadata, unspecified, multicast, broadcast or reserved)",
};

/** 0.0.0.0 and :: are what model servers print as their listening address ("all interfaces"), not a destination. */
const UNSPECIFIED_HINT = "0.0.0.0 and :: are listening addresses, not destinations: use 127.0.0.1 or the service name";
/** The IPv4 address read as "this host" (see the header). */
const THIS_HOST = "0.0.0.0";
/** What `baseUrlHints` says for a base URL on 0.0.0.0. */
export const THIS_HOST_HINT = "0.0.0.0 is a listening address (all interfaces), not a destination: it is used as 127.0.0.1 here; write 127.0.0.1 or the service name";

/** HTTP whitespace `fetch` strips from both ends of a header value before it checks and sends it. */
const HEADER_EDGE = /^[\t\n\r ]+|[\t\n\r ]+$/g;
/**
 * A character `fetch` refuses in a header value once the ends are stripped: NUL, CR and LF (its error text would carry the
 * value, so the key), the other control characters except tab, DEL, and code points above U+00FF.
 */
const BAD_HEADER_CHAR = /[^\t\x20-\x7e\x80-\xff]/;

/** The `authorization` value of a key, exactly as the legacy client built it (`fetch` strips its ends itself). */
export const bearer = (key: string): string => `Bearer ${key}`;

/**
 * Whether `fetch` sends `key` in the `authorization` header — the rule `fetch` itself applies, so a key the legacy client
 * sent (a line break or a tab at its end, a tab inside) is still sent, and only a key `fetch` would refuse is not.
 */
export function apiKeySendable(key: string): boolean {
  return !BAD_HEADER_CHAR.test(bearer(key).replace(HEADER_EDGE, ""));
}

/** Kind of an IP address for a model endpoint: `oidcAddressKind`, except that 0.0.0.0 is `loopback` (see the header). */
export function modelAddressKind(ip: string): OidcAddressKind {
  return ip === THIS_HOST ? "loopback" : oidcAddressKind(ip);
}

/** A refused base URL; `code` is the stable reason. */
export class ModelAddressError extends Error {
  readonly code: BaseUrlProblem;
  constructor(code: BaseUrlProblem, detail?: string) {
    const hint = code === "refused_address" && detail?.endsWith(": unspecified") ? `; ${UNSPECIFIED_HINT}` : "";
    super(`model address: ${PROBLEM_TEXT[code]}${detail ? ` (${detail})` : ""}${hint}`);
    this.name = "ModelAddressError";
    this.code = code;
  }
}

/** A base URL in canonical form, split into the parts the connection, the transport and the policy use. */
export interface ParsedBaseUrl {
  /** Canonical base URL: lower-case scheme and host, no default port, no userinfo, no trailing slash. */
  baseUrl: string;
  /** `scheme://host[:port]` — what a key is bound to (rule R3) and what every request must stay on. */
  origin: string;
  scheme: "http" | "https";
  /** Host as in the URL: a name without a trailing dot, an IPv4 address, or an IPv6 address in brackets. */
  host: string;
  /** `host[:port]` — for logs and usage rows (no path, no key). */
  hostPort: string;
  /** Explicit non-default port, or null. */
  port: number | null;
  /** Path below the origin, without a trailing slash; "" for the root. */
  pathPrefix: string;
  /** The IP address when the host is an IP literal (IPv6 without brackets), else null. */
  ip: string | null;
  /** `modelAddressKind(ip)` for an IP literal; null for a host name (needs DNS, see `hostLocality`). */
  ipKind: OidcAddressKind | null;
}

const MAX_URL = 2048;
const SCHEME_RE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;

/** Kind → refused kind, or null when a model may live there. */
export function refusedKind(kind: OidcAddressKind): RefusedAddressKind | null {
  return kind === "public" || kind === "private" || kind === "loopback" ? null : kind;
}

/** Kind → locality, or null for a refused kind. */
export function addressLocality(kind: OidcAddressKind): AddressLocality | null {
  return refusedKind(kind) === null ? (kind as AddressLocality) : null;
}

/** An IP literal of a host (brackets of IPv6 removed), or null when the host is a name. */
function ipOf(host: string): string | null {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return oidcAddressKind(bare) === "invalid" ? null : bare;
}

/**
 * Parse and canonicalise a model base URL. Refuses: other schemes, userinfo (even an empty `@`), a query, a fragment,
 * dot segments (also percent-encoded), backslashes and encoded slashes in the path, a missing host, port 0, spaces and
 * control characters (the URL parser would silently drop tabs and newlines). IP literals of a refused kind are refused
 * too (`refused_address`); host names are not resolved here.
 */
export function parseBaseUrl(raw: string): ParsedBaseUrl | { problem: BaseUrlProblem; detail?: string } {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text || text.length > MAX_URL || /[\x00-\x20\x7f]/.test(text)) return { problem: "not_a_url" };
  const scheme = SCHEME_RE.exec(text);
  if (!scheme) return { problem: /^[A-Za-z][A-Za-z0-9+.-]*:/.test(text) && !/^https?:/i.test(text) ? "scheme" : "not_a_url" };
  if (!/^https?$/i.test(scheme[1]!)) return { problem: "scheme" };
  const rest = text.slice(scheme[0].length);
  const authority = rest.split(/[/?#\\]/, 1)[0]!;
  if (authority.includes("@")) return { problem: "userinfo" };
  if (!authority || authority.startsWith(":")) return { problem: "host" };
  const port = /:(\d+)$/.exec(authority);
  if (port && (Number(port[1]) < 1 || Number(port[1]) > 65535)) return { problem: "port" };
  const afterAuthority = rest.slice(authority.length);
  if (afterAuthority.includes("#")) return { problem: "fragment" };
  if (afterAuthority.includes("?")) return { problem: "query" };
  if (afterAuthority.includes("\\")) return { problem: "path" };
  for (const segment of afterAuthority.split("/")) {
    const s = segment.toLowerCase();
    if (/%2f|%5c/.test(s)) return { problem: "path" };
    const decoded = s.replace(/%2e/g, ".");
    if (decoded === "." || decoded === "..") return { problem: "path" };
  }
  let url: URL;
  try { url = new URL(text); } catch { return { problem: "not_a_url" }; }
  if (url.username || url.password) return { problem: "userinfo" };
  if (url.search || url.hash) return { problem: url.hash ? "fragment" : "query" };
  if (!url.hostname) return { problem: "host" };

  const ip = ipOf(url.hostname);
  const host = ip === null && url.hostname.endsWith(".") ? url.hostname.slice(0, -1) : url.hostname;
  if (!host || host.endsWith(".")) return { problem: "host" };
  const ipKind = ip === null ? null : modelAddressKind(ip);
  if (ipKind !== null && refusedKind(ipKind) !== null) return { problem: "refused_address", detail: `${ip}: ${ipKind}` };

  const schemeName = url.protocol === "https:" ? "https" : "http";
  const portNumber = url.port ? Number(url.port) : null;
  const hostPort = portNumber === null ? host : `${host}:${portNumber}`;
  const origin = `${schemeName}://${hostPort}`;
  const pathPrefix = url.pathname.replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase()).replace(/\/+$/, "");
  return { baseUrl: origin + pathPrefix, origin, scheme: schemeName, host, hostPort, port: portNumber, pathPrefix, ip, ipKind };
}

/**
 * Advice for a base URL that is accepted but better written otherwise (today: a host of 0.0.0.0). For the readiness view
 * and the "test connection" route; [] when there is nothing to say or the address does not parse.
 */
export function baseUrlHints(raw: string): string[] {
  const p = parseBaseUrl(raw);
  return !("problem" in p) && p.ip === THIS_HOST ? [THIS_HOST_HINT] : [];
}

/** Problem of a base URL, or null when it parses (settings validation, the "test connection" route). */
export function baseUrlProblem(raw: string): BaseUrlProblem | null {
  const p = parseBaseUrl(raw);
  return "problem" in p ? p.problem : null;
}

/** Parse or throw `ModelAddressError`. */
export function parseBaseUrlOrThrow(raw: string): ParsedBaseUrl {
  const p = parseBaseUrl(raw);
  if ("problem" in p) throw new ModelAddressError(p.problem, p.detail);
  return p;
}

/**
 * Canonical base URL; throws `ModelAddressError`. Spellings that differ only in the case of the scheme and host, a
 * default or zero-padded port, trailing slashes, a trailing dot of the name, the notation of an IP literal or the case
 * of percent-escapes give the same string. Other percent-escapes are kept as written (`/a%2Db` and `/a-b` differ): a
 * comparison of two forms can then only fail on the safe side (a mismatch is a refusal, never a match).
 */
export function normalizeBaseUrl(raw: string): string {
  return parseBaseUrlOrThrow(raw).baseUrl;
}

/** Both addresses parse and have the same origin (scheme, host, port). */
export function sameOrigin(a: string, b: string): boolean {
  const pa = parseBaseUrl(a), pb = parseBaseUrl(b);
  return !("problem" in pa) && !("problem" in pb) && pa.origin === pb.origin;
}

/**
 * Resolves a host name to all of its addresses (like `dns.lookup` with `all: true`). Injected in tests. The one-address
 * answer of `dns.lookup` without `all` is accepted too and classified the same way; an answer of any other shape is the
 * refused kind `invalid`, so a mis-wired resolver refuses instead of reporting every name as unresolved.
 */
export type ModelLookup = (hostname: string) => Promise<ReadonlyArray<{ address: string; family?: number }> | { address: string; family?: number }>;
const systemLookup: ModelLookup = (hostname) => dnsLookup(hostname, { all: true });

/** One classified address of a host. */
export interface ClassifiedAddress { address: string; kind: OidcAddressKind }

/**
 * Where a host is:
 * - `ok` — every address may be called; `locality` is `loopback` when all addresses are loopback, `private` when all are
 *   private or loopback, otherwise `public` (one public address makes the whole name public);
 * - `refused` — at least one address is of a refused kind (the whole name is refused: a "good" address is never picked
 *   out of a mixed answer); `kind` and `address` name the first such address;
 * - `unresolved` — the name does not resolve (or the resolver failed): not a refusal; the caller fails the request the
 *   way a failed connection fails it.
 */
export type HostLocality =
  | { status: "ok"; locality: AddressLocality; addresses: ClassifiedAddress[] }
  | { status: "refused"; kind: RefusedAddressKind; address: string; addresses: ClassifiedAddress[] }
  | { status: "unresolved"; code: string };

/** An IP literal in the form the URL parser writes it (IPv6 compressed, lower-case, mapped IPv4 in hex). */
function canonicalIp(ip: string): string {
  try { return new URL(`http://${ip.includes(":") ? `[${ip}]` : ip}/`).hostname.replace(/^\[|\]$/g, ""); } catch { return ip; }
}

/** A bare host through the WHATWG host parser; null when it is not a host alone (port, path, userinfo,
 * percent-escapes, bad characters). Bare and bracketed IPv6 literals never get here: `ipOf` takes them first. */
function canonicalHost(host: unknown): string | null {
  if (typeof host !== "string" || !host || host.length > 255 || /[\x00-\x20\x7f/\\?#@:%]/.test(host)) return null;
  try {
    const u = new URL(`http://${host}/`);
    return u.port || u.username || u.password || u.pathname !== "/" ? null : u.hostname;
  } catch {
    return null;
  }
}

function localityOf(addresses: ClassifiedAddress[]): HostLocality {
  for (const a of addresses) {
    const refused = refusedKind(a.kind);
    if (refused) return { status: "refused", kind: refused, address: a.address, addresses };
  }
  const kinds = new Set(addresses.map((a) => a.kind));
  const locality: AddressLocality = kinds.has("public") ? "public" : kinds.has("private") ? "private" : "loopback";
  return { status: "ok", locality, addresses };
}

/**
 * Locality of a host (a name, an IPv4 address or a bracketed or bare IPv6 address — `ParsedBaseUrl.host` fits). IP
 * literals are classified without DNS; names are resolved once with `lookup` (default: the system resolver) and every
 * returned address is classified by `oidcAddressKind`. An answer that is not an IP address is the refused kind `invalid`.
 */
export async function hostLocality(host: string, opts: { lookup?: ModelLookup } = {}): Promise<HostLocality> {
  const literal = typeof host === "string" ? ipOf(host) : null;
  if (literal !== null) {
    const ip = canonicalIp(literal);
    return localityOf([{ address: ip, kind: modelAddressKind(ip) }]);
  }
  // Anything else goes through the URL host parser first: "2130706433" or "0x7f.1" must not reach the resolver as a
  // "name" (getaddrinfo would read them as 127.0.0.1), and names are compared lower-case.
  const canonical = canonicalHost(host);
  if (canonical === null) return { status: "unresolved", code: "EINVAL" };
  const ip = ipOf(canonical);
  if (ip !== null) return localityOf([{ address: ip, kind: modelAddressKind(ip) }]);
  const name = canonical.endsWith(".") ? canonical.slice(0, -1) : canonical;
  if (!name) return { status: "unresolved", code: "EINVAL" };
  let answer: unknown;
  try {
    answer = await (opts.lookup ?? systemLookup)(name);
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    return { status: "unresolved", code: typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : "ENOTFOUND" };
  }
  if (answer === undefined || answer === null || (Array.isArray(answer) && answer.length === 0)) return { status: "unresolved", code: "ENODATA" };
  // One address (`dns.lookup` without `all`, or a bare string) is a one-element answer; any other shape is `invalid`.
  const items: unknown[] = Array.isArray(answer) ? answer : typeof answer === "string" || typeof answer === "object" ? [answer] : [undefined];
  return localityOf(items.map((a) => {
    const raw = typeof a === "string" ? a : typeof a === "object" && a !== null ? (a as { address?: unknown }).address : undefined;
    const address = typeof raw === "string" ? raw : "";
    return { address, kind: modelAddressKind(address) };
  }));
}

/** Locality of a base URL: parse problems first, then `hostLocality` of its host. */
export async function baseUrlLocality(raw: string, opts: { lookup?: ModelLookup } = {}): Promise<HostLocality | { status: "invalid"; problem: BaseUrlProblem }> {
  const p = parseBaseUrl(raw);
  if ("problem" in p) return { status: "invalid", problem: p.problem };
  return hostLocality(p.host, opts);
}
