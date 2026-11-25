// "Not you? Sign out" and "Sign in again" of the agent consent screen: the same as leaving the
// workplace (`logoutAction`: the gateway ends this session, the session cookie and the "was signed in" mark are cleared),
// then 303 to the sign-in page with the return path of the request. The request itself does not change — reading does not
// bind it to anyone, so whoever signs in next (the same person or another one) reads and decides it as usual; their new
// session is newer than the request, which satisfies an app's `prompt=login`. A live single sign-on session of the
// company may let them in without a password — an accepted limitation. Only from the workplace's own pages.
import { NextResponse, type NextRequest } from "next/server";
import { call, GatewayError } from "@/lib/gateway";
import { consentPath, consentRefusal, isTxId } from "@/lib/agent-consent";
import { loginHref, WAS_IN_COOKIE } from "@/lib/login-return";
import { hasPreviewCookies, isSessionToken, USER_COOKIE } from "@/lib/user-session";
import { cookieSecure, fromOwnPages } from "@/lib/workplace-login";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  if (!fromOwnPages(req)) return consentRefusal(403, "failed");
  // a panel preview has no form here; its own exit is in the preview bar, not this handler
  if (await hasPreviewCookies()) return consentRefusal(403, "preview");
  const form = await req.formData().catch(() => null);
  const raw = form?.get("tx");
  const tx = typeof raw === "string" && isTxId(raw) ? raw : null;
  const token = req.cookies.get(USER_COOKIE)?.value;
  if (token && isSessionToken(token)) {
    try {
      await call("/api/v1/auth/logout", { method: "POST", token, timeoutMs: 15_000 });
    } catch (e) {
      // the gateway is down or the session is already dead: signing out still happens here (the cookie is cleared)
      if (!(e instanceof GatewayError)) throw e;
    }
  }
  const secure = cookieSecure(req);
  const out = new NextResponse(null, { status: 303, headers: { Location: loginHref({ next: tx ? consentPath(tx) : null }), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  out.cookies.set(USER_COOKIE, "", { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: 0 });
  out.cookies.set(WAS_IN_COOKIE, "", { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: 0 });
  return out;
}
