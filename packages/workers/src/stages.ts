// Stages on the record are the truth of «what is not done»; the queue only executes.
import { createHash, randomUUID } from "node:crypto";
import { callKind, ConverterError, lastOtherSuccess, LLM_GATE_DEFAULTS, LLM_RETRY_DEFAULTS, log, PlatformError, readProcessingSetting, type DataClass, type LlmSlot,
         nightWindowOf } from "@memory/shared";
import type pg from "pg";
import { EntityResolverError } from "@memory/connectors";
import { llmStageStore, recordsDb, type Ctx, type DbCtx } from "./ctx.ts";
import { abortedBy, blockedBy, MODEL_BUDGET_TEXT, planLlmOutcome, type PlanKind } from "./retry-policy.ts";
import { loadPromptVersion } from "./pipeline/prompts.ts";

export type Stage = "converted" | "indexed" | "summary" | "events" | "entities" | "described";
export const QUEUE_OF: Record<Stage, string> = { converted: "convert", indexed: "index", summary: "summarize", events: "extract_events", described: "describe", entities: "link_entities" };
const ORDER: Record<string, Stage[]> = { transcript: ["indexed", "summary", "events", "entities"], document: ["converted", "indexed", "described", "entities"] };
export const LLM_STAGES = new Set<Stage>(["summary", "events", "described"]);

/** `expire_sec` — the job lifetime by record size (stageExpireSec): by it runStage also spots an orphaned `running`. */
export interface StageJob { instance: string; class: DataClass; record_id: string; stage: Stage; version: string; lane: "now" | "night"; expire_sec?: number }

/** Version of the stage `indexed` when no embedder is active: the record is indexed for keyword search only. */
export const NO_EMBEDDER = "none";

/** The version the stage must be done with now. `DbCtx` — so the manual job run (run-job.ts) can ask for it too. */
export async function versionFor(ctx: DbCtx, stage: Stage): Promise<string> {
  if (stage === "indexed") return (await ctx.db.control.query("SELECT id FROM embedders WHERE active LIMIT 1")).rows[0]?.id ?? NO_EMBEDDER;
  if (stage === "converted") return "converter-v1";   // converter wrapper version, not a prompt's: no model here
  // a model stage's version is the name of its prompt file (contracts/pipeline/prompts/<version>.md, loadPromptVersion)
  const prompts = ctx.settings.get<Record<string, string>>("processing.prompts", {});
  // a saved version this release cannot run (removed since, mistyped) gives the default of the stage: the stage does not fail
  return usablePromptVersion(stage, prompts[stage]);
}

/** A model stage found «too slow»: neither the scheduler nor a claim takes it — until «Retry». */
export const TOO_SLOW_PREFIX = "llm_too_slow:";

/**
 * The next stage ready to run: in stage order, the earlier ones done or skipped. Reading does not lock the stages.
 * retry_at — the retry term of a model stage: the job is queued no earlier than it.
 */
export async function nextStage(ctx: Ctx, cls: DataClass, recordId: string): Promise<{ stage: Stage; type: string; now: boolean; intake: boolean; tokens: number; retry_at: Date | null } | null> {
  const db = recordsDb(ctx, cls);
  const rec = (await db.query(`SELECT type, attrs ? 'process_now_at' AS now, attrs @> '{"process_now_by": "intake"}' AS intake, COALESCE(token_count, 0) AS tokens FROM records_live WHERE id = $1`, [recordId])).rows[0];
  if (!rec) return null;
  const limit = ctx.settings.get<{ limit: number }>("processing.retries", { limit: 3 }).limit;
  const rows = (await db.query("SELECT stage, status, attempts, terminal, retry_at, last_error FROM record_stages WHERE record_id = $1", [recordId])).rows;
  const by = new Map(rows.map((r) => [r.stage as Stage, r]));
  for (const stage of ORDER[rec.type] ?? (["indexed", "entities"] as Stage[])) {
    const s = by.get(stage);
    if (!s || s.status === "done" || s.status === "skipped") continue;
    if (s.status === "running") return null;                                   // already running
    // three failures or a terminal refusal (a repeat gives the same answer) — the record shows as «unprocessed», no job;
    // a retry by the admin (`/admin/stages/retry`) returns the stage to pending and clears the mark (runStage)
    if (s.status === "failed" && (s.terminal || s.attempts >= limit)) return null;
    // a «too slow» record waits for the admin: a repeat without them gives the same «model too slow»
    if (s.status === "failed" && String(s.last_error ?? "").startsWith(TOO_SLOW_PREFIX)) return null;
    return { stage, type: rec.type, now: rec.now, intake: rec.intake === true, tokens: Number(rec.tokens), retry_at: s.retry_at ? new Date(s.retry_at) : null };
  }
  return null;
}

type Retries = { expire_now_sec: number; expire_night_sec: number; per_call_sec: number };
type Budgets = { single_call_tokens: number; part_tokens: number; part_overlap_tokens: number };

/**
 * Job lifetime of a stage: for a model stage — by the number of calls ahead of it. A transcript
 * longer than one call goes in parts (a summary also has a merge call), and the old single «now» lane term (15 min)
 * would make pg-boss drop it mid-work — a retry would reclaim the stage and run it twice. The term is at least the
 * lane's; per call `processing.retries.per_call_sec` (default 300 s, the gateway timeout).
 * Conversion: at least two converter wait terms and five minutes —
 * the job waits for the run (`integrations.converter_timeout_sec`, 900 s), then the export (up to the same term) or the fast
 * lane result. The old «now» lane term (900 s, after «Process now» and «Retry») made pg-boss drop it mid-wait,
 * a second job took over `running` (runStage), and two attempts polled the converter in parallel.
 */
