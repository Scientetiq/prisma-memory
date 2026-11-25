// Pass of the `converted` stage under the converter breaker.
//
// convertDocument (convert.ts) knows only the document: upload, run wait, result, open check and outcome.
// This layer wraps it, shared by all process documents:
//   1. BEFORE a pass — the admin's pause (`processing.converter_holds`) and the breaker `converter_gate`: open —
//      StageWait (no attempt spent, the job is set to the breaker's term); term over — one job atomically takes the
//      probe (`probe_by`) and tries: unavailable — `GET /api/v1/health` with no login; `config`/`locked` — login. Success
//      closes the breaker, failure opens it again; the others wait 15 s.
//   2. AFTER an error — class by the error table: unavailable (no connection, 502; 503, 504, timeout — only on a failed
//      health probe) → breaker and wait; account refused or not set up → `config`; 429 at login → `locked`;
//      503, 504, timeout with health fine → an error of THIS document (`doc_error`): own pause 1 → 30 min, counter
//      `conversion.doc_errors`, after `converter_doc_error_max` — failed with attempts used up; storage failure → wait
//      for storage. A step error and a final refusal go to runStage as before (job_error 5 → 25 min, terminal).
//   3. AFTER success — breaker closed, `last_ok_at`, `last_result_at` (for computed stalled); cleared: the mismatch
//      counter, `new_block` and the recovery after unavailability.
// The «new» pause (`holds = new`) does not hold here: admission decides it (convertDocument → admitConversion) — records
// already at the converter (intent, run) are brought to the end.
// One login session per process (converterSession); after each login the account fingerprint goes to
// `converter_gate.principal`; a change — event `principal_changed`.
// The fast lane flag (`caps`) — refreshConverterCaps: at worker start and every 10 min (not from a document pass:
// the pass is short; the admin enables office after the converter rollout — a 10-minute wait breaks nothing).
// Journal: `processing {job: "conversion", op: gate_open | gate_close | alert | principal_changed | caps_changed}`, no content;
// stage waits do not litter the journal (afterStage skips `converter_wait:*`). A document waits longer than 6 h —
// alert `alert {reason: long_wait}` (noteLongWait).
import { randomUUID } from "node:crypto";
import { capsChanged, capsChangedEvent, claimConverterProbe, classifyConverterErrorWithHealth, ConverterClient, converterConfig, ConverterError, converterGateDecision, converterHealth,
         converterSession, converterSettingsFingerprint, docErrorWaitSec, fetchConverterCaps, gateAfterConfig, gateAfterLocked, gateAfterOk, gateAfterUnavailable, gateNeedsAlert, gateWithCaps, log,
         patienceExceeded, readConverterGate, readConverterHolds, storageWaitSec, throttledWaitSec, updateConverterGate, type ConverterClassified, type ConverterConfig, type ConverterGateDecision,
         type ConverterGateState, type ConverterLoginEvent } from "@memory/shared";
import { conversionEvent, noteConversionMismatch } from "../conversion-queue.ts";
import { conversionPhase, CYCLE_END_DROP, LONG_WAIT_ALERT_EVERY_MS, longWaitCheck, nextActionFor, pendingAction } from "../conversion-rules.ts";
import { auditWorker, recordsDb, type Ctx } from "../ctx.ts";
import { StageClaimLost, StageRefused, StageWait, type StageClaim, type StageJob } from "../stages.ts";
import { convertDocument, patchConversion, type ConvertOutcome } from "./convert.ts";

/** How long to wait after a request is aborted by a worker stop (`aborted`). */
const ABORTED_WAIT_SEC = 15;

/** Fingerprint of the login settings as they are (also for an unset converter: filling the settings changes it). */
function settingsFp(ctx: Ctx): string {
  return converterSettingsFingerprint({ url: ctx.settings.str("integrations.converter_url"), login: ctx.settings.str("integrations.converter_login"),
                                        secret: ctx.settings.str("integrations.converter_password") });
}

