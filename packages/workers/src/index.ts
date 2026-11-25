// pg-boss workers and the stage scheduler. The source of truth is record_stages; the queue only executes.
import { PgBoss } from "pg-boss";
import pg from "pg";
import { AnchorsError, Databases, deployProfile, DeployProfileError, gateConnect, nightWindowOf, initAnchors, inWindow, listenSecurityMode, LLM_GATE_DEFAULTS, LlmGate, loadServiceSecrets, log, PgTlsConfigError, makeS3Client, pgTls, Platform, readEnv, registerInstanceLocale, Settings, WORKER_DB_ROLES, UsageRecorder, type DataClass, type NightWindow } from "@memory/shared";
import { auditWorker, recordsDb, stageChat, wireModelGate, wireUsage, type Ctx } from "./ctx.ts";
import { LLM_STAGES, QUEUE_OF, type Stage, type StageClaim, type StageJob } from "./stages.ts";
import { LLM_QUEUES, makeScheduler, reclaimOnStart } from "./scheduler.ts";
import { makeStageLoop } from "./stage-loop.ts";
import { startLlmDispatcher } from "./llm-dispatch.ts";
import { fixLlmJobs, migrateStuckLlmFailures } from "./llm-migrate.ts";
import { installLlmHooks } from "./llm-fake.ts";
import { CONVERTER_CAPS_EVERY_MS, convertPass, refreshConverterCaps } from "./jobs/convert-pass.ts";
import { indexRecord } from "./jobs/indexing.ts";
import { embedBackfill, reembedSettings } from "./jobs/embed-backfill.ts";
import { scheduleReconcile } from "./jobs/embedders.ts";
import { scheduleFtsReconcile } from "./jobs/fts-config.ts";
import { describe, extractEvents, summarize } from "./jobs/llm.ts";
import { linkEntities } from "./jobs/entities.ts";
import { namedLinksPass } from "./jobs/named.ts";
import { auditMaint, dismissedRetention, fallbackRetryDelaySec, kickPurge, moveClass, profilesSync, projectTagsSync, purgeRetrying, reconcileClasses, reextractNightly, spaceInvitesExpire } from "./jobs/maintenance.ts";
import { testLeftoversPass } from "./jobs/leftovers.ts";
import { testPurgeAuto } from "./jobs/leftovers-purge.ts";
import { storageSweep } from "./jobs/storage-sweep.ts";
import { mailTick } from "./jobs/mail.ts";
import { orgReviewTick, type OrgReviewPart } from "./jobs/org-review.ts";
import { morningNoteTick } from "./jobs/morning-note.ts";
import { outcomesBuild, type PassOpts } from "./jobs/outcomes.ts";
import { auditMaintPool } from "./audit-maint-pool.ts";
import { auditSpoolDrain } from "./jobs/audit-spool.ts";
import { auditOutboxDrain } from "./jobs/audit-outbox.ts";
import { ARCHIVE_OFFSET_MS, archiveDropGate, auditArchivePass } from "./jobs/audit-archive.ts";
import { registerAdminPlaneJobs } from "./jobs/admin-plane.ts";
import { registerEdgeCanary } from "./jobs/edge-canary.ts";
import { registerOpenRecheck } from "./jobs/open-recheck.ts";
import { registerAlertDetectors } from "./jobs/ops-alerts.ts";
import { registerConnectorJobs } from "./jobs/connectors.ts";
import { workerExternalLookup } from "./jobs/entity-lookup.ts";
import { workerQueueOptions } from "./queue-options.ts";
import { failureLine, timerEvery } from "./timer.ts";

// deploy profile — first, as in the gateway: an unknown MEMORY_DEPLOY_PROFILE stops the start, a
// typo must not pass silently here while the gateway refuses it. Unset — the strictest profile (internet)
try { deployProfile(); }
catch (e) {
  if (e instanceof DeployProfileError) { log.error("deploy_profile_invalid", { error: e.message }); process.exit(1); }
  throw e;
}

