import type pg from "pg";
import { ConverterError, ConverterStorageError } from "./converter.ts";
import { tx } from "./db.ts";

export const CONVERTER_GATE_KEY = "converter_gate";

export type ConverterGateReason = "unavailable" | "config" | "locked";
export type ConverterGateStateName = "closed" | "open" | "half_open";

export interface ConverterGateState {
  state: ConverterGateStateName;
  reason: ConverterGateReason | null;
  why: string | null;
  new_block: "mismatch" | null;
  stalled_ignore_until: string | null;
  open_until: string | null;
  streak: number;
  opened_at: string | null;
  last_ok_at: string | null;
  last_result_at: string | null;
  health_ok_at: string | null;
  probe_by: string | null;
  probe_at: string | null;
  settings_fp: string | null;
  principal: string | null;
  principal_ack: string | null;
  config_probes: number;
  mismatch: { code: string; records: string[]; since: string } | null;
  caps: { fast_lane: boolean; version: string | null; checked_at: string } | null;
  alerted: { reason: string; at: string } | null;
  wait_alert_at: string | null;
  recovering: boolean;
}

export const emptyConverterGate = (): ConverterGateState => ({
  state: "closed", reason: null, why: null, new_block: null, stalled_ignore_until: null, open_until: null, streak: 0, opened_at: null,
  last_ok_at: null, last_result_at: null, health_ok_at: null, probe_by: null, probe_at: null, settings_fp: null, principal: null, principal_ack: null,
  config_probes: 0, mismatch: null, caps: null, alerted: null, wait_alert_at: null, recovering: false,
});

export const GATE_UNAVAILABLE_BASE_SEC = 15;
export const GATE_UNAVAILABLE_CAP_SEC = 300;
export const GATE_PROBE_LEASE_SEC = 120;
export const GATE_HALF_OPEN_WAIT_SEC = 15;
export const GATE_RECHECK_SEC = 300;
export const GATE_CONFIG_PROBE_EVERY_SEC = 1800;
export const GATE_CONFIG_PROBES_MAX = 3;
export const GATE_LOCKED_DEFAULT_SEC = 900;
export const GATE_LOCKED_JITTER_MAX_SEC = 30;
export const GATE_ALERT_AFTER_HOURS = 4;

const iso = (d: Date): string => d.toISOString();
const ms = (s: string | null | undefined): number => (s ? Date.parse(s) : NaN);
const after = (d: Date, sec: number): string => new Date(d.getTime() + sec * 1000).toISOString();

export function normalizeConverterGate(raw: unknown): ConverterGateState {
  const v = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Partial<ConverterGateState> : {};
  const g = { ...emptyConverterGate(), ...v };
  if (g.state !== "open" && g.state !== "half_open") g.state = "closed";
  if (!Number.isFinite(g.streak)) g.streak = 0;
  if (!Number.isFinite(g.config_probes)) g.config_probes = 0;
  g.recovering = g.recovering === true;
  return g;
}

export const gateUnavailableSec = (streak: number): number => Math.min(GATE_UNAVAILABLE_CAP_SEC, GATE_UNAVAILABLE_BASE_SEC * 2 ** Math.max(0, streak - 1));

const strongOpen = (s: ConverterGateState, now: Date): boolean =>
  s.state !== "closed" && (s.reason === "config" || s.reason === "locked") && (s.open_until === null || ms(s.open_until) > now.getTime() || s.state === "half_open");

export function gateAfterUnavailable(s: ConverterGateState, now: Date, why: string | null = null): ConverterGateState {
  if (strongOpen(s, now) && s.probe_by === null) return s;
  if (s.state === "open" && s.reason === "unavailable" && ms(s.open_until) > now.getTime()) return s;
  const streak = s.streak + 1;
  return { ...s, state: "open", reason: "unavailable", why, streak, open_until: after(now, gateUnavailableSec(streak)),
           opened_at: s.state === "closed" ? iso(now) : s.opened_at ?? iso(now), probe_by: null, probe_at: null };
}

export const CONVERTER_PRINCIPAL_CHANGED = "principal_changed";

export const principalHold = (s: ConverterGateState): boolean => s.state !== "closed" && s.reason === "config" && s.why === CONVERTER_PRINCIPAL_CHANGED;

export function gateAfterConfig(s: ConverterGateState, now: Date, settingsFp: string, why: string | null = null, probe = false): ConverterGateState {
  const same = s.state !== "closed" && s.reason === "config" && s.settings_fp === settingsFp;
  if (same && principalHold(s)) return s;
  if (same && !probe && s.state === "open" && why !== CONVERTER_PRINCIPAL_CHANGED) return s;
  const probes = (same ? s.config_probes : 0) + (probe ? 1 : 0);
  const selfProbe = why !== CONVERTER_PRINCIPAL_CHANGED && probes < GATE_CONFIG_PROBES_MAX;
  return { ...s, state: "open", reason: "config", why, settings_fp: settingsFp, config_probes: probes, streak: s.streak + 1,
           open_until: selfProbe ? after(now, GATE_CONFIG_PROBE_EVERY_SEC) : null,
           opened_at: s.state === "closed" ? iso(now) : s.opened_at ?? iso(now), probe_by: null, probe_at: null };
}

