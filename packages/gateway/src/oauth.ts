import { ProviderRegistry, type AgentAuth } from "@memory/shared";
import { authenticateBuiltin } from "./agent-auth/tokens-auth.ts";
// MCP resource-server OAuth. Tokens live only in this request; the durable row is a revocable personal T2 grant.
import type pg from "pg";
import type { Hono } from "hono";
import { agentAuthConfig, agentAuthIssuer, agentAuthMode, agentAuthProblems, AGENT_AUTH_PROBLEM_TEXT, invalid, log, newId, notFound, OAUTH_EXP_SKEW_SEC, oauthConfig, oauthProblems,
         oidcConfig, policyAllows, tx, verifyOAuthAccessToken, type OAuthClaims, type OAuthConfig, type Settings } from "@memory/shared";
import type { App, Caller, PersonRow } from "./context.ts";
import { audit } from "./audit.ts";
import { decodeKeyset, encodeKeyset, intParam, isUuidParam, keysetAtSql } from "./paging.ts";
import { requireHuman } from "./workplace.ts";
import { KEY_EXPIRY_WARN_DAYS } from "./key-expiry.ts";
import { withSettingsTx } from "./login-policy.ts";
import { agentAuthFacts, agentAuthRoutesServed, agentAuthTablesPresent } from "./agent-auth/readiness.ts";
import { deletePersonPending } from "./agent-auth/store.ts";
import { cimdReadiness } from "./agent-auth/cimd-fetch.ts";

type Env = { Variables: { caller: Caller } };
/**
 * An agent connection (oauth_connections + api_keys). origin: keycloak — signed in through the external identity provider (oauth.*), edge — sign-in
 * from outside, builtin — the memory's built-in sign-in server (agent_auth.*). dcr_live — builtin with a DCR client_id
 * only: its agent_oauth_dcr_clients row exists and is not revoked (a database fact, LEFT JOIN of the sign-in query).
 */
export type Grant = { id: string; principal_id: string; client_kind: OAuthClaims["clientKind"]; client_label: string | null;
  created_at: Date; expires_at: Date; revoked_at: Date | null; last_used_at: Date | null; issuer: string; resource_url: string;
  client_id: string; person_id: string; instance_id: string; origin?: "keycloak" | "edge" | "builtin" | null; dcr_live?: boolean | null };
export const PERSON = "p.id,p.login,p.display_name,p.department,p.role,p.instance_id,p.active,(p.attrs->>'demo'='true') AS demo,p.notebook";
export const GRANT = "k.id,k.principal_id,k.instance_id,k.client_kind,k.client_label,k.created_at,k.expires_at,k.revoked_at,k.last_used_at,c.issuer,c.resource_url,c.client_id,c.person_id,c.origin";
const isEdge = (g: Pick<Grant, "origin">): boolean => g.origin === "edge";
const lockName = (app: Pick<App, "instanceId">) => `oauth-policy:${app.instanceId}`;
export const oauthPolicyLock = lockName;
export class OAuthRejected extends Error { constructor(readonly reason: "login_unlinked" | null = null) { super("OAuth connection unavailable"); } }
const reject = (reason: OAuthRejected["reason"] = null): never => { throw new OAuthRejected(reason); };
export const OAUTH_LOGIN_UNLINKED_TEXT = "The memory could not identify you from the agent sign-in. The token is missing your employee number from the company directory. "
  + "Sign in to the workspace once using “Sign in with company single sign-on”, then connect the agent again";
export const OAUTH_LOGIN_UNLINKED_ADMIN_TEXT = "The memory could not identify you from the agent sign-in. The token is missing your employee number from the company directory, "
  + "and the agent sign-in cannot currently be linked to you through the workspace. Tell the memory administrator";
const ready = (cfg: OAuthConfig): boolean => cfg.enabled && oauthProblems(cfg).length === 0;

