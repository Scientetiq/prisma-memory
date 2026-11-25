// Instance values of this panel process (interface language, time zone, product name), read from the gateway before
// anyone signs in: the `locale` object of the public "methods" answer of the listener this process may reach —
// role panel asks the admin listener (GET /api/v1/admin-auth/methods), roles workplace and all ask the workplace one
// (GET /api/v1/auth/methods). An older gateway without the object gives English and UTC.
//
// register() of src/instrumentation.ts makes the first read (at most 3 s) before the first request. After that there is
// no timer: the runtime asks the reader on globalThis[READER_KEY] to refresh when it reads the values (maybeRefresh),
// and a value older than 30 s (5 s while the gateway has not answered yet) starts one background read, outside the
// request that noticed it. Errors keep the last values and are logged at most once a minute. The settings page refreshes
// at once after a change in category "locale" (refreshInstanceNow). Server only; the state lives on globalThis because
// Next evaluates this module once per bundle (instrumentation, server components).
import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { gatewayBase, gatewayFetch, type GatewayBase, type Plane, type TransportInit } from "../lib/gateway-transport";
import { webRole, type WebRole } from "../lib/web-role";
import { setInstance } from "./runtime";

/** globalThis key of the reader of this process (the runtime calls its maybeRefresh). */
export const READER_KEY = "__memoryInstanceReader";
/** globalThis key of the "request scope missing" mark (the message is logged once per process). */
const SCOPE_MISSING_KEY = "__memoryRequestScopeMissingLogged";

export const FIRST_READ_MS = 3_000;
export const READ_TIMEOUT_MS = 3_000;
export const STALE_MS = 30_000;
export const UNKNOWN_STALE_MS = 5_000;
export const LOG_EVERY_MS = 60_000;

/** Values of the `locale` object as the runtime stores them (setInstance validates them once more). */
export interface LocaleBlock { language: unknown; timezone: unknown; productName: unknown }

/** The `locale` object of a "methods" answer; anything missing or malformed is null. */
export function localeBlockOf(data: unknown): LocaleBlock {
  const block = typeof data === "object" && data !== null ? (data as { locale?: unknown }).locale : undefined;
  if (typeof block !== "object" || block === null || Array.isArray(block)) return { language: null, timezone: null, productName: null };
  const b = block as { language?: unknown; timezone?: unknown; product_name?: unknown };
  return { language: b.language ?? null, timezone: b.timezone ?? null, productName: b.product_name ?? null };
}

/** Which listener and path tell this process its instance values. */
export function methodsSource(role: WebRole): { plane: Plane; path: string } {
  return role === "panel" ? { plane: "admin", path: "/api/v1/admin-auth/methods" } : { plane: "workplace", path: "/api/v1/auth/methods" };
}

export type LogLine = (level: "info" | "warn", code: string, fields?: Record<string, unknown>) => void;

