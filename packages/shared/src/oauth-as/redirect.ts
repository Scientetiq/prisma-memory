// OAuth authorization-server module of the gateway: return address rules. Differs from the edge's module: own structural
// types AnchorsRedirect/AnchorsClient; RedirectRow, ParsedRedirect and customOk are exported;
// a parity test pins the rest
//
// Return address rules, applied literally:
//   1. redirect_uri is required; comparison is exact after parsing, without case folding of the path, without decoding %XX,
//      dots or slashes; the host name is exactly as registered (127.1, 0x7f.0.0.1, LOCALHOST are not loopback names);
//   2. the port may differ only for an address registered with port "any" (only loopback: http, localhost / 127.0.0.1 /
//      [::1], RFC 8252 §7.3); otherwise exactly the registered port; an address without a port means the default port of
//      the scheme (https 443, http 80);
//   3. userinfo, fragment and query are forbidden (even an empty "?" or "#");
//   4. a custom scheme (cursor://…) only as an exact string from a { uri } row of the same client, mode custom;
//   5. a refusal is an error page without a redirect (RFC 6749 §4.1.2.1), otherwise sign-in would be an open redirect.
// [::1] is mode link: the code is handed over on a page with a link, not by a redirect.

export const REDIRECT_MAX = 2048;

export type RedirectMode = "redirect" | "link" | "custom";

/** Structural copy of AnchorsRedirect from @memory/wire/common (anchors.ts). */
export interface AnchorsRedirect { scheme: "http" | "https"; host: string; port: "any" | number; path?: string; path_regex?: string }
/** Structural copy of the part of AnchorsClient from @memory/wire/common that matchRedirect reads. */
export interface AnchorsClient { redirects: readonly RedirectRow[] }

/** Row for a client's own scheme: the whole address, compared as an exact string. */
export interface AnchorsCustomRedirect { uri: string }
export type RedirectRow = AnchorsRedirect | AnchorsCustomRedirect;
export type RedirectMatch = { ok: true; uri: string; mode: RedirectMode } | { ok: false };

// scheme://authority path, without query and fragment (their presence is checked separately)
const SHAPE = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)$/;
const PORT = /^[1-9][0-9]{0,4}$/;
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000- \u007f-￿\\]/;
// own scheme: not http, not https and not a scheme a browser executes; no spaces, query or fragment
const CUSTOM = /^(?!(?:https?|javascript|vbscript|data|blob|file|about|filesystem):)[a-z][a-z0-9+.-]*:[^\s?#]+$/;
export const customOk = (u: string): boolean => u.length <= REDIRECT_MAX && !BAD_CHARS.test(u) && CUSTOM.test(u);
const DEFAULT_PORT: Record<string, number> = { http: 80, https: 443 };

export interface ParsedRedirect { scheme: string; host: string; port: number | null; path: string }

/** Parse an address by shape; null: the address fits no rule. */
export function parseRedirect(raw: unknown): ParsedRedirect | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > REDIRECT_MAX) return null;
  if (BAD_CHARS.test(raw) || raw.includes("?") || raw.includes("#")) return null;
  const m = SHAPE.exec(raw);
  if (!m) return null;
  const [, scheme, authority, rest] = m as unknown as [string, string, string, string];
  if (authority.includes("@") || authority === "") return null;
  let host: string;
  let portText: string | undefined;
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    if (end < 0) return null;
    host = authority.slice(0, end + 1);
    const tail = authority.slice(end + 1);
    if (tail && !tail.startsWith(":")) return null;
    portText = tail ? tail.slice(1) : undefined;
  } else {
    const parts = authority.split(":");
    if (parts.length > 2) return null;
    host = parts[0]!;
    portText = parts[1];
  }
  let port: number | null = null;
  if (portText !== undefined) {
    if (!PORT.test(portText)) return null;
    port = Number(portText);
    if (port > 65535) return null;
  }
  const path = rest === "" ? "/" : rest;
  if (!path.startsWith("/")) return null;
  // the WHATWG parser must accept the address too and see the same host: otherwise the browser would go elsewhere
  try {
    const u = new URL(raw);
    if (u.protocol !== `${scheme}:` || u.hostname !== host || u.username || u.password || u.search || u.hash) return null;
  } catch {
    return null;
  }
  return { scheme, host, port, path };
}

function pathMatches(r: AnchorsRedirect, path: string): boolean {
  if (typeof r.path === "string") return path === r.path;
  if (typeof r.path_regex !== "string") return false;
  try {
    return new RegExp(r.path_regex).test(path);
  } catch {
    return false;
  }
}

const isCustomRow = (r: RedirectRow): r is AnchorsCustomRedirect => typeof (r as Partial<AnchorsCustomRedirect>).uri === "string";

/** Does a parsed address match one http/https row. */
function redirectMatches(r: AnchorsRedirect, p: ParsedRedirect): boolean {
  if (p.scheme !== r.scheme || p.host !== r.host) return false;
  if (r.port === "any") {
    // any port only for loopback over http
    if (r.scheme !== "http" || !["localhost", "127.0.0.1", "[::1]"].includes(r.host)) return false;
  } else if ((p.port ?? DEFAULT_PORT[p.scheme]) !== r.port) return false;
  return pathMatches(r, p.path);
}

/** Return address of a client: acceptable means the same string and the mode of handing over the code; otherwise an error page. */
export function matchRedirect(client: AnchorsClient, raw: unknown): RedirectMatch {
  const rows: readonly RedirectRow[] = client.redirects;
  // own scheme: an exact string of the same client
  if (typeof raw === "string" && /^[a-z][a-z0-9+.-]*:/.test(raw) && !/^https?:/.test(raw)) {
    return customOk(raw) && rows.some((r) => isCustomRow(r) && r.uri === raw) ? { ok: true, uri: raw, mode: "custom" } : { ok: false };
  }
  const p = parseRedirect(raw);
  if (!p) return { ok: false };
  if (!rows.some((r) => !isCustomRow(r) && redirectMatches(r, p))) return { ok: false };
  return { ok: true, uri: raw as string, mode: p.host === "[::1]" ? "link" : "redirect" };
}