export type SsoLinkProblem = "oidc_off" | "issuer_mismatch";
export function ssoLinkProblem(s: Pick<Settings, "get">): SsoLinkProblem | null {
  const oauth = oauthConfig(s);
  if (!oauth.enabled) return null;
  const oidc = oidcConfig(s);
  if (!oidc.enabled) return "oidc_off";
  return oauth.issuer === oidc.issuer ? null : "issuer_mismatch";
}

/**
 * Health check `oauth` by the agent sign-in mode (agent_auth.mode): external — as before (identity provider sign-in off, with
 * errors, the fallback without LDAP_ID closed); off — no browser sign-in, personal keys only; builtin — readiness of the
 * built-in server (agentAuthProblems: addresses, apps, [AS] tables, routes). facts — what only the process and the database
 * know (readiness.ts); without them builtin is "not ready". The check key and the health response schema do not change.
 */
export function oauthHealth(s: Pick<Settings, "get">, facts?: { schema?: boolean; routes?: boolean }): { ok: boolean; detail: string } {
  const mode = agentAuthMode(s);
  if (mode === "off") return { ok: true, detail: "agent sign-in in the browser is off (agent_auth.mode = off): personal keys only" };
  if (mode === "builtin") {
    const problems = agentAuthProblems(s, facts ?? {});
    const issuer = agentAuthIssuer(s);
    if (problems.length) return { ok: false, detail: `built-in agent sign-in is not ready: ${problems.map((p) => `${p} — ${AGENT_AUTH_PROBLEM_TEXT[p]}`).join(" ").slice(0, 400)}` };
    return { ok: true, detail: `built-in agent sign-in: ${issuer.issuer.slice(0, 200)}${issuer.dev ? " (plain HTTP on this computer: development only)" : ""}` };
  }
  const cfg = oauthConfig(s);
  if (!cfg.enabled) return { ok: true, detail: "agent sign-in through a company account is disabled (oauth.enabled = false)" };
  const problems = oauthProblems(cfg);
  if (problems.length) return { ok: false, detail: `agent sign-in settings errors: ${problems.map((x) => `${x.key}: ${x.message}`).join("; ").slice(0, 300)}` };
  switch (ssoLinkProblem(s)) {
    case "oidc_off": return { ok: false, detail: "agent sign-in is on, but workspace single sign-on is off (oidc.enabled = false). An agent with a token missing an "
      + "employee number (LDAP_ID) can only sign in if the person previously used single sign-on in the workspace. Others "
      + "get 401. Enable “Single sign-on (OpenID Connect)” or ask IT to add LDAP_ID to agent tokens" };
    case "issuer_mismatch": return { ok: false, detail: `issuers in “Agent sign-in” (${cfg.issuer.slice(0, 200)}) and “Single sign-on” (${oidcConfig(s).issuer.slice(0, 200)}) `
      + "differ: single sign-on account links will not match any profiles, and agents without an employee number (LDAP_ID) in their token "
      + "get 401. Set the same issuer in both sections" };
    default: return { ok: true, detail: `agent sign-in is enabled: ${cfg.issuer.slice(0, 200)}` };
  }
}

/** Settings and revocations commit together. Every control query uses q; callers never wait for a second pool slot. */
export async function withOAuthPolicyLock<T>(app: App, fn: (q: pg.PoolClient, settings: Settings) => Promise<T>): Promise<T> {
  return withSettingsTx(app, [lockName(app)], fn);
}
/**
 * A read under the shared policy lock: the settings of the transaction and the oauth.* config from them. The built-in
 * server (agent-auth/*) calls it too: a code exchange or a token refresh never overlaps the policy step.
 */
export async function policyRead<T>(app: App, fn: (q: pg.PoolClient, cfg: OAuthConfig, settings: Settings) => Promise<T>): Promise<T> {
  return tx(app.db.control, async (q) => {
    await q.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [lockName(app)]);
    const settings = app.settings.withDatabase(q);
    await settings.load(true);
    return fn(q, oauthConfig(settings), settings);
  });
}

