import type pg from "pg";
import { tx } from "./db.ts";
import { PlatformError } from "./platform-error.ts";

export type CallKind = "ok" | "answered_error" | "busy" | "slow" | "config" | "aborted";
export type OutcomeKind = CallKind | "blocked" | "error";
export type GateBlockKind = "hold" | "floor" | "breaker" | "dirty" | "slot_busy";
export interface GateBlock { kind: GateBlockKind; until: Date | null }

export type HoldReason = "floor" | "test" | "admin";
export interface HoldEntry { until: string; reason: HoldReason; note: string | null; set_at: string }
export type Holds = Record<string, HoldEntry>;
export interface LeaseValue { owner?: string; until?: string; granted_at?: string }
export interface ArbiterValue { owner?: string; until?: string; registered_at?: string }
export interface BreakerState {
  reason: null | "busy" | "slow" | "config"; open_until: string | null; busy_streak: number; slow_streak: number;
  opened_at: string | null; last_kind: string | null; last_at: string | null; last_success_at: string | null;
  /**
   * Answers with an error in a row: +1 on `answered_error`, 0 on `ok`; other outcomes keep it. The breaker does
   * not open on it (the model does answer); health reads it ("the model answers, but always with an error"). Rows written
   * before the field do not carry it — read as 0.
   */
  answered_error_streak?: number;
  last_success_record?: string | null; last_other_success_at?: string | null;
}
export interface SlotRow {
  owner?: string | null; pid?: number | null; purpose?: string | null; stage?: string | null; lane?: string | null; record_id?: string | null;
  acquired_at?: string | null; call_started_at?: string | null; released_at?: string | null; dirty_until?: string | null; max_tokens?: number | null;
}
export interface FaultProbe { active?: number; max?: number; calls?: number; since?: string }
export interface GateState { holds: Holds; lease: LeaseValue; breaker: BreakerState; slot: SlotRow; arbiter: ArbiterValue; fault_probe?: FaultProbe }
export interface GateTiming { timeoutSec: number; afterAbortHoldSec: number }

export const LLM_KEYS = ["llm_slot", "llm_breaker", "llm_holds", "llm_floor_lease", "llm_arbiter", "llm_fault_probe"] as const;

export const LLM_GATE_DEFAULTS = { busy_backoff_sec: 60, busy_backoff_cap_sec: 1800, slow_streak_open: 3, after_abort_hold_sec: 120, shutdown_grace_sec: 20, waiting_alert_hours: 24 };
export type LlmGateCfg = typeof LLM_GATE_DEFAULTS;
export const LLM_RETRY_DEFAULTS = { base_sec: 60, cap_sec: 1800, now_patience_min: 120, poison_after: 3 };
export type LlmRetryCfg = typeof LLM_RETRY_DEFAULTS;
export const LLM_CONCURRENCY = { now_llm: 1, night_llm: 1 } as const;

export const emptyBreaker = (): BreakerState => ({ reason: null, open_until: null, busy_streak: 0, slow_streak: 0, opened_at: null, last_kind: null, last_at: null, last_success_at: null,
                                                  last_success_record: null, last_other_success_at: null, answered_error_streak: 0 });

/** The longest minimum pause a provider's `Retry-After` can ask of the breaker: 10 minutes. */
export const MAX_MIN_PAUSE_MS = 600_000;
/**
 * The shortest busy pause the settings allow (`processing.llm_gate.busy_backoff_sec` ≥ 10 s, `llmSettingProblems`): every
 * pause the breaker sets is at least this long, so a `Retry-After` of 10 s or less cannot lengthen one.
 */
const SHORTEST_BREAKER_PAUSE_MS = 10_000;
/** Answers with an error in a row from which health reports the model as not working. */
export const ANSWERED_ERROR_STREAK_ALERT = 5;

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);
const later = (a: number, b: number): boolean => Number.isFinite(a) && a > b;

