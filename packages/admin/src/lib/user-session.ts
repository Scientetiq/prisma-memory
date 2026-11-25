import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getMe } from "./me-call";
import { failState, type ActionResult } from "./action-state";
import { loginHref, PATH_HEADER, safeNext, SESSION_PLAIN, WAS_IN_COOKIE, wasInCookieOptions } from "./login-return";
import { isHttpsRequest, publicUrlIsHttps } from "./workplace-login";

export const USER_COOKIE = "memory_user_session";
export const PREVIEW_COOKIE = "memory_preview";
export const PREVIEW_KEY_COOKIE = "memory_preview_key";
const DEFAULT_TTL_SEC = 7 * 24 * 3600;

export type PreviewRole = "employee" | "head";
export interface PreviewInfo { key_id: string; login: string; persona: string; role: PreviewRole }
export interface UserSession { key: string; preview: PreviewInfo | null }

export const isPersonalKey = (key: string): boolean => /^mem_(p|x)_[A-Za-z0-9_-]{8,}$/.test(key) && !/\s/.test(key);

export const isSessionToken = (token: string): boolean => /^mem_ses_[a-z2-7]{52}$/.test(token);

function parsePreview(raw: string | undefined): PreviewInfo | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as PreviewInfo;
    if (p && typeof p.key_id === "string" && typeof p.login === "string" && typeof p.persona === "string" && (p.role === "employee" || p.role === "head")) return p;
  } catch { }
  return null;
}

export const PREVIEW_RESET_PATH = "/auth/preview-reset";

export type PreviewCheck = "ok" | "forged" | "expired" | "unavailable";
export const checkPreviewKey = async (key: string, login: string): Promise<PreviewCheck> => {
  return (await verifyPreviewKey(key, login)).status;
};

type PreviewVerification =
  | { status: "ok"; keyId: string | null }
  | { status: Exclude<PreviewCheck, "ok"> };

const verifyPreviewKey = cache(async (key: string, login: string): Promise<PreviewVerification> => {
  const me = await getMe(key);
  if (!me.ok) return { status: me.code === "unauthorized" ? "expired" : "unavailable" };
  const previewKey = me.data.key;
  if (previewKey?.preview !== true || me.data.person?.login?.toLowerCase() !== login.toLowerCase()) {
    return { status: "forged" };
  }
  const id = previewKey.id;
  return { status: "ok", keyId: typeof id === "string" && id.length > 0 ? id : null };
});

async function previewCookies(): Promise<{ key: string; preview: PreviewInfo } | null> {
  const jar = await cookies();
  const preview = parsePreview(jar.get(PREVIEW_COOKIE)?.value);
  const previewKey = jar.get(PREVIEW_KEY_COOKIE)?.value;
  return preview && previewKey && isPersonalKey(previewKey) ? { key: previewKey, preview } : null;
}

export async function hasPreviewCookies(): Promise<boolean> {
  const jar = await cookies();
  return jar.has(PREVIEW_COOKIE) || jar.has(PREVIEW_KEY_COOKIE);
}

export async function previewExit(): Promise<{ revokeKeyId: string | null } | null> {
  if (!(await hasPreviewCookies())) return null;
  const pv = await previewCookies();
  if (!pv) return { revokeKeyId: null };
  const verification = await verifyPreviewKey(pv.key, pv.preview.login);
  return { revokeKeyId: verification.status === "ok" ? verification.keyId ?? pv.preview.key_id : null };
}

export async function readUserSession(): Promise<UserSession | null> {
  const pv = await previewCookies();
  if (pv) return (await checkPreviewKey(pv.key, pv.preview.login)) === "ok" ? pv : null;
  const token = (await cookies()).get(USER_COOKIE)?.value;
  if (!token || !isSessionToken(token)) return null;
  return { key: token, preview: null };
}

export const PREVIEW_UNAVAILABLE_PATH = "/admin/preview?unavailable=1";

