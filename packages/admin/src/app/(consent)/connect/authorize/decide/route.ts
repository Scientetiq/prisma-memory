// "Allow" / "Deny" of the agent consent screen: a route handler, not a Server
// Action — it checks the form came from the workplace's own pages and answers with an explicit 303 that works without
// JavaScript. Order:
//  1. `fromOwnPages` (Sec-Fetch-Site same-origin, or Origin equal to the workplace address) — otherwise 403;
//  2. a workplace session that is not a panel preview — none: the sign-in page with the return path of this request;
//  3. the issuer, read by this handler from the server (`GET /api/v1/me/connections/config` → `agent_auth.issuer`) — never
//     from the form or the browser's headers;
//  4. `POST /api/v1/me/oauth/consent {tx, csrf, allow}` — the gateway binds the request to this session, checks the CSRF
//     value and answers `{continue_url}`; the same session repeating the same decision gets a new continuation key;
//  5. `continue_url` must be https (or loopback development), exactly `<issuer>/oauth/authorize/continue?tx=<this>&c=…` —
//     then 303 there; any other answer is a 502 without a redirect.
// Neither the continuation key nor the CSRF value is logged.
import { NextResponse, type NextRequest } from "next/server";
import { call, GatewayError, type CallResult } from "@/lib/gateway";
import { checkContinueUrl, CONNECT_CONFIG_PATH, CONSENT_API_PATH, consentPath, consentRefusal, isCsrf, isTxId, parseDecision } from "@/lib/agent-consent";
import { loginHref } from "@/lib/login-return";
import { readUserSession, USER_COOKIE } from "@/lib/user-session";
import { cookieSecure, fromOwnPages } from "@/lib/workplace-login";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } as const;
const see = (location: string): NextResponse => new NextResponse(null, { status: 303, headers: { Location: location, ...NO_STORE } });
const field = (form: FormData | null, name: string): string => { const v = form?.get(name); return typeof v === "string" ? v : ""; };
const codeOf = (r: CallResult): string => { const c = (r.data as { code?: unknown } | null)?.code; return typeof c === "string" ? c : ""; };

/** The session ended between showing the screen and pressing the button: sign in again and come back to this request. */
function toLogin(req: NextRequest, tx: string): NextResponse {
  const out = see(loginHref({ expired: true, next: consentPath(tx) }));
  out.cookies.set(USER_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: cookieSecure(req), path: "/", maxAge: 0 });
  return out;
}

/** The issuer of the built-in sign-in as the server side knows it; null — off, not ready or not readable. */
async function serverIssuer(token: string): Promise<{ issuer: string } | { status: number }> {
  let r: CallResult;
  try { r = await call(CONNECT_CONFIG_PATH, { token, timeoutMs: 15_000 }); } catch (e) {
    if (e instanceof GatewayError) return { status: 502 };
    throw e;
  }
  if (r.status === 401) return { status: 401 };
  const a = (r.data as { agent_auth?: { mode?: unknown; ready?: unknown; issuer?: unknown } } | null)?.agent_auth;
  if (r.status !== 200 || !a || a.mode !== "builtin" || a.ready !== true || typeof a.issuer !== "string") return { status: 502 };
  return { issuer: a.issuer };
}

export async function POST(req: NextRequest): Promise<Response> {
  if (!fromOwnPages(req)) return consentRefusal(403, "failed");
  const form = await req.formData().catch(() => null);
  const tx = field(form, "tx"), csrf = field(form, "csrf"), decision = parseDecision(field(form, "decision"));
  if (!isTxId(tx)) return consentRefusal(400, "gone");
  if (!isCsrf(csrf) || !decision) return consentRefusal(400, "failed");

  const session = await readUserSession();
  if (!session) return see(loginHref({ expired: true, next: consentPath(tx) }));
  if (session.preview) return consentRefusal(403, "preview");

  const iss = await serverIssuer(session.key);
  if ("status" in iss) return iss.status === 401 ? toLogin(req, tx) : consentRefusal(502, "failed");

  let r: CallResult;
  try {
    r = await call(CONSENT_API_PATH, { method: "POST", token: session.key, body: { tx, csrf, allow: decision === "allow" }, timeoutMs: 30_000 });
  } catch (e) {
    if (e instanceof GatewayError) return consentRefusal(502, "failed");
    throw e;
  }
  if (r.status === 401) return toLogin(req, tx);
  const code = codeOf(r);
  // the app asked for a fresh sign-in and this session is older than the request: the screen offers "Sign in again"
  if (r.status === 409 && code === "oauth_fresh_login") return see(consentPath(tx));
  if (r.status === 409) return consentRefusal(409, "decided");
  if (r.status === 404) return consentRefusal(404, "gone");
  if (r.status === 400 || r.status === 403 || r.status === 429) return consentRefusal(r.status, "failed");
  if (r.status !== 200) return consentRefusal(502, "failed");

  const target = checkContinueUrl((r.data as { continue_url?: unknown } | null)?.continue_url, iss.issuer, tx);
  if (!target) {
    // the address itself carries the continuation key: only the fact goes to the log
    console.warn("agent_consent_continue_url_refused: the gateway answered a continuation address outside the issuer — no redirect");
    return consentRefusal(502, "failed");
  }
  return see(target);
}