export function stageExpireSec(stage: Stage, lane: "now" | "night", tokens: number, r: Retries, b: Budgets, converterTimeoutSec = 900): number {
  const base = lane === "now" ? r.expire_now_sec : r.expire_night_sec;
  if (stage === "converted") return Math.max(base, 2 * Math.max(30, converterTimeoutSec) + 300);
  if (!LLM_STAGES.has(stage) || stage === "described" || tokens <= b.single_call_tokens) return base;
  const parts = Math.ceil(tokens / Math.max(1, b.part_tokens - b.part_overlap_tokens));
  return Math.max(base, (parts + (stage === "summary" ? 1 : 0)) * r.per_call_sec);
}

/**
 * A terminal stage refusal with its own reason kind (open_check — the document text failed the open class check):
 * nothing to repeat — the same text gives the same refusal; the reason is in last_error, with no content.
 */
export class StageRefused extends Error {
  constructor(readonly kind: string, message: string) { super(message); this.name = "StageRefused"; }
}

/**
 * A failure of a stage with its own kind of reason that a repeat may cure (not terminal: it spends an attempt
 * and is repeated). `kind` is the code before the colon in `last_error`, so the panel shows its wording (admin
 * stage-errors.ts); a plain Error would be written as `error: …` and shown as an unknown reason.
 */
export class StageFault extends Error {
  constructor(readonly kind: string, message: string) { super(message); this.name = "StageFault"; }
}

/** A wait's reason without its count and first moment (`(wait N, since T)`, holdWait) — what a repeat compares. */
export const waitReasonHead = (reason: unknown): unknown => typeof reason === "string" ? reason.replace(/ \(wait \d+, since [^)]*\)$/u, "") : reason;

/**
 * Refusal reason for `record_stages.last_error`: one line (no line breaks), at most 200 characters and with no
 * record content. Model answer validation errors keep only schema paths, no values; the `detail` of a foreign
 * converter and archive file names do not go into the row — they live only in the `detail` field of the error object;
 * the worker log gets only its length and fingerprint. Exported for the test.
 */
export function stageErrorText(kind: string, e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const text = e instanceof PlatformError && e.kind === "schema_error" ? schemaPathsOnly(raw) : raw;
  // what the provider said (redacted, no request content), after the kind and the message
  const detail = e instanceof PlatformError && e.providerDetail ? ` (${e.providerDetail})` : "";
  return `${kind}: ${text}${detail}`.replace(/\s+/gu, " ").trim().slice(0, 200);
}

/** «…events-v2: data/events/0/kind must be equal to…» → «…events-v2: data/events/0/kind». */
function schemaPathsOnly(message: string): string {
  const cut = message.indexOf(": ");
  const head = cut > 0 ? message.slice(0, cut) : message;
  const tail = cut > 0 ? message.slice(cut + 2) : "";
  const paths = [...new Set(tail.match(/\bdata(?:\/[^\s;,]+)*/gu) ?? [])];
  return paths.length ? `${head}: ${paths.join(", ")}` : tail ? `${head}: ${tail}` : head;
}

/**
 * Claim of a stage without a model: runStage, like runLlmStage, has its own claim_token. Long work (indexing a large
 * document) extends the claim (updated_at) — else a pg-boss retry by term would take the stage as orphaned and run
 * a second one in parallel — and before every write checks the claim is still its own. touch(c) — on the same transaction
 * connection: the stage row stays locked until commit, it cannot be taken over mid-write.
 */
export interface StageClaim {
  readonly token: string;
  /** Extend the claim; false — claim lost (the stage was taken by another process or reset): write nothing. */
  touch(c?: pg.Pool | pg.PoolClient): Promise<boolean>;
  /** Attempt number after the claim (attempts + 1): the pass knows its last attempt by it; manual runs have none. */
  readonly attempts?: number;
  /** Claim moment by the database clock: «Process now» pressed later is not lost (StageWait). */
  readonly claimedAt?: Date | null;
  /** last_error before this pass (the reason it waited for): a repeated wait backs off by it (indexing). */
  readonly lastError?: string | null;
}

/** The stage claim was lost mid-work: the late process leaves with nothing written (runStage — outcome null). */
export class StageClaimLost extends Error {
  constructor() { super("stage claim lost: another process runs the stage"); this.name = "StageClaimLost"; }
}

/**
 * The stage waits for an outside event: a place in the converter window, its answer, the end of a pause.
 * The pass is short: runStage returns the stage to pending with term `retryAt`, spends no attempt (`attempts − 1`, as
 * in the trash) and drops the claim; afterStage queues the next job with `startAfter = retry_at`. `code` — the reason in
 * last_error (`converter_wait:<reason>`; no content or file names); the workplace shows plain words by it.
 * `busy` — waiting for an unavailable service: `busy_retries` and `first_busy_at` grow (patience limit, alert)
 * `spend` — the pass does NOT return its attempt: a wait for the lock of the second transaction of indexRecord after the
 * vectors are paid; so the count of paid passes lives in `attempts`, and another wait (it returns only its own pass) does
 * not wipe it
 */
export class StageWait extends Error {
  constructor(readonly retryAt: Date, readonly code: string, readonly busy = false, readonly spend = false) { super(code); this.name = "StageWait"; }
}

/** Prefix of converter wait reasons: such `retry` outcomes are not journaled — polls do not litter it. */
export const CONVERTER_WAIT_PREFIX = "converter_wait:";

/** runStage outcome: retry — StageWait, the stage waits for its term without spending an attempt. */
export type RunStageStatus = "done" | "skipped" | "handoff" | "failed" | "retry";

/**
 * What runStage tells the caller beyond the outcome: wait reason and term (for afterStage, journal). `repeat` — the stage
 * already waited for the same reason (its stored last_error is the same code): afterStage writes no new event
 * (as `repeat` of runLlmStage).
 */
export interface RunStageInfo { wait?: { code: string; retryAt: Date | null; repeat?: boolean } }

/** Prefix of the money-budget wait: `model_budget:`. */
const MODEL_BUDGET_PREFIX = MODEL_BUDGET_TEXT.slice(0, MODEL_BUDGET_TEXT.indexOf(":") + 1);

/**
 * The term of a stage that waits for the money budget: processing.llm_gate.busy_backoff_cap_sec from now (30 minutes
 * by default) — the term `indexing.ts` sets when the embeddings call is stopped by the budget.
 */