export function connectionExpiryWarning(expiresAt: Date | string, now = Date.now(), origin: Grant["origin"] = "keycloak"): string | null {
  const at = new Date(expiresAt).getTime();
  if (!Number.isFinite(at) || at - now > KEY_EXPIRY_WARN_DAYS * 86_400_000) return null;
  if (origin === "edge") return `The connection expires on ${new Date(at).toISOString().slice(0, 10)}; there is no extension. Connect the agent again from the program.`;
  // the built-in sign-in server: English like everything it says to agents, no identity provider in the advice
  if (origin === "builtin") return `Connection expires ${new Date(at).toISOString().slice(0, 10)} and is not extended. Reconnect the app to keep using memory.`;
  return `The connection expires on ${new Date(at).toISOString().slice(0, 10)}; there is no extension. Connect the agent again through a browser. If SSO reuses the old session, end it at the identity provider first.`;
}
export function connectionStatus(g: Pick<Grant, "revoked_at" | "expires_at">, now = Date.now()): "revoked" | "expired" | "active" {
  return g.revoked_at ? "revoked" : new Date(g.expires_at).getTime() <= now ? "expired" : "active";
}
/** A policy change can only narrow an existing grant; it cannot reassign it to another client kind or resource. */
export function connectionAllowed(cfg: OAuthConfig, g: Grant, instanceId: string): boolean {
  return ready(cfg) && g.instance_id === instanceId && g.person_id === g.principal_id && connectionStatus(g) === "active"
    && g.issuer === cfg.issuer && g.resource_url === cfg.resource_url && cfg.allowed_clients[g.client_id] === g.client_kind;
}
/**
 * The one rule «the connection is allowed by the policy», by origin:
 *   keycloak — mode external and the former connectionAllowed by oauth.*;
 *   builtin  — mode builtin and ready (facts: tables, routes), the connection's issuer and resource are the current ones, the
 *              client passes policyAllows (registry — the same row and kind, CIMD — host admission, DCR — on and the client
 *              alive), the connection belongs to the same person and is active;
 *   edge     — never (sign-in from outside is not a caller inside).
 * A policy change only narrows: a connection never moves to another kind or resource.
 */
export function connectionPolicyAllows(app: Pick<App, "instanceId">, settings: Pick<Settings, "get">, g: Grant, facts: { schema?: boolean; routes?: boolean } = {}): boolean {
  if (isEdge(g)) return false;
  const mode = agentAuthMode(settings);
  if ((g.origin ?? "keycloak") === "keycloak") return mode === "external" && connectionAllowed(oauthConfig(settings), g, app.instanceId);
  if (g.origin !== "builtin" || mode !== "builtin") return false;
  if (agentAuthProblems(settings, { schema: facts.schema ?? true, routes: facts.routes ?? agentAuthRoutesServed() }).length) return false;
  const { issuer, resource } = agentAuthIssuer(settings);
  return g.instance_id === app.instanceId && g.person_id === g.principal_id && connectionStatus(g) === "active"
    && g.issuer === issuer && g.resource_url === resource
    && policyAllows(agentAuthConfig(settings), { client_id: g.client_id, kind: g.client_kind, dcr_live: g.dcr_live === true });
}
export function callerForGrant(g: Grant, person: PersonRow, ip: string | null, baseUrl: string): Caller {
  return { keyId: g.id, keyKind: "connection", tier: "T2", principalType: "person", person, service: null, onBehalfOf: false,
    allowedOps: null, clientLabel: g.client_label, clientKind: g.client_kind, expiresAt: new Date(g.expires_at), ip, baseUrl,
    netBound: false, preview: false, scope: { classes: ["open"], tier: "T2", keyKind: "connection" } };
}

