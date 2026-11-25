import { MODE_TITLES, PROBLEM_TITLES, TEXT } from "../../../../messages/panel-agent-login";
// Gateway contract of this page. The names below are this page's choice, and the gateway
// (packages/gateway/src/agent-auth/admin.ts) must use exactly them:
//  * GET /api/v1/admin/agent-auth?dcr_cursor=<opaque>  — the DCR page cursor (a prefixed name because the answer is not a
//    list: precedent `proposals_cursor`, packages/gateway/src/space-guide.ts); first page — without the parameter;
//  * answer: { mode, ready, problems[], issuer, mcp_url, workplace_url, clients[] (rows of agent_auth.clients),
//    cimd_hosts[], cimd_any_https, cimd_needs_egress, cimd_last_failure ({host: {reason, status?, rule?, at}}
//    or [{host, reason, …}]), dcr: { enabled, items[], next_cursor: string | null }, connections: { registry, cimd, dcr } };
//  * dcr.trusted_egress_over_proxies[]: networks of agent_auth.dcr_trusted_egress that overlap access.trusted_proxies —
//    a warning of the page, absent in an older gateway (no warning);
//  * dcr.items[]: { client_id, client_name, redirect_uris[], created_at, last_authorize_at, first_used_at, last_used_at,
//    created_ip_prefix, active_connections, revoked_at } — `active_connections` as in listDcrClients of the gateway's
//    agent-auth/store.ts; 50 per page;
//  * DELETE /api/v1/admin/agent-auth/clients/:id → { connections_revoked: number } (absent — the panel names no number);
//  * POST /api/v1/admin/agent-auth/cimd-probe {url} → ProbeAnswer below.


export type AgentAuthMode = "external" | "builtin" | "off";

/** Link to the agent_auth category of the common settings page (all checks of PUT /settings apply there). */
export const AGENT_AUTH_SETTINGS_HREF = "/admin/settings?cat=agent_auth";
export type ClientSource = "registry" | "cimd" | "dcr";

export interface RegistryClient { client_id: string; kind: string; title: string; enabled: boolean; redirects: string[] }
export interface CimdFailure { host: string; at: string | null; reason: string; status: number | null; rule: number | null }
export interface DcrClient {
  client_id: string; client_name: string | null; redirect_uris: string[]; created_at: string | null; last_authorize_at: string | null;
  first_used_at: string | null; last_used_at: string | null; created_ip_prefix: string | null;
  /** Active connections of the client; null — the gateway did not say (shown as "—", never as 0). */
  active_connections: number | null;
  revoked_at: string | null;
}
export interface AgentAuthView {
  mode: AgentAuthMode;
  ready: boolean;
  problems: string[];
  issuer: string | null;
  mcp_url: string | null;
  workplace_url: string | null;
  clients: RegistryClient[];
  cimd_hosts: string[];
  cimd_any_https: boolean;
  cimd_needs_egress: boolean;
  cimd_last_failure: CimdFailure[];
  dcr: { enabled: boolean; items: DcrClient[]; next_cursor: string | null; trusted_egress_over_proxies: string[] };
  connections: Record<ClientSource, number | null>;
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);
const str = (v: unknown, max = 2048): string | null => (typeof v === "string" && v ? v.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, max) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strs = (v: unknown, max = 2048): string[] => (Array.isArray(v) ? v.map((x) => str(x, max)).filter((x): x is string => x !== null) : []);

/** A registry return address as one line: `{uri}` as it is, otherwise scheme://host:port/path (any port — `*`). */
export function redirectLine(r: unknown): string | null {
  const o = obj(r);
  if (!o) return str(r);
  if (typeof o.uri === "string") return str(o.uri);
  const scheme = str(o.scheme, 20), host = str(o.host, 255);
  if (!scheme || !host) return null;
  // stored rows of agent_auth.clients write the port of https rows (443): the line shows the address as people write it
  const defaultPort = (scheme === "https" && o.port === 443) || (scheme === "http" && o.port === 80);
  const port = o.port === "any" ? ":*" : typeof o.port === "number" && !defaultPort ? `:${o.port}` : "";
  const path = str(o.path, 2048) ?? "";
  const re = str(o.path_regex, 200);
  return TEXT.text2(scheme, host, port, path, re ? TEXT.path(re) : "");
}

