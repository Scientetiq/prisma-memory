import { NextResponse, type NextRequest } from "next/server";
import { call, GatewayError } from "@/lib/gateway";
import { OIDC_NEXT_COOKIE, safeNext } from "@/lib/login-return";
import { clientHeaders, cookieSecure, OIDC_COOKIE_PATH, OIDC_STATE_COOKIE, startHostRedirect } from "@/lib/workplace-login";

export const dynamic = "force-dynamic";

const toLogin = (code: string, next: string | null): NextResponse =>
  new NextResponse(null, { status: 303, headers: { Location: `/login?sso_error=${encodeURIComponent(code)}${next ? `&next=${encodeURIComponent(next)}` : ""}`, "Cache-Control": "no-store" } });

export async function GET(req: NextRequest): Promise<NextResponse> {
  const next = safeNext(req.nextUrl.searchParams.get("next"));
  const fresh = req.nextUrl.searchParams.get("fresh") === "1";
  const headers = clientHeaders(req.headers);
  let res;
  try {
    res = await call("/api/v1/auth/oidc/start", { method: "POST", body: fresh ? { fresh: true } : {}, headers, timeoutMs: 30_000 });
  } catch (e) {
    if (e instanceof GatewayError) return toLogin(e.code, next);
    throw e;
  }
  const d = (res.data ?? {}) as { authorization_url?: unknown; state?: unknown; expires_in?: unknown; code?: unknown };
  if (res.status !== 200) return toLogin(typeof d.code === "string" ? d.code : "oidc_unavailable", next);
  const url = typeof d.authorization_url === "string" ? d.authorization_url : "";
  if (!/^https:\/\//.test(url) || typeof d.state !== "string" || !d.state) return toLogin("contract", next);
  const hop = req.nextUrl.searchParams.has("h") ? null : startHostRedirect(url, req, next);
  if (hop) return new NextResponse(null, { status: 303, headers: { Location: fresh ? `${hop}&fresh=1` : hop, "Cache-Control": "no-store" } });
  const out = new NextResponse(null, { status: 303, headers: { Location: url, "Cache-Control": "no-store" } });
  const cookie = { httpOnly: true, sameSite: "lax" as const, secure: cookieSecure(req), path: OIDC_COOKIE_PATH, maxAge: Math.min(600, Number(d.expires_in) || 600) };
  out.cookies.set(OIDC_STATE_COOKIE, d.state, cookie);
  out.cookies.set(OIDC_NEXT_COOKIE, next ?? "", next ? cookie : { ...cookie, maxAge: 0 });
  return out;
}
