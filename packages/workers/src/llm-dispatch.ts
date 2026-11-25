// Dispatcher of the model queues: instead of boss.work for summarize, extract_events and describe. The order is
// slot first, then the best job: no job is picked before the slot is taken, so a night document cannot take the model
// ahead of a now meeting, and a slot wait spends no job lifetime. One loop and one LlmGate per process; the slot
// is held all stage: long meeting parts run in a row.
import type { PgBoss } from "pg-boss";
import { inWindow, log, PlatformError, type LlmGate, type LlmSlot, type NightWindow } from "@memory/shared";
import { stageUsage, type Ctx, type StageUsage } from "./ctx.ts";
import { runLlmStage, usableJob, type LlmStageResult, type Stage, type StageJob } from "./stages.ts";
import { LLM_QUEUES } from "./scheduler.ts";
import { addNightTokens, markCapped, nightCapState } from "./night-cap.ts";

type Handler = (c: Ctx, j: StageJob) => Promise<"done" | "skipped" | "handoff">;
export interface DispatchDeps {
  ctx: Ctx;
  gate: LlmGate;
  handlers: Partial<Record<Stage, Handler>>;
  afterStage: (job: StageJob, res: LlmStageResult, used: StageUsage) => Promise<void>;
  win: () => NightWindow;
  /**
   * Loop pauses (tests shorten): empty queues — idleMs, gate block — at most blockMaxMs; a slot round that gave
   * nothing (no job or it failed) — from idleMs, doubling up to emptyMaxMs.
   */
  idleMs?: number;
  blockMaxMs?: number;
  emptyMaxMs?: number;
  touchMs?: number;
  now?: () => Date;
}
export interface Dispatcher { stop(graceMs: number): Promise<void>; readonly running: boolean }

/**
 * Model queues with a job to run now: best first (priority, age). Outside the window night jobs
 * (priority 0) are skipped. A job whose key is already active (zombie or another process) is no demand — else the loop
 * would spin on a queue fetch gives nothing from. But fetch takes the queue head: if the head is a job
 * with an active key and another ready behind it, demand exists but fetch is empty until pg-boss updates its cache of
 * active keys (up to a minute). The head is not guessed here (a fresh cache makes fetch skip it): hence the loop pauses
 * doubling after an empty round.
 */
export async function dueQueues(ctx: Pick<Ctx, "db">, windowNow: boolean): Promise<string[]> {
  const { rows } = await ctx.db.control.query(
    // among queues of one best priority the one whose job of THAT priority has been due the longest goes first:
    // old documents of the day lane by default (priority 5) do not make a fresh explicit request in
    // `describe` older than an earlier meeting. Due since — start_after: the upsert of an explicit request moves it to the
    // moment of the request and keeps created_on of the job it raised; created_on breaks ties (a night window opens at once)
    `SELECT x.name, x.p, min(x.start_after) AS s, min(x.created_on) AS c
       FROM (SELECT j.name, j.priority, j.start_after, j.created_on, max(j.priority) OVER (PARTITION BY j.name) AS p
               FROM pgboss.job j
              WHERE j.name = ANY($1) AND j.state IN ('created','retry') AND j.start_after <= now() AND j.priority >= $2
                AND NOT EXISTS (SELECT 1 FROM pgboss.job a WHERE a.name = j.name AND a.singleton_key = j.singleton_key AND a.state = 'active')) x
      WHERE x.priority = x.p
      GROUP BY x.name, x.p ORDER BY x.p DESC, s, c`, [LLM_QUEUES, windowNow ? 0 : 1]);
  return rows.map((r) => r.name as string);
}

const jitter = (ms: number) => Math.round(ms * (0.8 + Math.random() * 0.4));

