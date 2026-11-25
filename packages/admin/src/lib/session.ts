import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { call, firstRunNeeded } from "./gateway";
import { decodeSession, isAdminSessionToken, isExpired, panelCookieSecure } from "./session-token";
import { requestIsHttps } from "./user-session";

export const SESSION_COOKIE = "memory_admin_session";
export const PANEL_COOKIE = "memory_panel";
const DEFAULT_TTL_SEC = 8 * 3600;
const PANEL_TTL_SEC = 60 * 60;

export type AdminRole = "memory_admin" | "security_auditor";
export interface Session {
  token: string;
  sessionId?: string;
  login: string;
  role?: AdminRole;
  breakglass?: boolean;
  authMethod?: string;
}

const panelSession = cache(async (token: string): Promise<Session | null> => {
  try {
    const { status, data } = await call("/api/v1/admin-auth/session", { token, timeoutMs: 10_000 });
    const d = data as { session_id?: unknown; login?: unknown; role?: unknown; breakglass?: unknown; auth_method?: unknown } | null;
    if (status !== 200 || !d || typeof d.login !== "string") return null;
    return { token, login: d.login, ...(typeof d.session_id === "string" ? { sessionId: d.session_id } : {}), role: d.role === "security_auditor" ? "security_auditor" : "memory_admin", breakglass: d.breakglass === true,
             ...(typeof d.auth_method === "string" && d.auth_method ? { authMethod: d.auth_method } : {}) };
  } catch {
    return null;
  }
});

export async function readSession(): Promise<Session | null> {
  const jar = await cookies();
  const panel = jar.get(PANEL_COOKIE)?.value;
  if (panel && isAdminSessionToken(panel)) return panelSession(panel);
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const claims = decodeSession(token);
  if (!claims || isExpired(claims)) return null;
  return { token, login: claims.login, role: "memory_admin" };
}

export async function requireSession(): Promise<Session> {
  const s = await readSession();
  if (s) return s;
  const jar = await cookies();
  const hadCookie = jar.has(SESSION_COOKIE) || jar.has(PANEL_COOKIE);
  if (await firstRunNeeded()) redirect("/admin/first-run");
  redirect(hadCookie ? "/admin/login?expired=1" : "/admin/login");
}

export async function setSessionCookie(token: string, ttlSec?: number): Promise<void> {
  const jar = await cookies();
  if (isAdminSessionToken(token)) {
    let secure = true;
    try { secure = panelCookieSecure({ headers: await headers() }); } catch { secure = true; }
    jar.set(PANEL_COOKIE, token, {
      httpOnly: true,
      sameSite: "strict",
      secure,
      path: "/admin",
      maxAge: ttlSec && ttlSec > 0 ? Math.min(Math.floor(ttlSec), PANEL_TTL_SEC) : PANEL_TTL_SEC,
    });
    return;
  }
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: await requestIsHttps(),
    path: "/",
    maxAge: ttlSec && ttlSec > 0 ? Math.floor(ttlSec) : DEFAULT_TTL_SEC,
  });
}

export async function clearSessionCookie(): Promise<void> {
  try {
    const jar = await cookies();
    jar.delete(SESSION_COOKIE);
    jar.delete({ name: PANEL_COOKIE, path: "/admin" });
  } catch { }
}
