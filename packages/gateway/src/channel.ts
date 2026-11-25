// The request channel: where a request came from — inside (internal), the address for agents (agent) or the
// external address for agents (external). The channel is settled before any database access: by Host (access.external_hosts,
// access.agent_hosts) and by the client address (access.internal_networks; X-Forwarded-For only through access.trusted_proxies).
// X-Forwarded-Host is not read: the proxy must keep Host. No socket address (a request not through node-server, unit
// tests) — the channel is settled by Host alone.
//
// Behind a trusted proxy (a socket in access.trusted_proxies) there is no internal traffic: the panel and workplace use
// loopback, tools come directly or through an SSH tunnel. So a name in neither the external names nor the agents' names,
// arriving through the proxy, is the external channel: the proxy put in the upstream address or passed a foreign name — the guard
// is not switched off silently. Exceptions: a socket of the gateway machine itself (loopback, access.system_key_networks) and
// of the workplace server (access.workplace_peers): not the company proxy, even when listed as trusted (the checks of a test installation do so).
//
// By channel the first handler (channelGate) closes paths (for the external address a strict allow list, for the agents' address
// 404 on the admin API, first run, people's sign-in, sessions), counts the limits before the key (preauth.ts); authenticate
// (auth.ts) rejects credentials that do not belong on this channel (credentialAllowed). The external channel is stricter than the
// agents' channel: everything closed on the agents' address is closed on the external one too.
import { networkInterfaces } from "node:os";
import type { Context, MiddlewareHandler } from "hono";
import { addressBytes, canonicalIp, canonicalSocketIp, deployProfile, effectiveExternalHosts, effectiveTrustedProxies, internalNetworksDefault, log, oidcAddressKind, parseCidr,
         SYSTEM_KEY_NETWORKS_DEFAULT, wholeNetworkProblem, type CanonicalIp } from "@memory/shared";
import type { App } from "./context.ts";
import { preauthFor } from "./preauth.ts";
import { fromWorkplace } from "./workplace.ts";
import { currentListener } from "./admin-plane/listeners.ts";

export type Channel = "internal" | "agent" | "external";
export interface RequestChannel {
  channel: Channel;
  /** Host in lowercase, without port, brackets and trailing dot; none — null. */
  host: string | null;
  /** Client address: X-Forwarded-For through access.trusted_proxies, else the socket. */
  ip: string | null;
  /** Socket address without ::ffff:. */
  sock: string | null;
  /** External by access.external_hosts. */
  byHost: boolean;
  /** External because ip is outside access.internal_networks. */
  byAddress: boolean;
  /** ip is the trusted proxy itself (the proxy did not append X-Forwarded-For). */
  viaProxy: boolean;
  /** The socket is a trusted company proxy (not loopback, not the panel or workplace server). */
  fromProxy?: boolean;
  /** External because it came through a trusted proxy with a name from neither access.external_hosts nor access.agent_hosts. */
  byProxy?: boolean;
  /**
   * External because the request carries a forwarding header (FORWARDING_HEADERS) and its socket is not a trusted proxy
   * (profile `internet` only): something forwarded it, and that something is not the configured reverse proxy. Also
   * when the socket is a trusted proxy but its headers give no client address beyond the socket: the client is unknown.
   */
  byForward?: boolean;
  /**
   * The request carries a forwarding header (FORWARDING_HEADERS, any value; every profile): something forwarded it.
   * Such a request is never exempt from the limits before the key (exemptFromPreauth). Set only when true.
   */
  forwarded?: boolean;
  /**
   * The client address is lost (profile `internet`, main listener): the public Host from a non-public socket
   * (loopback, RFC 1918, 100.64/10, ULA, link-local) that is not a trusted proxy, with or without forwarding headers — a
   * reverse proxy in front of the gateway that is not configured as trusted (also one that adds no forwarding header: a
   * TLS or TCP terminator, HAProxy without `option forwardfor`, an L4 balancer). ip is that socket, shared by every client
   * behind it, so preauth.ts counts it like a trusted proxy's own address (proxy_per_minute, no failures lock, failures do
   * not lock the socket for other names) instead of locking everybody out; health says so (proxy_trust, degraded).
   * The rule cannot tell a proxy from a direct client whose own address is non-public (a company LAN client of an internet
   * install; every client behind Docker Desktop, rootless Docker or docker-proxy, which all arrive from the bridge): such a
   * client gets the same relief, an accepted trade (availability over the per-address failures lock — keys are
   * random, the proxy and global limits still apply). A client whose public address reaches the gateway never gets here.
   * Set only when true.
   */
  lostClient?: boolean;
}
/** Credential kind for the channel rules: what is accepted on which channel (credentialAllowed). */
export type CredentialKind = "oauth" | "personal" | "preview" | "service_t1" | "service_t0" | "service_obo"
  | "extended" | "system" | "admin_session" | "workplace_session";

