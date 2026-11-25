import { cookieSecure } from "./workplace-login";

export interface SessionClaims { login: string; exp: number }

export function decodeSession(token: string): SessionClaims | null {
  if (!token.startsWith("mem_adm_")) return null;
  const [body, signature, extra] = token.slice(8).split(".", 3);
  if (!body || !signature || extra !== undefined) return null;
  try {
    const p: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (p && typeof p === "object" && typeof (p as SessionClaims).login === "string" && typeof (p as SessionClaims).exp === "number") {
      return { login: (p as SessionClaims).login, exp: (p as SessionClaims).exp };
    }
  } catch { }
  return null;
}

export function isExpired(claims: SessionClaims, nowMs: number = Date.now()): boolean {
  return claims.exp * 1000 <= nowMs;
}

export const isAdminSessionToken = (token: string): boolean => /^mem_as_[a-z2-7]{52}$/.test(token);

type RequestLike = { url?: string; headers: { get(name: string): string | null } };

/**
 * `Secure` flag of the panel cookies: the workplace rule (cookieSecure: an HTTPS request or an https MEMORY_PUBLIC_URL);
 * otherwise a loopback Host is Secure in a production build only, and an empty Host is always Secure.
 */
export function panelCookieSecure(req: RequestLike, nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  if (cookieSecure(req)) return true;
  const host = (req.headers.get("host") ?? "").trim().toLowerCase();
  if (!host) return true;
  const name = host === "::1" ? host : host.replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");
  if (name === "localhost" || name === "127.0.0.1" || name === "::1") return nodeEnv === "production";
  return false;
}
