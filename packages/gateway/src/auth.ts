import { ADMIN_SESSION_PREFIX, agentAuthMode, clientFromUa, hashApiKey, isNetBound, isSessionToken, kindFromPrefix, log, publicBaseUrl, raiseAlert, SESSION_PREFIX,
         trimBase, type ClassScope } from "@memory/shared";
import { ACCESS_PREFIX, CODE_PREFIX, REFRESH_PREFIX } from "@memory/shared/oauth-as";
import type { App, Caller, PersonRow, ServiceRow } from "./context.ts";
import { audit } from "./audit.ts";
import { credentialAllowed, exemptFromPreauth, externalHosts, bareAddress, forwardedAddress, fromSystemKeyNetwork, normalizeHost, onceIn,
         requestChannel, requestHost, type Channel, type CredentialKind, type RequestChannel } from "./channel.ts";
import { preauthFor } from "./preauth.ts";
import { sessionAlive, verifySession } from "./session.ts";
import { endSession, findSession, SESSION_CLIENT_LABEL, sessionIdleMs, testSessionsOn, touchSession } from "./user-sessions.ts";
import { fromWorkplace } from "./workplace.ts";
import { authenticateOAuth, createAgentAuthProviders, OAUTH_LOGIN_UNLINKED_ADMIN_TEXT, OAUTH_LOGIN_UNLINKED_TEXT, OAuthRejected, oauthCallerForKey, ssoLinkProblem } from "./oauth.ts";
import { noteNoConsentOnce, oboReadAllowed } from "./obo-consent.ts";
import { authenticateBuiltin } from "./agent-auth/tokens-auth.ts";
import { currentListener, processTopology } from "./admin-plane/listeners.ts";
import { legacyPanelTokenProblem } from "./admin-plane/legacy-token.ts";

const bearerProviders = createAgentAuthProviders({ external: authenticateOAuth, builtin: authenticateBuiltin });

export class HttpReject extends Error {
  /**
   * tokenPresented — the request carried a bearer token: the 401 of /mcp in agent_auth.mode = builtin then
   * starts its WWW-Authenticate with error="invalid_token" (RFC 6750 §3.1, mcpChallenge in oauth.ts). Only that reads it.
   */
  constructor(readonly status: 401 | 403, readonly code: "unauthorized" | "forbidden" | "system_key_disabled", message: string, readonly tokenPresented = false) { super(message); }
}

export const SYSTEM_KEY_DISABLED_TEXT = "The system key is switched off (admin.system_key_admin). For maintenance use an administrator session or the CLI on the server";
export const SYSTEM_KEY_ALERT_EVERY_MS = 600_000;

const adminSeparate = (): boolean => { try { return processTopology().adminSeparate; } catch { return false; } };
export const systemKeyAdmin = (app: Pick<App, "settings">): boolean => app.settings.get<boolean>("admin.system_key_admin", true) !== false;

export const EXTERNAL_ID = /^(ad|bitrix|sap|telegram|hub|sso):(.{1,128})$/;
export const personCols = (alias = ""): string => {
  const p = alias ? `${alias}.` : "";
  return `${p}id, ${p}login, ${p}display_name, ${p}department, ${p}role, ${p}instance_id, ${p}active, (${p}attrs->>'demo' = 'true') AS demo, ${p}notebook, ${p}attrs->>'given_name' AS given_name`;
};
const PERSON_COLS = personCols();
const NIL = "00000000-0000-0000-0000-000000000000";
export const OBO_READ_OPS = ["search", "read", "list", "original"] as const;

const OBO_NO_CONSENT = Symbol("obo_no_consent");
interface NoConsentMark { app: App; service: ServiceRow; person: PersonRow; who: Partial<Caller> }

export function oboReadRefused(caller: Caller, op: string): void {
  const m = (caller as Caller & { [OBO_NO_CONSENT]?: NoConsentMark })[OBO_NO_CONSENT];
  if (m && (OBO_READ_OPS as readonly string[]).includes(op)) noteNoConsentOnce(m.app, m.service, m.person, m.who);
}

