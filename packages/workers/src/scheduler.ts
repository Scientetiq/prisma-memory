// Stage scheduler: a job for the record's nearest ready stage, the stage outcome (journal, derived records,
// next stage), a periodic pass over records. Moved out of index.ts so the model stage dispatcher and tests with a
// real database use the same code as the worker.
import { LLM_RETRY_DEFAULTS, SUPERSEDED_STAGE_NOTE, inWindow, liveApplicationNames, log, nextWindowStart, type DataClass, type NightWindow, type SlotRow } from "@memory/shared";
import { auditWorker, recordsDb, type Ctx, type StageUsage } from "./ctx.ts";
import { CONVERTER_WAIT_PREFIX, indexRetryDelaySec, LLM_STAGES, nextStage, QUEUE_OF, stageExpireSec, TOO_SLOW_PREFIX, versionFor, type LlmStageResult, type RunStageStatus, type Stage, type StageJob } from "./stages.ts";
import { moveClass, purgeSerial } from "./jobs/maintenance.ts";
import { wakeConversionQueue } from "./conversion-queue.ts";
import { MODEL_BUDGET_TEXT, MODEL_POLICY_TEXT, slowDelaySec } from "./retry-policy.ts";
import { warmDerived } from "./jobs/indexing.ts";

/** Model stage queues — served by the dispatcher under a slot (llm-dispatch.ts), not by boss.work. */
export const LLM_QUEUES = [...LLM_STAGES].map((s) => QUEUE_OF[s]);
/** Priority of a day-lane job of a document that entered the "now" lane by default at upload: below 10, still ≥ 1 (daytime). */
export const INTAKE_PRIORITY = 5;
/** Priority of a model job of the day lane: a meeting, an explicit "process now" (a document of the day lane by default — INTAKE_PRIORITY). */
export const NOW_PRIORITY = 10;
const LLM_STAGE_LIST = [...LLM_STAGES];
/**
 * `last_error` patterns of a stage that waits for a permission, not for a model: the data policy refuses
 * the pair or the money budget is exhausted. The night lane would not change either.
 */
const WAITS_FOR_PERMISSION = [MODEL_POLICY_TEXT, MODEL_BUDGET_TEXT].map((t) => `${t.slice(0, t.indexOf(":") + 1)}%`);
/** Model job heartbeat: the dispatcher touches a job every 20 s; silent a minute — a zombie, removed by the pg-boss monitor. */
export const LLM_HEARTBEAT_SEC = 60;
/**
 * Heartbeat of conversion jobs: the pg-boss handler touches the job every 30 s itself; the process
 * died mid-pass (SIGKILL, OOM) — the pg-boss monitor removes the `active` job a minute later, not by the job lifetime (up to
 * an hour at night). Else the stately queue activates no new job of that key, the record stays in flight, and at K = 1
 * all of it halts.
 */
export const CONVERT_HEARTBEAT_SEC = 60;
const ORPHAN_TEXT = "worker_restart: the stage was orphaned because the worker stopped mid-run";
export { INDEX_RETRY_MIN_SEC } from "./stages.ts";

export type StageStatus = LlmStageResult["status"] | "done" | "skipped" | "handoff" | "failed";

export interface Scheduler {
  schedule(cls: DataClass, recordId: string, laneHint?: "now" | "night" | "index", queued?: Set<string>, delaySec?: number): Promise<void>;
  afterStage(job: StageJob, res: LlmStageResult, used: StageUsage): Promise<void>;
  scan(): Promise<void>;
  /**
   * «Wake the next» in the conversion queue: the first candidates for free places lose their term,
   * their job is moved to now or queued — the lane unchanged. The number woken.
   */
  wakeConversionQueue(): Promise<number>;
}

/**
 * Orphans of model stages: `running`, claimed by a process that no longer runs it. Only a stage
 * under a slot runs: its holder lives, its slot row is held and points here; all else over 30 s old is an orphan
 * (process dead or stage dropped). The attempt stays — a guard against a record killing a process.
 */