/** Event on the breaker and converter account: only codes, numbers and time. */
function gateEvent(ctx: Ctx, job: StageJob | null, details: Record<string, unknown>): Promise<void> {
  return auditWorker(ctx, { event_type: "processing", ...(job ? { class: job.class, record_ids: [job.record_id] } : {}), details: { job: "conversion", ...details } });
}

/** How often the worker re-reads the converter's fast lane flag (`GET /api/contract`, no login), ms. */
export const CONVERTER_CAPS_EVERY_MS = 600_000;

/**
 * Converter capabilities flag — into the breaker row `caps`: whether the fast lane is there and the version
 * of the contract. The gateway accepts office formats by it (convertibleFormats): before it, only PDF. Read
 * at worker start and every 10 min; no login. No connection or an answer of the wrong
 * form — the old flag stays. A change — log and event `processing {job: "conversion", op: "caps_changed"}`. Not set up
 * — does nothing. Returns the written flag or null.
 */
export async function refreshConverterCaps(ctx: Ctx): Promise<{ fast_lane: boolean; version: string | null } | null> {
  const cfg = converterConfig(ctx.settings);
  if (!cfg) return null;
  const got = await fetchConverterCaps(cfg);
  if (!got.ok) { log.info("converter_caps_unknown", { status: got.status }); return null; }
  const r = await updateConverterGate(ctx.db.control, ctx.instanceId, (cur, now) => ({ value: gateWithCaps(cur, now, got.caps), out: cur.caps }));
  if (capsChanged(r.out, got.caps)) {
    const ev = capsChangedEvent(r.out, got.caps);
    log.info("converter_caps_changed", { fast_lane: ev.fast_lane, version: ev.version, was_fast_lane: ev.was_fast_lane, previous_version: ev.previous_version });
    await gateEvent(ctx, null, ev);
  }
  return got.caps;
}

/** Write a breaker transition: a change «closed ↔ open» — a journal event and a log line. */
async function gateTransition(ctx: Ctx, job: StageJob | null, before: ConverterGateState, after: ConverterGateState): Promise<void> {
  if (before.state === "closed" && after.state !== "closed") {
    log.warn("converter_gate_open", { reason: after.reason, why: after.why, streak: after.streak, until: after.open_until, record_id: job?.record_id ?? null });
    await gateEvent(ctx, job, { op: "gate_open", reason: after.reason, why: after.why, streak: after.streak, until: after.open_until });
  } else if (before.state !== "closed" && after.state === "closed") {
    const openMs = before.opened_at ? Date.now() - Date.parse(before.opened_at) : null;
    log.info("converter_gate_close", { was: before.reason, open_ms: openMs, record_id: job?.record_id ?? null });
    await gateEvent(ctx, job, { op: "gate_close", was: before.reason, open_ms: openMs });
  } else if (before.reason !== after.reason && after.state !== "closed") {
    log.warn("converter_gate_reason", { from: before.reason, to: after.reason, why: after.why });
    await gateEvent(ctx, job, { op: "gate_open", reason: after.reason, why: after.why, streak: after.streak, until: after.open_until });
  }
}

/** Set the breaker (under the row lock) and log the transition. */
async function changeGate(ctx: Ctx, job: StageJob | null, fn: (cur: ConverterGateState, now: Date) => ConverterGateState): Promise<ConverterGateState> {
  const r = await updateConverterGate(ctx.db.control, ctx.instanceId, (cur, now) => ({ value: fn(cur, now), out: null }));
  if (r.after !== r.before) await gateTransition(ctx, job, r.before, r.after);
  return r.after;
}

/**
 * After each process session login: the account fingerprint — into `converter_gate.principal`. Account changed (other
 * settings of another install, a settings error) — log and event: by this fingerprint the «watchdog» build tells
 * «no run» from «a run of another account».
 */