export function startLlmDispatcher(d: DispatchDeps): Dispatcher {
  const { ctx, gate } = d;
  const boss: PgBoss = ctx.boss;
  const idle = d.idleMs ?? 2000, blockMax = d.blockMaxMs ?? 5000, emptyMax = d.emptyMaxMs ?? 15_000, touchMs = d.touchMs ?? 20_000;
  const now = d.now ?? (() => new Date());
  let stopping = false;
  let wake: (() => void) | null = null;
  // no sleep on shutdown: stop() wakes only a started pause
  const nap = (ms: number) => stopping ? Promise.resolve() : new Promise<void>((r) => { const t = setTimeout(() => { wake = null; r(); }, ms); wake = () => { clearTimeout(t); wake = null; r(); }; });
  let inStage = false;
  let emptyRounds = 0;
  let chatOff: string | null = null;

  async function once(): Promise<void> {
    // no-AI mode: while chat cannot be called, no slot is taken and no job is fetched — the stages stay pending as
    // they are (no stage row written, the breaker untouched) and run on a later round once the connection appears (the
    // worker reloads its settings cache every 60 s, the settings_reload timer of index.ts). Stub mode is ready (Platform.stubChat)
    const block = ctx.platform.chatBlock();
    if (block !== chatOff) {
      const problems = block === "off" ? ctx.platform.roleState("chat").problems : [];
      log.info(block ? "llm_dispatch_chat_blocked" : "llm_dispatch_chat_ready", {
        reason: problems.length ? "misconfigured" : block ?? chatOff, problems,
      });
      chatOff = block;
    }
    if (block) { await nap(blockMax); return; }
    const b = await gate.precheck();
    if (b) { await nap(Math.min(blockMax, b.until ? Math.max(50, b.until.getTime() - now().getTime()) : blockMax)); return; }
    // night cap: before the slot — from a cache at most 15 s old, so that an empty queue and
    // a busy slot spare the DB; a spent window skips night jobs (priority 0), as outside it. The hit is marked
    // here too: with only night jobs waiting, no slot is taken after the hit, so a mark under it would never come
    // (a repeat in the window — nothing: markCapped looks at capped_at; no night jobs — no mark, nothing stopped)
    const inWin = inWindow(d.win(), now());
    const capNow = inWin ? await nightCapState(ctx, { now: now() }) : null;
    if (capNow?.capped && capNow.tokens >= capNow.cap) await markCapped(ctx, capNow, now());   // a read-failure hit is not marked
    const windowNow = inWin && !capNow?.capped;
    if (!(await dueQueues(ctx, windowNow)).length) { emptyRounds = 0; await nap(idle); return; }
    const r = await gate.tryAcquire({ purpose: "stage" });
    if ("blocked" in r) {
      const until = r.blocked.until ? r.blocked.until.getTime() - now().getTime() : 0;
      await nap(jitter(r.blocked.kind === "slot_busy" ? Math.min(blockMax, 1000) : Math.min(blockMax, until > 0 ? until : blockMax)));
      return;
    }
    const slot: LlmSlot = r.slot;
    let job: { id: string; name: string; data: StageJob } | null = null;
    let res: LlmStageResult | null = null;
    let asked: string[] = [];
    const used: StageUsage = { tokens: 0, calls: 0 };
    let touch: ReturnType<typeof setInterval> | null = null;
    inStage = true;
    try {
      // night cap under the slot — a fresh read: the last stage added its spend before releasing the slot, so the stage
      // after the one over the threshold never starts (overspend: at most one stage); read failure — window spent
      let nightOk = true;
      if (inWindow(d.win(), now())) {
        const cap = await nightCapState(ctx, { fresh: true, now: now() });
        if (cap.capped) { nightOk = false; if (cap.tokens >= cap.cap) await markCapped(ctx, cap, now()); }
      }
      // again, under the slot: demand may change while the slot is awaited; empty fetch — the next queue of this round
      asked = await dueQueues(ctx, inWindow(d.win(), now()) && nightOk);
      for (const name of asked) {
        if (stopping) break;
        const got = await boss.fetch<StageJob>(name, { batchSize: 1, ...(inWindow(d.win(), now()) && nightOk ? {} : { minPriority: 1 }) });
        if (got[0]) { job = { id: got[0].id, name, data: got[0].data }; break; }
      }
      if (job) {
        const j = job; j.data = usableJob(j.data);   // a version removed since the job was queued: the default of its stage
        touch = setInterval(() => { void boss.touch(j.name, j.id).catch((e: Error) => log.warn("llm_job_touch_failed", { queue: j.name, error: e.message.slice(0, 120) })); }, touchMs);
        const handler = d.handlers[j.data.stage];
        if (!handler) throw new Error(`no handler for stage ${j.data.stage}`);
        res = await stageUsage.run(used, () => runLlmStage(ctx, j.data, slot, () => handler(ctx, j.data), now));
        // 0 rows: job not active any more (monitor took it); no error, stage outcome is in record_stages
        await boss.complete(j.name, j.id).catch((e: Error) => log.warn("llm_job_complete_failed", { queue: j.name, error: e.message.slice(0, 120) }));
      }
    } catch (e) {
      log.error("llm_dispatch_failed", { queue: job?.name ?? null, error: (e as Error).message.slice(0, 200) });
      if (job) await boss.fail(job.name, job.id, { message: (e as Error).message.slice(0, 200) }).catch(() => undefined);
      res = null;
    } finally {
      if (touch) clearInterval(touch);
      try {
        // a night stage's spend goes to the window counter before slot release: no other process takes a night stage
        // until the counter is written. Also for a stage that failed after some calls. The now lane spends no cap
        if (job?.data.lane === "night" && used.tokens > 0) await addNightTokens(ctx, used.tokens, now());
      } catch (e) {
        // addNightTokens throws no exceptions; safety — the slot is released whatever the addition gives: a stuck slot
        // would stop all model stages of the process, now ones too, until a restart
        log.warn("night_cap_add_failed", { tokens: used.tokens, error: (e as Error)?.message?.slice(0, 160) ?? "unknown" });
      } finally {
        await gate.release(slot);
        inStage = false;
      }
    }
    // outside the slot: journal, derived, next stage — meanwhile another process may take the model
    if (job && res) {
      emptyRounds = 0;
      await d.afterStage(job.data, res, used).catch((e: Error) => log.warn("llm_after_stage_failed", { record_id: job!.data.record_id, error: e.message.slice(0, 200) }));
      return;
    }
    // a slot round gave nothing: demand but an empty fetch (the queue head's key is still active at a dead
    // worker or an old job without heartbeat: pg-boss hits the unique index and returns nothing until it
    // updates its cache), or the job failed. Unpaused, the loop spins the slot idle — slot row, log and a blinking
    // in_flight for the arbiter each round. Pause doubles up to emptyMax; the first one is logged
    if (stopping) return;
    emptyRounds++;
    if (emptyRounds === 1 && !job) log.info("llm_dispatch_nothing_fetched", { queues: asked });
    await nap(jitter(Math.min(emptyMax, idle * 2 ** Math.min(emptyRounds - 1, 16))));
  }

  const loop = (async () => {
    while (!stopping) {
      try { await once(); }
      catch (e) { log.warn("llm_dispatch_loop_failed", { error: (e as Error).message.slice(0, 200) }); if (!stopping) await nap(blockMax); }
    }
  })();

  return {
    get running() { return inStage; },
    /**
     * Shutdown: nothing new is taken; a running stage gets graceMs, then the call is cut (aborted): the stage returns
     * to pending with no attempt spent, the slot row gets a dirty tail, the job ends, the slot is released.
     */
    async stop(graceMs: number): Promise<void> {
      stopping = true;
      wake?.();
      let timer: ReturnType<typeof setTimeout> | null = null;
      const late = new Promise<"late">((r) => { timer = setTimeout(() => r("late"), Math.max(0, graceMs)); });
      if ((await Promise.race([loop.then(() => "done" as const), late])) === "late") {
        log.warn("llm_dispatch_abort_on_stop", { grace_ms: graceMs });
        gate.abort(new PlatformError("aborted", "processing is stopping. The stage will resume after startup"));
        await loop;
      }
      if (timer) clearTimeout(timer);
    },
  };
}
