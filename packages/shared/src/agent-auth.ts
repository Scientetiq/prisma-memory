// Built-in authorization server for agents. Category agent_auth:
// who signs agents in (mode), which apps may (registry rows, client metadata documents, automatic registration) and for how
// long. Pure: the gateway reads the settings cache, passes the future state when settings are saved and the facts only the
// database knows (are the [AS] tables there, is a DCR client alive).
//
//   mode = "external"  — as before: the external identity provider (oauth.*) signs agents in, the built-in server answers 404;
//   mode = "builtin"   — the memory itself is the authorization server at the agents' address;
//   mode = "off"       — no agent sign-in in the browser at all (personal keys still work).
//
// One mode at a time. Connections of the other mode are revoked in the transaction that saves the new mode
// (gateway/src/agent-auth/policy-step.ts); setting the old mode back does not revive them.
//
// The protocol rules themselves live in oauth-as: CIMD admission and cimd_hosts entries in cimd.ts, the English
// readiness texts in errors.ts, registry rows in client-rows.ts. This module reads settings and wraps them, so the
// policy step, settings validation and the CIMD fetch apply one rule.
import { trimBase } from "./agent-address.ts";
import { parseCidr, wholeNetworkProblem } from "./channel-settings.ts";
import { publicBaseUrl } from "./public-url.ts";
import { admitCimdClientId, cimdPolicyFrom, CIMD_HOSTS_MAX, CIMD_ID_MAX, parseCimdHostEntry } from "./oauth-as/cimd.ts";
import { parseClientRows, type ClientRow } from "./oauth-as/client-rows.ts";
import { AGENT_AUTH_PROBLEM_TEXT, type AgentAuthProblemCode } from "./oauth-as/errors.ts";
import type { Settings } from "./settings.ts";

export { AGENT_AUTH_PROBLEM_TEXT, CIMD_HOSTS_MAX };

export { parseClientRows, pathRegexProblem, redirectRowProblem, registryClient, CLIENT_ID_RE, CLIENT_ROWS_MAX, CLIENT_REDIRECTS_MAX,
         type ClientRow, type ClientRedirectRow, type ClientHttpRedirect, type ClientCustomRedirect, type ClientRowsResult } from "./oauth-as/client-rows.ts";

type Getter = Pick<Settings, "get">;

export const AGENT_AUTH_MODES = ["external", "builtin", "off"] as const;
export type AgentAuthMode = (typeof AGENT_AUTH_MODES)[number];
export type ClientSource = "registry" | "cimd" | "dcr";

/** Seed of agent_auth.cimd_hosts: client metadata documents are fetched only under these host/prefix entries. */
export const AGENT_AUTH_CIMD_HOSTS_SEED = ["claude.ai/oauth/", "chatgpt.com/oauth/", "vscode.dev/oauth/"] as const;
/**
 * agent_auth.dcr_limits. per_day_trusted: the part of per_day that registrations from
 * agent_auth.dcr_trusted_egress may use — 0 ≤ per_day_trusted < per_day, the seed half of the seed per_day. A trusted
 * egress is held to it instead of per_day_net, and to per_day like everybody, so the other networks always keep
 * per_day − per_day_trusted of the day: trusting the address of a cloud is not trusting every user of that cloud.
 */
export interface DcrLimits { per_day: number; per_day_net: number; per_day_trusted: number; max_clients: number; unused_hours: number }
export const DCR_LIMITS_DEFAULT: Readonly<DcrLimits> = { per_day: 200, per_day_net: 20, per_day_trusted: 100, max_clients: 500, unused_hours: 720 };
const DCR_LIMIT_RANGES: Record<keyof DcrLimits, [number, number]> = {
  per_day: [1, 10000], per_day_net: [1, 1000], per_day_trusted: [0, 9999], max_clients: [1, 10000], unused_hours: [1, 2160],
};
/** per_day_trusted not stored, not an integer or not below per_day (past the API) — half of per_day. */
const trustedShareOf = (perDay: number): number => Math.floor(perDay / 2);
/**
 * agent_auth.dcr_trusted_egress: the outbound networks of cloud apps that register one client
 * per employee from a few shared addresses — the published egress ranges of Anthropic (claude.ai) and OpenAI (ChatGPT),
 * filled in by the operator. A registration whose address (the connection's, by access.trusted_proxies) is in one of
 * them is held to dcr_limits.per_day_trusted instead of per_day_net; per_day, max_clients and the oauth_register bucket
 * hold for everybody. At most DCR_TRUSTED_EGRESS_MAX networks, none wider than DCR_TRUSTED_EGRESS_WIDEST (a published
 * egress range is far narrower: a wider one is somebody else's cloud), never the whole internet, none touching a special
 * or transition range or IPv6 outside global unicast 2000::/3 (DCR_TRUSTED_EGRESS_FORBIDDEN), no two overlapping.
 */