async function recordPrincipal(ctx: Ctx, ev: ConverterLoginEvent): Promise<void> {
  if (!ev.principal) return;
  const r = await updateConverterGate(ctx.db.control, ctx.instanceId, (cur) =>
    cur.principal === ev.principal ? { value: cur, out: null as string | null } : { value: { ...cur, principal: ev.principal }, out: cur.principal });
  if (r.out) {
    log.warn("converter_principal_changed", { generation: ev.generation });
    await gateEvent(ctx, null, { op: "principal_changed" });
  }
}

/** Process session for these settings; the login callback is set once. */
function sessionFor(ctx: Ctx, cfg: ConverterConfig) {
  const session = converterSession(cfg);
  if (!session.onLogin) session.onLogin = (ev) => recordPrincipal(ctx, ev);
  return session;
}

/** Stage's first mark of waiting for a busy service (`first_busy_at`; kept by StageWait busy). */
async function firstBusyAt(ctx: Ctx, job: StageJob): Promise<{ firstBusyAt: Date | null; busyRetries: number }> {
  const r = (await recordsDb(ctx, job.class).query("SELECT first_busy_at, busy_retries FROM record_stages WHERE record_id = $1 AND stage = 'converted'", [job.record_id])).rows[0];
  return { firstBusyAt: r?.first_busy_at ? new Date(r.first_busy_at) : null, busyRetries: Number(r?.busy_retries ?? 0) };
}

/**
 * Patience with an unavailable converter (`integrations.converter_patience_hours`): used up — a non-final failed
 * with attempts used up and words for people. 0 (the default) — wait with no limit.
 * A final failure shows in `conversion` too (else the stage is failed but the mark is «pending» forever, and agents
 * get «still processing»): a fenced failed mark, the phase cleared, `next_action` — by the phase.
 */
async function checkPatience(ctx: Ctx, job: StageJob, now: Date, claim?: StageClaim): Promise<void> {
  const hours = Number(ctx.settings.get("integrations.converter_patience_hours", 0)) || 0;
  if (hours <= 0) return;
  const { firstBusyAt: since } = await firstBusyAt(ctx, job);
  if (!patienceExceeded(since, hours, now)) return;
  await markPatience(ctx, job, claim, hours);
  throw new ConverterError("network", `converter has not responded for ${hours} h. The administrator can retry processing`, undefined, false, undefined, "converter_patience", { exhausted: true });
}

/** Mark «converter silent for N h» in `conversion` (fenced by the claim) and a journal event; no content. */
async function markPatience(ctx: Ctx, job: StageJob, claim: StageClaim | undefined, hours: number): Promise<void> {
  const db = recordsDb(ctx, job.class);
  const raw = (await db.query("SELECT attrs -> 'conversion' AS conv FROM records WHERE id = $1", [job.record_id])).rows[0]?.conv;
  const conv = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const runId = typeof conv.run_id === "string" && conv.run_id ? conv.run_id : null;
  const next = nextActionFor({ phase: conversionPhase(conv), pendingKind: pendingAction(conv)?.kind ?? null, code: null, runId });
  await patchConversion(db, job.record_id, { status: "failed", error_kind: "converter_patience", error_code: "converter_patience", next_action: next }, claim, CYCLE_END_DROP);
  log.warn("converter_patience_exhausted", { record_id: job.record_id, run_id: runId, hours, next_action: next });
  await conversionEvent(ctx, job, { op: "failed", code: "converter_patience", error_kind: "converter_patience", next_action: next, run_id: runId });
}

/** Alert «converter unavailable for over 4 h» — once per episode. */
async function maybeAlert(ctx: Ctx, gate: ConverterGateState, now: Date): Promise<void> {
  if (!gateNeedsAlert(gate, now)) return;
  const r = await updateConverterGate(ctx.db.control, ctx.instanceId, (cur, dbNow) =>
    gateNeedsAlert(cur, dbNow) ? { value: { ...cur, alerted: { reason: "unavailable", at: dbNow.toISOString() } }, out: true } : { value: cur, out: false });
  if (!r.out) return;
  const hours = gate.opened_at ? Math.floor((now.getTime() - Date.parse(gate.opened_at)) / 3600_000) : null;
  log.warn("converter_alert", { reason: "unavailable", hours });
  await gateEvent(ctx, null, { op: "alert", reason: "unavailable", hours });
}

