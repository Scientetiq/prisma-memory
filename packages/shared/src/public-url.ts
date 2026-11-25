// Public address of the installation and the reverse proxies it trusts, from the environment:
//
//   MEMORY_PUBLIC_URL        the address agents use, for example https://memory.example.com (an origin: no path, query,
//                            fragment or user name). Its host name is added to access.external_hosts, and it is the
//                            fallback of the agents' address when access.cloud_agent_base_url and access.public_base_url
//                            are empty (issuer of the built-in agent sign-in, the address shown to agents).
//   MEMORY_TRUSTED_PROXIES   CIDR list of the reverse proxies as the gateway sees them (commas or spaces between entries;
//                            the width rules of access.trusted_proxies). Added to access.trusted_proxies.
//
// Nothing is written to the database: the effective lists are "stored settings ∪ environment", computed on every read, in
// every deploy profile. An environment overlay works before the first administrator exists and cannot drift from the proxy
// that the compose file starts. A malformed value is never half-applied: the address and the proxies are both dropped and
// the problem is reported (the gateway refuses to start on it, deploy-guard.ts). Problem texts never repeat the address
// (it might carry a password); a proxy entry is repeated only when it looks like an address.
//
// This module is the only reader of the two variables in the gateway and the workers (contracts/env-allowlist.json); the
// web service reads MEMORY_PUBLIC_URL itself for the Secure flag of its session cookies (packages/admin/src/lib/
// workplace-login.ts). A golden test pins both readers.
import { isHostName, NETWORK_WIDEST, parseCidr, wholeNetworkProblem } from "./channel-settings.ts";

export const PUBLIC_URL_ENV = "MEMORY_PUBLIC_URL";
export const TRUSTED_PROXIES_ENV = "MEMORY_TRUSTED_PROXIES";
/** At most as many proxies as access.trusted_proxies takes. */
export const TRUSTED_PROXIES_ENV_MAX = 20;

export interface PublicAddress {
  /** Origin of MEMORY_PUBLIC_URL without a trailing slash (host lower case, no trailing dot); not set or invalid — null. */
  url: string | null;
  /** Host name of the address for the Host lists; null when the address is an IP literal or localhost, or not set. */
  host: string | null;
  /** The address is https. */
  https: boolean;
  /** CIDR entries of MEMORY_TRUSTED_PROXIES; [] when not set or invalid. */
  proxies: readonly string[];
  /** Why the variables cannot be used (English, one line each); [] — usable or not set. */
  problems: readonly string[];
}

const EMPTY: PublicAddress = Object.freeze({ url: null, host: null, https: false, proxies: Object.freeze([]), problems: Object.freeze([]) });

const urlProblem = (why: string): string =>
  `${PUBLIC_URL_ENV} ${why}. Give the origin agents use, for example https://memory.example.com (the value is not repeated here).`;