export function gateAfterLocked(s: ConverterGateState, now: Date, retryAfterSec: number | undefined, jitterSec = 0, why: string | null = "login_locked"): ConverterGateState {
  if (s.state === "open" && s.reason === "locked" && ms(s.open_until) > now.getTime()) return s;
  if (principalHold(s) && s.state === "open") return s;
  const wait = (retryAfterSec && retryAfterSec > 0 ? retryAfterSec : GATE_LOCKED_DEFAULT_SEC) + Math.max(0, Math.min(GATE_LOCKED_JITTER_MAX_SEC, jitterSec));
  return { ...s, state: "open", reason: "locked", why, streak: s.streak + 1, open_until: after(now, wait),
           opened_at: s.state === "closed" ? iso(now) : s.opened_at ?? iso(now), probe_by: null, probe_at: null };
}

export function gateAfterOk(s: ConverterGateState, now: Date, o: { result?: boolean; health?: boolean; settingsFp?: string } = {}): ConverterGateState {
  if (principalHold(s) && !(o.settingsFp && o.settingsFp !== s.settings_fp))
    return o.result ? { ...s, last_ok_at: iso(now), last_result_at: iso(now), mismatch: null, new_block: null, recovering: false } : s;
  const recovering = o.result ? false : o.health && s.state !== "closed" && s.reason === "unavailable" ? true : s.recovering;
  return { ...s, state: "closed", reason: null, why: null, open_until: null, streak: 0, opened_at: null, probe_by: null, probe_at: null, config_probes: 0,
           alerted: s.state === "closed" ? s.alerted : null, last_ok_at: iso(now), recovering,
           ...(o.result ? { last_result_at: iso(now), mismatch: null, new_block: null } : {}), ...(o.health ? { health_ok_at: iso(now) } : {}),
           ...(o.settingsFp ? { settings_fp: o.settingsFp } : {}) };
}

export interface ConverterProbeResult {
  state: ConverterGateState;
  outcome: "ok" | "needs_confirm";
  principalChanged: boolean;
  confirmed: boolean;
}

export function gateAfterProbe(s: ConverterGateState, now: Date, o: { principal: string | null; settingsFp: string; confirm: boolean }): ConverterProbeResult {
  const hold = principalHold(s);
  const principalChanged = Boolean(o.principal && s.principal && o.principal !== s.principal);
  if ((hold || principalChanged) && !o.confirm) {
    return { state: hold ? s : gateAfterOk(s, now, { health: true, settingsFp: o.settingsFp }), outcome: "needs_confirm", principalChanged, confirmed: false };
  }
  const base: ConverterGateState = hold
    ? { ...s, state: "closed", reason: null, why: null, open_until: null, streak: 0, opened_at: null, probe_by: null, probe_at: null, config_probes: 0, alerted: null }
    : s;
  const closed = gateAfterOk(base, now, { health: true, settingsFp: o.settingsFp });
  const principal = o.principal ?? s.principal;
  const confirmed = hold || principalChanged;
  return { state: { ...closed, principal, ...(confirmed ? { principal_ack: principal } : {}) }, outcome: "ok", principalChanged, confirmed };
}

export function gateAfterResume(s: ConverterGateState, now: Date, ignoreMs: number = 3 * 3600_000): ConverterGateState {
  return { ...s, new_block: null, mismatch: null, stalled_ignore_until: new Date(now.getTime() + ignoreMs).toISOString() };
}

export const principalAcked = (s: Pick<ConverterGateState, "principal" | "principal_ack">): boolean => Boolean(s.principal && s.principal_ack === s.principal);

export function gateWithCaps(s: ConverterGateState, now: Date, caps: { fast_lane: boolean; version: string | null }): ConverterGateState {
  return { ...s, caps: { fast_lane: caps.fast_lane === true, version: caps.version ?? null, checked_at: iso(now) } };
}
export const capsChanged = (before: ConverterGateState["caps"], after: { fast_lane: boolean; version: string | null }): boolean =>
  !before || before.fast_lane !== (after.fast_lane === true) || (before.version ?? null) !== (after.version ?? null);
export const capsChangedEvent = (before: ConverterGateState["caps"], after: { fast_lane: boolean; version: string | null }) =>
  ({ op: "caps_changed" as const, fast_lane: after.fast_lane === true, version: after.version ?? null,
     was_fast_lane: before ? before.fast_lane : null, previous_version: before ? before.version ?? null : null });

