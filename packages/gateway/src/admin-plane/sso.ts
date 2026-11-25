import { isIP } from "node:net";
import { Hono, type Context } from "hono";
import {
  assertionOptions, authorizationRequest, ChallengeStore, exchangeCode, fetchUserinfo, log, newChallenge, OIDC_LOGIN_TTL_SEC, oidcConfig, OidcFailure,
  oidcProblems, panelUrlProblem, raiseAlert, ssoPerson, verifyIdToken, type AdminRole, type AuthMethod, type OidcConfig, type PendingLogin, type Settings,
} from "@memory/shared";
import type { App } from "../context.ts";
import { audit } from "../audit.ts";
import { baseUrlOf } from "../auth.ts";
import { bareAddress } from "../channel.ts";
import { providers, sameState } from "../oidc-login.ts";
import { remoteOf } from "../rest.ts";
import { fromWorkplace } from "../workplace.ts";
import { ADMIN_LOGIN_TEXT, adminGroupSetting, resolveAdmin } from "./admin-identity.ts";
import { adminDb, adminPlaneConfigured } from "./db.ts";
import { adminClientIp } from "./middleware.ts";
import { adminSessionCaller, createAdminSession, revokeAdminSessions } from "./session.ts";
import { adminNow } from "./test-clock.ts";
import { checkAssertion, counterSnapshot, usableCredentials, webauthnProblems, webauthnSettings } from "./webauthn-routes.ts";

export const ADMIN_CALLBACK_PATH = "/admin/login/callback";

export const ADMIN_CALLBACK_CAPS = { state: 512, cookie_state: 512, code: 4096, iss: 512, error: 256 } as const;

export const LOGIN_FAILURE_SERIES = { count: 5, windowMs: 15 * 60_000 } as const;

export const ADMIN_SSO_LIMITS = { perAddress: 30, ceiling: 120 } as const;

type SettingsReader = Pick<Settings, "get">;

export function adminOidcConfig(app: { settings: SettingsReader }): OidcConfig {
  const base = oidcConfig(app.settings);
  const text = (k: string): string => { const v = app.settings.get<unknown>(k, ""); return typeof v === "string" ? v.trim() : ""; };
  const secret = app.settings.get<unknown>("admin.oidc_client_secret", "");
  return { ...base, enabled: app.settings.get<unknown>("admin.sso_login_enabled", false) === true, client_id: text("admin.oidc_client_id"),
           client_secret: typeof secret === "string" ? secret : "", redirect_uri: text("admin.oidc_redirect_uri"), login_groups: [] };
}

export function adminOidcProblems(cfg: OidcConfig): string[] {
  const out = oidcProblems({ ...cfg, enabled: false, redirect_uri: "", login_groups: [] })
    .map((p) => `${p.key === "client_id" ? "admin.oidc_client_id" : `oidc.${p.key}`}: ${p.message}`);
  if (!cfg.issuer) out.push("oidc.issuer: the issuer address of the identity provider is required");
  if (!cfg.client_id) out.push("admin.oidc_client_id: the admin panel’s client at the identity provider is required");
  if (!cfg.client_secret) out.push("admin.oidc_client_secret: the admin panel’s client secret is required");
  if (!cfg.redirect_uri) out.push(`admin.oidc_redirect_uri: a redirect URI is required (https://example.com${ADMIN_CALLBACK_PATH})`);
  else {
    const bad = panelUrlProblem(cfg.redirect_uri, true);
    if (bad) out.push(`admin.oidc_redirect_uri: ${bad}`);
    else if (new URL(cfg.redirect_uri).pathname !== ADMIN_CALLBACK_PATH) out.push(`admin.oidc_redirect_uri: the path must be ${ADMIN_CALLBACK_PATH}`);
  }
  return out;
}

export function adminSsoReady(app: { settings: SettingsReader }): { ok: true; cfg: OidcConfig } | { ok: false; problems: string[] } {
  const cfg = adminOidcConfig(app);
  if (!cfg.enabled) return { ok: false, problems: ["admin.sso_login_enabled = false"] };
  const problems = adminOidcProblems(cfg);
  const group = adminGroupSetting(app).problem;
  if (group) problems.push(group);
  return problems.length ? { ok: false, problems } : { ok: true, cfg };
}