// a refused PostgreSQL TLS configuration stops the start with one line; any other error is thrown on
let env: ReturnType<typeof readEnv>;
try { env = readEnv(); }
catch (e) {
  if (e instanceof PgTlsConfigError) { log.error("pg_tls_invalid", { error: e.message }); process.exit(1); }
  throw e;
}
// keys from own files: role passwords, settings key, consent keys; a missing one — from PG_APP_PASSWORD as before.
// memory_audit_reader — journal reads (db.auditRead(): journal export, reconciliation, leftovers, «on behalf» watching)
const secrets = loadServiceSecrets(env, WORKER_DB_ROLES);
if (secrets.legacy.length) log.info("secrets_legacy", { names: secrets.legacy });
const db = new Databases({ ...env, role: "worker" });
const settings = new Settings(db.control, env.instanceId, env.appSecret, secrets.settingsKeyring);
// the instance language (locale.language) is the language of everything rendered outside a request: mail, alerts, jobs
registerInstanceLocale(settings);
for (let i = 0; ; i++) { try { await settings.load(true); break; } catch (e) { if (i > 30) throw e; await new Promise((r) => setTimeout(r, 2000)); } }
log.setLevel(settings.get("observability.log_level", "info"));
// trust anchors inside: the workers reach pinned addresses (mail, CRM, converter, models) — the same pins
// as the gateway's (shared/src/anchors.ts). A signers file exists but the check failed — the workers do not start
// audit — anchors_apply / anchors_reject events and alerts in the journal
try { await initAnchors({ process: "workers", db: db.control, audit: db.audit, instanceId: env.instanceId, appSecret: env.appSecret, settings }); }
catch (e) {
  if (e instanceof AnchorsError) { log.error(e.code, { error: e.message.slice(0, 300) }); process.exit(1); }
  throw e;
}
const win = (): NightWindow => nightWindowOf(settings);

const boss = new PgBoss(workerQueueOptions(env, secrets.pgPassword("memory_worker")));
boss.on("error", failureLine("queue_error"));   // a class, never the driver's text (timer.ts)
await boss.start();
// the gateway sends kick jobs and counts queue places: the owner of schema pgboss grants rights — the worker
const grants = new pg.Client({ host: env.pgHost, port: env.pgPort, database: "memory_control", user: "memory_worker", password: secrets.pgPassword("memory_worker"), ssl: env.pgTls ?? pgTls() });
await grants.connect();
await grants.query("GRANT USAGE ON SCHEMA pgboss TO memory_gateway; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO memory_gateway; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO memory_gateway; ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO memory_gateway");
await grants.end();

const platform = new Platform(settings);
// process stop: SIGTERM first aborts the converter requests — the pass manages to write its
// wait before pg-boss stops and the DBs close
const stopping = new AbortController();
const ctx: Ctx = {
  instanceId: env.instanceId, db, settings, platform, boss,
  s3: (cls: DataClass) => makeS3Client(settings, cls),          // the same client as the gateway's: one endpoint parse, timeouts
  chat: stageChat(platform),                                    // the model only under the stage slot
  despiteKeys: secrets.despiteKeys,                             // consent prints of «Make available to agents» — the gateway's key
  abort: stopping.signal,
};
// a pair outside models.allow_closed → audit event t1_fallback: each call, or an hourly sum by models.audit_calls
const gateAudit = wireModelGate(ctx);
gateAudit.start();
// usage of every model call of this process: sums in memory, written to model_usage_daily every 10 s and at shutdown
const usage = new UsageRecorder({ db: db.control, instanceId: env.instanceId, settings });
platform.usage = usage;
usage.start();
wireUsage(ctx);                                                 // model usage goes to the stage's account (processing journal: tokens, calls)
ctx.externalLookup = workerExternalLookup(ctx, secrets.settingsKeyring);   // entity lookup through connectors: set before any stage worker starts
// checks without a model: the test hook processing.llm_fault and the stub mode MEMORY_LLM_STUB
installLlmHooks(ctx, { stub: Boolean(env.llmStub), testHooks: Boolean(env.testHooks) });
if (env.llmStub) log.warn("llm_stub_mode", { instance: env.instanceId });
/**
 * The model slot: at most one model request at a time for the whole company. One LlmGate per process;
 * breaker open and close go to the journal (processing, details.job = llm_gate), without content.
 */
