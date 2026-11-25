// The consent API of the built-in authorization server for agents: what the workplace's
// consent page /connect/authorize reads and what its decision handler posts. Only the workplace listener (fromWorkplace)
// and only a person's workplace session (requireHuman: no key, no "on behalf of", no panel preview); on the agent address
// and outside the path is closed by the channel gate (AGENT_DENIED_PREFIXES). Outside builtin — the router's 404.
//
//   GET  /api/v1/me/oauth/tx/:id  — the request as the screen shows it; reading binds it to nobody: "Not
//                                   you? Sign out" and "Sign in again" (prompt=login) come back to the same request;
//   POST /api/v1/me/oauth/consent — {tx, csrf, allow}: in one database transaction the deciding person and the request are
//                                   locked, the session must still be live, the CSRF value of the request must match, a
//                                   prompt=login request needs a session newer than itself; then the request is bound to
//                                   this session and decided in one write, and the continuation key c is handed out —
//                                   only here, only to the browser that pressed the button. The same
//                                   session repeating the same decision (double click, "Continue") gets a new c, the old
//                                   one stops working; another session or another decision — 409.
// The CSRF value, the continuation key and the cookie of the request are never logged.
import { randomSecret, sha256 } from "@memory/shared/oauth-as";
import { agentAuthConfig, MemoryError, tx } from "@memory/shared";
import type { Context, Hono } from "hono";
import type { App, Caller, PersonRow } from "../context.ts";
import { fromWorkplace, isHumanSession } from "../workplace.ts";
import { markAgentAuthRoutesServed } from "./readiness.ts";
import { decideTx, lockTx, readTx, rekeyTxContinue, type TxRow } from "./store.ts";
import { builtinState, CONSENT_VERSION, isLoopbackRedirect, returnHost, type BuiltinState } from "./routes-authorize.ts";
import { timingSafeEqual } from "node:crypto";

type Env = { Variables: { caller: Caller } };

/** Request id and CSRF value: 32 bytes in base64url, 43 characters. */
const B64_43 = /^[A-Za-z0-9_-]{43}$/;

/** The answers of the API by code (English: they reach the workplace server, never an agent). */
const ANSWERS = {
  oauth_tx_gone: [404, "The sign-in request has expired or does not exist."],
  oauth_tx_decided: [409, "The sign-in request has already been answered."],
  oauth_fresh_login: [409, "The app asked for a fresh sign-in: sign in again, then answer."],
  oauth_csrf: [403, "The form of the sign-in request does not match it."],
  oauth_person_inactive: [403, "This person cannot approve apps."],
  oauth_session_ended: [401, "The workplace session has ended."],
} as const satisfies Record<string, readonly [number, string]>;
type AnswerCode = keyof typeof ANSWERS;
const answer = (c: Context, code: AnswerCode): Response => c.json({ code, message: ANSWERS[code][1] }, ANSWERS[code][0]);

/** The 403 of a caller that is not a person in the workplace (a key, "on behalf of", a panel preview) — English, like the rest of this API. */
export const CONSENT_HUMAN_ONLY = "Only a person signed in to the workplace can answer an app sign-in request.";

/**
 * Who may use the API here: a person's workplace session on the workplace listener. null — the router's 404. Otherwise
 * the condition of requireHuman (isHumanSession), with this API's own English answer: forbidden, code unchanged.
 */
async function consentCaller(app: App, c: Context<Env>): Promise<Caller | null> {
  const caller = c.get("caller");
  if (!(await fromWorkplace(app, caller.ip))) return null;
  if (!isHumanSession(caller)) throw new MemoryError("forbidden", CONSENT_HUMAN_ONLY, { hint: "Open the sign-in request in the workplace as yourself" });
  return caller;
}

const iso = (d: Date | string): string => new Date(d).toISOString();

/** The host the screen names an app document by: the host of its own address. */
function documentHost(clientId: string): string {
  try { return new URL(clientId).hostname; } catch { return ""; }
}

/** The request as GET /api/v1/me/oauth/tx/:id returns it. */
export function txView(st: BuiltinState, t: TxRow, person: Pick<PersonRow, "display_name" | "login">, o: { connectionDays: number; freshLogin: boolean; decided: "allow" | "deny" | null; now?: number }) {
  const redirectHost = returnHost(t.redirect_uri);
  return {
    issuer: st.issuer,
    client: { id: t.client_id, title: t.client_title, kind: t.client_kind, source: t.client_source, known: t.client_known,
              host: t.client_source === "cimd" ? documentHost(t.client_id) : redirectHost, name: t.client_name },
    redirect_host: redirectHost,
    loopback: isLoopbackRedirect(t.redirect_uri),
    custom_scheme: t.redirect_mode === "custom",
    connection_days: o.connectionDays,
    person: { display_name: person.display_name, login: person.login },
    csrf: t.csrf.toString("base64url"),
    fresh_login_required: o.freshLogin,
    started_seconds_ago: Math.max(0, Math.floor(((o.now ?? Date.now()) - new Date(t.created_at).getTime()) / 1000)),
    expires_at: iso(t.expires_at),
    consent_version: CONSENT_VERSION,
    decided: o.decided,
  };
}