/** The answer to a closed path is the one of an unknown route with a JSON body: the path does not reveal that it exists. */
export const NOT_FOUND_BODY: { code: "not_found"; message: string } = Object.freeze({ code: "not_found" as const, message: "Not found" });
/** The answer over the limit before the key check (together with the Retry-After header). */
export const RATE_LIMITED_BODY: { code: "rate_limited"; message: string } = Object.freeze({ code: "rate_limited" as const, message: "Too many requests from this address. Try again later" });

const HOUR_MS = 3_600_000;
/** At most this many Host names that came through a trusted proxy: the list is a hint for the administrator, not a journal. */
const PROXY_HOSTS_MAX = 20;
/** Sockets of untrusted proxies that lost the client address: at most this many, a hint, not a journal. */
const LOST_SOCKETS_MAX = 20;
const ONCE_MAX = 10_000;
/** Host is never longer than a DNS name (253 chars): the rest the client added itself — kept out of the log and the audit. */
export const HOST_MAX = 253;

// ------------------------------------------------------------------------------------------------ addresses and networks
//
// One parser: every address text this module compares — a hop
// of X-Forwarded-For (forwardedHop), the socket (bareAddress), an address another module passes in (inNetworks,
// isLoopbackAddress) — first becomes a CanonicalIp (canonicalIp / canonicalSocketIp, packages/shared). Comparisons take a
// CanonicalIp only (the type says so) and compare its bytes with the bytes of the parsed networks: neither node:net isIP
// nor BlockList is asked about any text here, so no second parser can read the same text differently. A header text the
// parser refuses (a zone id, garbage) is no address — an unknown hop.

/**
 * A socket address — the peer of the connection, or an address the panel relays from the browser's socket — in canonical
 * form: brackets, a port and ::ffff: before IPv4 dropped, a zone id dropped (canonicalSocketIp); not an address — null.
 */
export function bareAddress(x: string | null | undefined): CanonicalIp | null {
  return x ? canonicalSocketIp(x) : null;
}

/** A parsed network of a list: its bytes and prefix (IPv4 — 4 bytes, IPv6 — 16). */
interface Net { bytes: number[]; bits: number }
const lists = new Map<string, Net[]>();
const warned = new Set<string>();

/**
 * A parsed network list. The cache is by the setting value (the list's JSON): settings are re-read once a minute, and requests
 * are many. A wrong entry is skipped — with one channel_bad_cidr warning per value; the rest act.
 * "The whole internet" is skipped too: /0 and an IPv6 network touching ::ffff:0:0/96 — node:net BlockList matched every IPv4
 * address against it (wholeNetworkProblem): the panel refuses to save that; a database edit past the panel must not act.
 */
function networksOf(setting: string, cidrs: unknown): Net[] {
  const key = `${setting}\u0000${JSON.stringify(cidrs ?? null)}`;
  const hit = lists.get(key);
  if (hit) return hit;
  const list: Net[] = [];
  for (const raw of Array.isArray(cidrs) ? cidrs : []) {
    const parsed = parseCidr(typeof raw === "string" ? raw.trim() : raw);
    const net = parsed && !wholeNetworkProblem(parsed) ? parsed : null;
    if (!net) {
      const w = `${setting}\u0000${String(raw)}`;
      if (!warned.has(w)) {
        if (warned.size > 1000) warned.clear();
        warned.add(w);
        log.warn("channel_bad_cidr", { setting: setting || null, value: String(raw).slice(0, 80) });
      }
      continue;
    }
    list.push({ bytes: net.bytes, bits: net.bits });
  }
  if (lists.size > 200) lists.clear();
  lists.set(key, list);
  return list;
}