/** One JSON line on stdout, the format of server.mjs. */
export const logLine: LogLine = (level, code, fields = {}) => {
  try {
    process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), level, process: "memory-admin", code, ...fields })}\n`);
  } catch {
    // stdout closed: nothing to do
  }
};

export interface ReaderDeps {
  env?: Record<string, string | undefined>;
  fetch?: (base: GatewayBase, path: string, init: TransportInit) => Promise<Response>;
  now?: () => number;
  log?: LogLine;
  /** Where the values go (default: the runtime's setInstance). */
  store?: (v: LocaleBlock) => void;
  /** How long the start waits for the first read (default FIRST_READ_MS). */
  firstReadMs?: number;
  /** How long one read may take before it is given up (default READ_TIMEOUT_MS). */
  readTimeoutMs?: number;
}

export interface InstanceReader {
  /**
   * One read now, or the read already in flight; true if the gateway answered. Never rejects. `fresh`: the answer must
   * come from a read that starts after this call (a read in flight may predate a saved change): wait for it, then read.
   * Still one read at a time; fresh calls made during one read share the read that follows it.
   */
  refresh(fresh?: boolean): Promise<boolean>;
  /** Starts one background read if the values are stale and none is in flight. Synchronous, never throws. */
  maybeRefresh(): void;
  /** Whether the gateway has answered at least once. */
  readonly known: boolean;
}

function reasonOf(e: unknown): string {
  if (typeof e === "object" && e !== null) {
    const x = e as { name?: unknown; code?: unknown; cause?: { code?: unknown } };
    // the first string of these: a DOMException (an aborted or timed-out read) has a numeric code and a name
    for (const code of [x.cause?.code, x.code, x.name]) {
      if (typeof code === "string") return /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : "error";
    }
  }
  return "error";
}

/**
 * A reader of the instance values. Background reads run in the context the reader was created in (the start of the
 * process), not in the request that noticed the stale value: the read is not part of any page and sees no request data.
 */
export function createInstanceReader(deps: ReaderDeps = {}): InstanceReader {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetch ?? gatewayFetch;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? logLine;
  const store = deps.store ?? ((v: LocaleBlock) => setInstance(v));
  const readTimeoutMs = deps.readTimeoutMs ?? READ_TIMEOUT_MS;
  const outside = AsyncLocalStorage.snapshot();
  let inflight: Promise<boolean> | null = null;
  let known = false;
  let readAt = Number.NEGATIVE_INFINITY;
  let loggedAt = Number.NEGATIVE_INFINITY;

  const fail = (reason: string): false => {
    const t = now();
    if (t - loggedAt >= LOG_EVERY_MS) {
      loggedAt = t;
      log("warn", "i18n_instance_unreachable", { reason });
    }
    return false;
  };

  const read = async (): Promise<boolean> => {
    let role: WebRole;
    let base: GatewayBase;
    const started = now();
    try {
      role = webRole(env.MEMORY_WEB_ROLE);
      const src = methodsSource(role);
      base = gatewayBase(src.plane, role, env);
      const res = await fetchImpl(base, src.path, { method: "GET", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(readTimeoutMs) });
      if (res.status !== 200) await res.body?.cancel().catch(() => undefined);
      if (res.status !== 200) return fail(`http_${res.status}`);
      let data: unknown;
      try {
        data = JSON.parse(await res.text());
      } catch {
        return fail("bad_json");
      }
      store(localeBlockOf(data));
      known = true;
      return true;
    } catch (e) {
      return fail(reasonOf(e));
    } finally {
      readAt = started;
    }
  };

  const join = (): Promise<boolean> => {
    if (!inflight) {
      inflight = read().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  };

  const refresh = (fresh = false): Promise<boolean> => {
    const before = inflight;
    if (!fresh || !before) return join();
    // the read in flight started before this call: let it end (it never rejects), then join the next read
    return before.then(join, join);
  };

  return {
    refresh,
    maybeRefresh(): void {
      try {
        if (inflight) return;
        if (now() - readAt < (known ? STALE_MS : UNKNOWN_STALE_MS)) return;
        outside(() => {
          void refresh();
        });
      } catch {
        // never break the render that asked
      }
    },
    get known() {
      return known;
    },
  };
}

const G = globalThis as unknown as Record<string, unknown>;

function installed(): InstanceReader | null {
  const r = G[READER_KEY] as Partial<InstanceReader> | undefined;
  return typeof r === "object" && r !== null && typeof r.refresh === "function" && typeof r.maybeRefresh === "function" ? (r as InstanceReader) : null;
}

/**
 * Start of the process (register() of instrumentation.ts): installs the reader once and makes the first read, waiting at
 * most 3 s. Without the request-scope preload module every person gets the instance language (logged once).
 */
export async function startInstanceReader(deps: ReaderDeps = {}): Promise<void> {
  const log = deps.log ?? logLine;
  try {
    const scope = G.__memoryRequestLocale as { run?: unknown } | undefined;
    if ((typeof scope !== "object" || scope === null || typeof scope.run !== "function") && !G[SCOPE_MISSING_KEY]) {
      G[SCOPE_MISSING_KEY] = true;
      log("warn", "i18n_request_scope_missing", { hint: "start the panel with NODE_OPTIONS=--import=./client-peer.mjs" });
    }
    let reader = installed();
    if (!reader) {
      reader = createInstanceReader(deps);
      G[READER_KEY] = reader;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((done) => {
      timer = setTimeout(done, deps.firstReadMs ?? FIRST_READ_MS);
      timer.unref?.();
    });
    await Promise.race([reader.refresh(), limit]);
    if (timer) clearTimeout(timer);
  } catch {
    // the panel starts anyway: English and UTC until the gateway answers
  }
}

/**
 * Reads the instance values at once (after a change in category "locale"), never taking the answer of a read that
 * started before the change; no-op if no reader is installed.
 */
export async function refreshInstanceNow(): Promise<void> {
  try {
    await installed()?.refresh(true);
  } catch {
    // keep the last values
  }
}