export const GATE_MISMATCH_RECORDS = 3;

export function gateNoteMismatch(s: ConverterGateState, now: Date, code: string, recordId: string): { state: ConverterGateState; tripped: boolean; blocked: boolean } {
  if (s.new_block === "mismatch") return { state: s, tripped: false, blocked: s.mismatch?.code === code };
  const cur = s.mismatch?.code === code ? s.mismatch : { code, records: [] as string[], since: iso(now) };
  const records = cur.records.includes(recordId) ? cur.records : [...cur.records, recordId].slice(-GATE_MISMATCH_RECORDS);
  const tripped = records.length >= GATE_MISMATCH_RECORDS;
  return { state: { ...s, mismatch: { ...cur, records }, ...(tripped ? { new_block: "mismatch" as const } : {}) }, tripped, blocked: tripped };
}

export type ConverterHolds = null | "new" | "all";
export const CONVERTER_HOLDS_VALUES = ["new", "all"] as const;

export function converterHolds(v: unknown): ConverterHolds { return v === "new" || v === "all" ? v : null; }

export async function readConverterHolds(q: Q, instanceId: string, fallback: unknown): Promise<ConverterHolds> {
  try {
    const r = (await q.query("SELECT value FROM settings WHERE instance_id = $1 AND category = 'processing' AND key = 'converter_holds'", [instanceId])).rows[0];
    return converterHolds(r ? r.value : fallback);
  } catch {
    return converterHolds(fallback);
  }
}

export type ConverterGateDecision =
  | { kind: "pass" }
  | { kind: "probe"; reason: ConverterGateReason; settingsChanged: boolean }
  | { kind: "wait"; until: Date; code: string; busy: boolean };

export function converterGateDecision(s: ConverterGateState, now: Date, o: { holds: ConverterHolds; fresh: boolean; settingsFp: string }): ConverterGateDecision {
  const t = now.getTime();
  if (o.holds === "all") return { kind: "wait", until: new Date(t + GATE_RECHECK_SEC * 1000), code: "converter_wait:hold", busy: false };
  if (o.holds === "new" && o.fresh) return { kind: "wait", until: new Date(t + GATE_RECHECK_SEC * 1000), code: "converter_wait:hold_new", busy: false };
  if (s.state === "closed" || !s.reason) return { kind: "pass" };
  const settingsChanged = s.reason === "config" && s.settings_fp !== o.settingsFp;
  const code = `converter_wait:${s.reason}`;
  if (s.state === "half_open") {
    const live = s.probe_by !== null && ms(s.probe_at) > t - GATE_PROBE_LEASE_SEC * 1000;
    if (live && !settingsChanged) return { kind: "wait", until: new Date(t + GATE_HALF_OPEN_WAIT_SEC * 1000), code, busy: true };
    return { kind: "probe", reason: s.reason, settingsChanged };
  }
  const until = ms(s.open_until);
  if (settingsChanged || (Number.isFinite(until) && until <= t)) return { kind: "probe", reason: s.reason, settingsChanged };
  const at = Math.max(t + GATE_HALF_OPEN_WAIT_SEC * 1000, Math.min(Number.isFinite(until) ? until : Infinity, t + GATE_RECHECK_SEC * 1000));
  return { kind: "wait", until: new Date(at), code, busy: true };
}

export function gateNeedsAlert(s: ConverterGateState, now: Date): boolean {
  if (s.state === "closed" || s.reason !== "unavailable") return false;
  const opened = ms(s.opened_at);
  if (!Number.isFinite(opened) || now.getTime() - opened < GATE_ALERT_AFTER_HOURS * 3600_000) return false;
  return !(s.alerted?.reason === "unavailable" && ms(s.alerted.at) >= opened);
}

export type ConverterErrorClass = "unavailable" | "doc_error" | "storage" | "config" | "locked" | "session" | "wait" | "job_error" | "terminal" | "aborted";

export interface ConverterClassified {
  cls: ConverterErrorClass;
  code: string;
  retryAfterSec?: number;
  short?: boolean;
  mismatch?: boolean;
}

export function converterNeedsHealth(e: unknown): boolean {
  return e instanceof ConverterError && !e.terminal && !e.login && (e.status === 503 || e.status === 504 || e.code === "request_timeout");
}

const codeOf = (e: ConverterError): string => e.code ?? (e.status ? `http_${e.status}` : e.kind);

