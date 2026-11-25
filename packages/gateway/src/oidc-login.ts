import { identityProviders } from "./identity.ts";
import { timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import {
  authorizationRequest, checkProvider, log, MemoryError, newId, OIDC_FAILURE_TEXT, OIDC_LOGIN_TTL_SEC, oidcConfig, OidcFailure,
  oidcProblems, ProviderCache, ssoGroupNearMisses, tx,
  type DirectoryPerson, type OidcConfig, type OidcFailureCode, type PendingLogin, type SsoPerson,
} from "@memory/shared";
import type { App, PersonRow } from "./context.ts";
import { audit } from "./audit.ts";
import { personCols, workplaceClientAddress } from "./auth.ts";
import { poolBusy } from "./control-lock.ts";
import { healthState } from "./health.ts";
import { canonicalGuid, chooseCard, LINK_REFUSAL_TEXT, linkPerson, matchCard, sessionCallerOf, sockAddr } from "./ldap-login.ts";
import { createSession } from "./user-sessions.ts";
import { fromWorkplace } from "./workplace.ts";
import { LOGIN_POLICY_CHANGED, oidcPolicyPrint, underLoginPolicy } from "./login-policy.ts";

export const providers = new ProviderCache();

export class PendingLogins {
  private items = new Map<string, { nonce: string; verifier: string; redirect_uri: string; at: number; fresh?: boolean; started_at?: number }>();
  constructor(private readonly ttlMs = OIDC_LOGIN_TTL_SEC * 1000, private readonly max = 100_000) {}
  put(p: PendingLogin, now = Date.now()): void {
    for (const [k, v] of this.items) {
      if (now - v.at >= this.ttlMs || this.items.size >= this.max) this.items.delete(k);
      else break;
    }
    this.items.set(p.state, { nonce: p.nonce, verifier: p.verifier, redirect_uri: p.redirect_uri, at: now,
                              ...(p.fresh ? { fresh: true, started_at: p.started_at ?? now } : {}) });
  }
  take(state: string, now = Date.now()): { nonce: string; verifier: string; redirect_uri: string; fresh?: boolean; started_at?: number } | null {
    const v = this.items.get(state);
    if (!v) return null;
    this.items.delete(state);
    return now - v.at < this.ttlMs
      ? { nonce: v.nonce, verifier: v.verifier, redirect_uri: v.redirect_uri, ...(v.fresh ? { fresh: true, started_at: v.started_at } : {}) }
      : null;
  }
  get size(): number { return this.items.size; }
}
export const pendingLogins = new PendingLogins();

export const CALLBACK_CAPS = { state: 200, cookie_state: 200, code: 2048, iss: 500, error: 100 } as const;

export const OIDC_ROUTE_CEILING = 1200;

export function sameState(fromUrl: string, fromCookie: string): boolean {
  const a = Buffer.from(fromUrl, "utf8"), b = Buffer.from(fromCookie, "utf8");
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

const statusOf = (code: OidcFailureCode): 400 | 401 | 403 | 429 | 503 =>
  code === "oidc_state_invalid" || code === "oidc_request_invalid" ? 400
    : code === "oidc_code_invalid" || code === "oidc_token_invalid" || code === "oidc_provider_error" ? 401
      : code === "oidc_claim_invalid" ? 403 : code === "oidc_rate_limited" ? 429 : 503;

function providerErrorText(error: string): string {
  if (error === "access_denied") return "Sign-in was canceled at the identity provider. Start again if you canceled by mistake";
  if (error === "login_required" || error === "interaction_required") return "The identity provider requires a new sign-in. Start sign-in again";
  if (error === "temporarily_unavailable" || error === "server_error") return "The identity provider is temporarily unable to complete sign-in. Try again in a few minutes";
  return `${OIDC_FAILURE_TEXT.oidc_provider_error} (${error}). Tell the memory administrator`;
}
const oneLine = (v: unknown, max = 200): string => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);

export const OIDC_FRESH_SKEW_MS = 60_000;
export function oidcAuthTime(v: unknown, now = Date.now()): Date | null {
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) return null;
  const ms = v * 1000;
  return ms < Date.UTC(2000, 0, 1) || ms > now + 300_000 ? null : new Date(ms);
}