/** The address lies in the network: same family (a canonical address is never IPv4-mapped), equal on the prefix bits. */
function netContains(net: Net, bytes: readonly number[]): boolean {
  if (bytes.length !== net.bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    const m = (0xff << (8 - Math.max(0, Math.min(8, net.bits - i * 8)))) & 0xff;
    if ((bytes[i]! & m) !== (net.bytes[i]! & m)) return false;
  }
  return true;
}

/** The one comparison of this module: a canonical address against a list of networks (entries that are not networks — skipped). */
const inList = (setting: string, cidrs: unknown, ip: CanonicalIp | null): boolean => {
  const bytes = ip === null ? null : addressBytes(ip);
  return bytes !== null && networksOf(setting, cidrs).some((n) => netContains(n, bytes));
};

/**
 * The address lies in one of the list's networks (IPv4 and IPv6; ::ffff:a.b.c.d as IPv4). Wrong entries do not act. The text
 * goes through the one parser first (canonicalIp): a text it refuses — a zone id, garbage — lies in no network.
 */
export function inNetworks(ip: string | null, cidrs: readonly string[]): boolean {
  return inList("", cidrs, canonicalIp(ip));
}

const LOOPBACK_NETWORKS: readonly string[] = ["127.0.0.0/8", "::1/128"];
/** Loopback of the gateway machine itself: it is never external by address, whatever access.internal_networks holds. */
const isLoopback = (ip: CanonicalIp): boolean => inList("loopback", LOOPBACK_NETWORKS, ip);
/** The same check for any text, through the one parser: a text it refuses is not loopback. */
export const isLoopbackAddress = (ip: string | null): boolean => { const a = canonicalIp(ip); return a !== null && isLoopback(a); };
/** Not an internet address: loopback, RFC 1918, 100.64/10, ULA or link-local (oidcAddressKind of the canonical text). */
const nonPublic = (ip: CanonicalIp): boolean => ["loopback", "private", "link_local"].includes(oidcAddressKind(ip));

/**
 * The socket is in access.system_key_networks (the connection address only, not X-Forwarded-For). No socket — no. Exception:
 * the unix socket of the admin listener and the command line: the connection has no address, the OS admits to it (mode 0660).
 */
export function fromSystemKeyNetwork(app: App, sock: string | null): boolean {
  const l = currentListener();
  if (l?.unix && (l.kind === "admin" || l.kind === "cli")) return true;
  return inList("access.system_key_networks", app.settings.get<unknown>("access.system_key_networks", SYSTEM_KEY_NETWORKS_DEFAULT), bareAddress(sock));
}

/**
 * access.trusted_proxies as the gateway applies it: the stored list plus MEMORY_TRUSTED_PROXIES (public-url.ts;
 * nothing is written to the database). Every reader of the key in the gateway goes through this function and nowhere else
 * (a unit test checks this), so a proxy given by the environment reaches all of them at once.
 */
export const trustedProxies = (app: Pick<App, "settings">): string[] => effectiveTrustedProxies(app.settings.get<unknown>("access.trusted_proxies", []));
let ownCache: { at: number; list: string[] } | null = null;
let ownForTests: string[] | null = null;
/**
 * The networks of the gateway's own interfaces, as `address/prefix` (a container's Docker networks, the host's LANs),
 * loopback left out; re-read once a minute. In profile `internet` a key may not be bound to them (admin.ts keyCidrs)
 * — every client behind a proxy on such a network would match.
 */
export function ownNetworks(now = Date.now()): string[] {
  if (ownForTests) return [...ownForTests];
  if (ownCache && now - ownCache.at < 60_000) return [...ownCache.list];
  let list: string[] = [];
  try { list = Object.values(networkInterfaces()).flatMap((xs) => xs ?? []).filter((x) => x.internal !== true && typeof x.cidr === "string").map((x) => x.cidr as string); }
  catch { list = []; }
  ownCache = { at: now, list };
  return [...list];
}
/** Tests: the own networks to use instead of the interfaces; null — the interfaces again. */
export function setOwnNetworksForTests(list: string[] | null): void { ownForTests = list ? [...list] : null; ownCache = null; }

