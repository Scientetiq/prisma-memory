// The authorize side of the built-in authorization server for agents:
//   GET, HEAD, OPTIONS /.well-known/oauth-authorization-server — metadata (RFC 8414);
//   GET /oauth/authorize          — step 1: checks, the sign-in transaction, the browser cookie, 302 to the workplace;
//   GET /oauth/authorize/continue — step 5: the browser comes back from the workplace with the continuation key c,
//                                   the transaction is taken once, the code goes to the app.
// The token side (/oauth/token, /oauth/revoke) and registration (/oauth/register) are other modules.
//
// Mode first: the routes read agent_auth.mode from the settings cache (app.settings.get, no query, no reload)
// and outside builtin call next() — the router's own 404, byte for byte the answer of an unknown path; external does not
// touch the database here at all. In builtin an unready server (agentAuthProblems not empty) is a 404 too.
//
// Clients: resolveClient looks a client_id up by its source — the registry agent_auth.clients here;
// client metadata documents (https://…) and automatic registration (dcr_…) plug in through
// setClientResolver. Until a resolver is installed its source is refused (invalid_client) and the metadata do not
// announce it (client_id_metadata_document_supported, registration_endpoint).
//
// What never leaves this module: the cookie secret, the CSRF value, the continuation key, the code and the value of state.
// The audit event of a refusal (auth_failure, details.op oauth_refused) carries the code, the client_id (public), the host
// of the return address, lengths and the normalised resource only.
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { agentAuthConfig, agentAuthIssuer, agentAuthMode, agentAuthProblems, clientSource, log, registryClient, tx, type ClientSource, type Settings } from "@memory/shared";
import {
  asMetadata, challengeOk, CODE_PREFIX, cimdEnabled, cimdPolicyFrom, clearCookie, cookieSecret, errorDescription, hostCookie, isLoopbackRedirectUri, matchRedirect, newToken,
  parseParams, parseRedirect, PARAM_LIMITS, randomSecret, sha256, TX_COOKIE, withParams, type AsTextCode, type AuthorizeErrorCode, type RedirectMode,
} from "@memory/shared/oauth-as";
import type { App, Caller } from "../context.ts";
import { audit } from "../audit.ts";
import { requestChannel, requestHost } from "../channel.ts";
import { BUILTIN_PRM_PREFLIGHT_HEADERS, oauthPolicyLock } from "../oauth.ts";
import { addressKey, netPrefix, preauthLimits } from "../preauth.ts";
import { errorPage, methodNotAllowedPage, rateLimitedPage, returnPage, type CimdRefusal } from "./pages.ts";
import { agentAuthPolicyPrint, samePolicyPrint } from "./policy-step.ts";
import { agentAuthFacts, markAgentAuthRoutesServed } from "./readiness.ts";
import { parseResourceParams } from "./resource-params.ts";
import { insertCode, insertTxCapped, readTx, sweepAgentAuth, takeTx, TX_TTL_SEC, type ClientSourceCol, type TxRow } from "./store.ts";

type Env = { Variables: { caller: Caller } };
type Getter = Pick<Settings, "get">;

/** Limit of the whole query string of GET /oauth/authorize; the copy of PARAM_LIMITS stays as the edge's. */
export const AUTHORIZE_QUERY_MAX = 8192;
/** state up to 2048 (the edge allows 512): the length of ChatGPT's state is not known, redirect_uri is up to 2048 anyway. */
export const STATE_MAX = 2048;
/** client_id up to the column oauth_connections.client_id. */
export const CLIENT_ID_MAX = 255;
/** Fallbacks of the anonymous buckets (limits.personal_per_minute has no row for them; the seed does not change). */
export const AUTHORIZE_PER_MIN = 60;
export const AUTHORIZE_NET_PER_MIN = 240;
/** Retry-After of the page when a client lookup is busy (CIMD downloads at their concurrency limit). */
export const BUSY_RETRY_SEC = 5;
/** Version of the consent text the person saw (agent_oauth_tx.consent_version → the code → the connection). */
export const CONSENT_VERSION = 1;

// ---------------------------------------------------------------- readiness of the built-in server

