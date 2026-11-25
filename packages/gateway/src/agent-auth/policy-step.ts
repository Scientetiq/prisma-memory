// The common step of meaningful changes of agent sign-in: run under the EXCLUSIVE policy lock
// (oauth.ts, oauthPolicyLock), in the transaction that saves settings, before the write, on the future state:
//   1. the future mode is not external — every external identity provider connection is revoked (one mode at a time);
//   2. every live builtin connection goes through connectionPolicyAllows(future) — those that fail are revoked (mode not
//      builtin, builtin not ready, another issuer or resource, client disabled or gone, CIMD entry removed, DCR off or
//      client revoked);
//   3. issuer, resource, workplace, mode, registry, CIMD or DCR changed — every sign-in transaction and unused code of the
//      instance is deleted. At startup the state before is unknown, but each row records its client and resource: only
//      the rows the current policy no longer allows go (all of them when the mode is not builtin or builtin is not ready),
//      so a restart or a rolling update does not break a consent in progress.
// Revocation survives reverting the settings: setting the old value back revives nothing. Callers: PUT /settings
// (admin.ts), operator recovery (admin-plane/recovery.ts), gateway start (index.ts: catches edits past the API).
import type pg from "pg";
import { agentAuthConfig, agentAuthIssuer, agentAuthMode, agentAuthProblems, canonicalJson, CLOUD_AGENT_BASE_SETTING, log, policyAllows, SETTINGS_READ_WHOLE, type Settings } from "@memory/shared";
import { sha256 } from "@memory/shared/oauth-as";
import type { App } from "../context.ts";
import { connectionPolicyAllows, GRANT, revokeWhere, withOAuthPolicyLock, type Grant } from "../oauth.ts";
import { agentAuthFacts } from "./readiness.ts";
import { agentAuthCimdCache, deleteAllPending, deleteStalePending, pendingClients } from "./store.ts";

type Getter = Pick<Settings, "get">;
type Q = Pick<pg.PoolClient, "query">;

export type AgentAuthStepReason = "settings" | "recovery" | "startup";
export interface AgentAuthStepResult { keycloak: number; builtin: number; tx: number; codes: number }

/** Addresses the built-in server is built from: the issuer chain and the workplace (consent page). */
export const AGENT_AUTH_ADDRESS_KEYS: readonly string[] = [CLOUD_AGENT_BASE_SETTING, "access.public_base_url", "access.workplace_url"];

/** Does a save of these keys need the step (and the exclusive policy lock): category agent_auth or one of the addresses. */
export function agentAuthStepNeeded(paths: Iterable<string>): boolean {
  for (const p of paths) if (p.startsWith("agent_auth.") || AGENT_AUTH_ADDRESS_KEYS.includes(p)) return true;
  return false;
}

const jsonType = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const isPlainObject = (v: unknown): v is Record<string, unknown> => jsonType(v) === "object";

/**
 * Settings after the batch, read exactly as Settings.get will read them once it is saved: null and "" — not set (the
 * caller's fallback), a value of another JSON type than the seed default — the default, an object merged over the default
 * (a key of SETTINGS_READ_WHOLE — agent_auth.dcr_limits, oauth.allowed_clients — as given, never merged),
 * an array replaced. Keys outside the batch — as they are now.
 */
export function futureSettings(settings: Pick<Settings, "get" | "meta">, items: ReadonlyArray<{ category: string; key: string; value?: unknown }>): Getter {
  const next = new Map(items.map((i) => [`${i.category}.${i.key}`, i.value ?? null] as const));
  return {
    get: <T,>(path: `${string}.${string}`, fallback: T): T => {
      if (!next.has(path)) return settings.get<T>(path, fallback);
      const v = next.get(path);
      if (v === null || v === undefined || v === "") return fallback;
      const def = settings.meta(path).defaultValue;
      const ref = def ?? fallback;
      if (ref !== null && ref !== undefined && jsonType(ref) !== jsonType(v)) return (def ?? fallback) as T;
      if (SETTINGS_READ_WHOLE.has(path)) return v as T;
      if (isPlainObject(v) && isPlainObject(ref)) return { ...(fallback as object), ...(isPlainObject(def) ? def : {}), ...v } as T;
      return v as T;
    },
  };
}

/**
 * What the transactions and codes were made under: when it changes, a started sign-in must start again. Canonical JSON
 * (canonicalJson of settings-policy.ts: object keys sorted at every depth, arrays in their order): the
 * registry rows of a save keep the key order the administrator sent, the database (jsonb) its own — the same registry
 * with its keys in another order must not end every sign-in in progress, a changed value still does.
 */
function txPrint(s: Getter): string {
  const cfg = agentAuthConfig(s);
  const addr = agentAuthIssuer(s);
  return canonicalJson([addr.issuer, addr.resource, addr.workplace, cfg.mode, cfg.clients, cfg.cimd_hosts, cfg.cimd_any_https, cfg.dcr_enabled]);
}

/**
 * The same print as a 32-byte value a transaction and its code carry (agent_oauth_tx.policy_print,
 * agent_oauth_codes.policy_print): /oauth/authorize stores the print of the settings it checked the client
 * with, continue and the code exchange compare it with the print of the settings read from the database under the shared
 * policy lock. The policy step deletes every pending row when the print changes through the API; the print stops what that
 * cannot — a gateway whose settings cache is older than the change (another process saved it) minting a usable code under
 * rules that are gone.
 */
