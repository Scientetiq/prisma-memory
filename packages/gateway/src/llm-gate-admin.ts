import type { Context, Hono } from "hono";
import { activeHolds, answeredErrorStreakAlert, breakerOpen, chatBlockOf, roleConfigurationProblems, modelConfigurationText, clearArbiter, clearHold, conflict, dirtyUntil, emptyBreaker, evalPermission, forceClearHolds, inFlight, invalid, LLM_GATE_DEFAULTS,
         fallbackTz, instanceTz, LLM_RETRY_DEFAULTS, LlmGateConflict, leaseLive, liveApplicationNames, probeNow, putArbiter, putHold, putLease, readGateState, readProcessingSetting, resetFaultProbe, revokeLease,
         type Settings, type ModelConfigurationProblem, type BudgetPeriod, type BreakerState, type ChatBlock, type GateBlockKind, type GateState, type HoldReason } from "@memory/shared";
import type { App } from "./context.ts";
import { nightCapHeld } from "./night-cap.ts";
import { DAY_PRIORITY_MIN, LLM_QUEUES } from "./queue.ts";

type AdminAudit = (c: Context<any>, op: string, details?: Record<string, unknown>) => Promise<void>;
export const LLM_STAGES: readonly string[] = ["summary", "events", "described"];
const OWNER_RE = /^[A-Za-z0-9._:@-]{1,80}$/;
const REASONS: HoldReason[] = ["floor", "test", "admin"];

export const floorRequired = (): boolean => process.env.MEMORY_LLM_REQUIRE_FLOOR === "1";
export const stubMode = (): boolean => process.env.MEMORY_LLM_STUB === "1";

export interface WaitingStats {
  due_now_lane: number | null; due_night_lane: number | null; waiting_model: number; now_lane: number; night_lane: number; too_slow: number;
  next_retry_at: string | null; oldest_since: string | null; oldest_now_since: string | null;
  /** All pending stages of the model, whatever they wait for: what waits while AI is off. */
  pending_llm: number;
  blocked: number;
}
export interface LlmGateView {
  checked_at: string; floor_required: boolean; stub: boolean;
  slot: { limit: 1; in_flight: number; holder: { purpose: string | null; stage: string | null; lane: string | null; since: string | null } | null; dirty_until: string | null };
  timeouts: { timeout_sec: number; after_abort_hold_sec: number };
  holds: Array<{ owner: string; reason: HoldReason; note: string | null; until: string; set_at: string }>; paused_until: string | null;
  lease: { owner: string; until: string } | null;
  arbiter: { owner: string; until: string } | null;
  breaker: { open: boolean; reason: BreakerState["reason"]; open_until: string | null; busy_streak: number; slow_streak: number; last_success_at: string | null;
             /** Answers with an error in a row; 5 and more — the llm health check is not ok. */
             answered_error_streak: number };
  waiting: WaitingStats;
  /**
   * May chat be called now? The rule of the workers' `Platform.chatBlock()`: `"off"` — no usable chat connection
   * (the dispatcher takes no chat stage), `"budget"` — the money budget is exhausted, null — yes. Stub mode is
   * always null. An internal field until documents it.
   */
  chat_block: ChatBlock;
  /** Internal diagnostics until documents the shape; no stored values. */
  model_problems: ModelConfigurationProblem[];
  can_call_now: boolean; blocked_by: GateBlockKind | null; blocked_until: string | null;
  fault_probe?: { active: number; max: number; calls: number };
}

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

