import { isIP } from "node:net";
import type { DeployProfile } from "./deploy-profile.ts";

export const INTERNAL_NETWORKS_DEFAULT: readonly string[] = ["127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"];
/** Loopback only: the internal networks of the `internet` profile while access.internal_networks is unset. */
export const INTERNAL_NETWORKS_LOOPBACK: readonly string[] = ["127.0.0.0/8", "::1/128"];

/**
 * Effective access.internal_networks while the setting is unset (NULL: a fresh database, or a reset to the default) — by
 * deploy profile. `internet`: loopback only — behind a reverse proxy with a private address the whole internet
 * would otherwise be internal. `internal-http`, `development`: loopback, RFC 1918 and ULA, as before (a development installation needs its
 * Docker networks). A stored list wins in every profile, so an upgraded database classifies as before.
 */
export const internalNetworksDefault = (profile: DeployProfile): readonly string[] =>
  profile === "internet" ? INTERNAL_NETWORKS_LOOPBACK : INTERNAL_NETWORKS_DEFAULT;
export const SYSTEM_KEY_NETWORKS_DEFAULT: readonly string[] = ["127.0.0.1/32", "::1/128"];

export interface PreauthLimits { per_address_per_minute: number; proxy_per_minute: number; global_per_minute: number; auth_failures_per_minute: number }
export const PREAUTH_DEFAULTS: Readonly<PreauthLimits> = { per_address_per_minute: 600, proxy_per_minute: 6000, global_per_minute: 30_000, auth_failures_per_minute: 30 };
export const PREAUTH_RANGES: Readonly<Record<keyof PreauthLimits, readonly [number, number]>> = {
  per_address_per_minute: [60, 100_000], proxy_per_minute: [600, 1_000_000], global_per_minute: [1_000, 10_000_000], auth_failures_per_minute: [5, 10_000],
};

const HOSTS_MAX = 20;
const INTERNAL_NETWORKS_MAX = 50;
const SYSTEM_KEY_NETWORKS_MAX = 20;
const TRUSTED_PROXIES_MAX = 20;

export const NETWORK_WIDEST: Readonly<Record<"access.internal_networks" | "access.system_key_networks" | "access.trusted_proxies", { ipv4: number; ipv6: number }>> = {
  "access.internal_networks": { ipv4: 8, ipv6: 7 },
  "access.system_key_networks": { ipv4: 12, ipv6: 64 },
  "access.trusted_proxies": { ipv4: 12, ipv6: 64 },
};

export function addressBytes(addr: string): number[] | null {
  const v = isIP(addr);
  if (v === 4) return addr.split(".").map(Number);
  if (v !== 6 || addr.includes("%")) return null;
  let s = addr.toLowerCase(), tail: number[] = [];
  const dotted = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dotted) {
    tail = dotted[1]!.split(".").map(Number);
    s = `${s.slice(0, dotted.index + 1)}0:0`;
  }
  const [head = "", rest] = s.split("::");
  const left = head ? head.split(":") : [], right = rest === undefined ? [] : rest ? rest.split(":") : [];
  const groups = rest === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  if (groups.length !== 8) return null;
  const out = groups.flatMap((g) => { const n = parseInt(g, 16); return [n >> 8, n & 255]; });
  if (tail.length) out.splice(12, 4, ...tail);
  return out;
}

/**
 * A client address in its one canonical form (re-): the only kind of text the request channel compares
 * with networks. Made by canonicalIp or canonicalSocketIp only.
 */
export type CanonicalIp = string & { readonly __canonicalIp: true };

/** RFC 5952 text of 16 address bytes: lowercase, no leading zeros, the longest run (two groups or more) of zeros as `::`. */
function ipv6Text(bytes: readonly number[]): string {
  const groups = Array.from({ length: 8 }, (_, i) => ((bytes[2 * i]! << 8) | bytes[2 * i + 1]!));
  let best = -1, bestLen = 0;
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) { best = i; bestLen = j - i; }
    i = j;
  }
  const hex = (xs: number[]) => xs.map((g) => g.toString(16)).join(":");
  return best < 0 ? hex(groups) : `${hex(groups.slice(0, best))}::${hex(groups.slice(best + bestLen))}`;
}