/** access.external_hosts as the gateway applies it: the stored names plus the host of MEMORY_PUBLIC_URL; the only reader. */
export const externalHosts = (app: Pick<App, "settings">): string[] => effectiveExternalHosts(app.settings.get<unknown>("access.external_hosts", []));

/**
 * A value of X-Forwarded-For (or of another header that names an address) in canonical form — the one parser,
 * canonicalIp: port, brackets and ::ffff: dropped; a zone id, garbage or anything else that is not a plain literal — null
 * (an unknown hop, as if the proxy had named nobody).
 */
export function forwardedHop(v: string): CanonicalIp | null {
  return canonicalIp(v);
}
/** We parse no more chain links than this: nobody stands behind that many trusted proxies. */
export const MAX_FORWARDED_HOPS = 10;

/**
 * The X-Forwarded-For chain + the connection address → the client address: right to left up to the first untrusted address
 * (access.trusted_proxies). The left values come from the client — a proxy only appends. A non-IP in the chain — no further
 * trust: the address is the last trusted hop (a zone id or garbage is such a hop: the one parser refuses it). Network matching is
 * in memory (the bytes of the parsed networks), with no database query.
 */
export function forwardedAddress(app: Pick<App, "settings">, xff: string | null, sockRaw: string | null): CanonicalIp | null {
  const sock = bareAddress(sockRaw);
  const hops = (xff ?? "").split(",").filter((h) => h.trim()).slice(-MAX_FORWARDED_HOPS).map(forwardedHop);
  const proxies = trustedProxies(app);
  if (!hops.length || !sock || !proxies.length) return sock;
  const chain = [...hops, sock];
  let i = chain.length - 1;                                  // the socket
  while (i > 0 && inList("access.trusted_proxies", proxies, chain[i]!)) {
    if (chain[i - 1] === null) break;                        // a non-IP left of a trusted hop — the address of that hop
    i--;
  }
  return chain[i]!;
}

// ------------------------------------------------------------------------------------------------ Host names

/**
 * The Host header name: lowercase, without port, IPv6 brackets and trailing dot, at most 253 characters (a DNS name is never
 * longer — the tail goes to neither the log nor the audit); empty — null.
 */
export function normalizeHost(raw: string | null | undefined): string | null {
  let h = (raw ?? "").slice(0, HOST_MAX * 2).trim().toLowerCase();
  if (h.startsWith("[")) { const end = h.indexOf("]"); h = end > 0 ? h.slice(1, end) : h.slice(1); }
  else if ((h.match(/:/g) ?? []).length === 1) h = h.slice(0, h.indexOf(":"));
  h = h.replace(/\.+$/, "").slice(0, HOST_MAX);
  return h || null;
}

/** The request's Host; no header — the name from the request URL (that is how node-server builds it). */
export function requestHost(req: Request): string | null {
  const header = req.headers.get("host");
  if (header !== null) return normalizeHost(header);
  try { return normalizeHost(new URL(req.url).host); } catch { return null; }
}

const hostSets = new Map<string, Set<string>>();
/** Normalized names of a host list; cached by the list's value (the settings are re-read once a minute, requests are many). */
function hostSetOf(list: string, value: unknown): Set<string> {
  const key = `${list}\u0000${JSON.stringify(value ?? null)}`;
  const hit = hostSets.get(key);
  if (hit) return hit;
  const set = new Set((Array.isArray(value) ? value : []).map((v) => normalizeHost(typeof v === "string" ? v : "")).filter((v): v is string => v !== null));
  if (hostSets.size > 100) hostSets.clear();
  hostSets.set(key, set);
  return set;
}

// ------------------------------------------------------------------------------------------------ channel

