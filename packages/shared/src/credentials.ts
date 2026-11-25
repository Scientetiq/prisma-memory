import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RunMode } from "./enums.gen.ts";

export const GATEWAY_DATA_DIR = "/var/lib/memory/state";
export const SYSTEMD_CREDENTIALS_PREFIX = "/run/credentials/";

export function credentialsDir(): string | null {
  const dir = process.env.CREDENTIALS_DIRECTORY;
  return dir && dir.trim() ? dir : null;
}

export const CREDENTIAL_NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const validName = (name: string): boolean => CREDENTIAL_NAME.test(name) && !name.includes("..");

function checkName(name: string, what = "key name"): void {
  if (typeof name !== "string" || !validName(name)) throw new TypeError(`credentials: ${what} ${JSON.stringify(name)} must match [a-z0-9][a-z0-9._-]*`);
}

const missing = (e: unknown): boolean => ["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException)?.code ?? "");

export interface CredentialOptions {
  minBytes?: number;
}

function checkMin(o: CredentialOptions | undefined): number {
  const m = o?.minBytes ?? 1;
  if (!Number.isInteger(m) || m < 1 || m > 1 << 20) throw new TypeError("credentials: minBytes must be an integer of at least 1");
  return m;
}

export function readCredential(name: string, o?: CredentialOptions): Buffer | null {
  checkName(name);
  const min = checkMin(o);
  const dir = credentialsDir();
  if (!dir) return null;
  const path = join(dir, name);
  let b: Buffer;
  try {
    if (!statSync(path).isFile()) throw new Error(`credentials: ${name} is not a file`);
    b = readFileSync(path);
  } catch (e) {
    if (missing(e)) return null;
    throw e instanceof Error && e.message.startsWith("credentials:") ? e
      : new Error(`credentials: cannot read ${name} (${(e as NodeJS.ErrnoException)?.code ?? "error"})`);
  }
  if (b.length === 0) throw new Error(`credentials: ${name} is an empty file`);
  if (b.length < min) throw new Error(`credentials: ${name} is shorter than ${min} bytes`);
  return b;
}

export function readCredentialText(name: string, o?: CredentialOptions): string | null {
  const min = checkMin(o);
  const b = readCredential(name);
  if (b === null) return null;
  const text = b.toString("utf8").replace(/[\r\n]+$/, "");
  if (text.trim() === "") throw new Error(`credentials: ${name} is an empty file`);
  if (Buffer.byteLength(text, "utf8") < min) throw new Error(`credentials: ${name} is shorter than ${min} bytes`);
  return text;
}

export function credentialNames(): string[] {
  const dir = credentialsDir();
  if (!dir) return [];
  let names: string[];
  try { names = readdirSync(dir); } catch (e) { if (missing(e)) return []; throw new Error(`credentials: cannot read the directory (${(e as NodeJS.ErrnoException)?.code ?? "error"})`); }
  return names.filter((n) => validName(n) && (() => { try { return statSync(join(dir, n)).isFile(); } catch { return false; } })()).sort();
}

export function readCredentialSet(prefix: string, o?: CredentialOptions): Map<string, Buffer> {
  checkName(prefix, "name prefix");
  if (!prefix.endsWith("-")) throw new TypeError(`credentials: the name prefix ${JSON.stringify(prefix)} must end in “-”`);
  checkMin(o);
  const out = new Map<string, Buffer>();
  for (const n of credentialNames()) {
    if (!n.startsWith(prefix) || n.length === prefix.length) continue;
    const b = readCredential(n, o);
    if (b !== null) out.set(n.slice(prefix.length), b);
  }
  return out;
}

export function latestVersion(set: Map<string, Buffer>): string | null {
  let best: string | null = null;
  for (const v of set.keys()) {
    if (!/^[0-9]{1,15}$/.test(v)) continue;
    if (best === null || Number(v) > Number(best)) best = v;
  }
  return best;
}

export interface RunModeProbe {
  credentialsDirectory?: string | null;
  uid?: number | null;
  dataDirOwner?: (dir: string) => number | null;
  inContainer?: () => boolean;
  dockerSocket?: () => boolean;
  dataDir?: string;
}

const ownerOf = (dir: string): number | null => { try { return statSync(dir).uid; } catch { return null; } };
const CONTAINER_CGROUP = /\/(docker|containerd|kubepods|libpod|lxc)[/.-]/;

export function containerSign(): boolean {
  if (existsSync("/.dockerenv") || existsSync("/run/.containerenv")) return true;
  try {
    return CONTAINER_CGROUP.test(readFileSync("/proc/1/cgroup", "utf8"));
  } catch {
    return false;
  }
}

export function detectRunMode(o: RunModeProbe = {}): RunMode {
  const creds = o.credentialsDirectory !== undefined ? o.credentialsDirectory : credentialsDir();
  const uid = o.uid !== undefined ? o.uid : typeof process.getuid === "function" ? process.getuid() : null;
  const sysCreds = !!creds && creds.startsWith(SYSTEMD_CREDENTIALS_PREFIX);
  const notRoot = uid !== null && uid !== 0;
  if ((o.inContainer ?? containerSign)()) {
    const socket = (o.dockerSocket ?? (() => existsSync("/var/run/docker.sock")))();
    return sysCreds && notRoot && !socket ? "container" : "user";
  }
  if (sysCreds && notRoot) {
    const owner = (o.dataDirOwner ?? ownerOf)(o.dataDir ?? GATEWAY_DATA_DIR);
    if (owner !== null && owner !== uid) return "system";
  }
  return "user";
}