/**
 * The one parser of a client address. Every address text
 * the request channel takes from a header (a hop of X-Forwarded-For, an address the panel relays) becomes this canonical
 * form before ANY comparison — trusted proxies, internal networks, loopback, system-key networks — and nothing else is
 * compared. Accepted: a plain IPv4 or IPv6 literal, in brackets, IPv4 or bracketed IPv6 with a port. Result: IPv4 dotted;
 * an IPv4-mapped IPv6 address (::ffff:a.b.c.d, ::ffff:7f00:1, the full form) as that IPv4; IPv6 in RFC 5952 form.
 * Refused (null): a zone id (`::1%lo0` — node:net reads it as ::1, the byte parser as no address, and two parsers that
 * disagree about the same text let a stranger be both "internal" and "not loopback"), garbage, anything else. A refused text
 * is NOT an address: the caller treats it as an unknown hop, exactly as a missing one.
 */
export function canonicalIp(text: unknown): CanonicalIp | null {
  if (typeof text !== "string") return null;
  let s = text.trim();
  const bracketed = /^\[([^\]]*)\](?::\d+)?$/.exec(s);
  if (bracketed) s = bracketed[1]!;
  else { const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(s); if (v4port) s = v4port[1]!; }
  if (!s || s.includes("%") || !/^[0-9A-Fa-f:.]+$/.test(s)) return null;
  const bytes = addressBytes(s);
  if (!bytes) return null;
  if (bytes.length === 4) return bytes.join(".") as CanonicalIp;
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 255 && bytes[11] === 255) return bytes.slice(12).join(".") as CanonicalIp;
  return ipv6Text(bytes) as CanonicalIp;
}

/**
 * The same parser for a SOCKET address: a real link-local peer carries a zone id (`fe80::1%eth0`), which says which
 * interface, not who. The zone id is dropped, then canonicalIp. A socket address got exactly this from every comparison
 * before (node:net BlockList ignores the zone); only the byte comparisons now agree with it.
 * Used (through bareAddress in the gateway's channel.ts) for exactly these, and for nothing else:
 *  - the peer of the connection (the channel, system-key networks, trusted proxies, the admin plane's client address);
 *  - the panel's own stamps: X-Memory-Client-Peer (its stamp of the browser socket; auth.ts workplaceClientAddress,
 *    external-access.ts officeCandidateAddress), X-Memory-Client-Ip (the address the panel took as the browser's — the
 *    right-hand value of the X-Forwarded-For it received; workplaceClientAddress, only when there is no Peer) and the
 *    panel's `client_ip` body field (admin-plane/sso.ts, only from a trusted panel). X-Memory-Client-Ip is text the
 *    browser or a proxy before the panel may write, yet the socket rule stays on purpose: there a value the header rule
 *    refused would make workplaceClientAddress fall back to the gateway's own socket — the panel itself, which is more
 *    trusted than any address the sender could name — and the same sender can write the address without the zone id
 *    anyway (re-).
 * Every other header text — each hop of X-Forwarded-For and of the panel's X-Memory-Client-Forwarded chain — takes
 * canonicalIp, where a zone id means no address.
 */
export function canonicalSocketIp(text: unknown): CanonicalIp | null {
  if (typeof text !== "string") return null;
  return canonicalIp(text.trim().replace(/%[^\]]*/, ""));
}

export function parseCidr(x: unknown): { addr: string; bits: number; family: "ipv4" | "ipv6"; bytes: number[] } | null {
  if (typeof x !== "string" || x !== x.trim() || !x) return null;
  const [addr = "", mask, extra] = x.split("/");
  if (extra !== undefined) return null;
  const bytes = addressBytes(addr);
  if (!bytes) return null;
  const max = bytes.length * 8;
  if (mask !== undefined && !/^\d{1,3}$/.test(mask)) return null;
  const bits = mask === undefined ? max : Number(mask);
  if (bits > max) return null;
  for (let i = 0; i < bytes.length; i++) {
    const keep = Math.max(0, Math.min(8, bits - i * 8));
    if (bytes[i]! & (0xff >> keep)) return null;
  }
  return { addr, bits, family: bytes.length === 4 ? "ipv4" : "ipv6", bytes };
}

export const isCidr = (x: unknown): boolean => parseCidr(x) !== null;

