// The token side of the built-in authorization server for agents: POST /oauth/token (both
// grants) and POST /oauth/revoke (RFC 7009), with their CORS preflights. Only in agent_auth.mode = builtin and only while it
// is ready — in any other mode every method of these paths answers the router's 404 before reading the body or the
// database, and an unready builtin answers the same 404 (the AS routes work while ready, otherwise 404).
//
// Common rules of both endpoints:
//   - the form only: Content-Type application/x-www-form-urlencoded compared without parameters and case, body at
//     most PARAM_LIMITS.form (8 KiB; the transport limit is 16 KiB), parseParams — a repeated parameter is invalid_request;
//   - public clients only (method none): an Authorization header → 401 invalid_client with WWW-Authenticate of the same
//     scheme (RFC 6749 §5.2); client_secret, client_assertion, client_assertion_type → 401 invalid_client;
//   - per-address bucket oauth_token (fallback 600/min: claude.ai and ChatGPT come from one egress) → 429
//     temporarily_unavailable with Retry-After; the address is the one requestChannel derives (access.trusted_proxies);
//   - answers carry Cache-Control: no-store and Access-Control-Allow-Origin: * (no credentials: no cookie is read here);
//     a database that does not answer → 503 temporarily_unavailable with Retry-After, never a bare 500.
//
// authorization_code: the code is spent once under the shared policy lock and the person lock (lock order:
// policy, then the person row, then the code); client_id equal, redirect_uri exact when sent (OAuth 2.1 §10.2 — optional
// here, unlike the edge), PKCE S256, resource equal when sent (invalid_target as RFC 8707 §2.2 and the edge's token endpoint say),
// person active and not demo,
// mode builtin and ready, the code's resource still the current one, the client still allowed by policyAllows. Then the
// connection (api_keys auth_method oauth + oauth_connections origin builtin) and the first pair of tokens in the same
// transaction. A replayed code (used_at set) revokes the connection it made in a separate committed transaction
// (revokeConnectionFamily) before the answer invalid_grant.
//
// refresh_token: one flight per (sha256(rt), client_id, resource) in the process; the person row and then the
// refresh row are locked; the connection must still pass connectionPolicyAllows and belong to the client, resource equal
// when sent (invalid_grant here); idle longer than agent_auth.idle_days → the connection is revoked
// the key row is claimed live (not revoked, not expired, as committed) before anything is rotated. Rotation:
// rt[n+1] = HMAC of rt[n] with a key derived from the application secret, so a lost answer replayed within 60 s (at most 5
// times, while the successor is still the head of the family) gets the same successor; any other use of a replaced token
// (a stored successor this key does not derive included) revokes the connection in a separate committed transaction
// Refresh never extends the connection: only api_keys.last_used_at moves.
//
// Nothing secret is logged or journaled: codes, tokens, verifiers and state never leave the request.
import type pg from "pg";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { agentAuthConfig, agentAuthIssuer, agentAuthMode, agentAuthProblems, clientSource, derivedKey, log, policyAllows } from "@memory/shared";
import {
  ACCESS_PREFIX, CODE_PREFIX, GRANTED_SCOPE, isToken, newToken, NO_STORE, PARAM_LIMITS, parseParams, pkceMatches, REFRESH_PREFIX, sha256, successor,
  tokenError, verifierOk, type Params, type TokenErrorCode,
} from "@memory/shared/oauth-as";
import type { App, PersonRow } from "../context.ts";
import { audit } from "../audit.ts";
import { requestChannel, type RequestChannel } from "../channel.ts";
import { addressKey } from "../preauth.ts";
import { callerForGrant, connectionPolicyAllows, GRANT, PERSON, policyRead, type Grant } from "../oauth.ts";
import { agentAuthPolicyPrint, samePolicyPrint } from "./policy-step.ts";
import { agentAuthFacts, agentAuthTablesPresent, markAgentAuthRoutesServed } from "./readiness.ts";
import { parseResourceParams } from "./resource-params.ts";
import { normalizeResource, resolveRegistryClient } from "./routes-authorize.ts";
import {
  codeByHash, createBuiltinConnection, dcrClient, deleteAccessToken, insertAccessToken, insertRefreshToken, lockRefreshToken, markRotated, noteDcrUsed,
  noteReplay, revokeConnectionFamily, setCodeConnection, sweepAgentAuth, tokenByHash, useCode,
} from "./store.ts";

