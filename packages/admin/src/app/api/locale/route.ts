// Language switch: POST locale=en|ru&return_to=<path> from the switch form (works without JavaScript and without a session,
// so the sign-in pages carry it too). Only from this site's own pages (Sec-Fetch-Site: same-origin, or an Origin equal
// to the site's address; neither header — refused), body at most 1 kB, value exactly "en" or "ru". The answer sets the
// memory_locale cookie for a year and sends the browser back to a safe local path with a full page load (303): the
// language changes for server and client parts at once. No other server state changes; the values are never echoed.
// Under /api/, outside the matcher of proxy.ts, so it answers in every MEMORY_WEB_ROLE.
import { safeReturnPath } from "@/lib/login-return";
import { webRole } from "@/lib/web-role";
import { cookieSecure, fromOwnPages } from "@/lib/workplace-login";

const LOCALE_COOKIE = "memory_locale";
const LOCALE_COOKIE_MAX_AGE = 365 * 24 * 3600;
const LOCALE_BODY_MAX = 1024;

const plain = (status: number, text: string): Response =>
  new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/** The body as text, at most `max` bytes (a longer body is refused while it streams, not buffered); null — too large. */
async function readBody(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.byteLength;
    if (seen > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(seen);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Where to go when `next` is missing or unsafe: the home of this process's role. */
function home(): string {
  try {
    return webRole() === "panel" ? "/admin" : "/";
  } catch {
    return "/";
  }
}

/**
 * A safe local path as a Location value: a header holds ASCII only, so every character outside "!".."~" (a space, a
 * Cyrillic letter, a zero-width space) is percent-encoded; escapes already in the path stay as they are. A path that
 * cannot be encoded (a lone surrogate) goes home.
 */
function asLocation(path: string): string {
  try {
    return path.replace(/[^\x21-\x7e]/gu, (c) => encodeURIComponent(c));
  } catch {
    return home();
  }
}

export async function POST(req: Request): Promise<Response> {
  if (!fromOwnPages(req)) return plain(403, "Forbidden");
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > LOCALE_BODY_MAX) return plain(413, "Payload Too Large");
  const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return plain(415, "Unsupported Media Type");
  let body: string | null;
  try {
    body = await readBody(req, LOCALE_BODY_MAX);
  } catch {
    return plain(400, "Bad Request");
  }
  if (body === null) return plain(413, "Payload Too Large");
  const form = new URLSearchParams(body);
  const locale = form.get("locale");
  if (locale !== "en" && locale !== "ru") return plain(400, "Bad Request");
  const safe = safeReturnPath(form.get("return_to"));
  const target = safe === null ? home() : asLocation(safe);
  const cookie = `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax; HttpOnly${cookieSecure(req) ? "; Secure" : ""}`;
  return new Response(null, { status: 303, headers: { location: target, "set-cookie": cookie, "cache-control": "no-store" } });
}