export function callKind(e: unknown): OutcomeKind {
  if (e === null || e === undefined) return "ok";
  if (!(e instanceof PlatformError)) return "error";
  switch (e.kind) {
    case "schema_error": case "bad_response": return "answered_error";
    case "busy": return "busy";
    case "timeout": return "slow";
    case "not_configured": case "destination_denied": case "quota": return "config";
    case "refusal": case "context_overflow": return "answered_error";
    case "policy_denied": case "budget_exhausted": return "blocked";
    case "aborted": case "gate_lost": return "aborted";
    case "gate": return "error";
    case "http": {
      const st = e.status;
      if (st === undefined) return "busy";
      if (st === 429 || st === 502 || st === 503 || st === 504) return "busy";
      if (st === 408 || st >= 500) return "slow";
      if (st === 401 || st === 403 || st === 404) return "config";
      if (st === 400 && e.modelMissing) return "config";
      return "answered_error";
    }
  }
  return "error";
}

export function needsTail(e: unknown): boolean {
  if (!(e instanceof PlatformError) || e.fake) return false;
  if (e.kind === "timeout" || e.kind === "aborted" || e.kind === "gate_lost") return true;
  if (e.kind !== "http") return false;
  return e.status === undefined || e.status === 408 || e.status === 500 || e.status === 502 || e.status === 503 || e.status === 504;
}

/**
 * The minimum pause a failed call asks the breaker for: the provider's `Retry-After` (`PlatformError.retryAfterMs`),
 * at most 10 minutes. A value of 10 s or less is not passed: it cannot lengthen any pause the breaker sets, and the slot
 * calls of the legacy wire references (Retry-After of 1 s) keep their shape.
 */
export function minPauseFor(e: unknown): number | undefined {
  if (!(e instanceof PlatformError)) return undefined;
  const ms = e.retryAfterMs;
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= SHORTEST_BREAKER_PAUSE_MS) return undefined;
  return Math.min(ms, MAX_MIN_PAUSE_MS);
}

/** "The model answers, but always with an error": the streak of answers with an error reached the alert. */
export const answeredErrorStreakAlert = (b: Partial<BreakerState> | null | undefined): boolean =>
  (b?.answered_error_streak ?? 0) >= ANSWERED_ERROR_STREAK_ALERT;

export function breakerAfter(kind: OutcomeKind, s: BreakerState, cfg: Pick<LlmGateCfg, "busy_backoff_sec" | "busy_backoff_cap_sec" | "slow_streak_open">, now: Date,
                             recordId: string | null = null, o: { minPauseMs?: number } = {}): BreakerState {
  // blocked: nothing was asked of the model — like aborted, the breaker and its counters stay as they are
  if (kind === "aborted" || kind === "error" || kind === "blocked") return s;
  const at = now.toISOString(), base = cfg.busy_backoff_sec, cap = cfg.busy_backoff_cap_sec;
  // a pause the breaker opens is not shorter than the provider's Retry-After, at most 10 minutes
  const floor = typeof o.minPauseMs === "number" && Number.isFinite(o.minPauseMs) && o.minPauseMs > 0 ? Math.min(o.minPauseMs, MAX_MIN_PAUSE_MS) : 0;
  const until = (sec: number) => new Date(now.getTime() + Math.max(Math.min(cap, sec) * 1000, floor)).toISOString();
  const opened = (reason: BreakerState["reason"]) => (s.reason === null && reason !== null ? at : reason === null ? null : s.opened_at ?? at);
  if (kind === "ok" || kind === "answered_error") {
    const same = (s.last_success_record ?? null) === recordId;
    return { ...s, reason: null, open_until: null, busy_streak: 0, slow_streak: 0, opened_at: null, last_kind: kind, last_at: at, last_success_at: at,
             last_success_record: recordId, last_other_success_at: same ? s.last_other_success_at ?? null : s.last_success_at ?? null,
             answered_error_streak: kind === "ok" ? 0 : (s.answered_error_streak ?? 0) + 1 };
  }
  if (kind === "busy") {
    const streak = s.busy_streak + 1;
    return { ...s, reason: "busy", open_until: until(base * 2 ** (streak - 1)), busy_streak: streak, slow_streak: 0, opened_at: opened("busy"), last_kind: kind, last_at: at };
  }
  if (kind === "slow") {
    const streak = s.slow_streak + 1;
    if (streak < cfg.slow_streak_open) return { ...s, slow_streak: streak, last_kind: kind, last_at: at };
    return { ...s, reason: "slow", open_until: until(base * 2 ** (streak - cfg.slow_streak_open)), slow_streak: streak, opened_at: opened("slow"), last_kind: kind, last_at: at };
  }
  return { ...s, reason: "config", open_until: until(cap), opened_at: opened("config"), last_kind: kind, last_at: at };
}

