// Audit archive: job audit_archive, hourly, with its own one-connection pool of memory_audit_maint (index.ts,
// auditMaintPool(env, "audit_archive")): the shared maintenance pool has one connection and a 60 s wait — a long export through
// it would starve audit_maint and outcomes_build.
//
// One pass: the month partitions older than observability.audit_retention_months (audit_archive_candidates, oldest first); at
// most one export and at most one drop per pass, both in month order: only the oldest month without a verified archive is
// exported (each manifest names its predecessor, so a newer month waits for an older one that failed), and only the oldest
// month still in the base is dropped (the journal then has one horizon, auditArchivedBefore()).
//   1. Export: rows read through the parent with the month range, keyset (at, id), ARCHIVE_PAGE_ROWS per query; each row is one
//      NDJSON line — to_jsonb of the row in UTC, the query text always emptied (a candidate is at least three months old and the
//      rule of audit_scrub_query_text is 90 days: the archive never keeps a text the base would drop within days).
//      Lines go into gzip parts of at most ARCHIVE_PART_MAX_BYTES uncompressed (a single larger row is a
//      part of its own) under audit-archive/<instance>/<YYYY>/ in the closed-class bucket — outside `<instance>/`, which the
//      storage sweepers list. Then the manifest {format, partition, rows, parts:[{key,rows,bytes,sha256}], sha256 of the month's
//      NDJSON, min_at, max_at, prev_manifest_sha256}: a hash chain over months, so a removed month is detectable. A month
//      exported again (a count that differed at the drop) changes its manifest: the manifests of the newer months are relinked.
//   2. Verify: every part is downloaded again, its bytes hashed, decompressed and its lines counted; the month's hash recomputed;
//      the manifest downloaded and hashed; the month counted again in the base. Equal — the run is 'verified'.
//   3. Mode export_and_drop: only inside the night window, only when audit shipping (the cursor of the active sink and a
//      running "send history") has passed the month and only after the archive is checked again in the storage configured
//      now (a 'verified' mark can be months old: the bucket may have been emptied or replaced since), audit_archive_drop
//      detaches and drops the partition after counting it under the locks (03-audit.sql). A count that differs, or an archive
//      that is no longer in the storage as written, marks the run 'failed'; the month is exported again later. A lock that
//      could not be taken (timeout or deadlock) only holds the drop until the next pass. Facts that only the journal keeps and
//      that are read without a time bound (the SSO decision on admin.tool_sessions) are copied to the control DB first.
// A partition that holds rows of another instance is not archived (one audit database per instance is the supported layout:
// another instance's events must not go to this instance's bucket, nor be dropped by this instance's retention).
//   4. Expiry: the parts and the manifest of a month dropped from the log longer ago than
//      observability.audit_archive_keep_months are removed (the manifest last), the run becomes 'expired' — its row with the
//      manifest hash stays, so the next month's manifest still links to it and the read-back (gateway audit-archive.ts) checks
//      the chain. Keep 0 — never. Months the log still keeps are never removed. A removal that fails keeps the run 'dropped' with
//      the error; the next pass finishes it.
//   5. Backlog: months older than the retention that the archive has not finished with for more than
//      AUDIT_ARCHIVE_WAIT_DAYS (auditArchiveBacklog — no storage, a failing export, a drop held by the window or by shipping)
//      raise the medium alert audit_archive_waiting once a week; the Readiness item audit_archive shows the same.
// Without storage for closed data nothing is exported, dropped or removed. Failures: the run 'failed' with a short code (never
// event data, never the text of a storage or database error — it may name hosts; that text goes to the log only), a medium
// alert audit_archive_failed once per month and day, a retry after ARCHIVE_RETRY_MS. Events: admin {op: audit_archive_exported |
// audit_archive_dropped | audit_archive_expired}. Two passes never overlap: a session advisory lock on the pool's connection.
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type pg from "pg";
import { AUDIT_ARCHIVE_PREFIX, AUDIT_ARCHIVE_SEEN_MARK, AUDIT_ARCHIVE_WAIT_DAYS, AUDIT_ARCHIVED_UPTO_SQL, archiveSeenSince, auditArchiveBacklog, auditArchiveKeepMonths, auditArchiveMode, auditRetentionMonths, log, raiseAlert, watchLock,
  s3GetBuffer, s3List, s3Put, s3Remove, S3_TIMEOUT_MS, TOOL_SESSIONS_DECISION_MARK, TOOL_SESSIONS_DECISION_SQL, inWindow, type AuditArchiveMode, type NightWindow, type S3Target } from "@memory/shared";
import { auditWorker, type Ctx } from "../ctx.ts";
import { AT_TEXT } from "../audit-ship/reader.ts";

export const ARCHIVE_FORMAT = "prisma-audit-archive/1";
/** Rows per read of the month. */
export const ARCHIVE_PAGE_ROWS = 5000;
/** Uncompressed bytes per part (a single row larger than this is a part of its own). */
export const ARCHIVE_PART_MAX_BYTES = 32 * 1024 * 1024;
/** A failed month is exported again after this. */
export const ARCHIVE_RETRY_MS = 6 * 3_600_000;
/** The worker starts the hourly pass this long after audit_maint (packages/workers/src/index.ts): the two never start together. */
export const ARCHIVE_OFFSET_MS = 30 * 60_000;
/** Months whose archive expires in one pass at most (removals only; the next pass takes the rest). */
export const ARCHIVE_EXPIRE_PER_PASS = 12;
/** Session advisory lock of the job (one pass at a time across processes: the worker and run-job). */
const LOCK_SQL = "hashtext('memory:audit_archive')";
const SINKS = ["file", "syslog_tls"];

