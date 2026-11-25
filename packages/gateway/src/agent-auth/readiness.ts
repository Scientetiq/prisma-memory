// Facts of the built-in agent sign-in server that only the process and the database know (readiness — of the
// task): are the tables of the [AS] part there (contracts/schema/17-basic-tails.sql applies it only with 09), does this
// gateway serve the AS routes. agentAuthProblems (shared) takes them as `facts`; a fact nobody checked is "not ready".
import type pg from "pg";
import type { App } from "../context.ts";

type Q = Pick<pg.PoolClient, "query">;

/** "Present" is remembered per control pool until restart (like recheckHoldsReady): the part is never dropped under a live gateway. */
const tablesSeen = new WeakMap<object, true>();

/**
 * Are the [AS] tables there. Asked before any query to them inside a transaction (a failed query would abort the transaction
 * of saving settings): to_regclass, never the table itself. q — the transaction connection; without it the pool.
 */
export async function agentAuthTablesPresent(app: Pick<App, "db">, q?: Q): Promise<boolean> {
  if (tablesSeen.has(app.db.control)) return true;
  const ok = (await (q ?? app.db.control).query("SELECT to_regclass('agent_oauth_tx') IS NOT NULL AS ok")).rows[0]?.ok === true;
  if (ok) tablesSeen.set(app.db.control, true);
  return ok;
}

/** What is already known without a query: true — the tables were seen; undefined — not checked yet in this process. */
export function agentAuthTablesKnown(app: Pick<App, "db">): true | undefined {
  return tablesSeen.has(app.db.control) ? true : undefined;
}

// The AS routes come in three parts, each registered by its own function, which marks its part:
//   authorize — metadata, /oauth/authorize and its continuation (registerAgentAuthAuthorize, routes-authorize.ts, before
//               the key check);
//   consent   — the consent API /api/v1/me/oauth/* of the workplace (registerConsentApi, consent-api.ts, after the key
//               check: it needs the caller);
//   token     — /oauth/token and /oauth/revoke (registerAgentAuthToken, routes-token.ts).
// Until a gateway serves all three, builtin is not ready: saving builtin is refused with routes_missing, and the policy
// step treats builtin connections as not allowed. A gateway with only some parts (a partial port, a registration line
// lost in a merge) therefore stays safely "not ready" instead of sending agents into a dead end — without the consent API
// every sign-in would stop on the consent screen. A unit test checks that buildHttp marks every part.
export type AgentAuthRoutePart = "authorize" | "consent" | "token";
export const AGENT_AUTH_ROUTE_PARTS: readonly AgentAuthRoutePart[] = ["authorize", "consent", "token"];
const routesServed = new Set<AgentAuthRoutePart>();
let routesOverride: boolean | null = null;

/** Called by the code that registers one part of the AS routes on this process. */
export function markAgentAuthRoutesServed(part: AgentAuthRoutePart): void { routesServed.add(part); }
/** Does this process serve the AS routes: every part is registered. */
export function agentAuthRoutesServed(): boolean { return routesOverride ?? AGENT_AUTH_ROUTE_PARTS.every((p) => routesServed.has(p)); }
/** The parts registered so far (the panel and tests). */
export const agentAuthRoutePartsServed = (): AgentAuthRoutePart[] => AGENT_AUTH_ROUTE_PARTS.filter((p) => routesServed.has(p));
/** Tests: pretend the routes are served (true), not served (false) or back to the real state (null). */
export function setAgentAuthRoutesForTests(v: boolean | null): void { routesOverride = v; }
/** Tests: forget the registered parts. */
export function resetAgentAuthRoutePartsForTests(): void { routesServed.clear(); }

/** Both facts for agentAuthProblems: the tables (a query until they were seen once) and the routes. */
export async function agentAuthFacts(app: Pick<App, "db">, q?: Q): Promise<{ schema: boolean; routes: boolean }> {
  return { schema: await agentAuthTablesPresent(app, q), routes: agentAuthRoutesServed() };
}