export async function oauthPerson(q: Pick<pg.PoolClient, "query">, instanceId: string, claims: OAuthClaims): Promise<PersonRow | "login_unlinked" | null> {
  if (claims.ldapId === null) {
    if (!claims.username) return null;
    const linked = await q.query(`SELECT ${PERSON} FROM people p JOIN person_identities i ON i.person_id=p.id
        WHERE p.login=$1 AND p.instance_id=$2 AND i.system='sso' AND i.external_id=$3 AND i.active FOR UPDATE OF p`,
      [claims.username.trim().toLowerCase(), instanceId, `${claims.issuer}#${claims.subject}`]);
    const p = linked.rows[0];
    const result = linked.rows.length !== 1 ? "login_unlinked" as const : p.active && !p.demo ? p as PersonRow : null;
    log.info("oauth_identity_fallback", { result: result === "login_unlinked" ? "unlinked" : result ? "ok" : "refused" });
    return result;
  }
  const result = await q.query(`SELECT ${PERSON} FROM person_identities i JOIN people p ON p.id=i.person_id
        WHERE i.system='ad' AND i.external_id=$1 AND i.verified AND i.active AND p.instance_id=$2 FOR UPDATE OF p`, [claims.ldapId.toLowerCase(), instanceId]);
  const p = result.rows[0];
  return result.rows.length === 1 && p.active && !p.demo ? p : null;
}

export const oauthTokenExpired = (expiresAt: number, nowSec = Math.floor(Date.now() / 1000)): boolean => expiresAt + OAUTH_EXP_SKEW_SEC <= nowSec;