export function cidrContains(cidr: string, ip: string): boolean {
  const net = parseCidr(cidr);
  let bytes = addressBytes(ip);
  if (!net || !bytes) return false;
  if (bytes.length === 16 && net.family === "ipv4" && bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 255 && bytes[11] === 255) bytes = bytes.slice(12);
  if (bytes.length !== net.bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    const keep = Math.max(0, Math.min(8, net.bits - i * 8));
    const m = (0xff << (8 - keep)) & 0xff;
    if ((bytes[i]! & m) !== (net.bytes[i]! & m)) return false;
  }
  return true;
}

/**
 * A network or an address in a loose form: `a.b.c.d`, `a.b.c.d/n` with host bits allowed (an interface's own
 * `192.0.2.3/24` is its network 192.0.2.0/24), IPv6 likewise; an IPv4-mapped IPv6 network of at least /96 is the IPv4
 * network. Bits behind the mask are cleared. Not an address — null.
 */
function looseNetwork(x: string): { bytes: number[]; bits: number } | null {
  const [addr = "", mask, extra] = x.trim().split("/");
  if (extra !== undefined || (mask !== undefined && !/^\d{1,3}$/.test(mask))) return null;
  let bytes = addressBytes(addr);
  if (!bytes) return null;
  let bits = mask === undefined ? bytes.length * 8 : Number(mask);
  if (bits > bytes.length * 8) return null;
  if (bytes.length === 16 && bits >= 96 && bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 255 && bytes[11] === 255) { bytes = bytes.slice(12); bits -= 96; }
  return { bytes: bytes.map((b, i) => b & ((0xff << (8 - Math.max(0, Math.min(8, bits - i * 8)))) & 0xff)), bits };
}

/**
 * Two networks share at least one address: the same family and equal on the first min(bitsA, bitsB) bits — one
 * lies inside the other. Either side may be a bare address or a network with host bits; ::ffff:a.b.c.d is IPv4. An
 * entry that is not an address overlaps nothing.
 */
export function cidrOverlaps(a: string, b: string): boolean {
  const x = looseNetwork(a), y = looseNetwork(b);
  if (!x || !y || x.bytes.length !== y.bytes.length) return false;
  const bits = Math.min(x.bits, y.bits);
  for (let i = 0; i < x.bytes.length; i++) {
    const m = (0xff << (8 - Math.max(0, Math.min(8, bits - i * 8)))) & 0xff;
    if ((x.bytes[i]! & m) !== (y.bytes[i]! & m)) return false;
  }
  return true;
}

/**
 * Why a key network (net_cidrs of a key) would bind the key to nobody in particular: it covers or lies
 * inside a trusted proxy — behind the proxy every client matches it — ("proxy"), or one of the given own networks of the
 * server (its interfaces, loopback) ("own"). A /0 network is "no binding" (isNetBound) and is not judged here. Entries of
 * the lists that are not addresses are skipped.
 */
export function keyNetworkProblem(cidr: string, o: { proxies: readonly string[]; own: readonly string[] }): "proxy" | "own" | null {
  const net = looseNetwork(cidr);
  if (!net || net.bits === 0) return null;
  if (o.proxies.some((p) => typeof p === "string" && cidrOverlaps(cidr, p))) return "proxy";
  if (o.own.some((p) => typeof p === "string" && cidrOverlaps(cidr, p))) return "own";
  return null;
}

export function isHostName(x: unknown): boolean {
  if (typeof x !== "string" || x.length > 253 || !/^[A-Za-z0-9.-]+$/.test(x) || !x.includes(".")) return false;
  if (isIP(x)) return false;
  const lower = x.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) return false;
  const labels = lower.split(".");
  if (labels.some((l) => !l || l.length > 63 || l.startsWith("-") || l.endsWith("-"))) return false;
  return !/^\d+$/.test(labels[labels.length - 1]!);
}

function hostListProblems(value: unknown): string[] {
  if (!Array.isArray(value)) return ["expected a list of hostnames, for example [\"agents.example.test\"]"];
  if (value.length > HOSTS_MAX) return [`at most ${HOSTS_MAX} hostnames`];
  const bad = value.filter((v) => !isHostName(v));
  return bad.length ? [`not a DNS name (no scheme, port, path or “*”, and no IP address or localhost): ${bad.slice(0, 5).map((v) => JSON.stringify(v)).join(", ")}`] : [];
}