/**
 * Headers a forwarding hop adds. In the `internet` profile a request that carries any of them (even with an empty
 * value) on a socket outside the trusted proxies is external: a reverse proxy that is not configured as trusted — or a
 * client that writes the header itself to look internal. The panel's and the workplace's own X-Memory-Client-* headers are
 * not forwarding headers. Names are compared by Headers.has (case-insensitive).
 */
export const FORWARDING_HEADERS: readonly string[] = ["x-forwarded-for", "forwarded", "x-forwarded-host", "x-real-ip", "via"];

/**
 * The request came over a local listener the rule above does not apply to: the workplace listener (any transport — its
 * server forwards for every person) or a unix admin / CLI listener (no address, access is the OS's file permissions).
 * Outside a listener (unit tests on app.fetch) — the main listener.
 */
const onLocalListener = (): boolean => {
  const l = currentListener();
  return l?.kind === "workplace" || (l?.unix === true && (l.kind === "admin" || l.kind === "cli"));
};

async function classify(app: App, req: Request, sockRaw: string | null): Promise<RequestChannel> {
  const sock = bareAddress(sockRaw);
  const proxies = trustedProxies(app);
  const ip = forwardedAddress(app, req.headers.get("x-forwarded-for"), sock);
  const viaProxy = ip !== null && inList("access.trusted_proxies", proxies, ip);
  const host = requestHost(req);
  const byHost = host !== null && hostSetOf("external_hosts", externalHosts(app)).has(host);
  const byAddress = ip !== null && !isLoopback(ip)
    && !inList("access.internal_networks", app.settings.get<unknown>("access.internal_networks", internalNetworksDefault(deployProfile())), ip);
  const agent = host !== null && hostSetOf("agent_hosts", app.settings.get<unknown>("access.agent_hosts", [])).has(host);
  // the socket is a company proxy: trusted, but not loopback and not the panel or workplace server (their test-installation checks also
  // list them as trusted). A name through it that is neither external nor an agents' name — external (fail-closed)
  const fromProxy = sock !== null && inList("access.trusted_proxies", proxies, sock) && !isLoopback(sock) && !(await localPeer(app, sock));
  const byProxy = fromProxy && !byHost && !agent;
  // internet: forwarded by something that is not a trusted proxy — external (a missing socket counts as untrusted). A
  // trusted proxy whose forwarding yields no client address beyond the socket (X-Real-IP, Forwarded or Via without
  // X-Forwarded-For, or one that names only trusted hops) is external too: the client is unknown — fail closed. It matters
  // for a proxy on loopback, which fromProxy leaves out. A client address taken from the forwarding
  // that is itself a trusted hop or loopback is no client address either: a proxy that passes the client's own
  // X-Forwarded-For on unchanged lets the client write 127.0.0.2 or ::1 there — external as well.
  const sockTrusted = sock !== null && inList("access.trusted_proxies", proxies, sock);
  const forwarded = FORWARDING_HEADERS.some((h) => req.headers.has(h));
  const clientUnknown = ip === null || ip === sock || viaProxy || isLoopback(ip);
  const byForward = deployProfile() === "internet" && forwarded && (!sockTrusted || clientUnknown) && !onLocalListener();
  const rc: RequestChannel = { channel: byHost || byAddress || byProxy || byForward ? "external" : agent ? "agent" : "internal", host, ip, sock, byHost, byAddress, viaProxy, fromProxy, byProxy };
  if (byForward) rc.byForward = true;
  if (forwarded) rc.forwarded = true;
  // internet: an untrusted proxy in front of the gateway (the public Host through a non-public socket, with or without a
  // forwarding header — repair) — the client address is lost, every client shares the socket
  if (deployProfile() === "internet" && !onLocalListener() && byHost && sock !== null && !sockTrusted && nonPublic(sock)) rc.lostClient = true;
  return rc;
}

/** The request channel by Host and addresses. Does not touch the database. */
export async function classifyRequest(app: App, req: Request, sock: string | null): Promise<RequestChannel> {
  return classify(app, req, sock);
}

