// Workers context. Workers run in the system context: both classes; results inherit the class and scope of their inputs.
import { AsyncLocalStorage } from "node:async_hooks";
import type { PgBoss } from "pg-boss";
import { newId, log, ModelGateAudit, PlatformError, SCOPE_SYSTEM, spoolAudit, type BeforeModelDispatch, type ChatJsonResult, type Databases, type DataClass, type DespiteKeys, type LlmSlot, type Platform, type S3Target, type Settings } from "@memory/shared";
import { failureClass } from "@memory/connectors";
import type pg from "pg";
import type { StageJob } from "./stages.ts";

/**
 * Model call arguments without the slot: the stage slot supplies `ctx.chat`. The record fence at
 * the send (`beforeDispatch`, jobs/common.ts modelDispatchFence) is required here, while `chatJson` keeps it
 * optional for its callers outside the stages; `stageChat` refuses a call without it at run time as well.
 */
export type ChatArgs = Omit<Parameters<Platform["chatJson"]>[0], "slot" | "beforeDispatch"> & { beforeDispatch: BeforeModelDispatch };

/**
 * `chat` — a model call under the current stage's slot: one model for the whole company, at most one request
 * at a time. The LLM queue dispatcher takes the slot before picking a job and holds it for the whole stage —
 * a long meeting's parts go in a row. Off-stage — PlatformError("gate"): no gateway call.
 */
export interface Ctx { instanceId: string; db: Databases; settings: Settings; platform: Platform; boss: PgBoss; s3: (cls: DataClass) => S3Target | null; chat<T>(args: ChatArgs): Promise<ChatJsonResult<T>>;
  /**
   * Key of the fingerprints of the agent-show consent: the move worker checks on the copy the fingerprints computed
   * by the gateway. From the app secret at start (index.ts), no new env variables. Without a key a show despite
   * a finding is not moved (a fault, not a refusal).
   */
  despiteKeys?: DespiteKeys;
  /**
   * Process stop (the conversion queue, `aborted`): SIGTERM interrupts a running converter request, the pass writes
   * the wait before pg-boss stops and DBs close. Absent: no interrupts (manual run, tests).
   */
  abort?: AbortSignal;
  /** Wake the next in the conversion queue from inside the pass: the record left the window. Absent — no wake (tests). */
  wakeConversion?: () => Promise<number>;
  /** External entity lookup of the entities stage: connectors with entity_lookup. Absent — no lookup. */
  externalLookup?: import("./jobs/entity-lookup.ts").ExternalLookup }
/** The part of the context enough for jobs without models, queue and storage (manual run: run-job.ts). */
export type DbCtx = Pick<Ctx, "instanceId" | "db" | "settings">;
export const recordsDb = (ctx: DbCtx, cls: DataClass): pg.Pool => ctx.db.records(cls, SCOPE_SYSTEM);

/** The model stage running now: slot, job and wait counters after the claim (for the processing.llm_fault hook). */
export interface LlmStage { slot: LlmSlot; job: StageJob; counters: { busy_retries: number; slow_retries: number } }
export const llmStageStore = new AsyncLocalStorage<LlmStage>();

/** `ctx.chat`: slot from llmStageStore; off a model stage — refused, no call. */
export function stageChat(platform: Platform): Ctx["chat"] {
  return <T>(args: ChatArgs) => {
    const st = llmStageStore.getStore();
    if (!st) return Promise.reject(new PlatformError("gate", "model call outside a stage: a model can be called only while holding a stage slot"));
    if (typeof args.beforeDispatch !== "function") return Promise.reject(new PlatformError("gate", "a stage's model call without the record fence at the send: nothing is sent"));
    return platform.chatJson<T>({ ...args, slot: st.slot });
  };
}

export type WorkerEvent = { event_type: "processing" | "class_move" | "purge" | "forget" | "admin" | "t1_fallback" | "promote"; class?: DataClass; record_ids?: string[]; space_id?: string | null; details?: Record<string, unknown> };

/**
 * Non-strict journal: a failed write does not break the job. Audit outbox: the event the journal refused is kept in
 * audit_outbox (memory_control) with the same id and moved by audit_outbox_drain; lost only when the outbox fails too.
 */
export async function auditWorker(ctx: DbCtx, e: WorkerEvent): Promise<void> {
  const id = newId();
  try { await insertWorkerEvent(ctx, id, e); }
  catch (err) {
    log.error("audit_write_failed", { event_type: e.event_type, error: failureClass(err) });
    await spoolAudit(ctx.db.control, { id, instanceId: ctx.instanceId, source: "workers", payload: {
      event_type: e.event_type, principal_type: "system", class: e.class ?? null, record_ids: e.record_ids ?? [], space_id: e.space_id ?? null, details: e.details ?? {},
    } });
  }
}