async function personByLogin(app: App, login: string): Promise<PersonRow | null> {
  const { rows } = await app.db.control.query(`SELECT ${PERSON_COLS} FROM people WHERE login = $1 AND instance_id = $2`, [login.trim().toLowerCase(), app.instanceId]);
  return rows[0] ?? null;
}

async function resolveOnBehalfOf(app: App, raw: string): Promise<PersonRow | null> {
  const m = EXTERNAL_ID.exec(raw.trim());
  if (!m || raw.includes("@")) return personByLogin(app, raw);
  if (!app.settings.get("access.obo_external_identities", true)) return null;
  const { rows } = await app.db.control.query(
    `SELECT ${personCols("p")} FROM person_identities i JOIN people p ON p.id = i.person_id
     WHERE i.system = $1 AND i.external_id = $2 AND i.verified AND i.active AND p.instance_id = $3`, [m[1], m[2], app.instanceId]);
  return rows[0] ?? null;
}

export function scopeFor(kind: Caller["keyKind"], tier: Caller["tier"]): ClassScope {
  if (kind === "system") return { classes: [], tier: "system", keyKind: kind };
  if (kind === "extended") return { classes: ["open", "closed"], tier, keyKind: kind };
  return tier === "T2" || tier === "T1" ? { classes: ["open"], tier, keyKind: kind } : { classes: ["open", "closed"], tier, keyKind: kind };
}

export async function clientAddress(app: App, req: Request, remote: string | null): Promise<string | null> {
  return forwardedAddress(app, req.headers.get("x-forwarded-for"), remote?.replace(/^::ffff:/, "") ?? null);
}

export async function workplaceClientAddress(app: App, header: (name: string) => string | undefined, sock: string | null): Promise<string | null> {
  // the panel relays socket addresses (its own stamp of the browser socket, or the address it took as the browser's): the
  // socket rule of the one parser (bareAddress — a zone id is dropped, as before); the chain — hop by hop, the header rule
  const peer = bareAddress(header("x-memory-client-peer") ?? "");
  if (peer) return forwardedAddress(app, header("x-memory-client-forwarded") ?? null, peer);
  return bareAddress(header("x-memory-client-ip") ?? "") ?? sock;
}

const oboDenials = new Map<string, number[]>();
async function oboDenied(app: App, caller: Caller, reason: string, obo: string): Promise<void> {
  await audit(app, caller, { event_type: "auth_failure", details: { reason, on_behalf_of: obo.slice(0, 200) } });
  const cfg = app.settings.get<{ limit?: number; window_min?: number; pause_min?: number }>("access.obo_denial_pause", {});
  const limit = Number(cfg.limit ?? 20), windowMin = Number(cfg.window_min ?? 10), pauseMin = Math.max(1, Math.round(Number(cfg.pause_min ?? 15)));
  if (!(limit > 0) || !(windowMin > 0)) return;
  const now = Date.now(), xs = (oboDenials.get(caller.keyId) ?? []).filter((t) => t > now - windowMin * 60_000);
  xs.push(now);
  if (oboDenials.size > 10_000) oboDenials.clear();
  oboDenials.set(caller.keyId, xs);
  if (xs.length <= limit) return;
  oboDenials.delete(caller.keyId);
  const { rows } = await app.db.control.query("UPDATE api_keys SET paused_until = now() + make_interval(mins => $2::int) WHERE id = $1 RETURNING paused_until", [caller.keyId, pauseMin]);
  await audit(app, caller, { event_type: "auth_failure", details: { reason: "obo_key_paused", denials: xs.length, window_min: windowMin, pause_min: pauseMin, paused_until: rows[0]?.paused_until ?? null } });
  log.warn("obo_key_paused", { key_id: caller.keyId, service: caller.service?.name ?? null, denials: xs.length, pause_min: pauseMin });
}

export const AUTH_FAILED_TEXT = "The key is missing, invalid, revoked or expired";
/**
 * The same refusal in agent_auth.mode = builtin: the body of a 401 on /mcp when no key was presented — the
 * first thing claude.ai and ChatGPT see before signing in — or a built-in access token (mem_oat_) was refused. English like
 * everything the built-in sign-in says to agents; other keys keep AUTH_FAILED_TEXT, mode external keeps it everywhere.
 */