export function adminLoginProblems(s: SettingsReader): string[] {
  const ready = adminSsoReady({ settings: s });
  return [...(ready.ok ? [] : ready.problems), ...webauthnProblems(webauthnSettings({ settings: s }))];
}

export class AdminPendingLogins {
  private items = new Map<string, { p: PendingLogin; at: number }>();
  constructor(private readonly ttlMs: number, private readonly max: number) {}
  put(p: PendingLogin, now = Date.now()): boolean {
    for (const [k, v] of this.items) {
      if (now - v.at >= this.ttlMs) this.items.delete(k);
      else break;
    }
    if (this.items.size >= this.max) return false;
    this.items.set(p.state, { p, at: now });
    return true;
  }
  take(state: string, now = Date.now()): PendingLogin | null {
    const v = this.items.get(state);
    if (!v) return null;
    this.items.delete(state);
    return now - v.at < this.ttlMs ? v.p : null;
  }
  get size(): number { return this.items.size; }
  clear(): void { this.items.clear(); }
}
export const pendingAdminLogins = new AdminPendingLogins(OIDC_LOGIN_TTL_SEC * 1000, 10_000);

interface LoginChallenge { personId: string; login: string; guid: string; role: AdminRole; ip: string | null; challenge: Buffer; counters: Map<string, number> }
export const loginChallenges = new ChallengeStore<LoginChallenge>(5 * 60_000, 10_000);

const failures = new Map<string, number[]>();
const FAILURE_KEYS_MAX = 50_000;
const FAILURE_MARKS_MAX = 50;

export async function noteLoginFailure(app: App, login: string | null, ip: string | null, now = Date.now()): Promise<void> {
  const keys = [login ? `login:${login.toLowerCase()}` : null, ip ? `ip:${ip}` : null].filter((x): x is string => x !== null);
  if (failures.size >= FAILURE_KEYS_MAX)
    for (const [k, v] of failures) if (!v.some((t) => now - t < LOGIN_FAILURE_SERIES.windowMs)) failures.delete(k);
  for (const k of keys) {
    if (!failures.has(k) && failures.size >= FAILURE_KEYS_MAX) {
      log.warn("admin_login_failures_full", { keys: failures.size });
      continue;
    }
    const list = (failures.get(k) ?? []).filter((t) => now - t < LOGIN_FAILURE_SERIES.windowMs).slice(-(FAILURE_MARKS_MAX - 1));
    list.push(now);
    failures.set(k, list);
    if (list.length !== LOGIN_FAILURE_SERIES.count) continue;
    const byLogin = k.startsWith("login:");
    await raiseAlert({ control: app.db.control, audit: app.db.audit }, {
      instanceId: app.instanceId, level: "high", code: "admin_login_failures",
      summary: byLogin ? `${list.length} failed administrator sign-in attempts for ${login} in 15 minutes` : `${list.length} failed administrator sign-in attempts from ${ip} in 15 minutes`,
      details: { login: byLogin ? login : null, ip: byLogin ? null : ip, count: list.length },
      dedupeKey: `admin_login_failures:${k}:${Math.floor(now / LOGIN_FAILURE_SERIES.windowMs)}` });
  }
}
export function resetAdminSsoForTests(): void { failures.clear(); loginChallenges.clear(); pendingAdminLogins.clear(); }
export const failureKeysForTests = (): number => failures.size;

const hinted = (c: Context): boolean => Object.keys(c.req.header()).some((h) => h.toLowerCase().startsWith("x-memory-client-"));

async function browserIp(app: App, c: Context, bodyIp: unknown): Promise<string | null> {
  if (!hinted(c) && typeof bodyIp === "string" && bodyIp.length <= 64 && isIP(bodyIp.trim()) && await fromWorkplace(app, remoteOf(c)))
    return bareAddress(bodyIp.trim());
  return adminClientIp(app, c);
}

const bodyOf = async (c: Context): Promise<Record<string, unknown>> => {
  const b = await c.req.json().catch(() => null) as unknown;
  return b && typeof b === "object" && !Array.isArray(b) ? b as Record<string, unknown> : {};
};
const oneLine = (v: unknown, max = 200): string => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
const NOT_FOUND = { code: "not_found", message: "Not found" } as const;
const RESTART = "Sign-in through the identity provider did not complete. Start again";
const TOO_MANY = { code: "rate_limited", message: "Too many sign-in attempts; wait a minute" } as const;

