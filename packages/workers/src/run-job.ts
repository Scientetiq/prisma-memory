// Manual run of a worker service job — for white-box checks and operations (no wait for the daily schedule):
//   in the workers container, with the workers' environment and secret files:
//   compose:       docker compose … exec -T workers node_modules/.bin/tsx packages/workers/src/run-job.ts dismissed_retention
// An install whose service entrypoint sets up the secrets runs the job through it: a plain exec bypasses it, and readEnv
// fails with "no app secret".
//
// Runs only in the workers container (same variables and the memory_worker role); no models or queue touched, storage —
// only test_purge (test orphans) and storage_sweep (cleanup of files of records deleted for good).
import { AnchorsError, Databases, ExportAbort, initAnchors, loadServiceSecrets, log, makeS3Client, nightWindowOf, readEnv, registerInstanceLocale, Settings, WORKER_DB_ROLES, type DataClass } from "@memory/shared";
import { dismissedPreview, previewAssume } from "./jobs/custody.ts";
import { dismissedRetention, dismissedTrashHold, projectTagsSync, reconcileClasses, reextract, spaceInvitesExpire } from "./jobs/maintenance.ts";
import { testLeftoversPass, testLeftoversPreview } from "./jobs/leftovers.ts";
import { TestPurgeStop, testPurgeApply, testPurgeAuto, testPurgePreview } from "./jobs/leftovers-purge.ts";
import type { PurgeCtx } from "./jobs/maintenance.ts";
import { mailTick } from "./jobs/mail.ts";
import { namedLinksPass } from "./jobs/named.ts";
import { orgReviewTick, type OrgReviewPart } from "./jobs/org-review.ts";
import { morningNoteTick } from "./jobs/morning-note.ts";
import type { DbCtx } from "./ctx.ts";
import { outcomesBuild, outcomesRetention, parseOutcomesArgs } from "./jobs/outcomes.ts";
import { storageSweep } from "./jobs/storage-sweep.ts";
import { auditMaintPool } from "./audit-maint-pool.ts";
import { archiveDropGate, auditArchivePass } from "./jobs/audit-archive.ts";
import { repairRestored } from "./jobs/repair.ts";
import { masterOcrReport } from "./jobs/master-ocr-report.ts";
import { jobExitCode } from "./job-exit.ts";
import { ADMIN_PLANE_JOBS } from "./jobs/admin-plane.ts";
import { OPS_ALERT_JOBS } from "./jobs/ops-alerts.ts";
import { openRecheckPreview, openRecheckRun } from "./jobs/open-recheck.ts";
import { exportInstance } from "./jobs/export-instance.ts";