async function subjectMismatch(app: App, dp: DirectoryPerson, trust: boolean, ext: string): Promise<{ owner: string; to: string | null } | null> {
  const owner = (await app.db.control.query("SELECT person_id FROM person_identities WHERE system = 'sso' AND external_id = $1", [ext])).rows[0]?.person_id as string | undefined;
  const guid = canonicalGuid(dp.guid);
  if (!owner || !guid) return null;
  const choice = chooseCard(await matchCard(app.db.control, app.instanceId, { ...dp, guid }), trust);
  if (choice.kind !== "card") return null;
  const to = choice.card?.id ?? null;
  return to === owner ? null : { owner, to };
}

type SubjectNote = { kind: "ok"; subChanged: boolean } | { kind: "conflict"; owner: string };

async function noteSubject(app: App, personId: string, issuer: string, sub: string): Promise<SubjectNote> {
  const ext = `${issuer}#${sub}`, prefix = `${issuer}#`;
  return tx(app.db.control, async (q): Promise<SubjectNote> => {
    const prev = (await q.query("SELECT person_id FROM person_identities WHERE system = 'sso' AND external_id = $1 FOR UPDATE", [ext])).rows[0];
    if (prev && prev.person_id !== personId) return { kind: "conflict", owner: String(prev.person_id) };
    const older = (await q.query(
      "SELECT count(*)::int AS n FROM person_identities WHERE system = 'sso' AND person_id = $1 AND active AND left(external_id, length($2)) = $2 AND external_id <> $3",
      [personId, prefix, ext])).rows[0].n as number;
    const put = await q.query(`INSERT INTO person_identities (system, external_id, person_id, verified, verified_label, source, active) VALUES ('sso', $1, $2, false, 'oidc', 'oidc_login', true)
                               ON CONFLICT (system, external_id) DO UPDATE SET active = true WHERE person_identities.person_id = EXCLUDED.person_id`, [ext, personId]);
    if (!put.rowCount) {
      const now = (await q.query("SELECT person_id FROM person_identities WHERE system = 'sso' AND external_id = $1", [ext])).rows[0];
      return { kind: "conflict", owner: String(now?.person_id ?? "") };
    }
    await q.query("UPDATE person_identities SET active = false WHERE system = 'sso' AND person_id = $1 AND active AND left(external_id, length($2)) = $2 AND external_id <> $3",
                  [personId, prefix, ext]);
    return { kind: "ok", subChanged: older > 0 };
  });
}

type RejectStatus = 400 | 401 | 403 | 409 | 429 | 503;
type Route = "start" | "callback";