export const DCR_TRUSTED_EGRESS_MAX = 256;
export const DCR_TRUSTED_EGRESS_WIDEST: Readonly<{ ipv4: number; ipv6: number }> = { ipv4: 16, ipv6: 32 };
/** The longest network text an entry may have (an IPv6 network with an embedded IPv4 address and /128 is 49 characters). */
const TRUSTED_EGRESS_ENTRY_MAX = 64;
/**
 * Ranges no published cloud egress is in: an entry that overlaps one of them — any of its
 * addresses, not only the first — is refused. The address the gateway sees there is a local proxy, a NAT, a tunnel relay
 * (6to4, Teredo, NAT64 carry somebody else's IPv4 inside) or an anycast service, never the cloud: listing it would spare
 * everybody behind it. Coarse rule: what cannot be shown to be ordinary global unicast is refused.
 *
 * Compared row by row with the IANA IPv4 and IPv6 Special-Purpose Address Registries (both «Last Updated 2025-10-09»)
 * and the IANA IPv6 Address Space registry (2025-10-23). Completeness is claimed for these rows only;
 * a row added to a registry later needs its line here.
 *
 *   IPv4 Special-Purpose registry row               RFC                    here
 *   0.0.0.0/8 This network                          791 0.0.0.0/8
 *   0.0.0.0/32 This host on this network            1122 inside 0.0.0.0/8
 *   10.0.0.0/8 Private-Use                          1918                   10.0.0.0/8
 *   100.64.0.0/10 Shared Address Space              6598                   100.64.0.0/10
 *   127.0.0.0/8 Loopback                            1122 127.0.0.0/8
 *   169.254.0.0/16 Link Local                       3927                   169.254.0.0/16
 *   172.16.0.0/12 Private-Use                       1918                   172.16.0.0/12
 *   192.0.0.0/24 IETF Protocol Assignments          6890 192.0.0.0/24
 *   192.0.0.0/29 IPv4 Service Continuity Prefix     7335                   inside 192.0.0.0/24
 *   192.0.0.8/32 IPv4 dummy address                 7600                   inside 192.0.0.0/24
 *   192.0.0.9/32 Port Control Protocol Anycast      7723                   inside 192.0.0.0/24
 *   192.0.0.10/32 TURN Anycast                      8155                   inside 192.0.0.0/24
 *   192.0.0.170/32, .171/32 NAT64/DNS64 Discovery   8880, 7050 inside 192.0.0.0/24
 *   192.0.2.0/24 Documentation (TEST-NET-1)         5737                   192.0.2.0/24
 *   192.31.196.0/24 AS112-v4                        7535                   192.31.196.0/24
 *   192.52.193.0/24 AMT                             7450                   192.52.193.0/24
 *   192.88.99.0/24 Deprecated (6to4 Relay Anycast)  7526                   192.88.99.0/24
 *   192.88.99.2/32 6a44-relay anycast address       6751                   inside 192.88.99.0/24
 *   192.168.0.0/16 Private-Use                      1918                   192.168.0.0/16
 *   192.175.48.0/24 Direct Delegation AS112 Service 7534                   192.175.48.0/24
 *   198.18.0.0/15 Benchmarking                      2544                   198.18.0.0/15
 *   198.51.100.0/24 Documentation (TEST-NET-2)      5737                   198.51.100.0/24
 *   203.0.113.0/24 Documentation (TEST-NET-3)       5737                   203.0.113.0/24
 *   240.0.0.0/4 Reserved                            1112 240.0.0.0/4
 *   255.255.255.255/32 Limited Broadcast            8190, 919 inside 240.0.0.0/4
 *   (IPv4 Address Space registry) Multicast         5771                   224.0.0.0/4
 *
 *   IPv6 Special-Purpose registry row               RFC                    here
 *   ::1/128 Loopback Address                        4291                   inside ::/96
 *   ::/128 Unspecified Address                      4291                   inside ::/96
 *   ::ffff:0:0/96 IPv4-mapped Address               4291                   ::ffff:0:0/96
 *   64:ff9b::/96 IPv4-IPv6 Translat.                6052                   64:ff9b::/96
 *   64:ff9b:1::/48 IPv4-IPv6 Translat.              8215                   64:ff9b:1::/48
 *   100::/64 Discard-Only Address Block             6666                   100::/64
 *   100:0:0:1::/64 Dummy IPv6 Prefix                9780                   100:0:0:1::/64
 *   2001::/23 IETF Protocol Assignments             2928                   2001::/23
 *   2001::/32 TEREDO                                4380, 8190             2001::/32 (named; inside 2001::/23)
 *   2001:1::1/128 Port Control Protocol Anycast     7723                   inside 2001::/23
 *   2001:1::2/128 TURN Anycast                      8155                   inside 2001::/23
 *   2001:1::3/128 DNS-SD SRP Anycast                9665                   inside 2001::/23
 *   2001:2::/48 Benchmarking                        5180                   inside 2001::/23
 *   2001:3::/32 AMT                                 7450                   inside 2001::/23
 *   2001:4:112::/48 AS112-v6                        7535                   inside 2001::/23
 *   2001:10::/28 Deprecated (previously ORCHID)     4843                   inside 2001::/23
 *   2001:20::/28 ORCHIDv2                           7343                   inside 2001::/23
 *   2001:30::/28 Drone Remote ID DETs Prefix        9374                   inside 2001::/23
 *   2001:db8::/32 Documentation                     3849                   2001:db8::/32
 *   2002::/16 6to4                                  3056                   2002::/16
 *   2620:4f:8000::/48 Direct Delegation AS112       7534                   2620:4f:8000::/48
 *   3fff::/20 Documentation                         9637                   3fff::/20
 *   5f00::/16 Segment Routing (SRv6) SIDs           9602                   5f00::/16
 *   fc00::/7 Unique-Local                           4193, 8190             fc00::/7
 *   fe80::/10 Link-Local Unicast                    4291                   fe80::/10
 *   (Address Space) ::/96 IPv4-compatible, deprecated 4291::/96
 *   (Address Space) fec0::/10 site-local, deprecated 3879                  fec0::/10
 *   (Address Space) ff00::/8 Multicast              4291                   ff00::/8
 *   (Address Space) 3ffe::/16 6bone, returned       3701, 5156             3ffe::/16
 *   (Address Space) all but 2000::/3 Global Unicast 4291                   ::/3, 4000::/2, 8000::/1
 *
 * Besides the registries: nothing. Not checked and the price of the rule: unallocated space inside 2000::/3 and outside
 * these rows (an IANA or RIR allocation is not looked up), IPv4 allocated but unrouted, an operator's own NAT64 prefix
 * inside global unicast (RFC 6052 network-specific prefix) — such a network is accepted as written.
 */
