import { existsSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";

export const AUTHCHECK_SOCKET = "/run/memory-authcheck/api.sock";
export const AUTHCHECK_TIMEOUT_MS = 5_000;
const REPLY_MAX = 64 * 1024;

export type AuthcheckClosedReason = "threshold_unknown" | "window_unknown" | "pdc_unset" | "pdc_unreachable" | "counter_unreadable" | "pso_unreadable"
  | "tls_none" | "no_keys" | "anchors_invalid" | "login_disabled" | "settings_invalid" | "groups_unreadable" | "pdc_not_emulator";

export interface AuthcheckStatus {
  ok: boolean;
  closed_reason?: string;
  kids: number[];
  anchors_serial: number | null;
  pause_until?: string;
  last_sweep_at?: string;
  sweep_ok: boolean;
  version: string;
  [k: string]: unknown;
}

export interface AuthcheckPreflight {
  allowed: boolean;
  reasons: string[];
  needs_factor: boolean;
  ad: { in_group: boolean; denied: boolean; admin_count: boolean; enabled: boolean; locked: boolean };
}

export class AuthcheckUnavailable extends Error {
  constructor(readonly why: string) { super(`memory-authcheck is unavailable: ${why}`); }
}

let socketOverride: string | null = null;
export function setAuthcheckSocketForTests(path: string | null): void { socketOverride = path; }

export function authcheckSocketPath(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string {
  if (socketOverride) return socketOverride;
  if (exists(AUTHCHECK_SOCKET)) return AUTHCHECK_SOCKET;
  const xdg = env.XDG_RUNTIME_DIR?.trim();
  const user = xdg ? join(xdg, "memory-authcheck", "api.sock") : null;
  return user && exists(user) ? user : AUTHCHECK_SOCKET;
}

export function authcheckCall(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = AUTHCHECK_TIMEOUT_MS): Promise<{ status: number; body: unknown }> {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (e: AuthcheckUnavailable | null, v?: { status: number; body: unknown }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (e) reject(e); else resolve(v!);
    };
    const req = request({ socketPath: authcheckSocketPath(), method, path, host: "authcheck.invalid",
                          headers: { accept: "application/json", ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (b: Buffer) => {
        size += b.length;
        if (size > REPLY_MAX) { req.destroy(); finish(new AuthcheckUnavailable("response exceeds the size limit")); return; }
        chunks.push(b);
      });
      res.on("end", () => {
        try { finish(null, { status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") }); }
        catch { finish(new AuthcheckUnavailable("response is not JSON")); }
      });
      res.on("error", (e) => finish(new AuthcheckUnavailable((e as NodeJS.ErrnoException).code ?? "could not read the response")));
    });
    const timer = setTimeout(() => { req.destroy(); finish(new AuthcheckUnavailable("timeout")); }, timeoutMs);
    req.on("error", (e) => finish(new AuthcheckUnavailable((e as NodeJS.ErrnoException).code ?? "connection failure")));
    if (payload) req.write(payload);
    req.end();
  });
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export async function authcheckStatus(): Promise<AuthcheckStatus> {
  const r = await authcheckCall("GET", "/v1/status");
  const b = r.body;
  if (r.status !== 200 || !isObj(b) || typeof b.ok !== "boolean" || typeof b.sweep_ok !== "boolean" || !Array.isArray(b.kids))
    throw new AuthcheckUnavailable(`status violates the contract (${r.status})`);
  return b as AuthcheckStatus;
}

export async function authcheckPreflight(personId: string): Promise<AuthcheckPreflight> {
  const r = await authcheckCall("POST", "/v1/optin/preflight", { person_id: personId });
  if (r.status === 404) return { allowed: false, reasons: ["person_inactive"], needs_factor: false, ad: { in_group: false, denied: false, admin_count: false, enabled: false, locked: false } };
  const b = r.body;
  if (r.status !== 200 || !isObj(b) || typeof b.allowed !== "boolean" || !Array.isArray(b.reasons) || typeof b.needs_factor !== "boolean" || !isObj(b.ad))
    throw new AuthcheckUnavailable(`decision violates the contract (${r.status})`);
  return { allowed: b.allowed, reasons: (b.reasons as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 12),
           needs_factor: b.needs_factor, ad: b.ad as AuthcheckPreflight["ad"] };
}

export function statusClosed(s: Pick<AuthcheckStatus, "ok" | "closed_reason">): string | null {
  if (s.ok) return null;
  return typeof s.closed_reason === "string" && s.closed_reason ? s.closed_reason : "closed";
}

export const CLOSED_REASON_TEXT: Readonly<Record<string, string>> = {
  threshold_unknown: "AD lockout threshold is unset (edge.ad_lockout_threshold). Passwords for sign-in from outside are not checked",
  window_unknown: "AD failed password counter window is unset (edge.ad_lockout_window_min)",
  pdc_unset: "primary domain controller is unset (edge.ad_pdc)",
  pdc_unreachable: "the primary domain controller is not responding",
  counter_unreadable: "the directory’s incorrect password counter cannot be read",
  pso_unreadable: "could not read the password policy (PSO) from the directory",
  tls_none: "there is no secure connection to the directory",
  no_keys: "sign-in check service is missing request keys or edge signing keys",
  anchors_invalid: "edge anchors failed validation",
  login_disabled: "sign-in from outside is off (edge.login_enabled)",
  settings_invalid: "sign-in check service settings are corrupt",
  groups_unreadable: "sign-in and deny groups cannot be read from the directory",
  pdc_not_emulator: "edge.ad_pdc is missing from ldap.servers, is not the PDC emulator, or its role cannot be read",
  closed: "the sign-in check service is blocked for a reason unknown to the gateway",
};
export const closedReasonText = (code: string): string => CLOSED_REASON_TEXT[code] ?? CLOSED_REASON_TEXT.closed!;

export type AuthcheckFactorPath = "/v1/factor/status" | "/v1/factor/enroll/start" | "/v1/factor/replace/start" | "/v1/factor/enroll/confirm"
  | "/v1/recovery/issue" | "/v1/factor/reset";

export interface AuthcheckFactorAnswer { status: number; body: Record<string, unknown> }

export async function authcheckFactor(path: AuthcheckFactorPath, body: Record<string, unknown>): Promise<AuthcheckFactorAnswer> {
  const r = await authcheckCall("POST", path, body);
  if (!isObj(r.body)) throw new AuthcheckUnavailable(`second-factor response violates the contract (${r.status})`);
  return { status: r.status, body: r.body };
}