export const OAUTH_TOKEN_TEXT = "The access token is missing, invalid, revoked or expired";

const REVOKED_KEY_AUDIT_WINDOW_MS = 60_000;
const REVOKED_KEY_AUDIT_MAX = 10_000;
const revokedKeyAuditUntil = new WeakMap<App, Map<string, number>>();

function shouldAuditRevokedKey(app: App, keyId: string): boolean {
  let entries = revokedKeyAuditUntil.get(app);
  if (!entries) {
    entries = new Map();
    revokedKeyAuditUntil.set(app, entries);
  }
  const now = performance.now();
  // Expirations follow insertion order. Keep live entries even at capacity to avoid duplicate events.
  for (const [id, until] of entries) {
    if (until > now) break;
    entries.delete(id);
  }
  if (entries.has(keyId) || entries.size >= REVOKED_KEY_AUDIT_MAX) return false;
  entries.set(keyId, now + REVOKED_KEY_AUDIT_WINDOW_MS);
  return true;
}

type AuthFailureOptions = { countAddress?: boolean; shouldAudit?: () => boolean };

async function noteAuthFailure(app: App, rc: RequestChannel, reason: string, details: Record<string, unknown>, o: AuthFailureOptions = {}): Promise<void> {
  const n = (await exemptFromPreauth(app, rc)) ? { audit: true, throttledEvent: false, count: 0 } : preauthFor(app).noteFailure(rc, o);
  if (n.audit && (o.shouldAudit?.() ?? true)) await audit(app, null, { event_type: "auth_failure", details: { reason, ...details }, ip: rc.ip });
  else if (n.throttledEvent) await audit(app, null, { event_type: "auth_failure", details: { reason: "failures_throttled", count: n.count }, ip: rc.ip });
}

function keyCredential(key: { principal_type: string; kind: string; tier: string; preview?: boolean | null }, service: ServiceRow | null): CredentialKind {
  if (key.principal_type === "system" || key.kind === "system") return "system";
  if (key.principal_type === "service") return key.tier === "T0" || service?.tier === "T0" ? "service_t0" : service?.obo_allowed ? "service_obo" : "service_t1";
  if (key.preview === true) return "preview";
  return key.kind === "extended" ? "extended" : "personal";
}

