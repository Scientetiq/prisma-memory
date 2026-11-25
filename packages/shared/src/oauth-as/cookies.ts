// OAuth authorization-server module of the gateway: the sign-in transaction cookie. Differs from the edge's module:
// own cookie name TX_COOKIE = "__Host-mat"; no session cookie (the workplace session is the browser's sign-in);
// a parity test pins the rest
//
// Cookie of the built-in sign-in transaction on the agent address: a fixed name with the __Host- prefix, Secure, HttpOnly,
// SameSite=Lax, Path=/, no Domain (a browser accepts it neither from a sibling host nor over HTTP). The cookie carries only a
// random base64url secret (43 characters); the database keeps its SHA-256. Lax, not Strict: the app opens /oauth/authorize by
// a cross-site navigation, and the browser returns to /oauth/authorize/continue by a navigation from the workplace.

export const TX_COOKIE = "__Host-mat";

/** Cookie secret: 32 bytes in base64url without "=". */
export const COOKIE_SECRET = /^[A-Za-z0-9_-]{43}$/;

/** Set-Cookie of a sign-in cookie: HTTPS only, no script access, path /, Lax. */
export function hostCookie(name: string, value: string, maxAgeSec: number): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`;
}

/** Set-Cookie that makes the browser delete the cookie (same attributes, max age 0). */
export function clearCookie(name: string): string {
  return hostCookie(name, "", 0);
}

/**
 * Cookie value by name from the header. A repeated name gives null: a browser sends two cookies with one name only if one
 * of them was not set by this host, and neither is trusted.
 */
export function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  let found: string | null = null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      if (found !== null) return null;
      found = part.slice(eq + 1).trim();
    }
  }
  return found;
}

/** Secret from the cookie if it has the shape (43 base64url characters); otherwise null. */
export function cookieSecret(header: string | null, name: string): string | null {
  const v = cookieValue(header, name);
  return v !== null && COOKIE_SECRET.test(v) ? v : null;
}
