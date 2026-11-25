import { AsyncLocalStorage } from "node:async_hooks";
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import { dirname } from "node:path";
import { createAdaptorServer } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { log } from "@memory/shared";

export type ListenerKind = "main" | "admin" | "workplace" | "cli";
export type ListenAddr = { type: "unix"; path: string } | { type: "tcp"; host: string; port: number };

export class ListenerConfigError extends Error {
  readonly code = "listener_config_invalid";
}

export const LISTENER_VARS = { admin: "MEMORY_ADMIN_LISTEN", workplace: "MEMORY_WORKPLACE_LISTEN", cli: "MEMORY_CLI_LISTEN" } as const;

export function parseListen(raw: string | undefined | null, name = "MEMORY_*_LISTEN"): ListenAddr[] {
  const text = (raw ?? "").trim();
  if (!text) return [];
  const out: ListenAddr[] = [];
  for (const part of text.split(",").map((s) => s.trim())) {
    if (!part) throw new ListenerConfigError(`${name}: empty list element`);
    if (part.startsWith("unix:")) {
      const path = part.slice(5);
      if (!path.startsWith("/") || path.length > 100 || /[\0\s]/.test(path) || path.split("/").includes(".."))
        throw new ListenerConfigError(`${name}: a Unix socket must have an absolute path without “..” or spaces, up to 100 characters`);
      out.push({ type: "unix", path });
      continue;
    }
    if (part.startsWith("tcp:")) {
      const m = /^tcp:(?:\[([0-9a-fA-F:.]+)\]|([^:\[\]]+)):(\d{1,5})$/.exec(part);
      const port = m ? Number(m[3]) : NaN;
      if (!m || !(port >= 1 && port <= 65535)) throw new ListenerConfigError(`${name}: expected tcp:<address>:<port> (port 1–65535)`);
      out.push({ type: "tcp", host: m[1] ?? m[2]!, port });
      continue;
    }
    throw new ListenerConfigError(`${name}: “${part.slice(0, 40)}” must be unix:<path> or tcp:<address>:<port>`);
  }
  const keys = out.map((a) => (a.type === "unix" ? `unix:${a.path}` : `tcp:${a.host}:${a.port}`));
  if (new Set(keys).size !== keys.length) throw new ListenerConfigError(`${name}: an address appears twice`);
  return out;
}

export interface ListenerTopology {
  admin: ListenAddr[];
  workplace: ListenAddr[];
  cli: ListenAddr[];
  adminSeparate: boolean;
  workplaceSeparate: boolean;
}

export function listenerTopology(env: Record<string, string | undefined> = process.env): ListenerTopology {
  const admin = parseListen(env.MEMORY_ADMIN_LISTEN, LISTENER_VARS.admin);
  const workplace = parseListen(env.MEMORY_WORKPLACE_LISTEN, LISTENER_VARS.workplace);
  const cli = parseListen(env.MEMORY_CLI_LISTEN, LISTENER_VARS.cli);
  const all = [...admin, ...workplace, ...cli].map((a) => (a.type === "unix" ? `unix:${a.path}` : `tcp:${a.port}`));
  if (new Set(all).size !== all.length) throw new ListenerConfigError("two listeners share an address or port");
  if (cli.some((a) => a.type !== "unix")) throw new ListenerConfigError(`${LISTENER_VARS.cli}: the command line requires a Unix socket`);
  return { admin, workplace, cli, adminSeparate: admin.length > 0, workplaceSeparate: workplace.length > 0 };
}

let topologyCache: ListenerTopology | null = null;
export function processTopology(): ListenerTopology {
  return (topologyCache ??= listenerTopology());
}
export function resetTopologyForTests(t: ListenerTopology | null = null): void {
  topologyCache = t;
}

export interface ListenerContext {
  kind: ListenerKind;
  unix: boolean;
}
const listenerStore = new AsyncLocalStorage<ListenerContext>();

export const currentListener = (): ListenerContext | undefined => listenerStore.getStore();

