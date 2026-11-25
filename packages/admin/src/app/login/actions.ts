"use server";
import { TEXT } from "../../messages/ws-login";
import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { call, GatewayError } from "@/lib/gateway";
import { safeNext } from "@/lib/login-return";
import { clearPreviewCookies, setUserSessionCookie } from "@/lib/user-session";
import { clientHeaders, TEXT as WORKPLACE_LOGIN_TEXT, loginFailureDetail, loginFailureText } from "@/lib/workplace-login";

interface LoginOk { token?: unknown; session?: { expires_at?: string | null } }

const refused = (text: string, detail: string | null): ActionState => failState(text, detail ? { lines: [detail] } : {});

export async function ldapLoginAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const login = String(formData.get("login") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!login || !password) return failState(TEXT.enterYourLoginAndPassword);
  const extra = clientHeaders(await headers());
  let res;
  try {
    res = await call("/api/v1/auth/ldap", { method: "POST", body: { login, password }, headers: extra, timeoutMs: 60_000 });
  } catch (e) {
    if (e instanceof GatewayError) return refused(loginFailureText(e.status, { code: e.code }), loginFailureDetail(e.status, { code: e.code, message: e.message }));
    throw e;
  }
  const ok = res.data as LoginOk | null;
  if (res.status !== 201) {
    const code = (res.data as { code?: unknown } | null)?.code;
    const contact = code === "ldap_not_in_group" ? await supportContact() : null;
    return refused(loginFailureText(res.status, res.data, res.retryAfter, { contact }), loginFailureDetail(res.status, res.data));
  }
  if (typeof ok?.token !== "string" || !/^mem_ses_/.test(ok.token)) return refused(WORKPLACE_LOGIN_TEXT.loginContractError, WORKPLACE_LOGIN_TEXT.loginContractDetail);
  await clearPreviewCookies();
  await setUserSessionCookie(ok.token, ok.session?.expires_at);
  // No redirect() here: after a Server Action it is a client-side navigation, and the next page would be shown inside the
  // document of /login, under its policy. The form opens the already checked path by a full document load (fullLoadTo).
  return okState("", { fullLoadTo: safeNext(String(formData.get("next") ?? "")) ?? "/" });
}

async function supportContact(): Promise<string | null> {
  try {
    const { status, data } = await call("/api/v1/auth/methods", { timeoutMs: 5_000 });
    const c = (data as { support_contact?: unknown } | null)?.support_contact;
    return status === 200 && typeof c === "string" && c.trim() ? c.trim().slice(0, 300) : null;
  } catch (e) {
    unstable_rethrow(e);
    return null;
  }
}
