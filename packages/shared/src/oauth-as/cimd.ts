// Client ID Metadata Documents ("client passport"): the pure part. A client_id that starts with
// https:// is the address of a JSON document that describes the client. Here: admission of the address before any network
// access, acceptance of the HTTP reply, validation of the document with skipping of unusable return addresses,
// the pinned table of known apps with their return addresses, the client kind, the cache lifetime and the
// mapping of transport errors to reason codes. The download itself (network policy, single flight, limits, caches) lives in
// the gateway (packages/gateway/src/agent-auth/cimd-fetch.ts); nothing here does I/O.
//
// Security notes:
// - admission is strict and runs before the network and on every cache hit: the address must be canonical (WHATWG href
//   equals the string, path only [A-Za-z0-9._~/-], no "." or ".." segments, no "//", no %), the host must equal the host of
//   an agent_auth.cimd_hosts entry exactly and the path must start with its prefix; IP literals, IDN and a trailing dot are
//   refused even with agent_auth.cimd_any_https;
// - "known app" needs both the exact document address (or a pinned pattern) and a pinned return address of this
//   transaction; otherwise the consent page names the host of client_id, never the self-chosen client_name;
// - a return address on another origin than client_id, a custom scheme, plain http to a non-loopback host, an address that
//   is not in canonical form (the browser would visit another path: dot segments, %XX, "//") and the unverified forwarder
//   https://vscode.dev/redirect in any spelling are skipped, not trusted.
import type { ConnectionClientKind } from "../client-kind.ts";
import { matchRedirect, parseRedirect, REDIRECT_MAX, type AnchorsRedirect, type ParsedRedirect, type RedirectMode, type RedirectRow } from "./redirect.ts";

// ---------------------------------------------------------------- constants

/** client_id length limit: oauth_connections.client_id (05-access-model.sql). */
export const CIMD_ID_MAX = 255;
/** Body limit of a document download (OidcRequestOptions.maxBytes). */
export const CIMD_MAX_BYTES = 5120;
export const CIMD_TIMEOUT_MS = 5000;
export const CIMD_USER_AGENT = "PrismaMemory-AgentAuth/1";
export const CIMD_REQUEST_HEADERS: Readonly<Record<string, string>> = { accept: "application/json", "user-agent": CIMD_USER_AGENT };
/** Concurrent downloads per process; above it the page is temporarily_unavailable without waiting. */
export const CIMD_MAX_INFLIGHT = 4;
/**
 * Of CIMD_MAX_INFLIGHT, the slots only reserved documents use: the exact documents of KNOWN_CIMD and
 * documents that validated before under an agent_auth.cimd_hosts entry. Any other document (a made-up path under a listed
 * prefix, any https:// address with cimd_any_https — its address is the anonymous caller's choice) starts only while fewer
 * than CIMD_MAX_INFLIGHT − CIMD_RESERVED_INFLIGHT such downloads run: slow unknown documents never hold the last slot of
 * claude.ai, ChatGPT, Claude Code or Codex. The ceiling CIMD_MAX_INFLIGHT holds for all.
 */
export const CIMD_RESERVED_INFLIGHT = 1;
/**
 * Downloads per host per minute; above it cimd_rate_limited without network. Not counted: the exact
 * documents of KNOWN_CIMD and documents that validated before under an agent_auth.cimd_hosts entry — single flight and the
 * ≥ 5-minute cache bound them, and made-up paths must not use up their minute.
 */
export const CIMD_HOST_PER_MIN = 30;
/** New documents one client address (addressKey) may make the gateway download per minute; the same exemption. */
export const CIMD_ADDRESS_PER_MIN = 5;
/** Negative cache of a host after 403, 429, 5xx, TLS, DNS, timeout (code cimd_host_cooling). */
export const CIMD_HOST_COOLING_MS = 5 * 60_000;
/** Negative cache of one client_id after 404 or an invalid document. */
export const CIMD_CLIENT_NEGATIVE_MS = 60_000;
/** LRU size of the positive cache. */
export const CIMD_CACHE_MAX = 256;
export const CIMD_TTL_MIN_MS = 5 * 60_000;
export const CIMD_TTL_MAX_MS = 3 * 24 * 3600_000;
export const CIMD_TTL_DEFAULT_MS = 3600_000;
export const CIMD_REDIRECTS_MAX = 10;
/** client_name limit in characters (code points, as char_length in the database). */
export const CLIENT_NAME_MAX = 100;
/** agent_auth.cimd_hosts: at most 20 entries, prefix at most 100 characters. */
export const CIMD_HOSTS_MAX = 20;
export const CIMD_PREFIX_MAX = 100;
/** Labels and titles of connections (api_keys.client_label). */
export const CLIENT_LABEL_MAX = 80;
/**
 * Pages that forward the code wherever the state parameter says: not accepted from anyone. The Insiders host serves
 * the same page (VS Code registers it with DCR), so it is listed too.
 */
