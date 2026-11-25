// Settings of connectors to external systems (keys integrations.* of 04-seed.sql): the value checks of
// Settings.validate. A typo must neither open a network or a directory to connectors nor switch a pack on that the build
// does not have, and a number outside its range must not silently remove a limit.
import { posix } from "node:path";
import { isIPv4 } from "node:net";
import { oidcAddressKind, privateNetworkProblem } from "./oidc.ts";

export const CONNECTOR_PRIVATE_NETWORKS_SETTING = "integrations.connectors_private_networks";
export const CONNECTOR_FOLDER_ROOTS_SETTING = "integrations.connectors_folder_roots";
export const CONNECTOR_PACKS_SETTING = "integrations.connectors_packs";

/** Whole-number ranges of the numeric keys (inclusive). */
export const CONNECTOR_SETTING_RANGES: Readonly<Record<string, readonly [number, number]>> = {
  "integrations.webhooks_max_body_mb": [1, 32],
  "integrations.webhooks_tolerance_sec": [60, 900],
  "integrations.connectors_daily_items": [1, 100_000],
  "integrations.connectors_daily_mb": [1, 102_400],
  "integrations.connectors_max_failures": [1, 100],
  "integrations.connectors_sync_concurrency": [1, 8],
};

/**
 * Directories a folder connector may never read, nor anything under them. /var/run and /var/lock are links to /run and
 * /run/lock on the usual images (Debian, Alpine): the same directories in another spelling. A setting cannot see other
 * links — the folder connector resolves each root (realpath) and applies this list to the resolved path as well.
 */
export const CONNECTOR_FORBIDDEN_ROOTS: readonly string[] = ["/proc", "/sys", "/dev", "/etc", "/run", "/var/run", "/var/lock"];
const MAX_LIST = 64;
const PACK_ID = /^[a-z][a-z0-9_]{1,31}$/;
// control characters, line and paragraph separators, bidirectional overrides, isolates and marks, zero-width characters and
// the byte order mark: each changes how a path is shown without changing what is read
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/;
const UNSAFE_ALL = new RegExp(UNSAFE_CHARS.source, "g");

/**
 * Packs (optional presets) this build has. The connector registry of the build names them at start-up
 * (registerConnectorPacks); until then no pack is known, and integrations.connectors_packs accepts only the empty list.
 */
const knownPacks = new Set<string>();
export function registerConnectorPacks(ids: Iterable<string>): void {
  for (const id of ids) if (PACK_ID.test(id)) knownPacks.add(id);
}
export const knownConnectorPacks = (): readonly string[] => [...knownPacks].sort();

const shown = (v: unknown): string => {
  const s = typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
  return `"${s.replace(UNSAFE_ALL, "?").slice(0, 60)}${s.length > 60 ? "…" : ""}"`;
};

function listProblems(value: unknown, entry: (s: string) => string | null): string[] {
  if (!Array.isArray(value)) return ["a list is expected"];
  if (value.length > MAX_LIST) return [`at most ${MAX_LIST} entries`];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of value) {
    if (typeof v !== "string") { out.push(`${shown(v)} is not a string`); continue; }
    if (seen.has(v)) { out.push(`${shown(v)} is listed twice`); continue; }
    seen.add(v);
    const why = entry(v);
    if (why) out.push(why);
  }
  return out;
}

/** One entry of integrations.connectors_private_networks: an address or a CIDR inside the private ranges; null — fits. */
export function connectorNetworkProblem(entry: string): string | null {
  const [addr, prefix] = entry.split("/", 2);
  if (addr && oidcAddressKind(addr) === "metadata" && (prefix === undefined || prefix === (isIPv4(addr) ? "32" : "128")))
    return `${shown(entry)} is a cloud metadata address: connectors never reach it, so the entry would have no effect`;
  if (privateNetworkProblem(entry) === null) return null;
  return `${shown(entry)} is not an address or a CIDR inside a private range (RFC 1918, 100.64.0.0/10 or fc00::/7): public addresses need no entry, other kinds are never reachable`;
}

/** One entry of integrations.connectors_folder_roots: an absolute normalised directory outside the system ones; null — fits. */
export function connectorFolderRootProblem(entry: string): string | null {
  if (UNSAFE_CHARS.test(entry)) return `${shown(entry)} holds a control or direction character`;
  if (entry.length > 1024) return `${shown(entry)} is longer than 1024 characters`;
  if (!entry.startsWith("/")) return `${shown(entry)} is not an absolute path`;
  if (entry.split("/").some((part) => part === ".." || part === ".")) return `${shown(entry)} holds "." or ".." — write the directory itself`;
  if (entry === "/") return `"/" would open the whole file system`;
  if (posix.normalize(entry) !== entry || entry.endsWith("/")) return `${shown(entry)} is not normalised — write it as ${shown(posix.normalize(entry).replace(/\/+$/, "") || "/")}`;
  const system = CONNECTOR_FORBIDDEN_ROOTS.find((root) => entry === root || entry.startsWith(`${root}/`));
  if (system) return `${shown(entry)} is a system directory (${system}) — a folder connector never reads ${CONNECTOR_FORBIDDEN_ROOTS.join(", ")}`;
  return null;
}

/** One entry of integrations.connectors_packs: the id of a pack this build has; null — fits. */
export function connectorPackProblem(entry: string): string | null {
  if (!PACK_ID.test(entry)) return `${shown(entry)} is not a pack id (lowercase letters, digits and _, 2–32 characters)`;
  if (!knownPacks.has(entry)) {
    const known = knownConnectorPacks();
    return `${shown(entry)} is not a pack of this build (${known.length ? `known: ${known.join(", ")}` : "this build has no packs"})`;
  }
  return null;
}

/** Problems of a value of a connector key (empty — fits, or the key is not a connector key). null resets to the default. */
export function connectorSettingProblems(path: string, value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (path === CONNECTOR_PRIVATE_NETWORKS_SETTING) return listProblems(value, connectorNetworkProblem);
  if (path === CONNECTOR_FOLDER_ROOTS_SETTING) return listProblems(value, connectorFolderRootProblem);
  if (path === CONNECTOR_PACKS_SETTING) return listProblems(value, connectorPackProblem);
  const range = Object.hasOwn(CONNECTOR_SETTING_RANGES, path) ? CONNECTOR_SETTING_RANGES[path] : undefined;
  if (range && !(typeof value === "number" && Number.isInteger(value) && value >= range[0] && value <= range[1]))
    return [`a whole number from ${range[0]} to ${range[1]} is expected`];
  return [];
}