const channels = new WeakMap<Request, RequestChannel>();
/** The channel already settled by the channelGate handler (or requestChannel) for this Request; none — null. */
export function channelOfRequest(req: Request): RequestChannel | null {
  return channels.get(req) ?? null;
}
/** channelOfRequest(req) ?? classifyRequest(app, req, sock) — remembered on the Request. */
export async function requestChannel(app: App, req: Request, sock: string | null): Promise<RequestChannel> {
  const hit = channels.get(req);
  if (hit) return hit;
  const rc = await classify(app, req, sock);
  const again = channels.get(req);                         // a parallel call on the same Request got there first — its channel
  if (again) return again;
  channels.set(req, rc);
  return rc;
}

/** External channel — of the caller (Caller) or of the request channel. No channel — internal. */
export const isExternal = (x: { channel?: Channel } | null | undefined): boolean => x?.channel === "external";
/** The agents' channel: the address for agents or the external one. */
export const isAgentChannel = (x: { channel?: Channel } | null | undefined): boolean => x?.channel === "agent" || x?.channel === "external";

const ONLY_INTERNAL: ReadonlySet<CredentialKind> = new Set(["system", "admin_session", "workplace_session"]);
const NOT_EXTERNAL: ReadonlySet<CredentialKind> = new Set(["preview", "service_t0", "service_obo", "extended"]);
/**
 * Whether credentials of this kind are accepted on the channel. Inside — all (the addresses of the system key, of panel and
 * workplace sessions are checked apart). On the agents' address — all but the system key and sessions. Outside — also without
 * preview, the extended key, T0 service keys and on-behalf-of; OAuth, a personal key and a T1 service — yes.
 */
export function credentialAllowed(channel: Channel, kind: CredentialKind): boolean {
  if (channel === "internal") return true;
  if (ONLY_INTERNAL.has(kind)) return false;
  return !(channel === "external" && NOT_EXTERNAL.has(kind));
}

// ------------------------------------------------------------------------------------------------ state in memory

interface ChannelState { once: Map<string, number>; hosts: Map<string, { count: number; last: number }>; lost: Map<string, { count: number; last: number }> }
const states = new WeakMap<object, ChannelState>();
function stateOf(app: App): ChannelState {
  let s = states.get(app);
  if (!s) { s = { once: new Map(), hosts: new Map(), lost: new Map() }; states.set(app, s); }
  return s;
}

/** The first event with this key within the window ms (log rows "at most once an hour"). Process memory, no people. */
export function onceIn(app: App, key: string, ms: number, now = Date.now()): boolean {
  const once = stateOf(app).once;
  const at = once.get(key);
  if (at !== undefined && now - at < ms) return false;
  if (once.size >= ONCE_MAX) {
    for (const [k, t] of once) if (now - t >= HOUR_MS) once.delete(k);
    if (once.size >= ONCE_MAX) once.clear();                 // a growth guard: losing the marks only repeats a row
  }
  once.delete(key);
  once.set(key, now);
  return true;
}

/**
 * Host names that came through a trusted proxy (the socket is a company proxy: from access.trusted_proxies, not loopback, not the
 * panel or workplace server), with request counts: a name is forgotten after an hour without requests; at most 20 names. It shows
 * whether the proxy keeps the Host of the external address — without calling the address itself. Shown in the health check
 * external_channel only to the system caller; a name outside both lists is a warning there.
 */
export function proxyHostsSeen(app: App, now = Date.now()): Array<{ host: string; count: number }> {
  const hosts = stateOf(app).hosts;
  for (const [h, v] of hosts) if (now - v.last >= HOUR_MS) hosts.delete(h);
  return [...hosts].map(([host, v]) => ({ host, count: v.count })).sort((a, b) => b.count - a.count || a.host.localeCompare(b.host));
}

/**
 * Sockets of untrusted proxies that lost the client address during the last hour (RequestChannel.lostClient), with the
 * number of requests; at most 20. A socket that has been added to the effective trusted proxies since is left out, so the
 * warning ends with the next settings reload. Health check proxy_trust (system caller only).
 */