function overLimit(app: App, c: Context, route: "start" | "callback" | "assert", ip: string | null): Response | null {
  const perAddress = app.limiter?.takeAnonymous(`admin_sso_${route}`, ip ?? "?", ADMIN_SSO_LIMITS.perAddress);
  const hit = perAddress ? { r: perAddress, scope: "address" } : (() => {
    const total = app.limiter?.takeAnonymous(`admin_sso_${route}_all`, "*", ADMIN_SSO_LIMITS.ceiling);
    return total ? { r: total, scope: "all" } : null;
  })();
  if (!hit) return null;
  if (hit.r.firstRefusal) log.warn("admin_sso_rate_limited", { route, scope: hit.scope });
  c.header("Retry-After", String(Math.max(1, Math.ceil(hit.r.retryAfter))));
  return c.json(TOO_MANY, 429);
}

async function breakglassOpenNow(app: App): Promise<boolean> {
  if (!adminPlaneConfigured(app)) return false;
  const r = await adminDb(app).query(
    "SELECT 1 FROM breakglass_windows WHERE instance_id = $1 AND closed_at IS NULL AND expires_at > $2 LIMIT 1", [app.instanceId, adminNow()]);
  return (r.rowCount ?? 0) > 0;
}

async function windowEnd(app: App, windowId: string): Promise<Date | null> {
  const r = await adminDb(app).query("SELECT expires_at FROM breakglass_windows WHERE id = $1 AND instance_id = $2", [windowId, app.instanceId]);
  const x = r.rows[0] as { expires_at?: Date | string } | undefined;
  return x?.expires_at ? new Date(x.expires_at) : null;
}

async function refuse(app: App, c: Context, o: { ip: string | null; login: string | null; reason: string; status: 401 | 403 | 503; code: string; message: string;
                                                 extra?: Record<string, unknown>; count?: boolean }): Promise<Response> {
  await audit(app, null, { event_type: "auth_failure", ip: o.ip, details: { reason: o.reason, login: o.login, ...(o.extra ?? {}) } });
  if (o.count !== false) await noteLoginFailure(app, o.login, o.ip);
  return c.json({ code: o.code, message: o.message }, o.status);
}

function protocolFailure(app: App, c: Context, ip: string | null, stage: string, e: unknown): Promise<Response> {
  const f = e instanceof OidcFailure ? e : new OidcFailure("oidc_unreachable", oneLine((e as Error)?.message ?? e, 300));
  log.warn("admin_sso_failed", { stage, code: f.code, detail: oneLine(f.detail, 300) });
  const down = f.code === "oidc_unreachable" || f.code === "oidc_discovery_invalid" || f.code === "oidc_internal";
  return refuse(app, c, { ip, login: null, reason: "admin_sso_failed", status: down ? 503 : 401, code: down ? "internal" : "admin_login_denied",
                          message: down ? "The identity provider is not responding. Administrator sign-in is temporarily unavailable" : RESTART,
                          extra: { stage, code: f.code }, count: !down });
}

