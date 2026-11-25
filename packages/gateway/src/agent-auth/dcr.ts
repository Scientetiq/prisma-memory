// Automatic registration of clients ("Register automatically", DCR; RFC 7591) on the gateway: the route
// POST /oauth/register with its CORS preflight, the limits, the resolver of dcr_… clients for the sign-in, and the
// administrator's revocation of a client. The pure rules (what is accepted, what is registered, labels, the audit details)
// are packages/shared/src/oauth-as/dcr.ts; the rows are store.ts.
//
// Off by default (agent_auth.dcr_enabled = false). Off — every method of /oauth/register is the router's 404 (no query:
// the switch and the mode come from the settings cache) and the metadata carry no registration_endpoint; a dcr_… client is
// refused on /oauth/authorize like any unknown client, and the policy step has revoked its connections. On — the
// route works only in a ready builtin, like the other AS routes.
//
// Registration: JSON only, the body at most 8 KiB (the transport limit of /oauth/* is 16 KiB), public clients only
// (client_secret_basic and client_secret_post are registered as none, RFC 7591 §3.2.1; jwks, jwks_uri, client_secret and
// any other method — invalid_client_metadata); limits — the bucket oauth_register per address (20 a minute), registrations
// of one network (netPrefix: IPv4 /24, IPv6 /48) and of the instance in the last 24 hours, live clients of the instance
// (agent_auth.dcr_limits). The address is the one requestChannel derives with access.trusted_proxies: an
// X-Forwarded-For counts only from a trusted proxy. A registration from a network of agent_auth.dcr_trusted_egress (the
// operator lists the published egress ranges of the cloud apps, which register one client per employee from a few shared
// networks) is held to dcr_limits.per_day_trusted — the share of the day all trusted egress may use, below per_day —
// instead of the network's day (unlimited, any user of the listed cloud could close DCR for everybody
// again); per_day, max_clients and the bucket hold for everybody. What the request says never changes a limit (the
// return addresses are the anonymous caller's choice — judged by them, one network used up per_day for the whole
// instance). Every outcome past the bucket is an audit event with details.op
// oauth_dcr_register — `admin` for a registration, `auth_failure` for a refusal — with the names of the fields sent, the
// grant and response types, the method, the hosts of the return addresses (never whole addresses or secrets) and whether
// the address was a trusted egress (trusted_egress).
//
// Expiry: the lazy sweep of store.ts (sweepAgentAuth) deletes a client never used whose last authorize (or
// creation) is older than dcr_limits.unused_hours, never one registered within the 24 hours the daily limits count
// (DCR_DAY_HOURS: an unused_hours below a day must not hand a network its per_day_net back every hour); this route,
// /oauth/authorize and /oauth/token call it. Each
// /oauth/authorize with a client marks last_authorize_at (at most once a minute), each code exchange and refresh marks
// first_used_at / last_used_at.
//
// The consent screen: a DCR client is never "known"; its title is the host of the return address of this
// sign-in (not of the first registered address), its client_name only "It calls itself …"; the workplace adds the marks
// "App not on the list of known apps" and "Registered automatically" (packages/admin/src/lib/agent-consent.ts).
//
// Revocation by the administrator (DELETE /api/v1/admin/agent-auth/clients/:id, agent-auth/admin.ts): under the EXCLUSIVE
// policy lock (oauthPolicyLock), so a code exchange that started before it under the shared lock finishes first and its
// connection is revoked here, and one that starts after finds the client revoked; the client's connections, sign-in
// transactions and unused codes go in the same transaction.
import type { Context, Hono } from "hono";
import { agentAuthConfig, agentAuthMode, log, tx } from "@memory/shared";
import {
  checkDcrRequest, dcrClientLabel, dcrContentTypeOk, dcrRegisterDetails, dcrRegistrationResponse, dcrTitle, errorDescription, isDcrClientId, isLoopbackRedirectUri,
  kindByRedirects, matchRedirect, newDcrClientId, NO_STORE, parseDcrBody, usableRedirect, type RegistrationErrorCode, type UsableRedirect,
} from "@memory/shared/oauth-as";
import type { App } from "../context.ts";
import { audit } from "../audit.ts";
import { inNetworks, requestChannel } from "../channel.ts";
import { revokeWhere, withOAuthPolicyLock } from "../oauth.ts";
import { addressKey, netPrefix } from "../preauth.ts";
import { agentAuthTablesPresent } from "./readiness.ts";
import { builtinState, setClientResolver, type BuiltinState, type ClientResolver, type ResolvedClient, type SockOf } from "./routes-authorize.ts";
import { bodyWithin, TOKEN_PREFLIGHT_HEADERS } from "./routes-token.ts";
import {
  dcrClient, deleteClientPending, insertDcrClientLimited, noteDcrAuthorize, revokeDcrClient, sweepAgentAuth, type DcrClientRow, type DcrRefusal,
} from "./store.ts";