export const UNVERIFIED_FORWARDERS: readonly string[] = ["https://vscode.dev/redirect", "https://insiders.vscode.dev/redirect"];

/** Reason codes of a refused document; texts — CIMD_REASON_TEXT in errors.ts. */
export type CimdReason =
  | "cimd_bad_url" | "cimd_host_not_allowed" | "cimd_fetch_failed" | "cimd_too_large" | "cimd_invalid" | "cimd_host_cooling"
  | "cimd_rate_limited" | "tls" | "dns" | "timeout" | "network" | "address_blocked";

/** client_id is a document address (sourceOf: starts with https://). */
export const isCimdClientId = (clientId: unknown): clientId is string => typeof clientId === "string" && clientId.startsWith("https://");

// ---------------------------------------------------------------- agent_auth.cimd_hosts entries "host/prefix/"

export interface CimdHostEntry { readonly host: string; readonly prefix: string }
export interface CimdPolicy { readonly hosts: readonly CimdHostEntry[]; readonly anyHttps: boolean }

const LABEL = "[a-z0-9]([a-z0-9-]*[a-z0-9])?";
const HOST_RE = new RegExp(`^${LABEL}(\\.${LABEL})+$`);
const PATH_CHARS = /^[A-Za-z0-9._~/-]+$/;

/** Why a lower-case DNS host is not acceptable for a document; null: acceptable. */
function hostProblem(host: string): string | null {
  if (host.length > 253) return "host is longer than 253 characters";
  if (host.endsWith(".")) return "host ends with a dot";
  if (host.startsWith("[") || host.includes(":")) return "host is an IP literal";
  if (/(^|\.)[0-9]+$/.test(host) || /(^|\.)0x[0-9a-f]*$/i.test(host)) return "host is an IP literal";
  if (!HOST_RE.test(host)) return "host must be a lower-case DNS name with at least two labels";
  const labels = host.split(".");
  if (labels.some((l) => l.length > 63)) return "a host label is longer than 63 characters";
  if (labels.some((l) => l.startsWith("xn--"))) return "internationalized (xn--) host names are not accepted";
  return null;
}

/** Why a path or a prefix has a non-canonical shape; null: canonical. */
function pathProblem(path: string): string | null {
  if (!PATH_CHARS.test(path)) return "path may contain only A-Z a-z 0-9 . _ ~ / -";
  if (path.includes("//")) return "path contains //";
  if (path.split("/").some((s) => s === "." || s === "..")) return "path contains a . or .. segment";
  return null;
}

/** One entry of agent_auth.cimd_hosts, for example "claude.ai/oauth/". */
export function parseCimdHostEntry(raw: unknown): { ok: true; entry: CimdHostEntry } | { ok: false; problem: string } {
  if (typeof raw !== "string") return { ok: false, problem: "an entry must be a string host/prefix/, for example claude.ai/oauth/" };
  const slash = raw.indexOf("/");
  if (slash <= 0) return { ok: false, problem: "an entry is host/prefix/, for example claude.ai/oauth/" };
  const host = raw.slice(0, slash), prefix = raw.slice(slash);
  const hp = hostProblem(host);
  if (hp) return { ok: false, problem: hp };
  if (!prefix.endsWith("/")) return { ok: false, problem: "the prefix must end with /" };
  if (prefix.length > CIMD_PREFIX_MAX) return { ok: false, problem: `the prefix is longer than ${CIMD_PREFIX_MAX} characters` };
  if (prefix.includes("..")) return { ok: false, problem: "the prefix contains .." };
  const pp = pathProblem(prefix);
  if (pp) return { ok: false, problem: pp.replace("path", "the prefix") };
  return { ok: true, entry: { host, prefix } };
}