export const breakerOpen = (b: BreakerState, now: Date): boolean => later(ms(b.open_until), now.getTime());

export function lastOtherSuccess(b: Partial<BreakerState> | null | undefined, recordId: string): Date | null {
  if (!b) return null;
  const own = b.last_success_record !== undefined && b.last_success_record !== null && b.last_success_record === recordId;
  const at = own ? b.last_other_success_at ?? null : b.last_success_at ?? null;
  const t = ms(at);
  return Number.isFinite(t) ? new Date(t) : null;
}

export function activeHolds(holds: Holds, now: Date): Array<HoldEntry & { owner: string }> {
  return Object.entries(holds ?? {}).filter(([, h]) => later(ms(h?.until), now.getTime())).map(([owner, h]) => ({ owner, ...h }))
    .sort((a, b) => ms(a.until) - ms(b.until));
}

export const leaseLive = (l: LeaseValue, now: Date): boolean => later(ms(l?.until), now.getTime());

export function dirtyUntil(slot: SlotRow, t: GateTiming): Date | null {
  const d = ms(slot?.dirty_until);
  const crash = slot?.call_started_at ? ms(slot.call_started_at) + (t.timeoutSec + t.afterAbortHoldSec) * 1000 : NaN;
  const worst = Math.max(Number.isFinite(d) ? d : -Infinity, Number.isFinite(crash) ? crash : -Infinity);
  return Number.isFinite(worst) ? new Date(worst) : null;
}

export function evalPermission(st: GateState, now: Date, o: { requireFloor: boolean; stub: boolean; bypassBreaker?: boolean }, t: GateTiming): GateBlock | null {
  const holds = activeHolds(st.holds, now);
  if (holds.length) return { kind: "hold", until: new Date(ms(holds[holds.length - 1]!.until)) };
  if (o.requireFloor && !o.stub && !leaseLive(st.lease, now)) return { kind: "floor", until: null };
  if (o.bypassBreaker !== true && breakerOpen(st.breaker ?? emptyBreaker(), now)) return { kind: "breaker", until: new Date(ms(st.breaker.open_until)) };
  const dirty = dirtyUntil(st.slot, t);
  if (dirty && dirty.getTime() > now.getTime()) return { kind: "dirty", until: dirty };
  return null;
}

const int = (v: unknown, lo: number, hi: number): boolean => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

export const FAULT_KINDS = ["busy", "unavailable", "network", "timeout", "http_500", "http_401", "unknown_model"] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];
export interface LlmFault { title_contains?: string; busy?: boolean; busy_times?: number; kind?: FaultKind; hold_ms?: number; fake_ok?: boolean }
const FAULT_KEYS = new Set(["title_contains", "busy", "busy_times", "kind", "hold_ms", "fake_ok"]);

export const testHooksEnabled = (): boolean => process.env.MEMORY_TEST_HOOKS === "1";