/** Address part: origin, host, https flag, or the problem. */
function parseUrl(raw: string): { url: string; host: string | null; https: boolean } | { problem: string } {
  if (/\s/.test(raw)) return { problem: urlProblem("contains spaces") };
  let u: URL;
  try { u = new URL(raw); } catch { return { problem: urlProblem("is not a URL") }; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { problem: urlProblem("must start with https:// (or http:// outside the internet profile)") };
  if (u.username || u.password) return { problem: urlProblem("must not contain a user name or a password") };
  // what follows the authority in the raw text: the parser folds "/.", "/a/.." and "\" into "/", the raw text does not
  const rest = raw.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#\\]*/i, "");
  const path = rest.split(/[?#]/)[0];
  if (u.pathname !== "/" || (path !== "" && path !== "/")) return { problem: urlProblem("must not have a path") };
  if (u.search || rest.includes("?")) return { problem: urlProblem("must not have a query") };
  if (u.hash || rest.includes("#")) return { problem: urlProblem("must not have a fragment") };
  if (!u.hostname) return { problem: urlProblem("has no host") };
  const bare = u.hostname.replace(/\.+$/, "");
  if (!bare) return { problem: urlProblem("has no host") };
  if (bare !== u.hostname) u.hostname = bare;
  return { url: u.origin, host: isHostName(bare) ? bare.toLowerCase() : null, https: u.protocol === "https:" };
}

/** Entry shown in a problem text: the entry itself when it looks like an address or a network, otherwise its number. */
const shown = (entry: string, i: number): string => (/^[0-9A-Fa-f:./]{1,50}$/.test(entry) ? `"${entry}"` : `entry ${i + 1}`);

/** Proxy part: CIDR entries, or the problems. */
function parseProxies(raw: string): { proxies: string[] } | { problems: string[] } {
  const entries = raw.split(/[\s,]+/).filter(Boolean);
  const problems: string[] = [];
  if (entries.length > TRUSTED_PROXIES_ENV_MAX) problems.push(`${TRUSTED_PROXIES_ENV} lists ${entries.length} entries; at most ${TRUSTED_PROXIES_ENV_MAX} are allowed.`);
  const widest = NETWORK_WIDEST["access.trusted_proxies"];
  entries.forEach((e, i) => {
    const net = parseCidr(e);
    if (!net) problems.push(`${TRUSTED_PROXIES_ENV}: ${shown(e, i)} is not a CIDR network (address/prefix, host bits zero), for example 192.0.2.10/32.`);
    else if (net.bits === 0) problems.push(`${TRUSTED_PROXIES_ENV}: ${shown(e, i)} covers the whole internet; give the proxy's own address.`);
    else if (wholeNetworkProblem(net)) problems.push(`${TRUSTED_PROXIES_ENV}: ${shown(e, i)} is written as IPv6 but covers IPv4 addresses (::ffff:…); write an IPv4 proxy as IPv4, for example 192.0.2.10/32.`);
    else if (net.bits < widest[net.family]) problems.push(`${TRUSTED_PROXIES_ENV}: ${shown(e, i)} is too wide (IPv4 at most /${widest.ipv4}, IPv6 at most /${widest.ipv6}); give the proxy's own address.`);
  });
  return problems.length ? { problems } : { proxies: entries };
}

/**
 * The public address and the trusted proxies from the raw values of the two variables. Pure; never throws. Unset or blank
 * (compose passes `${VAR:-}`) means not set. Any problem drops both the address and the proxies.
 */
export function parsePublicAddress(rawUrl: string | null | undefined, rawProxies: string | null | undefined): PublicAddress {
  const urlRaw = (rawUrl ?? "").trim(), proxiesRaw = (rawProxies ?? "").trim();
  if (!urlRaw && !proxiesRaw) return EMPTY;
  const problems: string[] = [];
  const a = urlRaw ? parseUrl(urlRaw) : null;
  if (a && "problem" in a) problems.push(a.problem);
  const p = proxiesRaw ? parseProxies(proxiesRaw) : { proxies: [] as string[] };
  if ("problems" in p) problems.push(...p.problems);
  if (problems.length) return Object.freeze({ ...EMPTY, problems: Object.freeze(problems) });
  const addr = a && !("problem" in a) ? a : null;
  return Object.freeze({ url: addr?.url ?? null, host: addr?.host ?? null, https: addr?.https ?? false,
                         proxies: Object.freeze([...(p as { proxies: string[] }).proxies]), problems: Object.freeze([]) });
}

let cached: PublicAddress | null = null;

/** The public address of this process: read from the environment on the first call and remembered. */
export function publicAddress(): PublicAddress {
  return (cached ??= parsePublicAddress(process.env.MEMORY_PUBLIC_URL, process.env.MEMORY_TRUSTED_PROXIES));
}

/** For tests: set the two raw values, or (no argument) forget them so that the next call reads the environment again. */
export function resetPublicAddressForTests(v?: { url?: string; proxies?: string }): void {
  cached = v === undefined ? null : parsePublicAddress(v.url, v.proxies);
}

/** Origin of MEMORY_PUBLIC_URL, or null: the fallback of the agents' address when the settings are empty. */
export const publicBaseUrl = (): string | null => publicAddress().url;

const storedStrings = (stored: unknown): string[] => (Array.isArray(stored) ? stored.filter((x): x is string => typeof x === "string") : []);

/** access.trusted_proxies as applied: the stored entries first, then the entries of MEMORY_TRUSTED_PROXIES not already there. */
export function effectiveTrustedProxies(stored: unknown): string[] {
  const out = storedStrings(stored);
  for (const p of publicAddress().proxies) if (!out.includes(p)) out.push(p);
  return out;
}

const hostKey = (h: string): string => h.trim().toLowerCase().replace(/\.+$/, "");

/** access.external_hosts as applied: the stored names first, then the host of MEMORY_PUBLIC_URL unless already there. */
export function effectiveExternalHosts(stored: unknown): string[] {
  const out = storedStrings(stored);
  const host = publicAddress().host;
  if (host && !out.some((h) => hostKey(h) === host)) out.push(host);
  return out;
}