async function issue(app: App, c: Context, o: { personId: string; login: string; role: AdminRole; ip: string | null; method: AuthMethod; uv: boolean;
                                                breakglassWindowId: string | null }): Promise<Response> {
  if (!o.ip) return refuse(app, c, { ip: null, login: o.login, reason: "admin_network", status: 403, code: "admin_network_denied", message: ADMIN_LOGIN_TEXT.admin_network_denied });
  const created = await createAdminSession(app, { personId: o.personId, role: o.role, authMethod: o.method, ip: o.ip, uv: o.uv,
                                                  breakglassWindowId: o.breakglassWindowId });
  const token = created.token;
  const row = created.row;
  const caller = adminSessionCaller(row, o.ip, baseUrlOf(c.req.raw));
  try {
    await audit(app, caller, { event_type: "admin", ip: o.ip, details: { op: "admin_login", admin_session: row.id, admin_person: o.personId, admin_role: o.role,
                                                                     admin_auth: o.method, login: o.login } }, { strict: true });
  } catch {
    await revokeAdminSessions(app, { sessionId: row.id }, "logout");
    log.error("admin_login_audit_failed", { login: o.login, session: row.id });
    return c.json({ code: "internal", message: "The audit log is unavailable, so sign-in was not completed. Try again later" }, 503);
  }
  await raiseAlert({ control: app.db.control, audit: app.db.audit }, {
    instanceId: app.instanceId, level: "medium", code: "admin_login",
    summary: `Administrator ${o.login} signed in (${o.method === "sso_webauthn" ? "single sign-on and security key" : o.method === "sso_breakglass" ? "single sign-on, emergency access" : "single sign-on"})`,
    details: { admin_person: o.personId, admin_session: row.id, admin_role: o.role, admin_auth: o.method }, dedupeKey: `admin_login:${row.id}` });
  log.info("admin_login", { login: o.login, person: o.personId, session: row.id, auth: o.method });
  const end = o.breakglassWindowId ? await windowEnd(app, o.breakglassWindowId) : null;
  const expires = end && end.getTime() < new Date(row.expires_at).getTime() ? end : new Date(row.expires_at);
  return c.json({ step: "session", session: token, expires_at: expires.toISOString() });
}