export const REGISTER_PATH = "/oauth/register";
/** Per-address bucket of registration and its fallback without a row in limits.personal_per_minute. */
export const REGISTER_BUCKET = "oauth_register";
export const REGISTER_PER_MIN = 20;
/** Retry-After of a refusal by the daily limits or the cap of live clients: the 24-hour window frees slowly. */
export const DCR_LIMIT_RETRY_SEC = 3600;
/** Retry-After of a 503 when the database did not answer. */
const RETRY_AFTER_SEC = 30;

const CORS = { "access-control-allow-origin": "*" } as const;

// ---------------------------------------------------------------- answers (RFC 7591 §3.2)

/** error_description stays within the RFC 6749 §5.2 character set (printable ASCII without `"` and `\`). */
const describable = (s: string): string => s.replace(/[^\x20\x21\x23-\x5b\x5d-\x7e]/g, "?").slice(0, 300);

/**
 * Error answer of the registration endpoint: JSON {error, error_description}, no-store, CORS without credentials. The
 * description names the rule that failed (RFC 7591 §3.2.2: for the developer of the client); without one — the table text.
 */
export function registrationError(code: RegistrationErrorCode | "temporarily_unavailable", o: { detail?: string; status?: number; retryAfter?: number } = {}): Response {
  const status = o.status ?? (code === "temporarily_unavailable" ? 503 : 400);
  const headers: Record<string, string> = { "content-type": "application/json", ...NO_STORE, ...CORS };
  if (o.retryAfter) headers["retry-after"] = String(Math.max(1, Math.ceil(o.retryAfter)));
  return new Response(JSON.stringify({ error: code, error_description: describable(o.detail ?? errorDescription(code)) }), { status, headers });
}

// ---------------------------------------------------------------- the client of a dcr_… client_id (resolveClient)

/** The registered return addresses as rows for matchRedirect; an address the current rules no longer accept is left out. */
function registeredLines(uris: unknown): UsableRedirect[] {
  const out: UsableRedirect[] = [];
  for (const u of Array.isArray(uris) ? uris : []) {
    const r = usableRedirect(u, null);
    if (r.ok) out.push(r.line);
  }
  return out;
}

/**
 * The client of a registration row: kind by all registered addresses (all loopback — local_other, else
 * cloud_other), never known; for one return address — the title is that address's host, the label "<client_name>
 * (auto-registered)" or "<host> (auto-registered)".
 */
export function dcrResolvedClient(row: Pick<DcrClientRow, "client_id" | "client_name" | "redirect_uris">): ResolvedClient {
  const lines = registeredLines(row.redirect_uris);
  const kind = kindByRedirects(lines);
  const redirects = lines.map((l) => l.row);
  return {
    id: row.client_id, source: "dcr",
    view(redirectUri) {
      if (!redirects.length) return null;
      const m = matchRedirect({ redirects }, redirectUri);
      if (!m.ok) return null;
      // an anonymous caller registered the https addresses: no error before consent goes there (RFC 9700 §4.11.2)
      return { kind, title: dcrTitle(m.uri), known: false, name: row.client_name, label: dcrClientLabel(row.client_name, m.uri), redirect: { uri: m.uri, mode: m.mode },
        redirectTrusted: isLoopbackRedirectUri(m.uri) };
    },
    async onAuthorize(app) { await noteDcrAuthorize(app.db.control, app.instanceId, row.client_id); },
  };
}