function failures(v: unknown): CimdFailure[] {
  const one = (host: string, f: Record<string, unknown>): CimdFailure | null => {
    const reason = str(f.reason, 60) ?? str(f.code, 60);
    return reason ? { host, at: str(f.at, 40), reason, status: num(f.status), rule: num(f.rule) } : null;
  };
  if (Array.isArray(v)) return v.map((x) => { const f = obj(x); const host = str(f?.host, 255); return f && host ? one(host, f) : null; }).filter((x): x is CimdFailure => x !== null);
  const o = obj(v);
  if (!o) return [];
  return Object.entries(o).map(([host, f]) => (obj(f) ? one(host.slice(0, 255), obj(f)!) : null)).filter((x): x is CimdFailure => x !== null);
}

function dcrItems(v: unknown): DcrClient[] {
  if (!Array.isArray(v)) return [];
  return v.map((x): DcrClient | null => {
    const o = obj(x), id = str(o?.client_id ?? o?.id, 80);
    if (!o || !id) return null;
    return {
      client_id: id, client_name: str(o.client_name ?? o.name, 100), redirect_uris: strs(o.redirect_uris),
      created_at: str(o.created_at, 40), last_authorize_at: str(o.last_authorize_at, 40), first_used_at: str(o.first_used_at, 40),
      last_used_at: str(o.last_used_at, 40), created_ip_prefix: str(o.created_ip_prefix ?? o.net, 60),
      active_connections: num(o.active_connections), revoked_at: str(o.revoked_at, 40),
    };
  }).filter((x): x is DcrClient => x !== null);
}

/** The panel view of `GET /api/v1/admin/agent-auth`; null — the answer is not an object at all. */
export function parseAgentAuth(data: unknown): AgentAuthView | null {
  const d = obj(data);
  if (!d) return null;
  const mode: AgentAuthMode = d.mode === "builtin" || d.mode === "off" ? d.mode : "external";
  const dcr = obj(d.dcr), conns = obj(d.connections);
  const clients = Array.isArray(d.clients) ? d.clients.map((c): RegistryClient | null => {
    const o = obj(c), id = str(o?.client_id, 64);
    return o && id ? { client_id: id, kind: str(o.kind, 40) ?? "—", title: str(o.title, 80) ?? id, enabled: o.enabled === true, redirects: Array.isArray(o.redirects) ? o.redirects.map(redirectLine).filter((x): x is string => x !== null) : [] } : null;
  }).filter((x): x is RegistryClient => x !== null) : [];
  return {
    mode, ready: d.ready === true, problems: strs(d.problems, 80),
    issuer: str(d.issuer), mcp_url: str(d.mcp_url ?? d.resource), workplace_url: str(d.workplace_url),
    clients, cimd_hosts: strs(d.cimd_hosts, 400), cimd_any_https: d.cimd_any_https === true,
    cimd_needs_egress: d.cimd_needs_egress === true, cimd_last_failure: failures(d.cimd_last_failure),
    dcr: { enabled: dcr?.enabled === true || d.dcr_enabled === true, items: dcrItems(dcr?.items), next_cursor: str(dcr?.next_cursor, 500),
      trusted_egress_over_proxies: strs(dcr?.trusted_egress_over_proxies, 64) },
    connections: { registry: num(conns?.registry), cimd: num(conns?.cimd), dcr: num(conns?.dcr) },
  };
}

export { MODE_TITLES } from "../../../../messages/panel-agent-login";

/** Problem codes of readiness in panel words; an unknown code is shown as it is. */
export { PROBLEM_TITLES } from "../../../../messages/panel-agent-login";
export const problemTitle = (code: string): string => (Object.hasOwn(PROBLEM_TITLES, code) ? PROBLEM_TITLES[code]! : code);

/** Reason codes of app-document (CIMD) refusals in panel words. */
export function cimdReasonTitle(f: Pick<CimdFailure, "reason" | "status" | "rule">): string {
  switch (f.reason) {
    case "cimd_fetch_failed": return TEXT.theDocumentCouldNotBeLoaded(f.status !== null ? ` (HTTP ${f.status})` : "");
    case "tls": return TEXT.aSecureConnectionCouldNotBeEstablished;
    case "dns": return TEXT.theHostNameCouldNotBeResolved;
    case "timeout": return TEXT.theDocumentDidNotRespondWithinFive;
    case "network": return TEXT.theHostSNetworkIsUnreachable;
    case "address_blocked": return TEXT.theHostResolvesToAPrivateNetwork;
    case "cimd_invalid": return TEXT.theDocumentFailsValidation(f.rule !== null ? TEXT.rule(f.rule) : "");
    case "cimd_host_cooling": return TEXT.thisHostRecentlyFailedFetchesArePaused;
    case "cimd_rate_limited": return TEXT.tooManyDocumentFetchesToThisHost;
    case "cimd_host_not_allowed": return TEXT.theURLIsNotOnTheApp;
    case "cimd_bad_url": return TEXT.theDocumentURLIsNotInCanonical;
    default: return f.reason;
  }
}