const MAPPED_IPV4 = "::ffff:0:0/96";

export function wholeNetworkProblem(net: { bits: number; family: "ipv4" | "ipv6"; addr: string }): string | null {
  if (net.bits === 0) return "the entire internet (/0) is not allowed as a network";
  if (net.family === "ipv6" && (cidrContains(`${net.addr}/${net.bits}`, "::ffff:0:0") || cidrContains(MAPPED_IPV4, net.addr)))
    return "the IPv6 network overlaps IPv4 addresses (::ffff:0:0/96). Enter an IPv4 network in IPv4 notation (10.0.0.0/8)";
  return null;
}

function networkListProblems(value: unknown, max: number, mustCover: readonly string[], widest: { ipv4: number; ipv6: number }): string[] {
  if (!Array.isArray(value)) return ["expected a list of CIDR networks, for example [\"127.0.0.1/32\"]"];
  if (value.length > max) return [`at most ${max} networks`];
  const out: string[] = [];
  const bad = value.filter((v) => !isCidr(v));
  if (bad.length) out.push(`not valid CIDR (address/mask, with all bits beyond the mask set to zero): ${bad.slice(0, 5).map((v) => JSON.stringify(v)).join(", ")}`);
  const parsed = value.filter((v): v is string => isCidr(v)).map((v) => ({ v, net: parseCidr(v)! }));
  const whole = new Map<string, string[]>();
  for (const { v, net } of parsed) {
    const why = wholeNetworkProblem(net);
    if (why) whole.set(why, [...(whole.get(why) ?? []), v]);
  }
  for (const [why, vs] of whole) out.push(`${why}: ${vs.slice(0, 5).map((v) => JSON.stringify(v)).join(", ")}`);
  const wide = parsed.filter(({ net }) => net.bits > 0 && !wholeNetworkProblem(net) && net.bits < widest[net.family]);
  if (wide.length) out.push(`network is too broad (IPv4: no broader than /${widest.ipv4}, IPv6: no broader than /${widest.ipv6}): ${wide.slice(0, 5).map(({ v }) => JSON.stringify(v)).join(", ")}`);
  const nets = parsed.filter(({ net }) => !wholeNetworkProblem(net)).map(({ v }) => v);
  const missing = mustCover.filter((ip) => !nets.some((n) => cidrContains(n, ip)));
  if (missing.length) out.push(`the list must cover ${missing.join(", ")} because the gateway, admin panel, and workspace connect over loopback`);
  return out;
}

function preauthProblems(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["expected an object with {per_address_per_minute, proxy_per_minute, global_per_minute, auth_failures_per_minute}"];
  const o = value as Record<string, unknown>, out: string[] = [];
  const extra = Object.keys(o).filter((k) => !Object.hasOwn(PREAUTH_RANGES, k));
  if (extra.length) out.push(`unexpected fields: ${extra.join(", ")}`);
  for (const [k, [min, max]] of Object.entries(PREAUTH_RANGES)) {
    if (!(k in o)) continue;
    const v = o[k];
    if (!(typeof v === "number" && Number.isInteger(v) && (v === 0 || (v >= min && v <= max)))) out.push(`${k}: an integer from ${min} to ${max}, or 0 to disable the limit`);
  }
  return out;
}

export function channelSettingProblems(path: string, value: unknown): string[] {
  if (value === null) return [];
  switch (path) {
    case "access.external_hosts":
    case "access.agent_hosts": return hostListProblems(value);
    case "access.internal_networks": return networkListProblems(value, INTERNAL_NETWORKS_MAX, ["127.0.0.1", "::1"], NETWORK_WIDEST[path]);
    case "access.system_key_networks": return networkListProblems(value, SYSTEM_KEY_NETWORKS_MAX, ["127.0.0.1"], NETWORK_WIDEST[path]);
    case "access.trusted_proxies": return networkListProblems(value, TRUSTED_PROXIES_MAX, [], NETWORK_WIDEST[path]);
    case "limits.preauth": return preauthProblems(value);
    default: return [];
  }
}