export type ArchiveCtx = Pick<Ctx, "instanceId" | "db" | "settings" | "s3">;

type ArchiveDropHours = "in" | "out" | "unreadable";

export interface ArchivePassOpts {
  /** Fixed permission or a drop-hours check to run at the drop step. */
  inWindow: boolean | (() => ArchiveDropHours | Promise<ArchiveDropHours>);
  /** Tests: smaller pages and parts. */
  pageRows?: number;
  partMaxBytes?: number;
  /** Tests: the clock of the retry delay. */
  now?: () => number;
}

export type ArchiveHold = "window" | "window_unreadable" | "ship_cursor" | "history_cursor" | "lock_timeout" | "lock_conflict" | "no_storage" | "facts";
export interface ArchivePass {
  mode: AuditArchiveMode;
  skipped?: "off" | "busy" | "missing" | "no_storage";
  candidates: number;
  exported?: { partition: string; rows: number; parts: number; bytes: number; sha256: string };
  dropped?: { partition: string; rows: number };
  held?: { partition: string; reason: ArchiveHold };
  failed?: { partition: string; error: string };
  /** Months whose archive was removed in this pass (retention of the archive), with the number of objects. */
  expired?: Array<{ partition: string; objects: number }>;
  /** Months older than the retention that have waited more than AUDIT_ARCHIVE_WAIT_DAYS for the archive. */
  waiting?: { count: number; oldest: string; since: string };
  /** Rows in the base older than the newest dropped month (late events in audit_events_default): reported, not purged. */
  default_overage?: number;
}

/** A month partition: its name, the month and the bounds it was created with (UTC text). */
interface Candidate { partition_name: string; month_start: string; month_end: string; range_from: string; range_to: string }
interface Run { partition_name: string; status: string; rows: string | null; sha256: string | null; manifest_key: string | null; manifest_sha256: string | null; updated_at: Date }
interface Part { key: string; rows: number; bytes: number; sha256: string }
interface Manifest {
  format: string; partition: string; instance: string; month_start: string; month_end: string; range_from: string; range_to: string; rows: number; parts: Part[];
  sha256: string; min_at: string | null; max_at: string | null; prev_manifest_sha256: string | null; created_at: string;
}

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const short = (e: unknown): string => ((e as Error)?.message ?? String(e)).replace(/\s+/g, " ").slice(0, 200);
const code = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;
/** What a failure of a client (storage, database) is called in the run and the alert: its code or the error's class, never its text. */
const errName = (e: unknown): string => {
  const c = code(e);
  if (typeof c === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(c)) return c;
  const n = (e as Error | null)?.name;
  return typeof n === "string" && /^[A-Za-z0-9_]{1,40}$/.test(n) ? n : "error";
};

/** Object keys of a month: audit-archive/<instance>/<YYYY>/audit_events_<YYYY_MM>.(part-NNNN.ndjson.gz | manifest.json). */
export function archiveKeys(instanceId: string, partition: string): { base: string; part: (n: number) => string; manifest: string } {
  const year = /_(\d{4})_\d{2}$/.exec(partition)?.[1] ?? "0000";
  const base = `${AUDIT_ARCHIVE_PREFIX}${encodeURIComponent(instanceId)}/${year}/${partition}`;
  return { base, part: (n) => `${base}.part-${String(n).padStart(4, "0")}.ndjson.gz`, manifest: `${base}.manifest.json` };
}

