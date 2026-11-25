// The answer is the contract of the panel page (packages/admin/src/app/admin/(panel)/agent-login/view.ts): field names are
// that page's. No secrets: the registry rows and the DCR rows hold none (public clients), and nothing of
// the sign-in transactions, codes or tokens is read. The fetcher of app documents (cimd-fetch.ts) adds what this
// gateway process knows of its downloads: cimd_needs_egress and cimd_last_failure. cimd_needs_egress is the
// fetcher's one definition (cimd-fetch.ts, readiness): only in builtin and only on evidence of a failed download, the same
// value as health and /me/connections/config.
//
// POST /api/v1/admin/agent-auth/cimd-probe {url} (class read, role memory_admin —
// agent_auth.cimd_probe.post): admission, a real download past the cache within the limits, the document rules;
// the answer is the panel's ProbeAnswer (view.ts). It changes no data and writes no cache.
//
// DELETE /api/v1/admin/agent-auth/clients/:id (class narrow, role memory_admin, break-glass): revoke a
// client registered automatically — under the exclusive policy lock, with its connections, sign-in transactions and
// unused codes in the same transaction (dcr.ts, revokeDcrClientByAdmin); the answer carries the number of connections
// revoked (the panel says it). Unknown, already revoked or swept — 404. Audit: admin {op: oauth_dcr_revoked}.
import type { Context, Hono } from "hono";
import { agentAuthConfig, agentAuthIssuer, agentAuthProblems, dcrTrustedEgressOverProxies, invalid, MemoryError, notFound } from "@memory/shared";
import { CIMD_ID_MAX, isDcrClientId } from "@memory/shared/oauth-as";
import type { App } from "../context.ts";
import { cimdReadiness, probeCimd } from "./cimd-fetch.ts";
import { agentAuthFacts } from "./readiness.ts";
import { trustedProxies } from "../channel.ts";
import { listDcrClients } from "./store.ts";
import { revokeDcrClientByAdmin } from "./dcr.ts";

/** The audit of an administrator's action (admin.ts adminAudit): event_type admin, details.op and the details. */
export type AdminAudit = (c: Context<any>, op: string, details?: Record<string, unknown>) => Promise<void>;

/** DCR clients per page of the panel (the page's contract: 50). */
export const DCR_PAGE = 50;

/**
 * Opaque cursor of the DCR page: base64url of "<created_at>|<client_id>" (the keyset of listDcrClients). created_at is the
 * UTC time with microseconds as the database gave it (listDcrClients, keysetAtSql); a cursor with milliseconds or none
 * (issued before) still reads.
 */
export const encodeDcrCursor = (k: { created_at: string; client_id: string }): string => Buffer.from(`${k.created_at}|${k.client_id}`).toString("base64url");
/** The time of a cursor: exactly YYYY-MM-DDTHH:MM:SS[.fraction up to 6]Z — what the query's ::timestamptz reads as that instant. */
const CURSOR_AT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,6})?Z$/;
export function decodeDcrCursor(raw: string | undefined | null): { created_at: string; client_id: string } | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const bad = () => invalid("dcr_cursor: the opaque string of a previous answer (dcr.next_cursor)");
  if (raw.length > 200 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw bad();
  const [at, id, extra] = Buffer.from(raw, "base64url").toString("utf8").split("|");
  // Date.parse alone is not enough: it takes other forms and rolls over a day the calendar has not (02-30, hour 24), and
  // the database would refuse those — a 500 instead of a 400; the seconds part must come back unchanged from Date
  const m = CURSOR_AT.exec(at ?? "");
  const seconds = m ? Date.parse(`${m[1]}Z`) : Number.NaN;
  if (extra !== undefined || !m || !(seconds >= 0) || new Date(seconds).toISOString().slice(0, 19) !== m[1] || !isDcrClientId(id)) throw bad();
  return { created_at: at!, client_id: id };
}

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());

/** Active built-in connections by the source of their client_id (sourceOf: https:// — cimd, dcr_ — dcr). */
const CONNECTIONS_SQL = `SELECT count(*) FILTER (WHERE c.client_id LIKE 'https://%')::int AS cimd,
    count(*) FILTER (WHERE c.client_id LIKE 'dcr\\_%')::int AS dcr,
    count(*) FILTER (WHERE c.client_id NOT LIKE 'https://%' AND c.client_id NOT LIKE 'dcr\\_%')::int AS registry
  FROM oauth_connections c JOIN api_keys k ON k.id = c.id
  WHERE c.instance_id = $1 AND c.origin = 'builtin' AND k.revoked_at IS NULL AND k.expires_at > now()`;