/**
 * The warning next to the DCR switch (switching DCR off revokes every DCR connection, "the panel warns with a
 * number"): the number of active DCR connections, or — when the gateway did not say — that all of them go.
 */
export function dcrOffWarning(n: number | null): string {
  if (n === null) return TEXT.turningOffDCRWillRevokeAllDCR;
  if (n === 0) return TEXT.turningOffDCRWillNotRevokeAnything;
  return TEXT.turningOffDCRWillRevoke(n);
}

/**
 * The warning of the DCR section: networks of agent_auth.dcr_trusted_egress that overlap
 * access.trusted_proxies. A trusted proxy forwards the caller's address, so its own address in the egress list is the
 * proxy, not the cloud — every visitor behind it would count in the share of trusted egress. null — nothing to say.
 */
export function trustedEgressProxyWarning(nets: readonly string[]): string | null {
  if (!nets.length) return null;
  return TEXT.cloudAppEgressNetworksAgentAuthDcr(nets.slice(0, 5).join(", "), nets.length > 5 ? TEXT.andMore(nets.length - 5) : "");
}

/** The revoke confirmation of a DCR client: the number of its connections only when the gateway said it. */
export function dcrRevokeConfirm(c: Pick<DcrClient, "client_id" | "client_name" | "active_connections">): string {
  const conns = c.active_connections === null ? TEXT.itsConnections2 : TEXT.itsConnections(c.active_connections);
  return TEXT.revokeClientWillBeDisconnectedImmediatelyAnd(c.client_name ?? c.client_id, conns);
}

/** A DCR client id as the gateway issues it: `dcr_` and base32; the revoke action takes nothing else. */
export const isDcrClientId = (v: unknown): v is string => typeof v === "string" && /^dcr_[A-Za-z2-7]{16,40}$/.test(v);

/** An app document address is at most 255 characters (the `client_id` column). */
export const CIMD_URL_MAX = 255;
/** What the probe form may send: an https address without spaces, at most CIMD_URL_MAX characters (already trimmed). */
export const isProbeUrl = (v: string): boolean => v.length <= CIMD_URL_MAX && /^https:\/\/\S+$/.test(v);

/**
 * The CIMD probe answer as result lines of the form. `rule` — the rule of a refused document breaks
 * (cimd_invalid; the gateway sends it, OpenAPI AgentAuthCimdProbe.rule): the reason names it.
 */
export interface ProbeAnswer { ok: boolean; problem?: string; kind?: string; title?: string; known?: boolean; redirect_uris?: string[]; skipped_lines?: number; status?: number; rule?: number; bytes?: number; ms?: number; tls_code?: string }
export function probeLines(p: ProbeAnswer): string[] {
  const out: string[] = [];
  if (p.ok) {
    out.push(TEXT.appKindName(p.kind ?? "—", p.title ?? "—", p.known ? TEXT.knownApp : TEXT.notOnTheKnownAppsList));
    if (p.redirect_uris?.length) out.push(TEXT.returnURLs5(p.redirect_uris.join(", ")));
  } else if (p.problem) {
    out.push(TEXT.reason(cimdReasonTitle({ reason: p.problem, status: p.status ?? null, rule: typeof p.rule === "number" && Number.isFinite(p.rule) ? p.rule : null })));
  }
  if (typeof p.skipped_lines === "number" && p.skipped_lines > 0) out.push(TEXT.returnURLLinesSkipped(p.skipped_lines));
  const meta = [p.status !== undefined ? `HTTP ${p.status}` : null, p.bytes !== undefined ? TEXT.bytes(p.bytes) : null, p.ms !== undefined ? TEXT.ms(p.ms) : null, p.tls_code ? `TLS: ${p.tls_code}` : null].filter(Boolean);
  if (meta.length) out.push(meta.join(" · "));
  return out;
}