export async function waitingStats(app: Pick<App, "db">): Promise<WaitingStats> {
  const sys = { classes: ["open", "closed"] as const, tier: "system" as const };
  const w: WaitingStats = { due_now_lane: null, due_night_lane: null, waiting_model: 0, now_lane: 0, night_lane: 0, too_slow: 0, next_retry_at: null, oldest_since: null, oldest_now_since: null,
                            pending_llm: 0, blocked: 0 };
  let next = Infinity, oldest = Infinity, oldestNow = Infinity;
  for (const cls of ["open", "closed"] as const) {
    const r = (await app.db.records(cls, sys).query(
      `SELECT count(*) FILTER (WHERE waiting)::int AS waiting, count(*) FILTER (WHERE waiting AND now_lane)::int AS now_lane,
              count(*) FILTER (WHERE too_slow)::int AS too_slow, count(*) FILTER (WHERE pending)::int AS pending_llm, count(*) FILTER (WHERE blocked)::int AS blocked,
              min(retry_at) FILTER (WHERE waiting AND retry_at > now()) AS next_retry_at, min(COALESCE(first_busy_at, updated_at)) FILTER (WHERE waiting AND NOT blocked) AS oldest,
              min(COALESCE(first_busy_at, updated_at)) FILTER (WHERE waiting AND now_lane AND NOT blocked) AS oldest_now
         FROM (SELECT y.*, y.pending AND (y.busy_retries > 0 OR y.slow_retries > 0 OR y.retry_at IS NOT NULL OR y.last_error LIKE 'model_%') AS waiting
                 FROM (SELECT s.retry_at, s.first_busy_at, s.updated_at, s.busy_retries, s.slow_retries, COALESCE(s.last_error, '') AS last_error,
                              r.attrs ? 'process_now_at' AS now_lane, s.status = 'pending' AS pending,
                              s.status = 'pending' AND (COALESCE(s.last_error, '') LIKE 'model_policy:%' OR COALESCE(s.last_error, '') LIKE 'model_budget:%') AS blocked,
                              s.status = 'failed' AND COALESCE(s.last_error, '') LIKE 'llm_too_slow:%' AS too_slow
                         FROM record_stages s JOIN records_live r ON r.id = s.record_id WHERE s.stage = ANY($1::stage_name[])) y) x`, [[...LLM_STAGES]])).rows[0];
    w.waiting_model += r.waiting; w.now_lane += r.now_lane; w.night_lane += r.waiting - r.now_lane; w.too_slow += r.too_slow;
    w.pending_llm += r.pending_llm; w.blocked += r.blocked;
    if (r.next_retry_at) next = Math.min(next, new Date(r.next_retry_at).getTime());
    if (r.oldest) oldest = Math.min(oldest, new Date(r.oldest).getTime());
    if (r.oldest_now) oldestNow = Math.min(oldestNow, new Date(r.oldest_now).getTime());
  }
  w.next_retry_at = Number.isFinite(next) ? new Date(next).toISOString() : null;
  w.oldest_since = Number.isFinite(oldest) ? new Date(oldest).toISOString() : null;
  w.oldest_now_since = Number.isFinite(oldestNow) ? new Date(oldestNow).toISOString() : null;
  try {
    // lanes by the dispatcher's daytime threshold (1): documents of the day lane by default (priority 5) are day work
    const q = (await app.db.control.query(
      `SELECT count(*) FILTER (WHERE j.priority >= ${DAY_PRIORITY_MIN})::int AS now, count(*) FILTER (WHERE j.priority < ${DAY_PRIORITY_MIN})::int AS night
         FROM pgboss.job j
        WHERE j.name = ANY($1) AND j.state IN ('created','retry') AND j.start_after <= now()`, [LLM_QUEUES])).rows[0];
    w.due_now_lane = q.now; w.due_night_lane = q.night;
  } catch { }
  return w;
}

/** Connection readiness is separate from slot permission: an idle slot cannot make an unusable model callable. */
export function modelGateReadiness(settings: Pick<Settings, "get" | "str">, o: { stub?: boolean; budget?: BudgetPeriod | null } = {}) {
  const chat_block = chatBlockOf(settings, o);
  const model_problems = (["chat", "embeddings", "rerank"] as const).flatMap((role) =>
    role === "chat" && o.stub ? [] : roleConfigurationProblems(settings, role));
  return { chat_block, model_problems, can_call_now: chat_block === null };
}