export function withListener<T>(ctx: ListenerContext, fn: () => T): T {
  return listenerStore.run(ctx, fn);
}

type FetchFn = (req: Request, env?: any, ctx?: any) => Response | Promise<Response>;
export interface ListenerApps { main: { fetch: FetchFn }; admin?: { fetch: FetchFn }; workplace?: { fetch: FetchFn }; cli?: { fetch: FetchFn } }
export type AdaptorOptions = Parameters<typeof createAdaptorServer>[0];
export interface StartOptions {
  port: number;
  hostname?: string;
  topology?: ListenerTopology;
  wrap?: (kind: ListenerKind, addr: ListenAddr, options: AdaptorOptions) => AdaptorOptions;
}
export interface RunningListener { kind: ListenerKind; addr: ListenAddr; server: ServerType }
export interface Listeners { listeners: RunningListener[]; close: () => Promise<void> }

export function socketAlive(path: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(path);
    const done = (alive: boolean) => { s.removeAllListeners(); s.destroy(); resolve(alive); };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.setTimeout(timeoutMs, () => done(false));
  });
}

export async function prepareSocketPath(path: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
  let st;
  try { st = lstatSync(path); } catch { return; }
  if (!st.isSocket()) throw new ListenerConfigError(`${path}: this path is not a socket. The gateway will leave it in place`);
  if (await socketAlive(path)) throw new ListenerConfigError(`${path}: another process is using the socket`);
  unlinkSync(path);
}

function listenOn(server: ServerType, addr: ListenAddr): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => reject(e);
    server.once("error", onError);
    const ok = () => { server.off("error", onError); resolve(); };
    if (addr.type === "unix") server.listen(addr.path, ok);
    else server.listen(addr.port, addr.host, ok);
  });
}

export async function startListeners(apps: ListenerApps, o: StartOptions): Promise<Listeners> {
  const t = o.topology ?? processTopology();
  const plan: Array<{ kind: ListenerKind; addr: ListenAddr; app: { fetch: FetchFn } }> = [
    { kind: "main", addr: { type: "tcp", host: o.hostname ?? "0.0.0.0", port: o.port }, app: apps.main },
  ];
  for (const kind of ["admin", "workplace", "cli"] as const) {
    const app = apps[kind];
    if (!t[kind].length) continue;
    if (!app) throw new ListenerConfigError(`${LISTENER_VARS[kind]} is set, but the listener has no application`);
    for (const addr of t[kind]) plan.push({ kind, addr, app });
  }
  const running: RunningListener[] = [];
  const close = async (): Promise<void> => {
    await Promise.all(running.map((l) => new Promise<void>((resolve) => {
      l.server.close(() => resolve());
      (l.server as unknown as { closeIdleConnections?: () => void }).closeIdleConnections?.();
    })));
    for (const l of running) if (l.addr.type === "unix") { try { unlinkSync(l.addr.path); } catch { } }
  };
  try {
    for (const p of plan) {
      const unix = p.addr.type === "unix";
      const ctx: ListenerContext = { kind: p.kind, unix };
      const fetch: FetchFn = (req, env, ec) => withListener(ctx, () => p.app.fetch(req, env, ec));
      const base: AdaptorOptions = { fetch: fetch as AdaptorOptions["fetch"] };
      const server = createAdaptorServer(o.wrap ? o.wrap(p.kind, p.addr, base) : base);
      if (p.addr.type === "unix") await prepareSocketPath(p.addr.path);
      await listenOn(server, p.addr);
      running.push({ kind: p.kind, addr: p.addr, server });
      if (p.addr.type === "unix") chmodSync(p.addr.path, 0o660);
      log.info("listener_started", { kind: p.kind, ...(p.addr.type === "unix" ? { unix: p.addr.path } : { host: p.addr.host, port: p.addr.port }) });
    }
  } catch (e) {
    await close();
    throw e;
  }
  return { listeners: running, close };
}