export async function authenticate(app: App, req: Request, remoteAddress: string | null = null): Promise<Caller> {
  const header = req.headers.get("authorization") ?? "";
  const plain = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
  const rc = await requestChannel(app, req, remoteAddress);
  const ip = rc.ip, channel = rc.channel;
  const fail = async (reason: string, details: Record<string, unknown> = {}, message = AUTH_FAILED_TEXT, o: AuthFailureOptions = {}): Promise<never> => {
    await noteAuthFailure(app, rc, reason, details, o);
    throw new HttpReject(401, "unauthorized", message, !!plain);
  };
  const refuse = (kind: CredentialKind): Promise<never> => fail("channel_credential", { kind, channel, host: rc.host });
  if (plain?.startsWith("edge_")) return fail("edge_token", { prefix: plain.slice(0, 8) });
  // built-in sign-in server: a code or a refresh token is never a bearer token — refused before the database;
  // an access token (mem_oat_) only in mode builtin, before sessions and JWT. A refused mem_oat_ does not count against the
  // address (countAddress: false): all employees of claude.ai or ChatGPT come from one egress, and a wave of expired
  // tokens after a revocation would lock a neighbour's fresh token out with 429 (the client restarts sign-in only on 401).
  // The same in another mode (oauth_mode): after builtin is switched to external or off, the clients of that egress keep
  // presenting their dead mem_oat_ tokens, and counting them would lock out the credentials that do work there. No
  // mem_oat_ is ever accepted outside builtin, so not counting them helps no guessing; per_address_per_minute still holds
  if (plain?.startsWith(REFRESH_PREFIX) || plain?.startsWith(CODE_PREFIX)) return fail("oauth_wrong_token", { prefix: plain.slice(0, 8) });
  if (plain?.startsWith(ACCESS_PREFIX)) {
    if (!credentialAllowed(channel, "oauth")) return refuse("oauth");
    const mode = agentAuthMode(app.settings);
    if (mode !== "builtin") return fail("oauth_mode", { mode }, AUTH_FAILED_TEXT, { countAddress: false });
    try {
      const caller = await bearerProviders.agent("builtin").verifyBearer(app, plain, ip, baseUrlOf(req, { app, channel }));
      preauthFor(app).noteSuccess(rc, plain);
      const claimed = clientFromUa(req.headers.get("user-agent"), req.headers.get("mcp-protocol-version"));
      return { ...caller, ...(claimed ? { claimedClient: claimed } : {}), channel };
    } catch (e) {
      if (e instanceof OAuthRejected) return fail("oauth_connection", { origin: "builtin" }, OAUTH_TOKEN_TEXT, { countAddress: false });
      throw e;
    }
  }
  const used = (caller: Caller, kind: CredentialKind): Caller => {
    if (channel !== "internal" && onceIn(app, `key_use:${caller.keyId}:${channel}:${rc.host ?? ""}`, 3_600_000))
      log.info("channel_key_use", { key_id: caller.keyId, kind, channel, host: rc.host });
    preauthFor(app).noteSuccess(rc, plain);
    return caller;
  };
  const baseUrl = baseUrlOf(req, { app, channel });
  if (plain?.startsWith(ADMIN_SESSION_PREFIX) || (plain?.startsWith("mem_adm_") && adminSeparate() && currentListener()?.kind !== "admin"))
    return fail("admin_token_on_main", { listener: currentListener()?.kind ?? "main" });
  const systemKeyAlert = async (outside: boolean): Promise<void> => {
    if (onceIn(app, "system_key_used", SYSTEM_KEY_ALERT_EVERY_MS))
      await raiseAlert({ control: app.db.control, audit: app.db.audit }, { instanceId: app.instanceId, level: "high", code: "system_key_used",
        summary: "A system key was provided while system keys are disabled (admin.system_key_admin)", details: { channel, ip, outside_networks: outside },
        dedupeKey: `system_key_used:${Math.floor(Date.now() / SYSTEM_KEY_ALERT_EVERY_MS)}` });
  };
  const systemOff = async (): Promise<never> => {
    await noteAuthFailure(app, rc, "system_key_disabled", {});
    await systemKeyAlert(false);
    throw new HttpReject(401, "system_key_disabled", SYSTEM_KEY_DISABLED_TEXT, true);
  };
  if (plain?.startsWith("mem_adm_")) {
    if (!credentialAllowed(channel, "admin_session")) return refuse("admin_session");
    const legacy = legacyPanelTokenProblem(app.settings.get<string>("admin.local_login", "open"));
    if (legacy) return fail(legacy.reason, legacy.details);
    if (!fromSystemKeyNetwork(app, rc.sock) && !(await fromWorkplace(app, rc.sock))) return fail("admin_session_network");
    const s = verifySession(app, plain);
    if (!s) return fail("admin_session");
    const { rows: au } = await app.db.control.query("SELECT sessions_revoked_at FROM admin_users WHERE login = $1 AND disabled_at IS NULL", [s.login]);
    if (!au.length) return fail("admin_disabled", { login: s.login });
    if (!sessionAlive(s, au[0].sessions_revoked_at)) return fail("admin_session_revoked", { login: s.login });
    return { keyId: NIL, keyKind: "system", tier: "T0", principalType: "system", person: null, service: null, onBehalfOf: false,
             admin: { sessionId: null, personId: null, login: s.login, localLogin: s.login, role: "memory_admin", authMethod: "legacy_session", uvAt: null, breakglassWindowId: null },
             allowedOps: new Set(["admin"]), clientLabel: `admin:${s.login}`, clientKind: null, expiresAt: null, ip, netBound: false, preview: false, scope: scopeFor("system", "T0"), baseUrl, channel };
  }
  if (plain?.startsWith(SESSION_PREFIX) && !credentialAllowed(channel, "workplace_session")) return refuse("workplace_session");
  if (plain && isSessionToken(plain)) return { ...(await sessionCaller(app, plain, ip, baseUrl, fail)), channel };
  if (plain && !kindFromPrefix(plain) && plain.split(".").length === 3) {
    // an identity provider token only in mode external: in builtin and off refused before the signature and the database.
    // Not counted against the address: external→builtin revokes every identity provider connection, and
    // clients behind one egress keep sending their JWTs (and fresh ones from an identity provider refresh) until they rediscover the
    // server — counting them would lock colleagues' new mem_oat_ out with 429. A refused JWT-shaped string helps no
    // guessing of a prefixed key; per_address_per_minute still holds
    const mode = agentAuthMode(app.settings);
    if (mode !== "external") return fail("oauth_connection", { mode }, AUTH_FAILED_TEXT, { countAddress: false });
    try {
      const caller = await bearerProviders.agent("external").verifyBearer(app, plain, ip, baseUrl);
      preauthFor(app).noteSuccess(rc, plain);
      const claimed = clientFromUa(req.headers.get("user-agent"), req.headers.get("mcp-protocol-version"));
      return { ...caller, ...(claimed ? { claimedClient: claimed } : {}), channel };
    }
    catch (e) {
      if (e instanceof OAuthRejected && e.reason) {
        const link = ssoLinkProblem(app.settings);
        return fail("oauth_connection", { result: e.reason, ...(link ? { sso_link: link } : {}) }, link ? OAUTH_LOGIN_UNLINKED_ADMIN_TEXT : OAUTH_LOGIN_UNLINKED_TEXT);
      }
      if (e instanceof OAuthRejected) return fail("oauth_connection");
      throw e;
    }
  }
  const prefixKind = plain ? kindFromPrefix(plain) : null;
  // no key on /mcp in builtin — the English text: the first answer a cloud client gets before it signs in. Every new
  // claude.ai or ChatGPT connection starts with it, from the egress all their users share: it is not a guess at a key and
  // does not count against the address, or a busy minute of new connections would lock the fresh tokens of that
  // egress out with 429. The journal keeps its limit; in external the no-key 401 counts as before
  if (!plain && isMcpPath(req) && agentAuthMode(app.settings) === "builtin") return fail("malformed", {}, OAUTH_TOKEN_TEXT, { countAddress: false });
  if (!plain || !prefixKind) return fail("malformed");
  if (prefixKind === "system") {
    if (!credentialAllowed(channel, "system")) return refuse("system");
    if (!fromSystemKeyNetwork(app, rc.sock)) {
      if (!systemKeyAdmin(app)) await systemKeyAlert(true);
      return fail("system_key_network");
    }
    if (!systemKeyAdmin(app)) return systemOff();
  }
  if (prefixKind === "extended" && !credentialAllowed(channel, "extended")) return refuse("extended");

  const keyHash = hashApiKey(plain);
  const { rows } = await app.db.control.query(
    `SELECT id, principal_type, principal_id, kind, tier, ops_override, client_label, client_kind, expires_at, preview, net_cidrs::text[] AS net_cidrs, paused_until, open_write
     FROM api_keys WHERE key_hash = $1 AND instance_id = $2 AND revoked_at IS NULL AND auth_method = 'api_key'`, [keyHash, app.instanceId]);
  const key = rows[0];
  if (!key) {
    // Every miss gets the same lookup. Its result is only for the journal, so a lookup error keeps the ordinary 401.
    const revoked = (await app.db.control.query<{ id: string }>(
      "SELECT id FROM api_keys WHERE key_hash = $1 AND instance_id = $2 AND revoked_at IS NOT NULL AND auth_method = 'api_key'",
      [keyHash, app.instanceId]).catch(() => null))?.rows[0];
    if (revoked) {
      return fail("revoked", { key_id: revoked.id }, AUTH_FAILED_TEXT, {
        shouldAudit: () => shouldAuditRevokedKey(app, revoked.id),
      });
    }
    return fail("unknown_or_revoked");
  }
  if ((key.principal_type === "system" || key.kind === "system") && !systemKeyAdmin(app)) return systemOff();
  if (key.expires_at && new Date(key.expires_at) <= new Date()) return fail("expired");
  if (key.paused_until && new Date(key.paused_until) > new Date())
    throw new HttpReject(403, "forbidden", `The key is paused until ${new Date(key.paused_until).toISOString()} after repeated “on behalf of” denials (access.obo_denial_pause). Use “Services and keys” in the admin panel to lift the pause early`);
  if (key.net_cidrs?.length) {
    if (!ip) return fail("network", { key_id: key.id });
    const ok = await app.db.control.query("SELECT bool_or($1::inet <<= c::cidr) AS ok FROM unnest($2::text[]) c", [ip, key.net_cidrs]);
    if (!ok.rows[0]?.ok) return fail("network", { key_id: key.id });
  }
  let early: ServiceRow | null | undefined;
  if (key.principal_type === "service" && channel === "external") {
    early = (await app.db.control.query("SELECT id, name, kind, obo_allowed, obo_read, allowed_ops, tier, write_space_id FROM services WHERE id = $1 AND active", [key.principal_id])).rows[0] ?? null;
  }
  const credential = keyCredential(key, early ?? null);
  if (credential === "system" && !fromSystemKeyNetwork(app, rc.sock)) return fail("system_key_network");
  if (!credentialAllowed(channel, credential)) return refuse(credential);

  const base: Omit<Caller, "person" | "service" | "onBehalfOf" | "allowedOps" | "principalType"> = {
    keyId: key.id, keyKind: key.kind, tier: key.tier, clientLabel: key.client_label, expiresAt: key.expires_at, ip,
    clientKind: key.principal_type === "person" ? key.client_kind ?? null : null,
    netBound: isNetBound(key.net_cidrs),
    preview: key.preview === true, scope: scopeFor(key.kind, key.tier), baseUrl, channel,
    ...(key.kind === "extended" ? { openWrite: key.open_write === true } : {}),
  };
  const obo = req.headers.get("x-on-behalf-of")?.trim() || null;
  const claimed = key.preview === true ? undefined : clientFromUa(req.headers.get("user-agent"), req.headers.get("mcp-protocol-version"));
  const claimedClient = claimed ? { claimedClient: claimed } : {};
  void app.db.control.query(
    `UPDATE api_keys SET last_used_at = now(), last_used_ip = $2::inet
     WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute' OR last_used_ip IS DISTINCT FROM $2::inet)`, [key.id, ip]).catch(() => undefined);

  if (key.principal_type === "system") return used({ ...base, principalType: "system", person: null, service: null, onBehalfOf: false, allowedOps: new Set(["admin"]) }, credential);

  if (key.principal_type === "person") {
    const { rows: p } = await app.db.control.query(`SELECT ${personCols()} FROM people WHERE id = $1`, [key.principal_id]);
    if (!p[0]?.active) return fail("person_inactive");
    return used({ ...base, principalType: "person", person: p[0], service: null, onBehalfOf: false, allowedOps: key.ops_override ? new Set(key.ops_override) : null, ...claimedClient }, credential);
  }

  const service: ServiceRow | null = early !== undefined ? early
    : (await app.db.control.query("SELECT id, name, kind, obo_allowed, obo_read, allowed_ops, tier, write_space_id FROM services WHERE id = $1 AND active", [key.principal_id])).rows[0] ?? null;
  if (!service) return fail("service_inactive");
  if (service.tier === "T1" && !t1Allowed(app, service.name)) return fail("t1_not_allowed", { service: service.id });
  const ops = new Set<string>(key.ops_override ? service.allowed_ops.filter((o: string) => key.ops_override.includes(o)) : service.allowed_ops);
  let person: PersonRow | null = null, narrowedNoConsent = false;
  if (obo) {
    const deny = async (reason: string, message: string): Promise<never> => {
      await oboDenied(app, { ...base, principalType: "service", person: null, service, onBehalfOf: false, allowedOps: ops }, reason, obo);
      throw new HttpReject(403, "forbidden", message);
    };
    if (!service.obo_allowed) return deny("obo_not_allowed", "The service cannot act on behalf of users");
    person = await resolveOnBehalfOf(app, obo);
    if (!person?.active) return deny("obo_unknown_person", "The person in X-On-Behalf-Of is unknown or inactive");
    if (person.demo) return deny("obo_demo_person", "The person in X-On-Behalf-Of is unknown or inactive");
    if (!service.obo_read) for (const o of OBO_READ_OPS) ops.delete(o);
    else if (!(await oboReadAllowed(app, service, person, base, { note: isMcpPath(req) }))) {
      for (const o of OBO_READ_OPS) ops.delete(o);
      narrowedNoConsent = true;
    }
  }
  const out: Caller = { ...base, principalType: "service", person, service, onBehalfOf: person !== null, allowedOps: ops, ...claimedClient };
  if (narrowedNoConsent && person) (out as Caller & { [OBO_NO_CONSENT]?: NoConsentMark })[OBO_NO_CONSENT] = { app, service, person, who: base };
  return used(out, keyCredential(key, service));
}