/** The answer of GET /api/v1/admin/agent-auth (the panel's contract, view.ts). */
export async function agentAuthAdminView(app: App, o: { dcrCursor?: string | null } = {}): Promise<Record<string, unknown>> {
  const after = decodeDcrCursor(o.dcrCursor);
  await app.settings.load(true);
  const s = app.settings, cfg = agentAuthConfig(s);
  const facts = await agentAuthFacts(app);
  const problems = agentAuthProblems(s, facts);
  const a = agentAuthIssuer(s);
  let dcr = { items: [] as Array<Record<string, unknown>>, next_cursor: null as string | null };
  let connections: { registry: number | null; cimd: number | null; dcr: number | null } = { registry: null, cimd: null, dcr: null };
  // without the [AS] tables there is no DCR table to read; oauth_connections exists, but its counts are null there too
  // (an instance without the schema part has no built-in connections to speak of — "—", not 0)
  if (facts.schema) {
    const page = await listDcrClients(app.db.control, app.instanceId, { limit: DCR_PAGE, after });
    dcr = {
      items: page.items.map((d) => ({
        client_id: d.client_id, client_name: d.client_name, redirect_uris: d.redirect_uris, created_at: iso(d.created_at),
        last_authorize_at: iso(d.last_authorize_at), first_used_at: iso(d.first_used_at), last_used_at: iso(d.last_used_at),
        created_ip_prefix: d.created_ip_prefix, active_connections: d.active_connections, revoked_at: iso(d.revoked_at),
      })),
      next_cursor: page.next ? encodeDcrCursor(page.next) : null,
    };
    const n = (await app.db.control.query<{ registry: number; cimd: number; dcr: number }>(CONNECTIONS_SQL, [app.instanceId])).rows[0];
    if (n) connections = { registry: n.registry, cimd: n.cimd, dcr: n.dcr };
  }
  return {
    mode: cfg.mode,
    ready: cfg.mode === "builtin" && problems.length === 0,
    problems,
    issuer: a.issuer || null,
    mcp_url: a.resource || null,
    workplace_url: a.workplace || null,
    clients: cfg.clients,
    cimd_hosts: cfg.cimd_hosts,
    cimd_any_https: cfg.cimd_any_https,
    ...cimdReadiness(s),
    // a warning, not a readiness problem: networks of agent_auth.dcr_trusted_egress that share addresses with
    // access.trusted_proxies — listing the proxy instead of the cloud would spare everybody behind it
    dcr: { enabled: cfg.dcr_enabled, ...dcr, trusted_egress_over_proxies: dcrTrustedEgressOverProxies(cfg.dcr_trusted_egress, trustedProxies(app)) },
    connections,
  };
}

/** Register on the admin router (relative paths, like the other admin modules of admin.ts). */
export function registerAgentAuthAdmin(r: Hono<any>, app: App, adminAudit: AdminAudit): void {
  r.get("/agent-auth", async (c) => c.json(await agentAuthAdminView(app, { dcrCursor: c.req.query("dcr_cursor") ?? null })));
  r.post("/agent-auth/cimd-probe", async (c) => {
    const b = await c.req.json().catch(() => null) as { url?: unknown } | null;
    const url = b && typeof b === "object" && !Array.isArray(b) ? b.url : undefined;
    if (typeof url !== "string" || url.length < 1 || url.length > CIMD_ID_MAX) throw invalid(`url: the https:// address of an app document, at most ${CIMD_ID_MAX} characters`);
    await app.settings.load(true);
    const answer = await probeCimd(url, app.settings);
    if (!answer) throw new MemoryError("rate_limited", "Too many app document downloads at once: try again in a few seconds", { retry_after: CIMD_PROBE_RETRY_SEC });
    return c.json(answer);
  });
  r.delete("/agent-auth/clients/:id", async (c) => {
    const id = c.req.param("id");
    if (!isDcrClientId(id)) throw invalid("id: the client_id of a client registered automatically (dcr_ and 26 characters a-z, 2-7)");
    const out = await revokeDcrClientByAdmin(app, id);
    if (!out) throw notFound();
    await adminAudit(c, "oauth_dcr_revoked", { client_id: id, connections_revoked: out.connections_revoked,
      transactions_deleted: out.transactions_deleted, codes_deleted: out.codes_deleted });
    return c.json({ client_id: id, revoked: true, connections_revoked: out.connections_revoked });
  });
}

/** Retry-After of the probe when the downloads are at their concurrency limit. */
export const CIMD_PROBE_RETRY_SEC = 5;