const gate = new LlmGate({
  instanceId: env.instanceId, connect: gateConnect(env), settings, purpose: "stage",
  requireFloor: Boolean(env.llmRequireFloor), stub: Boolean(env.llmStub),
  onBreakerChange: (e) => void auditWorker(ctx, { event_type: "processing", details: { job: "llm_gate", reason: e.to ?? e.from, open: e.to !== null, until: e.until, streak: e.streak } }),
});

/**
 * Queues with the stately policy: one job per (queue, state, singletonKey). With standard the key did not dedupe,
 * and every 5 minutes the scheduler queued another job for a stage waiting for night (38 summarize, 2 records).
 * pg-boss does not let an existing queue's policy change — the queue is recreated; its jobs are lost then, but the source
 * of truth is record_stages: scan() at start queues them again.
 */
const QUEUES = ["kick", ...Object.values(QUEUE_OF), "move_class", "purge", "profiles_sync", "audit_maint", "reconcile", "mail", "project_tags", "org_review", "search_outcomes", "dismissed_retention", "embed_backfill"];
for (const q of QUEUES) {
  const cur = await boss.getQueue(q);
  if (cur?.policy === "stately") continue;
  if (cur) { log.warn("queue_recreated", { queue: q, was: cur.policy, now: "stately" }); await boss.deleteQueue(q); }
  await boss.createQueue(q, { policy: "stately" });
}

const sched = makeScheduler(ctx, win);
const schedule = sched.schedule;
ctx.wakeConversion = sched.wakeConversionQueue;                 // the conversion pass wakes the queue itself (fetching, suspicion, rerun_wait)

// start order: model jobs without a pg-boss retry, a one-time move of stuck ones, the return of orphaned stages —
// before handlers and dispatcher, or they would take a stage before its return
await fixLlmJobs(ctx);
await migrateStuckLlmFailures(ctx);
await reclaimOnStart(ctx);

// claim — a model-free stage claim: indexing and conversion renew it and write the result only under it
// (conversion — on every converter poll and in every `conversion` mark)
const HANDLERS: Record<Stage, (c: Ctx, j: StageJob, claim?: StageClaim) => Promise<"done" | "skipped" | "handoff">> = { converted: convertPass, indexed: indexRecord, summary: summarize, events: extractEvents, described: describe, entities: linkEntities };
// model-free stages — pg-boss handlers; model stages — the dispatcher under the slot (below, after the rest)
for (const [stage, queue] of Object.entries(QUEUE_OF) as Array<[Stage, string]>) {
  if (LLM_STAGES.has(stage)) continue;
  await boss.work<StageJob>(queue, { batchSize: 1, localConcurrency: stage === "indexed" || stage === "converted" ? 2 : 1 } as any,
    makeStageLoop(ctx, (c, j, claim) => HANDLERS[stage](c, j, claim), sched.afterStage));
}

/**
 * «Purge now» under the purge lock: busy with another process (a manual test_purge,
 * a second worker) — retry every 2 s up to 60 s, then log purge_busy, exit; the next scan finishes.
 */
async function purgeNow(): Promise<void> {
  const r = await purgeRetrying(ctx, {}, { everyMs: 2_000, maxMs: 60_000 });
  if (r.busy) log.warn("purge_busy", { waited_sec: 60 });
}