export function llmSettingProblems(key: string, merged: unknown, hooks = testHooksEnabled()): string[] | null {
  const obj = merged && typeof merged === "object" && !Array.isArray(merged) ? merged as Record<string, unknown> : null;
  if (key === "concurrency") {
    return obj && obj.now_llm === 1 && obj.night_llm === 1 && Object.keys(obj).length === 2 ? []
      : ["no more than one request to the model at a time; other values are not saved"];
  }
  if (key === "llm_gate") {
    if (!obj) return ["expected a set of values"];
    const p: string[] = [];
    if (Object.keys(obj).some((k) => !(k in LLM_GATE_DEFAULTS))) p.push("the setting contains unexpected fields. Remove them");
    if (!int(obj.busy_backoff_sec, 10, 3600)) p.push("pause when the model is busy: a whole number of seconds from 10 seconds to one hour");
    else if (!int(obj.busy_backoff_cap_sec, obj.busy_backoff_sec as number, 21600)) p.push("maximum pause when the model is busy: at least as long as the initial pause and up to 6 hours");
    if (!int(obj.slow_streak_open, 1, 20)) p.push("consecutive slow responses before pausing: 1 to 20");
    if (!int(obj.after_abort_hold_sec, 0, 900)) p.push("wait after an interrupted request: 0 to 15 minutes, specified in seconds");
    if (!int(obj.shutdown_grace_sec, 0, 25)) p.push("request completion time allowed at shutdown: 0 to 25 seconds");
    if (!int(obj.waiting_alert_hours, 1, 168)) p.push("time before an alert for a long wait: 1–168 hours");
    return p;
  }
  if (key === "llm_retry") {
    if (!obj) return ["expected a set of values"];
    const p: string[] = [];
    if (Object.keys(obj).some((k) => !(k in LLM_RETRY_DEFAULTS))) p.push("the setting contains unexpected fields. Remove them");
    if (!int(obj.base_sec, 5, 3600)) p.push("pause before retrying: a whole number of seconds from 5 seconds to one hour");
    else if (!int(obj.cap_sec, obj.base_sec as number, 21600)) p.push("maximum pause before retrying: at least as long as the initial pause and up to 6 hours");
    if (!int(obj.now_patience_min, 0, 1440)) p.push("daytime wait before deferring a meeting to the night queue: 0 to 1440 minutes");
    if (!int(obj.poison_after, 2, 20)) p.push("consecutive slow responses before a record takes too long: 2 to 20");
    return p;
  }
  if (key === "llm_fault") {
    if (!obj) return ["expected a set of values"];
    if (!Object.keys(obj).length) return [];
    const p: string[] = [];
    if (Object.keys(obj).some((k) => !FAULT_KEYS.has(k))) p.push("the setting contains unexpected fields. Remove them");
    if (typeof obj.title_contains !== "string" || [...obj.title_contains].length < 8 || [...obj.title_contains].length > 200)
      p.push("provide a record title substring of 8 to 200 characters. You can request a fault only for your own test records");
    if (obj.busy !== undefined && typeof obj.busy !== "boolean") p.push("“always busy”: yes or no");
    if (obj.busy_times !== undefined && !int(obj.busy_times, 0, 20)) p.push("number of “busy” responses: 0 to 20");
    if (obj.kind !== undefined && !(FAULT_KINDS as readonly unknown[]).includes(obj.kind))
      p.push("fault type: busy, unavailable, network interruption, timeout, gateway error, rejected key or unknown model");
    if ((obj.kind === "http_401" || obj.kind === "unknown_model") && Number(obj.busy_times ?? 0) > 0)
      p.push("a configuration fault (key or model name) can be set only to “always”. It does not change the attempt count");
    if (obj.hold_ms !== undefined && !int(obj.hold_ms, 0, 60000)) p.push("time to hold the model: 0 to 60 seconds, specified in milliseconds");
    if (obj.fake_ok !== undefined && typeof obj.fake_ok !== "boolean") p.push("“canned response”: yes or no");
    if (!hooks && (obj.fake_ok === true || Number(obj.hold_ms ?? 0) > 0)) p.push("canned responses and model holds are allowed only on a test installation");
    return p;
  }
  return null;
}

type Q = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query"> | Pick<pg.Client, "query">;
const DEFAULT_VALUES: Record<string, unknown> = { llm_slot: {}, llm_breaker: emptyBreaker(), llm_holds: {}, llm_floor_lease: {}, llm_arbiter: {}, llm_fault_probe: {} };

export async function ensureGateRows(q: Q, instanceId: string): Promise<void> {
  await q.query(
    `INSERT INTO maintenance_state (instance_id, key, value) SELECT $1, k, v FROM jsonb_each($2::jsonb) AS e(k, v) ON CONFLICT (instance_id, key) DO NOTHING`,
    [instanceId, JSON.stringify(DEFAULT_VALUES)]);
}

export async function readGateState(q: Q, instanceId: string): Promise<GateState & { dbNow: Date }> {
  const { rows } = await q.query(
    "SELECT key, value, now() AS db_now FROM maintenance_state WHERE instance_id = $1 AND key = ANY($2::text[])", [instanceId, [...LLM_KEYS]]);
  const by = new Map(rows.map((r: any) => [r.key as string, r.value]));
  const dbNow: Date = rows[0]?.db_now ?? (await q.query("SELECT now() AS n")).rows[0].n;
  return {
    slot: (by.get("llm_slot") ?? {}) as SlotRow, breaker: { ...emptyBreaker(), ...((by.get("llm_breaker") ?? {}) as Partial<BreakerState>) },
    holds: (by.get("llm_holds") ?? {}) as Holds, lease: (by.get("llm_floor_lease") ?? {}) as LeaseValue, arbiter: (by.get("llm_arbiter") ?? {}) as ArbiterValue,
    fault_probe: (by.get("llm_fault_probe") ?? {}) as FaultProbe, dbNow: new Date(dbNow),
  };
}