/** The whole value of agent_auth.cimd_hosts (for settings validation): an array of at most 20 entries. */
export function parseCimdHosts(v: unknown): { ok: true; entries: CimdHostEntry[] } | { ok: false; index: number | null; problem: string } {
  if (!Array.isArray(v)) return { ok: false, index: null, problem: "must be an array of entries host/prefix/" };
  if (v.length > CIMD_HOSTS_MAX) return { ok: false, index: null, problem: `at most ${CIMD_HOSTS_MAX} entries` };
  const entries: CimdHostEntry[] = [];
  for (let i = 0; i < v.length; i++) {
    const r = parseCimdHostEntry(v[i]);
    if (!r.ok) return { ok: false, index: i, problem: r.problem };
    entries.push(r.entry);
  }
  return { ok: true, entries };
}

/**
 * Policy from the current settings values. Entries that do not parse are ignored here (saving already refuses them):
 * a broken entry must not open anything. Only boolean true turns cimd_any_https on.
 */
export function cimdPolicyFrom(hosts: unknown, anyHttps: unknown): CimdPolicy {
  const list = Array.isArray(hosts) ? hosts : [];
  const entries: CimdHostEntry[] = [];
  for (const raw of list.slice(0, CIMD_HOSTS_MAX)) {
    const r = parseCimdHostEntry(raw);
    if (r.ok) entries.push(r.entry);
  }
  return { hosts: entries, anyHttps: anyHttps === true };
}

/** CIMD is on (client_id_metadata_document_supported). */
export const cimdEnabled = (p: CimdPolicy): boolean => p.hosts.length > 0 || p.anyHttps;

// ---------------------------------------------------------------- admission before the network

export type CimdAdmission =
  | { ok: true; clientId: string; host: string; origin: string; path: string; entry: CimdHostEntry | null }
  | { ok: false; reason: "cimd_bad_url" | "cimd_host_not_allowed"; host: string | null; detail: string };

const badUrl = (host: string | null, detail: string): CimdAdmission => ({ ok: false, reason: "cimd_bad_url", host, detail });

/**
 * May this document address be downloaded (and, on a cache hit, used)? Strict order: shape, canonical form, host and prefix.
 * Called before every download and on every cache hit, so a removed entry closes cached documents too.
 */
export function admitCimdClientId(clientId: unknown, policy: CimdPolicy): CimdAdmission {
  if (typeof clientId !== "string" || !clientId.startsWith("https://")) return badUrl(null, "client_id is not an https:// address");
  if (clientId.length > CIMD_ID_MAX) return badUrl(null, `client_id is longer than ${CIMD_ID_MAX} characters`);
  let u: URL;
  try {
    u = new URL(clientId);
  } catch {
    return badUrl(null, "client_id is not a URL");
  }
  const host = u.hostname;
  // 1. shape: https, no userinfo, no query or fragment (even empty), path not empty and not "/", default port
  if (u.protocol !== "https:") return badUrl(host, "scheme must be https");
  if (u.username || u.password) return badUrl(host, "userinfo is not allowed");
  if (clientId.includes("?") || clientId.includes("#")) return badUrl(host, "query and fragment are not allowed");
  if (u.port !== "") return badUrl(host, "only the default port 443 is allowed");
  if (u.pathname === "" || u.pathname === "/") return badUrl(host, "the address must have a path");
  // 2. canonical form: what is downloaded is exactly what is compared (WHATWG folds %2e%2e, .., case of the host)
  if (u.href !== clientId) return badUrl(host, "the address is not in canonical form");
  const pp = pathProblem(u.pathname);
  if (pp) return badUrl(host, pp);
  // 3. host: never an IP literal, IDN or a trailing dot; then an exact entry with its prefix, or cimd_any_https
  const hp = hostProblem(host);
  if (hp) return badUrl(host, hp);
  const entry = policy.hosts.find((e) => e.host === host && u.pathname.startsWith(e.prefix)) ?? null;
  if (!entry && !policy.anyHttps) {
    return { ok: false, reason: "cimd_host_not_allowed", host, detail: "no agent_auth.cimd_hosts entry covers this host and path" };
  }
  return { ok: true, clientId, host, origin: u.origin, path: u.pathname, entry };
}