type Q = Pick<pg.PoolClient, "query">;

/** Access token lifetime: an hour, never past the connection. */
export const ACCESS_TTL_SEC = 3600;
/** Key of the refresh successor HMAC: derived from the application secret; kid 1 is the only one so far. */
export const REFRESH_KEY_INFO = "memory-agent-auth/refresh/1";
export const REFRESH_KEY_KID = 1;
/** Transport limit of the body of /oauth/token and /oauth/revoke; the form itself is PARAM_LIMITS.form. */
export const TOKEN_BODY_MAX = 16 * 1024;
/** Per-address bucket of both endpoints and its fallback without a row in limits.personal_per_minute. */
export const TOKEN_BUCKET = "oauth_token";
export const TOKEN_BUCKET_FALLBACK = 600;
/** Retry-After of a 503 when the database did not answer. */
const RETRY_AFTER_SEC = 30;

const CORS = { "access-control-allow-origin": "*" } as const;
/** Preflight of the token, revocation and registration endpoints: no credentials, no Authorization header. */
export const TOKEN_PREFLIGHT_HEADERS = {
  ...CORS, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type", "access-control-max-age": "600",
} as const;

export interface TokenSuccess { access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string; scope: string }
export type TokenFailure = { ok: false; error: TokenErrorCode; challenge?: string; status?: number; retryAfter?: number; reason?: string };
export type TokenResult = { ok: true; body: TokenSuccess } | TokenFailure;
/** Refresh requests in flight in this process: key — sha256(rt), client_id and resource. */
export type RefreshFlights = Map<string, Promise<TokenResult>>;

export interface TokenRequest {
  contentType: string | null;
  /** The Authorization header (a public client sends none). */
  authorization: string | null;
  body: string;
  /** Client address as requestChannel derived it (last_used_ip of the connection). */
  ip: string | null;
}

const FORM_TYPE = "application/x-www-form-urlencoded";
/** The form media type, compared without parameters and case (`…;charset=UTF-8`, `Application/X-WWW-Form-Urlencoded`). */
export function isFormContentType(v: string | null | undefined): boolean {
  return (v ?? "").split(";")[0]!.trim().toLowerCase() === FORM_TYPE;
}

export { normalizeResource };

