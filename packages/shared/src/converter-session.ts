import { createHash } from "node:crypto";
import { log } from "./log.ts";

export const CONVERTER_SESSION_IDLE_MS = 25 * 60_000;
export const CONVERTER_SESSION_MAX_AGE_MS = 7.5 * 3600_000;
export const CONVERTER_RELOGIN_PAUSE_MS = 60_000;
export const CONVERTER_HEALTH_CACHE_MS = 30_000;
export const CONVERTER_HEALTH_TIMEOUT_MS = 10_000;

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export function converterSettingsFingerprint(c: { url?: string | null; login?: string | null; secret?: string | null }): string {
  return sha256(`${(c.url ?? "").replace(/\/+$/, "")}|${c.login ?? ""}|${sha256(c.secret ?? "")}`).slice(0, 32);
}

export function converterPrincipal(userId: unknown): string | null {
  return typeof userId === "string" && userId ? sha256(`dc-principal|${userId}`).slice(0, 16) : null;
}

export interface ConverterSessionUser { user_id?: string; username?: string; roles?: string[]; permissions?: string[] }

export interface ConverterLoginResult { jar: Map<string, string>; user: ConverterSessionUser | null }
export type ConverterLoginFn = () => Promise<ConverterLoginResult>;

export type ConverterLoginWhy = "first" | "idle" | "age" | "expired" | "forced";

export interface ConverterLoginEvent { why: ConverterLoginWhy; generation: number; principal: string | null; previous: string | null }

export class ConverterSession {
  jar = new Map<string, string>();
  generation = 0;
  loggedInAt: number | null = null;
  lastUsedAt: number | null = null;
  principal: string | null = null;
  user: ConverterSessionUser | null = null;
  private flight: Promise<void> | null = null;
  private reloginPausedUntil = 0;
  logins = 0;
  onLogin: ((e: ConverterLoginEvent) => void | Promise<void>) | null = null;

  constructor(readonly key: string, private readonly now: () => number = Date.now) {}

  get alive(): boolean { return this.loggedInAt !== null && this.jar.has("kos_session"); }

  used(): void { this.lastUsedAt = this.now(); }

  staleness(): "idle" | "age" | null {
    if (!this.alive) return null;
    const now = this.now();
    if (now - (this.loggedInAt ?? now) >= CONVERTER_SESSION_MAX_AGE_MS) return "age";
    if (now - (this.lastUsedAt ?? this.loggedInAt ?? now) >= CONVERTER_SESSION_IDLE_MS) return "idle";
    return null;
  }

  async ensure(login: ConverterLoginFn): Promise<void> {
    if (!this.alive) return this.login(login, "first");
    const why = this.staleness();
    if (!why || this.now() < this.reloginPausedUntil) return;
    try { await this.login(login, why); }
    catch (e) {
      const err = e as { status?: number; code?: string; kind?: string; retryAfterSec?: number };
      const pauseMs = Math.max(CONVERTER_RELOGIN_PAUSE_MS, (Number(err.retryAfterSec) || 0) * 1000);
      this.reloginPausedUntil = this.now() + pauseMs;
      log.warn("converter_relogin_failed", { why, status: err.status ?? null, code: err.code ?? null, kind: err.kind ?? null,
                                             retry_after_sec: err.retryAfterSec ?? null, keeps_old_session: this.alive, pause_ms: pauseMs });
    }
  }

  async renew(seenGeneration: number, login: ConverterLoginFn): Promise<void> {
    if (this.generation !== seenGeneration && this.alive) return;
    if (!this.flight) this.invalidate();
    return this.login(login, "expired");
  }

  invalidate(): void { this.jar = new Map(); this.loggedInAt = null; }

  login(login: ConverterLoginFn, why: ConverterLoginWhy): Promise<void> {
    if (this.flight) return this.flight;
    const started = this.now();
    this.flight = (async () => {
      const r = await login();
      const previous = this.principal;
      this.jar = r.jar;
      this.generation += 1;
      this.logins += 1;
      this.loggedInAt = this.lastUsedAt = this.now();
      this.reloginPausedUntil = 0;
      this.user = r.user;
      this.principal = converterPrincipal(r.user?.user_id) ?? previous;
      log.info("converter_login", { why, generation: this.generation, principal: this.principal, roles: r.user?.roles?.length ?? 0, ms: this.now() - started });
      if (this.onLogin) {
        try { await this.onLogin({ why, generation: this.generation, principal: this.principal, previous }); }
        catch (e) { log.warn("converter_login_hook_failed", { error: (e as Error).message.slice(0, 120) }); }
      }
    })().finally(() => { this.flight = null; });
    return this.flight;
  }
}

const SESSIONS = new Map<string, ConverterSession>();

export function converterSession(cfg: { url: string; login: string; secret: string }, now?: () => number): ConverterSession {
  const key = converterSettingsFingerprint(cfg);
  let s = SESSIONS.get(key);
  if (!s) {
    SESSIONS.clear();
    s = new ConverterSession(key, now);
    SESSIONS.set(key, s);
  }
  return s;
}

export function resetConverterSessions(): void { SESSIONS.clear(); HEALTH.clear(); CONTRACT.clear(); }

export interface ConverterHealth { ok: boolean; status: number | null; at: number; cached: boolean }

