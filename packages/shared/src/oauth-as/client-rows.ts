// Pre-registered clients of the built-in authorization server (setting agent_auth.clients). One row per public
// client: {client_id, kind, title, enabled, redirects}. A redirect row is the edge anchors' row
// {scheme, host, port, path | path_regex} or {uri} for an app's own scheme (cursor://…); matchRedirect (redirect.ts, the
// copy of the edge module) reads both forms. Used by settings validation (settings.ts) and by the gateway (client
// lookup), so a value the gateway reads always passed the same rules. Pure: no I/O.
//
// A redirect row must be reachable by matchRedirect, otherwise the row is dead weight or, worse, looks safe while it is
// not: http only for this computer (RFC 8252 §8.3), "any" port only for http loopback (RFC 8252 §7.3), https — a DNS
// name or loopback, a path exactly as the browser will see it (WHATWG pathname equal to the stored one: no dot segments,
// no percent-encoded dots), a path_regex anchored at both ends and without constructs that make matching slow.
// The rules of the composed address repeat parseRedirect of redirect.ts; a unit test checks
// every accepted seed row against the edge's own rule.
import type { ConnectionClientKind } from "../client-kind.ts";
import { UNVERIFIED_FORWARDERS } from "./cimd.ts";

/**
 * Kinds a registry row may name: CONNECTION_CLIENT_KINDS of ../client-kind.ts (the list is not extended).
 * Modules of oauth-as import only node:crypto, each other and types (a parity test holds
 * the rule), and client-kind.ts loads the shared error module, so the list is written here again: `satisfies`
 * makes tsc refuse a missing or an extra kind, and a unit test compares the keys with the original list.
 */
export const ROW_CLIENT_KINDS = {
  claude_code: true, codex: true, cursor: true, cloud_other: true, vscode: true, local_other: true, claude_desktop: true,
} as const satisfies Record<ConnectionClientKind, true>;
const isRowClientKind = (v: unknown): v is ConnectionClientKind => typeof v === "string" && Object.hasOwn(ROW_CLIENT_KINDS, v);

export const CLIENT_ROWS_MAX = 50;
export const CLIENT_REDIRECTS_MAX = 10;
export const CLIENT_TITLE_MAX = 80;
export const PATH_REGEX_MAX = 200;
export const CLIENT_REDIRECT_MAX = 2048;
/** client_id of a registry row: lower case, 3–64 characters; never `dcr_…` (DCR) and never an https URL (CIMD). */
export const CLIENT_ID_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;