const isMcpPath = (req: Request): boolean => { try { return /^\/mcp(\/|$)/.test(new URL(req.url).pathname); } catch { return false; } };

/** A configured address of the links: its origin, its normalized host name (normalizeHost), and whether it is external. */
interface LinkBase { origin: string; host: string | null; external: boolean }

/** `https://<name>` for a host name already normalized (normalizeHost); not an address — null. */
function httpsOrigin(name: string): string | null {
  try {
    const u = new URL(`https://${name.includes(":") ? `[${name}]` : name}`);
    return u.hostname && !u.username && !u.password ? u.origin : null;
  } catch { return null; }
}

/** `https://<name>` of the first effective external name (normalized, in the order of externalHosts) that is an address; none — null. */
function firstVettedOrigin(external: ReadonlySet<string>): string | null {
  for (const name of external) { const o = httpsOrigin(name); if (o) return o; }
  return null;
}

/**
 * Configured addresses of the agents as origins, in the order of the built-in sign-in issuer (agentAuthIssuer):
 * access.cloud_agent_base_url, access.public_base_url, then MEMORY_PUBLIC_URL. A value that is not an http(s)
 * address with a host, or that carries a user name or a password, is skipped; a path, a query or a fragment are dropped.
 * External: access.cloud_agent_base_url (the address of the cloud agents) and MEMORY_PUBLIC_URL always; access.public_base_url
 * — the address inside the company network by its meaning — only when its host is one of the external names.
 */