interface HealthSlot { value?: ConverterHealth; flight?: Promise<ConverterHealth> }
const HEALTH = new Map<string, HealthSlot>();

export async function converterHealth(cfg: { url: string; requestTimeoutMs?: number }, o: { force?: boolean; now?: () => number } = {}): Promise<ConverterHealth> {
  const now = o.now ?? Date.now;
  const url = cfg.url.replace(/\/+$/, "");
  const slot = HEALTH.get(url) ?? {};
  HEALTH.set(url, slot);
  if (!o.force && slot.value && now() - slot.value.at < CONVERTER_HEALTH_CACHE_MS) return { ...slot.value, cached: true };
  if (slot.flight) return slot.flight;
  slot.flight = (async (): Promise<ConverterHealth> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.min(CONVERTER_HEALTH_TIMEOUT_MS, Math.max(1000, cfg.requestTimeoutMs ?? CONVERTER_HEALTH_TIMEOUT_MS)));
    let value: ConverterHealth;
    try {
      const res = await fetch(`${url}/api/v1/health`, { method: "GET", headers: { accept: "application/json" }, signal: ctl.signal, redirect: "manual" });
      const text = await res.text().catch(() => "");
      let status: unknown;
      try { status = (JSON.parse(text) as { status?: unknown })?.status; } catch { status = undefined; }
      const ok = res.status >= 200 && res.status < 300 && (status === undefined || String(status).toLowerCase() === "ok");
      value = { ok, status: res.status, at: now(), cached: false };
    } catch {
      value = { ok: false, status: null, at: now(), cached: false };
    } finally { clearTimeout(timer); }
    slot.value = value;
    log.info("converter_health", { ok: value.ok, status: value.status });
    return value;
  })().finally(() => { slot.flight = undefined; });
  return slot.flight;
}

export const CONVERTER_CONTRACT_CACHE_MS = 10 * 60_000;

export interface ConverterContract { ok: boolean; status: number | null; version: string | null; fast_lane: boolean; at: number; cached: boolean }

const CONTRACT = new Map<string, { value?: ConverterContract; flight?: Promise<ConverterContract> }>();

export function parseConverterContract(json: unknown): { fast_lane: boolean; version: string | null } | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  const raw = o.paths;
  const paths: string[] = Array.isArray(raw)
    ? raw.map((p) => (typeof p === "string" ? p : p && typeof p === "object" && typeof (p as { path?: unknown }).path === "string" ? (p as { path: string }).path : "")).filter(Boolean)
    : raw && typeof raw === "object" ? Object.keys(raw) : [];
  const caps = o.capabilities && typeof o.capabilities === "object" && !Array.isArray(o.capabilities) ? o.capabilities as Record<string, unknown> : {};
  const features: unknown[] = Array.isArray(o.features) ? o.features : Array.isArray(caps.features) ? caps.features : [];
  if (!paths.length && typeof caps.fast_lane !== "boolean" && !features.length) return null;
  const info = o.info && typeof o.info === "object" ? (o.info as Record<string, unknown>).version : undefined;
  const v = [o.version, o.contract_version, info].find((x) => typeof x === "string" || (typeof x === "number" && Number.isFinite(x)));
  const version = v === undefined ? null : String(v).replace(/[^\w.+\-]/gu, "").slice(0, 64) || null;
  const fast_lane = paths.some((p) => /\/runs\/[^/]+\/fast-lane\/?$/u.test(p)) || caps.fast_lane === true
    || features.some((f) => f === "fast-lane" || f === "fast_lane");
  return { fast_lane, version };
}

export async function converterContract(cfg: { url: string; requestTimeoutMs?: number }, o: { force?: boolean; now?: () => number } = {}): Promise<ConverterContract> {
  const now = o.now ?? Date.now;
  const url = cfg.url.replace(/\/+$/, "");
  const slot = CONTRACT.get(url) ?? {};
  CONTRACT.set(url, slot);
  if (!o.force && slot.value && now() - slot.value.at < CONVERTER_CONTRACT_CACHE_MS) return { ...slot.value, cached: true };
  if (slot.flight) return slot.flight;
  slot.flight = (async (): Promise<ConverterContract> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.min(CONVERTER_HEALTH_TIMEOUT_MS, Math.max(1000, cfg.requestTimeoutMs ?? CONVERTER_HEALTH_TIMEOUT_MS)));
    let value: ConverterContract;
    try {
      const res = await fetch(`${url}/api/contract`, { method: "GET", headers: { accept: "application/json" }, signal: ctl.signal, redirect: "manual" });
      const text = await res.text().catch(() => "");
      let json: unknown = null;
      try { json = JSON.parse(text); } catch { json = null; }
      const parsed = res.status >= 200 && res.status < 300 ? parseConverterContract(json) : null;
      value = { ok: parsed !== null, status: res.status, version: parsed?.version ?? null, fast_lane: parsed?.fast_lane ?? false, at: now(), cached: false };
    } catch {
      value = { ok: false, status: null, version: null, fast_lane: false, at: now(), cached: false };
    } finally { clearTimeout(timer); }
    if (value.ok) slot.value = value; else slot.value = undefined;
    log.info("converter_contract", { ok: value.ok, status: value.status, version: value.version, fast_lane: value.fast_lane });
    return value;
  })().finally(() => { slot.flight = undefined; });
  return slot.flight;
}