/** One pass of the archive. Errors of the export itself are recorded in the run (status failed) and an alert; the pass resolves. */
export async function auditArchivePass(ctx: ArchiveCtx, pool: pg.Pool, o: ArchivePassOpts): Promise<ArchivePass> {
  const mode = auditArchiveMode(ctx.settings.get<unknown>("observability.audit_archive_mode", "off"));
  const months = auditRetentionMonths(ctx.settings.get<unknown>("observability.audit_retention_months", 12));
  const out: ArchivePass = { mode, candidates: 0 };
  if (mode === "off") {
    // the mark names the mode off: switched on again, the backlog's wait starts at the first pass then, not at an older mark
    // of the same mode
    await settingsSeenSince(ctx, mode, months, (o.now ?? Date.now)());
    return { ...out, skipped: "off" };
  }
  const c = await pool.connect();
  let locked = false;
  let watch: ReturnType<typeof watchLock> | undefined;
  try {
    locked = (await c.query(`SELECT pg_try_advisory_lock(${LOCK_SQL}) AS ok`)).rows[0]?.ok === true;
    if (!locked) return { ...out, skipped: "busy" };
    watch = watchLock(c);
    await c.query("SET TIME ZONE 'UTC'");
    const seenSince = await settingsSeenSince(ctx, mode, months, (o.now ?? Date.now)());
    let candidates: Candidate[];
    try {
      candidates = (await c.query(
        `SELECT partition_name, month_start::text AS month_start, month_end::text AS month_end, ${AT_TEXT("range_from")} AS range_from,
                ${AT_TEXT("range_to")} AS range_to FROM audit_archive_candidates($1)`, [months])).rows;
    } catch (e) {
      if (code(e) === "42883" || code(e) === "42P01") { log.warn("audit_archive_missing", { error: short(e) }); return { ...out, skipped: "missing" }; }
      throw e;
    }
    out.candidates = candidates.length;
    if (candidates.length) {
      const runs = new Map<string, Run>(((await c.query(
        "SELECT partition_name, status, rows::text AS rows, sha256, manifest_key, manifest_sha256, updated_at FROM audit_archive_runs WHERE partition_name = ANY($1::text[])",
        [candidates.map((x) => x.partition_name)])).rows as Run[]).map((r) => [r.partition_name, r]));
      const now = (o.now ?? Date.now)();
      const target = ctx.s3("closed");
      // the oldest month still in the base is the only one that may be dropped in this pass (an older month that is held or
      // failed keeps every newer one in the base: one horizon, auditArchivedBefore(), and no newer gap in the journal)
      let dropTried = false;
      for (const cand of candidates) {
        const run = runs.get(cand.partition_name);
        if (run?.status === "dropped" || run?.status === "expired") {
          // the month was dropped before and a table of that name is back (made by hand): never overwrite its archive
          log.warn("audit_archive_reappeared", { partition: cand.partition_name, status: run.status });
          continue;
        }
        if (run?.status === "verified") {
          if (mode === "export_and_drop" && !dropTried) { dropTried = true; await dropStep(ctx, c, cand, run, months, o, out, false); }
          continue;
        }
        // the oldest month without a verified archive: the only one exported in this pass; no newer month is exported before
        // it (its manifest would name the wrong predecessor and this month would fall out of the hash chain)
        if (run?.status === "failed" && now - new Date(run.updated_at).getTime() < ARCHIVE_RETRY_MS) break;
        if (!target) { out.skipped = "no_storage"; break; }
        const done = await exportStep(ctx, c, target, cand, o, out, watch.alive);
        // the drop only while the month just exported is still verified (a relink that failed it leaves it in the base)
        const kept = done ? await relinkNewer(ctx, c, target, cand.partition_name, done.manifestSha, out, watch.alive) : false;
        if (done && kept && mode === "export_and_drop" && !dropTried) { dropTried = true; await dropStep(ctx, c, cand, done.run, months, o, out, true); }
        break;
      }
      await backlogStep(ctx, c, candidates, mode, months, seenSince, o, out);
    }
    const keep = auditArchiveKeepMonths(ctx.settings.get<unknown>("observability.audit_archive_keep_months", 24));
    const target = ctx.s3("closed");
    if (keep > 0 && target) await expireStep(ctx, c, target, keep, out, watch.alive);
    out.default_overage = await defaultOverage(c);
    if (out.default_overage) log.warn("audit_default_overage", { rows: out.default_overage });
    return out;
  } catch (e) {
    await watch?.alive();
    throw e;
  } finally {
    try {
      if (!watch?.lost()) {
        if (locked) await c.query(`SELECT pg_advisory_unlock(${LOCK_SQL})`).catch(() => undefined);
        if (!watch?.lost()) await c.query("RESET TIME ZONE").catch(() => undefined);
      }
      if (watch?.lost()) log.warn("lock_connection_lost", { job: "audit_archive" });
    } finally {
      watch?.done();
      c.release(watch?.lost() || undefined);
    }
  }
}

/** Rows older than the newest dropped month: they can only be in audit_events_default (late events). 0 before any drop. */
async function defaultOverage(c: pg.PoolClient): Promise<number> {
  const r = (await c.query(
    `SELECT count(*)::int AS n FROM audit_events
      WHERE at < (SELECT max(${AUDIT_ARCHIVED_UPTO_SQL}) FROM audit_archive_runs WHERE status IN ('dropped', 'expired'))`)).rows[0];
  return Number(r?.n ?? 0);
}

const WINDOW_HOLD_TEXT = "the drop waits for the night window";
const HOLD_TEXT: Record<ArchiveHold, string> = {
  window: WINDOW_HOLD_TEXT, window_unreadable: WINDOW_HOLD_TEXT, ship_cursor: "the drop waits for audit shipping to pass the month",
  history_cursor: "the drop waits for the running \"send history\" of audit shipping", lock_timeout: "the drop could not take the lock of the audit log",
  lock_conflict: "the drop met a lock conflict", no_storage: "the storage for closed data is not configured", facts: "facts of the month could not be copied to the control database",
};

/**
 * When the job first ran with the present mode and retention (AUDIT_ARCHIVE_SEEN_MARK in maintenance_state of the control DB):
 * the mark is written at the first pass after either changed (or the first pass ever). The backlog wait starts no earlier
 * (auditArchiveBacklog). The mark cannot be read or written — null (no bound), logged.
 */