function configuredLinkBases(app: App, external: ReadonlySet<string>): LinkBase[] {
  const out: LinkBase[] = [];
  // Settings.str, not Settings.get: agentAuthIssuer stays the only Settings.get reader of access.public_base_url, the
  // signal of a unit test; a value that is not a string is null here and is skipped
  const sources: Array<[string | null, boolean]> = [[app.settings.str("access.cloud_agent_base_url"), true],
    [app.settings.str("access.public_base_url"), false], [publicBaseUrl(), true]];
  for (const [raw, alwaysExternal] of sources) {
    const v = trimBase(raw);
    if (!v) continue;
    let u: URL;
    try { u = new URL(v); } catch { continue; }
    if ((u.protocol !== "https:" && u.protocol !== "http:") || !u.hostname || u.username || u.password) continue;
    if (out.some((b) => b.origin === u.origin)) continue;
    const host = normalizeHost(u.host);
    out.push({ origin: u.origin, host, external: alwaysExternal || (host !== null && external.has(host)) });
  }
  return out;
}

export function baseUrlOf(req: Request, on?: { app: App; channel: Channel }): string {
  const url = new URL(req.url);
  if (on?.channel === "external") {
    const external = new Set(externalHosts(on.app).map((h) => normalizeHost(h)).filter((h): h is string => h !== null));
    const bases = configuredLinkBases(on.app, external);
    if (bases.length) {
      const asked = requestHost(req);
      const vetted = asked !== null && external.has(asked) ? httpsOrigin(asked) : null;
      return (asked !== null ? bases.find((b) => b.host === asked)?.origin : undefined)
        ?? bases.find((b) => b.external)?.origin ?? vetted ?? firstVettedOrigin(external) ?? bases[0]!.origin;
    }
  }
  return `${req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "")}://${req.headers.get("host") ?? url.host}`;
}