// reextract: recount of model stages under a new prompt version — the same pass as at night,
// but at once, with the same budget processing.backfill_per_night; the usual scheduler then runs its stages.
// mail: one pass of the mail queue — what the worker does every 15 seconds, and with the same app secret
// (a sent letter gets the mail transport fingerprint, else the sign-in gate does not count it).
// test_leftovers: a whole pass over test leftovers — the worker's purge does the cleanup; worker busy —
// skipped (busy). test_leftovers_preview [--ids <file>] [--check <file>]: what the pass would do with all — read only.
// test_purge_preview / test_purge --apply / test_purge_auto — final removal of test data:
// the preview only reads; a stop or busy — exit code 3 (the result — on stdout).
// outcomes_build [--since ISO] [--rebuild] [--allow-textless] — the search outcomes pass under the worker's lock
// (busy — {busy: true}, exit code 3; a pass or stage error — error in the result, exit code 4); --since moves the cursor
// to the series start, --rebuild rebuilds rows from since (at most 90 days without --allow-textless). Numbers only.
// outcomes_retention — removal by term (12 months), numbers.
// audit_archive [--in-window] — one pass of the audit archive on a pool of its own, under the job's lock (another pass
// running — {skipped: "busy"}); the drop step only inside the night window, or with --in-window. Result — names and numbers only.
// storage_sweep [--min-age-min N] — storage cleanup: files of records deleted for good with no links, at once (no
// «a day has passed» check); --min-age-min — file age in minutes instead of a day (for a test run). Numbers only.
// repair_restored — a one-off pass: for records restored from the trash (journal: forget, action = restore) the stages
// «skipped for good» while the record lay in the trash go back to the queue, night lane; search fragments of the old
// space after a move during indexing — with the current one. A repeat changes nothing; result: numbers.
// dismissed_retention — the pass over dismissed people (freeze, custodians, meetings, removal by term); another pass
// running — {busy: true}, exit code 3. dismissed_retention_preview — what the pass would do: custodians, meetings to
// hand over and return, removal by term — read only (custodian rows are counted in a rolled-back transaction). Result —
// logins and numbers, on stdout only. «As if» flags (this run only): --meetings transfer|wait, --personal
// keep|delete, --after-days N, --retention-days N — what the pass would do after the setting is switched (the first
// rollout uses wait: the pass runs at worker start, so the handover shows only after a restart).
// dismissed_trash_hold [--freeze | --thaw] — the trash of dismissed people before a code rollback and after a new rollout:
// --freeze — before the rollback, with the new image: the trash rows of held personal
// spaces get a far purge date (the old one — in attrs.held_purge_after), so the old purge will not erase them; before it
// their top rows under a parent outside the held ones are detached, so the parent does not take them in a cascade
// (detached; no flag — at_risk); --thaw — after the new rollout: the old term back, the detachment stays. Without
// a flag — numbers only. Result: numbers.
// master_ocr_report — a one-off check after phase 0 of the conversion queue is rolled out: documents the old converter
// took as «text ready» whose text carries the mark of fast scan recognition by a model. Read only:
// a list (id, class, space, whether the file is given to agents) — for the operator; records change only on its word.
// audit_ship, audit_ship_reconcile [YYYY-MM-DD], alert_mail, alert_digest [--force], obo_read_watch, admin_plane_gc — jobs
// of the admin plane (jobs/admin-plane.ts), one pass at once; result — numbers and codes only.
// named_links — the pass of links by name for collections: what the worker does every
// 10 minutes; while already processed meetings are recounted, repeat until recompute_done: true. Numbers only.
// open_recheck_preview [--all | --nfd] — recheck of open records: how many open records
// match the new names of the NDA list (--all — the whole list; --nfd — all rules over records with NFD letters), by
// space kinds — read only and numbers. open_recheck [--all | --nfd] — start a run and bring it to the end (a rollout
// step: the preview first, the result — to the operator); another run going — {busy}, exit code 3.
// export_instance --out <dir> [--space <slug>] [--no-originals] — whole-instance memory export of the server operator
// (jobs/export-instance.ts): writes prisma-memory-export-<instance>-<UTC time>.tar.gz (mode 0600) into <dir>, which
// must lie inside MEMORY_EXPORT_DIR; prints the SHA-256 and the counts. Refused before any record is read — exit code 2
// (a refusal after the start event and the alert stays in the audit log); incomplete (stopped by SIGTERM or SIGINT, a
// write error, a storage error — stopped_at names the record) — 4. The archive is plain data: store it like the database.
const env = readEnv();
// the same secret files as the workers: an incomplete directory stops the job before any database connection
const secrets = loadServiceSecrets(env, WORKER_DB_ROLES);
const JOBS: Record<string, (ctx: PurgeCtx, args: string[]) => Promise<unknown>> = {
  dismissed_retention: dismissedRetention, space_invites_expire: spaceInvitesExpire, projectTagsSync, reconcileClasses, reextract: (ctx) => reextract(ctx), mail: (ctx) => mailTick({ ...ctx, appSecret: env.appSecret }), project_tags: projectTagsSync, reconcile: reconcileClasses,
  repair_restored: (ctx) => repairRestored(ctx),
  master_ocr_report: (ctx) => masterOcrReport(ctx),
  named_links: (ctx) => namedLinksPass(ctx),
  dismissed_retention_preview: (ctx, args) => dismissedPreview(ctx, previewAssume(args)),
  dismissed_trash_hold: (ctx, args) => dismissedTrashHold(ctx, args),
  test_leftovers: testLeftoversPass,
  test_leftovers_preview: testLeftoversPreview,
  test_purge_preview: testPurgePreview,
  test_purge: (ctx, args) => testPurgeApply(ctx, args, { testHooks: env.testHooks }),
  test_purge_auto: (ctx) => testPurgeAuto(ctx),
  // org curators: org_review [return|digest|all] — return by term and/or the weekly letter (mail queue only)
  org_review: (ctx, args) => orgReviewTick(ctx, (["return", "digest", "all"].includes(args[0] ?? "") ? args[0] : "all") as OrgReviewPart),
  // personal morning note: one pass of the job — the same checks as the worker's (SMTP, the note, the send window); numbers only.
  // morning_note manual — the operator's run by hand: no switch or send window needed, test people included, one per hour
  morning_note: (ctx, args) => morningNoteTick(ctx, { manual: args[0] === "manual" }),
  outcomes_build: async (ctx, args) => {
    const opts = parseOutcomesArgs(args);
    const pool = auditMaintPool(env, `run-job:outcomes_build:${process.pid}`);
    try { return await outcomesBuild(ctx, pool, opts); } finally { await pool.end(); }
  },
  // retention of outcomes, sessions and weeks (12 months) — as auditMaint does at worker start; for white-box checks
  outcomes_retention: async () => {
    const pool = auditMaintPool(env, `run-job:outcomes_retention:${process.pid}`);
    try { return await outcomesRetention(pool); } finally { await pool.end(); }
  },
  audit_archive: async (ctx, args) => {
    const pool = auditMaintPool(env, `run-job:audit_archive:${process.pid}`);
    const dropGate = archiveDropGate(() => nightWindowOf(ctx.settings), { force: args.includes("--in-window") });
    try { return await auditArchivePass(ctx, pool, { inWindow: dropGate }); } finally { await pool.end(); }
  },
  ...ADMIN_PLANE_JOBS,
  ...OPS_ALERT_JOBS,
  open_recheck: (ctx, args) => openRecheckRun(ctx, args),
  open_recheck_preview: (ctx, args) => openRecheckPreview(ctx, args),
  // SIGTERM or SIGINT stops the export where it waits: the archive is left incomplete and its .partial file removed
  export_instance: (ctx, args) => {
    const stop = new AbortController();
    const on = () => stop.abort(new ExportAbort("interrupted"));
    process.once("SIGTERM", on); process.once("SIGINT", on);
    return exportInstance(ctx, args, { signal: stop.signal });
  },
  // storage cleanup: at once, no «a day has passed» check; --min-age-min N — file age in minutes (for a test run)
  storage_sweep: (ctx, args) => {
    const i = args.indexOf("--min-age-min"), min = i >= 0 ? Number(args[i + 1]) : NaN;
    if (i >= 0 && !(Number.isFinite(min) && min >= 0)) throw new Error("storage_sweep: --min-age-min must be a number of minutes");
    return storageSweep(ctx, { force: true, ...(i >= 0 ? { minAgeMs: min * 60_000 } : {}) });
  },
};
// these jobs' result — on stdout only: the log (sent to log collection) gets only the run itself, no logins or space names
const QUIET = new Set(["test_leftovers", "test_leftovers_preview", "test_purge_preview", "test_purge", "test_purge_auto", "dismissed_retention_preview", "master_ocr_report"]);