/** Decision «wait» → StageWait (converter unavailable — with patience check and alert). */
async function waitFor(ctx: Ctx, job: StageJob, d: Extract<ConverterGateDecision, { kind: "wait" }>, gate: ConverterGateState, now: Date, claim?: StageClaim): Promise<never> {
  if (gate.reason === "unavailable" && d.busy) { await maybeAlert(ctx, gate, now); await checkPatience(ctx, job, now, claim); }
  throw new StageWait(d.until, d.code, d.busy);
}

/**
 * Before a pass: pause and breaker. Returns — work can go on; else StageWait (or a non-final
 * failed, if patience ran out). A half-open breaker tries exactly one job.
 */
async function gateBefore(ctx: Ctx, job: StageJob, cfg: ConverterConfig | null, fp: string, claim?: StageClaim): Promise<void> {
  // the pause — from the DB settings row: «Resume» acts on the very first pass, not a minute later (readConverterHolds)
  const holds = await readConverterHolds(ctx.db.control, ctx.instanceId, ctx.settings.get<unknown>("processing.converter_holds", null));
  // the «new» pause is for admission: here only «stop all»
  const fresh = false;
  // not set up — breaker `config` (documents wait; filling the settings changes the fingerprint and clears it)
  if (!cfg) {
    if (holds === "all") throw new StageWait(new Date(Date.now() + 300_000), "converter_wait:hold");
    await changeGate(ctx, job, (cur, now) => gateAfterConfig(cur, now, fp, "not_configured"));
    throw new StageWait(new Date(Date.now() + 300_000), "converter_wait:config", true);
  }
  const { gate, dbNow } = await readConverterGate(ctx.db.control, ctx.instanceId);
  const d = converterGateDecision(gate, dbNow, { holds, fresh, settingsFp: fp });
  if (d.kind === "pass") return;
  if (d.kind === "wait") return waitFor(ctx, job, d, gate, dbNow, claim);
  const owner = claim?.token ?? randomUUID();
  const probe = await claimConverterProbe(ctx.db.control, ctx.instanceId, owner, fp);
  if (!probe.claimed) {
    if (probe.decision.kind === "pass") return;
    if (probe.decision.kind === "wait") return waitFor(ctx, job, probe.decision, gate, dbNow, claim);
    throw new StageWait(new Date(Date.now() + 15_000), `converter_wait:${gate.reason ?? "unavailable"}`, true);
  }
  log.info("converter_gate_probe", { reason: probe.reason, settings_changed: probe.settingsChanged, record_id: job.record_id });
  if (probe.reason === "unavailable") {
    // unavailability probe — liveness with no login, not a request for a document (one broken draft does not hold the breaker)
    const h = await converterHealth(cfg, { force: true });
    if (h.ok) { await changeGate(ctx, job, (cur, now) => gateAfterOk(cur, now, { health: true })); return; }
    const after = await changeGate(ctx, job, (cur, now) => gateAfterUnavailable(cur, now, h.status === null ? "health_unreachable" : `health_${h.status}`));
    await checkPatience(ctx, job, dbNow, claim);
    throw new StageWait(after.open_until ? new Date(after.open_until) : new Date(Date.now() + 15_000), "converter_wait:unavailable", true);
  }
  // `config` and `locked` — a login probe: the session logs in again (one per process); failed — the breaker again
  try {
    await new ConverterClient(cfg, { session: sessionFor(ctx, cfg), ...(ctx.abort ? { signal: ctx.abort } : {}) }).login();
  } catch (e) {
    const c = await classifyConverterErrorWithHealth(e, async () => (await converterHealth(cfg)).ok);
    await applyGateClass(ctx, job, c, fp, true);
    throw await waitForClass(ctx, job, c, claim);
  }
  await changeGate(ctx, job, (cur, now) => gateAfterOk(cur, now, { settingsFp: fp }));
}

