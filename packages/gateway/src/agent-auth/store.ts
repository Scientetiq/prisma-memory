// Data access of the built-in authorization server for agents: the tables of the [AS] part of
// contracts/schema/17-basic-tails.sql — sign-in transactions, authorization codes, access and refresh tokens, clients
// registered by DCR — plus the in-process cache of client metadata documents (CIMD) and the lazy sweep. No protocol rules
// here: the routes decide, this module only reads and writes rows. Secrets are never stored: codes, tokens, the browser
// secret and the continuation key are kept as SHA-256 (32 bytes); a caller passes the hash.
//
// Every function takes the connection to use (q): a route runs it inside its own transaction with the shared policy lock
// (oauth.ts, oauthPolicyLock) when the rule says so. Functions that must run in a transaction say so. Rows are scoped by
// instance_id like every table of the memory.
import type pg from "pg";
import { log, newId, tx } from "@memory/shared";
import type { DcrLimits } from "@memory/shared";
import { CIMD_CACHE_MAX, CIMD_CLIENT_NEGATIVE_MS, CIMD_HOST_COOLING_MS, cimdCacheTtlMs } from "@memory/shared/oauth-as";
import type { App } from "../context.ts";
// oauth.ts imports deletePersonPending from here: the cycle is safe, both sides use the other only inside functions
import { oauthPolicyLock, revokeWhere } from "../oauth.ts";
import { keysetAtSql } from "../paging.ts";
import { agentAuthTablesPresent } from "./readiness.ts";

type Q = Pick<pg.PoolClient, "query">;

/** A sign-in transaction lives 10 minutes. */
export const TX_TTL_SEC = 600;
/** An authorization code lives 60 seconds. */
export const CODE_TTL_SEC = 60;
/** Live transactions of an instance and of one network (TX_NET_CAP): above — temporarily_unavailable. */
export const TX_CAP = 5000;
export const TX_NET_CAP = 200;
/** A rotated refresh token may be presented again within 60 s at most 5 times (lost response),. */
export const REFRESH_REPLAY_WINDOW_SEC = 60;
export const REFRESH_MAX_REPLAYS = 5;
/** The sweep runs at most once per 5 minutes per process, in batches of 1000 rows. */
export const SWEEP_EVERY_MS = 300_000;
export const SWEEP_BATCH = 1000;
/** A revoked DCR client without live connections is deleted after 30 days. */
export const DCR_REVOKED_KEEP_DAYS = 30;
export const DCR_DAY_HOURS = 24;

export type ClientSourceCol = "registry" | "cimd" | "dcr";
export type RedirectModeCol = "redirect" | "link" | "custom";

// ---------------------------------------------------------------- sign-in transactions (agent_oauth_tx)

export interface TxRow {
  id: string; instance_id: string; cookie_hash: Buffer; csrf: Buffer; client_id: string; client_source: ClientSourceCol; client_kind: string;
  client_title: string; client_name: string | null; client_known: boolean; redirect_uri: string; redirect_mode: RedirectModeCol; state: string | null;
  code_challenge: string; resource: string; prompt_login: boolean; ip_net: string | null; created_at: Date; expires_at: Date;
  person_id: string | null; session_id: string | null; claimed_at: Date | null; decision: "allow" | "deny" | null; decided_at: Date | null;
  continue_hash: Buffer | null; consent_version: number | null;
  /** SHA-256 of the sign-in policy the transaction was started under (policy-step.ts, agentAuthPolicyPrint). */
  policy_print: Buffer;
  /** expires_at > now() by the database clock. */
  live: boolean;
}
export type NewTx = Pick<TxRow, "id" | "instance_id" | "cookie_hash" | "csrf" | "client_id" | "client_source" | "client_kind" | "client_title" | "client_name"
  | "client_known" | "redirect_uri" | "redirect_mode" | "state" | "code_challenge" | "resource" | "prompt_login" | "ip_net" | "policy_print">;

const TX_COLS = `id, instance_id, cookie_hash, csrf, client_id, client_source, client_kind, client_title, client_name, client_known, redirect_uri,
  redirect_mode, state, code_challenge, resource, prompt_login, ip_net, created_at, expires_at, person_id, session_id, claimed_at, decision,
  decided_at, continue_hash, consent_version, policy_print, expires_at > now() AS live`;

/**
 * Store a new transaction unless the instance already has TX_CAP live ones or its network TX_NET_CAP (one statement: the
 * counts and the insert see the same snapshot; two parallel inserts may pass the cap by one each — the cap is a guard
 * against floods, not an exact quota). "capped" — nothing stored.
 */