/** Strict journal: a write failure throws; the caller does nothing irreversible without the event. */
export async function auditWorkerStrict(ctx: DbCtx, e: WorkerEvent): Promise<void> {
  // strict events are never spooled: the caller refuses instead
  await insertWorkerEvent(ctx, newId(), e);
}

function insertWorkerEvent(ctx: DbCtx, id: string, e: WorkerEvent): Promise<unknown> {
  return ctx.db.audit.query(
    "INSERT INTO audit_events (id, instance_id, event_type, principal_type, class, record_ids, space_id, details) VALUES ($1,$2,$3,'system',$4,$5,$6,$7)",
    [id, ctx.instanceId, e.event_type, e.class ?? null, e.record_ids ?? [], e.space_id ?? null, JSON.stringify(e.details ?? {})]);
}

/**
 * Strict journal in a batch — one insert: all events reach the journal or none (the journal is another database,
 * and event by event a k-th failure left 1…k−1 without the change).
 */
export async function auditWorkerStrictMany(ctx: DbCtx, events: WorkerEvent[]): Promise<void> {
  if (!events.length) return;
  const rows: string[] = [], params: unknown[] = [];
  for (const e of events) {
    const b = params.length;
    rows.push(`($${b + 1},$${b + 2},$${b + 3},'system',$${b + 4},$${b + 5},$${b + 6},$${b + 7})`);
    params.push(newId(), ctx.instanceId, e.event_type, e.class ?? null, e.record_ids ?? [], e.space_id ?? null, JSON.stringify(e.details ?? {}));
  }
  await ctx.db.audit.query(`INSERT INTO audit_events (id, instance_id, event_type, principal_type, class, record_ids, space_id, details) VALUES ${rows.join(", ")}`, params);
}

/**
 * Data policy on the model path (formerly the T1 gate): every call to a "base URL + model" pair
 * outside models.allow_closed is audit event t1_fallback, the allowed ones (open class for a pair of models.allow_open) and
 * the refused ones. Written: the model (field alias), purpose, class, stage, role, host of the address (no path, no key) and
 * reason. `models.audit_calls`: `each` — one event per call; `hourly` — the allowed calls of an hour as one event
 * with `count` and `hour` (stage null), refusals one by one; a summary whose write failed is written again. The hook is
 * synchronous: writing the audit log neither delays nor breaks the model call. Returns the aggregator: the entry point
 * starts its timer and stops it at shutdown.
 */
export function wireModelGate(ctx: DbCtx & { platform: Platform }): ModelGateAudit {
  const gateAudit = new ModelGateAudit({
    settings: ctx.settings,
    write: (e) => {
      const sum = "count" in e ? { count: e.count, hour: e.hour } : {};
      const stage = "stage" in e ? e.stage ?? null : null;
      log.warn("t1_gate", { alias: e.alias, purpose: e.purpose, class: e.dataClass, stage, allowed: e.allowed, role: e.role, endpoint: e.endpoint, reason: e.reason, ...sum });
      // strict: a failed write is logged as before and rejects, so that the aggregator puts a summary back
      return auditWorkerStrict(ctx, { event_type: "t1_fallback", class: e.dataClass,
                                      details: { alias: e.alias, purpose: e.purpose, stage, allowed: e.allowed, role: e.role, endpoint: e.endpoint, reason: e.reason, ...sum } })
        .catch((err: unknown) => { log.error("audit_write_failed", { event_type: "t1_fallback", error: failureClass(err) }); throw err; });   // logged
    },
  });
  ctx.platform.onModelGate = (e) => { gateAudit.record(e); };
  return gateAudit;
}

/** Model spend of one stage: tokens (in + out) and gateway answers, including a retry on a schema error. */
export interface StageUsage { tokens: number; calls: number }
/** The stage a model call belongs to: runStage runs inside `stageUsage.run(...)`. */
export const stageUsage = new AsyncLocalStorage<StageUsage>();

/** Each gateway answer's spend goes to the stage that asked for it (outside a stage — nowhere). */
export function wireUsage(ctx: { platform: Platform }): void {
  ctx.platform.onUsage = (u) => {
    const s = stageUsage.getStore();
    if (s) { s.tokens += u.promptTokens + u.completionTokens; s.calls++; }
  };
}