const name = process.argv[2] ?? "";
const job = JOBS[name];
if (!job) { console.error(`unknown job “${name}”; available jobs: ${Object.keys(JOBS).join(", ")}`); process.exit(2); }
// own connection name: the maintenance window counts all service connections but this process as foreign
const db = new Databases({ ...env, role: "worker", applicationName: `run-job:${name}:${process.pid}` });
const settings = new Settings(db.control, env.instanceId, env.appSecret, secrets.settingsKeyring);
// the instance language (locale.language) is the language of everything rendered outside a request: mail, alerts, jobs
registerInstanceLocale(settings);
await settings.load(true);
// trust anchors: pinned settings apply in a one-off run too — the same as the workers';
// a signers file exists but the check failed — the run refuses, as workers do
try { await initAnchors({ process: "workers", db: db.control, audit: db.audit, instanceId: env.instanceId, appSecret: env.appSecret, settings }); }
catch (e) {
  if (e instanceof AnchorsError) { log.error(e.code, { error: e.message.slice(0, 300) }); process.exit(1); }
  throw e;
}
try {
  const out = await job({ instanceId: env.instanceId, db, settings, s3: (cls: DataClass) => makeS3Client(settings, cls) }, process.argv.slice(3));
  log.info("job_run", QUIET.has(name) ? { job: name, ok: true } : { job: name, result: out });
  console.log(JSON.stringify({ job: name, result: out }));
  // busy or stopped — 3; an outcomes pass with an error (batch or stage) — 4 (job-exit.ts)
  process.exitCode = jobExitCode(name, out);
} catch (e) {
  if (!(e instanceof TestPurgeStop)) throw e;
  log.info("job_run", { job: name, ok: false, stops: e.codes });
  console.log(JSON.stringify({ job: name, stop: { codes: e.codes, message: e.message, detail: e.detail }, result: (e as TestPurgeStop & { result?: unknown }).result ?? null }));
  process.exitCode = 3;
} finally { await db.close(); }