export const DCR_TRUSTED_EGRESS_FORBIDDEN: ReadonlyArray<readonly [network: string, what: string]> = [
  // IPv4: IANA IPv4 Special-Purpose Address Registry, row by row (their children are inside), and multicast
  ["0.0.0.0/8", "\"this network\" (0.0.0.0/8)"],
  ["10.0.0.0/8", "a private network (10.0.0.0/8)"],
  ["100.64.0.0/10", "shared address space of carrier NAT (100.64.0.0/10)"],
  ["127.0.0.0/8", "loopback (127.0.0.0/8)"],
  ["169.254.0.0/16", "link-local (169.254.0.0/16)"],
  ["172.16.0.0/12", "a private network (172.16.0.0/12)"],
  ["192.0.0.0/24", "IETF protocol assignments (192.0.0.0/24)"],
  ["192.0.2.0/24", "documentation (192.0.2.0/24)"],
  ["192.31.196.0/24", "AS112 anycast (192.31.196.0/24)"],
  ["192.52.193.0/24", "AMT anycast relays (192.52.193.0/24)"],
  ["192.88.99.0/24", "the deprecated 6to4 relay anycast (192.88.99.0/24)"],
  ["192.168.0.0/16", "a private network (192.168.0.0/16)"],
  ["192.175.48.0/24", "AS112 direct delegation (192.175.48.0/24)"],
  ["198.18.0.0/15", "benchmarking (198.18.0.0/15)"],
  ["198.51.100.0/24", "documentation (198.51.100.0/24)"],
  ["203.0.113.0/24", "documentation (203.0.113.0/24)"],
  ["224.0.0.0/4", "multicast (224.0.0.0/4)"],
  ["240.0.0.0/4", "reserved, with the broadcast address 255.255.255.255 (240.0.0.0/4)"],
  // IPv6: IANA IPv6 Special-Purpose Address Registry, row by row, and the deprecated blocks of the address space
  ["::/96", "the unspecified, loopback and IPv4-compatible addresses (::/96)"],
  ["::ffff:0:0/96", "IPv4-mapped addresses (::ffff:0:0/96)"],
  ["64:ff9b::/96", "NAT64 (64:ff9b::/96)"],
  ["64:ff9b:1::/48", "local NAT64 (64:ff9b:1::/48)"],
  ["100::/64", "discard-only (100::/64)"],
  ["100:0:0:1::/64", "the dummy IPv6 prefix (100:0:0:1::/64)"],
  ["2001::/32", "Teredo (2001::/32)"],
  ["2001::/23", "IETF protocol assignments (2001::/23: Teredo, anycast, benchmarking, AMT, AS112, ORCHID, DETs)"],
  ["2001:db8::/32", "documentation (2001:db8::/32)"],
  ["2002::/16", "6to4 (2002::/16)"],
  ["2620:4f:8000::/48", "AS112 direct delegation (2620:4f:8000::/48)"],
  ["3ffe::/16", "the returned 6bone (3ffe::/16)"],
  ["3fff::/20", "documentation (3fff::/20)"],
  ["5f00::/16", "SRv6 segment identifiers (5f00::/16)"],
  ["fc00::/7", "unique-local (fc00::/7)"],
  ["fe80::/10", "link-local (fe80::/10)"],
  ["fec0::/10", "the deprecated site-local (fec0::/10)"],
  ["ff00::/8", "multicast (ff00::/8)"],
  // IPv6 outside 2000::/3 — the only Global Unicast block of the IANA IPv6 Address Space; the named rows above say more
  ["::/3", "IPv6 outside global unicast 2000::/3 (::/3, reserved by IETF)"],
  ["4000::/2", "IPv6 outside global unicast 2000::/3 (4000::/2, reserved by IETF)"],
  ["8000::/1", "IPv6 outside global unicast 2000::/3 (8000::/1: reserved, unique-local, link-local, site-local, multicast)"],
];
type Net = NonNullable<ReturnType<typeof parseCidr>>;
const FORBIDDEN_NETS: ReadonlyArray<readonly [Net, string]> = DCR_TRUSTED_EGRESS_FORBIDDEN.map(([n, what]) => [parseCidr(n)!, what] as const);