export interface BuiltinState { issuer: string; resource: string; workplace: string }

/**
 * The built-in server is on and ready: mode builtin (from the cache) and no readiness problem (addresses, apps, the [AS]
 * tables, the routes). null — the AS routes answer the router's 404. Outside builtin nothing is queried.
 */
export async function builtinState(app: Pick<App, "settings" | "db">): Promise<BuiltinState | null> {
  if (agentAuthMode(app.settings) !== "builtin") return null;
  if (agentAuthProblems(app.settings, await agentAuthFacts(app)).length) return null;
  const a = agentAuthIssuer(app.settings);
  return a.issuer && a.workplace ? { issuer: a.issuer, resource: a.resource, workplace: a.workplace } : null;
}

// ---------------------------------------------------------------- clients (extension point for CIMD and DCR)

/** How a client appears for one return address: what the transaction stores and the consent screen shows. */
export interface ClientView {
  kind: string;
  /** title on the consent page: a registry title, the pinned title of a known document, otherwise a host (≤ 120) */
  title: string;
  known: boolean;
  /** the client's own name (CIMD client_name, DCR client_name) — only for "It calls itself …" */
  name: string | null;
  /** client_label of a connection made through this return address (≤ 80) */
  label: string;
  redirect: { uri: string; mode: RedirectMode };
  /**
   * May errors before consent be sent to this return address (RFC 9700 §4.11.2: the AS "MUST only
   * automatically redirect the user agent if it trusts the redirection URI")? true — a registry row (the administrator
   * listed it), a document under an agent_auth.cimd_hosts entry, or a loopback address (the person's own computer); false — an
   * https address an anonymous caller chose: an automatically registered client, a document admitted only by
   * cimd_any_https. Then the error is the page, and the person first meets the address on the consent screen with its
   * "App not on the list of known apps" mark.
   */
  redirectTrusted: boolean;
}

export interface ResolvedClient {
  id: string;
  source: ClientSource;
  /** The client for this return address; null — the address is not allowed (invalid_redirect_uri). */
  view(redirectUri: unknown): ClientView | null;
  /** After a transaction of this client was stored (DCR: last_authorize_at). A failure is logged, the sign-in goes on. */
  onAuthorize?(app: App): Promise<void>;
}

/**
 * busy — the lookup could not run now (CIMD: too many document downloads at once): not the app's fault, the
 * page is temporarily_unavailable and nothing is spent.
 */
export type ClientResolution = { ok: true; client: ResolvedClient } | { ok: false; cimd?: CimdRefusal; busy?: true };
/** Who asks (the client address of the request — the CIMD refusal event is throttled by it). */
export interface ResolveContext { ip?: string | null }
/** Look a client up (network allowed — never inside a database transaction). */
export type ClientResolver = (app: App, clientId: string, settings: Getter, ctx?: ResolveContext) => Promise<ClientResolution>;

/** The return address is an app on this computer (http loopback, RFC 8252 §7.3): the consent screen says so. */
export const isLoopbackRedirect = (uri: unknown): boolean => isLoopbackRedirectUri(uri);

/** Host of a return address for the consent screen and the audit: http(s) host, the authority of a custom scheme; "" — none. */
export function returnHost(uri: unknown): string {
  const p = parseRedirect(uri);
  if (p) return p.host;
  if (typeof uri !== "string") return "";
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#@]*)/i.exec(uri);
  return m ? m[1]!.toLowerCase().slice(0, 253) : "";
}

/** A registry row of agent_auth.clients: enabled, kind and title of the row, always "known" (the administrator listed it). */
export const resolveRegistryClient: ClientResolver = async (_app, clientId, settings) => {
  const row = registryClient(settings.get<unknown>("agent_auth.clients", []), clientId);
  if (!row) return { ok: false };
  return {
    ok: true,
    client: {
      id: row.client_id, source: "registry",
      view(redirectUri) {
        const m = matchRedirect({ redirects: row.redirects }, redirectUri);
        return m.ok ? { kind: row.kind, title: row.title, known: true, name: null, label: row.title, redirect: { uri: m.uri, mode: m.mode }, redirectTrusted: true } : null;
      },
    },
  };
};

