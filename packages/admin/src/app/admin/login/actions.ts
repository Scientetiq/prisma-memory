"use server";
import { TEXT } from "../../../messages/panel-login";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { failState, type ActionState } from "@/lib/action-state";
import { call, GatewayError, toGatewayError } from "@/lib/gateway";
import { clearSessionCookie, readSession, setSessionCookie } from "@/lib/session";
import { panelCookieSecure } from "@/lib/session-token";
import { clientHeaders } from "@/lib/workplace-login";
import { lockMinutes, OTP_INPUT_MAX, OTP_TEXT, serverTimeText, type LocalLoginState } from "./second-factor";

const PANEL_STATE_COOKIE = "memory_panel_state";
const STATE_PATH = "/admin/login/callback";

export async function loginAction(_prev: ActionState, formData: FormData): Promise<LocalLoginState> {
  const login = String(formData.get("login") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  // the form is on the code step when it carries the field `otp`; only then the code goes to the gateway, so an
  // account without a second factor sends today's body {login, password} byte for byte. The password never enters the state
  const codeStep = formData.has("otp");
  const otp = String(formData.get("otp") ?? "").trim();
  const fail = (message: string, extra: Partial<LocalLoginState> = {}): LocalLoginState =>
    // i18n-ignore: otp is a form-state code, not display text.
    codeStep || extra.otp ? failState(message, { otp: "retry", login, ...extra }) : failState(message, extra);
  if (!login || !password) return fail(TEXT.enterYourLoginAndPassword);
  if (codeStep && !otp) return fail(OTP_TEXT.empty);
  if (otp.length > OTP_INPUT_MAX) return fail(OTP_TEXT.invalid);

  let res: { status: number; data: unknown; retryAfter?: number };
  try {
    res = await call("/api/v1/admin-login", { method: "POST", body: codeStep ? { login, password, otp } : { login, password }, headers: clientHeaders(await headers()) });
  } catch (e) {
    return fail(e instanceof GatewayError ? e.message : TEXT.theGatewayIsNotResponding);
  }
  const d = (res.data ?? {}) as { reason?: unknown; server_time?: unknown; retry_after?: unknown };
  // the gateway asks for the code only after a correct password; a refused code tells what to check and the server's time
  if (res.status === 401 && d.reason === "otp_required") return fail(OTP_TEXT.required, { otp: "required", lines: [OTP_TEXT.requiredHint] });
  if (res.status === 401 && d.reason === "bad_code") {
    const at = serverTimeText(d.server_time);
    return fail(OTP_TEXT.bad, { otp: "retry", lines: [OTP_TEXT.badHint, ...(at ? [OTP_TEXT.serverTime(at)] : [])] });
  }
  if (res.status === 429 && d.reason === "factor_locked") return fail(OTP_TEXT.locked(lockMinutes(d.retry_after, res.retryAfter)), { otp: "retry", lines: [OTP_TEXT.lockedHint] });
  if (res.status === 400 && d.reason === "otp_invalid") return fail(OTP_TEXT.invalid, { otp: "retry" });
  if (res.status === 401) return fail(TEXT.incorrectLoginOrPassword);
  if (res.status >= 400) return fail(toGatewayError(res.status, res.data).message);

  const body = (res.data ?? {}) as { session?: unknown; expires_in?: unknown };
  if (typeof body.session !== "string" || !/^mem_(adm|as)_/.test(body.session)) return fail(TEXT.theGatewayReturnedAnUnexpectedSignIn);
  await setSessionCookie(body.session, typeof body.expires_in === "number" ? body.expires_in : undefined);
  redirect("/admin");
}

export async function ssoStartAction(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  const h = await headers();
  let res: { status: number; data: unknown };
  try {
    res = await call("/api/v1/admin-auth/sso/start", { method: "POST", body: { client_ip: clientHeaders(h)["X-Memory-Client-Ip"] ?? "" }, headers: clientHeaders(h), timeoutMs: 30_000 });
  } catch (e) {
    return failState(e instanceof GatewayError && e.status !== 404 ? e.message : TEXT.companySignInToThePanelIs2);
  }
  if (res.status === 404) return failState(TEXT.companySignInToThePanelIs);
  if (res.status === 429) return failState(TEXT.tooManySignInAttemptsWaitA);
  if (res.status !== 200) return failState(res.status === 503 ? TEXT.keycloakIsNotRespondingSignInIs : toGatewayError(res.status, res.data).message);
  const d = (res.data ?? {}) as { authorization_url?: unknown; state?: unknown };
  const url = typeof d.authorization_url === "string" ? d.authorization_url : "";
  if (!/^https?:\/\//.test(url) || typeof d.state !== "string" || !d.state) return failState(TEXT.theGatewayReturnedAnUnexpectedResponseWhen);
  (await cookies()).set(PANEL_STATE_COOKIE, d.state, { httpOnly: true, sameSite: "lax", secure: panelCookieSecure({ headers: h }), path: STATE_PATH, maxAge: 600 });
  redirect(url);
}

export type CallbackResult =
  | { kind: "webauthn"; tx: string; options: unknown }
  | { kind: "error"; message: string };

async function finish(res: { status: number; data: unknown }): Promise<CallbackResult> {
  const d = (res.data ?? {}) as { step?: unknown; session?: unknown; expires_at?: unknown; tx?: unknown; options?: unknown; code?: unknown; message?: unknown };
  if (res.status === 200 && d.step === "session" && typeof d.session === "string" && d.session.startsWith("mem_as_")) {
    const left = typeof d.expires_at === "string" ? Math.floor((Date.parse(d.expires_at) - Date.now()) / 1000) : undefined;
    await setSessionCookie(d.session, left && left > 0 ? left : undefined);
    redirect("/admin");
  }
  if (res.status === 200 && d.step === "webauthn" && typeof d.tx === "string" && d.options && typeof d.options === "object") return { kind: "webauthn", tx: d.tx, options: d.options };
  if (res.status === 503) return { kind: "error", message: typeof d.message === "string" ? d.message : TEXT.signInIsUnavailableTryAgainIn };
  return { kind: "error", message: typeof d.message === "string" && d.message ? d.message : TEXT.signInDidNotCompleteStartAgain };
}

export async function ssoCallbackAction(q: { state?: string; code?: string; iss?: string; error?: string }): Promise<CallbackResult> {
  const jar = await cookies();
  const cookieState = jar.get(PANEL_STATE_COOKIE)?.value ?? "";
  jar.delete({ name: PANEL_STATE_COOKIE, path: STATE_PATH });
  const h = await headers();
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max + 1) : undefined);
  const body = { state: text(q.state, 512) ?? "", cookie_state: cookieState.slice(0, 513), client_ip: clientHeaders(h)["X-Memory-Client-Ip"] ?? "",
                 ...(q.code ? { code: text(q.code, 4096) } : {}), ...(q.iss ? { iss: text(q.iss, 512) } : {}), ...(q.error ? { error: text(q.error, 256) } : {}) };
  try {
    return await finish(await call("/api/v1/admin-auth/sso/callback", { method: "POST", body, headers: clientHeaders(h), timeoutMs: 60_000 }));
  } catch (e) {
    if (e instanceof GatewayError) return { kind: "error", message: e.status === 404 ? TEXT.companySignInToThePanelIs3 : e.message };
    throw e;
  }
}

export async function webauthnAssertAction(tx: string, credential: unknown): Promise<CallbackResult> {
  if (typeof tx !== "string" || !tx || tx.length > 128 || !credential || typeof credential !== "object") return { kind: "error", message: TEXT.signInDidNotCompleteStartAgain2 };
  const h = await headers();
  try {
    return await finish(await call("/api/v1/admin-auth/webauthn/assert", { method: "POST", body: { tx, credential, client_ip: clientHeaders(h)["X-Memory-Client-Ip"] ?? "" },
                                                                         headers: clientHeaders(h), timeoutMs: 30_000 }));
  } catch (e) {
    if (e instanceof GatewayError) return { kind: "error", message: e.message };
    throw e;
  }
}

export async function logoutAction(): Promise<void> {
  const s = await readSession();
  if (s) {
    const path = s.token.startsWith("mem_as_") ? "/api/v1/admin-auth/logout" : "/api/v1/admin/logout";
    try { await call(path, { method: "POST", token: s.token, timeoutMs: 10_000 }); }
    catch (e) { if (!(e instanceof GatewayError)) throw e; }
  }
  await clearSessionCookie();
  redirect("/admin/login");
}