/** Two networks share an address: the same family and the same first min(bits) bits (IPv4 and IPv6 never do here). */
export function networksOverlap(a: Pick<Net, "family" | "bits" | "bytes">, b: Pick<Net, "family" | "bits" | "bytes">): boolean {
  if (a.family !== b.family) return false;
  const bits = Math.min(a.bits, b.bits);
  for (let i = 0; i * 8 < bits; i++) {
    const keep = Math.min(8, bits - i * 8);
    const m = (0xff << (8 - keep)) & 0xff;
    if ((a.bytes[i]! & m) !== (b.bytes[i]! & m)) return false;
  }
  return true;
}
export const CONNECTION_DAYS_RANGE = [1, 90] as const;
export const IDLE_DAYS_RANGE = [1, 90] as const;
/** client_id of a client metadata document — a URL up to the length of oauth_connections.client_id (CIMD_ID_MAX of cimd.ts). */
export const CIMD_CLIENT_ID_MAX = CIMD_ID_MAX;

export interface AgentAuthConfig {
  mode: AgentAuthMode;
  /** Registry rows; a value that does not parse gives [] (no registry client is served). */
  clients: ClientRow[];
  /** host/prefix/ entries that pass the rules; others are dropped. */
  cimd_hosts: string[];
  cimd_any_https: boolean;
  dcr_enabled: boolean;
  dcr_limits: DcrLimits;
  /** Networks of agent_auth.dcr_trusted_egress that pass dcrTrustedEgressProblem; others are dropped. */
  dcr_trusted_egress: string[];
  connection_days: number;
  idle_days: number;
}

const intIn = (v: unknown, [min, max]: readonly [number, number]): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/**
 * Category agent_auth from settings (the cache or a future state). Read without a database query: the mode decides on every
 * request whether the built-in routes answer at all. No row (sandboxes of tests without the [AS] part) — the fallbacks:
 * mode external, no clients. A mode value outside the list (written past the API) is read as "off": nobody signs in.
 */
