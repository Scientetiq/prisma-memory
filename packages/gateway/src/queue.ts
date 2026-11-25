// The pg-boss queue in memory_control. The source of truth for "what is not done" is record_stages; the gateway only wakes
// the worker: a `kick` job with a lane. The schema and queues (policy stately: one job per state and singletonKey) are made by
// the worker; the gateway only sends and counts the place in the queue — a repeated kick of one record and lane is not doubled.
import { PgBoss } from "pg-boss";
import { log, passwordFor, pgTls, type DataClass, type Env } from "@memory/shared";

export type Lane = "now" | "night" | "index";
/** Queues of stages with a model (worker, llm-dispatch.ts): their jobs are taken by their own dispatcher under the model slot. */
export const LLM_QUEUES = ["summarize", "extract_events", "describe"];
/**
 * Priorities of model jobs (the worker's scheduler.ts sets them): 10 — the day lane of meetings and explicit "process now"
 * requests, 5 — a document that entered the day lane at upload (`process_now_by: "intake"`, INTAKE_PRIORITY there),
 * 0 — the night lane. A job of the day lane is any job with priority 1 or more (the dispatcher's daytime threshold,
 * llm-dispatch.ts); counting the lanes by the threshold 10 would put the documents of the day lane into the night.
 */
export const NOW_PRIORITY = 10;
export const INTAKE_PRIORITY = 5;
export const DAY_PRIORITY_MIN = 1;
/** Priority of the model jobs of a record of the day lane, by its attributes: the place in the queue counts the jobs from it up. */
export const nowPriorityOf = (attrs: Record<string, unknown> | null | undefined): number =>
  attrs?.process_now_by === "intake" ? INTAKE_PRIORITY : NOW_PRIORITY;
export interface KickJob { instance: string; class: DataClass; record_id: string; lane: Lane }

export class JobQueue {
  private boss?: PgBoss;
  private ready = false;
  constructor(private readonly env: Env) {}

  async start(): Promise<void> {
    this.boss = new PgBoss({
      host: this.env.pgHost, port: this.env.pgPort, database: "memory_control", user: "memory_gateway",
      password: passwordFor(this.env, "memory_gateway"), schema: "pgboss", migrate: false, supervise: false, schedule: false, max: 3,
      ssl: this.env.pgTls ?? pgTls(),
    });
    this.boss.on("error", (e: Error) => log.warn("queue_error", { error: e.message }));
    try { await this.boss.start(); this.ready = true; } catch (e) { log.warn("queue_not_ready", { error: (e as Error).message }); }
  }

  /** Wakes the worker. No queue yet (the worker has not started) is not an error: the stage scheduler picks up pending itself. */
  async kick(job: KickJob): Promise<boolean> {
    if (!this.boss) return false;
    try {
      if (!this.ready) { await this.boss.start(); this.ready = true; }
      // null — such a job is already queued (stately by singletonKey): the worker will wake anyway, it is not a refusal
      const id = await this.boss.send("kick", job, { priority: job.lane === "now" ? 10 : job.lane === "index" ? 5 : 0, singletonKey: `${job.record_id}:${job.lane}`, retryLimit: 3, expireInSeconds: 900 });
      if (!id) log.debug("queue_kick_deduplicated", { record_id: job.record_id, lane: job.lane });
      return true;
    } catch (e) { log.warn("queue_send_failed", { error: (e as Error).message }); return false; }
  }

  /**
   * A service job, no record (profiles_sync after the org table load, reconcile — the class reconciler by button, search_outcomes —
   * "Recount now"; dismissed_retention — keepers and meetings of departed people after a dismissal, a return and a manual keeper
   * assignment; audit_ship_reconcile — "Reconcile now" of shipping the journal outside; open_recheck — the open recheck
   * after saving settings and the "Open check" buttons; alert_digest — "Build the digest now" of the "Alerts" panel,
   * the worker creates the queue, registerAlertDetectors).
   */
  async wake(queue: "profiles_sync" | "reconcile" | "mail" | "project_tags" | "org_review" | "search_outcomes" | "dismissed_retention" | "audit_ship_reconcile"
             | "open_recheck" | "alert_digest",
             data: { part?: string; settle_sec?: number; since?: string; current_week?: boolean } = {}): Promise<boolean> {
    if (!this.boss) return false;
    // the job part (org_review: return | digest | all) — in the key: "return only" does not collapse with the mail.
    // The parameters of the search outcomes test hook — in the key too: a test wake is not eaten by an ordinary
    const hook = queue === "search_outcomes" && (data.settle_sec !== undefined || data.since !== undefined || data.current_week !== undefined);
    const key = hook ? `${queue}:hook:${data.settle_sec ?? ""}:${data.since ?? ""}:${data.current_week ? 1 : 0}` : data.part ? `${queue}:${data.part}` : queue;
    try { if (!this.ready) { await this.boss.start(); this.ready = true; } await this.boss.send(queue, data, { singletonKey: key, retryLimit: 1 }); return true; }
    catch (e) { log.warn("queue_send_failed", { error: (e as Error).message }); return false; }
  }

  /**
   * How many model jobs of the "now" lane are ahead; null — the queue is unavailable. Only the queues of stages with
   * a model and only those whose time has come: a deferred "model busy" retry and service kicks take no place in the queue
   * — there is one model, and the queue to it is the waiting itself.
   * `minPriority` — the priority of the record's own jobs: a meeting or an explicit request (10) waits only for jobs of 10, a
   * document of the day lane by default (5) also for the other documents of that lane.
   */
  async nowPosition(control: import("pg").Pool, minPriority: number = NOW_PRIORITY): Promise<number | null> {
    try {
      const { rows } = await control.query(
        `SELECT count(*)::int AS n FROM pgboss.job
          WHERE name = ANY($1) AND state IN ('created','retry','active') AND priority >= $2 AND start_after <= now()`, [LLM_QUEUES, minPriority]);
      return rows[0]?.n ?? 0;
    } catch { return null; }
  }

  async stop(): Promise<void> { await this.boss?.stop({ graceful: false }).catch(() => undefined); }
}