export function agentAuthPolicyPrint(s: Getter): Buffer {
  return sha256(txPrint(s));
}
/** Two prints are the same (a row without one never is). */
export function samePolicyPrint(a: Buffer | null | undefined, b: Buffer): boolean {
  return Buffer.isBuffer(a) && a.length === b.length && a.equals(b);
}

type Listener = (reason: AgentAuthStepReason) => void;
const listeners = new Set<Listener>();
/** Be told after every step (the CIMD fetch keeps its own state there). Returns the unsubscribe function. */
export function onAgentAuthPolicyChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * The step itself. q — the transaction of the save, under the exclusive oauthPolicyLock; future — the settings after it;
 * before — the settings before it (unknown at startup: then each transaction and unused code is judged by the client and
 * resource it records). The [AS] tables may be absent (sandboxes of tests apply 17 without 09): then only step 1 runs.
 */
export async function applyAgentAuthPolicy(app: App, q: Q, future: Getter, o: { before?: Getter; reason: AgentAuthStepReason }): Promise<AgentAuthStepResult> {
  const out: AgentAuthStepResult = { keycloak: 0, builtin: 0, tx: 0, codes: 0 };
  if (agentAuthMode(future) !== "external") out.keycloak = await revokeWhere(q, "c.instance_id=$1 AND c.origin='keycloak'", [app.instanceId]);
  const facts = await agentAuthFacts(app, q);
  if (facts.schema) {
    // no FOR UPDATE: new builtin connections are made by a code exchange under the shared policy lock, here it is exclusive
    const rows = (await q.query<Grant>(`SELECT ${GRANT},(d.client_id IS NOT NULL) AS dcr_live FROM oauth_connections c JOIN api_keys k ON k.id=c.id
      LEFT JOIN agent_oauth_dcr_clients d ON d.client_id=c.client_id AND d.instance_id=c.instance_id AND d.revoked_at IS NULL
      WHERE c.instance_id=$1 AND c.origin='builtin' AND k.auth_method='oauth' AND k.revoked_at IS NULL AND k.expires_at>now()`, [app.instanceId])).rows;
    const off = rows.filter((g) => !connectionPolicyAllows(app, future, g, facts)).map((g) => g.id);
    if (off.length) out.builtin = await revokeWhere(q, "c.instance_id=$1 AND c.origin='builtin' AND c.id = ANY($2::uuid[])", [app.instanceId, off]);
    const d = !o.before ? await stalePendingAtStartup(app, q, future, facts)
      : txPrint(o.before) !== txPrint(future) ? await deleteAllPending(q, app.instanceId) : { tx: 0, codes: 0 };
    out.tx = d.tx; out.codes = d.codes;
  }
  // the CIMD document cache is cleared on every save of agent_auth.*: the host admission may have narrowed
  agentAuthCimdCache.clear();
  for (const fn of listeners) { try { fn(o.reason); } catch (e) { log.warn("agent_auth_policy_listener_failed", { error: ((e as Error)?.message ?? "").slice(0, 160) }); } }
  if (out.keycloak || out.builtin || out.tx || out.codes) log.info("agent_auth_policy_step", { reason: o.reason, ...out });
  return out;
}

/**
 * Step 3 at startup: what changed while the gateway was down is unknown, but a row records
 * its client (id, source, kind) and its resource. Not builtin or not ready — nothing can continue a sign-in: every row
 * goes. Otherwise only rows for another resource (the issuer changed) or for a client the policy no longer allows
 * (switched off, removed, its CIMD entry gone, DCR off or the client revoked). The workplace is not recorded in a row: a
 * transaction lives at most 10 minutes, and continue and the token exchange check the client and the policy again.
 */
async function stalePendingAtStartup(app: App, q: Q, future: Getter, facts: { schema: boolean; routes: boolean }): Promise<{ tx: number; codes: number }> {
  if (agentAuthMode(future) !== "builtin" || agentAuthProblems(future, facts).length) return deleteAllPending(q, app.instanceId);
  const policy = agentAuthConfig(future);
  const off = (await pendingClients(q, app.instanceId))
    .filter((c) => !policyAllows(policy, { client_id: c.client_id, kind: c.client_kind, source: c.client_source, dcr_live: c.dcr_live }));
  return deleteStalePending(q, app.instanceId, agentAuthIssuer(future).resource, off);
}

/**
 * At gateway start, once, in the background (index.ts): the step under the exclusive lock on the current settings — catches
 * a mode or a policy changed past the API (a SQL edit, a restore of a copy). Errors go to the log, never stop the start.
 */
export async function agentAuthStartupStep(app: App): Promise<AgentAuthStepResult | null> {
  try {
    return await withOAuthPolicyLock(app, (q, settings) => applyAgentAuthPolicy(app, q, settings, { reason: "startup" }));
  } catch (e) {
    log.warn("agent_auth_startup_step_failed", { error: ((e as Error)?.message ?? "").slice(0, 200) });
    return null;
  }
}