export function agentAuthConfig(s: Getter): AgentAuthConfig {
  const mode = s.get<unknown>("agent_auth.mode", "external");
  const clients = parseClientRows(s.get<unknown>("agent_auth.clients", []));
  const hosts = s.get<unknown>("agent_auth.cimd_hosts", [...AGENT_AUTH_CIMD_HOSTS_SEED]);
  // the stored object itself: Settings.get and futureSettings return agent_auth.dcr_limits whole, never merged with the
  // seed default or a fallback (SETTINGS_READ_WHOLE of settings.ts); absent fields are filled here
  const stored = s.get<unknown>("agent_auth.dcr_limits", null);
  const obj: Record<string, unknown> = stored && typeof stored === "object" && !Array.isArray(stored) ? stored as Record<string, unknown> : {};
  const merged: Record<string, unknown> = { ...DCR_LIMITS_DEFAULT, ...obj };
  const dcrLimits = Object.fromEntries((Object.keys(DCR_LIMITS_DEFAULT) as Array<keyof DcrLimits>)
    .map((k) => [k, intIn(merged[k], DCR_LIMIT_RANGES[k]) ? merged[k] : DCR_LIMITS_DEFAULT[k]])) as unknown as DcrLimits;
  // the share of trusted egress counts only when it is stored, and always below the day: absent (a value
  // saved before the field or without it — whatever the seed default says now), not an integer or not below the day
  // (past the API) — floor(per_day / 2) of this value's own day, never a share merged in from a default
  const share = Object.hasOwn(obj, "per_day_trusted") ? obj.per_day_trusted : undefined;
  dcrLimits.per_day_trusted = intIn(share, DCR_LIMIT_RANGES.per_day_trusted) && share < dcrLimits.per_day ? share : trustedShareOf(dcrLimits.per_day);
  const trustedEgress = s.get<unknown>("agent_auth.dcr_trusted_egress", []);
  const connectionDays = s.get<unknown>("agent_auth.connection_days", 90);
  const idleDays = s.get<unknown>("agent_auth.idle_days", 30);
  return {
    mode: (AGENT_AUTH_MODES as readonly unknown[]).includes(mode) ? mode as AgentAuthMode : "off",
    clients: clients.ok ? clients.rows : [],
    cimd_hosts: Array.isArray(hosts) ? hosts.filter((h): h is string => cimdHostEntryProblem(h) === null) : [],
    cimd_any_https: s.get<unknown>("agent_auth.cimd_any_https", false) === true,
    dcr_enabled: s.get<unknown>("agent_auth.dcr_enabled", false) === true,
    dcr_limits: dcrLimits,
    // a list the validation would not have saved (written past the API: a bad or special network, an overlap, too many)
    // trusts nobody at all — not its good-looking part
    dcr_trusted_egress: dcrTrustedEgressListProblems(trustedEgress).length === 0 ? [...trustedEgress as string[]] : [],
    connection_days: intIn(connectionDays, CONNECTION_DAYS_RANGE) ? connectionDays : 90,
    idle_days: intIn(idleDays, IDLE_DAYS_RANGE) ? idleDays : 30,
  };
}

/** The mode alone, from the cache, with the same fallback and the same "off" for an unknown value (the external path reads nothing else). */
export function agentAuthMode(s: Getter): AgentAuthMode {
  const mode = s.get<unknown>("agent_auth.mode", "external");
  return (AGENT_AUTH_MODES as readonly unknown[]).includes(mode) ? mode as AgentAuthMode : "off";
}

// ---------------------------------------------------------------- issuer, resource, readiness

/**
 * Readiness problem codes, in the order agentAuthProblems reports them. The codes are AgentAuthProblemCode of
 * oauth-as/errors.ts, and their English texts (health detail, API `problems`) are AGENT_AUTH_PROBLEM_TEXT there; the panel
 * shows its own Russian label. A unit test checks that the list names every code of errors.ts.
 */
export const AGENT_AUTH_PROBLEMS = ["agent_address_missing", "agent_address_not_origin", "agent_address_not_https", "workplace_url_missing",
  "workplace_url_not_https", "no_clients", "schema_missing", "routes_missing"] as const satisfies readonly AgentAuthProblemCode[];
export type AgentAuthProblem = (typeof AGENT_AUTH_PROBLEMS)[number];

export interface AgentAuthIssuer {
  /** Origin of the agents' address (https://host[:port]); "" when it is not usable. */
  issuer: string;
  /** `<issuer>/mcp` or "". */
  resource: string;
  /** access.workplace_url without trailing slashes, or "". */
  workplace: string;
  /** Address problems only (agent_address_*, workplace_url_*). */
  problems: AgentAuthProblem[];
  /** Plain HTTP on this computer is in use (development): readiness says so. */
  dev: boolean;
}

const DEV_HOSTS = new Set(["localhost", "127.0.0.1"]);
const parseUrl = (s: string): URL | null => { try { return new URL(s); } catch { return null; } };

