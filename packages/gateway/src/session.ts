import { createHmac, scrypt, timingSafeEqual } from "node:crypto";
import { FailureWindow } from "./failure-window.ts";
import type { App } from "./context.ts";

export const SESSION_TTL_SEC = 8 * 3600;
export const SESSION_CLOCK_SKEW_SEC = 60;
export interface AdminSession {
  login: string; iat: number; iatMs: number;
  /** Second factor that opened the session: present only on a token issued after a TOTP or recovery code. */
  sf?: SessionFactor;
}
/** Second factor of a local administrator's session (admin_sessions.second_factor, claim `sf` of mem_adm_). */
export type SessionFactor = "totp" | "recovery";

const sessionKey = (app: { appSecret: string }) => createHmac("sha256", app.appSecret).update("memory-admin-session").digest();
export function signSession(app: { appSecret: string }, login: string, now = Date.now(), sf?: SessionFactor): string {
  const iat = Math.floor(now / 1000);
  // sf only when a factor was used: a token without one keeps the four claims and their earlier order
  const claims = { login, iat, iat_ms: Math.floor(now), exp: iat + SESSION_TTL_SEC, ...(sf ? { sf } : {}) };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `mem_adm_${body}.${createHmac("sha256", sessionKey(app)).update(body).digest("base64url")}`;
}
export function verifySession(app: { appSecret: string }, bearer: string, now = Date.now()): AdminSession | null {
  if (!bearer.startsWith("mem_adm_")) return null;
  const [body, mac] = bearer.slice(8).split(".");
  if (!body || !mac) return null;
  const want = createHmac("sha256", sessionKey(app)).update(body).digest(), got = Buffer.from(mac, "base64url");
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  let p: { login?: unknown; iat?: unknown; iat_ms?: unknown; exp?: unknown; sf?: unknown };
  try { p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  if (typeof p.login !== "string" || typeof p.exp !== "number" || !Number.isFinite(p.exp) || p.exp <= now / 1000) return null;
  if (p.iat !== undefined && (typeof p.iat !== "number" || !Number.isFinite(p.iat))) return null;
  const iat = typeof p.iat === "number" ? p.iat : p.exp - SESSION_TTL_SEC;
  if (iat > now / 1000 + SESSION_CLOCK_SKEW_SEC || !(p.exp > iat) || p.exp - iat > SESSION_TTL_SEC) return null;
  const iatMs = typeof p.iat_ms === "number" && Math.floor(p.iat_ms / 1000) === iat ? p.iat_ms : iat * 1000;
  // sf: only the two known values count; anything else is "no factor" and never rejects a token signed by us
  const sf = p.sf === "totp" || p.sf === "recovery" ? p.sf : null;
  return { login: p.login, iat, iatMs, ...(sf ? { sf } : {}) };
}

export const sessionAlive = (s: Pick<AdminSession, "iatMs">, revokedAt: Date | string | null): boolean =>
  !revokedAt || new Date(revokedAt).getTime() <= s.iatMs;

const DUMMY = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
export async function verifyAdminPasswordAsync(plain: string, stored: string | null): Promise<boolean> {
  const [scheme, N, r, p, salt, hash] = (stored ?? DUMMY).split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64");
  const got = await new Promise<Buffer>((resolve, reject) =>
    scrypt(plain, Buffer.from(salt, "base64"), want.length, { N: Number(N), r: Number(r), p: Number(p) }, (e, key) => (e ? reject(e) : resolve(key))));
  return stored !== null && want.length === got.length && timingSafeEqual(want, got);
}

export class LoginFailures {
  private readonly w: FailureWindow;
  constructor(private readonly byIp = 5, private readonly byLogin = 20, windowMs = 15 * 60_000) { this.w = new FailureWindow(windowMs); }
  private keys(login: string, ip: string): [string, number][] { return [[`a:${ip}`, this.byIp], [`l:${login}`, this.byLogin]]; }
  retryAfter(login: string, ip: string): number { return this.w.retryAfter(this.keys(login, ip)); }
  reserve(login: string, ip: string): ReturnType<FailureWindow["reserve"]> { return this.w.reserve(this.keys(login, ip)); }
  record(login: string, ip: string): void { this.w.record(this.keys(login, ip).map(([k]) => k)); }
  clear(login: string, ip: string): void { this.w.clear(this.keys(login, ip).map(([k]) => k)); }
  inFlight(ip: string): number { return this.w.inFlight(`a:${ip}`); }
}
export const loginFailures = new LoginFailures();