export async function insertTxCapped(q: Q, t: NewTx, caps: { total: number; net: number } = { total: TX_CAP, net: TX_NET_CAP }): Promise<"ok" | "capped"> {
  const r = await q.query(
    `INSERT INTO agent_oauth_tx (id, instance_id, cookie_hash, csrf, client_id, client_source, client_kind, client_title, client_name, client_known,
       redirect_uri, redirect_mode, state, code_challenge, resource, prompt_login, ip_net, expires_at, policy_print)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now() + make_interval(secs => $18), $21
      WHERE (SELECT count(*) FROM agent_oauth_tx WHERE instance_id = $2 AND expires_at > now()) < $19
        AND ($17::text IS NULL OR (SELECT count(*) FROM agent_oauth_tx WHERE instance_id = $2 AND ip_net = $17 AND expires_at > now()) < $20)`,
    [t.id, t.instance_id, t.cookie_hash, t.csrf, t.client_id, t.client_source, t.client_kind, t.client_title, t.client_name, t.client_known,
     t.redirect_uri, t.redirect_mode, t.state, t.code_challenge, t.resource, t.prompt_login, t.ip_net, TX_TTL_SEC, caps.total, caps.net, t.policy_print]);
  return (r.rowCount ?? 0) === 1 ? "ok" : "capped";
}

/** The transaction as it is (no lock, expired too — `live` says): reading claims nothing. */
export async function readTx(q: Q, instanceId: string, id: string): Promise<TxRow | null> {
  return ((await q.query<TxRow>(`SELECT ${TX_COLS} FROM agent_oauth_tx WHERE id = $1 AND instance_id = $2`, [id, instanceId])).rows[0]) ?? null;
}

/** The live transaction under FOR UPDATE (in a transaction): the decision. */
export async function lockTx(q: Q, instanceId: string, id: string): Promise<TxRow | null> {
  return ((await q.query<TxRow>(`SELECT ${TX_COLS} FROM agent_oauth_tx WHERE id = $1 AND instance_id = $2 AND expires_at > now() FOR UPDATE`,
    [id, instanceId])).rows[0]) ?? null;
}

/**
 * Claim and decide in one write (like claimConsent of the edge): only an undecided live transaction. false — someone decided
 * first or it expired.
 */
export async function decideTx(q: Q, instanceId: string, id: string,
                               d: { person_id: string; session_id: string; decision: "allow" | "deny"; consent_version: number; continue_hash: Buffer }): Promise<boolean> {
  const r = await q.query(`UPDATE agent_oauth_tx SET person_id = $3, session_id = $4, claimed_at = now(), decided_at = now(), decision = $5,
      consent_version = $6, continue_hash = $7
    WHERE id = $1 AND instance_id = $2 AND decision IS NULL AND expires_at > now()`, [id, instanceId, d.person_id, d.session_id, d.decision, d.consent_version, d.continue_hash]);
  return (r.rowCount ?? 0) === 1;
}

/** The same session repeats the same decision (double click, «Continue»): a new continuation key, the old one stops working. */
export async function rekeyTxContinue(q: Q, instanceId: string, id: string, sessionId: string, decision: "allow" | "deny", continueHash: Buffer): Promise<boolean> {
  const r = await q.query(`UPDATE agent_oauth_tx SET continue_hash = $5
    WHERE id = $1 AND instance_id = $2 AND session_id = $3 AND decision = $4 AND expires_at > now()`, [id, instanceId, sessionId, decision, continueHash]);
  return (r.rowCount ?? 0) === 1;
}

/** Delete the transaction first and return it: a repeated continue link finds nothing. `live` — as it was. */
export async function takeTx(q: Q, instanceId: string, id: string): Promise<TxRow | null> {
  return ((await q.query<TxRow>(`DELETE FROM agent_oauth_tx WHERE id = $1 AND instance_id = $2 RETURNING ${TX_COLS}`, [id, instanceId])).rows[0]) ?? null;
}

/** Decided transactions and unused codes of a person (the person is disabled, the administrator revokes their connections). */
export async function deletePersonPending(q: Q, instanceId: string, personId: string): Promise<{ tx: number; codes: number }> {
  const tx = await q.query("DELETE FROM agent_oauth_tx WHERE instance_id = $1 AND person_id = $2", [instanceId, personId]);
  const codes = await q.query("DELETE FROM agent_oauth_codes WHERE instance_id = $1 AND person_id = $2 AND used_at IS NULL", [instanceId, personId]);
  return { tx: tx.rowCount ?? 0, codes: codes.rowCount ?? 0 };
}

/** Every transaction and unused code of the instance (the policy step after a change of issuer, mode or clients). */
export async function deleteAllPending(q: Q, instanceId: string): Promise<{ tx: number; codes: number }> {
  const tx = await q.query("DELETE FROM agent_oauth_tx WHERE instance_id = $1", [instanceId]);
  const codes = await q.query("DELETE FROM agent_oauth_codes WHERE instance_id = $1 AND used_at IS NULL", [instanceId]);
  return { tx: tx.rowCount ?? 0, codes: codes.rowCount ?? 0 };
}

export interface PendingClient { client_id: string; client_source: ClientSourceCol; client_kind: string; dcr_live: boolean }