await boss.work<{ class: DataClass; record_id: string; lane: "now" | "night" | "index" }>("kick", { batchSize: 1, localConcurrency: 4 } as any, async (jobs) => {
  for (const j of jobs) {
    const moves = (await db.control.query("SELECT id FROM class_moves WHERE record_id = $1 AND status IN ('pending','copying','verifying')", [j.data.record_id])).rows;
    for (const m of moves) await moveClass(ctx, m.id).catch((e) => log.warn("class_move_kick_failed", { move_id: m.id, error: (e as Error).message.slice(0, 200) }));
    const loc = (await db.control.query("SELECT class, deleted FROM record_locations WHERE record_id = $1", [j.data.record_id])).rows[0];
    if (!loc) continue;
    if (loc.deleted) { void kickPurge(ctx); continue; }              // «purge now» = grace 0 + a priority job; the rest of the purge — in scan
    // the personal-open fallback move failed — a new conversion not at once but after a pause
    const delay = await fallbackRetryDelaySec(ctx, j.data.record_id, moves.map((m) => m.id as string))
      .catch((e) => { log.warn("fallback_retry_delay_failed", { record_id: j.data.record_id, error: (e as Error).message.slice(0, 120) }); return 0; });
    if (delay) log.info("open_check_fallback_retry_delayed", { record_id: j.data.record_id, delay_sec: delay });
    await schedule(loc.class, j.data.record_id, delay ? "now" : j.data.lane, undefined, delay);
  }
});

const scan = sched.scan;

const every = timerEvery();   // the general timer of timer.ts — a failed run is `<name>_failed` with a class
every(settings.get("processing.scheduler_interval_sec", 300) * 1000, "scan", scan);
every(60_000, "settings_reload", () => settings.load(true).then(() => { void scheduleReconcile(ctx); void scheduleFtsReconcile(ctx); }));   // workers reread the settings every minute — no rollout needed
// embedders follow the two embeddings connections: at start and after every settings reload; a failure is a log line
void scheduleReconcile(ctx);
// the full-text language follows search.fts_configs the same way
void scheduleFtsReconcile(ctx);
// re-embedding: the backfill job and its permanent sweep — every retrieval.reembed.sweep_min
// (read at start), at start, and at once again while a run left work and set no stop; one job at a time (singleton key,
// and the run lock of kind embed between processes)
const sendBackfill = () => boss.send("embed_backfill", {}, { singletonKey: "embed_backfill" } as any);
await boss.work("embed_backfill", { batchSize: 1 } as any, async () => {
  const out = await embedBackfill(ctx);
  if (out !== "busy" && out.more) await sendBackfill();
});
every(reembedSettings(settings).sweep_min * 60_000, "embed_backfill", sendBackfill);
void sendBackfill().catch(failureLine("embed_backfill_failed"));   // a class, never the text (timer.ts)
listenSecurityMode(db.control, settings);                          // a security mode change — at once (LISTEN security_mode)
// the converter's fast lane flag: by it the gateway accepts office formats; without a converter sign-in,
// every 10 minutes and at start (a failure only logs: the old flag stays)
every(CONVERTER_CAPS_EVERY_MS, "converter_caps", () => refreshConverterCaps(ctx));
// test leftovers — a pass right after the org cards, wherever they run (every 10 minutes,
// on the profiles_sync signal, at start); its own failure only to the log (the pass writes it): a failed card sync does not
// hold them (finally); their failure breaks neither the cards nor the next scan. No overlap: in a process — a chain,
// across processes (run-job too) — the instance advisory lock in the pass
let leftoversRun: Promise<unknown> = Promise.resolve();
const leftovers = () => (leftoversRun = leftoversRun.catch(() => undefined).then(() => testLeftoversPass(ctx)).catch(() => undefined));
/**
 * Org cards, then at once indexing of new cards and versions: a «kick» into the index lane, as the gateway does after
 * a write, not a wait for a scheduler round: with a queue over LIMIT 1000 a fresh card would wait a night or more.
 */
