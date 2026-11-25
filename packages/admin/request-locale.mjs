// Request scope of the interface language. One AsyncLocalStorage per process on globalThis.__memoryRequestLocale (the
// runtime of src/i18n reads it there: Next evaluates its bundles more than once, the tests re-evaluate modules). Every
// request runs inside a store that holds only the language cookie: the first memory_locale pair of the Cookie header,
// kept only if it is exactly "en" or "ru". Nothing else of the request is read, and nothing here throws: the scope wraps
// every request, the sign-in and the peer stamp of client-peer.mjs included.
//
// Loaded by client-peer.mjs (static import), so the start command does not change: client-peer.mjs wraps the "request"
// event of every http.Server, server.mjs wraps its HTTPS handler by hand (an https.Server is not an http.Server).
import { AsyncLocalStorage } from "node:async_hooks";

export const LOCALE_COOKIE = "memory_locale";
/** A Cookie header longer than this is not parsed (the language falls back to the instance setting). */
export const COOKIE_HEADER_MAX = 8192;

const G = globalThis;
/** The store of this process, created once even if the module is evaluated twice. */
export const requestLocaleScope = (G.__memoryRequestLocale ??= new AsyncLocalStorage());

const EMPTY = Object.freeze({ cookie: null });

/** The language of the memory_locale cookie: the first pair decides; anything but exactly "en" or "ru" is null. */
export function cookieLocale(header) {
  try {
    const raw = Array.isArray(header) ? header.join("; ") : header;
    if (typeof raw !== "string" || raw === "" || raw.length > COOKIE_HEADER_MAX) return null;
    for (const pair of raw.split(";")) {
      const eq = pair.indexOf("=");
      if (eq < 0 || pair.slice(0, eq).trim() !== LOCALE_COOKIE) continue;
      const value = pair.slice(eq + 1).trim();
      return value === "en" || value === "ru" ? value : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** The store of one request: { cookie }, frozen. A request without readable headers gets { cookie: null }. */
export function requestLocaleStore(req) {
  try {
    const cookie = cookieLocale(req?.headers?.cookie);
    return cookie === null ? EMPTY : Object.freeze({ cookie });
  } catch {
    return EMPTY;
  }
}

/** Runs fn (the request handler) inside the request's store; fn's own result and errors pass through unchanged. */
export function runWithRequestLocale(req, fn) {
  return requestLocaleScope.run(requestLocaleStore(req), fn);
}