/**
 * Issuer of the built-in server — origin of the agents' address: access.cloud_agent_base_url, else access.public_base_url
 * oauth.issuer and oauth.resource_url are not read in builtin. The workplace address is where the sign-in redirects
 * people to, so it must be HTTPS too: the workplace session cookie and the consent form would travel in clear text.
 */
export function agentAuthIssuer(s: Getter): AgentAuthIssuer {
  const problems: AgentAuthProblem[] = [];
  let dev = false;
  const cloud = trimBase(s.get<unknown>("access.cloud_agent_base_url", "")), pub = trimBase(s.get<unknown>("access.public_base_url", ""));
  // both settings empty — the origin of MEMORY_PUBLIC_URL; a stored address wins
  const raw = cloud || pub || (publicBaseUrl() ?? "");
  let issuer = "";
  if (!raw) problems.push("agent_address_missing");
  else {
    const u = parseUrl(raw);
    const devHttp = u?.protocol === "http:" && DEV_HOSTS.has(u.hostname);
    if (!u || (u.protocol !== "https:" && !devHttp)) problems.push("agent_address_not_https");
    else if (u.pathname !== "/" || u.search || u.hash || raw.includes("?") || raw.includes("#") || u.username || u.password) problems.push("agent_address_not_origin");
    else { issuer = u.origin; dev ||= devHttp; }
  }
  const workplace = trimBase(s.get<unknown>("access.workplace_url", ""));
  if (!workplace) problems.push("workplace_url_missing");
  else {
    const u = parseUrl(workplace);
    const devHttp = u?.protocol === "http:" && DEV_HOSTS.has(u.hostname);
    if (!u || (u.protocol !== "https:" && !devHttp) || u.username || u.password) problems.push("workplace_url_not_https");
    else dev ||= devHttp;
  }
  return { issuer, resource: issuer ? `${issuer}/mcp` : "", workplace: problems.some((p) => p.startsWith("workplace_url")) ? "" : workplace, problems, dev };
}

/**
 * Why builtin is not ready, for the future state of settings: address problems, no app able to sign in, and the facts the
 * caller knows — `schema: false` the [AS] tables are absent (undefined — not checked), `routes` the gateway serves the AS
 * routes (absent — not served: a caller that does not know cannot make builtin look ready). Empty — ready. Used by saving
 * settings (refuse to enable an unready builtin), by health (checks.oauth) and by the panel section.
 */
export function agentAuthProblems(future: Getter, facts: { schema?: boolean; routes?: boolean } = {}): AgentAuthProblem[] {
  const out = [...agentAuthIssuer(future).problems];
  const cfg = agentAuthConfig(future);
  if (!cfg.clients.some((c) => c.enabled) && cfg.cimd_hosts.length === 0 && !cfg.cimd_any_https && !cfg.dcr_enabled) out.push("no_clients");
  if (facts.schema === false) out.push("schema_missing");
  if (facts.routes !== true) out.push("routes_missing");
  return out;
}

// ---------------------------------------------------------------- policy: is the client of a connection allowed

/** Source of a client by its client_id: an https URL — a client metadata document (CIMD), dcr_… — DCR, else the registry. */
export function clientSource(clientId: string): ClientSource {
  if (clientId.startsWith("https://")) return "cimd";
  if (clientId.startsWith("dcr_")) return "dcr";
  return "registry";
}

export type CimdAdmission = { ok: true; host: string } | { ok: false; reason: "cimd_bad_url" | "cimd_host_not_allowed"; host: string | null };

/**
 * May this client_id be fetched as a client metadata document — before any network access (strict order: shape,
 * canonical form, host and prefix; IDN and IP literals, a trailing dot and single-label hosts never, whatever cimd_any_https
 * says). The rule is admitCimdClientId of oauth-as/cimd.ts, the one the CIMD fetch calls before every download and on every
 * cache hit; here it reads the policy from agent_auth.cimd_hosts and agent_auth.cimd_any_https, so the policy step revokes
 * exactly the connections whose document the fetch would no longer admit.
 */
export function cimdAdmission(clientId: string, policy: Pick<AgentAuthConfig, "cimd_hosts" | "cimd_any_https">): CimdAdmission {
  const r = admitCimdClientId(clientId, cimdPolicyFrom(policy.cimd_hosts, policy.cimd_any_https));
  return r.ok ? { ok: true, host: r.host } : { ok: false, reason: r.reason, host: r.host };
}