const syncProfiles = async () => {
  const out = await profilesSync(ctx);
  for (const id of out.fresh) await schedule("closed", id, "index").catch((e) => log.warn("schedule_failed", { record_id: id, error: (e as Error).message.slice(0, 120) }));
  return out;
};
every(600_000, "profiles_sync", () => syncProfiles().finally(leftovers));   // cheap: writes only the changed rows of the org table
// name links for collections: new notes and events of people and agents and, until the recount for the current rule
// version is done, the meetings already processed; no model, in batches, the cursor in maintenance_state.named_links
every(600_000, "named_links", () => namedLinksPass(ctx));
// final deletion of test data: its own chain once an hour, not at start.
// The pass takes the session lock test_leftovers (try): it never overlaps the leftovers pass; busy — skipped. Off
// (access.test_purge ≠ auto) — only the S10 mark in maintenance_state; failures log test_purge_failed
let testPurgeRun: Promise<unknown> = Promise.resolve();
every(3_600_000, "test_purge", () => (testPurgeRun = testPurgeRun.catch(() => undefined).then(() => testPurgeAuto(ctx))));
/**
 * Recount for a new prompt version: one pass a night with the budget processing.backfill_per_night.
 * The check is hourly, but passes keep an 18-hour gap: night windows start once a day, so per night
 * one pass only, and the budget is not multiplied by the window's hours. To run now — run-job.ts reextract.
 */
