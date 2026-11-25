import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { EgressError } from "../net/egress.ts";
import { ConnectorError, vendorError } from "../sdk/errors.ts";
import type { EgressClient, EgressResponse } from "../sdk/types.ts";
import {
  deleteConnectorSecret, deleteConnectorSecretIf, loadConnectorSecrets, replaceConnectorSecretIf, replaceConnectorSecretIfAndGet,
  SECRET_MAX_CHARS, setConnectorSecret, type Queryable,
} from "../secrets.ts";

export interface OAuthProvider {
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  client_id: string;
  client_secret?: string;
  scopes: readonly string[];
  redirect_uri: string;
}

export interface OAuthDependencies {
  /** Use the same query port for a connector's operations within a process. */
  q: Queryable;
  keyring: Parameters<typeof loadConnectorSecrets>[1];
  http: EgressClient;
  /** Epoch milliseconds. */
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

export const OAUTH_RESULT_CODES = Object.freeze([
  "oauth_pending_absent", "oauth_state_mismatch", "oauth_exchange_refused",
  "oauth_answer_invalid", "oauth_revocation_failed",
] as const);
export type OAuthResultCode = (typeof OAUTH_RESULT_CODES)[number];

type Refusal<C extends OAuthResultCode> = { ok: false; code: C };
type AuthorizationResult =
  | { ok: true; expires_at: number | null; scope: string }
  | Refusal<Exclude<OAuthResultCode, "oauth_revocation_failed">>;
type RevocationResult = { ok: true } | Refusal<"oauth_revocation_failed">;
type Callback = { state: string; code: string };
type TokenOptions = {
  /** The access token the provider has just refused (HTTP 401). The stored token is then not handed out again: one renewal is made, or the call fails with auth_failed. A caller renews at most once per operation. */
  refused?: string;
};

const PENDING = "oauth_pending";
const ACCESS = "oauth_access";
const REFRESH = "oauth_refresh";
const PENDING_TTL_MS = 600_000;
const REQUIRED_VALIDITY_MS = 60_000;
const REFRESH_WAIT_MS = [100, 200, 400, 800, 1600] as const;

interface Pending {
  state_hash: string;
  verifier: string;
  redirect_uri: string;
  started_at: number;
}
interface StoredAccess {
  token: string;
  expires_at: number | null;
  scope: string;
}
type TokenReply =
  | { ok: true; access: StoredAccess; refresh: string | null }
  | (Refusal<"oauth_exchange_refused"> & { invalidGrant: boolean; response: EgressResponse })
  | Refusal<"oauth_answer_invalid">;

const nowOf = (deps: OAuthDependencies): number => deps.now?.() ?? Date.now();
const sha256 = (value: string): Buffer => createHash("sha256").update(value).digest();
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function jsonObject(read: () => unknown): Record<string, unknown> | null {
  try {
    const value = read();
    return isObject(value) ? value : null;
  } catch { return null; }
}

function browserEndpoint(endpoint: string): URL {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new EgressError("egress_blocked:url"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new EgressError("egress_blocked:scheme");
  if (!url.hostname || url.username || url.password || url.port === "0" || url.hash) throw new EgressError("egress_blocked:url");
  if (url.protocol === "http:" && url.hostname !== "localhost" && url.hostname !== "[::1]"
      && !/^127(?:\.[0-9]{1,3}){3}$/.test(url.hostname)) {
    throw new EgressError("egress_blocked:scheme");
  }
  return url;
}

export async function beginAuthorization(deps: OAuthDependencies, connectorId: string, provider: OAuthProvider): Promise<string> {
  const url = browserEndpoint(provider.authorization_endpoint);
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const pending: Pending = {
    state_hash: sha256(state).toString("hex"), verifier, redirect_uri: provider.redirect_uri, started_at: nowOf(deps),
  };
  const fields = {
    response_type: "code", client_id: provider.client_id, redirect_uri: pending.redirect_uri,
    scope: provider.scopes.join(" "), state, code_challenge: sha256(verifier).toString("base64url"), code_challenge_method: "S256",
  };
  for (const [name, value] of Object.entries(fields)) url.searchParams.set(name, value);
  await setConnectorSecret(deps.q, deps.keyring, connectorId, PENDING, JSON.stringify(pending));
  return url.href;
}

async function takePending(deps: OAuthDependencies, connectorId: string): Promise<Pending | null> {
  // Returning the deleted ciphertext makes consuming a row atomic even across different callbacks and processes.
  const deleted = await deps.q.query(
    "DELETE FROM connector_secrets WHERE connector_id = $1 AND name = $2 RETURNING name, value, enc_kid",
    [connectorId, PENDING],
  );
  const loaded = await loadConnectorSecrets({ query: async () => deleted }, deps.keyring, connectorId);
  const row = jsonObject(() => JSON.parse(loaded.get(PENDING) ?? "null"));
  if (!row || typeof row.state_hash !== "string" || !/^[0-9a-f]{64}$/.test(row.state_hash)
      || typeof row.verifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(row.verifier)
      || typeof row.redirect_uri !== "string" || typeof row.started_at !== "number" || !Number.isFinite(row.started_at)) return null;
  return { state_hash: row.state_hash, verifier: row.verifier, redirect_uri: row.redirect_uri, started_at: row.started_at };
}

const formEncode = (value: string): string => new URLSearchParams([["", value]]).toString().slice(1);

function postForm(http: EgressClient, endpoint: string, provider: OAuthProvider, fields: Record<string, string>): Promise<EgressResponse> {
  const body = new URLSearchParams(fields);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded", accept: "application/json",
  };
  if (provider.client_secret === undefined) {
    body.set("client_id", provider.client_id);
  } else {
    const credentials = `${formEncode(provider.client_id)}:${formEncode(provider.client_secret)}`;
    headers.authorization = `Basic ${Buffer.from(credentials).toString("base64")}`;
  }
  return http.request({ method: "POST", url: endpoint, headers, body: body.toString() });
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= SECRET_MAX_CHARS && !/[\x00-\x1f\x7f]/.test(value);
}

async function exchange(deps: OAuthDependencies, provider: OAuthProvider, fields: Record<string, string>,
                        defaultScope: string, secrets: readonly string[] = []): Promise<TokenReply> {
  const response = await postForm(deps.http, provider.token_endpoint, provider, fields);
  const value = jsonObject(() => response.json());
  if (response.status < 200 || response.status >= 300 || typeof value?.error === "string") {
    return { ok: false, code: "oauth_exchange_refused", invalidGrant: value?.error === "invalid_grant", response };
  }
  const invalid = { ok: false, code: "oauth_answer_invalid" } as const;
  if (!value || !isToken(value.access_token) || typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer") return invalid;
  const refresh = value.refresh_token;
  if (refresh !== undefined && !isToken(refresh)) return invalid;
  const rawLifetime = value.expires_in;
  const lifetime = typeof rawLifetime === "string" && /^[0-9]{1,10}$/.test(rawLifetime) ? Number(rawLifetime) : rawLifetime;
  let expires_at: number | null = null;
  if (lifetime !== undefined) {
    if (typeof lifetime !== "number" || lifetime < 0 || !Number.isSafeInteger(lifetime)) return invalid;
    expires_at = nowOf(deps) + lifetime * 1000;
    if (!Number.isSafeInteger(expires_at)) return invalid;
  }

  const scope = value.scope === undefined ? defaultScope : value.scope;
  const privateValues = [...secrets, value.access_token, refresh, provider.client_secret];
  if (typeof scope !== "string" || privateValues.some((secret) => secret && scope.includes(secret))) return invalid;
  const access = { token: value.access_token, expires_at, scope };
  if (JSON.stringify(access).length > SECRET_MAX_CHARS) return invalid;
  return { ok: true, access, refresh: refresh ?? null };
}

async function storeTokens(deps: OAuthDependencies, id: string, access: StoredAccess, refresh: string | null, keepRefresh = false): Promise<void> {
  if (refresh !== null) await setConnectorSecret(deps.q, deps.keyring, id, REFRESH, refresh);
  else if (!keepRefresh) await deleteConnectorSecret(deps.q, id, REFRESH);
  await setConnectorSecret(deps.q, deps.keyring, id, ACCESS, JSON.stringify(access));
}

async function clearTokens(q: Queryable, id: string): Promise<void> {
  const deleted = await Promise.allSettled([deleteConnectorSecret(q, id, ACCESS), deleteConnectorSecret(q, id, REFRESH)]);
  for (const result of deleted) if (result.status === "rejected") throw result.reason;
}

async function readUsableAccessToken(deps: OAuthDependencies, id: string, refused?: string): Promise<string | null> {
  const loaded = await loadConnectorSecrets(deps.q, deps.keyring, id);
  if (!loaded.unreadable().includes(ACCESS)) {
    const access = readAccess(loaded.get(ACCESS));
    if (access && access.token !== refused && usable(access, nowOf(deps))) return access.token;
  }
  return null;
}

async function reloadAccessToken(deps: OAuthDependencies, id: string): Promise<string> {
  const token = await readUsableAccessToken(deps, id);
  if (token !== null) return token;
  throw new ConnectorError("auth_failed");
}

async function waitForAccessToken(deps: OAuthDependencies, id: string, refused: string | undefined): Promise<string> {
  const wait = deps.wait ?? delay;
  for (const ms of REFRESH_WAIT_MS) {
    await wait(ms);
    const token = await readUsableAccessToken(deps, id, refused);
    if (token !== null) return token;
  }
  throw new ConnectorError("auth_failed");
}

const queues = new WeakMap<Queryable, Map<string, Promise<void>>>();
type Flight = { result: Promise<string>; completion: Promise<string>; refused: string | undefined };
const refreshes = new WeakMap<Queryable, Map<string, Flight>>();
const clientGrants = new WeakMap<Queryable, Map<string, Flight>>();

function jobsFor<T>(byPort: WeakMap<Queryable, Map<string, T>>, q: Queryable): Map<string, T> {
  const existing = byPort.get(q);
  if (existing) return existing;
  const jobs = new Map<string, T>();
  byPort.set(q, jobs);
  return jobs;
}

/** Token changes share a queue so a local revocation cannot race a token write. */
function withConnector<T>(q: Queryable, id: string, work: () => Promise<T>): Promise<T> {
  const queue = jobsFor(queues, q);
  const result = (queue.get(id) ?? Promise.resolve()).then(work);
  const tail = result.then(() => undefined, () => undefined);
  queue.set(id, tail);
  void tail.then(() => { if (queue.get(id) === tail) queue.delete(id); });
  return result;
}

function singleFlight(byPort: typeof refreshes, q: Queryable, id: string, work: () => Promise<string>, refused?: string): Promise<string> {
  const jobs = jobsFor(byPort, q);
  const requireReplacement = (token: string): string => {
    if (token === refused) throw new ConnectorError("auth_failed");
    return token;
  };
  const start = () => {
    const run = refused === undefined ? work : () => work().then(requireReplacement);
    const completion = withConnector(q, id, run);
    const result = completion.finally(() => { jobs.delete(id); });
    jobs.set(id, { result, completion, refused });
    return result;
  };
  const existing = jobs.get(id);
  if (!existing) return start();
  if (refused === undefined) return existing.result;
  return existing.result.then((token) => {
    if (token !== refused) return token;
    const replacement = jobs.get(id);
    if (!replacement) return start();
    if (replacement.refused === refused) return replacement.result;
    // The completion reaction runs after cleanup and before callers can start another flight.
    return replacement.completion.then((next) => {
      if (next !== refused) return next;
      return jobs.get(id)?.result ?? start();
    });
  });
}

export function completeAuthorization(deps: OAuthDependencies, connectorId: string,
                                      provider: OAuthProvider, callback: Callback): Promise<AuthorizationResult> {
  return withConnector(deps.q, connectorId, async () => {
    const pending = await takePending(deps, connectorId);
    if (!pending || nowOf(deps) - pending.started_at > PENDING_TTL_MS) return { ok: false, code: "oauth_pending_absent" };
    if (!timingSafeEqual(Buffer.from(pending.state_hash, "hex"), sha256(callback.state))) return { ok: false, code: "oauth_state_mismatch" };
    const reply = await exchange(deps, provider, {
      grant_type: "authorization_code", code: callback.code, redirect_uri: pending.redirect_uri, code_verifier: pending.verifier,
    }, provider.scopes.join(" "), [callback.code, pending.verifier, callback.state]);
    if (!reply.ok) return { ok: false, code: reply.code };
    await storeTokens(deps, connectorId, reply.access, reply.refresh);
    return { ok: true, expires_at: reply.access.expires_at, scope: reply.access.scope };
  });
}

function readAccess(raw: string | null): StoredAccess | null {
  const row = jsonObject(() => JSON.parse(raw ?? "null"));
  if (!row || typeof row.token !== "string" || typeof row.scope !== "string"
      || !(row.expires_at === null || (typeof row.expires_at === "number" && Number.isSafeInteger(row.expires_at)))) return null;
  return { token: row.token, expires_at: row.expires_at, scope: row.scope };
}

function usable(access: StoredAccess, now: number): boolean {
  return access.expires_at === null || access.expires_at - now >= REQUIRED_VALIDITY_MS;
}

function exchangeError(reply: Exclude<TokenReply, { ok: true }>, now: number): ConnectorError {
  if (reply.code === "oauth_answer_invalid") return new ConnectorError("vendor_refused");
  if (reply.invalidGrant) return new ConnectorError("auth_failed");
  return vendorError(reply.response, new Date(now)) ?? new ConnectorError("auth_failed");
}

export function accessToken(deps: OAuthDependencies, connectorId: string, provider: OAuthProvider, opts?: TokenOptions): Promise<string> {
  const refused = opts?.refused;
  return singleFlight(refreshes, deps.q, connectorId, async () => {
    const loaded = await loadConnectorSecrets(deps.q, deps.keyring, connectorId);
    const stored = loaded.get(ACCESS);
    const access = readAccess(stored);
    if (access && access.token !== refused && usable(access, nowOf(deps))) return access.token;
    const refresh = loaded.get(REFRESH);
    const expected = loaded.stored(REFRESH);
    if (refresh === null || expected === null) {
      if (refused !== undefined && stored !== null) await deleteConnectorSecret(deps.q, connectorId, ACCESS);
      throw new ConnectorError("auth_failed");
    }
    const claimed = await replaceConnectorSecretIfAndGet(deps.q, deps.keyring, connectorId, REFRESH, refresh, expected);
    if (claimed === null) return waitForAccessToken(deps, connectorId, refused);
    const reply = await exchange(deps, provider, { grant_type: "refresh_token", refresh_token: refresh },
      access?.scope ?? provider.scopes.join(" "), access ? [refresh, access.token] : [refresh]);
    if (!reply.ok) {
      if (reply.code === "oauth_exchange_refused" && reply.invalidGrant) {
        const deleted = await deleteConnectorSecretIf(deps.q, connectorId, REFRESH, claimed);
        if (!deleted) return reloadAccessToken(deps, connectorId);
        await deleteConnectorSecret(deps.q, connectorId, ACCESS);
      }
      throw exchangeError(reply, nowOf(deps));
    }
    const replaced = await replaceConnectorSecretIf(deps.q, deps.keyring, connectorId, REFRESH, reply.refresh ?? refresh, claimed);
    if (!replaced) return reloadAccessToken(deps, connectorId);
    await storeTokens(deps, connectorId, reply.access, null, true);
    return reply.access.token;
  }, refused);
}

export function revoke(deps: OAuthDependencies, connectorId: string, provider: OAuthProvider): Promise<RevocationResult> {
  return withConnector(deps.q, connectorId, async () => {
    let failed = false;
    try {
      if (provider.revocation_endpoint !== undefined) {
        const loaded = await loadConnectorSecrets(deps.q, deps.keyring, connectorId);
        const refresh = loaded.get(REFRESH);
        const token = refresh ?? readAccess(loaded.get(ACCESS))?.token;
        if (token !== undefined) {
          const response = await postForm(deps.http, provider.revocation_endpoint, provider, {
            token, token_type_hint: refresh === null ? "access_token" : "refresh_token",
          });
          failed = response.status < 200 || response.status >= 300;
        }
      }
    } catch { failed = true; }
    try { await clearTokens(deps.q, connectorId); } catch { failed = true; }
    try { await deleteConnectorSecret(deps.q, connectorId, PENDING); } catch { failed = true; }
    return failed ? { ok: false, code: "oauth_revocation_failed" } : { ok: true };
  });
}

export function clientCredentialsToken(deps: OAuthDependencies, connectorId: string, provider: OAuthProvider, opts?: TokenOptions): Promise<string> {
  const refused = opts?.refused;
  return singleFlight(clientGrants, deps.q, connectorId, async () => {
    const loaded = await loadConnectorSecrets(deps.q, deps.keyring, connectorId);
    const access = readAccess(loaded.get(ACCESS));
    if (access && access.token !== refused && usable(access, nowOf(deps)) && loaded.get(REFRESH) === null) return access.token;
    const scope = provider.scopes.join(" ");
    const reply = await exchange(deps, provider, { grant_type: "client_credentials", ...(scope ? { scope } : {}) },
      scope, access ? [access.token] : []);
    if (!reply.ok) throw exchangeError(reply, nowOf(deps));
    await storeTokens(deps, connectorId, reply.access, null);
    return reply.access.token;
  }, refused);
}

export type GrantedRightsResult = {
  ok: true;
  granted: string[];
  missing: string[];
  extra: string[];
};

export function compareScopes(asked: readonly string[], granted: string): Omit<GrantedRightsResult, "ok"> {
  const askedTokens = new Set(asked);
  const grantedTokens = new Set(granted.split(" ").filter((token) => token !== ""));
  const sortedAsked = [...askedTokens].sort();
  return {
    granted: sortedAsked.filter((token) => grantedTokens.has(token)),
    missing: sortedAsked.filter((token) => !grantedTokens.has(token)),
    extra: [...grantedTokens].filter((token) => !askedTokens.has(token)).sort(),
  };
}

export async function grantedRights(deps: OAuthDependencies, connectorId: string, provider: OAuthProvider): Promise<GrantedRightsResult> {
  const loaded = await loadConnectorSecrets(deps.q, deps.keyring, connectorId);
  if (!loaded.unreadable().includes(ACCESS)) {
    const access = readAccess(loaded.get(ACCESS));
    if (access) return { ok: true, ...compareScopes(provider.scopes, access.scope) };
  }
  throw new ConnectorError("auth_failed");
}