async function settingsSeenSince(ctx: ArchiveCtx, mode: AuditArchiveMode, months: number, now: number): Promise<number | null> {
  try {
    const v = (await ctx.db.control.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = $2", [ctx.instanceId, AUDIT_ARCHIVE_SEEN_MARK])).rows[0]?.value;
    const seen = archiveSeenSince(v, mode, months);
    if (seen !== null) return seen;
    const at = new Date(now).toISOString();
    await ctx.db.control.query(
      `INSERT INTO maintenance_state (instance_id, key, value, updated_at) VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (instance_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [ctx.instanceId, AUDIT_ARCHIVE_SEEN_MARK, JSON.stringify({ mode, retention_months: months, at })]);
    return now;
  } catch (e) {
    log.warn("audit_archive_seen_mark_failed", { error: short(e) });
    return null;
  }
}

/**
 * Months older than the retention that have waited more than AUDIT_ARCHIVE_WAIT_DAYS for the archive (auditArchiveBacklog over
 * the run states after this pass, the time the month before the oldest waiting one was finished and the first pass with the
 * present settings): a medium alert audit_archive_waiting, deduplicated per week; `out.waiting`. The alert names the oldest
 * month and why it waits as far as this pass knows (no storage, the last error, the hold of this pass).
 */
async function backlogStep(ctx: ArchiveCtx, c: pg.PoolClient, candidates: Candidate[], mode: AuditArchiveMode, months: number, seenSince: number | null,
  o: ArchivePassOpts, out: ArchivePass): Promise<void> {
  const now = (o.now ?? Date.now)();
  const runs = (await c.query("SELECT partition_name, status, error, verified_at, dropped_at FROM audit_archive_runs WHERE instance_id = $1 OR partition_name = ANY($2::text[])",
    [ctx.instanceId, candidates.map((x) => x.partition_name)])).rows as Array<{ partition_name: string; status: string; error: string | null; verified_at: Date | null; dropped_at: Date | null }>;
  const states = new Map(runs.map((r) => [r.partition_name, r]));
  const { overdue } = auditArchiveBacklog(candidates.map((x) => ({ partition: x.partition_name, month_start: x.month_start,
    status: states.get(x.partition_name)?.status ?? null, error: states.get(x.partition_name)?.error ?? null })), {
    mode, retentionMonths: months, now, seenSince,
    runs: runs.map((r) => ({ partition: r.partition_name, status: r.status, verified_at: r.verified_at, dropped_at: r.dropped_at })),
  });
  const oldest = overdue[0];
  if (!oldest) return;
  out.waiting = { count: overdue.length, oldest: oldest.partition, since: oldest.since };
  const why = !ctx.s3("closed") ? HOLD_TEXT.no_storage
    : out.held?.partition === oldest.partition ? HOLD_TEXT[out.held.reason]
      : oldest.status === "failed" && oldest.error ? `the last attempt failed (${oldest.error.slice(0, 80)})`
        : oldest.status ? `its archive is ${oldest.status}` : "it is not exported yet";
  const n = overdue.length;
  log.warn("audit_archive_waiting", { count: n, partition: oldest.partition, since: oldest.since, status: oldest.status });
  await raiseAlert({ control: ctx.db.control, audit: ctx.db.audit }, {
    instanceId: ctx.instanceId, level: "medium", code: "audit_archive_waiting",
    summary: `${n} audit log ${n === 1 ? "month" : "months"} older than the retention ${n === 1 ? "has" : "have"} waited more than ${AUDIT_ARCHIVE_WAIT_DAYS} days for the archive: the oldest, ${oldest.partition}, since ${oldest.since.slice(0, 10)}; ${why}`,
    details: { count: n, partition: oldest.partition, since: oldest.since, status: oldest.status },
    dedupeKey: `audit_archive_waiting:${Math.floor(now / (AUDIT_ARCHIVE_WAIT_DAYS * 86_400_000))}`,
  });
}

/**
 * Retention of the archive: months dropped from the log longer ago than `keep` months (runs 'dropped', dropped_at)
 * lose their parts and manifest — every object under the month's key base, the manifest last — and become 'expired'. The run
 * row stays with its hashes: the next month's manifest names it. At most ARCHIVE_EXPIRE_PER_PASS months per pass, oldest first.
 * A failure (listing, a removal, an object still there) keeps the run 'dropped' with `error` and stops the step; the next pass
 * repeats the month from its listing.
 */
async function expireStep(ctx: ArchiveCtx, c: pg.PoolClient, t: S3Target, keep: number, out: ArchivePass, alive: () => Promise<void>): Promise<void> {
  const due = (await c.query(
    `SELECT partition_name, rows::text AS rows FROM audit_archive_runs
      WHERE instance_id = $1 AND status = 'dropped' AND dropped_at IS NOT NULL AND dropped_at < now() - make_interval(months => $2)
      ORDER BY partition_name LIMIT $3`, [ctx.instanceId, keep, ARCHIVE_EXPIRE_PER_PASS])).rows as Array<{ partition_name: string; rows: string | null }>;
  for (const r of due) {
    const name = r.partition_name, keys = archiveKeys(ctx.instanceId, name), prefix = `${keys.base}.`;
    try {
      const objs = (await s3List(t, prefix, 100_000)).map((x) => x.key);
      const order = [...objs.filter((k) => k !== keys.manifest), ...objs.filter((k) => k === keys.manifest)];
      for (const k of order) {
        await alive();
        await s3Remove(t, k);
      }
      const left = (await s3List(t, prefix, 100_000)).length;
      if (left) throw Object.assign(new Error("objects left"), { archiveCode: `expire: ${left} objects still in the storage` });
      const u = await c.query("UPDATE audit_archive_runs SET status = 'expired', expired_at = now(), error = NULL, updated_at = now() WHERE partition_name = $1 AND status = 'dropped'", [name]);
      if (!u.rowCount) continue;
      (out.expired ??= []).push({ partition: name, objects: order.length });
      log.info("audit_archive_expired", { partition: name, objects: order.length });
      await auditWorker(ctx, { event_type: "admin", details: { op: "audit_archive_expired", partition: name, rows: Number(r.rows ?? 0), objects: order.length } });
    } catch (e) {
      await alive();
      const error = (e as { archiveCode?: string } | null)?.archiveCode ?? `expire: ${errName(e)}`;
      log.warn("audit_archive_expire_failed", { partition: name, error, detail: short(e) });
      await c.query("UPDATE audit_archive_runs SET error = $2, updated_at = now() WHERE partition_name = $1 AND status = 'dropped'", [name, error])
        .catch((x) => log.warn("audit_archive_state_failed", { partition: name, error: short(x) }));
      return;
    }
  }
}

/** `error` — a short code and counts (it goes into the run, the alert and the journal); `detail` — the client's own text, log only. */
async function failRun(ctx: ArchiveCtx, c: pg.PoolClient, partition: string, error: string, out: ArchivePass, detail?: unknown): Promise<void> {
  out.failed = { partition, error };
  log.warn("audit_archive_failed", { partition, error, ...(detail === undefined ? {} : { detail: short(detail) }) });
  await c.query("UPDATE audit_archive_runs SET status = 'failed', error = $2, updated_at = now() WHERE partition_name = $1 AND status IN ('exporting', 'verified', 'failed')",
    [partition, error]).catch((e) => log.warn("audit_archive_state_failed", { partition, error: short(e) }));
  await raiseAlert({ control: ctx.db.control, audit: ctx.db.audit }, {
    instanceId: ctx.instanceId, level: "medium", code: "audit_archive_failed",
    summary: `The audit archive of ${partition} failed (${error.slice(0, 80)}); the month stays in the audit log and is exported again later`,
    details: { partition, error: error.slice(0, 120) }, dedupeKey: `audit_archive_failed:${partition}:${new Date().toISOString().slice(0, 10)}`,
  });
}

/** Export and verify one month. Not null — the run is 'verified': its state and the sha256 of the manifest written. */
async function exportStep(ctx: ArchiveCtx, c: pg.PoolClient, t: S3Target, cand: Candidate, o: ArchivePassOpts, out: ArchivePass, alive: () => Promise<void>): Promise<{ run: Run; manifestSha: string } | null> {
  const name = cand.partition_name, keys = archiveKeys(ctx.instanceId, name);
  const pageRows = o.pageRows ?? ARCHIVE_PAGE_ROWS, partMax = o.partMaxBytes ?? ARCHIVE_PART_MAX_BYTES;
  await c.query(
    `INSERT INTO audit_archive_runs (partition_name, instance_id, status, range_from, range_to, attempts, started_at, updated_at)
     VALUES ($1, $2, 'exporting', $3::timestamptz, $4::timestamptz, 1, now(), now())
     ON CONFLICT (partition_name) DO UPDATE SET status = 'exporting', instance_id = EXCLUDED.instance_id, range_from = EXCLUDED.range_from,
       range_to = EXCLUDED.range_to, attempts = audit_archive_runs.attempts + 1, started_at = now(), updated_at = now(), error = NULL, rows = NULL, parts = NULL, bytes = NULL, sha256 = NULL, manifest_key = NULL,
       manifest_sha256 = NULL, min_at = NULL, max_at = NULL, verified_at = NULL
     WHERE audit_archive_runs.status IN ('exporting', 'failed')`, [name, ctx.instanceId, cand.range_from, cand.range_to]);
  try {
    const other = (await c.query("SELECT EXISTS (SELECT 1 FROM audit_events WHERE at >= $1::timestamptz AND at < $2::timestamptz AND instance_id <> $3) AS e",
      [cand.range_from, cand.range_to, ctx.instanceId])).rows[0]?.e === true;
    if (other) throw Object.assign(new Error("other_instances"), { archiveCode: "other_instances" });
    const month = createHash("sha256"), parts: Part[] = [];
    let lines: string[] = [], size = 0, rows = 0, minAt: string | null = null, maxAt: string | null = null;
    let cursor: { at: string; id: string } | null = null;
    const flush = async () => {
      if (!lines.length) return;
      const raw = Buffer.from(lines.join("\n") + "\n", "utf8");
      month.update(raw);
      const gz = gzipSync(raw), key = keys.part(parts.length + 1);
      await alive();
      await s3Put(t, key, gz, "application/gzip");
      parts.push({ key, rows: lines.length, bytes: gz.length, sha256: sha(gz) });
      lines = []; size = 0;
    };
    for (;;) {
      const args: unknown[] = [cand.range_from, cand.range_to, pageRows];
      let after = "";
      if (cursor) { args.push(cursor.at, cursor.id); after = " AND e.at >= $4::timestamptz AND (e.at, e.id) > ($4::timestamptz, $5::uuid)"; }
      const page = (await c.query(
        `SELECT (to_jsonb(e) || '{"query_text": null}'::jsonb)::text AS line,
                e.instance_id, ${AT_TEXT("e.at")} AS k_at, e.id::text AS k_id
           FROM audit_events e
          WHERE e.at >= $1::timestamptz AND e.at < $2::timestamptz${after}
          ORDER BY e.at, e.id LIMIT $3`, args)).rows as Array<{ line: string; instance_id: string; k_at: string; k_id: string }>;
      for (const r of page) {
        if (r.instance_id !== ctx.instanceId) throw Object.assign(new Error("other_instances: the partition holds events of another instance"), { archiveCode: "other_instances" });
        const n = Buffer.byteLength(r.line, "utf8") + 1;
        if (lines.length && size + n > partMax) await flush();
        lines.push(r.line); size += n; rows++;
        minAt ??= r.k_at; maxAt = r.k_at;
      }
      if (page.length < pageRows) break;
      const last = page[page.length - 1]!;
      cursor = { at: last.k_at, id: last.k_id };
    }
    await flush();
    const monthSha = month.digest("hex");
    const prev = (await c.query(
      `SELECT manifest_sha256 FROM audit_archive_runs WHERE partition_name < $1 AND status IN ('verified', 'dropped', 'expired') AND manifest_sha256 IS NOT NULL
        ORDER BY partition_name DESC LIMIT 1`, [name])).rows[0]?.manifest_sha256 ?? null;
    const manifest: Manifest = { format: ARCHIVE_FORMAT, partition: name, instance: ctx.instanceId, month_start: cand.month_start, month_end: cand.month_end,
      range_from: cand.range_from, range_to: cand.range_to,
      rows, parts, sha256: monthSha, min_at: minAt, max_at: maxAt, prev_manifest_sha256: prev, created_at: new Date().toISOString() };
    const mBuf = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8"), mSha = sha(mBuf);
    await alive();
    await s3Put(t, keys.manifest, mBuf, "application/json");
    await removeStaleParts(t, keys.base, new Set(parts.map((p) => p.key)), alive);
    const bytes = parts.reduce((a, p) => a + p.bytes, 0);
    await c.query(
      `UPDATE audit_archive_runs SET rows = $2, parts = $3, bytes = $4, sha256 = $5, manifest_key = $6, manifest_sha256 = $7, min_at = $8, max_at = $9, updated_at = now()
        WHERE partition_name = $1 AND status = 'exporting'`, [name, rows, parts.length, bytes, monthSha, keys.manifest, mSha, minAt, maxAt]);
    // verification: what is in the storage now, not what was sent
    const problem = await verify(t, manifest, mSha, keys.manifest);
    if (problem) { await failRun(ctx, c, name, problem, out); return null; }
    const now = Number((await c.query("SELECT count(*) AS n FROM audit_events WHERE at >= $1::timestamptz AND at < $2::timestamptz",
      [cand.range_from, cand.range_to])).rows[0]?.n ?? -1);
    if (now !== rows) { await failRun(ctx, c, name, `count_mismatch: ${now} rows in the month, ${rows} exported`, out); return null; }
    const v = await c.query("UPDATE audit_archive_runs SET status = 'verified', verified_at = now(), error = NULL, updated_at = now() WHERE partition_name = $1 AND status = 'exporting'", [name]);
    if (!v.rowCount) { await failRun(ctx, c, name, "state_changed: the run left 'exporting' during the export", out); return null; }
    out.exported = { partition: name, rows, parts: parts.length, bytes, sha256: monthSha };
    log.info("audit_archive_exported", { partition: name, rows, parts: parts.length, bytes });
    await auditWorker(ctx, { event_type: "admin", details: { op: "audit_archive_exported", partition: name, rows, parts: parts.length, bytes, sha256: monthSha } });
    return { manifestSha: mSha, run: { partition_name: name, status: "verified", rows: String(rows), sha256: monthSha, manifest_key: keys.manifest, manifest_sha256: mSha, updated_at: new Date() } };
  } catch (e) {
    await alive();
    const archiveCode = (e as { archiveCode?: string } | null)?.archiveCode;
    await failRun(ctx, c, name, archiveCode ? archiveCode : `export: ${errName(e)}`, out, archiveCode ? undefined : e);
    return null;
  }
}

/**
 * A month exported again after newer months were exported (a count that differed at its drop): its manifest is new, so the
 * newer manifests name a predecessor that is gone. Each newer manifest (runs 'verified' or 'dropped', in month order) is
 * checked against the sha256 recorded when it was written and gets the new predecessor; the walk stops where the chain is
 * already right. A manifest that differs from what was written is not relinked: its run is failed (exported again if its month
 * is still in the base) and the alert names it. So is a newer manifest that is not in the storage at all (the bucket emptied
 * or replaced after the newer months were verified): that month is failed and exported in its turn, the month
 * just exported keeps its verified archive. Other storage errors fail the month just exported, so the walk is redone with it.
 * true — the month just exported is still verified (it may be dropped in this pass); false — it was failed here.
 */
async function relinkNewer(ctx: ArchiveCtx, c: pg.PoolClient, t: S3Target, name: string, manifestSha: string, out: ArchivePass, alive: () => Promise<void>): Promise<boolean> {
  const newer = (await c.query(
    `SELECT partition_name, status, manifest_key, manifest_sha256 FROM audit_archive_runs
      WHERE partition_name > $1 AND status IN ('verified', 'dropped', 'expired') AND manifest_key IS NOT NULL AND manifest_sha256 IS NOT NULL
      ORDER BY partition_name`, [name])).rows as Array<{ partition_name: string; status: string; manifest_key: string; manifest_sha256: string }>;
  let prev = manifestSha;
  for (const r of newer) {
    // an expired month: its manifest is gone, its row keeps the hash the next month links to — the chain past it is
    // anchored there and must not be relinked to the month just exported
    if (r.status === "expired") return true;
    let buf: Buffer;
    try {
      buf = await s3GetBuffer(t, r.manifest_key, S3_TIMEOUT_MS.transfer, 64 * 1024 * 1024);
    } catch (e) {
      await alive();
      if (MISSING_OBJECT.has(code(e) ?? "")) {
        await failRun(ctx, c, r.partition_name, `chain: the manifest of ${r.partition_name} is not in the storage (${errName(e)})`, out, e);
        return true;
      }
      await failRun(ctx, c, name, `chain: ${errName(e)}`, out, e);
      return false;
    }
    try {
      if (sha(buf) !== r.manifest_sha256) { await failRun(ctx, c, r.partition_name, "chain: the manifest differs from what was written", out); return true; }
      const m = JSON.parse(buf.toString("utf8")) as Manifest;
      if (m.prev_manifest_sha256 === prev) return true;
      m.prev_manifest_sha256 = prev;
      const nb = Buffer.from(JSON.stringify(m, null, 2) + "\n", "utf8"), ns = sha(nb);
      await alive();
      await s3Put(t, r.manifest_key, nb, "application/json");
      if (sha(await s3GetBuffer(t, r.manifest_key, S3_TIMEOUT_MS.transfer, 64 * 1024 * 1024)) !== ns) {
        await failRun(ctx, c, name, `chain: the relinked manifest of ${r.partition_name} differs from what was written`, out); return false;
      }
      await c.query("UPDATE audit_archive_runs SET manifest_sha256 = $2, updated_at = now() WHERE partition_name = $1 AND manifest_sha256 = $3",
        [r.partition_name, ns, r.manifest_sha256]);
      log.info("audit_archive_relinked", { partition: r.partition_name, prev: name });
      prev = ns;
    } catch (e) {
      await alive();
      await failRun(ctx, c, name, `chain: ${errName(e)}`, out, e);
      return false;
    }
  }
  return true;
}

/** Storage codes of an object that is not there (MinIO / S3 getObject and statObject). */
const MISSING_OBJECT = new Set(["NoSuchKey", "NotFound"]);

/**
 * The archive of a month verified earlier, checked again in the storage configured now, right before its partition is dropped:
 * the manifest is downloaded and compared with the sha256 recorded at the export, then every part as at the export. null —
 * the archive is there as written; otherwise a short reason.
 */
async function recheck(t: S3Target, run: Run): Promise<string | null> {
  if (!run.manifest_key || !run.manifest_sha256) return "recheck: the run has no manifest";
  let mb: Buffer;
  try { mb = await s3GetBuffer(t, run.manifest_key, S3_TIMEOUT_MS.transfer, 64 * 1024 * 1024); }
  catch (e) { return `recheck: the manifest is not readable (${errName(e)})`; }
  if (sha(mb) !== run.manifest_sha256) return "recheck: the manifest differs from what was written";
  let m: Manifest;
  try { m = JSON.parse(mb.toString("utf8")) as Manifest; } catch { return "recheck: the manifest is not JSON"; }
  if (m.partition !== run.partition_name || String(m.rows) !== String(run.rows) || m.sha256 !== run.sha256 || !Array.isArray(m.parts)) {
    return "recheck: the manifest does not describe the verified run";
  }
  try { return (await verify(t, m, run.manifest_sha256, run.manifest_key))?.replace(/^verify: /, "recheck: ") ?? null; }
  catch (e) { return `recheck: ${errName(e)}`; }
}

/** Downloads every part and the manifest; null — all equal; otherwise a short reason. */
async function verify(t: S3Target, m: Manifest, manifestSha: string, manifestKey: string): Promise<string | null> {
  const month = createHash("sha256");
  let rows = 0;
  for (const p of m.parts) {
    const gz = await s3GetBuffer(t, p.key, S3_TIMEOUT_MS.transfer, p.bytes + 1);
    if (gz.length !== p.bytes || sha(gz) !== p.sha256) return `verify: part ${p.key.slice(-24)} differs from what was written`;
    const raw = gunzipSync(gz);
    let n = 0;
    for (let i = raw.indexOf(10); i !== -1; i = raw.indexOf(10, i + 1)) n++;
    if (n !== p.rows) return `verify: part ${p.key.slice(-24)} has ${n} rows, ${p.rows} written`;
    month.update(raw);
    rows += n;
  }
  if (rows !== m.rows) return `verify: ${rows} rows in the parts, ${m.rows} in the manifest`;
  if (month.digest("hex") !== m.sha256) return "verify: the month's hash differs";
  const mb = await s3GetBuffer(t, manifestKey, S3_TIMEOUT_MS.transfer, 64 * 1024 * 1024);
  if (sha(mb) !== manifestSha) return "verify: the manifest differs from what was written";
  return null;
}

/** Parts of an earlier attempt that the new manifest does not list (an attempt with more parts): removed, best effort. */
async function removeStaleParts(t: S3Target, base: string, keep: Set<string>, alive: () => Promise<void>): Promise<void> {
  try {
    for (const x of await s3List(t, `${base}.part-`, 100_000))
      if (!keep.has(x.key)) {
        await alive();
        await s3Remove(t, x.key).catch((e) => log.warn("audit_archive_stale_part", { key: x.key, error: short(e) }));
      }
  } catch (e) {
    await alive();
    log.warn("audit_archive_stale_part", { error: short(e) });
  }
}

/**
 * Detach and drop a verified month — inside the drop hours, behind the shipping cursors and, unless it was verified in this
 * very pass (`fresh`), after its archive is checked again in the storage configured now.
 */
async function dropStep(ctx: ArchiveCtx, c: pg.PoolClient, cand: Candidate, run: Run, months: number, o: ArchivePassOpts, out: ArchivePass, fresh: boolean): Promise<void> {
  const name = cand.partition_name;
  const hold = (reason: ArchiveHold) => {
    const held = { partition: name, reason };
    out.held = held;
    if (reason === "window_unreadable") log.warn("audit_archive_held", held);
    else log.info("audit_archive_held", held);
  };
  const hours = typeof o.inWindow === "function" ? await o.inWindow() : o.inWindow;
  if (hours === "unreadable") return hold("window_unreadable");
  if (hours !== true && hours !== "in") return hold("window");
  const shipHold = await shippingHold(ctx, cand.range_to);
  if (shipHold) return hold(shipHold);
  if (!fresh) {
    const t = ctx.s3("closed");
    if (!t) return hold("no_storage");
    const problem = await recheck(t, run);
    if (problem) { await failRun(ctx, c, name, problem, out); return; }
  }
  if (!(await keepFacts(ctx, c, cand))) return hold("facts");
  let v: string | undefined;
  try {
    v = (await c.query("SELECT audit_archive_drop($1, $2) AS v", [name, months])).rows[0]?.v;
  } catch (e) {
    // the function takes its locks in the order of every reader (parent first); a timeout or a deadlock broken by the server
    // only means another session held the journal: the run stays 'verified', the drop is tried again at the next pass
    if (code(e) === "55P03") return hold("lock_timeout");
    if (code(e) === "40P01") return hold("lock_conflict");
    await failRun(ctx, c, name, `drop: ${errName(e)}`, out, e);
    return;
  }
  if (v === "count_mismatch") {
    // the function marked the run failed in its own transaction; the alert and the result here
    const err = (await c.query("SELECT error FROM audit_archive_runs WHERE partition_name = $1", [name])).rows[0]?.error ?? "count_mismatch";
    await failRun(ctx, c, name, String(err), out);
    return;
  }
  const rows = Number((await c.query("SELECT rows FROM audit_archive_runs WHERE partition_name = $1", [name])).rows[0]?.rows ?? 0);
  const sum = (await c.query("SELECT sha256 FROM audit_archive_runs WHERE partition_name = $1", [name])).rows[0]?.sha256 ?? null;
  out.dropped = { partition: name, rows };
  log.info("audit_archive_dropped", { partition: name, rows });
  await auditWorker(ctx, { event_type: "admin", details: { op: "audit_archive_dropped", partition: name, rows, sha256: sum } });
}

/**
 * Facts that live only in the journal and are read without a time bound are copied to the control DB before their month is
 * dropped: the decision on admin.tool_sessions made through an SSO session (TOOL_SESSIONS_DECISION_MARK, Readiness item
 * tool_sessions). false — the copy failed: the drop is held (the fact would be lost with the month).
 */
async function keepFacts(ctx: ArchiveCtx, c: pg.PoolClient, cand: Candidate): Promise<boolean> {
  try {
    const r = (await c.query(
      `SELECT at, details->>'admin_person' AS person FROM audit_events
        WHERE at >= $1::timestamptz AND at < $2::timestamptz AND instance_id = $3 AND ${TOOL_SESSIONS_DECISION_SQL} ORDER BY at LIMIT 1`,
      [cand.range_from, cand.range_to, ctx.instanceId])).rows[0] as { at: Date; person: string | null } | undefined;
    if (r) {
      await ctx.db.control.query(
        "INSERT INTO maintenance_state (instance_id, key, value, updated_at) VALUES ($1, $2, $3::jsonb, now()) ON CONFLICT DO NOTHING",
        [ctx.instanceId, TOOL_SESSIONS_DECISION_MARK, JSON.stringify({ at: new Date(r.at).toISOString(), person: r.person })]);
    }
    return true;
  } catch (e) {
    log.warn("audit_archive_facts_failed", { partition: cand.partition_name, error: short(e) });
    return false;
  }
}

/**
 * Audit shipping still needs the month: the cursor of the active sink is inside or before it, or a "send history" that is not
 * done has its cursor there. Shipping off, or no state row of the active sink yet (shipping starts at the end of the journal),
 * — no hold. A state that cannot be read holds the drop.
 */
async function shippingHold(ctx: ArchiveCtx, rangeTo: string): Promise<"ship_cursor" | "history_cursor" | null> {
  const sink = String(ctx.settings.get<unknown>("observability.audit_ship_mode", "off"));
  if (!SINKS.includes(sink)) return null;
  let r: { cursor_before: boolean | null; history_before: boolean | null } | undefined;
  try {
    r = (await ctx.db.control.query(
      `SELECT (cursor_at IS NULL OR cursor_at < $3::timestamptz) AS cursor_before,
              (history_requested_at IS NOT NULL AND history_done_at IS NULL AND (history_cursor_at IS NULL OR history_cursor_at < $3::timestamptz)) AS history_before
         FROM audit_ship_state WHERE instance_id = $1 AND sink = $2`, [ctx.instanceId, sink, rangeTo])).rows[0];
  } catch (e) {
    log.warn("audit_archive_ship_state_unreadable", { error: short(e) });
    return "ship_cursor";
  }
  if (!r) return null;
  if (r.cursor_before) return "ship_cursor";
  if (r.history_before) return "history_cursor";
  return null;
}

/**
 * The hours in which a verified month may be detached and dropped — the hours of processing.night_window (weekdays,
 * weekends, zone) whatever its switch. With mode `off` the night lane runs at any hour; the drop, which locks the
 * audit parent, keeps the maintenance hours. A window that cannot be read (a zone that is not one) holds the drop: the
 * export and its check still run, only the drop waits.
 */
export function archiveDropHours(w: NightWindow, at = new Date()): ArchiveDropHours {
  try {
    return inWindow({ ...w, mode: "window" }, at) ? "in" : "out";
  } catch {
    return "unreadable";
  }
}

export function inArchiveDropHours(w: NightWindow, at = new Date()): boolean {
  return archiveDropHours(w, at) === "in";
}

export function archiveDropGate(read: () => NightWindow, { force = false }: { force?: boolean } = {}): () => ArchiveDropHours {
  return () => {
    if (force) return "in";
    try {
      return archiveDropHours(read());
    } catch {
      return "unreadable";
    }
  };
}