// ---------------------------------------------------------------- the HTTP reply

export interface CimdReply { status: number; contentType: string; text: string }
export type CimdReplyCheck =
  | { ok: true; json: Record<string, unknown>; bytes: number }
  | { ok: false; reason: "cimd_fetch_failed" | "cimd_too_large" | "cimd_invalid"; status: number; rule?: 0; bytes: number; contentType: string };

const JSON_TYPE = /^application\/json[ \t]*(;.*)?$/i;

/** Content-Type is application/json, parameters allowed, any case. */
export const isJsonContentType = (contentType: unknown): boolean => typeof contentType === "string" && JSON_TYPE.test(contentType.trim());

/** A reply is usable only with status 200, Content-Type application/json (parameters allowed) and a JSON object body. */
export function checkCimdReply(r: CimdReply): CimdReplyCheck {
  const bytes = Buffer.byteLength(typeof r.text === "string" ? r.text : "", "utf8");
  const contentType = String(r.contentType ?? "").slice(0, 100);
  if (r.status !== 200) return { ok: false, reason: "cimd_fetch_failed", status: r.status, bytes, contentType };
  if (bytes > CIMD_MAX_BYTES) return { ok: false, reason: "cimd_too_large", status: r.status, bytes, contentType };
  if (!isJsonContentType(contentType)) return { ok: false, reason: "cimd_invalid", rule: 0, status: r.status, bytes, contentType };
  let v: unknown;
  try {
    v = JSON.parse(r.text);
  } catch {
    return { ok: false, reason: "cimd_invalid", rule: 0, status: r.status, bytes, contentType };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, reason: "cimd_invalid", rule: 0, status: r.status, bytes, contentType };
  return { ok: true, json: v as Record<string, unknown>, bytes };
}

// ---------------------------------------------------------------- return addresses of a document or a registration

export type RedirectSkipReason = "unparsed" | "scheme" | "plain_http" | "non_canonical" | "other_origin" | "unverified_forwarder";
export interface UsableRedirect { readonly uri: string; readonly row: AnchorsRedirect; readonly loopback: boolean }

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** A row is loopback: http to localhost / 127.0.0.1 / [::1]. */
export const isLoopbackRow = (r: RedirectRow): boolean =>
  "scheme" in r && r.scheme === "http" && LOOPBACK_HOSTS.includes(r.host);

/** A return address is an app on this computer: http to localhost / 127.0.0.1 / [::1] (RFC 8252 §7.3). */
export const isLoopbackRedirectUri = (uri: unknown): boolean => {
  const p = parseRedirect(uri);
  return !!p && p.scheme === "http" && LOOPBACK_HOSTS.includes(p.host);
};

/**
 * The page a browser (and a lenient web server) would serve for an http(s) address, as a comparison key for the forwarder
 * denylist: WHATWG parsing (dot segments, default port, host case), then repeatedly every %XX decoded, "\" read as "/",
 * ";params" of a segment dropped, dot segments resolved again, runs of "/" collapsed, trailing "/" and "." dropped, the path in
 * lower case; the host without a trailing dot. Deliberately looser than any server: a denylist must catch every spelling
 * of the page, never the other way round. null — not an http(s) URL.
 */