export async function llmGateState(app: Pick<App, "db" | "instanceId" | "settings"> & Partial<Pick<App, "platform">>): Promise<LlmGateView> {
  const ctl = app.db.control;
  const [st, cfg, fault] = await Promise.all([
    readGateState(ctl, app.instanceId),
    readProcessingSetting(ctl, app.instanceId, "llm_gate", LLM_GATE_DEFAULTS),
    readProcessingSetting<Record<string, unknown>>(ctl, app.instanceId, "llm_fault", {}),
  ]);
  const now = st.dbNow;
  const t = { timeoutSec: Number(app.settings.get("models.timeout_sec", 300)), afterAbortHoldSec: Number(cfg.after_abort_hold_sec) };
  const [flying, live, waiting, budget] = await Promise.all([
    inFlight(ctl),
    st.slot.owner ? liveApplicationNames(ctl, [st.slot.owner]) : Promise.resolve(new Set<string>()),
    waitingStats(app),
    // the money budget of the installation, by this process's usage recorder: the table is common to all processes
    stubMode() ? Promise.resolve(null) : app.platform?.budgetFresh() ?? Promise.resolve(null),
  ]);
  const holding = flying > 0 && !!st.slot.owner && live.has(st.slot.owner) && !st.slot.released_at;
  const dirty = dirtyUntil(st.slot, t);
  const holds = activeHolds(st.holds, now).map((h) => ({ owner: h.owner, reason: h.reason, note: h.note ?? null, until: h.until, set_at: h.set_at }));
  const b = { ...emptyBreaker(), ...st.breaker };
  const block = evalPermission(st, now, { requireFloor: floorRequired(), stub: stubMode() }, t);
  const probe = st.fault_probe ?? {};
  const readiness = modelGateReadiness(app.settings, { stub: stubMode(), budget });
  return {
    checked_at: now.toISOString(), floor_required: floorRequired(), stub: stubMode(),
    slot: { limit: 1, in_flight: flying,
            holder: holding ? { purpose: st.slot.purpose ?? null, stage: st.slot.stage ?? null, lane: st.slot.lane ?? null, since: iso(st.slot.acquired_at) } : null,
            dirty_until: dirty && dirty.getTime() > now.getTime() ? dirty.toISOString() : null },
    timeouts: { timeout_sec: t.timeoutSec, after_abort_hold_sec: t.afterAbortHoldSec },
    holds, paused_until: holds.length ? holds[holds.length - 1]!.until : null,
    lease: leaseLive(st.lease, now) && st.lease.owner ? { owner: st.lease.owner, until: st.lease.until! } : null,
    arbiter: st.arbiter?.owner && st.arbiter.until && Date.parse(st.arbiter.until) > now.getTime() ? { owner: st.arbiter.owner, until: st.arbiter.until } : null,
    breaker: { open: breakerOpen(b, now), reason: b.reason, open_until: b.open_until, busy_streak: b.busy_streak, slow_streak: b.slow_streak, last_success_at: b.last_success_at,
               answered_error_streak: Number(b.answered_error_streak ?? 0) },
    waiting,
    ...readiness,
    can_call_now: readiness.can_call_now && !block, blocked_by: block?.kind ?? null, blocked_until: block?.until?.toISOString() ?? null,
    ...(Object.keys(fault).length ? { fault_probe: { active: Number(probe.active ?? 0), max: Number(probe.max ?? 0), calls: Number(probe.calls ?? 0) } } : {}),
  };
}

export interface GateSnapshot { paused: boolean; breakerOpen: boolean; openUntil: string | null; at: number }
let snap: GateSnapshot | null = null;
export async function gateSnapshot(app: Pick<App, "db" | "instanceId">): Promise<GateSnapshot> {
  if (snap && Date.now() - snap.at < 5000) return snap;
  const st: GateState & { dbNow: Date } = await readGateState(app.db.control, app.instanceId);
  const now = st.dbNow, b = { ...emptyBreaker(), ...st.breaker };
  const paused = activeHolds(st.holds, now).length > 0 || (floorRequired() && !stubMode() && !leaseLive(st.lease, now));
  snap = { paused, breakerOpen: breakerOpen(b, now), openUntil: breakerOpen(b, now) ? b.open_until : null, at: Date.now() };
  return snap;
}
export const resetGateSnapshot = (): void => { snap = null; };