export async function authenticateOAuth(app: App, token: string, ip: string | null, baseUrl: string): Promise<Caller> {
  await app.settings.load(true);
  // identity provider tokens only in mode external: in builtin and off refused before the signature is checked
  if (agentAuthMode(app.settings) !== "external") return reject();
  const verifiedConfig = oauthConfig(app.settings);
  if (!ready(verifiedConfig)) return reject();
  let claims: OAuthClaims;
  try { claims = await verifyOAuthAccessToken(verifiedConfig, token); } catch { return reject(); }
  // the first sign-in of a connection is an event, written after the transaction committed (a rolled back grant
  // leaves none); the token's subject and SSO session are not written
  let created: Grant | null = null;
  const caller = await policyRead(app, async (q, cfg, settings) => {
    // Verification occurred outside the transaction/network wait. Do not admit it under a different policy.
    if (agentAuthMode(settings) !== "external") return reject();
    if (JSON.stringify(cfg) !== JSON.stringify(verifiedConfig) || oauthTokenExpired(claims.expiresAt)) return reject();
    await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`oauth-tuple:${app.instanceId}:${JSON.stringify([claims.issuer, claims.subject, claims.clientId, claims.sessionId])}`]);
    const person = await oauthPerson(q, app.instanceId, claims);
    if (person === "login_unlinked") return reject("login_unlinked");
    if (!person) return reject();
    let grant = (await q.query<Grant>(`SELECT ${GRANT} FROM oauth_connections c JOIN api_keys k ON k.id=c.id
      WHERE c.instance_id=$1 AND c.issuer=$2 AND c.subject=$3 AND c.client_id=$4 AND c.session_id=$5 AND c.origin='keycloak'`,
      [app.instanceId, claims.issuer, claims.subject, claims.clientId, claims.sessionId])).rows[0];
    if (!grant) {
      const id = newId();
      await q.query(`INSERT INTO api_keys(id,key_prefix,key_hash,auth_method,principal_type,principal_id,kind,tier,instance_id,client_label,client_kind,created_at,expires_at,basis)
        VALUES($1,'oauth',NULL,'oauth','person',$2,'personal','T2',$3,$4,$5,now(),now()+make_interval(days=>$6::int),'OAuth browser login')`,
        [id, person.id, app.instanceId, claims.clientId, claims.clientKind, cfg.connection_days]);
      await q.query(`INSERT INTO oauth_connections(id,instance_id,issuer,subject,client_id,session_id,person_id,resource_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, app.instanceId, claims.issuer, claims.subject, claims.clientId, claims.sessionId, person.id, cfg.resource_url]);
      grant = (await q.query<Grant>(`SELECT ${GRANT} FROM oauth_connections c JOIN api_keys k ON k.id=c.id WHERE c.id=$1`, [id])).rows[0]!;
      created = grant;
    }
    if (!grant || isEdge(grant) || grant.person_id !== person.id || !connectionAllowed(cfg, grant, app.instanceId)) return reject();
    // Fixed expiry: neither refresh nor request activity updates created_at/expires_at.
    await q.query("UPDATE api_keys SET last_used_at=now(),last_used_ip=$2::inet WHERE id=$1", [grant.id, ip]);
    return callerForGrant(grant, person, ip, baseUrl);
  });
  const made = created as Grant | null;
  if (made) await audit(app, caller, { event_type: "admin", details: { op: "oauth_connection_created", connection_id: made.id, origin: "keycloak",
                                                                       client_kind: made.client_kind, client_id: made.client_id, issuer: made.issuer } });
  return caller;
}

export async function oauthCallerForKey(app: App, id: string, ip: string | null, baseUrl: string): Promise<Caller | null> {
  // the mode from the settings cache: off — no query; inside the transaction — by its settings. The SQL of
  // mode external is the former text, builtin has its own (origin builtin and the DCR fact); never origin IN (…)
  if (agentAuthMode(app.settings) === "off") return null;
  return policyRead(app, async (q, cfg, settings) => {
    const mode = agentAuthMode(settings);
    if (mode === "builtin") {
      const facts = await agentAuthFacts(app, q);
      if (agentAuthProblems(settings, facts).length) return null;
      const g = (await q.query<Grant>(`SELECT ${GRANT},(d.client_id IS NOT NULL) AS dcr_live FROM oauth_connections c JOIN api_keys k ON k.id=c.id
        LEFT JOIN agent_oauth_dcr_clients d ON d.client_id=c.client_id AND d.instance_id=c.instance_id AND d.revoked_at IS NULL
        WHERE c.id=$1 AND k.auth_method='oauth' AND c.instance_id=$2 AND c.origin='builtin'`, [id, app.instanceId])).rows[0];
      if (!g || !connectionPolicyAllows(app, settings, g, facts)) return null;
      const p = (await q.query(`SELECT ${PERSON} FROM people p WHERE p.id=$1 AND p.instance_id=$2`, [g.person_id, app.instanceId])).rows[0];
      return p?.active && !p.demo ? { ...callerForGrant(g, p, ip, baseUrl), connectionOrigin: "builtin" } : null;
    }
    if (mode !== "external") return null;
    const g = (await q.query<Grant>(`SELECT ${GRANT} FROM oauth_connections c JOIN api_keys k ON k.id=c.id
      WHERE c.id=$1 AND k.auth_method='oauth' AND c.instance_id=$2 AND c.origin='keycloak'`, [id, app.instanceId])).rows[0];
    if (!g || isEdge(g) || !connectionAllowed(cfg, g, app.instanceId)) return null;
    const p = (await q.query(`SELECT ${PERSON} FROM people p WHERE p.id=$1 AND p.instance_id=$2`, [g.person_id, app.instanceId])).rows[0];
    return p?.active && !p.demo ? callerForGrant(g, p, ip, baseUrl) : null;
  });
}

export function oauthResourceMetadata(app: App): Record<string, unknown> | null {
  const cfg = oauthConfig(app.settings);
  return ready(cfg) ? { resource: cfg.resource_url, authorization_servers: [cfg.issuer], scopes_supported: [cfg.scope], bearer_methods_supported: ["header"] } : null;
}
export function oauthChallenge(app: App): string | null {
  const cfg = oauthConfig(app.settings);
  if (!ready(cfg)) return null;
  const metadata = new URL("/.well-known/oauth-protected-resource/mcp", cfg.resource_url).href;
  return `Bearer resource_metadata="${metadata}", scope="mcp:memory"`;
}
/** The one protected resource metadata path of the built-in server (RFC 9728 §3.1, suffix of the resource path /mcp). */
export const BUILTIN_PRM_PATH = "/.well-known/oauth-protected-resource/mcp";
/**
 * Protected resource metadata of the built-in server: the resource <issuer>/mcp and the issuer as the
 * only authorization server; null while builtin is not ready (the path answers 404). oauth.issuer and oauth.resource_url
 * are not read in builtin.
 */
export function builtinResourceMetadata(s: Pick<Settings, "get">, facts: { schema?: boolean; routes?: boolean }): Record<string, unknown> | null {
  if (agentAuthProblems(s, facts).length) return null;
  const { issuer, resource } = agentAuthIssuer(s);
  return { resource, authorization_servers: [issuer], scopes_supported: ["mcp:memory"], bearer_methods_supported: ["header"] };
}
/**
 * WWW-Authenticate of a 401 on /mcp by the mode: external — oauthChallenge as before, byte for byte;
 * builtin and ready — the same format with the built-in metadata address, and error="invalid_token" first when the request
 * presented a bearer token (RFC 6750 §3.1: claude.ai and ChatGPT start a new sign-in on it); builtin not ready and off —
 * a bare Bearer challenge. The [AS] tables are asked once per process (agentAuthFacts caches «present»); the external path asks nothing.
 */
export async function mcpChallenge(app: App, o: { tokenPresented?: boolean } = {}): Promise<string | null> {
  const mode = agentAuthMode(app.settings);
  if (mode === "external") return oauthChallenge(app) ?? "Bearer";
  if (mode !== "builtin") return "Bearer";
  const metadata = builtinResourceMetadata(app.settings, await builtinFactsOrUnready(app));
  if (!metadata) return "Bearer";
  const { issuer } = agentAuthIssuer(app.settings);
  return `Bearer ${o.tokenPresented ? 'error="invalid_token", ' : ""}resource_metadata="${issuer}${BUILTIN_PRM_PATH}", scope="mcp:memory"`;
}
/**
 * Facts of the built-in server for an answer that must not fail with the database (the PRM, the 401 challenge of /mcp, the
 * connection settings of the workplace): a failed check of the [AS] tables reads as «not ready», as health does.
 */
async function builtinFactsOrUnready(app: App): Promise<{ schema: boolean; routes: boolean }> {
  return agentAuthFacts(app).catch(() => ({ schema: false, routes: agentAuthRoutesServed() }));
}
/** Adapters retain the current token, policy-lock and metadata implementations in each mode. */
export function createAgentAuthProviders(verify = { external: authenticateOAuth, builtin: authenticateBuiltin }) {
  return new ProviderRegistry<never, AgentAuth<App, Caller>>([], [
    {
      mode: "external",
      verifyBearer: verify.external,
      protectedResource: async (app) => oauthResourceMetadata(app),
      challenge: mcpChallenge,
    },
    {
      mode: "builtin",
      verifyBearer: verify.builtin,
      protectedResource: async (app, path) => path === BUILTIN_PRM_PATH
        ? builtinResourceMetadata(app.settings, await builtinFactsOrUnready(app)) : null,
      challenge: mcpChallenge,
    },
    {
      mode: "off",
      verifyBearer: async () => reject(),
      protectedResource: async () => null,
      challenge: mcpChallenge,
    },
  ]);
}
export const agentAuthProviders = createAgentAuthProviders();

/** CORS of the built-in PRM: any origin, the MCP header allowed, no credentials — MCP Inspector, vscode.dev. */
export const BUILTIN_PRM_CORS = { "access-control-allow-origin": "*" } as const;
export const BUILTIN_PRM_PREFLIGHT_HEADERS = {
  ...BUILTIN_PRM_CORS, "access-control-allow-methods": "GET, HEAD, OPTIONS", "access-control-allow-headers": "mcp-protocol-version, content-type",
  "access-control-max-age": "600",
} as const;
export function registerOAuthMetadata(r: Hono<Env>, app: App): void {
  // literal paths: the capability registry reads the routes from this call
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"])
    r.get(path, async (c) => {
      await app.settings.load();
      const mode = agentAuthMode(app.settings);
      const metadata = await agentAuthProviders.agent(mode).protectedResource(app, path);
      if (mode === "builtin") return metadata ? c.json(metadata, 200, BUILTIN_PRM_CORS) : c.notFound();
      return metadata ? c.json(metadata) : c.notFound();
    });
  // the preflight only where the built-in metadata is served; elsewhere (external included) the router's 404 as before
  r.options("/.well-known/oauth-protected-resource/mcp", async (c, next) => {
    if (agentAuthMode(app.settings) !== "builtin" || !builtinResourceMetadata(app.settings, await builtinFactsOrUnready(app))) return next();
    return c.body(null, 204, BUILTIN_PRM_PREFLIGHT_HEADERS);
  });
}

/** Revoke and pending-plan cancellation share one statement/transaction. Already applying plans follow their existing continuation rules. */
export async function revokeWhere(q: Pick<pg.PoolClient, "query">, where: string, values: unknown[]): Promise<number> {
  const out = await q.query(`WITH revoked AS (UPDATE api_keys k SET revoked_at=now() FROM oauth_connections c
    WHERE c.id=k.id AND k.auth_method='oauth' AND k.revoked_at IS NULL AND ${where} RETURNING k.id),
    cancelled AS (UPDATE action_plans SET status='cancelled' WHERE status='pending' AND key_id IN (SELECT id FROM revoked))
    SELECT count(*)::int AS n FROM revoked`, values);
  return out.rows[0]?.n ?? 0;
}
export async function revokeOAuthOutsidePolicy(app: App, cfg: OAuthConfig, transaction?: pg.PoolClient): Promise<number> {
  const run = (q: pg.PoolClient) => revokeWhere(q,
    "c.instance_id=$1 AND c.origin='keycloak' AND (c.issuer<>$2 OR c.resource_url<>$3 OR COALESCE($4::jsonb->>c.client_id,'')<>k.client_kind)",
    [app.instanceId, cfg.issuer, cfg.resource_url, JSON.stringify(cfg.allowed_clients)]);
  return transaction ? run(transaction) : tx(app.db.control, run);
}
export async function revokePersonConnections(app: App, personId: string): Promise<number> {
  return tx(app.db.control, async (q) => {
    const person = await q.query("SELECT 1 FROM people WHERE id=$1 AND instance_id=$2 FOR UPDATE", [personId, app.instanceId]);
    if (!person.rowCount) throw notFound();
    const edge = Number((await q.query<{ n: number }>("SELECT edge_revoke_person($1::uuid, 'admin') AS n", [personId])).rows[0]?.n ?? 0);
    // built-in sign-in: the person's decided transactions and unused codes — in the same transaction, whenever
    // the [AS] tables exist (a cached to_regclass), whatever this process's settings cache says. The cache may still say
    // external for up to its TTL after another gateway switched to builtin: a decided sign-in
    // left behind would mint a code and a new connection after the disconnect. In external the deletes find nothing.
    if (await agentAuthTablesPresent(app, q)) await deletePersonPending(q, app.instanceId, personId);
    return edge + await revokeWhere(q, "c.instance_id=$1 AND c.person_id=$2", [app.instanceId, personId]);
  });
}
export async function agentAuthConnectConfig(app: App): Promise<{ mode: ReturnType<typeof agentAuthMode>; ready: boolean; issuer: string; mcp_url: string; cimd_needs_egress?: boolean }> {
  const mode = agentAuthMode(app.settings);
  if (mode !== "builtin") return { mode, ready: false, issuer: "", mcp_url: "" };
  const ready = agentAuthProblems(app.settings, await builtinFactsOrUnready(app)).length === 0;
  const { issuer, resource } = agentAuthIssuer(app.settings);
  return { mode, ready, issuer, mcp_url: resource, cimd_needs_egress: cimdReadiness(app.settings).cimd_needs_egress };
}
export function registerConnections(r: Hono<Env>, app: App): void {
  const human = async (caller: Caller, bucket: "me_keys" | "me_keys_view") => { await requireHuman(app, caller, "Manage agent connections", { path: "/connect", section: "Connect an agent" }); app.limiter.check(caller, bucket); return caller.person!.id; };
  r.get("/api/v1/me/connections/config", async (c) => {
    await human(c.get("caller"), "me_keys_view"); await app.settings.load(true); const cfg = oauthConfig(app.settings);
    return c.json({ enabled: cfg.enabled, issuer: cfg.issuer, resource_url: cfg.resource_url, scope: cfg.scope, allowed_clients: cfg.allowed_clients, connection_days: cfg.connection_days,
      agent_auth: await agentAuthConnectConfig(app) });
  });
  r.get("/api/v1/me/connections", async (c) => {
    const personId = await human(c.get("caller"), "me_keys_view"), limit = intParam(c.req.query("limit"), 50, 1, 100), cur = decodeKeyset(c.req.query("cursor"));
    const expiring = c.req.query("expiring");
    if (expiring !== undefined && expiring !== "true" && expiring !== "false") throw invalid("expiring: true or false");
    const origin = c.req.query("origin");
    if (origin !== undefined && origin !== "edge" && origin !== "keycloak" && origin !== "builtin") throw invalid("origin: edge, keycloak or builtin");
    const args: unknown[] = [personId, app.instanceId];
    if (cur) args.push(cur.at, cur.id);
    args.push(limit + 1);
    const rows = (await app.db.control.query<Grant & { at_key: string }>(`SELECT ${GRANT},${keysetAtSql("k.created_at")} AS at_key FROM oauth_connections c JOIN api_keys k ON k.id=c.id
      WHERE c.person_id=$1 AND c.instance_id=$2 ${expiring === "true" ? "AND k.revoked_at IS NULL AND k.expires_at>now() AND k.expires_at<=now()+interval '14 days'" : ""} ${origin === "edge" ? "AND c.origin='edge'" : origin === "keycloak" ? "AND c.origin<>'edge' AND c.origin<>'builtin'" : origin === "builtin" ? "AND c.origin='builtin'" : ""} ${cur ? "AND (k.created_at,k.id)<($3::timestamptz,$4::uuid)" : ""}
      ORDER BY k.created_at DESC,k.id DESC LIMIT $${args.length}`, args)).rows;
    const page = rows.slice(0, limit);
    return c.json({ items: page.map((g) => ({ id: g.id, client_id: g.client_id, client_kind: g.client_kind, created_at: g.created_at,
      last_used_at: g.last_used_at, expires_at: g.expires_at, revoked_at: g.revoked_at,
      expires_warning: connectionStatus(g) === "active" ? connectionExpiryWarning(g.expires_at, Date.now(), g.origin) : null, status: connectionStatus(g),
      origin: g.origin ?? "keycloak" })),
      next_cursor: rows.length > limit ? encodeKeyset(page.at(-1)!.at_key, page.at(-1)!.id) : null });
  });
  r.delete("/api/v1/me/connections/:id", async (c) => {
    const caller = c.get("caller"), personId = await human(caller, "me_keys"), id = c.req.param("id");
    if (!isUuidParam(id)) throw notFound();
    const changed = await tx(app.db.control, async (q) => {
      await q.query("SELECT 1 FROM people WHERE id=$1 AND instance_id=$2 FOR UPDATE", [personId, app.instanceId]);
      const own = (await q.query<{ origin: string | null }>("SELECT origin FROM oauth_connections WHERE id=$1 AND person_id=$2 AND instance_id=$3", [id, personId, app.instanceId])).rows[0];
      if (!own) throw notFound();
      if (own.origin === "edge") return (await q.query<{ ok: boolean }>("SELECT edge_revoke_connection($1::uuid, 'self') AS ok", [id])).rows[0]?.ok ? 1 : 0;
      return revokeWhere(q, "c.id=$1 AND c.person_id=$2 AND c.instance_id=$3", [id, personId, app.instanceId]);
    });
    if (changed) await audit(app, caller, { event_type: "admin", details: { op: "connection_revoke_self", connection_id: id } });
    return c.json({ revoked: true });
  });
}