export async function reclaimLlmOrphans(ctx: Pick<Ctx, "instanceId" | "db" | "settings">, cls: DataClass): Promise<number> {
  const limit = ctx.settings.get("processing.retries", { limit: 3 }).limit;
  const db = recordsDb(ctx, cls);
  const owners = (await db.query(
    `SELECT DISTINCT claimed_by FROM record_stages WHERE status = 'running' AND stage = ANY($1) AND claimed_by IS NOT NULL AND updated_at < now() - interval '30 seconds'`,
    [LLM_STAGE_LIST])).rows.map((r) => r.claimed_by as string);
  if (!owners.length) return 0;
  const slot = ((await ctx.db.control.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = 'llm_slot'", [ctx.instanceId])).rows[0]?.value ?? {}) as SlotRow & { owner?: string; record_id?: string | null; stage?: string | null };
  const live = await liveApplicationNames(ctx.db.control, owners);
  const holder = slot.owner && !slot.released_at && live.has(slot.owner) ? slot.owner : null;
  const r = await db.query(
    `UPDATE record_stages SET status = (CASE WHEN attempts >= $2 THEN 'failed' ELSE 'pending' END)::stage_status, claim_token = NULL, last_error = $3, updated_at = now()
      WHERE status = 'running' AND stage = ANY($1) AND claimed_by IS NOT NULL AND updated_at < now() - interval '30 seconds'
        AND NOT (claimed_by = $4 AND record_id::text = COALESCE($5, record_id::text) AND stage::text = COALESCE($6, stage::text))
      RETURNING record_id, stage`,
    [LLM_STAGE_LIST, limit, ORPHAN_TEXT, holder ?? "", holder ? slot.record_id ?? null : null, holder ? slot.stage ?? null : null]);
  if (r.rowCount) log.warn("llm_orphan_reclaimed", { class: cls, stages: r.rowCount, holder: Boolean(holder) });
  return r.rowCount ?? 0;
}

/**
 * Return of orphaned stages at worker start (before the handlers and the dispatcher). A worker restart mid-job
 * leaves the stage in `running`. With one worker instance any non-model `running` at start is
 * orphaned: it goes back to pending at once, not after the «over 2 hours» rule. The attempt was counted at the claim
 * — not added a second time; with the limit used up the stage goes to failed: pending attempts are not checked, and
 * a record that kills the worker would else spin in restarts forever. With several instances the setting
 * processing.reclaim_running_on_start is switched off — then only the job lifetime works. Model stages — only
 * orphans (their holder is seen by the slot's connection name), whatever the setting; claimed by old code (claimed_by
 * empty) — as non-model stages.
 */
export async function reclaimOnStart(ctx: Pick<Ctx, "instanceId" | "db" | "settings">): Promise<void> {
  for (const cls of ["open", "closed"] as DataClass[]) {
    if (ctx.settings.get("processing.reclaim_running_on_start", true)) {
      const limit = ctx.settings.get("processing.retries", { limit: 3 }).limit;
      const n = (await recordsDb(ctx, cls).query(
        `UPDATE record_stages SET status = (CASE WHEN attempts >= $1 THEN 'failed' ELSE 'pending' END)::stage_status,
           last_error = 'worker_restart: stage was orphaned when the worker restarted', updated_at = now()
         WHERE status = 'running' AND (NOT (stage = ANY($2)) OR claimed_by IS NULL)`, [limit, LLM_STAGE_LIST])).rowCount ?? 0;
      if (n) log.warn("stages_reclaimed_on_start", { class: cls, stages: n });
    }
    await reclaimLlmOrphans(ctx, cls);
  }
}

export function makeScheduler(ctx: Ctx, win: () => NightWindow): Scheduler {
  const settings = ctx.settings, boss = ctx.boss;
  let nightWakeCursor: string | null = null;

  /** Off also removes a clock wait already stored by pg-boss. Stage retry deadlines still apply. */
  async function wakeNightJobs(): Promise<void> {
    if (win().mode !== "off") { nightWakeCursor = null; return; }
    const { rows } = await ctx.db.control.query(
      `SELECT id, name, data FROM pgboss.job WHERE name = ANY($1) AND state = 'created' AND priority = 0
         AND start_after > now() AND data->>'instance' = $2 AND data->>'lane' = 'night'
         AND ($3::uuid IS NULL OR id > $3::uuid) ORDER BY id LIMIT 1000`, [LLM_QUEUES, ctx.instanceId, nightWakeCursor]);
    // Page past genuine retry waits too: they must not hide later clock waits on every scan.
    nightWakeCursor = rows.length === 1000 ? rows[rows.length - 1]!.id as string : null;
    for (const row of rows) {
      const job = row.data as StageJob | null;
      if (!job || (job.class !== "open" && job.class !== "closed") || !UUID.test(job.record_id)
        || !LLM_STAGES.has(job.stage) || row.name !== QUEUE_OF[job.stage] || job.version !== await versionFor(ctx, job.stage)) continue;
      const db = recordsDb(ctx, job.class);
      const stage = (await db.query(
        `SELECT retry_at, updated_at, slow_retries, last_error FROM record_stages WHERE record_id = $1 AND stage = $2
           AND (status = 'pending' OR (status = 'failed' AND NOT terminal AND attempts < $3 AND COALESCE(last_error, '') NOT LIKE '${TOO_SLOW_PREFIX}%'))`,
        [job.record_id, job.stage, settings.get("processing.retries", { limit: 3 }).limit])).rows[0];
      if (!stage) continue;
      // Older night timeouts include the next window in retry_at. Recover the backoff from the persisted outcome,
      // then fix the stage as well as pg-boss: the dispatcher's claim checks the stage's deadline again.
      if (stage.retry_at && stage.slow_retries > 0 && String(stage.last_error).startsWith("model_slow:")) {
        const retry = settings.get("processing.llm_retry", LLM_RETRY_DEFAULTS);
        const backoff = new Date(new Date(stage.updated_at).getTime() + slowDelaySec(Number(stage.slow_retries), retry) * 1000);
        if (backoff.getTime() < new Date(stage.retry_at).getTime()) {
          const fixed = await db.query(
            `UPDATE record_stages SET retry_at = $3 WHERE record_id = $1 AND stage = $2 AND status = 'pending'
               AND retry_at = $4 AND updated_at = $5 AND slow_retries = $6 AND last_error = $7 RETURNING retry_at`,
            [job.record_id, job.stage, backoff, stage.retry_at, stage.updated_at, stage.slow_retries, stage.last_error]);
          if (!fixed.rows[0]) continue;
          stage.retry_at = fixed.rows[0].retry_at;
        }
      }
      const at = new Date(Math.max(Date.now(), stage.retry_at ? new Date(stage.retry_at).getTime() : 0));
      await ctx.db.control.query(
        `UPDATE pgboss.job SET start_after = $3 WHERE id = $1 AND name = $2 AND state = 'created' AND priority = 0 AND start_after > $3`,
        [row.id, row.name, at]);
    }
  }

  /**
   * Turns the record's nearest ready stage into a job. singletonKey is record:stage:version, no lane: one stage — one
   * job. The «now» lane goes by upsert: a same-stage job waiting for night becomes a day job (priority, startAfter),
   * not a duplicate; «night» — through send, which returns null when a job already stands (stately). `queued` — keys of jobs
   * already queued (created/retry/active): with it the scheduler does not resend what already waits.
   * A model stage: retries are run by record_stages, hence retryLimit 0; the job is queued no earlier than
   * the stage's retry_at (the retry pause is kept); a night job — from the next window's start.
   */
  async function schedule(cls: DataClass, recordId: string, laneHint?: "now" | "night" | "index", queued?: Set<string>, delaySec = 0): Promise<void> {
    const next = await nextStage(ctx, cls, recordId);
    if (!next) return;
    const lane: "now" | "night" = next.now || laneHint === "now" ? "now" : "night";
    const version = await versionFor(ctx, next.stage), r = settings.get("processing.retries", { limit: 3, delay_sec: 300, backoff: true, expire_now_sec: 900, expire_night_sec: 3600, per_call_sec: 300 });
    const key = `${recordId}:${next.stage}:${version}`;
    if (lane === "night" && queued?.has(key)) return;
    // the job's term — by record size: a long meeting in parts must not be removed mid-work
    // for conversion — by the converter wait term: the job is not removed while waiting for the run and the export
    const expire = stageExpireSec(next.stage, lane, next.tokens, r, settings.get("processing.budgets", { single_call_tokens: 20000, part_tokens: 12000, part_overlap_tokens: 1000 }),
                                  Number(settings.get("integrations.converter_timeout_sec", 900)) || 900);
    const job: StageJob = { instance: ctx.instanceId, class: cls, record_id: recordId, stage: next.stage, version, lane, expire_sec: expire };
    // a document that entered the day lane at upload (process_now_by = intake) yields to meetings and explicit requests
    const priority = lane === "now" ? (next.type === "document" && next.intake ? INTAKE_PRIORITY : NOW_PRIORITY) : 0;
    // delaySec — the pause before a retry after a failed fallback move (fallbackRetryDelaySec): the job
    // waits queued with a term — the scheduler does not duplicate it (queued); an explicit «process now» lifts the pause
    const at = new Date(Math.max(Date.now() + delaySec * 1000, next.retry_at?.getTime() ?? 0));
    if (LLM_STAGES.has(next.stage)) {
      const startAfter = lane === "night" ? nextWindowStart(win(), at) : at;
      const opts = { priority, singletonKey: key, retryLimit: 0, heartbeatSeconds: LLM_HEARTBEAT_SEC, expireInSeconds: expire, startAfter };
      if (lane === "now") await boss.upsert(QUEUE_OF[next.stage], job, opts);
      // night lane: a job of this key already waits with a later term (the stage was blocked or busy and the panel's
      // Retry cleared its term) — bring the term forward, as for `converted` below; the lane and the priority stay
      else if (await boss.send(QUEUE_OF[next.stage], job, opts) === null) await startEarlier(next.stage, recordId, key, startAfter);
      return;
    }
    // search preparation waits for the embedder longer: a service failure of a couple of minutes must not stop
    // the meeting for good. A failed stage throws (runStage), and pg-boss retries the job with a pause of at least a minute
    // by day, doubled (1 → 2 → 4 min); runStage writes it to record_stages.retry_at, and a job from here (scan, kick,
    // «now» upsert over a waiting retry) is queued no earlier than it, in both lanes. The attempt limit is as before
    const indexing = next.stage === "indexed";
    const delay = indexing ? indexRetryDelaySec(lane, r.delay_sec) : lane === "now" ? 15 : r.delay_sec;
    const opts = { priority, singletonKey: key, retryLimit: r.limit, retryDelay: delay, retryBackoff: indexing ? true : r.backoff, expireInSeconds: expire, startAfter: at,
                   ...(next.stage === "converted" ? { heartbeatSeconds: CONVERT_HEARTBEAT_SEC } : {}) };
    if (lane === "now") { await boss.upsert(QUEUE_OF[next.stage], job, opts); return; }
    const sent = await boss.send(QUEUE_OF[next.stage], job, opts);
    // conversion: a job with the same key already waits (`created`, stately — send returned null), and
    // the needed term is earlier than its startAfter — move the term earlier, keep the lane. «Wake the next» relies on this
    // and «Check now»: else the pass would start at the old, later wait term
    if (sent === null && next.stage === "converted") await startEarlier(next.stage, recordId, key, at);
  }

  /** The waiting (`created`) job of this key starts no later than `at`; a job due earlier is left alone. */
  async function startEarlier(stage: Stage, recordId: string, key: string, at: Date): Promise<void> {
    const moved = await ctx.db.control.query(
      "UPDATE pgboss.job SET start_after = $3 WHERE name = $1 AND singleton_key = $2 AND state = 'created' AND start_after > $3 RETURNING id",
      [QUEUE_OF[stage], key, at]);
    if (moved.rowCount) log.info("stage_job_start_moved", { stage, record_id: recordId, start_after: at.toISOString() });
  }

  /** «Wake the next» (conversion-queue.ts); queuing — by this same schedule with no lane hint. */
  const wakeConversion = (): Promise<number> => wakeConversionQueue(ctx, (cls, id) => schedule(cls, id));

  /**
   * Stage outcome: processing journal, derived records, next stage. handoff — the stage went to a class move (personal
   * open) or to the record's new class: kick ends the move under the record lock and plans the stage there.
   */
  async function afterStage(job: StageJob, res: LlmStageResult, used: StageUsage): Promise<void> {
    if (res.status === "handoff") {
      await boss.send("kick", { instance: ctx.instanceId, class: job.class, record_id: job.record_id, lane: "now" }, { priority: 10, singletonKey: `${job.record_id}:now`, retryLimit: 3, expireInSeconds: 900 });
      return;
    }
    const llm = LLM_STAGES.has(job.stage);
    // tokens — the stage's model spend: from the day's sum in the «now» lane the gateway counts the daily cap
    const status = res.status === "refused" ? "failed" : res.status;
    const extra = res.status === "retry" ? { kind: res.kind, busy_retries: res.busy_retries, slow_retries: res.slow_retries, retry_at: res.retry_at ?? null }
      : res.status === "deferred" ? { reason: res.reason ?? "model_busy" }
      : res.status === "failed" && res.kind ? { kind: res.kind, retry_at: res.retry_at ?? null } : {};
    // a converter wait (poll, queue, pause — StageWait) is not written to the journal: else
    // every poll each 30 s would leave a processing event
    // a repeated policy/budget refusal with the same text is quiet too — the event marks entering the wait for a
    // permission and leaving it (done), not every attempt every 30 minutes. The same for a stage without a model that waits
    // again for the same reason (`indexed` under a spent money budget)
    const quiet = (res.status === "retry" && String(res.kind ?? "").startsWith(CONVERTER_WAIT_PREFIX)) || (res.kind === "blocked" && res.repeat === true)
      || (res.status === "retry" && res.repeat === true);
    if (!quiet) await auditWorker(ctx, { event_type: "processing", class: job.class, record_ids: [job.record_id],
                                         details: { stage: job.stage, lane: job.lane, version: job.version, status, ...extra, ...(llm ? { tokens: used.tokens, calls: used.calls } : {}) } });
    // the record went to night («now» patience over or «too slow»): the rest of the chain — at night
    if (res.status === "deferred") { await schedule(job.class, job.record_id, "night"); return; }
    // the model busy or slow, an error with attempts left, a converter wait — the same stage with its own term
    // (retry_at): a job with startAfter = retry_at in this job's lane; stately allows it next to a still active
    if (res.status === "retry" || res.status === "failed" || res.status === "refused") {
      await schedule(job.class, job.record_id, job.lane);
      if (res.status !== "retry") await wakeAfterConversion(job);
      return;
    }
    // derived (summary, events) pass indexed on their own; then the parent's next stage, with no wait for the scheduler
    if (job.stage === "summary" || job.stage === "events") {
      await warmDerived(ctx, job.class, job.record_id);
      for (const d of (await recordsDb(ctx, job.class).query("SELECT r.id FROM records r JOIN record_stages s ON s.record_id = r.id AND s.stage = 'indexed' AND s.status = 'pending' WHERE r.parent_id = $1", [job.record_id])).rows) await schedule(job.class, d.id, "now");
    }
    await schedule(job.class, job.record_id, job.lane);
    await wakeAfterConversion(job);
  }

  /**
   * Conversion ended (done, failed, refused; skipped — the record was removed mid-conversion): a place in window K is free —
   * wake the next at once, without waiting for its term and scan. A wake failure — only to the log:
   * the next comes by its own term.
   */
  async function wakeAfterConversion(job: StageJob): Promise<void> {
    if (job.stage !== "converted") return;
    await wakeConversion().catch((e) => log.warn("converter_wake_failed", { record_id: job.record_id, error: (e as Error).message.slice(0, 120) }));
  }

  /**
   * «Now» lane patience for records short of the slot: only outside the window; queued in «now» longer than
   * now_patience_min, and a model stage of the record waits (busy or slow) or an instance rollback is open — to the night.
   * Its day job is dropped (else the dispatcher takes it by day); the scheduler sets a night one.
   * Not while chat cannot be called: the records wait for a model, not for a busy one — a breaker left open from
   * before would otherwise move every "process now" record to the night lane with reason `model_busy`. Nor a record whose
   * stage waits for a permission (data policy, budget): the night would not change it, and the record would show "model
   * busy" in the night lane.
   */
  async function patience(cls: DataClass, breakerOpen: boolean): Promise<void> {
    if (inWindow(win()) || ctx.platform.chatBlock() !== null) return;
    const retry = settings.get("processing.llm_retry", { now_patience_min: 120 });
    const moved = (await recordsDb(ctx, cls).query(
      `UPDATE records r SET attrs = (r.attrs - 'process_now_at') || jsonb_build_object('deferred_reason', 'model_busy', 'deferred_to_night_at', now())
        WHERE r.attrs ? 'process_now_at' AND r.is_current AND r.deleted_at IS NULL
          AND COALESCE(CASE WHEN r.attrs->>'process_now_at' ~ '^\\d{4}-\\d{2}-\\d{2}' THEN (r.attrs->>'process_now_at')::timestamptz END,
                       (SELECT min(s.first_busy_at) FROM record_stages s WHERE s.record_id = r.id), now()) < now() - make_interval(mins => $1)
          AND EXISTS (SELECT 1 FROM record_stages s WHERE s.record_id = r.id AND s.stage = ANY($2) AND s.status = 'pending'
                        AND ($3::boolean OR s.busy_retries > 0 OR s.slow_retries > 0))
          AND NOT EXISTS (SELECT 1 FROM record_stages p WHERE p.record_id = r.id AND p.stage = ANY($2) AND p.status = 'pending'
                            AND COALESCE(p.last_error, '') LIKE ANY($4::text[]))
      RETURNING r.id`, [Number(retry.now_patience_min ?? 120), LLM_STAGE_LIST, breakerOpen, WAITS_FOR_PERMISSION])).rows.map((x) => x.id as string);
    if (!moved.length) return;
    const jobs = (await ctx.db.control.query(
      "SELECT id, name FROM pgboss.job WHERE name = ANY($1) AND state IN ('created','retry') AND data->>'record_id' = ANY($2::text[])", [LLM_QUEUES, moved])).rows;
    for (const j of jobs) await boss.cancel(j.name, j.id).catch((e) => log.warn("llm_job_cancel_failed", { queue: j.name, error: (e as Error).message.slice(0, 120) }));
    for (const id of moved) {
      await auditWorker(ctx, { event_type: "processing", class: cls, record_ids: [id], details: { job: "llm_patience", status: "deferred", reason: "model_busy", lane: "now" } });
      await schedule(cls, id, "night").catch((e) => log.warn("schedule_failed", { record_id: id, error: (e as Error).message.slice(0, 120) }));
    }
    log.warn("llm_deferred_to_night", { class: cls, records: moved.length, by: "patience" });
  }

  /**
   * Scheduler: pending → jobs; running over two hours → pending; failed retried up to three times. Records with
   * a blocked chain (a failed stage with attempts used up or «too slow») and with a running stage
   * are not selected — else they held the LIMIT 1000 window forever and new records never reached the scheduler.
   * For the same reason records whose job already waits in the queue are left out too: schedule() would not
   * resend them, yet they took the LIMIT window, and a new record (a fresh org card) waited until the queue was under
   * 1000. The exception — a record with «process now» (process_now_at): scan moves its night-waiting job to «now».
   * A document of the day lane by default (process_now_by = intake) is queued in the day lane from the start: it
   * has no night job to move, so it is taken only without a queued job — otherwise 1000 uploaded documents would fill the
   * window again.
   * Only while its queued job is not a "now" job already: records waiting in the "now" lane for weeks without a
   * model would otherwise fill the window on every round, and newer records that lost their job would never be scheduled.
   * Both rules are one selection: a job is "now" already when its priority is the day
   * priority of an explicit request (NOW_PRIORITY), waiting or active; a job below it (a night one, or 5 of a document of the
   * day lane by default) may still be raised.
   * The next stage after a job is queued by afterStage — nothing skipped. Order — by retry term or stage age.
   */
  async function scan(): Promise<void> {
    await settings.load();
    await wakeNightJobs();
    const r = settings.get("processing.retries", { limit: 3, stuck_running_hours: 2 });
    const queuedRows = (await ctx.db.control.query(
      "SELECT singleton_key, priority FROM pgboss.job WHERE name = ANY($1) AND state IN ('created','retry','active') AND singleton_key IS NOT NULL", [Object.values(QUEUE_OF)])).rows;
    const queued = new Set<string>(queuedRows.map((x) => x.singleton_key as string));
    const queuedIds = queuedRecordIds(queued);
    // a record with "process now" is taken again only while one of its queued jobs may still be raised: a job below the day
    // priority of an explicit request (a night one, or 5 of a document of the day lane by default). A job already at that
    // priority is left alone: waiting, the upsert would move its due time (start_after) to the moment of the scan, and the
    // dispatcher orders queues of one priority by it; waiting or active, there is nothing to raise,
    // and records waiting in the "now" lane for weeks without a model would fill the window on every round
    const raisableIds = queuedRecordIds(queuedRows.filter((x) => Number(x.priority) < NOW_PRIORITY).map((x) => x.singleton_key as string));
    const breaker = (await ctx.db.control.query("SELECT (value->>'open_until')::timestamptz > now() AS open FROM maintenance_state WHERE instance_id = $1 AND key = 'llm_breaker'", [ctx.instanceId])).rows[0];
    for (const cls of ["open", "closed"] as DataClass[]) {
      const rdb = recordsDb(ctx, cls);
      await reclaimLlmOrphans(ctx, cls).catch((e) => log.warn("llm_orphan_reclaim_failed", { class: cls, error: (e as Error).message.slice(0, 120) }));
      // a stuck stage: the attempt was counted at the claim; with the limit used up — failed, no endless pending. Stages with
      // a model claimed by the gate (claimed_by) go to reclaimLlmOrphans: the database shows their holder
      await rdb.query(
        `UPDATE record_stages SET status = (CASE WHEN attempts >= $2 THEN 'failed' ELSE 'pending' END)::stage_status, last_error = 'stuck_running: stage did not finish in time', updated_at = now()
         WHERE status = 'running' AND updated_at < now() - make_interval(hours => $1) AND (NOT (stage = ANY($3)) OR claimed_by IS NULL)`, [r.stuck_running_hours, r.limit, LLM_STAGE_LIST]);
      // non-current versions (superseded) are not in records_live and will never be planned: their unfinished stages — skipped
      const stale = await rdb.query(
        `UPDATE record_stages s SET status = 'skipped', last_error = $1, updated_at = now()
         FROM records r WHERE r.id = s.record_id AND NOT r.is_current AND s.status IN ('pending','failed')`, [SUPERSEDED_STAGE_NOTE]);
      if (stale.rowCount) log.info("superseded_stages_skipped", { class: cls, stages: stale.rowCount });
      await patience(cls, Boolean(breaker?.open)).catch((e) => log.warn("llm_patience_failed", { class: cls, error: (e as Error).message.slice(0, 120) }));
      // terminal — a refusal a retry will not fix: such a stage is not planned whatever the attempt count;
      // «too slow» (llm_too_slow) — too, until the admin's «Retry»
      const { rows } = await rdb.query(
        `SELECT r.id FROM records_live r
         WHERE EXISTS (SELECT 1 FROM record_stages s WHERE s.record_id = r.id
                       AND (s.status = 'pending' OR (s.status = 'failed' AND NOT s.terminal AND s.attempts < $1 AND COALESCE(s.last_error, '') NOT LIKE '${TOO_SLOW_PREFIX}%'
                                                     AND COALESCE(s.retry_at, s.updated_at + interval '5 minutes') <= now())))
           AND NOT EXISTS (SELECT 1 FROM record_stages f WHERE f.record_id = r.id
                           AND (f.status = 'running' OR (f.status = 'failed' AND (f.terminal OR f.attempts >= $1 OR COALESCE(f.last_error, '') LIKE '${TOO_SLOW_PREFIX}%'))))
           AND (r.id <> ALL($2::uuid[]) OR (r.attrs ? 'process_now_at' AND r.attrs->>'process_now_by' IS DISTINCT FROM 'intake' AND r.id = ANY($3::uuid[])))
         ORDER BY (SELECT min(COALESCE(s.retry_at, s.updated_at)) FROM record_stages s WHERE s.record_id = r.id AND s.status IN ('pending','failed')), r.ingested_at LIMIT 1000`, [r.limit, queuedIds, raisableIds]);
      for (const row of rows) await schedule(cls, row.id, undefined, queued).catch((e) => log.warn("schedule_failed", { record_id: row.id, error: (e as Error).message.slice(0, 120) }));
    }
    // moves: pending after 30 s (the gateway answered in_progress and woke kick — a safety net), copying/verifying older
    // than 5 minutes — cut off by a worker restart; class_moves has no last-step mark, the age counts from the request
    const moves = (await ctx.db.control.query(
      `SELECT id, status FROM class_moves WHERE (status = 'pending' AND requested_at < now() - interval '30 seconds')
          OR (status IN ('copying','verifying') AND requested_at < now() - interval '5 minutes')`)).rows;
    for (const m of moves) await moveClass(ctx, m.id).catch((e) => log.warn("class_move_scan_failed", { move_id: m.id, status: m.status, error: (e as Error).message.slice(0, 200) }));
    // cleanup under the purge lock: busy in another process — go on, the next scan finishes it
    await purgeSerial(ctx).catch((e) => log.warn("purge_failed", { error: (e as Error).message.slice(0, 200) }));
  }

  return { schedule, afterStage, scan, wakeConversionQueue: wakeConversion };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Records with a queued job: the stage singletonKey is `<record_id>:<stage>:<version>` (schedule); other keys skipped. */
export function queuedRecordIds(keys: Iterable<string>): string[] {
  const ids = new Set<string>();
  for (const k of keys) { const id = k.split(":", 1)[0]!; if (UUID.test(id)) ids.add(id.toLowerCase()); }
  return [...ids];
}

/**
 * Non-model stage outcome (runStage) in the form of a model stage outcome — for the common afterStage. retry (StageWait)
 * — `{status: "retry", kind: <reason>}` and a term: by the reason prefix `converter_wait:` afterStage writes
 * no journal.
 */
export const plainResult = (s: RunStageStatus, code?: string, retryAt?: Date | string | null, repeat?: boolean): LlmStageResult =>
  s === "retry" ? { status: "retry", ...(code ? { kind: code } : {}), retry_at: retryAt ? new Date(retryAt).toISOString() : null, ...(repeat ? { repeat: true } : {}) }
    : { status: s === "failed" ? "refused" : s };
export type { Stage };