/** Time of day for the health texts, in the installation's zone: «14:30». */
const hhmm = (at: string | Date, tz: string): string => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(at));

export function llmHealth(v: Pick<LlmGateView, "breaker" | "holds" | "paused_until" | "lease" | "floor_required" | "stub" | "waiting"> & Partial<Pick<LlmGateView, "chat_block" | "model_problems">>, now: Date,
                          cfg: { waiting_alert_hours: number; now_patience_min: number; night_cap_held?: boolean }, tz: string = fallbackTz()): { ok: boolean; detail: string } {
  // AI is off — nothing is asked of a model, so neither a breaker left from before nor an old wait is a fault
  const pending = Number(v.waiting.pending_llm ?? 0);
  if (v.model_problems?.length) return { ok: false, detail: `model configuration is not usable: ${modelConfigurationText(v.model_problems)}` };
  if (v.chat_block === "off") return { ok: true, detail: `AI is off: ${pending === 0 ? "no record waits" : pending === 1 ? "1 record waits" : `${pending} records wait`} for a model` };
  if (v.chat_block === "budget")
    return { ok: false, detail: `model budget exhausted: ${pending === 1 ? "1 record waits" : `${pending} records wait`} until the budget is raised or the next period starts` };
  const r = llmGateHealth(v, now, cfg, tz);
  // stages the data policy or the budget refused wait for a permission: told, never a fault
  const blocked = Number(v.waiting.blocked ?? 0);
  return r.ok && blocked > 0 ? { ok: true, detail: `${r.detail}; ${blocked === 1 ? "1 record waits" : `${blocked} records wait`} for a permitted model` } : r;
}

function llmGateHealth(v: Pick<LlmGateView, "breaker" | "holds" | "paused_until" | "lease" | "floor_required" | "stub" | "waiting">, now: Date,
                       cfg: { waiting_alert_hours: number; now_patience_min: number; night_cap_held?: boolean }, tz: string): { ok: boolean; detail: string } {
  if (v.breaker.open && v.breaker.reason === "config") return { ok: false, detail: "the model is unavailable with the current settings: check the gateway address, key and model name" };
  if (v.breaker.open) return { ok: false, detail: `the model ${v.breaker.reason === "slow" ? "responds too slowly" : "is busy"}: calls are paused until ${hhmm(v.breaker.open_until!, tz)}` };
  // "the model answers, but always with an error": the breaker stays closed for answers, the streak tells it
  // only while it is fresh: the streak counts record-specific answers too (refusal, context overflow), so five of
  // them at the end of a batch and then a quiet day are not a fault of the model; the time of the last answer is
  // last_success_at (an answer with an error sets it as well); none known — alert, as before
  const lastAnswer = v.breaker.last_success_at ? Date.parse(v.breaker.last_success_at) : NaN;
  const streakFresh = !Number.isFinite(lastAnswer) || now.getTime() - lastAnswer <= cfg.waiting_alert_hours * 3600_000;
  if (answeredErrorStreakAlert(v.breaker) && streakFresh)
    return { ok: false, detail: `the model has answered with an error ${v.breaker.answered_error_streak} times in a row — see the unprocessed list` };
  let capNote: string | null = null;
  // the stages that wait for the model itself: the blocked ones wait for a permission and are told apart by llmHealth
  const forModel = Math.max(0, Number(v.waiting.waiting_model ?? 0) - Number(v.waiting.blocked ?? 0) || 0);
  if (v.waiting.oldest_since) {
    const age = (iso: string | null) => (iso ? now.getTime() - Date.parse(iso) : 0);
    const alertMs = cfg.waiting_alert_hours * 3600_000, span = cfg.waiting_alert_hours === 24 ? "one day" : `${cfg.waiting_alert_hours} h`;
    const nightLong = age(v.waiting.oldest_since) > alertMs;
    const nowLong = age(v.waiting.oldest_now_since) > (cfg.now_patience_min + 60) * 60_000;
    const capExplains = nightLong && !nowLong && cfg.night_cap_held === true && age(v.waiting.oldest_now_since) <= alertMs;
    if ((nightLong || nowLong) && !capExplains) return { ok: false, detail: `model requests have been waiting more than ${nightLong ? span : `${cfg.now_patience_min + 60} min`}: ${forModel}` };
    if (capExplains) capNote = `night jobs have been waiting more than ${span} because of the nightly model limit. The rest will run on following nights. Waiting for the model: ${forModel}`;
  }
  if (v.holds.length) {
    const why = v.holds.some((h) => h.reason === "admin") ? "set by an administrator" : v.holds.some((h) => h.reason === "test") ? "a check is running" : "the model is reserved for developer test checks";
    return { ok: true, detail: `paused until ${hhmm(v.paused_until!, tz)}: ${why}` };
  }
  if (v.stub) return { ok: true, detail: "model disabled: using canned responses" };
  if (v.floor_required) return { ok: true, detail: v.lease ? `the model requires a test lease: the lease expires at ${hhmm(v.lease.until, tz)}` : "the model requires a test lease: no lease is active" };
  return { ok: true, detail: capNote ?? (forModel ? `waiting for the model: ${forModel}` : "the model is working") };
}