/**
 * resolveClient for dcr_… (installed by registerAgentAuthRegister): automatic registration is on and the client is alive
 * (not revoked, not swept). One query, outside any transaction.
 */
export const resolveDcrClient: ClientResolver = async (app, clientId, settings) => {
  if (!agentAuthConfig(settings).dcr_enabled || !isDcrClientId(clientId)) return { ok: false };
  if (!(await agentAuthTablesPresent(app))) return { ok: false };
  const row = await dcrClient(app.db.control, app.instanceId, clientId);
  if (!row || row.revoked_at !== null) return { ok: false };
  return { ok: true, client: dcrResolvedClient(row) };
};

// ---------------------------------------------------------------- POST /oauth/register

/**
 * Does this process serve registration now: mode builtin and automatic registration on (both from the settings cache — no
 * query otherwise), and builtin ready. null — the router's 404.
 */
export async function registrationState(app: Pick<App, "settings" | "db">): Promise<BuiltinState | null> {
  if (agentAuthMode(app.settings) !== "builtin" || !agentAuthConfig(app.settings).dcr_enabled) return null;
  return builtinState(app);
}

export interface RegisterRequest {
  contentType: string | null;
  /** the body as read within the transport limit; null — over it */
  body: string | null;
  /** client address as requestChannel derived it */
  ip: string | null;
}

const LIMIT_TEXT: Readonly<Record<DcrRefusal, string>> = {
  per_day_net: "Too many apps were registered from this network in the last 24 hours. Try again later.",
  per_day_trusted: "Too many apps were registered from the networks of cloud apps in the last 24 hours. Try again later.",
  per_day: "Too many apps were registered on this memory in the last 24 hours. Try again later.",
  max_clients: "This memory has as many registered apps as it allows. Ask the administrator.",
};

/** POST /oauth/register without HTTP framing and without the bucket (the route takes it first; tests call this directly). */
export async function registerEndpoint(app: App, r: RegisterRequest): Promise<Response> {
  const refused = async (code: RegistrationErrorCode, detail: string, body: unknown): Promise<Response> => {
    await audit(app, null, { event_type: "auth_failure", ip: r.ip, details: { ...dcrRegisterDetails(body), reason: code } });
    return registrationError(code, { detail });
  };
  if (r.body === null) return refused("invalid_client_metadata", "the body is larger than 16384 bytes", {});
  if (!dcrContentTypeOk(r.contentType)) return refused("invalid_client_metadata", "Content-Type must be application/json", {});
  const parsed = parseDcrBody(r.body);
  if (!parsed.ok) return refused(parsed.error, parsed.detail, {});
  const check = checkDcrRequest(parsed.json);
  if (!check.ok) return refused(check.error, check.detail, parsed.json);
  const reg = check.reg;
  const unavailable = async (): Promise<Response> => {
    try {
      await audit(app, null, { event_type: "auth_failure", ip: r.ip, details: {
        ...dcrRegisterDetails(parsed.json), reason: "temporarily_unavailable",
        trusted_egress: r.ip !== null && inNetworks(r.ip, agentAuthConfig(app.settings).dcr_trusted_egress),
      } });
    } catch { /* best effort */ }
    return registrationError("temporarily_unavailable", { retryAfter: RETRY_AFTER_SEC });
  };
  try {
    if (!(await agentAuthTablesPresent(app))) return unavailable();
    const cfg = agentAuthConfig(app.settings);
    const limits = cfg.dcr_limits;
    // the caller's address only (requestChannel: X-Forwarded-For counts only from access.trusted_proxies) — never the body
    const trustedEgress = r.ip !== null && inNetworks(r.ip, cfg.dcr_trusted_egress);
    void sweepAgentAuth(app, { limits });
    const clientId = newDcrClientId();
    const issuedAt = Date.now() / 1000;
    const stored = await tx(app.db.control, (q) => insertDcrClientLimited(q, {
      client_id: clientId, instance_id: app.instanceId, client_name: reg.clientName, redirect_uris: [...reg.redirectUris],
      software_id: reg.softwareId, software_version: reg.softwareVersion, created_ip_prefix: r.ip ? netPrefix(r.ip) : null,
    }, limits, { trustedEgress }));
    if (stored !== "ok") {
      await audit(app, null, { event_type: "auth_failure", ip: r.ip, details: { ...dcrRegisterDetails(parsed.json), reason: `limit_${stored}`, trusted_egress: trustedEgress } });
      return registrationError("temporarily_unavailable", { detail: LIMIT_TEXT[stored], status: 429, retryAfter: DCR_LIMIT_RETRY_SEC });
    }
    await audit(app, null, { event_type: "admin", ip: r.ip,
      details: { ...dcrRegisterDetails(parsed.json), result: "registered", client_id: clientId, client_kind: reg.kind, trusted_egress: trustedEgress } });
    return new Response(JSON.stringify(dcrRegistrationResponse(clientId, issuedAt, reg)), {
      status: 201, headers: { "content-type": "application/json", ...NO_STORE, ...CORS },
    });
  } catch (e) {
    // the database did not answer or refused a write: no details outside, the client retries
    log.warn("agent_auth_register_failed", { error: ((e as Error)?.message ?? "").slice(0, 160) });
    return unavailable();
  }
}