const resolvers: Partial<Record<ClientSource, ClientResolver>> = { registry: resolveRegistryClient };

/**
 * Install (or with null remove) the resolver of client metadata documents (cimd) or of automatically registered
 * clients (dcr). The metadata announce a source only while its resolver is installed and the settings enable it.
 */
export function setClientResolver(source: "cimd" | "dcr", r: ClientResolver | null): void {
  if (r) resolvers[source] = r; else delete resolvers[source];
}
/** Is a resolver installed for this source. */
export const clientSourceServed = (source: ClientSource): boolean => resolvers[source] !== undefined;

/**
 * The client of a client_id: by source — https:// a client metadata document, dcr_… automatic
 * registration, otherwise the registry. Longer than 255 or a source without a resolver — refused without any lookup.
 */
export async function resolveClient(app: App, clientId: unknown, settings: Getter = app.settings, ctx: ResolveContext = {}): Promise<ClientResolution> {
  if (typeof clientId !== "string" || clientId.length < 1 || clientId.length > CLIENT_ID_MAX) return { ok: false };
  const r = resolvers[clientSource(clientId)];
  return r ? r(app, clientId, settings, ctx) : { ok: false };
}

/**
 * A requested resource indicator (RFC 8707) in the form it is compared in: scheme and host lower case, the default port
 * dropped, one trailing "/" of the path dropped; a query, a fragment (even empty) or credentials — null (invalid_target).
 */
export function normalizeResource(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048 || raw.includes("?") || raw.includes("#")) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.username || u.password || u.search || u.hash || (u.protocol !== "https:" && u.protocol !== "http:")) return null;
  const path = u.pathname.length > 1 && u.pathname.endsWith("/") ? u.pathname.slice(0, -1) : u.pathname === "/" ? "" : u.pathname;
  return `${u.protocol}//${u.host}${path}`;
}

// ---------------------------------------------------------------- audit of refusals (auth_failure, op oauth_refused)

const WINDOW_MS = 60_000;
const REFUSAL_WINDOWS_MAX = 10_000;
const refusalWindows = new WeakMap<object, Map<string, { start: number; n: number }>>();

/**
 * Write the refusal event with the limit of noteAuthFailure (limits.preauth.auth_failures_per_minute per address and minute:
 * each of the first N, then one failures_throttled, then silence until the window ends). Its own window: a refused
 * sign-in in a browser must not lock the address for keys (the preauth failure counter is for unknown keys; behind one NAT
 * or a cloud client's egress are many people).
 */
export async function noteRefusal(app: App, ip: string | null, details: Record<string, unknown>): Promise<void> {
  const limit = preauthLimits(app).auth_failures_per_minute;
  if (ip && limit > 0) {
    let m = refusalWindows.get(app);
    if (!m) { m = new Map(); refusalWindows.set(app, m); }
    const key = addressKey(ip), now = Date.now();
    let w = m.get(key);
    if (!w || now - w.start >= WINDOW_MS) {
      if (m.size >= REFUSAL_WINDOWS_MAX) for (const [k, v] of m) if (now - v.start >= WINDOW_MS || m.size >= REFUSAL_WINDOWS_MAX) m.delete(k);
      w = { start: now, n: 0 };
      m.set(key, w);
    }
    w.n++;
    if (w.n === limit + 1) { await audit(app, null, { event_type: "auth_failure", details: { reason: "failures_throttled", op: typeof details.op === "string" ? details.op : "oauth_refused", count: w.n }, ip }); return; }
    if (w.n > limit) return;
  }
  await audit(app, null, { event_type: "auth_failure", details, ip });
}

/** Host of any address for the audit, leniently (also of refused ones); only the host, at most 253. */
function auditHost(u: string | undefined): string | null {
  if (!u) return null;
  try { return new URL(u).hostname.replace(/[^A-Za-z0-9.:[\]_~%-]/g, "?").slice(0, 253) || null; } catch { return returnHost(u) || null; }
}

// ---------------------------------------------------------------- responses

const NO_STORE_HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer" } as const;

function redirectTo(location: string, cookies: string[] = []): Response {
  const h = new Headers({ location, ...NO_STORE_HEADERS });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(null, { status: 302, headers: h });
}