/** The clients of the instance's transactions and unused codes, each once, with the DCR fact (a live agent_oauth_dcr_clients row). */
export async function pendingClients(q: Q, instanceId: string): Promise<PendingClient[]> {
  return (await q.query<PendingClient>(`SELECT DISTINCT x.client_id, x.client_source, x.client_kind, (d.client_id IS NOT NULL) AS dcr_live
      FROM (SELECT client_id, client_source, client_kind FROM agent_oauth_tx WHERE instance_id = $1
            UNION SELECT client_id, client_source, client_kind FROM agent_oauth_codes WHERE instance_id = $1 AND used_at IS NULL) x
      LEFT JOIN agent_oauth_dcr_clients d ON d.client_id = x.client_id AND d.instance_id = $1 AND d.revoked_at IS NULL`, [instanceId])).rows;
}

/**
 * Transactions and unused codes made for another resource than `resource` or for one of `clients` (same client_id, source
 * and kind): the gateway start, when the state before is unknown but each row records what it was made under.
 */
export async function deleteStalePending(q: Q, instanceId: string, resource: string,
                                         clients: ReadonlyArray<Pick<PendingClient, "client_id" | "client_source" | "client_kind">>): Promise<{ tx: number; codes: number }> {
  const args = [instanceId, resource, clients.map((c) => c.client_id), clients.map((c) => c.client_source), clients.map((c) => c.client_kind)];
  const stale = "(resource <> $2 OR (client_id, client_source, client_kind) IN (SELECT * FROM unnest($3::text[], $4::text[], $5::text[])))";
  const tx = await q.query(`DELETE FROM agent_oauth_tx WHERE instance_id = $1 AND ${stale}`, args);
  const codes = await q.query(`DELETE FROM agent_oauth_codes WHERE instance_id = $1 AND used_at IS NULL AND ${stale}`, args);
  return { tx: tx.rowCount ?? 0, codes: codes.rowCount ?? 0 };
}

// ---------------------------------------------------------------- authorization codes (agent_oauth_codes)

export interface CodeRow {
  code_hash: Buffer; instance_id: string; grant_id: string; person_id: string; session_id: string; client_id: string; client_source: ClientSourceCol;
  client_kind: string; client_label: string; redirect_uri: string; code_challenge: string; resource: string; consent_version: number;
  created_at: Date; expires_at: Date; used_at: Date | null; connection_id: string | null;
  /** the policy_print of the transaction it was minted from: the exchange compares it with the policy now */
  policy_print: Buffer;
}
export type NewCode = Omit<CodeRow, "created_at" | "expires_at" | "used_at" | "connection_id">;

export async function insertCode(q: Q, c: NewCode, ttlSec = CODE_TTL_SEC): Promise<void> {
  await q.query(`INSERT INTO agent_oauth_codes (code_hash, instance_id, grant_id, person_id, session_id, client_id, client_source, client_kind, client_label,
      redirect_uri, code_challenge, resource, consent_version, expires_at, policy_print)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now() + make_interval(secs => $14), $15)`,
    [c.code_hash, c.instance_id, c.grant_id, c.person_id, c.session_id, c.client_id, c.client_source, c.client_kind, c.client_label,
     c.redirect_uri, c.code_challenge, c.resource, c.consent_version, ttlSec, c.policy_print]);
}

/** Use the code once: only an unused, unexpired one. null — see codeByHash for a replay. */
export async function useCode(q: Q, instanceId: string, codeHash: Buffer): Promise<CodeRow | null> {
  return ((await q.query<CodeRow>(`UPDATE agent_oauth_codes SET used_at = now()
    WHERE code_hash = $1 AND instance_id = $2 AND used_at IS NULL AND expires_at > now() RETURNING *`, [codeHash, instanceId])).rows[0]) ?? null;
}

/** The code row as it is: used_at set — a replay of the code. */
export async function codeByHash(q: Q, instanceId: string, codeHash: Buffer): Promise<CodeRow | null> {
  return ((await q.query<CodeRow>("SELECT * FROM agent_oauth_codes WHERE code_hash = $1 AND instance_id = $2", [codeHash, instanceId])).rows[0]) ?? null;
}

/** The connection made from the code: a replay of the code revokes exactly it. */
export async function setCodeConnection(q: Q, instanceId: string, codeHash: Buffer, connectionId: string): Promise<void> {
  await q.query("UPDATE agent_oauth_codes SET connection_id = $3 WHERE code_hash = $1 AND instance_id = $2", [codeHash, instanceId, connectionId]);
}

// ---------------------------------------------------------------- access and refresh tokens (agent_oauth_tokens)

export interface TokenRow {
  token_hash: Buffer; instance_id: string; kind: "at" | "rt"; connection_id: string; generation: number; k_rt_kid: number | null;
  rotated_at: Date | null; successor_hash: Buffer | null; replays: number; created_at: Date; expires_at: Date;
  /** rotated_at within REFRESH_REPLAY_WINDOW_SEC by the database clock (refresh rows; false otherwise). */
  in_replay_window: boolean;
}
const TOKEN_COLS = `token_hash, instance_id, kind, connection_id, generation, k_rt_kid, rotated_at, successor_hash, replays, created_at, expires_at,
  COALESCE(rotated_at > now() - make_interval(secs => ${REFRESH_REPLAY_WINDOW_SEC}), false) AS in_replay_window`;

