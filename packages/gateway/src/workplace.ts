// The workplace server (access.workplace_peers): addresses, CIDR and host names (in a Docker installation the workplace is the container
// admin, its address from the compose network DNS). The gateway accepts a workplace
// session only from here (auth.ts), and "people only" actions — open a class, restore from the trash, delete forever,
// issue and revoke a key — only by a session. The address is the socket's (caller.ip; X-Forwarded-For — from a trusted proxy).
import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { log, MemoryError } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { currentListener, processTopology } from "./admin-plane/listeners.ts";

/** The workplace on its own socket (MEMORY_WORKPLACE_LISTEN). A layout error — the gateway start has already failed. */
const workplaceSeparate = (): boolean => { try { return processTopology().workplaceSeparate; } catch { return false; } };

const DEFAULT_PEERS = ["127.0.0.1/32", "::1/128"];
const HOST_TTL_MS = 60_000;
const hosts = new Map<string, { at: number; ips: string[] }>();

async function resolveHost(host: string): Promise<string[]> {
  const hit = hosts.get(host);
  if (hit && Date.now() - hit.at < HOST_TTL_MS) return hit.ips;
  const ips = await lookup(host, { all: true }).then((xs) => xs.map((x) => x.address), () => [] as string[]);
  if (hosts.size > 100) hosts.clear();
  hosts.set(host, { at: Date.now(), ips });
  return ips;
}

const family = (ip: string): "ipv4" | "ipv6" => (isIP(ip) === 6 ? "ipv6" : "ipv4");

/**
 * The request came from the workplace server (access.workplace_peers). An unreadable list element is skipped with
 * a warning. Listeners: a request on the workplace socket and on the unix socket of the admin listener (its
 * client is the panel, admitted by the OS) — always "from the workplace server"; an admin listener on TCP (a test installation, a setup
 * error) — only from an address in access.workplace_peers; with a separate workplace
 * (MEMORY_WORKPLACE_LISTEN) the main listener — never, even from an address in access.workplace_peers. In legacy — by
 * address, as before.
 */
export async function fromWorkplace(app: App, ip: string | null): Promise<boolean> {
  const l = currentListener();
  if (l?.kind === "workplace" || (l?.kind === "admin" && l.unix)) return true;
  if (l?.kind !== "admin" && workplaceSeparate()) return false;
  if (!ip || !isIP(ip)) return false;
  const peers = app.settings.get<unknown>("access.workplace_peers", DEFAULT_PEERS);
  const list = new BlockList();
  for (const raw of Array.isArray(peers) ? peers : []) {
    const p = String(raw ?? "").trim();
    if (!p) continue;
    const [addr = "", bits] = p.split("/");
    try {
      if (!isIP(addr)) { for (const a of await resolveHost(p)) list.addAddress(a, family(a)); continue; }
      if (bits === undefined) list.addAddress(addr, family(addr));
      else list.addSubnet(addr, Number(bits), family(addr));
    } catch {
      log.warn("workplace_peer_invalid", { peer: p.slice(0, 80) });
    }
  }
  return list.check(ip, family(ip));
}

/** The workplace section address for links in answers to agents (access.workplace_url); empty — null. */
export function workplaceUrl(app: App, path = ""): string | null {
  const base = String(app.settings.get<string>("access.workplace_url", "") ?? "").trim().replace(/\/+$/, "");
  return base ? `${base}${path}` : null;
}

/** Where the person will do it: a link to the section if the workplace address is set, otherwise the section name. */
export function workplaceWhere(app: App, path: string, section: string): string {
  const url = workplaceUrl(app, path);
  return url ?? `in the workspace, under “${section}”`;
}

/**
 * A "people only" action (open a class, restore, delete forever, issue and revoke a key): a workplace
 * session — not a key, not "on behalf of", not a panel preview. The address was already checked on accepting the session
 * (auth.ts): a key from the workplace address does not become a person. Otherwise forbidden with a link to the needed section —
 * the agent passes it to the person.
 */
/** A person in the workplace: a session, not a key, not "on behalf of", not a panel preview (the requireHuman condition). */
export const isHumanSession = (caller: Pick<Caller, "keyKind" | "principalType" | "person" | "onBehalfOf" | "preview">): boolean =>
  caller.keyKind === "session" && caller.principalType === "person" && !!caller.person && !caller.onBehalfOf && !caller.preview;

export async function requireHuman(app: App, caller: Caller, what: string, where: { path: string; section: string } = { path: "/trash", section: "Trash" }): Promise<void> {
  if (isHumanSession(caller)) return;
  throw new MemoryError("forbidden", `Only a person can perform this action in the workspace: ${what}. Workspace: ${workplaceWhere(app, where.path, where.section)}`,
    { hint: "Send the person the workspace link" });
}
