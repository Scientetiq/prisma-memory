import { ME_API_TEXT } from "../messages/me-api";
import "server-only";
import { redirect } from "next/navigation";
import { call, GatewayError, toGatewayError, type CallInit, type CallResult } from "./gateway";
import { toolErrorMessage } from "./mcp-parse";
import { invalidateNav, methodChanges } from "./nav-cache";
import { clearUserSessionCookie, inServerAction, loginUrl } from "./user-session";

export type MeResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; code: string; message: string; retryAfter?: number; hint?: string; details?: unknown };

const HUMAN = new Set(["rate_limited", "fail_closed", "unauthorized", "gateway_unreachable", "class_denied", "not_found", "response_lost"]);

const failOf = (status: number, code: string, message: string, retryAfter?: number, hint?: string, details?: unknown): Extract<MeResult<never>, { ok: false }> => ({
  ok: false, status, code,
  message: HUMAN.has(code) ? toolErrorMessage({ code, message, retryAfter, details }) : message,
  ...(retryAfter !== undefined ? { retryAfter } : {}),
  ...(hint && !HUMAN.has(code) ? { hint } : {}),
  ...(details !== undefined && details !== null ? { details } : {}),
});

export async function meGw<T>(key: string, path: string, init: Omit<CallInit, "token"> = {}): Promise<MeResult<T>> {
  let res: CallResult;
  try {
    res = await call(path, { ...init, token: key });
  } catch (e) {
    if (e instanceof GatewayError) return failOf(e.status, e.code, e.message);
    throw e;
  } finally {
    if (methodChanges(init.method)) invalidateNav(key);
  }
  if (res.status === 401) {
    if (await inServerAction()) return failOf(401, "unauthorized", ME_API_TEXT.unauthorized);
    await clearUserSessionCookie();
    redirect(await loginUrl({ expired: true }));
  }
  if (res.status >= 400) {
    const err = toGatewayError(res.status, res.data);
    const body = res.data as { retry_after?: unknown; hint?: unknown } | null;
    const retryAfter = res.retryAfter ?? (typeof body?.retry_after === "number" ? body.retry_after : undefined);
    const code = res.status === 503 && !err.code.startsWith("ldap_") && err.code !== "internal" ? "fail_closed" : res.status === 429 ? "rate_limited" : err.code;
    return failOf(err.status, code, err.message, retryAfter, typeof body?.hint === "string" && body.hint ? body.hint : undefined, err.details);
  }
  return { ok: true, status: res.status, data: res.data as T };
}
