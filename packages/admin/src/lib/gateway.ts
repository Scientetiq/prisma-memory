import { GATEWAY_TEXT } from "../messages/gateway";
import "server-only";
import { unstable_rethrow } from "next/navigation";
import { connection } from "next/server";
import { headers as requestHeaders } from "next/headers";
import { currentLocale } from "../i18n/runtime";
import { parseFirstRun, type FirstRunInfo, type FirstRunStatus } from "./first-run";
import { gatewayBase, gatewayFetch, planeOfPath } from "./gateway-transport";
import type { Health } from "./types";
import { clientHeaders } from "./workplace-login";

export class GatewayError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown, readonly hint?: string) {
    super(message);
    this.name = "GatewayError";
  }
}

export type Query = Record<string, string | number | boolean | null | undefined>;
export interface CallInit { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown; query?: Query; token?: string | null; timeoutMs?: number; headers?: Record<string, string>;
  /** A ready body with its own type instead of JSON (a new document version goes to REST as multipart/form-data). */
  raw?: { bytes: Uint8Array<ArrayBuffer>; contentType: string } }

export interface CallResult { status: number; data: unknown; retryAfter?: number }

export async function call(path: string, init: CallInit = {}): Promise<CallResult> {
  await connection();
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(init.query ?? {})) {
    if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  }
  const qs = q.toString();
  const target = qs ? `${path}${path.includes("?") ? "&" : "?"}${qs}` : path;
  const plane = planeOfPath(path, undefined, init.token?.startsWith("mem_as_") === true);
  let base;
  try { base = gatewayBase(plane); } catch (e) { throw new GatewayError(404, "not_found", (e as Error).message); }
  // the interface language of this request (always exactly "en" or "ru"): the gateway answers its texts in it
  const headers: Record<string, string> = { ...(await adminClientHeaders(plane, init)), ...init.headers, Accept: "application/json", "Accept-Language": currentLocale() };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.raw) headers["Content-Type"] = init.raw.contentType;
  if (init.token) headers.Authorization = `Bearer ${init.token}`;

  let res: Response;
  try {
    res = await gatewayFetch(base, target, {
      method: init.method ?? "GET",
      headers,
      body: init.raw ? init.raw.bytes : init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
    });
  } catch (e) {
    unstable_rethrow(e);
    throw new GatewayError(502, "gateway_unreachable", GATEWAY_TEXT.unreachable);
  }
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    unstable_rethrow(e);
    throw new GatewayError(502, "response_lost", GATEWAY_TEXT.responseLost);
  }
  let data: unknown = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  const ra = Number(res.headers.get("retry-after")?.trim() || undefined);
  return { status: res.status, data, ...(Number.isFinite(ra) && ra >= 0 ? { retryAfter: ra } : {}) };
}

async function adminClientHeaders(plane: "admin" | "workplace", init: CallInit): Promise<Record<string, string>> {
  if (plane !== "admin" || !init.token?.startsWith("mem_as_")) return {};
  try { return clientHeaders(await requestHeaders()); } catch { return {}; }
}

export function toGatewayError(status: number, data: unknown): GatewayError {
  const b = (data ?? {}) as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  const code = typeof b.code === "string" ? b.code : `http_${status}`;
  const message = typeof b.message === "string" && b.message ? b.message : GATEWAY_TEXT.httpError(status);
  return new GatewayError(status, code, message, b.details, typeof b.hint === "string" && b.hint ? b.hint : undefined);
}

export type { FirstRunStatus } from "./first-run";

/** The browser's address headers (clientHeaders) of the page request being rendered; outside a request — none. */
async function browserHeaders(): Promise<Record<string, string>> {
  try { return clientHeaders(await requestHeaders()); } catch { return {}; }
}

export async function firstRunInfo(): Promise<FirstRunInfo> {
  try {
    const { status, data } = await call("/api/v1/first-run", { timeoutMs: 10_000, headers: await browserHeaders() });
    return parseFirstRun(status, data);
  } catch (e) {
    unstable_rethrow(e);
    return { status: "unreachable", codeRequired: false };
  }
}

export async function firstRunStatus(): Promise<FirstRunStatus> {
  return (await firstRunInfo()).status;
}

export async function firstRunNeeded(): Promise<boolean> {
  return (await firstRunStatus()) === "needed";
}

export type HealthView = (Health & { reachable: true }) | { reachable: false; message: string };

export async function getHealth(token?: string | null): Promise<HealthView> {
  try {
    const { data } = await call("/api/v1/health", { timeoutMs: 10_000, token: token ?? null });
    const h = data as Partial<Health> | null;
    if (h && typeof h.status === "string") return { ...h, status: h.status as Health["status"], checks: h.checks && typeof h.checks === "object" ? h.checks : {}, reachable: true };
    return { reachable: false, message: GATEWAY_TEXT.healthUnexpected };
  } catch (e) {
    unstable_rethrow(e);
    return { reachable: false, message: e instanceof GatewayError ? e.message : GATEWAY_TEXT.healthUnreachable };
  }
}