function budgetWaitUntil(ctx: Ctx): Date {
  const sec = Number(ctx.settings.get("processing.llm_gate", LLM_GATE_DEFAULTS).busy_backoff_cap_sec ?? LLM_GATE_DEFAULTS.busy_backoff_cap_sec);
  return new Date(Date.now() + (Number.isFinite(sec) && sec > 0 ? sec : LLM_GATE_DEFAULTS.busy_backoff_cap_sec) * 1000);
}

/**
 * The stage waited for the money budget and the budget is still spent: the handler is not
 * run again — it would rewrite the chunks of the record every term only to be stopped before the first embeddings request.
 * A failed read of the spent amount lets the handler run (the guard of the transport decides then).
 */
async function stillOverBudget(ctx: Ctx, prevError: unknown): Promise<boolean> {
  if (typeof prevError !== "string" || !prevError.startsWith(MODEL_BUDGET_PREFIX)) return false;
  try { return (await ctx.platform?.budgetFresh?.()) != null; } catch { return false; }
}

/**
 * The kind of the failure that ends the waits of the second transaction of indexRecord (jobs/indexing.ts storeWait;
 * it spends an attempt) — one definition, read here by the claim and the failure branch.
 */
export const STORE_LOCKED_KIND = "index_store_locked";
const STORE_LOCKED_PREFIX = `${STORE_LOCKED_KIND}:`;

/** Pause before a search preparation retry after an embedder failure, seconds (doubling). */
export const INDEX_RETRY_MIN_SEC = 60;

/**
 * First pause before a search preparation retry: an embedder failure of a couple of minutes must not stop processing
 * for good — a minute or more by day, processing.retries.delay_sec or more at night. pg-boss takes it (retryDelay
 * doubled), and runStage writes the retry term to record_stages.retry_at, unless quota is out.
 */
export const indexRetryDelaySec = (lane: "now" | "night", delaySec: number): number => (lane === "now" ? INDEX_RETRY_MIN_SEC : Math.max(INDEX_RETRY_MIN_SEC, delaySec));

/**
 * Retry term of a failed search preparation, seconds from now: the first pause doubled for each past attempt (1 → 2 →
 * 4 min) — the lower bound of the pg-boss pause with retryBackoff. 0 — no retry (a final refusal, attempts used up or
 * the stage is not indexed): no term is set, and the workplace honestly shows «Failed». Pure: for tests.
 */
export function indexRetryAfterSec(o: { stage: Stage; lane: "now" | "night"; attempts: number; limit: number; terminal: boolean; delaySec: number }): number {
  return o.stage === "indexed" ? stageRetryAfterSec(o) : 0;
}

/** First pause after a conversion step error (job_error), seconds; then ×5. */
export const CONVERTER_JOB_ERROR_BASE_SEC = 300;
/** Cap of the conversion step error pause: with over 3 attempts it does not grow to a day (5 · 5ⁿ min). */
export const CONVERTER_JOB_ERROR_MAX_SEC = 6 * 3600;

/**
 * Retry term of a failed stage, seconds from now (a generalization of indexRetryAfterSec).
 * 0 — no retry: a final refusal, attempts used up or the stage runs its retries elsewhere (model stages —
 * their own retry machine, the rest — the pg-boss pause). Search preparation — first lane pause, doubled (1→2→4 min);
 * conversion — 300 · 5^(attempts − 1) s (5 → 25 min): afterStage queues the retry by this term, not pg-boss. Pure; tests.
 */
export function stageRetryAfterSec(o: { stage: Stage; lane: "now" | "night"; attempts: number; limit: number; terminal: boolean; delaySec: number }): number {
  if (o.terminal || o.attempts >= o.limit) return 0;
  const n = Math.max(0, o.attempts - 1);
  if (o.stage === "indexed") return indexRetryDelaySec(o.lane, o.delaySec) * 2 ** n;
  if (o.stage === "converted") return Math.min(CONVERTER_JOB_ERROR_MAX_SEC, CONVERTER_JOB_ERROR_BASE_SEC * 5 ** n);
  return 0;
}

/** Wait reason of a stage of a record in the trash: it is not «skipped for good» but goes on after a restore. */
export const IN_TRASH_TEXT = "in_trash: the record is in the trash — the stage goes on after a restore";

/** The record is in the trash and not yet purged: its stages wait for a restore, not skipped for good. */
async function inTrash(db: pg.Pool, recordId: string): Promise<boolean> {
  return Boolean((await db.query("SELECT 1 FROM records WHERE id = $1 AND deleted_at IS NOT NULL AND purge_after > now()", [recordId])).rowCount);
}

/**
 * Log line fields of a converter error without its text: HTTP code, length of `detail` and the first 12 hex
 * of its sha256. Exported for the test.
 */
export function converterDetailMeta(e: ConverterError): { status: number | null; detail_len: number; detail_fp: string | null } {
  const d = e.detail ?? "";
  return { status: e.status ?? null, detail_len: d.length, detail_fp: d ? createHash("sha256").update(d).digest("hex").slice(0, 12) : null };
}

/** Reason kind for last_error, as before the model gate: the panel and the tests read the reason. */
function errorKind(e: unknown): string {
  return e instanceof PlatformError ? (e.kind === "timeout" ? "llm_timeout" : e.kind === "schema_error" ? "schema_error" : `platform_${e.kind}`)
    : e instanceof ConverterError ? `converter_${e.kind}` : e instanceof StageRefused || e instanceof StageFault ? e.kind
    : e instanceof EntityResolverError ? e.kind : "error";
}