export interface PolicyConnection {
  client_id: string;
  /** client_kind of the connection (api_keys.client_kind). */
  kind: string | null;
  /** Defaults to clientSource(client_id); a source that disagrees with the client_id is refused. */
  source?: ClientSource;
  /** DCR only: a live (not revoked) row of agent_oauth_dcr_clients exists — the database fact. */
  dcr_live?: boolean;
}

/**
 * The one rule «the client of this connection is allowed by the policy»: registry — an enabled row with this
 * client_id and the same kind; CIMD — the client_id is admitted (cimdAdmission); DCR — automatic registration is on and the
 * client is alive. A policy change only narrows: a connection never moves to another kind.
 */
export function policyAllows(policy: AgentAuthConfig, conn: PolicyConnection): boolean {
  const source = clientSource(conn.client_id);
  if (conn.source !== undefined && conn.source !== source) return false;
  switch (source) {
    case "registry": return policy.clients.some((c) => c.client_id === conn.client_id && c.enabled && c.kind === conn.kind);
    case "cimd": return cimdAdmission(conn.client_id, policy).ok;
    case "dcr": return policy.dcr_enabled && conn.dcr_live === true;
  }
}

// ---------------------------------------------------------------- validation of the keys (settings.validate)

/**
 * Why one agent_auth.dcr_trusted_egress entry is not a network the list takes, or null: a network in the form of the cidr
 * type of PostgreSQL (address/length, no host bits; a bare address is /32 or /128 — parseCidr), never the whole internet
 * and never an IPv6 network that covers IPv4 addresses (wholeNetworkProblem: ::ffff:0:0/96 would match any IPv4 caller),
 * at most DCR_TRUSTED_EGRESS_WIDEST wide, sharing no address with a range of DCR_TRUSTED_EGRESS_FORBIDDEN. English: an
 * API message.
 */
export function dcrTrustedEgressProblem(entry: unknown): string | null {
  if (typeof entry !== "string" || entry.length === 0 || entry.length > TRUSTED_EGRESS_ENTRY_MAX) return "a network in CIDR form, e.g. 198.51.100.0/24";
  const net = parseCidr(entry);
  if (!net) return `«${entry}»: not a network in CIDR form (address/length, no host bits after the mask, no spaces)`;
  if (net.bits === 0) return `«${entry}»: the whole internet (/0) is not an egress network`;
  if (wholeNetworkProblem(net)) return `«${entry}»: an IPv6 network that covers IPv4 addresses (::ffff:0:0/96) — write an IPv4 network as IPv4`;
  const widest = DCR_TRUSTED_EGRESS_WIDEST[net.family];
  if (net.bits < widest) return `«${entry}»: wider than /${widest} (${net.family === "ipv4" ? "IPv4" : "IPv6"}) — a published egress range is narrower`;
  const special = FORBIDDEN_NETS.find(([range]) => networksOverlap(net, range));
  if (special) return `«${entry}»: touches ${special[1]} — not ordinary global unicast: the address seen there is a local proxy, a NAT, a relay or a shared service, never a cloud's egress`;
  return null;
}

/**
 * Problems of the whole agent_auth.dcr_trusted_egress list (empty — the list is saved, and read as it is): a list, at
 * most DCR_TRUSTED_EGRESS_MAX networks, each one by dcrTrustedEgressProblem, no network repeated or overlapping another
 * (one would hide an edit of the other). The same rule decides the read past the API: any problem — nobody is trusted.
 */
export function dcrTrustedEgressListProblems(value: unknown): string[] {
  if (!Array.isArray(value)) return ["a list of networks in CIDR form, e.g. [\"198.51.100.0/24\", \"203.0.113.0/24\"]"];
  const out: string[] = [];
  if (value.length > DCR_TRUSTED_EGRESS_MAX) out.push(`at most ${DCR_TRUSTED_EGRESS_MAX} networks`);
  for (const e of value) { const p = dcrTrustedEgressProblem(e); if (p) out.push(p); }
  if (new Set(value).size !== value.length) out.push("networks are repeated");
  const nets = value.filter((e): e is string => typeof e === "string" && dcrTrustedEgressProblem(e) === null).map((e) => [e, parseCidr(e)!] as const);
  for (let i = 0; i < nets.length; i++) {
    for (let j = i + 1; j < nets.length; j++) {
      if (nets[i]![0] !== nets[j]![0] && networksOverlap(nets[i]![1], nets[j]![1])) out.push(`«${nets[i]![0]}» and «${nets[j]![0]}» overlap — list each network once`);
    }
  }
  return out;
}