export async function readProcessingSetting<T extends object>(q: Q, instanceId: string, key: string, defaults: T): Promise<T> {
  const r = (await q.query("SELECT value, default_value FROM settings WHERE instance_id = $1 AND category = 'processing' AND key = $2", [instanceId, key])).rows[0];
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v as Partial<T> : {});
  return { ...defaults, ...obj(r?.default_value), ...obj(r?.value) };
}

export async function inFlight(q: Q): Promise<number> {
  return (await q.query(
    `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid = 1835363692 AND objid = 0 AND objsubid = 2
       AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)).rows[0].n;
}

export async function liveApplicationNames(q: Q, names: string[]): Promise<Set<string>> {
  if (!names.length) return new Set();
  const { rows } = await q.query("SELECT DISTINCT application_name FROM pg_stat_activity WHERE application_name = ANY($1::text[])", [names]);
  return new Set(rows.map((r: any) => r.application_name as string));
}

export class LlmGateConflict extends Error {
  constructor(readonly what: "lease" | "arbiter", message: string, readonly details: Record<string, unknown> = {}) { super(message); }
}

type Pool = Pick<pg.Pool, "connect">;

async function mutate<T, R>(pool: Pool, instanceId: string, key: string, fn: (v: T, now: Date) => { value: T; out: R }): Promise<R> {
  return tx(pool as pg.Pool, async (c) => {
    await c.query("INSERT INTO maintenance_state (instance_id, key, value) VALUES ($1, $2, $3::jsonb) ON CONFLICT (instance_id, key) DO NOTHING",
      [instanceId, key, JSON.stringify(DEFAULT_VALUES[key] ?? {})]);
    const r = (await c.query("SELECT value, now() AS db_now FROM maintenance_state WHERE instance_id = $1 AND key = $2 FOR UPDATE", [instanceId, key])).rows[0];
    const { value, out } = fn((r.value ?? {}) as T, new Date(r.db_now));
    await c.query("UPDATE maintenance_state SET value = $3::jsonb, updated_at = now() WHERE instance_id = $1 AND key = $2", [instanceId, key, JSON.stringify(value)]);
    return out;
  });
}

const liveHolds = (h: Holds, now: Date): Holds => Object.fromEntries(Object.entries(h ?? {}).filter(([, x]) => later(ms(x?.until), now.getTime())));
const pausedUntil = (h: Holds, now: Date): string | null => { const a = activeHolds(h, now); return a.length ? a[a.length - 1]!.until : null; };
export interface HoldsResult { holds: Holds; paused_until: string | null; isNew: boolean }

export function putHold(pool: Pool, instanceId: string, h: { owner: string; ttlSec: number; reason: HoldReason; note?: string | null }): Promise<HoldsResult> {
  return mutate<Holds, HoldsResult>(pool, instanceId, "llm_holds", (cur, now) => {
    const prev = cur?.[h.owner], isNew = !prev || !later(ms(prev.until), now.getTime());
    const holds = { ...liveHolds(cur, now), [h.owner]: { until: new Date(now.getTime() + h.ttlSec * 1000).toISOString(), reason: h.reason, note: h.note ?? null, set_at: isNew ? now.toISOString() : prev!.set_at } };
    return { value: holds, out: { holds, paused_until: pausedUntil(holds, now), isNew } };
  });
}

export function clearHold(pool: Pool, instanceId: string, owner: string): Promise<HoldsResult & { removed: boolean }> {
  return mutate<Holds, HoldsResult & { removed: boolean }>(pool, instanceId, "llm_holds", (cur, now) => {
    const holds = liveHolds(cur, now), removed = owner in holds;
    delete holds[owner];
    return { value: holds, out: { holds, paused_until: pausedUntil(holds, now), isNew: false, removed } };
  });
}

export function forceClearHolds(pool: Pool, instanceId: string): Promise<HoldsResult & { removed: number }> {
  return mutate<Holds, HoldsResult & { removed: number }>(pool, instanceId, "llm_holds", (cur, now) => {
    const live = liveHolds(cur, now);
    const holds = Object.fromEntries(Object.entries(live).filter(([, x]) => x.reason === "floor"));
    return { value: holds, out: { holds, paused_until: pausedUntil(holds, now), isNew: false, removed: Object.keys(live).length - Object.keys(holds).length } };
  });
}

export interface LeaseResult { lease: LeaseValue; isNew: boolean }
export function putLease(pool: Pool, instanceId: string, owner: string, ttlSec: number): Promise<LeaseResult> {
  return mutate<LeaseValue, LeaseResult>(pool, instanceId, "llm_floor_lease", (cur, now) => {
    const live = leaseLive(cur, now);
    if (live && cur.owner !== owner) throw new LlmGateConflict("lease", "another arbiter already holds the model lease", { until: cur.until });
    const isNew = !live || cur.owner !== owner;
    const lease = { owner, until: new Date(now.getTime() + ttlSec * 1000).toISOString(), granted_at: isNew ? now.toISOString() : cur.granted_at ?? now.toISOString() };
    return { value: lease, out: { lease, isNew } };
  });
}

export function revokeLease(pool: Pool, instanceId: string, owner: string): Promise<LeaseResult & { revoked: boolean }> {
  return mutate<LeaseValue, LeaseResult & { revoked: boolean }>(pool, instanceId, "llm_floor_lease", (cur, now) => {
    const live = leaseLive(cur, now);
    if (cur.owner && cur.owner !== owner) {
      if (live) throw new LlmGateConflict("lease", "another arbiter holds the lease and only that arbiter can revoke it", { until: cur.until });
      return { value: cur, out: { lease: cur, isNew: false, revoked: false } };
    }
    const lease = cur.owner ? { ...cur, until: live ? now.toISOString() : cur.until } : cur;
    return { value: lease, out: { lease, isNew: false, revoked: live } };
  });
}

const hostOf = (owner: string | undefined): string | null => (owner ? owner.split(":")[1] ?? null : null);
export interface ArbiterResult { arbiter: ArbiterValue | null; isNew: boolean }
export function putArbiter(pool: Pool, instanceId: string, owner: string, ttlSec: number): Promise<ArbiterResult> {
  return mutate<ArbiterValue, ArbiterResult>(pool, instanceId, "llm_arbiter", (cur, now) => {
    const live = later(ms(cur?.until), now.getTime());
    if (live && cur.owner !== owner) throw new LlmGateConflict("arbiter", "another check queue arbiter is already running on this server", { owner_host: hostOf(cur.owner), until: cur.until });
    const isNew = !live || cur.owner !== owner;
    const arbiter = { owner, until: new Date(now.getTime() + ttlSec * 1000).toISOString(), registered_at: isNew ? now.toISOString() : cur.registered_at ?? now.toISOString() };
    return { value: arbiter, out: { arbiter, isNew } };
  });
}

export function clearArbiter(pool: Pool, instanceId: string, owner: string): Promise<ArbiterResult> {
  return mutate<ArbiterValue, ArbiterResult>(pool, instanceId, "llm_arbiter", (cur, now) => {
    const live = later(ms(cur?.until), now.getTime());
    if (live && cur.owner && cur.owner !== owner) throw new LlmGateConflict("arbiter", "the registration belongs to another arbiter", { owner_host: hostOf(cur.owner), until: cur.until });
    return { value: {}, out: { arbiter: null, isNew: false } };
  });
}

export function probeNow(pool: Pool, instanceId: string): Promise<BreakerState> {
  return mutate<BreakerState, BreakerState>(pool, instanceId, "llm_breaker", (cur, now) => {
    const b = { ...emptyBreaker(), ...cur, open_until: cur?.open_until && later(ms(cur.open_until), now.getTime()) ? now.toISOString() : cur?.open_until ?? null };
    return { value: b, out: b };
  });
}

export function resetFaultProbe(pool: Pool, instanceId: string): Promise<FaultProbe> {
  return mutate<FaultProbe, FaultProbe>(pool, instanceId, "llm_fault_probe", (_cur, now) => {
    const v = { active: 0, max: 0, calls: 0, since: now.toISOString() };
    return { value: v, out: v };
  });
}