export function untrustedProxiesSeen(app: App, now = Date.now()): Array<{ sock: string; count: number }> {
  const lost = stateOf(app).lost;
  for (const [k, v] of lost) if (now - v.last >= HOUR_MS) lost.delete(k);
  const proxies = trustedProxies(app);
  return [...lost].filter(([sock]) => !inList("access.trusted_proxies", proxies, bareAddress(sock)))
    .map(([sock, v]) => ({ sock, count: v.count })).sort((a, b) => b.count - a.count || a.sock.localeCompare(b.sock));
}

function noteSeen(app: App, rc: RequestChannel, now = Date.now()): void {
  if (rc.lostClient && rc.sock) {
    const lost = stateOf(app).lost;
    for (const [k, v] of lost) if (now - v.last >= HOUR_MS) lost.delete(k);
    const hit = lost.get(rc.sock);
    if (hit) { hit.count++; hit.last = now; }
    else if (lost.size < LOST_SOCKETS_MAX) lost.set(rc.sock, { count: 1, last: now });
  }
  if (rc.host && rc.fromProxy) {
    const hosts = stateOf(app).hosts, name = rc.host.slice(0, 100);
    for (const [h, v] of hosts) if (now - v.last >= HOUR_MS) hosts.delete(h);
    const hit = hosts.get(name);
    if (hit) { hit.count++; hit.last = now; }
    else if (hosts.size < PROXY_HOSTS_MAX) hosts.set(name, { count: 1, last: now });
  }
  // external only because the name through the proxy is in no list: the proxy put in the upstream address or passed
  // a foreign name — once an hour per name (a name is short, no people)
  if (rc.byProxy && !rc.byAddress && onceIn(app, `by_proxy:${(rc.host ?? "").slice(0, 100)}`, HOUR_MS, now))
    log.warn("channel_external_by_proxy_host", { host: rc.host?.slice(0, 100) ?? null });
  // external by address alone: an internal name, a client outside company networks (unlisted VPN pool?) — hourly per address
  if (rc.byAddress && !rc.byHost && rc.ip && onceIn(app, `by_address:${rc.ip}`, HOUR_MS, now))
    log.warn("channel_external_by_address", { ip: rc.ip, host: rc.host?.slice(0, 100) ?? null });
  // internet: a forwarding header from a socket outside the trusted proxies — once an hour per socket
  if (rc.byForward && onceIn(app, `by_forward:${rc.sock ?? "-"}`, HOUR_MS, now))
    log.warn("channel_external_by_forwarding_header", { sock: rc.sock, host: rc.host?.slice(0, 100) ?? null });
}

// ------------------------------------------------------------------------------------------------ first handler

const READ_METHODS: readonly string[] = ["GET", "HEAD", "OPTIONS"];
/** The external address is a strict allow list; a method outside the list on an allowed path is a 404 too. */
export const EXTERNAL_PATHS: ReadonlyArray<{ path: string; prefix?: true; methods: readonly string[] | null }> = [
  { path: "/mcp", methods: null },
  { path: "/.well-known/oauth-protected-resource", methods: READ_METHODS },
  { path: "/.well-known/oauth-protected-resource/mcp", methods: READ_METHODS },
  // the built-in AS answers only in agent_auth.mode = builtin, otherwise the router's 404
  { path: "/.well-known/oauth-authorization-server", prefix: true, methods: READ_METHODS },
  // the gateway has none: the answer is the same as on the internal address (the router's 404)
  { path: "/.well-known/openid-configuration", prefix: true, methods: READ_METHODS },
  // the built-in AS, exact paths: the browser part of the sign-in (HEAD is answered 405 by the route)
  // and the token side, registration with their CORS preflights; outside builtin — the router's 404
  { path: "/oauth/authorize", methods: ["GET", "HEAD"] },
  { path: "/oauth/authorize/continue", methods: ["GET"] },
  { path: "/oauth/token", methods: ["POST", "OPTIONS"] },
  { path: "/oauth/revoke", methods: ["POST", "OPTIONS"] },
  { path: "/oauth/register", methods: ["POST", "OPTIONS"] },
  { path: "/api/v1/skill/", prefix: true, methods: READ_METHODS },
  { path: "/api/v1/originals/", prefix: true, methods: READ_METHODS },
  { path: "/api/v1/uploads/", prefix: true, methods: ["PUT", "OPTIONS"] },
  { path: "/api/v1/health", methods: ["GET", "HEAD"] },
];
/**
 * The agents' address: the admin API and panel sign-in, first run, people's sign-in, workplace sessions — 404. The admin plane:
 * administrator sign-in /api/v1/admin-auth and the consents to on-behalf-of reads — a person only, not an agent.
 */