export function registerOidcLogin(r: Hono<any>, app: App, remoteOf: (c: Context) => string | null): void {
  const reject = async (c: Context, ip: string | null, status: RejectStatus, code: string, message: string, result: string,
                        extra: Record<string, unknown> = {}, reply: Record<string, unknown> = {}) => {
    await audit(app, null, { event_type: status === 429 ? "rate_limited" : "auth_failure", details: { reason: "oidc_login", result, ...extra }, ip });
    return c.json({ code, message, ...reply }, status);
  };
  const failed = (c: Context, ip: string | null, stage: string, e: unknown) => {
    const f = e instanceof OidcFailure ? e : new OidcFailure("oidc_unreachable", oneLine((e as Error)?.message ?? e, 500));
    log.warn("oidc_login_failed", { stage, code: f.code, detail: f.detail });
    const message = f.code === "oidc_provider_error" ? providerErrorText(f.detail.split(":")[0] ?? "") : f.message;
    return reject(c, ip, statusOf(f.code), f.code, message, f.code, { stage });
  };
  const limitedReply = async (c: Context, ip: string | null, route: Route, scope: "address" | "all", hit: { retryAfter: number; firstRefusal: boolean }) => {
    const wait = Math.max(1, Math.ceil(hit.retryAfter));
    c.header("Retry-After", String(wait));
    if (!hit.firstRefusal) return c.json({ code: "oidc_rate_limited", message: OIDC_FAILURE_TEXT.oidc_rate_limited, retry_after: wait }, 429);
    if (scope === "all") log.warn("oidc_login_ceiling", { stage: route, retry_after: wait });
    return reject(c, ip, 429, "oidc_rate_limited", OIDC_FAILURE_TEXT.oidc_rate_limited, "rate_limited", { stage: route, ...(scope === "all" ? { scope } : {}) }, { retry_after: wait });
  };
  const overloaded = async (c: Context, ip: string | null, stage: string, busy: MemoryError, extra: Record<string, unknown>) => {
    if (extra.session_id !== undefined)
      await audit(app, null, { event_type: "auth_failure", details: { reason: "oidc_login", result: "overloaded", stage, ...extra }, ip });
    c.header("Retry-After", String(busy.extra.retry_after ?? 5));
    return c.json(busy.body(), busy.status as 409);
  };
  const internal = (c: Context, ip: string | null, stage: string, e: unknown, extra: Record<string, unknown> = {}) => {
    const busy = poolBusy(e);
    if (busy) return overloaded(c, ip, stage, busy, extra);
    log.error("oidc_login_internal", { stage, error: oneLine((e as Error)?.message ?? e, 500), stack: String((e as Error)?.stack ?? "").slice(0, 4000), ...extra });
    return reject(c, ip, 503, "oidc_internal", OIDC_FAILURE_TEXT.oidc_internal, "oidc_internal", { stage, ...extra });
  };

  async function gate(c: Context, route: Route): Promise<{ ip: string | null; cfg: OidcConfig } | Response> {
    const sock = sockAddr(remoteOf(c));
    if (!(await fromWorkplace(app, sock))) {
      const refuse = () => c.json({ code: "forbidden", message: "Sign-in through the identity provider is accepted only from the workspace server" }, 403);
      if (app.limiter.takeAnonymous("oidc_not_workplace", sock ?? "?", 1)) return refuse();
      await audit(app, null, { event_type: "auth_failure", details: { reason: "oidc_login", result: "not_workplace", stage: route }, ip: sock });
      return refuse();
    }
    const ip = await workplaceClientAddress(app, (n) => c.req.header(n), sock);
    const perAddress = app.limiter.takeAnonymous(`oidc_${route}`, ip ?? "?");
    if (perAddress) return limitedReply(c, ip, route, "address", perAddress);
    const total = app.limiter.takeAnonymous(`oidc_${route}_all`, "*", OIDC_ROUTE_CEILING);
    if (total) return limitedReply(c, ip, route, "all", total);
    if ((await healthState(app)).status === "fail_closed")
      return reject(c, ip, 503, "forbidden", "The installation is not serving requests (fail-closed): see /api/v1/health", "fail_closed", { stage: route });
    const cfg = identityProviders.get("oidc").config(app.settings);
    if (!cfg.enabled) return reject(c, ip, 503, "oidc_disabled", OIDC_FAILURE_TEXT.oidc_disabled, "oidc_disabled", { stage: route });
    const problems = oidcProblems(cfg);
    if (problems.length) {
      log.warn("oidc_login_failed", { stage: route, code: "oidc_not_configured", detail: problems.map((p) => `${p.key}: ${p.message}`).join("; ") });
      return reject(c, ip, 503, "oidc_not_configured", OIDC_FAILURE_TEXT.oidc_not_configured, "oidc_not_configured", { stage: route });
    }
    return { ip, cfg };
  }
  const gated = async (c: Context, route: Route) => {
    try { return await gate(c, route); } catch (e) { return internal(c, sockAddr(remoteOf(c)), route, e); }
  };

  r.post("/api/v1/auth/oidc/start", async (c) => {
    const g = await gated(c, "start");
    if (g instanceof Response) return g;
    const sb = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (sb !== null && (typeof sb !== "object" || Array.isArray(sb) || Object.keys(sb).some((k) => k !== "fresh") || (sb.fresh !== undefined && typeof sb.fresh !== "boolean")))
      return reject(c, g.ip, 400, "invalid_argument", "To start sign-in, use {fresh?: true|false} as the request body", "start_body_invalid", { stage: "start" });
    try {
      const d = await providers.discovery(g.cfg);
      const { url, pending } = authorizationRequest(g.cfg, d, { fresh: sb?.fresh === true });
      pendingLogins.put(pending);
      return c.json({ authorization_url: url, state: pending.state, expires_in: OIDC_LOGIN_TTL_SEC });
    } catch (e) {
      return failed(c, g.ip, "start", e);
    }
  });

  r.post("/api/v1/auth/oidc/callback", async (c) => {
    const g = await gated(c, "callback");
    if (g instanceof Response) return g;
    const { ip, cfg } = g;
    const b = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const text = (k: string): string => (typeof b?.[k] === "string" ? b[k] as string : "");
    const q = { state: text("state"), cookie_state: text("cookie_state"), code: text("code"), iss: text("iss"), error: text("error") };
    let person: SsoPerson, stage = "request", authTime: Date | null = null;
    try {
      const long = (Object.keys(CALLBACK_CAPS) as Array<keyof typeof CALLBACK_CAPS>).filter((k) => q[k].length > CALLBACK_CAPS[k]);
      if (long.length) throw new OidcFailure("oidc_request_invalid", `over the length limit: ${long.join(", ")}`);
      stage = "state";
      const pending = q.state ? pendingLogins.take(q.state) : null;
      if (!pending) throw new OidcFailure("oidc_state_invalid", "state is unknown, expired or already used");
      stage = "browser";
      if (!sameState(q.state, q.cookie_state))
        throw new OidcFailure("oidc_state_invalid", q.cookie_state ? "state does not match the browser cookie" : "the browser has no state cookie: the response returned to a different browser from the one that started sign-in");
      stage = "callback";
      if (q.error) {
        const code = /^[a-z_]{1,40}$/.test(q.error) ? q.error : "error";
        throw new OidcFailure("oidc_provider_error", `${code}: ${oneLine(b?.error_description, 200)}`);
      }
      if (q.iss && q.iss !== cfg.issuer) throw new OidcFailure("oidc_token_invalid", `iss in the authorization response is “${oneLine(q.iss)}”, expected “${cfg.issuer}”`);
      if (!q.code) throw new OidcFailure("oidc_code_invalid", "the authorization response has no code");
      const d = await providers.discovery(cfg);
      if (d.iss_parameter && !q.iss) throw new OidcFailure("oidc_token_invalid", "the provider declares iss in the authorization response, but it is missing");
      stage = "token";
      const tokens = await identityProviders.get("oidc").login.exchangeCode(cfg, d, q.code, pending, providers.transport);
      let claims = await identityProviders.get("oidc").login.verifyIdToken(cfg, d, tokens.idToken, pending.nonce, providers);
      if (claims[cfg.claims.guid] === undefined && tokens.accessToken) claims = { ...(await identityProviders.get("oidc").login.fetchUserinfo(cfg, d, tokens.accessToken, String(claims.sub), providers.transport)), ...claims };
      stage = "claims";
      authTime = oidcAuthTime(claims.auth_time);
      if (pending.fresh && (!authTime || authTime.getTime() < (pending.started_at ?? 0) - OIDC_FRESH_SKEW_MS))
        throw new OidcFailure("oidc_token_invalid", authTime ? "fresh sign-in: auth_time precedes the start of sign-in. The identity provider did not ask for the password again" : "fresh sign-in: the ID token is missing auth_time");
      person = identityProviders.get("oidc").identity(cfg, claims).person;
      if (!person.guid) throw new OidcFailure("oidc_claim_missing", `claim ${cfg.claims.guid} is missing from both the ID token and userinfo. Check the client’s LDAP_ID mapper`);
      if (person.invalidClaims.length) throw new OidcFailure("oidc_claim_invalid", `invalid characters in claims: ${person.invalidClaims.join(", ")}`);
    } catch (e) {
      return failed(c, ip, stage, e);
    }

    const account = person.username ?? person.mail ?? person.sub;
    if (!person.matchedGroups.length) {
      const nearMisses = ssoGroupNearMisses(person.groups, cfg.login_groups);
      log[nearMisses.length ? "warn" : "info"]("oidc_login_not_in_group", {
        account, groups: person.groups.length, received: person.groups.slice(0, 20).map((x) => oneLine(x, 100)), near_misses: nearMisses });
      return reject(c, ip, 403, "oidc_not_in_group", "The company account is outside the memory access group. Contact the memory administrator", "not_in_group", { login: account });
    }

    let sessionId: string | null = null;
    stage = "link";
    try {
      const dp: DirectoryPerson = { dn: `oidc:${person.sub}`, account: person.username, guid: person.guid!, mail: person.mail, name: person.name, department: person.department,
                                    employeeId: person.employeeId, groups: person.groups, matchedGroups: person.matchedGroups, givenName: person.givenName ?? null };
      const subjectConflict = (owner: string, to: string | null) => {
        log.warn("oidc_sub_conflict", { account, sub_owner: owner, person: to });
        return reject(c, ip, 409, "person_conflict", "The identity provider account is already linked to another profile in memory. Sign-in was denied. Contact the memory administrator",
                      "sub_guid_mismatch", { login: account, sub_owner: owner, person: to });
      };
      const early = await subjectMismatch(app, dp, person.mailVerified, `${cfg.issuer}#${person.sub}`);
      if (early) return await subjectConflict(early.owner, early.to);
      const linked = await linkPerson(app, dp, { trustMail: person.mailVerified, via: "oidc" });
      if (linked.kind === "no_mail") return await reject(c, ip, 403, "oidc_no_mail", "The company account has no e-mail address, which memory uses as the login. Contact the directory administrator", "no_mail", { login: account });
      if (linked.kind === "untrusted_mail")
        return await reject(c, ip, 403, "oidc_email_unverified", "The identity provider does not confirm your e-mail address, which memory needs to create your profile. Sign in once with your company account (AD) or contact the memory administrator", "email_unverified", { login: account });
      if (linked.kind === "bad_guid") return await failed(c, ip, "link", new OidcFailure("oidc_claim_invalid", `${cfg.claims.guid}: not a GUID`));
      if (linked.kind === "conflict") {
        log.warn("oidc_login_conflict", { account, reason: linked.reason, candidates: linked.candidates });
        return await reject(c, ip, 409, "person_conflict", LINK_REFUSAL_TEXT[linked.reason], "conflict", { login: account, conflict: linked.reason, candidates: linked.candidates });
      }
      if (linked.kind === "guid_unconfirmed")
        return await reject(c, ip, 409, "guid_link_unconfirmed", LINK_REFUSAL_TEXT.guid_unconfirmed, "guid_link_unconfirmed", { login: account, person: linked.personId, link: linked.state });
      if (linked.kind === "inactive") return await reject(c, ip, 403, "person_inactive", "The profile in memory is inactive. Contact the memory administrator", "person_inactive", { person: linked.personId });

      stage = "subject";
      const note = await noteSubject(app, linked.personId, cfg.issuer, person.sub);
      if (note.kind === "conflict") return await subjectConflict(note.owner, linked.personId);
      if (note.subChanged) log.warn("oidc_sub_changed", { account, person: linked.personId });
      stage = "session";
      const row: PersonRow = (await app.db.control.query(`SELECT ${personCols()} FROM people WHERE id = $1`, [linked.personId])).rows[0];
      sessionId = newId();
      const pre = sessionCallerOf(row, sessionId, ip, new Date().toISOString());
      if (linked.created) await audit(app, pre, { event_type: "admin", details: { op: "person_created", person: row.id, source: "oidc" } });
      if (linked.renamedFrom) await audit(app, pre, { event_type: "admin", details: { op: "person_login_changed", person: row.id, from: linked.renamedFrom, to: row.login, source: "oidc" } });
      try {
        await audit(app, pre, { event_type: "admin", details: { op: "login", source: "oidc", session_id: sessionId, matched_by: linked.matchedBy, ...(note.subChanged ? { sub_changed: true } : {}) }, ip }, { strict: true });
      } catch {
        sessionId = null;
        return await reject(c, ip, 503, "oidc_internal", "The audit log is unavailable, so sign-in was not completed. Try again later", "audit_unavailable", { stage: "audit" });
      }
      const issued = await underLoginPolicy(app, (st) => oidcPolicyPrint(oidcConfig(st)), oidcPolicyPrint(cfg),
        (q) => createSession(app, row.id, "oidc", { id: sessionId!, ip, userAgent: c.req.header("x-memory-client-ua") ?? null, q, authTime }));
      if (!issued.ok) {
        log.info("oidc_login_policy_changed", { account, person: row.id });
        return await reject(c, ip, 503, "login_policy_changed", LOGIN_POLICY_CHANGED, "config_changed", { login: account, session_id: sessionId });
      }
      const s = issued.value;
      if (!authTime) log.info("oidc_no_auth_time", { person: row.id, session: s.id });
      log.info("oidc_login", { account, person: row.id, session: s.id, created: linked.created, matched_by: linked.matchedBy, sub_changed: note.subChanged });
      return c.json({ token: s.token, session: { id: s.id, expires_at: s.expires_at, source: s.source }, person: { id: row.id, login: row.login, created: linked.created } }, 201);
    } catch (e) {
      return internal(c, ip, stage, e, sessionId ? { session_id: sessionId } : {});
    }
  });
}

type AdminAudit = (c: Context<any>, op: string, details?: Record<string, unknown>) => Promise<void>;

export function registerOidcAdmin(r: Hono<any>, app: App, adminAudit: AdminAudit): void {
  r.post("/oidc/check", async (c) => {
    const cfg = identityProviders.get("oidc").config(app.settings);
    providers.clear();
    const res = await checkProvider(cfg, providers.transport);
    const failedSteps = res.steps.filter((s) => s.status === "fail");
    await adminAudit(c, "oidc_check", { ok: res.ok, failed: failedSteps.map((s) => s.code ?? s.step), failed_steps: failedSteps.map((s) => s.step) });
    return c.json({ ...res, enabled: cfg.enabled });
  });
}