// The last pass time is in maintenance_state.reextract_last under the instance lock (reextractNightly): a restart
// of the worker takes no second portion that night
every(3_600_000, "reextract", async () => {
  if (!inWindow(win())) return;
  const out = await reextractNightly(ctx);
  if (out?.queued) await scan();                                  // no wait for the next scheduler round
});
// the journal upkeep pool is shared with the search outcomes job: audit-maint-pool.ts
const maintPool = auditMaintPool(env);
every(3_600_000, "audit_maint", () => auditMaint(maintPool));    // hourly and at start: partitions ahead and the query text reset do not depend on uptime
// audit archive: hourly, on a one-connection pool of its own — an export of a month must not hold the shared one;
// half an hour after audit_maint (ARCHIVE_OFFSET_MS), so that a drop does not wait for the scrub of query texts, which updates
// the old months through the parent
const archivePool = auditMaintPool(env, "audit_archive");
let archiveRun: Promise<unknown> = Promise.resolve();
const archivePass = () => (archiveRun = archiveRun.catch(() => undefined).then(() => auditArchivePass(ctx, archivePool, { inWindow: archiveDropGate(win) })));
setTimeout(() => {
  void archivePass().catch(failureLine("audit_archive_failed"));   // a class, never the text (timer.ts)
  every(3_600_000, "audit_archive", archivePass);
}, ARCHIVE_OFFSET_MS);
// dismissed people: freeze, custodians, transfer and return of meetings, deletion by term — once an
// hour, at start and on a gateway wake (queue dismissed_retention: dismissal, manual custodian); passes do not
// overlap — a chain in a process, across processes (run-job) — the instance lock in dismissedRetention. Manual: run-job.ts
let dismissedRun: Promise<unknown> = Promise.resolve();
const dismissedOnce = () => (dismissedRun = dismissedRun.catch(() => undefined).then(() => dismissedRetention(ctx)));
every(3_600_000, "dismissed_retention", dismissedOnce);
await boss.work("dismissed_retention", { batchSize: 1 } as any, async () => { await dismissedOnce(); });
// storage cleanup: files of records deleted for good whose file deletion failed. A check every hour
// and at start, a pass at most once a day (by maintenance_state.storage_sweep: rollouts restart the worker more often);
// by hand — run-job.ts storage_sweep
every(3_600_000, "storage_sweep", () => storageSweep(ctx));
every(86_400_000, "space_invites_expire", () => spaceInvitesExpire(ctx));   // daily and at start: expired project invites — mail and full names are not kept past the term
await boss.work("profiles_sync", { batchSize: 1 } as any, async () => { await syncProfiles().finally(leftovers); await scan(); });   // scan → purge picks up removals with term 0
// the class reconciler: every 5 minutes and by the panel button (POST /admin/maintenance/reconcile)
every(300_000, "reconcile", () => reconcileClasses(ctx));
await boss.work("reconcile", { batchSize: 1 } as any, async () => { await reconcileClasses(ctx); });
// The scheduler and the panel wake do not reconcile at once in one process. Each reconcile is a bounded batch.
let projectTagsRun: Promise<unknown> = Promise.resolve();
const syncProjectTags = () => (projectTagsRun = projectTagsRun.catch(() => undefined).then(() => projectTagsSync(ctx)));
every(900_000, "project_tags", syncProjectTags);
await boss.work("project_tags", { batchSize: 1 } as any, async () => { await syncProjectTags(); });
// the mail queue: a pass every 15 seconds (due retries) and at once when the gateway queues a mail (wake «mail»);
// passes never overlap — the second waits; rows are taken FOR UPDATE SKIP LOCKED
// the transport fingerprint of a sent mail — from the app secret, the same key as the gateway's: the alert mail gate
// compares it with the current one
let mailRun: Promise<unknown> = Promise.resolve();
const mailOnce = () => (mailRun = mailRun.catch(() => undefined).then(() => mailTick({ ...ctx, appSecret: env.appSecret })));
every(15_000, "mail", mailOnce);
await boss.work("mail", { batchSize: 1 } as any, async () => { await mailOnce(); });   // mailTick rereads the settings inside the pass queue
every(5_000, "audit_spool_drain", () => auditSpoolDrain(ctx));   // the journal of services without memory_audit access → audit_events
every(30_000, "audit_outbox_drain", () => auditOutboxDrain(ctx));   // events the gateway and workers could not write → audit_events
// admin plane: jobs/admin-plane.ts registers its jobs; index.ts is not edited for it any more
registerAdminPlaneJobs(ctx, every);
registerOpenRecheck(ctx, every);   // recheck of the open data when the NDA list grows
registerEdgeCanary(ctx);   // edge canaries: by the panel button and on the first export switch-on, every minute
registerAlertDetectors(ctx, every);   // 1d alerts: the journal feed and detectors every 15 s, «Digest now»
registerConnectorJobs({ ctx, every, keyring: secrets.settingsKeyring });   // connectors: runs claimed from the state rows every 5 s, cleanup every 10 min
// org curators: return by term and the weekly mail — hourly, at start and by the panel button (part:
// return | digest | all); no overlap — a chain in a process, across processes — the record lock in returnFromOrg
let orgReviewRun: Promise<unknown> = Promise.resolve();
const orgReviewOnce = (part: OrgReviewPart = "all") => (orgReviewRun = orgReviewRun.catch(() => undefined).then(() => orgReviewTick(ctx, part, { kickMail: mailOnce })));
every(3_600_000, "org_review", () => orgReviewOnce());
await boss.work<{ part?: OrgReviewPart }>("org_review", { batchSize: 1 } as any, async (jobs) => {
  for (const j of jobs) await orgReviewOnce(["return", "digest", "all"].includes(j.data?.part ?? "") ? j.data.part : "all");
});
// personal morning note: every 15 minutes (the send window is 3 hours); only inside the send window of the day's slot, one
// e-mail per person per day (dedupe); passes do not overlap in the process, across processes the dedupe key decides
let morningNoteRun: Promise<unknown> = Promise.resolve();
const morningNoteOnce = () => (morningNoteRun = morningNoteRun.catch(() => undefined).then(() => morningNoteTick(ctx, { kickMail: mailOnce })));
every(900_000, "morning_note", morningNoteOnce);