async function previewRedirectPath(): Promise<string | null> {
  const pv = await previewCookies();
  const check = pv ? await checkPreviewKey(pv.key, pv.preview.login) : null;
  if (check === "forged") return PREVIEW_RESET_PATH;
  if (check === "unavailable") return PREVIEW_UNAVAILABLE_PATH;
  return (await hasPreviewCookies()) ? "/admin/preview?expired=1" : null;
}

export async function requireUserSession(): Promise<UserSession> {
  const s = await readUserSession();
  if (s) return s;
  const to = await previewRedirectPath();
  if (to) redirect(to);
  const jar = await cookies();
  redirect(await loginUrl({ expired: jar.has(USER_COOKIE) || jar.has(WAS_IN_COOKIE) }));
}

export async function returnPath(): Promise<string | null> {
  try { return safeNext((await headers()).get(PATH_HEADER)); } catch { return null; }
}

export async function loginUrl(o: { expired?: boolean } = {}): Promise<string> {
  return loginHref({ expired: o.expired, next: await returnPath() });
}

export async function inServerAction(): Promise<boolean> {
  try { return (await headers()).has("next-action"); } catch { return false; }
}

export async function sessionEndedState(): Promise<ActionResult> {
  return failState(SESSION_PLAIN.ended, { link: { href: await loginUrl({ expired: true }), label: SESSION_PLAIN.login } });
}

export async function actionSession(): Promise<UserSession | ActionResult> {
  const s = await readUserSession();
  if (s) return s;
  const to = await previewRedirectPath();
  if (to) redirect(to);
  return sessionEndedState();
}

export async function requestIsHttps(): Promise<boolean> {
  let https = false;
  try { https = isHttpsRequest({ headers: await headers() }); } catch { https = false; }
  // an https public address (MEMORY_PUBLIC_URL) makes the cookie Secure even when the proxy sends no X-Forwarded-Proto
  return https || publicUrlIsHttps();
}

export async function setUserSessionCookie(token: string, sessionExpiresAt: string | null | undefined, ttlSec = DEFAULT_TTL_SEC): Promise<void> {
  const jar = await cookies(), secure = await requestIsHttps();
  jar.set(USER_COOKIE, token, sessionCookieOptions(sessionExpiresAt, ttlSec, secure));
  jar.set(WAS_IN_COOKIE, "1", wasInCookieOptions(secure));
}

export async function clearWasInCookie(): Promise<void> {
  try { (await cookies()).delete(WAS_IN_COOKIE); } catch { }
}

export function sessionCookieOptions(sessionExpiresAt: string | null | undefined, ttlSec = DEFAULT_TTL_SEC, secure = false) {
  return { httpOnly: true, sameSite: "lax" as const, secure, path: "/", maxAge: sessionMaxAge(sessionExpiresAt, ttlSec) };
}

export function sessionMaxAge(sessionExpiresAt: string | null | undefined, ttlSec = DEFAULT_TTL_SEC): number {
  let maxAge = ttlSec;
  if (sessionExpiresAt) {
    const left = Math.floor((Date.parse(sessionExpiresAt) - Date.now()) / 1000);
    if (Number.isFinite(left)) maxAge = Math.min(maxAge, left);
  }
  return Math.max(60, maxAge);
}

export async function setPreviewCookies(key: string, info: PreviewInfo, maxAge: number): Promise<void> {
  const jar = await cookies();
  const opts = { httpOnly: true, sameSite: "lax" as const, secure: await requestIsHttps(), path: "/", maxAge: Math.max(60, maxAge) };
  jar.set(PREVIEW_KEY_COOKIE, key, opts);
  jar.set(PREVIEW_COOKIE, JSON.stringify(info), opts);
}

export async function clearPreviewCookies(): Promise<void> {
  try {
    const jar = await cookies();
    jar.delete(PREVIEW_KEY_COOKIE);
    jar.delete(PREVIEW_COOKIE);
  } catch { }
}

export async function clearUserSessionCookie(): Promise<void> {
  try {
    const jar = await cookies();
    jar.delete(USER_COOKIE);
    jar.delete(PREVIEW_KEY_COOKIE);
    jar.delete(PREVIEW_COOKIE);
  } catch { }
}