/** Hand the authorization response to the app: redirect, or the "Return to the app" page for link and custom. */
function deliver(r: { uri: string; mode: RedirectMode }, app: string, params: Record<string, string | undefined>, o: { error?: AsTextCode; cookies?: string[] } = {}): Response {
  const href = withParams(r.uri, params);
  if (r.mode === "redirect") return redirectTo(href, o.cookies);
  const res = returnPage(app, href, o.error ? { error: o.error } : {});
  for (const c of o.cookies ?? []) res.headers.append("set-cookie", c);
  return res;
}

/** Address of the TCP peer (rest.ts remoteOf); requestChannel derives the client address from it and access.trusted_proxies. */
export type SockOf = (c: Context) => string | null;

/** The raw query string (without "?"), exactly as the client sent it. */
const rawQuery = (url: string): string => { const i = url.indexOf("?"); if (i < 0) return ""; const h = url.indexOf("#", i); return url.slice(i + 1, h < 0 ? undefined : h); };

/** Rate limits of the AS browser routes: per address (addressKey) and per network (netPrefix). */
function takeLimits(app: App, ip: string | null): number | null {
  const a = app.limiter.takeAnonymous("oauth_authorize", ip ? addressKey(ip) : "unknown", AUTHORIZE_PER_MIN);
  if (a) return a.retryAfter;
  const n = app.limiter.takeAnonymous("oauth_authorize_net", ip ? netPrefix(ip) : "unknown", AUTHORIZE_NET_PER_MIN);
  return n ? n.retryAfter : null;
}