function servedPage(uri: unknown): { host: string; path: string } | null {
  if (typeof uri !== "string" || uri.length > REDIRECT_MAX) return null;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return null;
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.port !== "") return null;
  let path = u.pathname;
  for (let i = 0; i < 4; i++) {
    const decoded = path.replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    const segments = decoded.replace(/\\/g, "/").split(/[?#]/)[0]!.split("/").map((s) => s.split(";")[0]!);
    let next: string;
    try {
      next = new URL(segments.join("/").replace(/^\/*/, "/"), "https://page.invalid").pathname;
    } catch {
      return null;
    }
    next = next.replace(/\/{2,}/g, "/").replace(/[/.]+$/, "").toLowerCase();
    if (next === path) break;
    path = next;
  }
  return { host: u.hostname.replace(/\.+$/, ""), path };
}
const FORWARDER_PAGES = UNVERIFIED_FORWARDERS.map((f) => servedPage(f)!);

/**
 * The address reaches an unverified forwarder page: any http(s) spelling of it (:443, case, a trailing slash or dot,
 * %XX, dot segments, "//", ";params", a host with a trailing dot) and the files and sub-paths under it (…/redirect.html,
 * …/redirect/index.html), because a static host may serve the page there too.
 */
export function isUnverifiedForwarder(uri: unknown): boolean {
  const p = servedPage(uri);
  return p !== null && FORWARDER_PAGES.some((f) => p.host === f.host && (p.path === f.path || p.path.startsWith(`${f.path}/`) || p.path.startsWith(`${f.path}.`)));
}

/**
 * Why a parsed http(s) return address is not in canonical form; null — canonical. What is registered and compared must be
 * exactly what the browser visits: the WHATWG path equals the written one (no dot segments, no characters the browser
 * re-encodes), the path has only A-Z a-z 0-9 . _ ~ / - (no %, no ";params"), no "//", and the host has no trailing dot.
 * The same path rule as the admission of client_id.
 */
function redirectCanonicalProblem(uri: string, p: ParsedRedirect): string | null {
  if (p.host.endsWith(".")) return "host ends with a dot";
  if (new URL(uri).pathname !== p.path) return "the browser would visit another path";
  return pathProblem(p.path);
}

/**
 * One return address as a matchRedirect row: loopback http with or without a port gets port "any"
 * (RFC 8252); https is an exact address and must be on the origin `origin` when it is given. The address must be canonical
 * (redirectCanonicalProblem), so that the forwarder check and matchRedirect compare what the browser will visit
 * (https://vscode.dev/./redirect is the forwarder too). Anything else is not usable.
 */
export function usableRedirect(uri: unknown, origin: string | null): { ok: true; line: UsableRedirect } | { ok: false; reason: RedirectSkipReason } {
  const p = parseRedirect(uri);
  if (!p) return { ok: false, reason: typeof uri === "string" && /^[a-z][a-z0-9+.-]*:/i.test(uri) && !/^https?:/i.test(uri) ? "scheme" : "unparsed" };
  if (p.scheme === "http") {
    if (!LOOPBACK_HOSTS.includes(p.host)) return { ok: false, reason: "plain_http" };
    if (redirectCanonicalProblem(uri as string, p)) return { ok: false, reason: "non_canonical" };
    return { ok: true, line: { uri: uri as string, row: { scheme: "http", host: p.host, port: "any", path: p.path }, loopback: true } };
  }
  if (p.scheme !== "https") return { ok: false, reason: "scheme" };
  if (isUnverifiedForwarder(uri)) return { ok: false, reason: "unverified_forwarder" };
  if (redirectCanonicalProblem(uri as string, p)) return { ok: false, reason: "non_canonical" };
  if (origin !== null && new URL(uri as string).origin !== origin) return { ok: false, reason: "other_origin" };
  return { ok: true, line: { uri: uri as string, row: { scheme: "https", host: p.host, port: p.port ?? 443, path: p.path }, loopback: false } };
}

/** Kind by return addresses: all loopback — local_other, otherwise cloud_other. */
export const kindByRedirects = (lines: readonly { loopback: boolean }[]): "local_other" | "cloud_other" =>
  lines.length > 0 && lines.every((l) => l.loopback) ? "local_other" : "cloud_other";

// ---------------------------------------------------------------- labels

// control, format (bidi marks such as U+202E), line/paragraph separators and lone surrogates
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

/** Self-chosen name of a client: unsafe characters removed, white space collapsed; empty — null. */
export function cleanClientName(v: string): string | null {
  const s = v.replace(UNSAFE, "").replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
}

/** Number of characters as PostgreSQL char_length counts them (code points). */
export const charLength = (s: string): number => [...s].length;

/** A host as a label of at most `max` characters: a too long host keeps its end (the registrable part) after "…". */
export function hostLabel(host: string, max: number = CLIENT_LABEL_MAX): string {
  const chars = [...host];
  return chars.length <= max ? host : `…${chars.slice(chars.length - (max - 1)).join("")}`;
}

// ---------------------------------------------------------------- the document

export interface CimdDocument {
  readonly clientId: string;
  /** usable return addresses in document order */
  readonly lines: readonly UsableRedirect[];
  /** rows for matchRedirect */
  readonly redirects: readonly AnchorsRedirect[];
  /** skipped lines: index in redirect_uris and why (for the event and the admin probe) */
  readonly skipped: readonly { index: number; reason: RedirectSkipReason }[];
  /** cleaned client_name, only for the line "It calls itself …" */
  readonly name: string | null;
}
export type CimdCheck =
  | { ok: true; doc: CimdDocument }
  | { ok: false; reason: "cimd_invalid"; rule: number; detail: string; skipped: number };

const invalid = (rule: number, detail: string, skipped = 0): CimdCheck => ({ ok: false, reason: "cimd_invalid", rule, detail, skipped });
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * Validate a downloaded document for client_id (rule 0 — not a JSON object). Return addresses that
 * cannot be used are skipped; the document is refused only when none is usable. The client is always public: secrets and
 * client_assertion are refused at /oauth/token.
 */
export function checkCimdDocument(clientId: string, json: unknown): CimdCheck {
  if (!json || typeof json !== "object" || Array.isArray(json)) return invalid(0, "the document is not a JSON object");
  const d = json as Record<string, unknown>;
  // 1. client_id: strict string equality with the address
  if (d.client_id !== clientId) return invalid(1, "client_id in the document differs from its address");
  // 2. redirect_uris: 1–10 strings, each at most 2048 characters
  const uris = d.redirect_uris;
  if (!isStringArray(uris) || uris.length < 1 || uris.length > CIMD_REDIRECTS_MAX || uris.some((u) => u.length > REDIRECT_MAX)) {
    return invalid(2, `redirect_uris must be 1-${CIMD_REDIRECTS_MAX} strings of at most ${REDIRECT_MAX} characters`);
  }
  // 3–4. each line as a matchRedirect row; unusable lines are skipped
  let origin: string;
  try {
    origin = new URL(clientId).origin;
  } catch {
    return invalid(1, "client_id is not a URL");
  }
  const lines: UsableRedirect[] = [];
  const skipped: { index: number; reason: RedirectSkipReason }[] = [];
  uris.forEach((u, index) => {
    const r = usableRedirect(u, origin);
    if (r.ok) lines.push(r.line);
    else skipped.push({ index, reason: r.reason });
  });
  if (lines.length === 0) return invalid(4, "no usable return address in redirect_uris", skipped.length);
  // 5. authentication: "none" must be possible; the client is always treated as public
  const methods = d.token_endpoint_auth_methods_supported, method = d.token_endpoint_auth_method;
  const noneOk = (Array.isArray(methods) && methods.includes("none")) || method === "none" || (methods == null && method == null);
  if (!noneOk) return invalid(5, "the document does not allow token endpoint auth method none", skipped.length);
  // 6. grant_types with authorization_code, response_types with code (extra values do not matter)
  if (d.grant_types != null && !(isStringArray(d.grant_types) && d.grant_types.includes("authorization_code"))) {
    return invalid(6, "grant_types must contain authorization_code", skipped.length);
  }
  if (d.response_types != null && !(isStringArray(d.response_types) && d.response_types.includes("code"))) {
    return invalid(6, "response_types must contain code", skipped.length);
  }
  // 7. client_name: a string of at most 100 characters after cleaning; logo_uri is not used
  let name: string | null = null;
  if (d.client_name != null) {
    if (typeof d.client_name !== "string") return invalid(7, "client_name must be a string", skipped.length);
    name = cleanClientName(d.client_name);
    if (name !== null && charLength(name) > CLIENT_NAME_MAX) return invalid(7, `client_name is longer than ${CLIENT_NAME_MAX} characters`, skipped.length);
  }
  return { ok: true, doc: { clientId, lines, redirects: lines.map((l) => l.row), skipped, name } };
}

// ---------------------------------------------------------------- known apps (KNOWN_CIMD)

export interface KnownCimd {
  /** exact document addresses */
  readonly clientIds: readonly string[];
  /** or a pinned pattern, anchored, group 1 — the id used by pinned return addresses */
  readonly pattern?: RegExp;
  /** ids of the pattern that belong to another row */
  readonly exceptIds?: readonly string[];
  /** pinned return addresses; id — group 1 of the pattern (null for an exact address) */
  readonly redirects: (id: string | null) => readonly RedirectRow[];
  readonly kind: ConnectionClientKind;
  readonly title: string;
}

/**
 * Codex path: /callback or /callback/<callback id>. The id alphabet includes - and _ (the Codex callback id is
 * base64url).
 */
export const CODEX_CALLBACK_PATH = "^/callback(/[A-Za-z0-9_-]{8,32})?$";
const loopback = (hosts: readonly string[], path: { path: string } | { path_regex: string }): AnchorsRedirect[] =>
  hosts.map((host) => ({ scheme: "http", host, port: "any", ...path }) as AnchorsRedirect);
const https = (host: string, path: string): AnchorsRedirect => ({ scheme: "https", host, port: 443, path });

/** First match from the top. All documents of the exact rows were downloaded once and checked. */
export const KNOWN_CIMD: readonly KnownCimd[] = [
  { clientIds: ["https://claude.ai/oauth/claude-code-client-metadata"], redirects: () => loopback(["localhost", "127.0.0.1"], { path: "/callback" }),
    kind: "claude_code", title: "Claude Code" },
  { clientIds: ["https://claude.ai/oauth/mcp-oauth-client-metadata"], redirects: () => [https("claude.ai", "/api/mcp/auth_callback")],
    kind: "cloud_other", title: "Claude (claude.ai)" },
  { clientIds: ["https://chatgpt.com/oauth/client.json"], redirects: () => [https("chatgpt.com", "/connector_platform_oauth_redirect")],
    kind: "cloud_other", title: "ChatGPT" },
  { clientIds: ["https://chatgpt.com/oauth/codex/client.json"], pattern: /^https:\/\/chatgpt\.com\/oauth\/codex\/([A-Za-z0-9_-]{1,64})\/client\.json$/,
    redirects: () => loopback(["127.0.0.1", "localhost"], { path_regex: CODEX_CALLBACK_PATH }), kind: "codex", title: "Codex" },
  // ChatGPT without RFC 9207 support: …/oauth/<callback id>/client.json
  { clientIds: [], pattern: /^https:\/\/chatgpt\.com\/oauth\/([A-Za-z0-9_-]{1,64})\/client\.json$/, exceptIds: ["codex"],
    redirects: (id) => [https("chatgpt.com", "/connector_platform_oauth_redirect"), https("chatgpt.com", `/connector/oauth/${id}`)],
    kind: "cloud_other", title: "ChatGPT" },
  { clientIds: ["https://vscode.dev/oauth/client-metadata.json"], redirects: () => loopback(["127.0.0.1"], { path: "/" }), kind: "vscode", title: "VS Code" },
];

/** Does this row claim the address: an exact address (id null) or the pattern with an id not excluded; null — no. */
export function knownCimdMatch(row: KnownCimd, clientId: string): { id: string | null } | null {
  if (row.clientIds.includes(clientId)) return { id: null };
  const m = row.pattern?.exec(clientId);
  return m && !(row.exceptIds ?? []).includes(m[1]!) ? { id: m[1]! } : null;
}

/** The first row of KNOWN_CIMD that claims the address, with the pattern id; null — none. */
export function knownCimdRow(clientId: string): { row: KnownCimd; id: string | null } | null {
  for (const row of KNOWN_CIMD) {
    const m = knownCimdMatch(row, clientId);
    if (m) return { row, id: m.id };
  }
  return null;
}

export interface CimdClientView {
  readonly kind: ConnectionClientKind;
  /** title on the consent page and client label: the pinned title, or the host of client_id */
  readonly title: string;
  readonly known: boolean;
  /** cleaned client_name ("It calls itself …"), never the title of an unknown app */
  readonly name: string | null;
  /** host of client_id */
  readonly host: string;
  readonly redirect: { uri: string; mode: RedirectMode };
}

/**
 * The client of a transaction: the requested redirect_uri must match a usable line of the document; "known" only when the
 * address is pinned and redirect_uri is one of the row's pinned return addresses. null — the return address is
 * not allowed (invalid_redirect_uri).
 */
export function cimdClientFor(doc: CimdDocument, redirectUri: unknown): CimdClientView | null {
  const m = matchRedirect({ redirects: doc.redirects }, redirectUri);
  if (!m.ok) return null;
  const host = new URL(doc.clientId).hostname;
  const known = knownCimdRow(doc.clientId);
  if (known && matchRedirect({ redirects: known.row.redirects(known.id) }, redirectUri).ok) {
    return { kind: known.row.kind, title: known.row.title, known: true, name: doc.name, host, redirect: { uri: m.uri, mode: m.mode } };
  }
  return { kind: kindByRedirects(doc.lines), title: hostLabel(host), known: false, name: doc.name, host, redirect: { uri: m.uri, mode: m.mode } };
}

// ---------------------------------------------------------------- cache lifetime

/**
 * Lifetime of a cached document from Cache-Control: max-age clamped to 5 min … 3 days; without the header or max-age — 1 h;
 * no-store, no-cache and max-age=0 also give 5 minutes (a client document rarely changes, and without a lower bound every
 * sign-in would go to the network).
 */
export function cimdCacheTtlMs(cacheControl: string | null | undefined): number {
  if (typeof cacheControl !== "string" || cacheControl.trim() === "") return CIMD_TTL_DEFAULT_MS;
  const directives = cacheControl.toLowerCase().split(",").map((d) => d.trim());
  if (directives.some((d) => d === "no-store" || d === "no-cache" || d.startsWith("no-cache="))) return CIMD_TTL_MIN_MS;
  for (const d of directives) {
    const m = /^max-age\s*=\s*"?(\d{1,12})"?$/.exec(d);
    if (m) return Math.min(CIMD_TTL_MAX_MS, Math.max(CIMD_TTL_MIN_MS, Number(m[1]) * 1000));
  }
  return CIMD_TTL_DEFAULT_MS;
}

// ---------------------------------------------------------------- failures: reason and negative cache

const TLS_CODE = /CERT|TLS|SSL|SELF_SIGNED|ALTNAME|UNABLE_TO|EPROTO|HANDSHAKE/i;

/**
 * Reason of a transport error (systemHttp of oidc.ts): the same order as transportFailure there, plus a body over
 * maxBytes (error property bodyLimit) — cimd_too_large.
 */
export function cimdTransportReason(e: unknown): CimdReason {
  const err = (e && typeof e === "object" ? e : {}) as { code?: unknown; message?: unknown; bodyLimit?: unknown };
  if (typeof err.bodyLimit === "number") return "cimd_too_large";
  const code = typeof err.code === "string" ? err.code : "";
  const message = typeof err.message === "string" ? err.message : String(e ?? "");
  if (code === "OIDC_ADDRESS_BLOCKED") return "address_blocked";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
  if (code === "OIDC_TIMEOUT") return "timeout";
  if (TLS_CODE.test(code) || /certificate|ssl|tls/i.test(message)) return "tls";
  return "network";
}

/**
 * Which negative cache a failed download goes to: "host" — the host cools down for 5 minutes (403, 429, 5xx, TLS, DNS,
 * timeout; also a refused connection and a blocked address — the site, not the document); "client" — this client_id for
 * 60 s (404 and other statuses, an invalid or too large document); null — not a download failure.
 */
export function cimdFailureScope(reason: CimdReason, status?: number): "host" | "client" | null {
  switch (reason) {
    case "tls": case "dns": case "timeout": case "network": case "address_blocked":
      return "host";
    case "cimd_fetch_failed":
      return status === 403 || status === 429 || (typeof status === "number" && status >= 500) ? "host" : "client";
    case "cimd_too_large": case "cimd_invalid":
      return "client";
    default:
      return null;
  }
}

/**
 * details of the audit event auth_failure {op: "oauth_cimd_refused"}: only public facts and lengths; client_id
 * is a public document address, cut to 255.
 */
export function cimdRefusedDetails(o: {
  clientId: unknown; host: string | null; reason: CimdReason; status?: number; rule?: number; contentType?: string; bytes?: number; skipped?: number;
}): Record<string, string | number | null> {
  return {
    op: "oauth_cimd_refused",
    client_id: typeof o.clientId === "string" ? o.clientId.slice(0, CIMD_ID_MAX) : null,
    host: o.host === null ? null : o.host.slice(0, 253),
    reason: o.reason,
    status: o.status ?? null,
    rule: o.rule ?? null,
    content_type: o.contentType === undefined ? null : o.contentType.slice(0, 100),
    bytes: o.bytes ?? null,
    skipped_lines: o.skipped ?? 0,
  };
}