// name of the HTTP authentication scheme (RFC 9110 §11.1)
const AUTH_SCHEME = /^([!#$%&'*+.^_`|~0-9A-Za-z-]{1,32})(?:\s|$)/;
/** WWW-Authenticate of invalid_client for a client that sent Authorization (RFC 6749 §5.2): its scheme, realm "memory". */
export function clientChallenge(authorization: string): string {
  const scheme = AUTH_SCHEME.exec(authorization.trim())?.[1]?.toLowerCase();
  return `${scheme === "bearer" ? "Bearer" : "Basic"} realm="memory"`;
}

const fail = (error: TokenErrorCode, reason?: string, o: Omit<TokenFailure, "ok" | "error" | "reason"> = {}): TokenFailure => ({ ok: false, error, ...(reason ? { reason } : {}), ...o });
const unavailable = (reason: string): TokenFailure => fail("temporarily_unavailable", reason, { retryAfter: RETRY_AFTER_SEC });

/** The answer of the token endpoint (RFC 6749 §5.1, §5.2): JSON, no-store, CORS without credentials. */
export function tokenResponse(r: TokenResult): Response {
  if (!r.ok) {
    const extra: Record<string, string> = { ...CORS };
    if (r.challenge) extra["www-authenticate"] = r.challenge;
    if (r.retryAfter) extra["retry-after"] = String(r.retryAfter);
    return tokenError(r.error, extra, r.status);
  }
  return new Response(JSON.stringify(r.body), { status: 200, headers: { "content-type": "application/json", ...NO_STORE, ...CORS } });
}

/** Form, public client: what both endpoints check before anything else. null — fine. */
function formProblem(r: TokenRequest, p: Params): TokenFailure | null {
  if (!isFormContentType(r.contentType) || p.problem) return fail("invalid_request", p.problem ?? "content_type");
  // the Authorization header first: client_secret_basic sends client_id only there (RFC 6749 §2.3.1)
  if (r.authorization) return fail("invalid_client", "authorization_header", { challenge: clientChallenge(r.authorization) });
  if (p.get("client_secret") || p.get("client_assertion") || p.get("client_assertion_type")) return fail("invalid_client", "client_secret");
  return null;
}

/**
 * Does this process answer the token side now (the AS routes work only in builtin and only while it is ready):
 * "off" — another mode (read from the settings cache, no query) or builtin with a readiness problem: the router's 404;
 * "ready" — serve; "unavailable" — the database did not say whether the [AS] tables are there: 503, never a bare 500.
 */
export async function tokenSideState(app: Pick<App, "settings" | "db">): Promise<"off" | "ready" | "unavailable"> {
  if (agentAuthMode(app.settings) !== "builtin") return "off";
  let facts: { schema: boolean; routes: boolean };
  try { facts = await agentAuthFacts(app); } catch { return "unavailable"; }
  return agentAuthProblems(app.settings, facts).length ? "off" : "ready";
}

/** Access token of a connection, inserted in the transaction: an hour at most and never past the connection. */
async function issueAccess(q: Q, app: Pick<App, "instanceId">, connectionId: string, connectionExpires: Date): Promise<{ token: string; expiresIn: number }> {
  const now = Date.now();
  const expires = new Date(Math.min(now + ACCESS_TTL_SEC * 1000, new Date(connectionExpires).getTime()));
  const token = newToken(ACCESS_PREFIX);
  await insertAccessToken(q, { token_hash: sha256(token), instance_id: app.instanceId, connection_id: connectionId, expires_at: expires });
  return { token, expiresIn: Math.max(0, Math.round((expires.getTime() - now) / 1000)) };
}

type PersonLocked = PersonRow & { demo: boolean };
const lockPerson = async (q: Q, app: Pick<App, "instanceId">, personId: string): Promise<PersonLocked | undefined> =>
  (await q.query(`SELECT ${PERSON} FROM people p WHERE p.id=$1 AND p.instance_id=$2 FOR UPDATE`, [personId, app.instanceId])).rows[0] as PersonLocked | undefined;

// ---------------------------------------------------------------- grant_type=authorization_code

type CodeOutcome =
  | { kind: "ok"; body: TokenSuccess; grant: Grant; person: PersonLocked; source: string }
  | { kind: "refused"; failure: TokenFailure }
  | { kind: "replay"; connectionId: string | null; clientId: string };

async function codeGrant(app: App, p: Params, clientId: string, ip: string | null): Promise<TokenResult> {
  const code = p.get("code");
  if (!code) return fail("invalid_request", "no_code");
  if (!isToken(CODE_PREFIX, code)) return fail("invalid_grant", "code_shape");
  const redirectUri = p.get("redirect_uri"), verifier = p.get("code_verifier"), resourceParam = p.get("resource");
  const hash = sha256(code);
  const out = await policyRead(app, async (q, _cfg, settings): Promise<CodeOutcome> => {
    const refused = (error: TokenErrorCode, reason: string): CodeOutcome => ({ kind: "refused", failure: fail(error, reason) });
    const known = await codeByHash(q, app.instanceId, hash);
    if (!known) return refused("invalid_grant", "code_unknown");
    // the person lock before the code: «disconnect all» and the trigger of 17 [AS] take it first too
    const person = await lockPerson(q, app, known.person_id);
    const row = await useCode(q, app.instanceId, hash);
    if (!row) {
      // read again under the person lock: an exchange that held it may have spent the code since the first read
      const now = await codeByHash(q, app.instanceId, hash);
      return now?.used_at ? { kind: "replay", connectionId: now.connection_id, clientId: now.client_id } : refused("invalid_grant", "code_expired");
    }
    // the code is spent from here on: a refusal below commits it spent (single use, T1)
    if (row.client_id !== clientId) return refused("invalid_grant", "client");
    if (redirectUri !== undefined && redirectUri !== row.redirect_uri) return refused("invalid_grant", "redirect_uri");
    if (!verifierOk(verifier) || !pkceMatches(verifier, row.code_challenge)) return refused("invalid_grant", "pkce");
    if (resourceParam !== undefined && normalizeResource(resourceParam) !== row.resource) return refused("invalid_target", "resource");
    if (!person?.active || person.demo) return refused("invalid_grant", "person");
    if (agentAuthMode(settings) !== "builtin" || agentAuthProblems(settings, await agentAuthFacts(app, q)).length) return refused("invalid_grant", "mode");
    const { issuer, resource } = agentAuthIssuer(settings);
    if (row.resource !== resource) return refused("invalid_grant", "resource_changed");
    const cfg = agentAuthConfig(settings);
    const dcrLive = row.client_source === "dcr" ? (await dcrClient(q, app.instanceId, row.client_id))?.revoked_at === null : undefined;
    if (!policyAllows(cfg, { client_id: row.client_id, kind: row.client_kind, source: row.client_source, ...(dcrLive !== undefined ? { dcr_live: dcrLive } : {}) }))
      return refused("invalid_grant", "policy");
    // The code was minted under the rules of now (settings of the database under the shared lock) — a
    // gateway with an older settings cache did not mint it under rules that are gone
    if (!samePolicyPrint(row.policy_print, agentAuthPolicyPrint(settings))) return refused("invalid_grant", "policy_changed");
    // a registry client: its return address is still one of the row's now (the registry entry, not the cache that checked it)
    if (row.client_source === "registry") {
      const reg = await resolveRegistryClient(app, row.client_id, settings);
      if (!reg.ok || reg.client.view(row.redirect_uri)?.redirect.uri !== row.redirect_uri) return refused("invalid_grant", "redirect_gone");
    }
    const conn = await createBuiltinConnection(q, { instance_id: app.instanceId, person_id: row.person_id, grant_id: row.grant_id, client_id: row.client_id,
      client_kind: row.client_kind, client_label: row.client_label.slice(0, 80), issuer, resource: row.resource, consent_version: row.consent_version,
      connection_days: cfg.connection_days });
    await setCodeConnection(q, app.instanceId, hash, conn.id);
    if (row.client_source === "dcr") await noteDcrUsed(q, app.instanceId, row.client_id);
    const at = await issueAccess(q, app, conn.id, conn.expires_at);
    const rt = newToken(REFRESH_PREFIX);
    await insertRefreshToken(q, { token_hash: sha256(rt), instance_id: app.instanceId, connection_id: conn.id, generation: 1, k_rt_kid: REFRESH_KEY_KID, expires_at: conn.expires_at });
    const grant = (await q.query<Grant>(`SELECT ${GRANT} FROM oauth_connections c JOIN api_keys k ON k.id=c.id WHERE c.id=$1`, [conn.id])).rows[0]!;
    return { kind: "ok", grant, person, source: row.client_source,
             body: { access_token: at.token, token_type: "Bearer", expires_in: at.expiresIn, refresh_token: rt, scope: GRANTED_SCOPE } };
  });
  if (out.kind === "refused") return out.failure;
  if (out.kind === "replay") {
    // a replayed code (RFC 6749 §4.1.2, T2): the connection it made goes, committed before the answer
    if (out.connectionId) await revokeConnectionFamily(app, out.connectionId);
    await audit(app, null, { event_type: "auth_failure", ip, details: { op: "oauth_code_replay", client_id: out.clientId.slice(0, 255),
      ...(out.connectionId ? { connection_id: out.connectionId } : {}) } });
    return fail("invalid_grant", "code_replay");
  }
  await audit(app, callerForGrant(out.grant, out.person, ip, ""), { event_type: "admin", ip,
    details: { op: "oauth_connection_created", connection_id: out.grant.id, client_source: out.source, client_kind: out.grant.client_kind } });
  return { ok: true, body: out.body };
}

// ---------------------------------------------------------------- grant_type=refresh_token

type RefreshOutcome =
  | { kind: "ok"; body: TokenSuccess }
  | { kind: "refused"; failure: TokenFailure }
  | { kind: "replay" | "idle"; connectionId: string; clientId: string };

/** Refresh with one flight: parallel requests with the same token, client and resource get one and the same answer. */
export function refreshGrant(app: App, flights: RefreshFlights, i: { refreshToken: string; clientId: string; resource?: string; ip: string | null }): Promise<TokenResult> {
  const key = `${sha256(i.refreshToken).toString("hex")}|${i.clientId}|${i.resource ?? ""}`;
  const inFlight = flights.get(key);
  if (inFlight) return inFlight;
  const run = refreshOnce(app, i).finally(() => flights.delete(key));
  flights.set(key, run);
  return run;
}

async function refreshOnce(app: App, i: { refreshToken: string; clientId: string; resource?: string; ip: string | null }): Promise<TokenResult> {
  const hash = sha256(i.refreshToken);
  const out = await policyRead(app, async (q, _cfg, settings): Promise<RefreshOutcome> => {
    const refused = (error: TokenErrorCode, reason: string): RefreshOutcome => ({ kind: "refused", failure: fail(error, reason) });
    const cfg = agentAuthConfig(settings);
    const peek = await tokenByHash(q, app.instanceId, hash, "rt");
    if (!peek) return refused("invalid_grant", "unknown");
    const g = (await q.query<Grant & { idle: boolean }>(`SELECT ${GRANT},(d.client_id IS NOT NULL) AS dcr_live,
        (COALESCE(k.last_used_at,k.created_at) < now() - make_interval(days => $3::int)) AS idle
      FROM oauth_connections c JOIN api_keys k ON k.id=c.id
      LEFT JOIN agent_oauth_dcr_clients d ON d.client_id=c.client_id AND d.instance_id=c.instance_id AND d.revoked_at IS NULL
      WHERE c.id=$1 AND c.instance_id=$2 AND c.origin='builtin' AND k.auth_method='oauth'`, [peek.connection_id, app.instanceId, cfg.idle_days])).rows[0];
    if (!g) return refused("invalid_grant", "connection");
    // lock order: the person row before the token rows (revokeConnectionFamily locks the person, then deletes tokens)
    const person = await lockPerson(q, app, g.person_id);
    const row = await lockRefreshToken(q, app.instanceId, hash);
    if (!row || row.connection_id !== g.id) return refused("invalid_grant", "unknown");
    if (g.client_id !== i.clientId) return refused("invalid_grant", "client");
    // On refresh the resource, when sent, is the connection's, and any failure of this check is invalid_grant —
    // unlike the code grant (invalid_target there, RFC 8707 §2.2): a client that gets invalid_grant on refresh drops its
    // tokens and signs in again (the MCP SDK does), while invalid_target would stop it; the connection stays as it is
    if (i.resource !== undefined && normalizeResource(i.resource) !== g.resource_url) return refused("invalid_grant", "resource");
    if (!person?.active || person.demo) return refused("invalid_grant", "person");
    if (!connectionPolicyAllows(app, settings, g, await agentAuthFacts(app, q))) return refused("invalid_grant", "policy");
    if (g.idle) return { kind: "idle", connectionId: g.id, clientId: g.client_id };
    if (row.k_rt_kid !== null && row.k_rt_kid !== REFRESH_KEY_KID) return refused("invalid_grant", "k_rt_kid");
    // The connection row was read before the person lock: a revocation that held the lock (DELETE /me/connections/:id,
    // «disconnect all») or the key row (revokeWhere updates api_keys) and committed while this request waited is not in
    // `g`. The time of use is therefore claimed only on a live key, before anything is rotated or issued: this UPDATE reads
    // the committed row (and waits for a revocation still holding it), so a revoked or expired connection gets
    // invalid_grant, never a new pair. Refresh never extends the connection: only the time of use moves (the idle term).
    const live = await q.query("UPDATE api_keys SET last_used_at=now(), last_used_ip=$2::inet WHERE id=$1 AND revoked_at IS NULL AND expires_at>now()", [g.id, i.ip]);
    if (!live.rowCount) return refused("invalid_grant", "connection");
    const next = successor(i.refreshToken, derivedKey(app.appSecret, REFRESH_KEY_INFO), REFRESH_PREFIX);
    const nextHash = sha256(next);
    if (row.rotated_at === null) {
      if (!(await markRotated(q, app.instanceId, hash, nextHash))) return refused("invalid_grant", "rotated");
      await insertRefreshToken(q, { token_hash: nextHash, instance_id: app.instanceId, connection_id: g.id, generation: row.generation + 1, k_rt_kid: REFRESH_KEY_KID,
        expires_at: new Date(g.expires_at) });
    } else {
      // a replaced token: within the window, while its successor is still the head of the family and at most 5 times —
      // the same successor (a lost answer); any other use of a replaced token is a replay (the connection goes). A
      // stored successor that is not the one this key derives (another application secret, a row written otherwise) is
      // such a use too: the lost answer cannot be given again, and the family is revoked rather than left to idle out
      if (!row.successor_hash || !nextHash.equals(row.successor_hash)) return { kind: "replay", connectionId: g.id, clientId: g.client_id };
      if (!(await noteReplay(q, app.instanceId, hash))) return { kind: "replay", connectionId: g.id, clientId: g.client_id };
    }
    // an automatically registered client in use: the panel shows when it was last used
    if (clientSource(g.client_id) === "dcr") await noteDcrUsed(q, app.instanceId, g.client_id);
    const at = await issueAccess(q, app, g.id, g.expires_at);
    return { kind: "ok", body: { access_token: at.token, token_type: "Bearer", expires_in: at.expiresIn, refresh_token: next, scope: GRANTED_SCOPE } };
  });
  if (out.kind === "ok") return { ok: true, body: out.body };
  if (out.kind === "refused") return out.failure;
  // replay or idle: the connection goes in a transaction of its own, committed before the answer
  const r = await revokeConnectionFamily(app, out.connectionId);
  if (out.kind === "replay")
    await audit(app, null, { event_type: "auth_failure", ip: i.ip, details: { op: "oauth_refresh_replay", connection_id: out.connectionId, client_id: out.clientId.slice(0, 255) } });
  else if (r.revoked)
    await audit(app, null, { event_type: "admin", ip: i.ip, details: { op: "oauth_connection_revoked", via: "idle", connection_id: out.connectionId } });
  return fail("invalid_grant", out.kind === "replay" ? "refresh_replay" : "idle");
}

// ---------------------------------------------------------------- the endpoints

/** POST /oauth/token without HTTP framing (the route reads the request; tests call it directly). */
export async function tokenEndpoint(app: App, r: TokenRequest, flights: RefreshFlights): Promise<TokenResult> {
  const { params: p, resourceConflict } = parseResourceParams(r.body, PARAM_LIMITS.form, normalizeResource);
  const problem = formProblem(r, p);
  if (problem) return problem;
  const grantType = p.get("grant_type");
  if (!grantType) return fail("invalid_request", "no_grant_type");
  if (grantType !== "authorization_code" && grantType !== "refresh_token") return fail("unsupported_grant_type", "grant_type");
  const clientId = p.get("client_id");
  if (!clientId) return fail("invalid_request", "no_client_id");
  if (resourceConflict) return fail(grantType === "authorization_code" ? "invalid_target" : "invalid_grant", "resource");
  try {
    if (!(await agentAuthTablesPresent(app))) return unavailable("schema");
    void sweepAgentAuth(app, { limits: agentAuthConfig(app.settings).dcr_limits });
    if (grantType === "authorization_code") return await codeGrant(app, p, clientId, r.ip);
    const rt = p.get("refresh_token");
    if (!rt) return fail("invalid_request", "no_refresh_token");
    if (!isToken(REFRESH_PREFIX, rt)) return fail("invalid_grant", "refresh_shape");
    return await refreshGrant(app, flights, { refreshToken: rt, clientId, resource: p.get("resource"), ip: r.ip });
  } catch (e) {
    // the database did not answer or refused a write: no details outside, the client retries
    log.warn("agent_auth_token_failed", { grant_type: grantType, error: ((e as Error)?.message ?? "").slice(0, 160) });
    return unavailable("store");
  }
}

const revokeOk = (): Response => new Response(null, { status: 200, headers: { ...NO_STORE, ...CORS } });

/**
 * POST /oauth/revoke without HTTP framing (RFC 7009). Always 200 with an empty body, whether the token was found or not (not
 * an oracle), except a malformed request (400 invalid_request), a confidential client (401 invalid_client) and a database
 * that did not answer (503: the client must keep treating the token as live and retry, RFC 7009 §2.2.1). client_id is
 * optional (a public client may not send it); when sent it must be the connection's, otherwise nothing is done.
 * mem_ort_ — the whole connection is revoked and its tokens deleted; mem_oat_ — only that access token is deleted.
 */
export async function revokeEndpoint(app: App, r: TokenRequest): Promise<Response> {
  const p = parseParams(r.body, PARAM_LIMITS.form);
  const problem = formProblem(r, p);
  if (problem) return tokenResponse(problem);
  const token = p.get("token");
  if (!token) return tokenResponse(fail("invalid_request", "no_token"));
  const clientId = p.get("client_id");
  const kind = isToken(REFRESH_PREFIX, token) ? "rt" as const : isToken(ACCESS_PREFIX, token) ? "at" as const : null;
  if (!kind) return revokeOk();
  try {
    if (!(await agentAuthTablesPresent(app))) return tokenResponse(unavailable("schema"));
    const hash = sha256(token);
    const found = (await app.db.control.query<{ connection_id: string; client_id: string }>(`SELECT t.connection_id, c.client_id FROM agent_oauth_tokens t
        JOIN oauth_connections c ON c.id=t.connection_id AND c.instance_id=t.instance_id
      WHERE t.token_hash=$1 AND t.instance_id=$2 AND t.kind=$3 AND c.origin='builtin'`, [hash, app.instanceId, kind])).rows[0];
    if (!found || (clientId !== undefined && found.client_id !== clientId)) return revokeOk();
    if (kind === "at") await deleteAccessToken(app.db.control, app.instanceId, hash);
    else {
      const out = await revokeConnectionFamily(app, found.connection_id);
      if (out.revoked) await audit(app, null, { event_type: "admin", ip: r.ip, details: { op: "oauth_connection_revoked", via: "client", connection_id: found.connection_id } });
    }
  } catch (e) {
    log.warn("agent_auth_revoke_failed", { error: ((e as Error)?.message ?? "").slice(0, 160) });
    return tokenResponse(unavailable("store"));
  }
  return revokeOk();
}

/** The per-address bucket (the address as addressKey counts it — IPv6 by /64): null — within it, otherwise the 429 answer. */
function limited(app: App, rc: Pick<RequestChannel, "ip">): Response | null {
  const hit = app.limiter.takeAnonymous(TOKEN_BUCKET, rc.ip ? addressKey(rc.ip) : "unknown", TOKEN_BUCKET_FALLBACK);
  return hit ? tokenResponse(fail("temporarily_unavailable", "rate", { status: 429, retryAfter: Math.max(1, Math.ceil(hit.retryAfter)) })) : null;
}

/**
 * The body within TOKEN_BODY_MAX (16 KiB on /oauth/*) as Hono's bodyLimit checks it — a declared Content-Length, or
 * the stream read up to the limit; null — over the limit. Called inside the handler, after the mode and readiness check:
 * outside builtin the path is the router's 404 whatever the body. Registration (dcr.ts) reads its body the same way.
 */
export async function bodyWithin(c: Context): Promise<string | null> {
  let over = false;
  await bodyLimit({ maxSize: TOKEN_BODY_MAX, onError: () => { over = true; return new Response(null, { status: 413 }); } })(c, async () => undefined);
  return over ? null : c.req.text();
}

/**
 * Register POST and OPTIONS of /oauth/token and /oauth/revoke on the REST router, before the key check: these requests carry
 * no key. This function is the token side only and marks the "token" part of the AS routes (readiness.ts); the authorize
 * side (registerAgentAuthAuthorize, routes-authorize.ts) and the consent API (registerConsentApi, consent-api.ts) mark
 * theirs. builtin is ready only when all three parts are served. Outside builtin, and in builtin while it is not ready,
 * every method calls next(): the router's own 404 (NOT_FOUND_BODY of http.ts), byte for byte the answer of an unknown
 * path, without a query in external. Order in builtin: readiness, the per-address bucket, the 16 KiB body, then
 * the endpoint.
 */
export function registerAgentAuthToken(r: Hono<any>, app: App, remoteOf: (c: Context) => string | null, flights: RefreshFlights = new Map()): void {
  markAgentAuthRoutesServed("token");
  const serve = (endpoint: (rq: TokenRequest) => Promise<Response>) => async (c: Context, next: () => Promise<void>): Promise<Response | void> => {
    const st = await tokenSideState(app);
    if (st === "off") return next();
    if (st === "unavailable") return tokenResponse(unavailable("schema_unknown"));
    const rc = await requestChannel(app, c.req.raw, remoteOf(c));
    const refusal = limited(app, rc);
    if (refusal) return refusal;
    const body = await bodyWithin(c);
    if (body === null) return tokenResponse(fail("invalid_request", "body_too_large"));
    return endpoint({ contentType: c.req.header("content-type") ?? null, authorization: c.req.header("authorization") || null, body, ip: rc.ip });
  };
  for (const path of ["/oauth/token", "/oauth/revoke"])
    r.options(path, async (c, next) => ((await tokenSideState(app)) === "ready" ? new Response(null, { status: 204, headers: TOKEN_PREFLIGHT_HEADERS }) : next()));
  r.post("/oauth/token", serve(async (rq) => {
    const res = await tokenEndpoint(app, rq, flights);
    if (!res.ok) log.info("agent_auth_token_refused", { error: res.error, reason: res.reason ?? null });
    return tokenResponse(res);
  }));
  r.post("/oauth/revoke", serve((rq) => revokeEndpoint(app, rq)));
}