export function classifyConverterError(e: unknown, healthOk = true): ConverterClassified {
  if (e instanceof ConverterStorageError) return { cls: "storage", code: e.code };
  if (!(e instanceof ConverterError)) return { cls: "job_error", code: "error" };
  const code = codeOf(e);
  if (e.code === "aborted") return { cls: "aborted", code };
  if (e.code === "not_configured") return { cls: "config", code };
  if (e.login) {
    if (e.status === 401 || e.status === 403 || e.code === "login_no_session") return { cls: "config", code };
    if (e.status === 429) return { cls: "locked", code, ...(e.retryAfterSec !== undefined ? { retryAfterSec: e.retryAfterSec } : {}) };
    if (e.kind === "network" || e.kind === "timeout" || (e.status !== undefined && e.status >= 500)) return { cls: "unavailable", code };
    return { cls: "config", code };
  }
  if (e.terminal) return { cls: "terminal", code };
  if (e.kind === "network" || e.status === 502) return { cls: "unavailable", code };
  if (converterNeedsHealth(e)) return healthOk ? { cls: "doc_error", code } : { cls: "unavailable", code };
  if (e.status === 429) return { cls: "locked", code, short: true, ...(e.retryAfterSec !== undefined ? { retryAfterSec: e.retryAfterSec } : {}) };
  if (e.kind === "auth") return { cls: "job_error", code: e.status ? `http_${e.status}` : code, mismatch: true };
  const mismatch = e.mismatch === true || e.code === "unexpected_response" || e.code === "run_control_conflict" || (e.status !== undefined && e.status >= 500)
    || e.status === 400 || e.status === 422;
  return { cls: "job_error", code, ...(mismatch ? { mismatch: true } : {}) };
}

export async function classifyConverterErrorWithHealth(e: unknown, health: () => Promise<boolean>): Promise<ConverterClassified> {
  return classifyConverterError(e, converterNeedsHealth(e) ? await health() : true);
}

export const docErrorWaitSec = (n: number): number => Math.min(1800, 60 * 2 ** Math.max(0, n));
export const storageWaitSec = (n: number): number => Math.min(900, 60 * 2 ** Math.max(0, n));
export const throttledWaitSec = (retryAfterSec: number | undefined): number => Math.min(900, Math.max(15, retryAfterSec ?? 60));
export function patienceExceeded(firstBusyAt: Date | null, hours: number, now: Date): boolean {
  return hours > 0 && firstBusyAt !== null && now.getTime() - firstBusyAt.getTime() >= hours * 3600_000;
}

type Q = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

export async function readConverterGate(q: Q, instanceId: string): Promise<{ gate: ConverterGateState; dbNow: Date }> {
  const r = (await q.query("SELECT value, now() AS db_now FROM maintenance_state WHERE instance_id = $1 AND key = $2", [instanceId, CONVERTER_GATE_KEY])).rows[0];
  const dbNow = r?.db_now ? new Date(r.db_now) : new Date((await q.query("SELECT now() AS n")).rows[0]?.n ?? Date.now());
  return { gate: normalizeConverterGate(r?.value), dbNow };
}

export async function updateConverterGate<R>(pool: Pick<pg.Pool, "connect">, instanceId: string,
                                             fn: (cur: ConverterGateState, now: Date) => { value: ConverterGateState; out: R }): Promise<{ before: ConverterGateState; after: ConverterGateState; out: R }> {
  return tx(pool as pg.Pool, async (c) => {
    await c.query("INSERT INTO maintenance_state (instance_id, key, value) VALUES ($1, $2, $3::jsonb) ON CONFLICT (instance_id, key) DO NOTHING",
      [instanceId, CONVERTER_GATE_KEY, JSON.stringify(emptyConverterGate())]);
    const r = (await c.query("SELECT value, now() AS db_now FROM maintenance_state WHERE instance_id = $1 AND key = $2 FOR UPDATE", [instanceId, CONVERTER_GATE_KEY])).rows[0];
    const before = normalizeConverterGate(r?.value);
    const { value, out } = fn(before, new Date(r?.db_now ?? Date.now()));
    if (value !== before)
      await c.query("UPDATE maintenance_state SET value = $3::jsonb, updated_at = now() WHERE instance_id = $1 AND key = $2", [instanceId, CONVERTER_GATE_KEY, JSON.stringify(value)]);
    return { before, after: value, out };
  });
}

export type ConverterProbeClaim = { claimed: true; reason: ConverterGateReason; settingsChanged: boolean } | { claimed: false; decision: ConverterGateDecision };

export async function claimConverterProbe(pool: Pick<pg.Pool, "connect">, instanceId: string, owner: string, settingsFp: string): Promise<ConverterProbeClaim> {
  const r = await updateConverterGate<ConverterProbeClaim>(pool, instanceId, (cur, now) => {
    const d = converterGateDecision(cur, now, { holds: null, fresh: false, settingsFp });
    if (d.kind !== "probe") return { value: cur, out: { claimed: false, decision: d } };
    return { value: { ...cur, state: "half_open", probe_by: owner, probe_at: now.toISOString() },
             out: { claimed: true, reason: d.reason, settingsChanged: d.settingsChanged } };
  });
  return r.out;
}