export const AGENT_DENIED_PREFIXES: readonly string[] = ["/api/v1/admin", "/api/v1/admin-auth", "/api/v1/first-run", "/api/v1/auth", "/api/v1/me/sessions",
  "/api/v1/me/obo-consents",
  // the sign-in transaction API of the built-in AS: only the workplace listener, a person's session
  "/api/v1/me/oauth"];

/** Whether the path is open on the channel. The path is the same one routing uses (c.req.path). */
export function pathAllowed(channel: Channel, method: string, path: string): boolean {
  if (channel === "internal") return true;
  if (channel === "external") {
    const m = method.toUpperCase();
    return EXTERNAL_PATHS.some((x) => (x.prefix ? path.startsWith(x.path) : path === x.path) && (x.methods === null || x.methods.includes(m)));
  }
  // the ban works on lowercase and without repeated "/": a variant spelling of the path must not slip past the list
  const p = path.toLowerCase().replace(/\/{2,}/g, "/");
  return !AGENT_DENIED_PREFIXES.some((x) => p.startsWith(x));
}

/**
 * The socket is the gateway's own machine or the workplace server: access.system_key_networks or access.workplace_peers
 * (the panel's server calls for every person). A fact about the socket only — whether the request is exempt from the
 * limits before the key is exemptFromPreauth's decision.
 */
export async function localPeer(app: App, sock: string | null): Promise<boolean> {
  return fromSystemKeyNetwork(app, sock) || (await fromWorkplace(app, sock));
}

/**
 * Exempt from the limits before the key: only a local caller that speaks for itself. In this order — never on the
 * external channel (any listener); always on a local listener (the workplace listener, a unix admin or CLI socket); never
 * when the request carries a forwarding header or its socket is a trusted proxy (a reverse proxy on loopback or in a Docker
 * network forwards the internet: its traffic is counted, by the client address it forwards); otherwise a local peer
 * (localPeer). The first four steps need no name lookup (fromWorkplace may resolve the names of access.workplace_peers).
 */
export async function exemptFromPreauth(app: App, rc: Pick<RequestChannel, "sock" | "channel" | "forwarded">): Promise<boolean> {
  if (rc.channel === "external") return false;
  if (onLocalListener()) return true;
  if (rc.forwarded === true) return false;
  if (rc.sock !== null && inList("access.trusted_proxies", trustedProxies(app), bareAddress(rc.sock))) return false;
  return localPeer(app, rc.sock);
}

const gated = new WeakSet<Request>();
/**
 * The gateway's first handler (http.ts): settles the channel, remembers it on the Request, applies the limit before the key
 * (preauth.ts), then closes paths by channel. All before the key and before the database. A repeated call on the same Request
 * does nothing.
 */
export function channelGate(app: App, sockOf: (c: Context) => string | null): MiddlewareHandler {
  return async (c, next) => {
    const req = c.req.raw;
    if (gated.has(req)) { await next(); return; }
    gated.add(req);
    const rc = await requestChannel(app, req, sockOf(c));
    noteSeen(app, rc);
    const authorization = req.headers.get("authorization");
    const credential = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1] ?? null;
    const verdict = preauthFor(app).admit(rc, { exempt: await exemptFromPreauth(app, rc), hasCredential: !!authorization, credential });
    if (!verdict.ok) {
      if (onceIn(app, `preauth:${verdict.scope}:${rc.ip ?? "-"}`, 60_000)) log.warn("preauth_rate_limited", { scope: verdict.scope, ip: rc.ip, channel: rc.channel });
      return c.json(RATE_LIMITED_BODY, 429, { "Retry-After": String(verdict.retryAfter) });
    }
    if (!pathAllowed(rc.channel, c.req.method, c.req.path)) return c.json(NOT_FOUND_BODY, 404);
    await next();
  };
}