export async function callerForKey(app: App, keyId: string, ip: string | null, baseUrl: string, channel: Channel = "internal"): Promise<Caller | null> {
  const { rows } = await app.db.control.query(
    `SELECT id, auth_method, principal_type, principal_id, kind, tier, ops_override, client_label, client_kind, expires_at, preview, net_cidrs::text[] AS net_cidrs, paused_until, open_write
     FROM api_keys WHERE id = $1 AND instance_id = $2 AND revoked_at IS NULL`, [keyId, app.instanceId]);
  const key = rows[0];
  if (key?.auth_method === "oauth") { const c = await oauthCallerForKey(app, keyId, ip, baseUrl); return c ? { ...c, channel } : null; }
  if (!key || key.principal_type !== "person" || (key.kind !== "personal" && key.kind !== "extended")) return null;
  if (!credentialAllowed(channel, keyCredential(key, null))) return null;
  if (key.expires_at && new Date(key.expires_at) <= new Date()) return null;
  if (key.paused_until && new Date(key.paused_until) > new Date()) return null;
  if (key.net_cidrs?.length) {
    if (!ip) return null;
    const ok = await app.db.control.query("SELECT bool_or($1::inet <<= c::cidr) AS ok FROM unnest($2::text[]) c", [ip, key.net_cidrs]);
    if (!ok.rows[0]?.ok) return null;
  }
  const { rows: p } = await app.db.control.query(`SELECT ${PERSON_COLS} FROM people WHERE id = $1`, [key.principal_id]);
  if (!p[0]?.active || p[0].demo) return null;
  return { keyId: key.id, keyKind: key.kind, tier: key.tier, principalType: "person", person: p[0], service: null, onBehalfOf: false,
           allowedOps: key.ops_override ? new Set(key.ops_override) : null, clientLabel: key.client_label, clientKind: key.client_kind ?? null, expiresAt: key.expires_at, ip,
           netBound: isNetBound(key.net_cidrs), preview: key.preview === true,
           scope: scopeFor(key.kind, key.tier), baseUrl, channel, ...(key.kind === "extended" ? { openWrite: key.open_write === true } : {}) };
}