/** Open the breaker by the error class (unavailable, config, locked); other classes leave it alone. */
async function applyGateClass(ctx: Ctx, job: StageJob, c: ConverterClassified, fp: string, probe = false): Promise<ConverterGateState | null> {
  if (c.cls === "unavailable") return changeGate(ctx, job, (cur, now) => gateAfterUnavailable(cur, now, c.code));
  if (c.cls === "config") return changeGate(ctx, job, (cur, now) => gateAfterConfig(cur, now, fp, c.code, probe));
  if (c.cls === "locked" && !c.short) return changeGate(ctx, job, (cur, now) => gateAfterLocked(cur, now, c.retryAfterSec, Math.floor(Math.random() * 30), c.code));
  return null;
}

/** Wait by the breaker error class: the term — its `open_until` (at most 5 min, at least 15 s), the reason — its kind. */
async function waitForClass(ctx: Ctx, job: StageJob, c: ConverterClassified, claim?: StageClaim): Promise<StageWait | ConverterError> {
  const { gate, dbNow } = await readConverterGate(ctx.db.control, ctx.instanceId);
  if (c.cls === "locked" && c.short) return new StageWait(new Date(dbNow.getTime() + throttledWaitSec(c.retryAfterSec) * 1000), "converter_wait:throttled", false);
  const reason = gate.state !== "closed" && gate.reason ? gate.reason : c.cls;
  if (reason === "unavailable") {
    try { await maybeAlert(ctx, gate, dbNow); await checkPatience(ctx, job, dbNow, claim); }
    catch (e) { if (e instanceof ConverterError) return e; throw e; }
  }
  const until = gate.open_until ? Date.parse(gate.open_until) : dbNow.getTime() + 300_000;
  const at = Math.max(dbNow.getTime() + 15_000, Math.min(until, dbNow.getTime() + 300_000));
  return new StageWait(new Date(at), `converter_wait:${reason}`, true);
}

/**
 * Document error (`doc_error`): DC is healthy but does not give out this document. Own pause 60 s · 2ⁿ ≤ 30 min and
 * counter `conversion.doc_errors` (fenced by the claim); after `converter_doc_error_max` — non-final failed with
 * attempts used up «the converter does not give out this document's result»: phase cleared, `next_action` — by the phase,
 * plus the mismatch counter (under its block — wait, not failed). Result `done` clears the counter (it replaces
 * the mark), as does a new «Retry» (convertDocument).
 */