/**
 * Run of a stage without a model: running → work → done with the version or failed with a reason (no silent skip).
 * Model stages are run by runLlmStage — under a slot and with its own retry machine.
 * null — the stage was not claimed (done in that version or run by another job): the caller writes no audit and does not
 * plan on — else every duplicate job would leave a processing event.
 * "failed" — a terminal refusal, nothing to repeat (the converter rejected the document, the run was cancelled, export
 * empty, the answer overran the cap). No exception: pg-boss does not repeat it; the record shows «unprocessed».
 * The terminal mark is a separate column `terminal`, not a tweaked counter: the admin sees the real number
 * of attempts, and the panel — that a repeat gives the same refusal. A stage claim clears the mark: the admin's
 * repeat («Retry») honestly runs anew.
 */
/**
 * handoff: the stage went to a class move or to the class the record moved to — the work already set its status
 * itself (pending in the right database); runStage leaves it, the caller wakes the move with a kick job.
 * A safety net for any stage: the outcome mark landed in no row (0 rows — a class move removed them
 * while the stage worked), and the locator names another class — the move copied the stage `running` there, to hang
 * until stuck_running_hours. It goes back to pending: handoff.
 */
/**
 * The move deletes the source rows (its stage rows with them) BEFORE it switches the locator
 * (maintenance.ts, the last control transaction). A stage that ends in that window finds no row of its own and a locator
 * that still names its class: the copy in the other class — copied as is, `running` with this stage's claim token —
 * stayed `running` until stuck_running_hours. `own` — this stage's claim token: in that window only that copy is
 * returned to pending (a random token: nothing another process claimed is touched).
 */
