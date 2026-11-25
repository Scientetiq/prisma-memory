import { NextResponse, type NextRequest } from "next/server";
import { call, GatewayError } from "@/lib/gateway";
import { OIDC_NEXT_COOKIE, safeNext, WAS_IN_COOKIE, wasInCookieOptions } from "@/lib/login-return";
import { PREVIEW_COOKIE, PREVIEW_KEY_COOKIE, sessionCookieOptions, USER_COOKIE } from "@/lib/user-session";
import { clientHeaders, cookieSecure, OIDC_COOKIE_PATH, OIDC_STATE_COOKIE, oidcCallbackBody, sameOidcState } from "@/lib/workplace-login";

export const dynamic = "force-dynamic";

function go(location: string, secure: boolean): NextResponse {
  const out = new NextResponse(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } });
  out.cookies.set(OIDC_STATE_COOKIE, "", { httpOnly: true, sameSite: "lax", secure, path: OIDC_COOKIE_PATH, maxAge: 0 });
  out.cookies.set(OIDC_NEXT_COOKIE, "", { httpOnly: true, sameSite: "lax", secure, path: OIDC_COOKIE_PATH, maxAge: 0 });
  return out;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const secure = cookieSecure(req);
  const next = safeNext(req.cookies.get(OIDC_NEXT_COOKIE)?.value);
  const toLogin = (code: string): NextResponse => go(`/login?sso_error=${encodeURIComponent(code)}${next ? `&next=${encodeURIComponent(next)}` : ""}`, secure);
  const body = oidcCallbackBody(req.nextUrl.searchParams, req.cookies.get(OIDC_STATE_COOKIE)?.value);
  const headers = clientHeaders(req.headers);
  let res;
  try {
    res = await call("/api/v1/auth/oidc/callback", { method: "POST", body, headers, timeoutMs: 60_000 });
  } catch (e) {
    if (e instanceof GatewayError) return toLogin(e.code);
    throw e;
  }
  const d = (res.data ?? {}) as { token?: unknown; session?: { expires_at?: string | null }; code?: unknown };
  const code = typeof d.code === "string" ? d.code : "";
  if (code === "oidc_provider_error" && body.error === "access_denied") return toLogin("oidc_cancelled");
  if (res.status !== 201) return toLogin(code || "oidc_unavailable");
  if (typeof d.token !== "string" || !/^mem_ses_/.test(d.token)) return toLogin("contract");
  if (!sameOidcState(body.state ?? "", body.cookie_state)) {
    console.warn("oidc_callback_state_mismatch");
    return toLogin("oidc_state_invalid");
  }
  const out = go(next ?? "/", secure);
  out.cookies.set(USER_COOKIE, d.token, sessionCookieOptions(d.session?.expires_at, undefined, secure));
  out.cookies.set(WAS_IN_COOKIE, "1", wasInCookieOptions(secure));
  out.cookies.set(PREVIEW_COOKIE, "", { path: "/", maxAge: 0 });
  out.cookies.set(PREVIEW_KEY_COOKIE, "", { path: "/", maxAge: 0 });
  return out;
}