async function docError(ctx: Ctx, job: StageJob, claim: StageClaim | undefined, c: ConverterClassified, e: unknown): Promise<StageWait | ConverterError> {
  const db = recordsDb(ctx, job.class);
  const r = (await db.query(
    `SELECT attrs -> 'conversion' ->> 'doc_errors' AS n, attrs -> 'conversion' ->> 'first_doc_error_at' AS since,
            attrs -> 'conversion' ->> 'doc_error_limit_at' AS limit_at, attrs -> 'conversion' AS conv FROM records WHERE id = $1`, [job.record_id])).rows[0];
  const conv = (r?.conv && typeof r.conv === "object" ? r.conv : {}) as Record<string, unknown>;
  // the limit was already used up: a used-up failed does not retry by itself, so this pass is after «Retry» or «Process
  // now», and the series starts anew (the last series' counter stays in the mark until now — for analysis)
  const fresh = Boolean(r?.limit_at);
  const n = fresh ? 0 : Math.max(0, Math.floor(Number(r?.n ?? 0)) || 0);
  const max = Math.max(1, Math.floor(Number(ctx.settings.get("integrations.converter_doc_error_max", 8))) || 8);
  const status = e instanceof ConverterError ? e.status : undefined;
  const now = new Date().toISOString();
  const limit = n + 1 >= max;
  const firstAt = fresh ? now : r?.since ?? now;
  if (limit) {
    // mismatch: DC is healthy but gives no result for the document; under the block — wait, no attempt spent
    const m = await noteConversionMismatch(ctx, job, "doc_error_limit").catch(() => ({ blocked: false }));
    if (m.blocked) {
      await patchConversion(db, job.record_id, { doc_errors: n + 1, first_doc_error_at: firstAt, doc_error_code: c.code }, claim);
      return new StageWait(new Date(Date.now() + 300_000), "converter_wait:mismatch", false);
    }
    const phase = conversionPhase(conv);
    const runId = typeof conv.run_id === "string" ? conv.run_id : null;
    // run done but the result is not given out — a new run; the poll does not answer — poll again; upload — by intent
    const next = phase === "fetching" && runId ? "new_run" : nextActionFor({ phase, pendingKind: pendingAction(conv)?.kind ?? null, code: null, runId });
    await patchConversion(db, job.record_id, { doc_errors: n + 1, first_doc_error_at: firstAt, doc_error_code: c.code, doc_error_limit_at: now,
                                               status: "failed", error_kind: "converter_doc_error", error_code: "doc_error_limit", next_action: next },
                          claim, CYCLE_END_DROP);
    log.warn("converter_doc_error", { record_id: job.record_id, code: c.code, status: status ?? null, doc_errors: n + 1, max, limit: true });
    await gateEvent(ctx, job, { op: "doc_error_limit", code: c.code, doc_errors: n + 1, next_action: next, run_id: runId });
    return new ConverterError("http", "converter is running but has not returned the result for this document. The administrator will investigate", status, false, undefined, "doc_error_limit", { exhausted: true });
  }
  await patchConversion(db, job.record_id, { doc_errors: n + 1, first_doc_error_at: firstAt, doc_error_code: c.code, doc_error_limit_at: null }, claim);
  log.warn("converter_doc_error", { record_id: job.record_id, code: c.code, status: status ?? null, doc_errors: n + 1, max });
  // «at the converter since …»: the code tail is the cycle's first send time; the workplace shows HH:MM
  const since = [conv.submitted_at, conv.run_started_at, firstAt].find((v) => typeof v === "string" && v) as string;
  return new StageWait(new Date(Date.now() + docErrorWaitSec(n) * 1000), `converter_wait:doc_error: ${since}`, false);
}

/** Pass error → what to throw to runStage: StageWait (wait, no attempt spent) or the original error (step, refusal). */
async function afterError(ctx: Ctx, job: StageJob, claim: StageClaim | undefined, cfg: ConverterConfig | null, fp: string, e: unknown): Promise<unknown> {
  const c = await classifyConverterErrorWithHealth(e, async () => (cfg ? (await converterHealth(cfg)).ok : false));
  switch (c.cls) {
    case "unavailable": case "config": case "locked":
      await applyGateClass(ctx, job, c, fp);
      return waitForClass(ctx, job, c, claim);
    case "doc_error":
      return docError(ctx, job, claim, c, e);
    case "storage": {
      const { busyRetries } = await firstBusyAt(ctx, job);
      log.warn("converter_storage_wait", { record_id: job.record_id, code: c.code, busy_retries: busyRetries });
      return new StageWait(new Date(Date.now() + storageWaitSec(busyRetries) * 1000), "converter_wait:storage", true);
    }
    case "aborted":
      return new StageWait(new Date(Date.now() + ABORTED_WAIT_SEC * 1000), "converter_wait:aborted", false);
    default:
      return e;                                                    // step error and final refusal — runStage, as before
  }
}