export function ssoRoutes(app: App): Hono {
  const r = new Hono();

  // Login methods never write to the database. Only breakglass mode exposes its window state.
  // The configured IdP origin lets the panel allow its plain SSO form's external redirect in CSP.
  r.get("/api/v1/admin-auth/methods", async (c) => {
    const raw = String(app.settings.get<string>("admin.local_login", "open"));
    const local = ["open", "breakglass", "off"].includes(raw) ? raw : "open";
    const open = local === "breakglass" ? await breakglassOpenNow(app).catch(() => false) : false;
    const ready = adminSsoReady(app);
    if (ready.ok) c.header("X-Memory-Sso-Origin", new URL(ready.cfg.issuer).origin);
    return c.json({ sso: ready.ok, local, breakglass_open: open });
  });

  r.post("/api/v1/admin-auth/sso/start", async (c) => {
    const ready = adminSsoReady(app);
    if (!ready.ok) {
      if (adminOidcConfig(app).enabled) log.warn("admin_sso_not_configured", { problems: ready.problems.join("; ").slice(0, 500) });
      return c.json(NOT_FOUND, 404);
    }
    const b = await bodyOf(c);
    const ip = await browserIp(app, c, b.client_ip);
    const limited = overLimit(app, c, "start", ip);
    if (limited) return limited;
    try {
      const d = await providers.discovery(ready.cfg);
      const { url, pending } = authorizationRequest(ready.cfg, d);
      if (!pendingAdminLogins.put(pending)) {
        log.warn("admin_sso_pending_full", { size: pendingAdminLogins.size });
        c.header("Retry-After", "60");
        return c.json(TOO_MANY, 429);
      }
      return c.json({ authorization_url: url, state: pending.state });
    } catch (e) {
      return protocolFailure(app, c, ip, "start", e);
    }
  });

  r.post("/api/v1/admin-auth/sso/callback", async (c) => {
    const ready = adminSsoReady(app);
    if (!ready.ok) return c.json(NOT_FOUND, 404);
    const cfg = ready.cfg;
    const b = await bodyOf(c);
    const ip = await browserIp(app, c, b.client_ip);
    const limited = overLimit(app, c, "callback", ip);
    if (limited) return limited;
    const text = (k: string): string => (typeof b[k] === "string" ? b[k] as string : "");
    const q = { state: text("state"), cookie_state: text("cookie_state"), code: text("code"), iss: text("iss"), error: text("error") };
    let stage = "request";
    let claims: Record<string, unknown>;
    try {
      const long = (Object.keys(ADMIN_CALLBACK_CAPS) as Array<keyof typeof ADMIN_CALLBACK_CAPS>).filter((k) => q[k].length > ADMIN_CALLBACK_CAPS[k]);
      if (long.length) throw new OidcFailure("oidc_request_invalid", `over the length limit: ${long.join(", ")}`);
      stage = "state";
      const pending = q.state ? pendingAdminLogins.take(q.state) : null;
      if (!pending) throw new OidcFailure("oidc_state_invalid", "state is unknown, expired or already used");
      stage = "browser";
      if (!sameState(q.state, q.cookie_state)) throw new OidcFailure("oidc_state_invalid", "state does not match the browser cookie");
      stage = "callback";
      if (q.error) throw new OidcFailure("oidc_provider_error", /^[a-z_]{1,40}$/.test(q.error) ? q.error : "error");
      if (q.iss && q.iss !== cfg.issuer) throw new OidcFailure("oidc_token_invalid", "iss in the authorization response identifies a different issuer");
      if (!q.code) throw new OidcFailure("oidc_code_invalid", "the authorization response has no code");
      const d = await providers.discovery(cfg);
      if (d.iss_parameter && !q.iss) throw new OidcFailure("oidc_token_invalid", "the provider declares iss in the authorization response, but it is missing");
      stage = "token";
      const tokens = await exchangeCode(cfg, d, q.code, pending, providers.transport);
      claims = await verifyIdToken(cfg, d, tokens.idToken, pending.nonce, providers);
      if (claims[cfg.claims.guid] === undefined && tokens.accessToken)
        claims = { ...(await fetchUserinfo(cfg, d, tokens.accessToken, String(claims.sub), providers.transport)), ...claims };
    } catch (e) {
      return protocolFailure(app, c, ip, stage, e);
    }

    const person = ssoPerson(cfg, claims);
    const decided = await resolveAdmin(app, { sub: person.sub, preferred_username: person.username ?? undefined, ldap_id: person.guid ?? undefined, groups: person.groups }, ip);
    if (!decided.ok)
      return refuse(app, c, { ip, login: decided.login, reason: decided.reason, status: decided.status, code: decided.code, message: decided.message,
                              extra: decided.extra, count: decided.reason !== "admin_directory_unavailable" });

    if (decided.webauthn === "not_required")
      return issue(app, c, { personId: decided.personId, login: decided.login, role: decided.role, ip,
                             method: decided.breakglassWindowId ? "sso_breakglass" : "sso", uv: false, breakglassWindowId: decided.breakglassWindowId });

    const w = webauthnSettings(app);
    const problems = webauthnProblems(w);
    if (problems.length) {
      log.warn("admin_webauthn_not_configured", { problems: problems.join("; ").slice(0, 500) });
      return refuse(app, c, { ip, login: decided.login, reason: "admin_sso_failed", status: 503, code: "internal",
                              message: "No WebAuthn keys are configured for the admin panel. Sign-in with a key is unavailable", extra: { stage: "webauthn_config" }, count: false });
    }
    const rows = await usableCredentials(app, decided.personId, decided.guid);
    const challenge = newChallenge();
    const tx = loginChallenges.put({ personId: decided.personId, login: decided.login, guid: decided.guid, role: decided.role, ip, challenge,
                                     counters: counterSnapshot(rows) });
    const options = assertionOptions({ rpId: w.rpId, challenge, userVerification: w.uv,
                                       allow: rows.map((x) => ({ id: Buffer.from(x.credential_id), transports: x.transports })) });
    return c.json({ step: "webauthn", tx, options });
  });

  r.post("/api/v1/admin-auth/webauthn/assert", async (c) => {
    const b = await bodyOf(c);
    const ip = await browserIp(app, c, b.client_ip);
    const limited = overLimit(app, c, "assert", ip);
    if (limited) return limited;
    const p = loginChallenges.take(b.tx);
    const fail = (login: string | null, step: string, code?: string) =>
      refuse(app, c, { ip, login, reason: "webauthn_failed", status: 401, code: "webauthn_failed", message: ADMIN_LOGIN_TEXT.webauthn_failed,
                       extra: { step, ...(code ? { code } : {}) } });
    if (!p) return fail(null, "tx");
    if (p.ip !== ip) return fail(p.login, "ip");
    const rows = await usableCredentials(app, p.personId, p.guid);
    const out = await checkAssertion(app, { credential: b.credential, challenge: p.challenge, rows, login: p.login, counters: p.counters });
    if (!out.ok) return fail(p.login, out.step, out.code);
    return issue(app, c, { personId: p.personId, login: p.login, role: p.role, ip, method: "sso_webauthn", uv: true, breakglassWindowId: null });
  });

  return r;
}