/** Host of the issuer as requestHost writes a Host header: lower case, IPv6 without brackets. */
const hostOf = (origin: string): string => { try { return new URL(origin).hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1"); } catch { return ""; } };

function sameBytes(a: Buffer | null | undefined, b: Buffer): boolean {
  return !!a && a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- the routes

const METADATA_PATH = "/.well-known/oauth-authorization-server";
const CORS_READ = { "access-control-allow-origin": "*" } as const;
/**
 * Preflight of the discovery documents: any origin, the MCP header allowed, no credentials — one set
 * of headers for the AS metadata here and the built-in protected resource metadata (oauth.ts, BUILTIN_PRM_PREFLIGHT_HEADERS).
 */
export const DISCOVERY_PREFLIGHT_HEADERS: Readonly<Record<string, string>> = BUILTIN_PRM_PREFLIGHT_HEADERS;

/** The metadata document of the ready built-in server: CIMD and registration only while served and enabled. */
export function builtinAsMetadata(state: BuiltinState, settings: Getter): Record<string, unknown> {
  const cfg = agentAuthConfig(settings);
  return asMetadata(state.issuer, {
    cimd: clientSourceServed("cimd") && cimdEnabled(cimdPolicyFrom(cfg.cimd_hosts, cfg.cimd_any_https)),
    registration: clientSourceServed("dcr") && cfg.dcr_enabled,
  });
}

/**
 * Register the authorize side on the REST router, before authenticate. Marks the authorize part of the AS routes
 * as served (readiness routes_missing): builtin is ready only once the consent API (consent-api.ts) and the token side
 * (routes-token.ts) have marked their parts too.
 */
export function registerAgentAuthAuthorize(r: Hono<Env>, app: App, sockOf: SockOf): void {
  markAgentAuthRoutesServed("authorize");

  r.get(METADATA_PATH, async (c, next) => {
    const st = await builtinState(app);
    if (!st) return next();
    return c.json(builtinAsMetadata(st, app.settings), 200, { "cache-control": "max-age=60", ...CORS_READ });
  });
  r.options(METADATA_PATH, async (c, next) => {
    if (!(await builtinState(app))) return next();
    return c.body(null, 204, { ...DISCOVERY_PREFLIGHT_HEADERS });
  });

  r.get("/oauth/authorize", async (c, next) => {
    const st = await builtinState(app);
    if (!st) return next();
    // Hono answers HEAD with the GET handler: link previews and scanners would open transactions
    if (c.req.method === "HEAD") return methodNotAllowedPage();
    return authorize(app, c, st, sockOf);
  });

  r.get("/oauth/authorize/continue", async (c, next) => {
    const st = await builtinState(app);
    if (!st) return next();
    // the transaction is taken first: a HEAD (link preview) must not spend it
    if (c.req.method === "HEAD") return methodNotAllowedPage();
    return authorizeContinue(app, c, st, sockOf);
  });
}

/** GET /oauth/authorize — checks in the order of the edge's authorize endpoint. */
async function authorize(app: App, c: Context, st: BuiltinState, sockOf: SockOf): Promise<Response> {
  const req = c.req.raw;
  const ip = (await requestChannel(app, req, sockOf(c))).ip;
  // 1. limits per address and per network — a page, nothing stored
  const wait = takeLimits(app, ip);
  if (wait !== null) return rateLimitedPage(wait);

  const query = rawQuery(req.url);
  const { params: p, resourceConflict } = parseResourceParams(query, AUTHORIZE_QUERY_MAX, normalizeResource);
  const clientId = p.get("client_id"), redirectUri = p.get("redirect_uri"), state = p.get("state"), scope = p.get("scope");
  const askedResource = p.get("resource");
  const event = (code: string, o: { client?: string | undefined; redirect?: string | undefined } = {}) => noteRefusal(app, ip, {
    op: "oauth_refused", reason: "oauth_refused", code,
    client_id: o.client === undefined ? null : o.client.slice(0, CLIENT_ID_MAX),
    redirect_host: auditHost(o.redirect),
    state_len: state?.length ?? 0, scope_len: scope?.length ?? 0, query_len: query.length,
    resource: askedResource === undefined ? null : (normalizeResource(askedResource)?.slice(0, 255) ?? null),
  });
  const pageRefusal = async (status: number, code: AsTextCode, o: { vars?: Record<string, string>; cimd?: CimdRefusal; headers?: Record<string, string> } = {}) => {
    await event(code, { client: clientId, redirect: redirectUri });
    return errorPage(status, code, o);
  };

  // 2. the query does not parse; client_id or redirect_uri repeated
  if (p.problem === "too_long" || p.duplicated("client_id") || p.duplicated("redirect_uri")) return pageRefusal(400, "invalid_request");
  // 3. another name for the agent address (a tunnel alias): the cookie would land on the wrong host — no transaction, no cookie
  if (requestHost(req) !== hostOf(st.issuer)) return pageRefusal(400, "wrong_host", { vars: { issuer: st.issuer } });
  // 4. the client (registry; CIMD and DCR through their resolvers)
  if (!clientId) return pageRefusal(400, "invalid_request");
  // the print of the policy the client is checked under, taken BEFORE the lookup (a CIMD download may wait while the cache
  // reloads: a newer print over an older check would let continue pass it; an older print only makes continue refuse)
  const policyPrint = agentAuthPolicyPrint(app.settings);
  const resolved = await resolveClient(app, clientId, app.settings, { ip });
  if (!resolved.ok && resolved.busy) return pageRefusal(503, "temporarily_unavailable", { headers: { "retry-after": String(BUSY_RETRY_SEC) } });
  if (!resolved.ok) return pageRefusal(400, "invalid_client", resolved.cimd ? { cimd: resolved.cimd } : {});
  // 5. the return address against the client's rows
  const view = resolved.client.view(redirectUri);
  if (!view) return pageRefusal(400, "invalid_redirect_uri");

  // from here on errors go to the app's return address, with iss (RFC 9207) and state if it fits — when this memory trusts
  // that address before consent (ClientView.redirectTrusted, RFC 9700 §4.11.2). An address an anonymous caller chose (DCR,
  // a document admitted only by cimd_any_https) gets the page instead: no open redirector on the agent address
  const stateOk = state === undefined || state.length <= STATE_MAX;
  const fail = async (error: AuthorizeErrorCode): Promise<Response> => {
    await event(error, { client: clientId, redirect: view.redirect.uri });
    if (!view.redirectTrusted) {
      return error === "temporarily_unavailable"
        ? errorPage(503, error, { headers: { "retry-after": String(BUSY_RETRY_SEC) } })
        : errorPage(400, error);
    }
    return deliver(view.redirect, view.title, { error, error_description: errorDescription(error), state: stateOk ? state : undefined, iss: st.issuer }, { error });
  };
  // 6. other repeats or control characters; response_type
  if (p.problem) return fail("invalid_request");
  const responseType = p.get("response_type");
  if (!responseType) return fail("invalid_request");
  if (responseType !== "code") return fail("unsupported_response_type");
  // 7. PKCE S256 only
  const challenge = p.get("code_challenge");
  if (!challengeOk(challenge, p.get("code_challenge_method"))) return fail("invalid_request");
  // 8. resource indicator of this memory, or none (then this memory's)
  if (resourceConflict || (askedResource !== undefined && normalizeResource(askedResource) !== st.resource)) return fail("invalid_target");
  // 9. lengths; unknown scopes are dropped silently (mcp:memory is granted)
  if (!stateOk || (scope ?? "").length > PARAM_LIMITS.scope) return fail("invalid_request");
  // 10. no silent sign-in
  const prompt = (p.get("prompt") ?? "").split(" ").filter(Boolean);
  if (prompt.includes("none")) return fail("interaction_required");

  // 11. the transaction, within the caps of the instance and of the network
  const cookie = randomSecret(), id = randomSecret();
  const stored = await insertTxCapped(app.db.control, {
    id, instance_id: app.instanceId, cookie_hash: sha256(cookie), csrf: randomBytes(32), client_id: resolved.client.id,
    client_source: resolved.client.source as ClientSourceCol, client_kind: view.kind, client_title: [...view.title].slice(0, 120).join("") || resolved.client.id.slice(0, 120),
    client_name: view.name === null ? null : [...view.name].slice(0, 100).join(""), client_known: view.known, redirect_uri: view.redirect.uri,
    redirect_mode: view.redirect.mode, state: state ?? null, code_challenge: challenge, resource: st.resource, prompt_login: prompt.includes("login"),
    ip_net: ip ? netPrefix(ip) : null, policy_print: policyPrint,
  });
  if (stored === "capped") return fail("temporarily_unavailable");
  // the hook only keeps bookkeeping (DCR last_authorize_at): its failure must not break a sign-in already stored
  try { await resolved.client.onAuthorize?.(app); } catch (e) { log.warn("agent_auth_on_authorize_failed", { source: resolved.client.source, error: ((e as Error)?.message ?? "").slice(0, 160) }); }
  void sweepAgentAuth(app, { limits: agentAuthConfig(app.settings).dcr_limits });
  // a new sign-in in the same browser replaces the cookie of the previous one (accepted)
  return redirectTo(`${st.workplace}/connect/authorize?tx=${id}`, [hostCookie(TX_COOKIE, cookie, TX_TTL_SEC)]);
}

/** Outcome of the continue transaction: a page or the authorization response; the transaction row is gone either way. */
type ContinueOutcome = { page: true } | { page: false; tx: TxRow; error: "access_denied" | null; code?: string; label?: string };

/** GET /oauth/authorize/continue?tx&c. */
async function authorizeContinue(app: App, c: Context, st: BuiltinState, sockOf: SockOf): Promise<Response> {
  const req = c.req.raw;
  const ip = (await requestChannel(app, req, sockOf(c))).ip;
  const wait = takeLimits(app, ip);
  if (wait !== null) return rateLimitedPage(wait);
  const gone = () => errorPage(400, "tx_gone", { headers: { "set-cookie": clearCookie(TX_COOKIE) } });
  if (requestHost(req) !== hostOf(st.issuer)) return errorPage(400, "wrong_host", { vars: { issuer: st.issuer } });
  const p = parseParams(rawQuery(req.url), PARAM_LIMITS.text);
  const id = p.get("tx"), key = p.get("c");
  if (p.problem || !id || !key || !/^[A-Za-z0-9_-]{43}$/.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(key)) return gone();

  // the client of the transaction is looked up before the database transaction (a CIMD fetch may wait on the network)
  const before = await readTx(app.db.control, app.instanceId, id);
  if (!before) return gone();
  // this process's settings cache is not the policy the transaction was started under (another gateway started it, or
  // a save elsewhere is not here yet): read the settings again before judging the client by them
  if (!samePolicyPrint(before.policy_print, agentAuthPolicyPrint(app.settings))) await app.settings.load(true);
  // the print of what the client is judged by, before the lookup (see authorize)
  const usedPrint = agentAuthPolicyPrint(app.settings);
  const resolved = await resolveClient(app, before.client_id, app.settings, { ip });
  // too many document downloads at once: nothing is spent — the same link works again in a moment
  if (!resolved.ok && resolved.busy) return errorPage(503, "temporarily_unavailable", { headers: { "retry-after": String(BUSY_RETRY_SEC) } });
  const browser = cookieSecret(req.headers.get("cookie"), TX_COOKIE);

  const out = await tx(app.db.control, async (q): Promise<ContinueOutcome> => {
    // the shared policy lock (oauth.ts, policyRead): a code is never minted across a policy step
    await q.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [oauthPolicyLock(app)]);
    // the policy now: the settings of the database under the lock, not this process's cache
    const current = app.settings.withDatabase(q);
    await current.load(true);
    const now = agentAuthPolicyPrint(current);
    // the transaction is deleted first (claimConsent of the edge): a repeated link finds nothing
    const t = await takeTx(q, app.instanceId, id);
    if (!t || !t.live) return { page: true };
    // 1. the browser that started the sign-in; 2. the key handed only to the browser that pressed Allow
    if (!browser || !sameBytes(t.cookie_hash, sha256(browser))) return { page: true };
    if (!sameBytes(t.continue_hash, sha256(key))) return { page: true };
    // 2a. started under rules that are gone (a gateway with an older settings cache checked the client): the page — nothing,
    // not even an error, goes to a return address the rules may no longer list; the person starts again from the app
    if (!samePolicyPrint(t.policy_print, now)) return { page: true };
    // 2b. the client was looked up (maybe after a document download) under other rules than the ones now: the page
    if (!samePolicyPrint(usedPrint, now)) return { page: true };
    // 3. decided
    if (t.decision !== "allow") return { page: false, tx: t, error: "access_denied" };
    // 4. the client is still allowed and the return address still passes; the person is still active
    const view = resolved.ok && resolved.client.source === t.client_source ? resolved.client.view(t.redirect_uri) : null;
    if (!view || view.kind !== t.client_kind || view.redirect.uri !== t.redirect_uri) return { page: false, tx: t, error: "access_denied" };
    const person = (await q.query<{ active: boolean; demo: boolean }>("SELECT active, (attrs->>'demo'='true') AS demo FROM people WHERE id = $1 AND instance_id = $2",
      [t.person_id, app.instanceId])).rows[0];
    if (!person?.active || person.demo || !t.person_id || !t.session_id) return { page: false, tx: t, error: "access_denied" };
    // 5. the code: 60 s, single use, hashed; it carries the grant, the person, the session and the client
    const code = newToken(CODE_PREFIX);
    await insertCode(q, {
      code_hash: sha256(code), instance_id: app.instanceId, grant_id: randomUUID(), person_id: t.person_id, session_id: t.session_id,
      client_id: t.client_id, client_source: t.client_source, client_kind: t.client_kind, client_label: [...view.label].slice(0, 80).join("") || t.client_title.slice(0, 80),
      redirect_uri: t.redirect_uri, code_challenge: t.code_challenge, resource: t.resource, consent_version: t.consent_version ?? CONSENT_VERSION,
      policy_print: now,
    });
    return { page: false, tx: t, error: null, code, label: view.title };
  });

  if (out.page) return gone();
  const t = out.tx, cookies = [clearCookie(TX_COOKIE)];
  const target = { uri: t.redirect_uri, mode: t.redirect_mode };
  if (out.error) {
    return deliver(target, t.client_title, { error: out.error, error_description: errorDescription(out.error), state: t.state ?? undefined, iss: st.issuer },
      { error: out.error, cookies });
  }
  // 6. by the mode of the return address
  return deliver(target, out.label ?? t.client_title, { code: out.code, state: t.state ?? undefined, iss: st.issuer }, { cookies });
}