/**
 * Networks of the trusted egress list that share addresses with access.trusted_proxies: a warning of the
 * panel, not a refusal — a proxy the administrator trusts forwards the caller's address, so its own address in the
 * egress list is almost always the mistake of listing the proxy instead of the cloud. Bad entries of either list are
 * skipped (the validation of each list speaks for them).
 */
export function dcrTrustedEgressOverProxies(egress: readonly string[], proxies: unknown): string[] {
  const nets = (Array.isArray(proxies) ? proxies : []).map((p) => parseCidr(p)).filter((n): n is Net => n !== null && wholeNetworkProblem(n) === null);
  return egress.filter((e) => { const n = parseCidr(e); return n !== null && nets.some((p) => networksOverlap(n, p)); });
}

/** Why one agent_auth.cimd_hosts entry is not `host/prefix/`, or null: parseCimdHostEntry of oauth-as/cimd.ts. */
export function cimdHostEntryProblem(entry: unknown): string | null {
  const r = parseCimdHostEntry(entry);
  if (r.ok) return null;
  return typeof entry === "string" ? `«${entry.slice(0, 120)}»: ${r.problem}` : r.problem;
}

/**
 * Problems of one agent_auth.* value for saving (empty — fine). `value` of dcr_limits is the merged object (seed default
 * with the value on top, Settings.validate): an absent per_day_trusted is checked as the seed's share — stricter than the
 * read, which takes floor(per_day / 2) for it (agentAuthConfig). Texts are English: they are API messages.
 */
export function agentAuthSettingProblems(path: string, value: unknown): string[] {
  if (!path.startsWith("agent_auth.") || value === null) return [];
  const key = path.slice("agent_auth.".length);
  switch (key) {
    case "mode":
      return (AGENT_AUTH_MODES as readonly unknown[]).includes(value) ? [] : ["one of \"external\", \"builtin\", \"off\""];
    case "clients": {
      const r = parseClientRows(value);
      return r.ok ? [] : r.problems.slice(0, 20);
    }
    case "cimd_hosts": {
      if (!Array.isArray(value)) return ["a list of host/prefix/ entries"];
      const out: string[] = [];
      if (value.length > CIMD_HOSTS_MAX) out.push(`at most ${CIMD_HOSTS_MAX} entries`);
      for (const e of value) { const p = cimdHostEntryProblem(e); if (p) out.push(p); }
      if (new Set(value).size !== value.length) out.push("entries are repeated");
      return out.slice(0, 20);
    }
    case "cimd_any_https":
    case "dcr_enabled":
      return typeof value === "boolean" ? [] : ["true or false"];
    case "dcr_limits": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return ["an object {per_day, per_day_net, per_day_trusted, max_clients, unused_hours}"];
      const out: string[] = [];
      const extra = Object.keys(value).filter((k) => !(k in DCR_LIMIT_RANGES));
      if (extra.length) out.push(`unknown fields: ${extra.join(", ")}`);
      const o = value as Record<string, unknown>;
      for (const [k, range] of Object.entries(DCR_LIMIT_RANGES)) {
        // per_day_trusted may be absent (a seed older than the field): it is read as half of per_day then
        if (k === "per_day_trusted" && o[k] === undefined) continue;
        if (!intIn(o[k], range)) out.push(`${k} is an integer ${range[0]}–${range[1]}`);
      }
      // the trusted egress share lies inside the day and below it: the other networks always keep a part
      if (typeof o.per_day === "number" && typeof o.per_day_trusted === "number" && o.per_day_trusted >= o.per_day) {
        out.push(`per_day_trusted (${o.per_day_trusted}) must be below per_day (${o.per_day}): it is the part of the day registrations from agent_auth.dcr_trusted_egress may use, the rest stays for other networks`);
      }
      return out;
    }
    case "dcr_trusted_egress":
      return dcrTrustedEgressListProblems(value).slice(0, 20);
    case "connection_days":
      return intIn(value, CONNECTION_DAYS_RANGE) ? [] : [`an integer ${CONNECTION_DAYS_RANGE[0]}–${CONNECTION_DAYS_RANGE[1]} (days)`];
    case "idle_days":
      return intIn(value, IDLE_DAYS_RANGE) ? [] : [`an integer ${IDLE_DAYS_RANGE[0]}–${IDLE_DAYS_RANGE[1]} (days without use)`];
    default:
      return [];
  }
}

/** Keys of the category: the nine rows of the seed (04-seed.sql, guarded block). */
export const AGENT_AUTH_KEYS = ["mode", "clients", "cimd_hosts", "cimd_any_https", "dcr_enabled", "dcr_limits", "dcr_trusted_egress", "connection_days", "idle_days"] as const;