export async function insertAccessToken(q: Q, t: { token_hash: Buffer; instance_id: string; connection_id: string; expires_at: Date }): Promise<void> {
  await q.query("INSERT INTO agent_oauth_tokens (token_hash, instance_id, kind, connection_id, expires_at) VALUES ($1, $2, 'at', $3, $4)",
    [t.token_hash, t.instance_id, t.connection_id, t.expires_at]);
}

export async function insertRefreshToken(q: Q, t: { token_hash: Buffer; instance_id: string; connection_id: string; generation: number; k_rt_kid: number; expires_at: Date }): Promise<void> {
  await q.query(`INSERT INTO agent_oauth_tokens (token_hash, instance_id, kind, connection_id, generation, k_rt_kid, expires_at)
    VALUES ($1, $2, 'rt', $3, $4, $5, $6)`, [t.token_hash, t.instance_id, t.connection_id, t.generation, t.k_rt_kid, t.expires_at]);
}

/** A token row by hash and kind, unexpired (the access token of a request: authenticateBuiltin reads its connection itself). */
export async function tokenByHash(q: Q, instanceId: string, tokenHash: Buffer, kind: "at" | "rt"): Promise<TokenRow | null> {
  return ((await q.query<TokenRow>(`SELECT ${TOKEN_COLS} FROM agent_oauth_tokens WHERE token_hash = $1 AND instance_id = $2 AND kind = $3 AND expires_at > now()`,
    [tokenHash, instanceId, kind])).rows[0]) ?? null;
}

/** The refresh row under FOR UPDATE (in a transaction), unexpired: one refresh of a family at a time. */
export async function lockRefreshToken(q: Q, instanceId: string, tokenHash: Buffer): Promise<TokenRow | null> {
  return ((await q.query<TokenRow>(`SELECT ${TOKEN_COLS} FROM agent_oauth_tokens
    WHERE token_hash = $1 AND instance_id = $2 AND kind = 'rt' AND expires_at > now() FOR UPDATE`, [tokenHash, instanceId])).rows[0]) ?? null;
}

/** Mark the refresh row rotated to its successor: only an unrotated one (false — someone rotated it first). */
export async function markRotated(q: Q, instanceId: string, tokenHash: Buffer, successorHash: Buffer): Promise<boolean> {
  const r = await q.query(`UPDATE agent_oauth_tokens SET rotated_at = now(), successor_hash = $3
    WHERE token_hash = $1 AND instance_id = $2 AND kind = 'rt' AND rotated_at IS NULL`, [tokenHash, instanceId, successorHash]);
  return (r.rowCount ?? 0) === 1;
}

/**
 * The rotated refresh token presented again within the window (a lost response): count it. Only while its successor is
 * still the head of the family — the successor row is there, unexpired and not rotated itself: once the client
 * used the successor, the old token is a replay of a replaced token whatever the window says. false — outside the window,
 * the limit used up or the successor moved on: the caller revokes the connection.
 */
export async function noteReplay(q: Q, instanceId: string, tokenHash: Buffer): Promise<boolean> {
  const r = await q.query(`UPDATE agent_oauth_tokens t SET replays = t.replays + 1
    WHERE t.token_hash = $1 AND t.instance_id = $2 AND t.kind = 'rt' AND t.rotated_at IS NOT NULL
      AND t.rotated_at > now() - make_interval(secs => $3) AND t.replays < $4
      AND EXISTS (SELECT 1 FROM agent_oauth_tokens s WHERE s.token_hash = t.successor_hash AND s.instance_id = t.instance_id
                     AND s.kind = 'rt' AND s.rotated_at IS NULL AND s.expires_at > now())`,
    [tokenHash, instanceId, REFRESH_REPLAY_WINDOW_SEC, REFRESH_MAX_REPLAYS]);
  return (r.rowCount ?? 0) === 1;
}

/** Revoke one access token (RFC 7009 for mem_oat_). */
export async function deleteAccessToken(q: Q, instanceId: string, tokenHash: Buffer): Promise<number> {
  return (await q.query("DELETE FROM agent_oauth_tokens WHERE token_hash = $1 AND instance_id = $2 AND kind = 'at'", [tokenHash, instanceId])).rowCount ?? 0;
}

/** Every token of a connection (the connection is revoked: the family is gone with it). */
export async function deleteConnectionTokens(q: Q, instanceId: string, connectionId: string): Promise<number> {
  return (await q.query("DELETE FROM agent_oauth_tokens WHERE connection_id = $1 AND instance_id = $2", [connectionId, instanceId])).rowCount ?? 0;
}

// ---------------------------------------------------------------- connections of the built-in server (api_keys + oauth_connections)

/** basis of the api_keys row of a connection made by the built-in server (the external identity provider one says 'OAuth browser login'). */
export const BUILTIN_CONNECTION_BASIS = "OAuth built-in sign-in";

export interface NewBuiltinConnection {
  instance_id: string; person_id: string;
  /** grant_id of the code: the connection's session_id, as the edge keeps its grant id there. */
  grant_id: string;
  client_id: string; client_kind: string; client_label: string;
  /** Issuer and resource of the code, as the policy checks them on every request. */
  issuer: string; resource: string;
  consent_version: number;
  /** agent_auth.connection_days (1–90; api_keys_oauth_grant_check refuses more than 90). */
  connection_days: number;
}