export async function llmHealthCheck(app: Pick<App, "db" | "instanceId" | "settings">): Promise<{ ok: boolean; detail: string }> {
  const v = await llmGateState(app);
  const [gate, retry, held] = await Promise.all([readProcessingSetting(app.db.control, app.instanceId, "llm_gate", LLM_GATE_DEFAULTS),
                                                 readProcessingSetting(app.db.control, app.instanceId, "llm_retry", LLM_RETRY_DEFAULTS),
                                                 nightCapHeld(app, new Date(v.checked_at))]);
  return llmHealth(v, new Date(v.checked_at), { waiting_alert_hours: Number(gate.waiting_alert_hours), now_patience_min: Number(retry.now_patience_min), night_cap_held: held }, instanceTz(app.settings));
}

export async function llmSettingsSaved(app: Pick<App, "db" | "instanceId">, items: Array<{ category?: unknown; key?: unknown }>): Promise<{ probed: boolean; faultReset: boolean }> {
  let probed = false, faultReset = false;
  if (items.some((i) => i?.category === "models")) {
    const st = await readGateState(app.db.control, app.instanceId);
    if (st.breaker.reason === "config" && breakerOpen(st.breaker, st.dbNow)) { await probeNow(app.db.control, app.instanceId); probed = true; }
  }
  if (items.some((i) => i?.category === "processing" && i?.key === "llm_fault")) { await resetFaultProbe(app.db.control, app.instanceId); faultReset = true; }
  if (probed) resetGateSnapshot();
  return { probed, faultReset };
}

async function body(c: Context<any>): Promise<Record<string, unknown>> {
  const b = await c.req.json().catch(() => { throw invalid("The request body is not JSON"); });
  if (!b || typeof b !== "object" || Array.isArray(b)) throw invalid("The request body must be a JSON object");
  return b as Record<string, unknown>;
}
const ownerOf = (v: unknown): string => {
  if (typeof v !== "string" || !OWNER_RE.test(v)) throw invalid("owner must be 1 to 80 characters: Latin letters, digits and . _ : @ -");
  return v;
};
const ttlOf = (v: unknown, lo: number, hi: number, text: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) throw invalid(text);
  return v;
};
async function conflicts<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) { if (e instanceof LlmGateConflict) throw conflict(e.message, e.details); throw e; }
}