await auditMaint(maintPool).catch((e) => log.warn("audit_maint_failed", { error: (e as Error).message.slice(0, 200) }));
await dismissedOnce().catch((e) => log.warn("dismissed_retention_failed", { error: (e as Error).message.slice(0, 200) }));
await spaceInvitesExpire(ctx).catch((e) => log.warn("space_invites_expire_failed", { error: (e as Error).message.slice(0, 200) }));
void storageSweep(ctx).catch((e) => log.warn("storage_sweep_failed", { error: (e as Error).message.slice(0, 200) }));   // no await: listing does not block start
void refreshConverterCaps(ctx).catch((e) => log.warn("converter_caps_failed", { error: (e as Error).message.slice(0, 200) }));   // no await: start never waits on it
await syncProjectTags().catch((e) => log.warn("project_tags_failed", { error: (e as Error).message.slice(0, 200) }));
await orgReviewOnce().catch((e) => log.warn("org_review_failed", { error: (e as Error).message.slice(0, 200) }));   // at start (every: the interval only)
await syncProfiles().catch((e) => log.warn("profiles_sync_failed", { error: (e as Error).message }));
await leftovers();
void namedLinksPass(ctx).catch((e) => log.warn("named_links_failed", { error: (e as Error).message.slice(0, 200) }));   // background: start does not wait
await gate.init();
const HANDLERS_LLM = Object.fromEntries([...LLM_STAGES].map((s) => [s, HANDLERS[s]]));
const dispatcher = startLlmDispatcher({ ctx, gate, handlers: HANDLERS_LLM, afterStage: sched.afterStage, win });
await scan();
/**
 * Search outcomes: every 15 minutes, at start (no await — start does not wait for it) and by the panel
 * button (wake «search_outcomes»). All of it after the start block: else a pass or a wake
 * queued during a restart would take the only client of the journal upkeep pool before auditMaint and hold
 * up the whole start; wakes wait in the queue. Passes never overlap: a chain in a process, across processes (run-job) —
 * the instance lock inside the pass. Wake parameters (settle_sec, since, current_week) — only with the test hooks.
 */
let outcomesRun: Promise<unknown> = Promise.resolve();
const outcomesOnce = (opts: PassOpts = {}) => (outcomesRun = outcomesRun.catch(() => undefined).then(() => outcomesBuild(ctx, maintPool, opts)));
every(900_000, "search_outcomes", () => outcomesOnce());
await boss.work<{ settle_sec?: number; since?: string; current_week?: boolean }>("search_outcomes", { batchSize: 1 } as any, async (jobs) => {
  for (const j of jobs) {
    const d = env.testHooks ? j.data ?? {} : {};
    const since = typeof d.since === "string" && !Number.isNaN(Date.parse(d.since)) ? new Date(d.since) : undefined;
    await outcomesOnce({ ...(typeof d.settle_sec === "number" ? { settleSec: d.settle_sec } : {}), ...(since ? { since } : {}), ...(d.current_week ? { currentWeek: true } : {}) })
      .catch((e) => log.warn("search_outcomes_failed", { error: (e as Error).message.slice(0, 200) }));
  }
});
void outcomesOnce().catch((e) => log.warn("search_outcomes_failed", { error: (e as Error).message.slice(0, 200) }));
log.info("workers_started", { instance: env.instanceId, queues: QUEUES.length, llm_queues: LLM_QUEUES.length, in_night_window: inWindow(win()), stub: Boolean(env.llmStub) });
/**
 * Shutdown: the dispatcher first — a running model stage gets shutdown_grace_sec, then the call is aborted (the stage
 * returns to pending, no attempt spent); then pg-boss and DBs. docker compose waits 30 s (stop_grace_period). The usage
 * recorder writes what it holds before pg-boss stops (the stop may be cut by the grace period) and its last sums after
 * pg-boss has let its active jobs finish (their model calls are counted too). The hourly sums of the model-call
 * audit are written at the same two points, side by side with the usage sums (other database; the audit waits
 * for its writes at most GATE_AUDIT_STOP_WAIT_MS, so a silent audit database holds neither the usage sums nor pg-boss).
 */
let stoppingAll = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => {
  if (stoppingAll) return;
  stoppingAll = true;
  stopping.abort();                                             // converter requests go first (`aborted`)
  const grace = Number(settings.get("processing.llm_gate", LLM_GATE_DEFAULTS).shutdown_grace_sec ?? LLM_GATE_DEFAULTS.shutdown_grace_sec) * 1000;
  void dispatcher.stop(grace).catch(() => undefined).then(() => gate.close()).then(() => Promise.all([gateAudit.stop(), usage.flush()])).then(() => boss.stop({ graceful: true })).then(() => Promise.all([gateAudit.stop(), usage.stop()])).then(() => db.close()).finally(() => process.exit(0));
});