/**
 * The connection made by a code exchange, inside the exchange transaction: the api_keys row of a personal T2
 * OAuth grant — the same columns as an external identity provider connection (oauth.ts, authenticateOAuth), basis BUILTIN_CONNECTION_BASIS — and
 * its oauth_connections row with origin builtin, subject = people.id, session_id = the grant id of the code. The schema
 * guards hold it (oauth_connection_guard, api_keys_oauth_grant_check); the caller has checked the code, the person and the
 * policy. Returns the connection id (api_keys.id) and its expiry: tokens never outlive it, a refresh never extends it.
 */
export async function createBuiltinConnection(q: Q, c: NewBuiltinConnection): Promise<{ id: string; expires_at: Date }> {
  const id = newId();
  const k = await q.query<{ expires_at: Date }>(`INSERT INTO api_keys (id, key_prefix, key_hash, auth_method, principal_type, principal_id, kind, tier, instance_id,
      client_label, client_kind, created_at, expires_at, basis)
    VALUES ($1, 'oauth', NULL, 'oauth', 'person', $2, 'personal', 'T2', $3, $4, $5, now(), now() + make_interval(days => $6::int), $7) RETURNING expires_at`,
    [id, c.person_id, c.instance_id, c.client_label, c.client_kind, c.connection_days, BUILTIN_CONNECTION_BASIS]);
  await q.query(`INSERT INTO oauth_connections (id, instance_id, issuer, subject, client_id, session_id, person_id, resource_url, origin, consent_version)
    VALUES ($1, $2, $3, $4::text, $5, $6::text, $4::uuid, $7, 'builtin', $8)`,
    [id, c.instance_id, c.issuer, c.person_id, c.client_id, c.grant_id, c.resource, c.consent_version]);
  return { id, expires_at: new Date(k.rows[0]!.expires_at) };
}

/**
 * Revoke a builtin connection and delete its tokens in a transaction of its own, committed before the caller answers
 * after a replayed code or refresh token the exchange answers invalid_grant once its main transaction rolled back,
 * and the revocation must not roll back with it. Call it after that ROLLBACK, never from inside another transaction of the
 * same person (it waits for the person row). Locks in this order: the shared policy lock (oauth.ts, policyRead),
 * then the person row; plans of the connection are cancelled by the same statement (revokeWhere). Other connections of
 * the person and connections of other origins are untouched.
 */
export async function revokeConnectionFamily(app: Pick<App, "db" | "instanceId">, connectionId: string): Promise<{ revoked: number; tokens: number }> {
  return tx(app.db.control, async (q) => {
    await q.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [oauthPolicyLock(app)]);
    const c = (await q.query<{ person_id: string }>("SELECT person_id FROM oauth_connections WHERE id = $1 AND instance_id = $2 AND origin = 'builtin'",
      [connectionId, app.instanceId])).rows[0];
    let revoked = 0;
    if (c) {
      await q.query("SELECT 1 FROM people WHERE id = $1 AND instance_id = $2 FOR UPDATE", [c.person_id, app.instanceId]);
      revoked = await revokeWhere(q, "c.instance_id=$1 AND c.origin='builtin' AND c.id=$2", [app.instanceId, connectionId]);
    }
    const tokens = await deleteConnectionTokens(q, app.instanceId, connectionId);
    return { revoked, tokens };
  });
}

// ---------------------------------------------------------------- clients registered by DCR (agent_oauth_dcr_clients)

export interface DcrClientRow {
  client_id: string; instance_id: string; client_name: string | null; redirect_uris: string[]; software_id: string | null; software_version: string | null;
  created_ip_prefix: string | null; created_at: Date; last_authorize_at: Date | null; first_used_at: Date | null; last_used_at: Date | null; revoked_at: Date | null;
  /** registered from a network of agent_auth.dcr_trusted_egress: counted in dcr_limits.per_day_trusted */
  trusted_egress: boolean;
}
export type NewDcrClient = Pick<DcrClientRow, "client_id" | "instance_id" | "client_name" | "redirect_uris" | "software_id" | "software_version" | "created_ip_prefix">;
export type DcrRefusal = "per_day" | "per_day_net" | "per_day_trusted" | "max_clients";

/**
 * Register a client within the limits: registrations of the network (created_ip_prefix) and of the instance in the
 * last DCR_DAY_HOURS (the sweep keeps every row that young), live clients of the instance. Must run in a transaction: an
 * advisory lock of the instance serializes the count and the insert, so parallel registrations cannot pass a limit together.
 * o.trustedEgress — the caller's address is in agent_auth.dcr_trusted_egress (the published egress of a cloud app that
 * registers one client per employee from a few shared networks): held to per_day_trusted — the registrations of the day
 * from any trusted egress (the row's trusted_egress) — instead of per_day_net, and to per_day like everybody (unlimited,
 * any user of the listed cloud could use up per_day for the whole instance again; with a share below the
 * day the other networks always keep per_day − per_day_trusted). Only the address decides — the one requestChannel derives
 * with access.trusted_proxies, never anything the request says (the shape of the return addresses is the
 * anonymous caller's choice). max_clients holds for everybody, and the row still counts for the network's other
 * registrations.
 */