async function sessionCaller(app: App, token: string, ip: string | null, baseUrl: string, fail: (reason: string, details?: Record<string, unknown>) => Promise<never>): Promise<Caller> {
  if (!(await fromWorkplace(app, ip))) return fail("session_not_workplace");
  const s = await findSession(app, token);
  if (!s) return fail("session_unknown");
  if (s.ended_at) return fail("session_ended", { session_id: s.id, ended_reason: s.ended_reason });
  if (new Date(s.expires_at) <= new Date()) { await endSession(app, s.id, "expired"); return fail("session_expired", { session_id: s.id }); }
  const idle = sessionIdleMs(app);
  if (idle && Date.now() - new Date(s.last_seen_at).getTime() > idle) { await endSession(app, s.id, "idle"); return fail("session_idle", { session_id: s.id }); }
  if (s.source === "test" && !testSessionsOn(app)) { await endSession(app, s.id, "hook_off"); return fail("session_test_hook_off", { session_id: s.id }); }
  const { rows: p } = await app.db.control.query(`SELECT ${PERSON_COLS} FROM people WHERE id = $1`, [s.person_id]);
  const person: PersonRow | undefined = p[0];
  if (!person?.active || person.demo) { await endSession(app, s.id, "deactivated"); return fail("person_inactive", { session_id: s.id }); }
  touchSession(app, s);
  return { keyId: s.id, keyKind: "session", tier: "T0", principalType: "person", person, service: null, onBehalfOf: false, allowedOps: null,
           clientLabel: SESSION_CLIENT_LABEL, clientKind: null, expiresAt: s.expires_at, ip, netBound: false, preview: false, scope: scopeFor("session", "T0"), baseUrl };
}

export function t1Allowed(app: App, serviceName: string): boolean {
  const providers = app.settings.get<string[]>("access.t1_providers", []);
  return providers.length > 0 && providers.includes(serviceName);
}

export function originAllowed(app: App, req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  if (origin === "null") return false;
  const allow = app.settings.get<string[]>("access.origin_allowlist", []);
  if (!allow.length) return false;
  if (allow.includes("*")) return true;
  try {
    const host = new URL(origin).hostname;
    return allow.some((a) => a === origin || a === host || (a.startsWith("*.") && host.endsWith(a.slice(1))));
  } catch { return false; }
}
