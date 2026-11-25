"use server";

import { headers } from "next/headers";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { call, GatewayError } from "@/lib/gateway";
import { safeNext } from "@/lib/login-return";
import { clearPreviewCookies, setUserSessionCookie } from "@/lib/user-session";
import { clientHeaders, TEXT, loginFailureDetail, loginFailureText } from "@/lib/workplace-login";
import { LOCAL_SIGNIN } from "../../messages/local-signin";

interface LoginOk { token?: unknown; session?: { expires_at?: string | null } }
interface LoginFailure { code?: unknown; reason?: unknown; retry_after?: unknown }

function loginFailure(status: number, code: unknown, retryAfter?: number): ActionState {
  const body = { code };
  const detail = loginFailureDetail(status, body);
  return failState(loginFailureText(status, body, retryAfter), detail ? { lines: [detail] } : {});
}

export async function localLoginAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const login = String(formData.get("login") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!login || !password) return failState(LOCAL_SIGNIN.enterBoth);

  const extra = clientHeaders(await headers());
  let res;
  try {
    res = await call("/api/v1/auth/local", { method: "POST", body: { login, password }, headers: extra, timeoutMs: 60_000 });
  } catch (e) {
    if (e instanceof GatewayError) return loginFailure(e.status, e.code);
    throw e;
  }

  const body = res.data as LoginFailure | null;
  if (res.status === 401) return failState(LOCAL_SIGNIN.invalid);
  if (res.status === 400) return failState(LOCAL_SIGNIN.badRequest);
  if (res.status === 404) return failState(LOCAL_SIGNIN.off);
  if (res.status === 429) {
    if (body?.reason === "in_flight") return failState(LOCAL_SIGNIN.inFlight);
    if (body?.reason === "busy") return failState(LOCAL_SIGNIN.busy);
    const seconds = typeof body?.retry_after === "number" ? body.retry_after : res.retryAfter ?? 0;
    return failState(LOCAL_SIGNIN.limited(Math.max(1, Math.ceil(seconds / 60))));
  }
  if (res.status !== 201) return loginFailure(res.status, body?.code, res.retryAfter);

  const ok = res.data as LoginOk | null;
  if (typeof ok?.token !== "string" || !ok.token.startsWith("mem_ses_")) {
    return failState(TEXT.loginContractError, { lines: [TEXT.loginContractDetail] });
  }
  await clearPreviewCookies();
  await setUserSessionCookie(ok.token, ok.session?.expires_at);
  // No redirect() here: after a Server Action it is a client-side navigation, and the next page would be shown inside the
  // document of /login, under its policy. The form opens the already checked path by a full document load (fullLoadTo).
  return okState("", { fullLoadTo: safeNext(String(formData.get("next") ?? "")) ?? "/" });
}