/**
 * Register POST and OPTIONS of /oauth/register on the REST router, before the key check (the request carries no key), and
 * install the resolver of dcr_… clients: from here on the metadata announce registration_endpoint while
 * agent_auth.dcr_enabled is on (routes-authorize.ts, builtinAsMetadata). Outside a ready builtin with DCR on, every method
 * calls next(): the router's own 404, byte for byte the answer of an unknown path. Order: the switch and readiness, the
 * per-address bucket, the 16 KiB body, then the endpoint.
 */
export function registerAgentAuthRegister(r: Hono<any>, app: App, sockOf: SockOf): void {
  setClientResolver("dcr", resolveDcrClient);
  const state = async (): Promise<"off" | "ready" | "unavailable"> => {
    try { return (await registrationState(app)) ? "ready" : "off"; } catch { return "unavailable"; }
  };
  r.options(REGISTER_PATH, async (c, next) => ((await state()) === "ready" ? new Response(null, { status: 204, headers: TOKEN_PREFLIGHT_HEADERS }) : next()));
  r.post(REGISTER_PATH, async (c: Context, next) => {
    const st = await state();
    if (st === "off") return next();
    if (st === "unavailable") return registrationError("temporarily_unavailable", { retryAfter: RETRY_AFTER_SEC });
    const rc = await requestChannel(app, c.req.raw, sockOf(c));
    const hit = app.limiter.takeAnonymous(REGISTER_BUCKET, rc.ip ? addressKey(rc.ip) : "unknown", REGISTER_PER_MIN);
    if (hit) return registrationError("temporarily_unavailable", { status: 429, retryAfter: hit.retryAfter });
    const body = await bodyWithin(c);
    const res = await registerEndpoint(app, { contentType: c.req.header("content-type") ?? null, body, ip: rc.ip });
    if (res.status !== 201) log.info("agent_auth_register_refused", { status: res.status });
    return res;
  });
}

// ---------------------------------------------------------------- revocation by the administrator

export interface DcrRevocation { client_id: string; connections_revoked: number; transactions_deleted: number; codes_deleted: number }

/**
 * Revoke a registered client (the panel, DELETE /api/v1/admin/agent-auth/clients/:id): under the exclusive policy lock, in
 * one transaction — the client row (revoked_at), every live builtin connection of the client, its sign-in transactions and
 * unused codes. null — no such live client (unknown, already revoked or swept; without the [AS] tables there is none).
 */
export async function revokeDcrClientByAdmin(app: App, clientId: string): Promise<DcrRevocation | null> {
  return withOAuthPolicyLock(app, async (q) => {
    if (!(await agentAuthTablesPresent(app, q))) return null;
    if (!(await revokeDcrClient(q, app.instanceId, clientId))) return null;
    const connections = await revokeWhere(q, "c.instance_id=$1 AND c.origin='builtin' AND c.client_id=$2", [app.instanceId, clientId]);
    const pending = await deleteClientPending(q, app.instanceId, clientId);
    return { client_id: clientId, connections_revoked: connections, transactions_deleted: pending.tx, codes_deleted: pending.codes };
  });
}
