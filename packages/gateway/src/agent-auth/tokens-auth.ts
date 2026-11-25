// Sign-in of a request by an access token of the built-in authorization server: the opaque
// mem_oat_ token that /oauth/token issued. Only in agent_auth.mode = builtin (auth.ts checks the mode from the settings
// cache before calling, this module checks it again inside the transaction). The token is looked up by its SHA-256 — the
// database never holds the text — and admits a request only while
//   - the token row is unexpired (the database clock) and belongs to a builtin connection of this instance;
//   - the connection passes connectionPolicyAllows (oauth.ts): mode builtin and ready, its issuer and resource are the
//     current ones, the client is still allowed (registry row enabled with the same kind, CIMD host admitted, DCR on and
//     the client alive), the connection is active (not revoked, not expired) and belongs to the same person;
//   - the person is active and not a demo person.
// A refused token throws OAuthRejected: auth.ts answers the English 401 (OAUTH_TOKEN_TEXT) without counting the failure
// against the client address. The result is the caller of an external identity provider connection (callerForGrant: T2, open
// only, personal tool groups) plus connectionOrigin "builtin" — memory_me picks the expiry text by it.
import type { App, Caller, PersonRow } from "../context.ts";
import { agentAuthConfig, agentAuthMode, agentAuthProblems } from "@memory/shared";
import { ACCESS_PREFIX, isToken, sha256 } from "@memory/shared/oauth-as";
import { callerForGrant, connectionPolicyAllows, GRANT, OAuthRejected, PERSON, policyRead, type Grant } from "../oauth.ts";
import { agentAuthFacts } from "./readiness.ts";
import { sweepAgentAuth } from "./store.ts";

/** The connection and the person a token admitted (tests and the routes use the same read). */
export interface BuiltinGrant { grant: Grant; person: PersonRow }

/**
 * The caller of a request that presented `token` (a mem_oat_ string). Throws OAuthRejected when the token is not one of
 * ours, unknown, expired or its connection is no longer allowed. ip — the client address (last_used_ip); baseUrl — as for
 * every caller (links in answers).
 */
export async function authenticateBuiltin(app: App, token: string, ip: string | null, baseUrl: string): Promise<Caller> {
  if (!isToken(ACCESS_PREFIX, token)) throw new OAuthRejected();
  if (agentAuthMode(app.settings) !== "builtin") throw new OAuthRejected();
  // the lazy sweep of the [AS] tables: at most once per 5 minutes per process, never in the way of the request
  void sweepAgentAuth(app, { limits: agentAuthConfig(app.settings).dcr_limits });
  const hash = sha256(token);
  const out = await policyRead(app, async (q, _cfg, settings) => {
    // the mode of the transaction's settings: a switch committed after the cache was read admits nothing
    if (agentAuthMode(settings) !== "builtin") return null;
    const facts = await agentAuthFacts(app, q);
    if (agentAuthProblems(settings, facts).length) return null;
    const g = (await q.query<Grant>(`SELECT ${GRANT},(d.client_id IS NOT NULL) AS dcr_live FROM agent_oauth_tokens t
        JOIN api_keys k ON k.id=t.connection_id JOIN oauth_connections c ON c.id=k.id
        LEFT JOIN agent_oauth_dcr_clients d ON d.client_id=c.client_id AND d.instance_id=c.instance_id AND d.revoked_at IS NULL
      WHERE t.token_hash=$1 AND t.kind='at' AND t.instance_id=$2 AND t.expires_at>now() AND c.origin='builtin' AND k.auth_method='oauth'`,
      [hash, app.instanceId])).rows[0];
    if (!g || !connectionPolicyAllows(app, settings, g, facts)) return null;
    const p = (await q.query<PersonRow & { demo: boolean }>(`SELECT ${PERSON} FROM people p WHERE p.id=$1 AND p.instance_id=$2`, [g.person_id, app.instanceId])).rows[0];
    if (!p?.active || p.demo) return null;
    // the address and the time of use, at most once a minute: the idle term of the refresh token reads it
    await q.query("UPDATE api_keys SET last_used_at=now(), last_used_ip=$2::inet WHERE id=$1 AND (last_used_at IS NULL OR last_used_at < now()-interval '1 minute')",
      [g.id, ip]);
    return { grant: g, person: p } satisfies BuiltinGrant;
  });
  if (!out) throw new OAuthRejected();
  return { ...callerForGrant(out.grant, out.person, ip, baseUrl), connectionOrigin: "builtin" };
}