export interface ClientHttpRedirect { scheme: "http" | "https"; host: string; port: number | "any"; path?: string; path_regex?: string }
export interface ClientCustomRedirect { uri: string }
export type ClientRedirectRow = ClientHttpRedirect | ClientCustomRedirect;
export interface ClientRow { client_id: string; kind: ConnectionClientKind; title: string; enabled: boolean; redirects: ClientRedirectRow[] }
export type ClientRowsResult = { ok: true; rows: ClientRow[] } | { ok: false; problems: string[] };

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);
const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
// the same characters parseRedirect refuses: control characters, space, everything from DEL up, backslash
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000- \u007f-￿\\]/;
// an app's own scheme: not http(s) and not a scheme the browser executes; no spaces, query or fragment (customOk)
const CUSTOM = /^(?!(?:https?|javascript|vbscript|data|blob|file|about|filesystem):)[a-z][a-z0-9+.-]*:[^\s?#]+$/;
/** Characters that must never be in a title shown on the consent screen: control and format (bidi overrides) characters. */
export const UNSAFE_TEXT = /[\p{Cc}\p{Cf}]/u;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * At most this many ways for a path_regex to match one path (the product below). The edge matches the anonymous
 * redirect_uri of GET /oauth/authorize with a backtracking engine, so the work of a failed match grows with that number:
 * a quantifier over one character or class costs its count range, an unbounded one (*, +, {m,}) up to the path length,
 * an optional group (…)? one more than its inside, alternatives their sum. 65 536 keeps one unbounded repeat with a few
 * small bounded ones, or four {0,15} — milliseconds on a 2048-character path — and refuses two unbounded repeats (2049²),
 * a?ⁿaⁿ and chains of overlapping repeats, which are exponential or high-degree polynomial.
 */
export const PATH_REGEX_WAYS_MAX = 65_536;
const UNBOUNDED_WAYS = CLIENT_REDIRECT_MAX + 1;
// escapes outside and inside a class: one-character classes and punctuation; never assertions (\b), code points (\u, \x,
// \c, \0), back-references (\1, \k) or properties (\p)
const ESCAPABLE = new Set([..."dDwWsS", ..."\\/.-_~^$*+?()[]{}|"]);

/**
 * Why a path_regex cannot be stored, or null. The edge compiles it with `new RegExp(row.path_regex)` and tests the request
 * path (≤ 2048 characters): anchored ^/…$, at most 200 characters, compiles, no back-references. The rest is a narrow
 * grammar (a plain "no nested quantifiers" rule still let `(a|a)*`, `.*a.*a.*a` and
 * a?ⁿaⁿ through): literals, `.`, classes and the escapes above, each repeated by ?, *, +, {m}, {m,}, {m,n} (n ≤ 2048,
 * never lazy); groups (…) and (?:…) one level deep, repeated only as optional (…)?, | only inside a group; and the number
 * of ways to match stays within PATH_REGEX_WAYS_MAX.
 */
export function pathRegexProblem(src: unknown): string | null {
  if (typeof src !== "string" || src.length === 0) return "path_regex must be a non-empty string";
  if (src.length > PATH_REGEX_MAX) return `path_regex is longer than ${PATH_REGEX_MAX} characters`;
  if (!src.startsWith("^/") || !src.endsWith("$") || src.endsWith("\\$")) return "path_regex must start with ^/ and end with $";
  try { new RegExp(src); } catch { return "path_regex does not compile"; }
  if (/\\[1-9]|\\k</.test(src)) return "path_regex must not use back-references";
  const shape = pathRegexWays(src.slice(1, -1));
  if (typeof shape === "string") return shape;
  if (shape > PATH_REGEX_WAYS_MAX) return `path_regex can match one path in too many ways: at most one unbounded repeat (*, +, {m,}), and all repeats multiplied stay within ${PATH_REGEX_WAYS_MAX}`;
  return null;
}

/** The grammar of pathRegexProblem over the body between ^ and $: the number of ways to match (capped), or a problem. */
function pathRegexWays(body: string): number | string {
  let i = 0;
  const cap = (n: number) => Math.min(n, PATH_REGEX_WAYS_MAX + 1);
  // the end of a class [ … ] that starts at i, or a problem
  const classEnd = (): number | string => {
    let j = i + 1;
    if (body[j] === "^") j++;
    for (; j < body.length; j++) {
      const ch = body[j]!;
      if (ch === "]") return j;
      if (ch === "\\") { if (!ESCAPABLE.has(body[j + 1] ?? "")) return "path_regex escapes only \\d \\w \\s (and their capitals) and punctuation"; j++; }
    }
    return "path_regex has a class without ]";
  };
  // the quantifier at i: its kind, the ways of one character or class repeated by it, its length (none: 1 way, length 0)
  const quantifier = (): { kind: "none" | "optional" | "count"; ways: number; len: number } | string => {
    const ch = body[i];
    let q: { kind: "none" | "optional" | "count"; ways: number; len: number };
    if (ch === "?") q = { kind: "optional", ways: 2, len: 1 };
    else if (ch === "*" || ch === "+") q = { kind: "count", ways: UNBOUNDED_WAYS, len: 1 };
    else if (ch === "{") {
      const m = /^\{(\d{1,5})(,(\d{0,5}))?\}/.exec(body.slice(i));
      if (!m) return "path_regex writes {, }, ] and other special characters escaped";
      const min = Number(m[1]), max = m[2] === undefined ? min : m[3] === "" ? Infinity : Number(m[3]);
      if (min > CLIENT_REDIRECT_MAX || (max !== Infinity && max > CLIENT_REDIRECT_MAX)) return `path_regex repeats at most ${CLIENT_REDIRECT_MAX} times`;
      q = { kind: "count", ways: max === Infinity ? UNBOUNDED_WAYS : max - min + 1, len: m[0].length };
    } else return { kind: "none", ways: 1, len: 0 };
    if (body[i + q.len] === "?") return "path_regex must not use lazy repeats";
    return q;
  };
  // a sequence up to the end, | or ): the product of its items' ways
  const sequence = (inGroup: boolean): number | string => {
    let ways = 1;
    while (i < body.length) {
      const ch = body[i]!;
      if (ch === "|" || ch === ")") {
        if (inGroup) return ways;
        return ch === "|" ? "path_regex must not use | outside a group (it splits the anchors: ^/a|b$ is «starts with /a» or «ends with b»)" : "path_regex has ) without (";
      }
      let item: number;
      let group = false;
      if (ch === "(") {
        if (inGroup) return "path_regex must not nest groups";
        i++;
        if (body.startsWith("?:", i)) i += 2;
        else if (body[i] === "?") return "path_regex must not use lookarounds or named groups";
        let sum = 0;
        for (;;) {
          const alt = sequence(true);
          if (typeof alt === "string") return alt;
          sum = cap(sum + alt);
          if (body[i] === "|") { i++; continue; }
          if (body[i] === ")") { i++; break; }
          return "path_regex has ( without )";
        }
        item = sum;
        group = true;
      } else if (ch === "[") {
        const end = classEnd();
        if (typeof end === "string") return end;
        i = end + 1;
        item = 1;
      } else if (ch === "\\") {
        if (!ESCAPABLE.has(body[i + 1] ?? "")) return "path_regex escapes only \\d \\w \\s (and their capitals) and punctuation";
        i += 2;
        item = 1;
      } else if ("^$?*+{}]".includes(ch)) {
        return "path_regex writes {, }, ] and other special characters escaped";
      } else { i++; item = 1; }
      const q = quantifier();
      if (typeof q === "string") return q;
      i += q.len;
      if (group && q.kind === "count") return "path_regex may repeat a group only with ? (optional)";
      ways = cap(ways * (group ? (q.kind === "optional" ? item + 1 : item) : q.ways));
    }
    return ways;
  };
  return sequence(false);
}

export const FORWARDER_HOSTS: ReadonlySet<string> = new Set(UNVERIFIED_FORWARDERS.map((u) => new URL(u).hostname));

/** Why a redirect row cannot be stored, or null. */
export function redirectRowProblem(row: unknown): string | null {
  if (!isObject(row)) return "a redirect is an object {scheme, host, port, path | path_regex} or {uri}";
  const keys = Object.keys(row);
  if (keys.includes("uri")) {
    if (keys.length !== 1) return "a redirect {uri} has no other fields";
    const uri = row.uri;
    if (typeof uri !== "string" || uri.length > CLIENT_REDIRECT_MAX || BAD_CHARS.test(uri) || !CUSTOM.test(uri))
      return "uri is an app's own scheme address (for example cursor://…/callback): not http(s), no spaces, query or fragment";
    return null;
  }
  const extra = keys.filter((k) => !["scheme", "host", "port", "path", "path_regex"].includes(k));
  if (extra.length) return `unknown redirect fields: ${extra.join(", ")}`;
  const { scheme, host, port, path, path_regex: pathRegex } = row;
  if (scheme !== "http" && scheme !== "https") return "scheme is http or https";
  if (typeof host !== "string" || !host) return "host is required";
  const loopback = LOOPBACK.has(host);
  if (scheme === "http" && !loopback) return "http is allowed only for this computer: 127.0.0.1, [::1] or localhost";
  if (scheme === "https" && !loopback && !HOSTNAME.test(host)) return "host is a lower-case DNS name";
  if (FORWARDER_HOSTS.has(host)) return `${host} forwards the code to an address chosen by whoever starts the sign-in: not accepted as a return address`;
  if (port === "any") {
    if (scheme !== "http" || !loopback) return "port \"any\" is allowed only for http on this computer";
  } else if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return "port is 1–65535 or \"any\"";
  if ((path === undefined) === (pathRegex === undefined)) return "a redirect has exactly one of path and path_regex";
  if (pathRegex !== undefined) return pathRegexProblem(pathRegex);
  if (typeof path !== "string" || !path.startsWith("/")) return "path starts with /";
  const composed = `${scheme}://${host}${port === "any" ? "" : `:${port}`}${path}`;
  if (composed.length > CLIENT_REDIRECT_MAX || BAD_CHARS.test(composed) || path.includes("?") || path.includes("#"))
    return "path has no spaces, query, fragment or non-ASCII characters";
  try {
    const u = new URL(composed);
    if (u.protocol !== `${scheme}:` || u.hostname !== host || u.pathname !== path) return "path must be written exactly as a browser sends it (no dot segments)";
  } catch {
    return "the redirect address does not parse";
  }
  return null;
}

/**
 * Parse agent_auth.clients: an array of at most 50 rows, each row valid, client_id unique. Any problem refuses the whole
 * value (settings validation shows every problem; the gateway then serves no registry client — fail closed).
 */
export function parseClientRows(value: unknown): ClientRowsResult {
  if (!Array.isArray(value)) return { ok: false, problems: ["agent_auth.clients is an array of clients"] };
  const problems: string[] = [];
  if (value.length > CLIENT_ROWS_MAX) problems.push(`at most ${CLIENT_ROWS_MAX} clients`);
  const seen = new Set<string>();
  value.forEach((raw, n) => {
    const at = `client ${n + 1}`;
    if (!isObject(raw)) { problems.push(`${at}: an object {client_id, kind, title, enabled, redirects}`); return; }
    const extra = Object.keys(raw).filter((k) => !["client_id", "kind", "title", "enabled", "redirects"].includes(k));
    if (extra.length) problems.push(`${at}: unknown fields ${extra.join(", ")}`);
    const id = raw.client_id;
    if (typeof id !== "string" || !CLIENT_ID_RE.test(id)) problems.push(`${at}: client_id is 3–64 characters a-z 0-9 . _ -, starting with a letter or digit`);
    else {
      if (id.startsWith("dcr_")) problems.push(`${at}: client_id must not start with dcr_ (reserved for automatic registration)`);
      if (seen.has(id)) problems.push(`${at}: client_id ${id} is repeated`);
      seen.add(id);
    }
    if (typeof id === "string" && id.startsWith("https:")) problems.push(`${at}: client_id must not be an https address (reserved for client metadata documents)`);
    if (!isRowClientKind(raw.kind)) problems.push(`${at}: kind is one of ${Object.keys(ROW_CLIENT_KINDS).join(", ")}`);
    if (typeof raw.title !== "string" || raw.title.trim().length === 0 || raw.title.length > CLIENT_TITLE_MAX || raw.title !== raw.title.trim() || UNSAFE_TEXT.test(raw.title))
      problems.push(`${at}: title is 1–${CLIENT_TITLE_MAX} characters without control or format characters and without spaces at the ends`);
    if (typeof raw.enabled !== "boolean") problems.push(`${at}: enabled is true or false`);
    if (!Array.isArray(raw.redirects) || raw.redirects.length < 1 || raw.redirects.length > CLIENT_REDIRECTS_MAX)
      problems.push(`${at}: redirects is a list of 1–${CLIENT_REDIRECTS_MAX} return addresses`);
    else raw.redirects.forEach((r, k) => { const p = redirectRowProblem(r); if (p) problems.push(`${at}, redirect ${k + 1}: ${p}`); });
  });
  if (problems.length) return { ok: false, problems };
  return { ok: true, rows: value as ClientRow[] };
}

/** Enabled registry row with this client_id, or null (rows that do not parse serve nobody). */
export function registryClient(value: unknown, clientId: string): ClientRow | null {
  const parsed = parseClientRows(value);
  if (!parsed.ok) return null;
  return parsed.rows.find((r) => r.client_id === clientId && r.enabled) ?? null;
}