export async function insertDcrClientLimited(q: Q, c: NewDcrClient, limits: DcrLimits, o: { trustedEgress?: boolean } = {}): Promise<"ok" | DcrRefusal> {
  const trusted = o.trustedEgress === true;
  await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`agent-oauth-dcr:${c.instance_id}`]);
  const n = (await q.query<{ day: number; net: number; trusted: number; live: number }>(
    `SELECT count(*) FILTER (WHERE created_at > now() - interval '${DCR_DAY_HOURS} hours')::int AS day,
            count(*) FILTER (WHERE created_at > now() - interval '${DCR_DAY_HOURS} hours' AND $2::text IS NOT NULL AND created_ip_prefix = $2)::int AS net,
            count(*) FILTER (WHERE created_at > now() - interval '${DCR_DAY_HOURS} hours' AND trusted_egress)::int AS trusted,
            count(*) FILTER (WHERE revoked_at IS NULL)::int AS live
       FROM agent_oauth_dcr_clients WHERE instance_id = $1`, [c.instance_id, c.created_ip_prefix])).rows[0] ?? { day: 0, net: 0, trusted: 0, live: 0 };
  if (trusted && n.trusted >= limits.per_day_trusted) return "per_day_trusted";
  if (!trusted && c.created_ip_prefix !== null && n.net >= limits.per_day_net) return "per_day_net";
  if (n.day >= limits.per_day) return "per_day";
  if (n.live >= limits.max_clients) return "max_clients";
  await q.query(`INSERT INTO agent_oauth_dcr_clients (client_id, instance_id, client_name, redirect_uris, software_id, software_version, created_ip_prefix, trusted_egress)
    VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
    [c.client_id, c.instance_id, c.client_name, JSON.stringify(c.redirect_uris), c.software_id, c.software_version, c.created_ip_prefix, trusted]);
  return "ok";
}

/** The DCR client, revoked too (revoked_at says). */
export async function dcrClient(q: Q, instanceId: string, clientId: string): Promise<DcrClientRow | null> {
  return ((await q.query<DcrClientRow>("SELECT * FROM agent_oauth_dcr_clients WHERE client_id = $1 AND instance_id = $2", [clientId, instanceId])).rows[0]) ?? null;
}

/** GET /oauth/authorize with this client: last_authorize_at, at most once a minute (the sweep keeps clients in use). */
export async function noteDcrAuthorize(q: Q, instanceId: string, clientId: string): Promise<void> {
  await q.query(`UPDATE agent_oauth_dcr_clients SET last_authorize_at = now()
    WHERE client_id = $1 AND instance_id = $2 AND revoked_at IS NULL AND (last_authorize_at IS NULL OR last_authorize_at < now() - interval '1 minute')`,
    [clientId, instanceId]);
}

/**
 * The client was used — a code exchanged or a refresh token rotated: first_used_at once, last_used_at at most once a
 * minute (one registration may serve many people — ChatGPT registers once per app — and every refresh would otherwise
 * write the same row).
 */
export async function noteDcrUsed(q: Q, instanceId: string, clientId: string): Promise<void> {
  await q.query(`UPDATE agent_oauth_dcr_clients SET first_used_at = COALESCE(first_used_at, now()), last_used_at = now()
    WHERE client_id = $1 AND instance_id = $2
      AND (first_used_at IS NULL OR last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`, [clientId, instanceId]);
}

/** Revoke the client (the administrator): only a live one. The caller revokes its connections in the same transaction. */
export async function revokeDcrClient(q: Q, instanceId: string, clientId: string): Promise<boolean> {
  const r = await q.query("UPDATE agent_oauth_dcr_clients SET revoked_at = now() WHERE client_id = $1 AND instance_id = $2 AND revoked_at IS NULL", [clientId, instanceId]);
  return (r.rowCount ?? 0) === 1;
}

/** Sign-in transactions and unused codes of one client (its DCR registration revoked by the administrator). */
export async function deleteClientPending(q: Q, instanceId: string, clientId: string): Promise<{ tx: number; codes: number }> {
  const tx = await q.query("DELETE FROM agent_oauth_tx WHERE instance_id = $1 AND client_id = $2", [instanceId, clientId]);
  const codes = await q.query("DELETE FROM agent_oauth_codes WHERE instance_id = $1 AND client_id = $2 AND used_at IS NULL", [instanceId, clientId]);
  return { tx: tx.rowCount ?? 0, codes: codes.rowCount ?? 0 };
}

export interface DcrClientItem extends DcrClientRow { active_connections: number }

/**
 * DCR clients of the instance for the panel, newest first, by pages: keyset (created_at, client_id). next — the cursor
 * of the next page or null; its created_at is the database's text of the last row's time with microseconds (keysetAtSql):
 * node-postgres reads timestamptz into a Date with milliseconds only, and a cursor cut to the millisecond skipped every
 * row of that millisecond after the last one (two registrations whose transactions start in the same millisecond). A
 * cursor with milliseconds (issued before, or a Date) reads as that instant.
 */
export async function listDcrClients(q: Q, instanceId: string, o: { limit?: number; after?: { created_at: Date | string; client_id: string } | null } = {}):
    Promise<{ items: DcrClientItem[]; next: { created_at: string; client_id: string } | null }> {
  const limit = Math.max(1, Math.min(200, Math.trunc(o.limit ?? 50)));
  const after = o.after ?? null;
  const at = after === null ? null : typeof after.created_at === "string" ? after.created_at : after.created_at.toISOString();
  const rows = (await q.query<DcrClientItem & { at_key: string }>(
    `SELECT d.*, ${keysetAtSql("d.created_at")} AS at_key,
            (SELECT count(*)::int FROM oauth_connections c JOIN api_keys k ON k.id = c.id
              WHERE c.instance_id = d.instance_id AND c.origin = 'builtin' AND c.client_id = d.client_id
                AND k.revoked_at IS NULL AND k.expires_at > now()) AS active_connections
       FROM agent_oauth_dcr_clients d
      WHERE d.instance_id = $1 AND ($2::timestamptz IS NULL OR (d.created_at, d.client_id) < ($2::timestamptz, $3::text))
      ORDER BY d.created_at DESC, d.client_id DESC LIMIT $4`,
    [instanceId, at, after?.client_id ?? null, limit + 1])).rows;
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const items = page.map(({ at_key: _key, ...item }) => item);
  return { items, next: more && last ? { created_at: last.at_key, client_id: last.client_id } : null };
}

// ---------------------------------------------------------------- the cache of client metadata documents

// The numbers and the lifetime rule are the pure ones of packages/shared/src/oauth-as/cimd.ts (CIMD_CACHE_MAX,
// CIMD_HOST_COOLING_MS, CIMD_CLIENT_NEGATIVE_MS, cimdCacheTtlMs) — one definition, tested there and end to end
// by unit tests; this module keeps no copies of them.

/**
 * Cache lifetime of a fetched document in seconds (CimdCache.set takes seconds): the shared rule of — max-age clamped
 * to 5 minutes … 3 days; no header — 1 hour; no-store, no-cache and max-age=0 — 5 minutes too.
 */
export const cimdTtlSec = (cacheControl: string | null | undefined): number => cimdCacheTtlMs(cacheControl) / 1000;

/**
 * In-process LRU of client metadata documents by client_id, plus the negative caches: a failed host for 5 minutes, a failed
 * client_id for 60 seconds. An expired entry is never returned (a failed refetch must not fall back to it: the
 * document may have changed its redirect addresses). clear() — on every save of agent_auth.* (policy-step.ts).
 */
interface CimdNegative { reason: string; until: number; status?: number; rule?: number }

export class CimdCache<T> {
  private readonly docs = new Map<string, { value: T; until: number }>();
  private readonly badHosts = new Map<string, CimdNegative>();
  private readonly badClients = new Map<string, CimdNegative>();
  constructor(private readonly max = CIMD_CACHE_MAX, private readonly now: () => number = Date.now) {}

  get(clientId: string): T | null {
    const e = this.docs.get(clientId);
    if (!e) return null;
    if (e.until <= this.now()) { this.docs.delete(clientId); return null; }
    this.docs.delete(clientId); this.docs.set(clientId, e);   // most recently used last
    return e.value;
  }
  set(clientId: string, value: T, ttlSec: number): void {
    this.docs.delete(clientId);
    this.docs.set(clientId, { value, until: this.now() + Math.max(0, ttlSec) * 1000 });
    while (this.docs.size > this.max) { const oldest = this.docs.keys().next().value; if (oldest === undefined) break; this.docs.delete(oldest); }
  }
  /**
   * Remember a failure: the host for 5 minutes (network, TLS, timeout of the host), the client_id for 60 seconds. status
   * and rule (the HTTP status, the rule) come back with failure(): the page names the cause.
   */
  fail(clientId: string, host: string | null, reason: string, o: { host?: boolean; status?: number; rule?: number } = {}): void {
    this.docs.delete(clientId);
    const detail = { ...(o.status !== undefined ? { status: o.status } : {}), ...(o.rule !== undefined ? { rule: o.rule } : {}) };
    this.badClients.set(clientId, { reason, until: this.now() + CIMD_CLIENT_NEGATIVE_MS, ...detail });
    if (o.host && host) this.badHosts.set(host, { reason, until: this.now() + CIMD_HOST_COOLING_MS, ...detail });
    for (const m of [this.badClients, this.badHosts]) while (m.size > this.max) { const k = m.keys().next().value; if (k === undefined) break; m.delete(k); }
  }
  /** A remembered failure of this client_id or its host, or null. */
  failure(clientId: string, host: string | null): { reason: string; scope: "client" | "host"; status?: number; rule?: number } | null {
    const t = this.now();
    const detail = (e: CimdNegative) => ({ ...(e.status !== undefined ? { status: e.status } : {}), ...(e.rule !== undefined ? { rule: e.rule } : {}) });
    const c = this.badClients.get(clientId);
    if (c && c.until > t) return { reason: c.reason, scope: "client", ...detail(c) };
    if (c) this.badClients.delete(clientId);
    const h = host ? this.badHosts.get(host) : undefined;
    if (h && h.until > t) return { reason: h.reason, scope: "host", ...detail(h) };
    if (h && host) this.badHosts.delete(host);
    return null;
  }
  clear(): void { this.docs.clear(); this.badHosts.clear(); this.badClients.clear(); }
  get size(): number { return this.docs.size; }
}

/**
 * The process cache of client metadata documents (filled by the CIMD fetch, cimd-fetch.ts, with validated CimdDocument
 * values only; cleared by the policy step).
 */
export const agentAuthCimdCache = new CimdCache<unknown>();

// ---------------------------------------------------------------- the lazy sweep

const lastSweep = new Map<string, number>();

export interface SweepResult { tx: number; codes: number; tokens: number; dcr: number }

/**
 * Remove what is no longer needed, in batches of SWEEP_BATCH: transactions expired over an hour ago, codes expired
 * over 10 minutes ago (a code outlives its term a little to recognise a replay), tokens expired or of a connection that is
 * revoked, expired or gone, DCR clients never used for unused_hours since the last authorize (or creation) and revoked ones
 * without live connections after DCR_REVOKED_KEEP_DAYS — never a DCR row registered within DCR_DAY_HOURS: the daily limits
 * count those rows, and deleting one would hand its place back before the day is over. Lazy: at most once per
 * SWEEP_EVERY_MS per process and instance; the AS routes and authenticateBuiltin call it, there is no timer. force — tests.
 * Errors go to the log, never to the caller.
 */
export async function sweepAgentAuth(app: Pick<App, "db" | "instanceId">, o: { force?: boolean; limits?: Pick<DcrLimits, "unused_hours">; now?: number } = {}): Promise<SweepResult | null> {
  const now = o.now ?? Date.now();
  const key = app.instanceId;
  if (!o.force && now - (lastSweep.get(key) ?? 0) < SWEEP_EVERY_MS) return null;
  lastSweep.set(key, now);
  try {
    if (!(await agentAuthTablesPresent(app))) return null;
    const q = app.db.control;
    const inst = app.instanceId;
    const unusedHours = o.limits?.unused_hours ?? 720;
    const tx = (await q.query(`DELETE FROM agent_oauth_tx WHERE id IN (SELECT id FROM agent_oauth_tx
        WHERE instance_id = $1 AND expires_at < now() - interval '1 hour' LIMIT $2)`, [inst, SWEEP_BATCH])).rowCount ?? 0;
    const codes = (await q.query(`DELETE FROM agent_oauth_codes WHERE code_hash IN (SELECT code_hash FROM agent_oauth_codes
        WHERE instance_id = $1 AND expires_at < now() - interval '10 minutes' LIMIT $2)`, [inst, SWEEP_BATCH])).rowCount ?? 0;
    const tokens = (await q.query(`DELETE FROM agent_oauth_tokens WHERE token_hash IN (SELECT t.token_hash FROM agent_oauth_tokens t
        WHERE t.instance_id = $1 AND (t.expires_at < now()
           OR NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.id = t.connection_id AND k.revoked_at IS NULL AND k.expires_at > now()))
        LIMIT $2)`, [inst, SWEEP_BATCH])).rowCount ?? 0;
    const dcr = (await q.query(`DELETE FROM agent_oauth_dcr_clients WHERE client_id IN (SELECT d.client_id FROM agent_oauth_dcr_clients d
        WHERE d.instance_id = $1 AND d.created_at < now() - interval '${DCR_DAY_HOURS} hours' AND (
              (d.first_used_at IS NULL AND COALESCE(d.last_authorize_at, d.created_at) < now() - make_interval(hours => $3))
           OR (d.revoked_at IS NOT NULL AND d.revoked_at < now() - make_interval(days => $4)
               AND NOT EXISTS (SELECT 1 FROM oauth_connections c JOIN api_keys k ON k.id = c.id
                                WHERE c.instance_id = d.instance_id AND c.origin = 'builtin' AND c.client_id = d.client_id
                                  AND k.revoked_at IS NULL AND k.expires_at > now())))
        LIMIT $2)`, [inst, SWEEP_BATCH, unusedHours, DCR_REVOKED_KEEP_DAYS])).rowCount ?? 0;
    if (tx || codes || tokens || dcr) log.info("agent_auth_sweep", { tx, codes, tokens, dcr });
    return { tx, codes, tokens, dcr };
  } catch (e) {
    log.warn("agent_auth_sweep_failed", { error: ((e as Error)?.message ?? "").slice(0, 160) });
    return null;
  }
}

/** Tests: forget when the sweep last ran. */
export function resetAgentAuthSweepForTests(): void { lastSweep.clear(); }
