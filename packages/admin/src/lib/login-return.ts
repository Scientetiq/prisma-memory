import { SESSION_PLAIN } from "../messages/login-return";

export const PATH_HEADER = "x-memory-path";
export const WAS_IN_COOKIE = "memory_was_in";
export const WAS_IN_MAX_AGE = 30 * 24 * 3600;
export const OIDC_NEXT_COOKIE = "memory_oidc_next";

const NEXT_MAX = 512;
const BLOCKED = ["/admin", "/login", "/auth", "/api", "/_next"];
const CONTROL = /[\u0000-\u001f\u007f]/;

const blockedPath = (p: string, blocked: readonly string[] = BLOCKED): boolean => {
  const path = p.split(/[?#]/)[0]!.toLowerCase();
  return blocked.some((b) => path === b || path.startsWith(`${b}/`));
};

const ORIGIN = "http://memory.invalid";
const normalPath = (p: string): string | null => {
  try { const u = new URL(p, ORIGIN); return u.origin === ORIGIN ? u.pathname : null; } catch { return null; }
};

export function safeNext(raw: string | null | undefined): string | null {
  return checkedPath(raw, BLOCKED);
}

/** Sections the language switch never returns to: sign-in routes, the API and Next's own paths (panel and sign-in pages are fine). */
const SWITCH_BLOCKED = ["/auth", "/api", "/_next"];

/**
 * Where the language switch sends the browser back: a path of this site under the same rules as safeNext (one leading
 * "/", at most 512 characters, no control characters or backslashes, also once decoded and normalised), but the admin
 * panel and the sign-in pages are allowed. Otherwise null.
 */
export function safeReturnPath(raw: string | null | undefined): string | null {
  return checkedPath(raw, SWITCH_BLOCKED);
}

function checkedPath(raw: string | null | undefined, blocked: readonly string[]): string | null {
  if (typeof raw !== "string" || !raw || raw.length > NEXT_MAX) return null;
  if (raw[0] !== "/" || raw[1] === "/" || raw.includes("\\") || CONTROL.test(raw)) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { return null; }
  if (decoded[1] === "/" || decoded.includes("\\") || CONTROL.test(decoded)) return null;
  const norm = normalPath(raw), normDecoded = normalPath(decoded);
  if (norm === null || normDecoded === null) return null;
  if ([raw, decoded, norm, normDecoded].some((p) => blockedPath(p, blocked))) return null;
  return raw;
}

export function loginHref(o: { next?: string | null; expired?: boolean } = {}): string {
  const q = new URLSearchParams();
  if (o.expired) q.set("expired", "1");
  const next = safeNext(o.next);
  if (next && next !== "/") q.set("next", next);
  const s = q.toString();
  return s ? `/login?${s}` : "/login";
}

export function ssoStartHref(next: string | null | undefined, fresh = false): string {
  const n = safeNext(next);
  const q = [...(n && n !== "/" ? [`next=${encodeURIComponent(n)}`] : []), ...(fresh ? ["fresh=1"] : [])];
  return q.length ? `/auth/oidc/start?${q.join("&")}` : "/auth/oidc/start";
}

export const wasInCookieOptions = (secure: boolean) => ({ httpOnly: true, sameSite: "lax" as const, secure, path: "/", maxAge: WAS_IN_MAX_AGE });

export { SESSION_PLAIN } from "../messages/login-return";

export const isLoginLink = (href: string): boolean => href === "/login" || href.startsWith("/login?");

export function resultLink(res: { ok: boolean; message: string; link?: { href: string; label: string } }, here: string | null): { href: string; label: string } | undefined {
  if (res.link) return res.link;
  if (res.ok || !res.message.includes(SESSION_PLAIN.ended)) return undefined;
  if (here && blockedPath(here)) return undefined;
  return { href: loginHref({ expired: true, next: here }), label: SESSION_PLAIN.login };
}

export const browserPath = (): string | null => (typeof location === "undefined" ? null : `${location.pathname}${location.search}`);