export function registerLlmGateRoutes(r: Hono<any>, app: App, adminAudit: AdminAudit): void {
  const ctl = app.db.control;

  r.get("/llm-gate", async (c) => c.json(await llmGateState(app)));

  r.put("/llm-gate/hold", async (c) => {
    const b = await body(c);
    const owner = ownerOf(b.owner);
    const ttl = ttlOf(b.ttl_sec, 30, 14_400, "Pause duration (ttl_sec) must be a whole number from 30 seconds to 4 hours");
    if (!REASONS.includes(b.reason as HoldReason)) throw invalid("Pause reason (reason) must be floor (test queue), test (test) or admin (administrator)");
    if (b.note !== undefined && b.note !== null && (typeof b.note !== "string" || b.note.length > 120)) throw invalid("Explanation (note) must be a string of up to 120 characters");
    const out = await putHold(ctl, app.instanceId, { owner, ttlSec: ttl, reason: b.reason as HoldReason, note: (b.note as string | null | undefined) ?? null });
    resetGateSnapshot();
    if (out.isNew) await adminAudit(c, "llm_hold_set", { owner, reason: b.reason, ttl_sec: ttl });
    return c.json({ holds: out.holds, paused_until: out.paused_until });
  });

  r.delete("/llm-gate/hold", async (c) => {
    if (c.req.query("force") === "1") {
      const out = await forceClearHolds(ctl, app.instanceId);
      resetGateSnapshot();
      await adminAudit(c, "llm_hold_force_cleared", { removed: out.removed });
      return c.json({ holds: out.holds, paused_until: out.paused_until, removed: out.removed });
    }
    const owner = ownerOf(c.req.query("owner"));
    const out = await clearHold(ctl, app.instanceId, owner);
    resetGateSnapshot();
    if (out.removed) await adminAudit(c, "llm_hold_cleared", { owner });
    return c.json({ holds: out.holds, paused_until: out.paused_until });
  });

  r.put("/llm-gate/lease", async (c) => {
    const b = await body(c);
    const owner = ownerOf(b.owner);
    const ttl = ttlOf(b.ttl_sec, 10, 120, "Lease duration (ttl_sec) must be a whole number from 10 seconds to 2 minutes");
    const out = await conflicts(() => putLease(ctl, app.instanceId, owner, ttl));
    resetGateSnapshot();
    if (out.isNew) await adminAudit(c, "llm_lease_granted", { owner, ttl_sec: ttl });
    return c.json({ lease: out.lease });
  });

  r.delete("/llm-gate/lease", async (c) => {
    const owner = ownerOf(c.req.query("owner"));
    const out = await conflicts(() => revokeLease(ctl, app.instanceId, owner));
    resetGateSnapshot();
    if (out.revoked) await adminAudit(c, "llm_lease_revoked", { owner });
    return c.json({ lease: out.lease });
  });

  r.put("/llm-gate/arbiter", async (c) => {
    const b = await body(c);
    const owner = ownerOf(b.owner);
    const ttl = ttlOf(b.ttl_sec, 15, 300, "Registration duration (ttl_sec) must be a whole number from 15 seconds to 5 minutes");
    const out = await conflicts(() => putArbiter(ctl, app.instanceId, owner, ttl));
    if (out.isNew) await adminAudit(c, "llm_arbiter_registered", { owner, ttl_sec: ttl });
    return c.json({ arbiter: out.arbiter });
  });

  r.delete("/llm-gate/arbiter", async (c) => {
    const owner = ownerOf(c.req.query("owner"));
    await conflicts(() => clearArbiter(ctl, app.instanceId, owner));
    return c.json({ arbiter: null });
  });

  r.post("/llm-gate/probe", async (c) => {
    const breaker = await probeNow(ctl, app.instanceId);
    resetGateSnapshot();
    await adminAudit(c, "llm_probe", { reason: breaker.reason, busy_streak: breaker.busy_streak, slow_streak: breaker.slow_streak });
    return c.json({ breaker });
  });
}