async function handoffMoved(ctx: Ctx, job: StageJob, token?: string, own?: string): Promise<boolean> {
  const loc = (await ctx.db.control.query("SELECT class, deleted FROM record_locations WHERE record_id = $1", [job.record_id])).rows[0];
  if (!loc || loc.deleted) return false;
  if (loc.class === job.class) {
    if (!own) return false;
    const other: DataClass = job.class === "open" ? "closed" : "open";
    const r = await recordsDb(ctx, other).query(
      `UPDATE record_stages SET status = 'pending', attempts = 0, terminal = false, last_error = $3, updated_at = now()
       WHERE record_id = $1 AND stage = $2 AND status = 'running' AND claim_token = $4`,
      [job.record_id, job.stage, "handoff: the record moved to the other data class during the stage", own]);
    return (r.rowCount ?? 0) > 0;
  }
  // `token` — only a copy of its own claim (a move copies the stage row as is): a stage another process claimed there
  // is left alone
  const r = await recordsDb(ctx, loc.class as DataClass).query(
    `UPDATE record_stages SET status = 'pending', attempts = 0, terminal = false, last_error = $3, updated_at = now()
     WHERE record_id = $1 AND stage = $2 AND status = 'running'${token ? " AND claim_token = $4" : ""}`,
    [job.record_id, job.stage, "handoff: the record moved to the other data class during the stage", ...(token ? [token] : [])]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * retry — the work threw StageWait: the stage is pending again with a term, the attempt
 * returned, the claim dropped; reason and term — in `info.wait` (afterStage queues with `startAfter = retry_at`).
 * A conversion step error (job_error) — failed with term 300 · 5^(attempts − 1) s, outcome "failed", no exception:
 * afterStage queues the retry by retry_at, not pg-boss; after processing.retries.limit attempts no term — a final failed.
 */
export async function runStage(ctx: Ctx, job: StageJob, work: (claim: StageClaim) => Promise<"done" | "skipped" | "handoff">, info?: RunStageInfo): Promise<RunStageStatus | null> {
  const db = recordsDb(ctx, job.class);
  const cur = (await db.query("SELECT status, version FROM record_stages WHERE record_id = $1 AND stage = $2", [job.record_id, job.stage])).rows[0];
  if (!cur || ((cur.status === "done" || cur.status === "skipped") && cur.version === job.version)) return null;   // a job repeat is safe
  // the claim is atomic: «night» and «now» lane jobs of one stage do not run it twice (else two summaries per transcript)
  // `running` longer than its lane's job lifetime is an orphaned stage (the worker died mid-work): pg-boss already dropped
  // that job by expireInSeconds, so a retry may take it. Else the claim would block the queue's own self-healing.
  // Live long work extends the claim (claim.touch), so a pg-boss retry by term does not take it.
  // The retry term (retry_at, search preparation after an embedder failure) has not come — no claim: a second
  // job of the same stage (scheduler, kick) does not bypass the pause; «Retry» and «Process now» lift the term
  const r = ctx.settings.get("processing.retries", { limit: 3, delay_sec: 300, expire_now_sec: 900, expire_night_sec: 3600 });
  const token = randomUUID();
  // a stage failed `index_store_locked` on its last attempt is not taken — not by a queue retry,
  // a kick or a scan — until its attempts are reset: «Retry» (gateway admin.ts), «Process now» and the MCP tool
  // `memory_process_now` (gateway write.ts processNow) set it `pending` with 0 attempts; a new version has a stage of its own;
  // a `processing.retries.limit` raised above its attempts lets it run again
  const claimed = await db.query(
    `UPDATE record_stages SET status = 'running', attempts = attempts + 1, terminal = false, claim_token = $4, retry_at = NULL, updated_at = now()
     WHERE record_id = $1 AND stage = $2
       AND ((status IN ('pending','failed') AND (retry_at IS NULL OR retry_at <= now())) OR (status = 'running' AND updated_at < now() - make_interval(secs => $3)))
       AND NOT (status = 'failed' AND attempts >= $5::int AND COALESCE(last_error, '') LIKE '${STORE_LOCKED_PREFIX}%')
     RETURNING attempts, updated_at AS claimed_at, last_error AS prev_error`,
    [job.record_id, job.stage, job.expire_sec ?? (job.lane === "now" ? r.expire_now_sec : r.expire_night_sec), token, r.limit]);
  if (!claimed.rowCount) return null;
  // the claim does not change last_error: RETURNING gives the reason the stage waited for before this pass
  const prevError: unknown = claimed.rows[0]?.prev_error ?? null;
  const attempts = Number(claimed.rows[0]?.attempts ?? 0);
  const claimedAt = claimed.rows[0]?.claimed_at ? new Date(claimed.rows[0].claimed_at) : null;
  // outcome writes are fenced by the token — a late process (its stage reclaimed) overwrites no other outcome
  const fence = "record_id = $1 AND stage = $2 AND claim_token = $3";
  const claim: StageClaim = {
    token, attempts, claimedAt, lastError: typeof prevError === "string" ? prevError : null,
    touch: async (c: pg.Pool | pg.PoolClient = db) => ((await c.query(`UPDATE record_stages SET updated_at = now() WHERE ${fence}`, [job.record_id, job.stage, token])).rowCount ?? 0) > 0,
  };
  const started = Date.now();
  try {
    if (await stillOverBudget(ctx, prevError)) throw new StageWait(budgetWaitUntil(ctx), MODEL_BUDGET_TEXT, false);
    const status = await work(claim);
    if (status === "handoff") {
      log.info("stage_handoff", { stage: job.stage, record_id: job.record_id, lane: job.lane, ms: Date.now() - started });
      return status;
    }
    // a record in the trash: the stage is not «skipped for good» but waits for a restore; the claim attempt returns
    if (status === "skipped" && await inTrash(db, job.record_id)) {
      await db.query(`UPDATE record_stages SET status = 'pending', attempts = GREATEST(attempts - 1, 0), last_error = $4, claim_token = NULL, updated_at = now() WHERE ${fence}`,
                     [job.record_id, job.stage, token, IN_TRASH_TEXT]);
      log.info("stage_in_trash", { stage: job.stage, record_id: job.record_id, lane: job.lane });
      return null;
    }
    // duration_ms — from the claim to the end: the morning report counts p50/p95 per stage; the wait
    // marks (StageWait busy) do not stay on a finished stage
    const marked = await db.query(`UPDATE record_stages SET status = $4, version = $5, last_error = NULL, duration_ms = $6, claim_token = NULL, busy_retries = 0, first_busy_at = NULL, updated_at = now() WHERE ${fence}`,
                                  [job.record_id, job.stage, token, status, job.version, Date.now() - started]);
    if (marked.rowCount === 0) {
      // handoffMoved now asks the other class's database too — its failure after finished work is
      // «claim lost», as at the other four sites, not a stage error
      if (await handoffMoved(ctx, job, undefined, token).catch(() => false)) {
        log.info("stage_handoff", { stage: job.stage, record_id: job.record_id, lane: job.lane, after: status, ms: Date.now() - started });
        return "handoff";
      }
      log.warn("stage_claim_lost", { stage: job.stage, record_id: job.record_id, after: status, ms: Date.now() - started });
      return null;
    }
    log.info("stage_done", { stage: job.stage, status, record_id: job.record_id, lane: job.lane, ms: Date.now() - started });
    return status;
  } catch (e) {
    // another process took the claim and writes the outcome — this one leaves quietly, no pg-boss retry. Or the stage row
    // was deleted by a class move («Close» mid-work) that copied it to another class as `running`, old claim: there
    // it is pending again — as for the outcome writes with 0 rows below
    if (e instanceof StageClaimLost) {
      if (await handoffMoved(ctx, job, token, token).catch(() => false)) {
        log.info("stage_handoff", { stage: job.stage, record_id: job.record_id, lane: job.lane, after: "claim_lost", ms: Date.now() - started });
        return "handoff";
      }
      log.warn("stage_claim_lost", { stage: job.stage, record_id: job.record_id, ms: Date.now() - started });
      return null;
    }
    // a wait: pending with a term, the attempt returned, the claim dropped. «Process
    // now» or «Check now» pressed during the pass (processNow does not touch running) are not lost: the mark
    // wake_requested_at newer than the claim — the term is «now», not long. Fenced by the token; 0 rows — moved (handoff)
    // or the stage reclaimed (null)
    if (e instanceof StageWait) {
      const code = e.code.replace(/\s+/gu, " ").trim().slice(0, 200) || `${CONVERTER_WAIT_PREFIX}wait`;
      const at = Number.isFinite(e.retryAt.getTime()) ? e.retryAt : new Date();
      // a pass of `indexed` past the stage's last attempt (a queue retry of a failure on the last
      // attempt) that waits does not make the stage `pending` — a pending stage is scheduled whatever its attempts, with
      // fresh queue retries. It is failed again with no term and keeps its reason; the pass ends with nothing written else
      const past = job.stage === "indexed" && (e.spend ? attempts : Math.max(attempts - 1, 0)) >= r.limit;
      // a paid wait keeps the attempt of its pass (a constant fragment, no input in the text)
      const w = past
        ? await db.query(
          `UPDATE record_stages SET status = 'failed', attempts = ${e.spend ? "attempts" : "GREATEST(attempts - 1, 0)"}, last_error = COALESCE(last_error, $4),
                  retry_at = NULL, claim_token = NULL, updated_at = now()
           WHERE ${fence}
           RETURNING retry_at`,
          [job.record_id, job.stage, token, code])
        : await db.query(
        `UPDATE record_stages SET status = 'pending', attempts = ${e.spend ? "attempts" : "GREATEST(attempts - 1, 0)"}, last_error = $4,
                retry_at = CASE WHEN (SELECT CASE WHEN attrs->>'wake_requested_at' ~ '^\\d{4}-\\d{2}-\\d{2}' THEN (attrs->>'wake_requested_at')::timestamptz END
                                        FROM records WHERE id = $1) > $7::timestamptz
                                THEN now() ELSE $5::timestamptz END,
                busy_retries = CASE WHEN $6::boolean THEN busy_retries + 1 ELSE 0 END,
                first_busy_at = CASE WHEN $6::boolean THEN COALESCE(first_busy_at, now()) ELSE NULL END,
                claim_token = NULL, updated_at = now()
         WHERE ${fence}
         RETURNING retry_at`,
        [job.record_id, job.stage, token, code, at, e.busy, claimedAt]);
      if (!w.rowCount) {
        if (await handoffMoved(ctx, job, token, token).catch(() => false)) {
          log.info("stage_handoff", { stage: job.stage, record_id: job.record_id, lane: job.lane, after: "wait", ms: Date.now() - started });
          return "handoff";
        }
        log.warn("stage_claim_lost", { stage: job.stage, record_id: job.record_id, after: "wait", ms: Date.now() - started });
        return null;
      }
      if (past) {
        log.info("stage_wait_past_limit", { stage: job.stage, record_id: job.record_id, lane: job.lane, code: code.split(":").slice(0, 2).join(":").trim(), attempts, ms: Date.now() - started });
        return null;
      }
      const retryAt = w.rows[0]?.retry_at ? new Date(w.rows[0].retry_at) : null;
      // a wait for the same reason is a repeat whatever its count — the hold's tail `(wait N, since T)` changes
      // every time, and a held record left one processing event per wait
      if (info) info.wait = { code, retryAt, ...(waitReasonHead(prevError) === waitReasonHead(code) ? { repeat: true } : {}) };
      // to the log — only the reason kind (`converter_wait:queue`), no tail; the term and busy mark
      log.info("stage_wait", { stage: job.stage, record_id: job.record_id, lane: job.lane, code: code.split(":").slice(0, 2).join(":").trim(),
                               retry_at: retryAt?.toISOString() ?? null, busy: e.busy, ms: Date.now() - started });
      return "retry";
    }
    const kind = errorKind(e);
    const terminal = (e instanceof ConverterError && e.terminal) || e instanceof StageRefused;
    // search preparation waits for the embedder: the retry term is in the stage row, not only the pg-boss job; seen by
    // the scheduler (scan, both lanes' startAfter), claim and workplace («Preparing» while a retry waits). A conversion
    // step error (job_error) — also a term in the stage row: 5 → 25 min
    // a non-final refusal with attempts used up (conversion queue: «the converter does not give out this document's
    // result», «no answer for N h»): failed with no retry term, attempts at least the limit, no terminal — «Process now»
    // and «Retry» work
    // Exhausted provider quota during indexing takes the same outcome.
    const exhausted = !terminal && (
      (e instanceof ConverterError && e.exhausted === true) ||
      (job.stage === "indexed" && e instanceof PlatformError && e.kind === "quota")
    );
    const retryAfter = exhausted ? 0 : stageRetryAfterSec({ stage: job.stage, lane: job.lane, attempts, limit: r.limit, terminal, delaySec: r.delay_sec });
    // a retry could reclaim and finish an orphaned stage: a late failure of the first job does not undo its done/skipped
    const failed = await db.query(
      `UPDATE record_stages SET status = 'failed', terminal = $6, last_error = $4, duration_ms = $5, claim_token = NULL,
              retry_at = CASE WHEN $7::int > 0 THEN now() + make_interval(secs => $7::int) ELSE NULL END,
              attempts = CASE WHEN $8::boolean THEN GREATEST(attempts, $9::int) ELSE attempts END,
              -- an exhausted wait (patience with an unavailable converter): Retry starts the count again instead of failing at once
              busy_retries = CASE WHEN $8::boolean THEN 0 ELSE busy_retries END,
              first_busy_at = CASE WHEN $8::boolean THEN NULL ELSE first_busy_at END, updated_at = now()
       WHERE ${fence} AND status NOT IN ('done','skipped')`,
      [job.record_id, job.stage, token, stageErrorText(kind, e), Date.now() - started, terminal, retryAfter, exhausted, r.limit]);
    if (failed.rowCount === 0) {
      // no rows — the record moved to another class while the stage worked: the stage is pending there again
      if (await handoffMoved(ctx, job, undefined, token).catch(() => false)) {
        log.warn("stage_handoff_after_error", { stage: job.stage, record_id: job.record_id, kind, ms: Date.now() - started });
        return "handoff";
      }
      // the stage was reclaimed by another process (or finished): this late failure is not its outcome
      log.warn("stage_claim_lost", { stage: job.stage, record_id: job.record_id, after: "failed", kind, ms: Date.now() - started });
      return null;
    }
    // a foreign service's text (converter detail, archive file names) is not logged at any level: it
    // may hold the name of an uploaded closed file. For analysis — HTTP code, length and text fingerprint (equal errors
    // group without text); the full text is in the converter journal by run_id (converter_failed, jobs/convert.ts)
    log.warn("stage_failed", { stage: job.stage, record_id: job.record_id, kind, terminal, ms: Date.now() - started,
                               ...(e instanceof ConverterError ? converterDetailMeta(e) : {}), ...(retryAfter ? { retry_after_sec: retryAfter } : {}) });
    if (terminal || exhausted) return "failed";                                // nothing to repeat: the job ends with no exception
    // the failure of the last attempt over a lock of the second transaction of indexRecord ends its
    // job without an exception — a queue retry would be one more paid pass under the same lock
    if (e instanceof StageFault && e.kind === STORE_LOCKED_KIND) return "failed";
    // a conversion step error (job_error): no exception — afterStage queues the retry
    // with `startAfter = retry_at` (nextStage gives failed with attempts left plus the term), not pg-boss; on the last
    // attempt there is no term — a final failed, no more jobs
    if (job.stage === "converted") return "failed";
    throw e;                                                                    // pg-boss retries with a growing pause (indexed: not before retry_at)
  }
}

/**
 * Outcome of a model stage. retry — the model is busy or slow, the stage waits for it (pending, the attempt not
 * spent); deferred — the record went to night («now» lane patience ran out or the record is «too slow»); failed —
 * an error (answer off the schema, a code fault) or «too slow» at night; refused — terminal, nothing to repeat.
 */
export interface LlmStageResult {
  status: "done" | "skipped" | "handoff" | "failed" | "deferred" | "retry" | "refused";
  /** Outcome kind: model stages — PlanKind; a wait of a stage without a model (StageWait) — its reason (`converter_wait:…`). */
  kind?: PlanKind | (string & {}); retry_at?: string | null; busy_retries?: number; slow_retries?: number; reason?: "model_busy" | "too_slow";
  /** kind `blocked` only: the same refusal text as the stage already stored — no new audit event. */
  repeat?: boolean;
}

/** What was «slow» — in words for last_error. */
function slowWhat(e: unknown): string {
  if (e instanceof PlatformError && e.kind === "http" && e.status !== undefined) return e.status === 408 ? "408" : `gateway error ${e.status}`;
  return "timeout";
}

/** The outcome write did not land (0 rows): the record moved class — handoff; else another process took the claim. */
async function claimLost(ctx: Ctx, job: StageJob, after: string, ms: number, own?: string): Promise<LlmStageResult | null> {
  if (await handoffMoved(ctx, job, undefined, own).catch(() => false)) {
    log.info("stage_handoff", { stage: job.stage, record_id: job.record_id, lane: job.lane, after, ms });
    return { status: "handoff" };
  }
  log.warn("llm_claim_lost", { stage: job.stage, record_id: job.record_id, after });
  return null;
}

/**
 * A model stage under a slot. The claim sets its own claim_token and the slot's connection name
 * (claimed_by — the scheduler spots an orphan by it); outcome writes are fenced by the token — a late process overwrites
 * no other outcome. No exception goes out: the outcome is in the stage row and the result; record_stages retries,
 * not pg-boss. null — not claimed (already done, too early, a duplicate job) or the claim taken over.
 * now — the clock for term decisions (a test parameter).
 */
export async function runLlmStage(ctx: Ctx, job: StageJob, slot: LlmSlot, work: () => Promise<"done" | "skipped" | "handoff">, now: () => Date = () => new Date()): Promise<LlmStageResult | null> {
  const db = recordsDb(ctx, job.class);
  const cur = (await db.query("SELECT status, version FROM record_stages WHERE record_id = $1 AND stage = $2", [job.record_id, job.stage])).rows[0];
  if (!cur || ((cur.status === "done" || cur.status === "skipped") && cur.version === job.version)) return null;
  const token = randomUUID();
  const claimed = await db.query(
    `UPDATE record_stages SET status = 'running', attempts = attempts + 1, terminal = false, claim_token = $3, claimed_by = $4, updated_at = now()
     WHERE record_id = $1 AND stage = $2 AND status IN ('pending','failed')
       AND (retry_at IS NULL OR retry_at <= now())
       AND NOT (status = 'failed' AND COALESCE(last_error, '') LIKE '${TOO_SLOW_PREFIX}%')
     RETURNING attempts, busy_retries, slow_retries, first_busy_at, last_error`, [job.record_id, job.stage, token, slot.owner]);
  if (!claimed.rowCount) return null;
  const row = claimed.rows[0];
  const counters = { busy_retries: Number(row.busy_retries), slow_retries: Number(row.slow_retries) };
  await slot.annotate?.({ stage: job.stage, lane: job.lane, record_id: job.record_id }).catch(() => undefined);
  const fence = "record_id = $1 AND stage = $2 AND claim_token = $3";
  const started = Date.now();
  try {
    const status = await llmStageStore.run({ slot, job, counters }, work);
    if (status === "handoff") {
      log.info("stage_handoff", { stage: job.stage, record_id: job.record_id, lane: job.lane, ms: Date.now() - started });
      return { status };
    }
    // a record in the trash: the stage waits for a restore, not «skipped for good»; the claim attempt is returned
    if (status === "skipped" && await inTrash(db, job.record_id)) {
      const back = await db.query(`UPDATE record_stages SET status = 'pending', attempts = GREATEST(attempts - 1, 0), last_error = $4, claim_token = NULL, updated_at = now() WHERE ${fence}`,
                                  [job.record_id, job.stage, token, IN_TRASH_TEXT]);
      if (!back.rowCount) return claimLost(ctx, job, "in_trash", Date.now() - started, token);
      log.info("stage_in_trash", { stage: job.stage, record_id: job.record_id, lane: job.lane });
      return null;
    }
    const marked = await db.query(
      // attempts counts only real errors: success returns the claim attempt
      `UPDATE record_stages SET status = $4, version = $5, last_error = NULL, duration_ms = $6, retry_at = NULL, first_busy_at = NULL,
              attempts = GREATEST(attempts - 1, 0), busy_retries = 0, slow_retries = 0, claim_token = NULL, updated_at = now() WHERE ${fence}`,
      [job.record_id, job.stage, token, status, job.version, Date.now() - started]);
    if (!marked.rowCount) return claimLost(ctx, job, status, Date.now() - started, token);
    // the record got its model: the status needs no wait reason any more
    await db.query("UPDATE records SET attrs = attrs - 'deferred_reason' - 'deferred_to_night_at' WHERE id = $1 AND (attrs ? 'deferred_reason' OR attrs ? 'deferred_to_night_at')", [job.record_id]);
    log.info("stage_done", { stage: job.stage, status, record_id: job.record_id, lane: job.lane, ms: Date.now() - started });
    return { status };
  } catch (e) {
    const ms = Date.now() - started;
    if (e instanceof StageRefused || (e instanceof ConverterError && e.terminal)) {
      const r = await db.query(
        `UPDATE record_stages SET status = 'failed', terminal = true, last_error = $4, duration_ms = $5, retry_at = NULL, claim_token = NULL, updated_at = now() WHERE ${fence}`,
        [job.record_id, job.stage, token, stageErrorText(errorKind(e), e), ms]);
      if (!r.rowCount) return claimLost(ctx, job, "refused", ms, token);
      log.warn("stage_failed", { stage: job.stage, record_id: job.record_id, kind: errorKind(e), terminal: true, ms });
      return { status: "refused" };
    }
    const k = callKind(e);
    const abortCause = abortedBy(e);
    const [retry, breaker, rec, gate] = await Promise.all([
      readProcessingSetting(ctx.db.control, ctx.instanceId, "llm_retry", LLM_RETRY_DEFAULTS),
      ctx.db.control.query(
        `SELECT value->>'last_success_at' AS at, value->>'last_success_record' AS rec, value->>'last_other_success_at' AS other
           FROM maintenance_state WHERE instance_id = $1 AND key = 'llm_breaker'`, [ctx.instanceId]),
      db.query("SELECT attrs->>'process_now_at' AS process_now_at FROM records WHERE id = $1", [job.record_id]),
      // Blocked calls use busy_backoff_cap_sec. Repeated record-check faults use busy_backoff_sec.
      k === "blocked" || (k === "aborted" && abortCause === "record_check")
        ? readProcessingSetting(ctx.db.control, ctx.instanceId, "llm_gate", LLM_GATE_DEFAULTS) : undefined,
    ]);
    // «the model answered others» — only answers to other records: successful parts of this same meeting do not count
    const b = breaker.rows[0];
    const lastSuccess = lastOtherSuccess(b ? { last_success_at: b.at ?? null, last_success_record: b.rec ?? undefined, last_other_success_at: b.other ?? null } : null, job.record_id);
    const plan = planLlmOutcome(k === "ok" ? "error" : k, { attempts: Number(row.attempts), ...counters, first_busy_at: row.first_busy_at ? new Date(row.first_busy_at) : null },
      { retry, retries: ctx.settings.get("processing.retries", { limit: 3, delay_sec: 300, backoff: true }), win: nightWindowOf(ctx.settings), gate },
      now(), { lane: job.lane, processNowAt: rec.rows[0]?.process_now_at ?? null, lastSuccessAt: lastSuccess, slowWhat: slowWhat(e), errorText: stageErrorText(errorKind(e), e),
               blockedBy: blockedBy(e), abortedBy: abortCause, prevError: row.last_error });
    const upd = await db.query(
      `UPDATE record_stages SET status = $4, attempts = $5, busy_retries = $6, slow_retries = $7, first_busy_at = $8, retry_at = $9, last_error = $10,
              terminal = false, duration_ms = $11, claim_token = NULL, updated_at = now() WHERE ${fence}`,
      [job.record_id, job.stage, token, plan.status, plan.attempts, plan.busy_retries, plan.slow_retries, plan.first_busy_at, plan.retry_at, plan.last_error.slice(0, 200), ms]);
    if (!upd.rowCount) return claimLost(ctx, job, plan.kind, ms, token);
    const retryAt = plan.retry_at?.toISOString() ?? null;
    if (plan.defer) {
      await db.query(`UPDATE records SET attrs = (attrs - 'process_now_at') || jsonb_build_object('deferred_reason', $2::text, 'deferred_to_night_at', now()) WHERE id = $1`, [job.record_id, plan.defer]);
      log.warn("llm_deferred_to_night", { stage: job.stage, record_id: job.record_id, reason: plan.defer, busy_retries: plan.busy_retries, slow_retries: plan.slow_retries });
    }
    if (plan.kind === "too_slow") log.warn("llm_too_slow", { stage: job.stage, record_id: job.record_id, lane: job.lane, slow_retries: plan.slow_retries, deferred: Boolean(plan.defer) });
    if (plan.result === "retry") log.info("llm_retry_scheduled", { stage: job.stage, record_id: job.record_id, kind: plan.kind, retry_at: retryAt, busy_retries: plan.busy_retries, slow_retries: plan.slow_retries });
    if (plan.result === "failed") log.warn("stage_failed", { stage: job.stage, record_id: job.record_id, kind: plan.kind === "error" ? errorKind(e) : plan.kind, attempts: plan.attempts, retry_at: retryAt, ms });
    // the same refusal as the stored one (the capture keeps last_error) — afterStage writes no new event
    const repeat = plan.kind === "blocked" && row.last_error === plan.last_error.slice(0, 200);
    return { status: plan.result, kind: plan.kind, retry_at: retryAt, busy_retries: plan.busy_retries, slow_retries: plan.slow_retries, ...(plan.defer ? { reason: plan.defer } : {}),
             ...(repeat ? { repeat: true } : {}) };
  }
}

/**
 * The versions a fresh installation runs its stages with: the seed value of `processing.prompts`. The prompt of the stage
 * `described` is named describe-…, not described-…; `entities` has no model and no prompt file.
 */
export const DEFAULT_PROMPT_VERSIONS = Object.freeze({ summary: "summary-v2", events: "events-v4", described: "describe-v2", entities: "entities-v1" });

const promptUsable = new Map<string, boolean>();
const promptReplaced = new Set<string>();

/**
 * The version a stage runs with, given the version that a setting or a queued job names. For a model stage a version
 * whose prompt this release does not have (removed since it was saved or queued, mistyped, the prompt of another stage, a
 * file that does not load) is replaced by the default of the stage: the stage runs with the default instead of failing,
 * and the replacement is logged once per process as `prompt_version_replaced`. No version at all gives the default too.
 */
export function usablePromptVersion(stage: keyof typeof DEFAULT_PROMPT_VERSIONS, version: unknown, from: "setting" | "job" = "setting"): string {
  const fallback = DEFAULT_PROMPT_VERSIONS[stage];
  if (typeof version !== "string" || !version) return fallback;
  if (stage === "entities") return version;
  const key = `${stage}:${version}`;
  let usable = promptUsable.get(key);
  if (usable === undefined) {
    // a version is a plain file name: a value that could name a file outside the prompts directory is never opened
    try { usable = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(version) && loadPromptVersion(version).stage === stage; } catch { usable = false; }
    promptUsable.set(key, usable);
  }
  if (usable) return version;
  if (!promptReplaced.has(`${from}:${key}`)) {
    promptReplaced.add(`${from}:${key}`);
    log.warn("prompt_version_replaced", { stage, from, configured: version.slice(0, 80), used: fallback });
  }
  return fallback;
}

/** A queued model stage job with a version its stage can run with: a job queued before an upgrade runs with the default. */
export function usableJob(job: StageJob): StageJob {
  if (job.stage !== "summary" && job.stage !== "events" && job.stage !== "described") return job;
  const version = usablePromptVersion(job.stage, job.version, "job");
  return version === job.version ? job : { ...job, version };
}
