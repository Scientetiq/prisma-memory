// Start refusals of the deploy profile. index.ts calls startRefusals() right after it has read the listener layout
// and stops the start when the list is not empty — one log line `listener_config_invalid` per refusal, exit code 1.
//
//   internet       The admin API (the panel's API, the admin sign-in, the first-run) must have its own listener, and that
//                  listener must not be reachable from other machines: a unix socket (access is given by the file
//                  permissions) or a TCP port on a loopback address. Without it the admin paths would be served by the
//                  main listener, the one a reverse proxy publishes. A separate workplace listener is held to the same
//                  rule: every request on it is trusted as coming from the workplace server.
//   internal-http  As before: the readiness check warns when the admin API shares the main listener.
//   development    As before.
//
// The public address and the trusted proxies (publicAddressRefusals): index.ts calls it right after startRefusals()
// and logs one line `public_address_invalid` per refusal, exit code 1. A malformed MEMORY_PUBLIC_URL or MEMORY_TRUSTED_PROXIES
// stops the start in every profile. In `internet` a public address must be https, must be a host name (it becomes an external
// host), and needs MEMORY_TRUSTED_PROXIES — the check looks at the environment only: it runs before the database, and it is
// the same on every start. Neither variable set is allowed: a local-only start, where every request on the main listener that
// does not come from loopback is external. The secrets refusal is not here: it must stop workers and tools too (readEnv).
import { cidrContains, INTERNAL_NETWORKS_LOOPBACK, parseCidr, type DeployProfile, type PublicAddress } from "@memory/shared";
import { LISTENER_VARS, type ListenAddr, type ListenerTopology } from "./admin-plane/listeners.ts";

const ADMIN_SOCKET_EXAMPLE = "unix:/run/memory-admin/api.sock";

/** Refusal: `internet` and no admin listener. */
export const adminListenerMissingMessage =
  `The deploy profile "internet" requires the admin API on its own listener, and ${LISTENER_VARS.admin} is not set. `
  + `Set it to a unix socket, for example ${LISTENER_VARS.admin}=${ADMIN_SOCKET_EXAMPLE}, or to a loopback port such as tcp:127.0.0.1:8082. `
  + `A server on a closed network served over plain HTTP may use MEMORY_DEPLOY_PROFILE=internal-http instead.`;

const tcpText = (host: string, port: number): string => (host.includes(":") ? `tcp:[${host}]:${port}` : `tcp:${host}:${port}`);

/** Refusal: `internet` and a listener of the admin API or of the workplace on a TCP address other machines can reach. */
export const listenerNotLocalMessage = (variable: string, host: string, port: number): string =>
  `The deploy profile "internet" allows ${variable} only on a unix socket or a loopback address (127.0.0.1, ::1), `
  + `and it has ${tcpText(host, port)}. Use a unix socket (for example ${variable === LISTENER_VARS.admin ? ADMIN_SOCKET_EXAMPLE : "unix:/run/memory-gateway/workplace.sock"}) `
  + `or tcp:127.0.0.1:${port}.`;

/** A TCP address only this machine can reach: an IP literal in 127.0.0.0/8 or ::1 (also IPv4-mapped). A host name is not. */
export const isLoopbackAddress = (host: string): boolean => cidrContains("127.0.0.0/8", host) || cidrContains("::1/128", host);

const notLocal = (addrs: readonly ListenAddr[]): Array<Extract<ListenAddr, { type: "tcp" }>> =>
  addrs.filter((a): a is Extract<ListenAddr, { type: "tcp" }> => a.type === "tcp" && !isLoopbackAddress(a.host));

/** Every reason this process must not start in this profile with this listener layout; empty — it may start. */
export function startRefusals(profile: DeployProfile, topology: ListenerTopology): string[] {
  if (profile !== "internet") return [];
  const out: string[] = [];
  if (!topology.adminSeparate) out.push(adminListenerMissingMessage);
  for (const a of notLocal(topology.admin)) out.push(listenerNotLocalMessage(LISTENER_VARS.admin, a.host, a.port));
  for (const a of notLocal(topology.workplace)) out.push(listenerNotLocalMessage(LISTENER_VARS.workplace, a.host, a.port));
  return out;
}

/** Refusal: `internet` and MEMORY_PUBLIC_URL is not https. */
export const publicUrlNotHttpsMessage =
  `The deploy profile "internet" requires MEMORY_PUBLIC_URL to start with https:// (the reverse proxy terminates TLS). `
  + `A server on a closed network served over plain HTTP may use MEMORY_DEPLOY_PROFILE=internal-http instead.`;

/** Refusal: `internet` and the host of MEMORY_PUBLIC_URL is an IP address or localhost. */
export const publicUrlNoHostNameMessage =
  `The deploy profile "internet" requires MEMORY_PUBLIC_URL to use a DNS name with at least one dot, made of letters, digits `
  + `and hyphens (for example https://memory.example.com) — not an IP address, localhost or a name without a dot: the name is `
  + `what marks requests from the internet as external.`;

/** Refusal: `internet`, MEMORY_PUBLIC_URL is set and MEMORY_TRUSTED_PROXIES is not. */
export const trustedProxiesMissingMessage =
  `The deploy profile "internet" with MEMORY_PUBLIC_URL requires MEMORY_TRUSTED_PROXIES: the address of the reverse proxy as the gateway sees it `
  + `(CIDR, for example 192.0.2.10/32: the address of a proxy container, or the gateway of the Docker network for a proxy on the host). `
  + `Without it the gateway cannot tell the clients behind the proxy apart. A server on a closed network may use MEMORY_DEPLOY_PROFILE=internal-http instead.`;

/** Every reason this process must not start with this public address and these trusted proxies; empty — it may start. */
export function publicAddressRefusals(profile: DeployProfile, address: PublicAddress): string[] {
  const out = [...address.problems];
  if (profile !== "internet" || address.url === null) return out;
  if (!address.https) out.push(publicUrlNotHttpsMessage);
  if (address.host === null) out.push(publicUrlNoHostNameMessage);
  if (address.proxies.length === 0) out.push(trustedProxiesMissingMessage);
  return out;
}

/**
 * Entries of a stored access.internal_networks that reach beyond loopback: in `internet` index.ts warns
 * `internal_networks_wider_than_loopback` with their number — a deliberate choice of an administrator (or the list of an
 * upgraded database), so not a refusal. Not a list, or unset — 0.
 */
export function internalNetworksBeyondLoopback(stored: unknown): number {
  if (!Array.isArray(stored)) return 0;
  return stored.filter((e) => {
    const net = parseCidr(typeof e === "string" ? e.trim() : e);
    if (!net) return false;                                  // skipped by the channel as well (channel_bad_cidr)
    return !INTERNAL_NETWORKS_LOOPBACK.some((l) => { const n = parseCidr(l)!; return n.family === net.family && net.bits >= n.bits && cidrContains(l, net.addr); });
  }).length;
}