const sameBytes = (a: Buffer | null | undefined, b: Buffer): boolean => !!a && a.length === b.length && timingSafeEqual(a, b);

/**
 * The continuation address of a decided request, the only thing POST /consent answers with. The
 * workplace's decision handler redirects there only after checkContinueUrl (packages/admin/src/lib/agent-consent.ts):
 * the issuer it read itself, exactly /oauth/authorize/continue, the same tx and one c — a contract test
 * holds both sides to this shape.
 */
export const continueUrl = (issuer: string, txId: string, key: string): string => `${issuer}/oauth/authorize/continue?tx=${txId}&c=${key}`;

interface SessionRow { created_at: Date; ended_at: Date | null; expires_at: Date; person_id: string; live: boolean }
const SESSION_SQL = "SELECT created_at, ended_at, expires_at, person_id, (ended_at IS NULL AND expires_at > now()) AS live FROM user_sessions WHERE id = $1 AND instance_id = $2";

/**
 * Register the consent API on the REST router, after authenticate: its handlers read the caller. Marks the
 * consent part of the AS routes as served (readiness routes_missing): without this API every sign-in would stop on the
 * consent screen, so a gateway that lacks it stays "not ready".
 */
export function registerConsentApi(r: Hono<Env>, app: App): void {
  markAgentAuthRoutesServed("consent");
  r.get("/api/v1/me/oauth/tx/:id", async (c, next) => {
    const st = await builtinState(app);
    if (!st) return next();
    const caller = await consentCaller(app, c);
    if (!caller) return next();
    app.limiter.check(caller, "me_keys_view");
    const id = c.req.param("id");
    if (!B64_43.test(id)) return answer(c, "oauth_tx_gone");
    const t = await readTx(app.db.control, app.instanceId, id);
    if (!t || !t.live) return answer(c, "oauth_tx_gone");
    // decided: only the deciding session sees it again (its "Continue" repeats the decision until continue is passed)
    if (t.decision !== null && t.session_id !== caller.keyId) return answer(c, "oauth_tx_decided");
    const s = (await app.db.control.query<SessionRow>(SESSION_SQL, [caller.keyId, app.instanceId])).rows[0];
    // by the reading session; the deciding one is checked again on POST
    const freshLogin = t.prompt_login && (!s || new Date(s.created_at).getTime() <= new Date(t.created_at).getTime());
    return c.json(txView(st, t, caller.person!, { connectionDays: agentAuthConfig(app.settings).connection_days, freshLogin, decided: t.decision }));
  });

  r.post("/api/v1/me/oauth/consent", async (c, next) => {
    const st = await builtinState(app);
    if (!st) return next();
    const caller = await consentCaller(app, c);
    if (!caller) return next();
    app.limiter.check(caller, "me_keys");
    const b = await c.req.json<Record<string, unknown>>().catch(() => null);
    const id = b?.tx, csrf = b?.csrf, allow = b?.allow;
    if (typeof id !== "string" || typeof csrf !== "string" || typeof allow !== "boolean")
      return c.json({ code: "invalid_argument", message: "tx, csrf and allow are required" }, 400);
    if (!B64_43.test(id)) return answer(c, "oauth_tx_gone");
    const provided = B64_43.test(csrf) ? Buffer.from(csrf, "base64url") : Buffer.alloc(0);
    const decision = allow ? "allow" : "deny";
    const personId = caller.person!.id, sessionId = caller.keyId;
    const key = randomSecret();

    const out = await tx(app.db.control, async (q): Promise<AnswerCode | "ok"> => {
      // the person first, then the request: the trigger of 17 [AS] on people (a person switched off) locks in the same order
      const p = (await q.query<{ active: boolean; demo: boolean }>("SELECT active, (attrs->>'demo'='true') AS demo FROM people WHERE id = $1 AND instance_id = $2 FOR UPDATE",
        [personId, app.instanceId])).rows[0];
      if (!p?.active || p.demo) return "oauth_person_inactive";
      const t = await lockTx(q, app.instanceId, id);
      if (!t) return "oauth_tx_gone";
      const s = (await q.query<SessionRow>(SESSION_SQL, [sessionId, app.instanceId])).rows[0];
      if (!s || !s.live || s.person_id !== personId) return "oauth_session_ended";
      if (!sameBytes(t.csrf, provided)) return "oauth_csrf";
      if (t.prompt_login && new Date(s.created_at).getTime() <= new Date(t.created_at).getTime()) return "oauth_fresh_login";
      if (t.decision === null)
        return (await decideTx(q, app.instanceId, id, { person_id: personId, session_id: sessionId, decision, consent_version: CONSENT_VERSION, continue_hash: sha256(key) }))
          ? "ok" : "oauth_tx_decided";
      // the same session repeats the same decision: a new key, the old one stops working
      if (t.session_id === sessionId && t.decision === decision)
        return (await rekeyTxContinue(q, app.instanceId, id, sessionId, decision, sha256(key))) ? "ok" : "oauth_tx_decided";
      return "oauth_tx_decided";
    });
    if (out !== "ok") return answer(c, out);
    return c.json({ continue_url: continueUrl(st.issuer, id, key) });
  });
}