/**
 * Soft wait term: a document waits in the queue or at the converter longer than 6 h — an alert
 * to the admin: log `converter_alert` and event `processing {op: alert, reason: long_wait}`, once per cycle per record and
 * at most hourly for all of memory (`converter_gate.wait_alert_at`). Counted from the cycle's first send (`submitted_at`),
 * for an unsent one — from the cycle's wait start (`waiting_since`, marked here by the first wait). The marks are
 * fenced by the claim. Any failure — a log line only: the stage wait does not depend on the alert.
 */
async function noteLongWait(ctx: Ctx, job: StageJob, claim: StageClaim | undefined): Promise<void> {
  const db = recordsDb(ctx, job.class);
  const r = (await db.query("SELECT attrs -> 'conversion' AS conv, now() AS db_now FROM records WHERE id = $1", [job.record_id])).rows[0];
  if (!r) return;
  const conv = (r.conv && typeof r.conv === "object" && !Array.isArray(r.conv) ? r.conv : {}) as Record<string, unknown>;
  const now = new Date(r.db_now ?? Date.now());
  const c = longWaitCheck(conv, now);
  if (c.start) { await patchConversion(db, job.record_id, { waiting_since: now.toISOString() }, claim); return; }
  if (!c.alert) return;
  const g = await updateConverterGate(ctx.db.control, ctx.instanceId, (cur, dbNow) => {
    const last = cur.wait_alert_at ? Date.parse(cur.wait_alert_at) : NaN;
    return Number.isFinite(last) && dbNow.getTime() - last < LONG_WAIT_ALERT_EVERY_MS ? { value: cur, out: false } : { value: { ...cur, wait_alert_at: dbNow.toISOString() }, out: true };
  });
  if (!g.out) return;
  await patchConversion(db, job.record_id, { wait_alerted_at: now.toISOString() }, claim);
  const runId = typeof conv.run_id === "string" ? conv.run_id : null;
  log.warn("converter_alert", { reason: "long_wait", record_id: job.record_id, run_id: runId, hours: c.hours });
  await gateEvent(ctx, job, { op: "alert", reason: "long_wait", hours: c.hours, run_id: runId });
}

/**
 * Pass of stage `converted` (worker HANDLERS): breaker and pause → convertDocument → error classes. Outcomes — as in
 * convertDocument; a wait — StageWait (runStage: pending with a term, the attempt returned), with it — the soft wait
 * term check.
 */
export async function convertPass(ctx: Ctx, job: StageJob, claim?: StageClaim): Promise<ConvertOutcome> {
  try { return await passOnce(ctx, job, claim); }
  catch (e) {
    if (e instanceof StageWait)
      await noteLongWait(ctx, job, claim).catch((err) => {
        // claim lost — another process runs the stage and marks it; the rest — a log line only
        if (!(err instanceof StageClaimLost)) log.warn("converter_long_wait_note_failed", { record_id: job.record_id, error: String((err as Error)?.message ?? err).slice(0, 120) });
      });
    throw e;
  }
}

async function passOnce(ctx: Ctx, job: StageJob, claim?: StageClaim): Promise<ConvertOutcome> {
  const cfg = converterConfig(ctx.settings);
  const fp = settingsFp(ctx);
  if (cfg) sessionFor(ctx, cfg);
  await gateBefore(ctx, job, cfg, fp, claim);
  let out: ConvertOutcome;
  try {
    out = await convertDocument(ctx, job, claim);
  } catch (e) {
    if (e instanceof StageClaimLost || e instanceof StageRefused || e instanceof StageWait) throw e;
    throw await afterError(ctx, job, claim, cfg, fp, e);
  }
  // the converter answered and the run ended: breaker closed, marks for computed stalled (a write failure — only logged)
  if (out === "done")
    await changeGate(ctx, job, (cur, now) => gateAfterOk(cur, now, { result: true })).catch((e) => log.warn("converter_gate_note_failed", { error: (e as Error).message.slice(0, 120) }));
  return out;
}
