// Audit archive read-back: the list of the monthly archives with a check of their hash chain, the download of one part
// or manifest, and the Readiness item audit_archive. The archive itself is written by the worker job audit_archive
// (packages/workers/src/jobs/audit-archive.ts): gzip NDJSON parts and a manifest per month under
// audit-archive/<instance>/<YYYY>/ in the closed-class bucket; one row per month in audit_archive_runs (memory_audit), read here
// as memory_audit_reader.
//
// Trust: the row of a month holds the SHA-256 of its manifest as the job wrote it; the manifest holds the SHA-256 and size of
// every part and the SHA-256 of the previous month's manifest. So the storage alone cannot change an archive unnoticed: a
// manifest that differs from its row, a part that differs from its manifest, a month whose objects are gone, or a month removed
// together with its row (the next manifest then names a hash no row has) all show as `chain: "broken"` in the list, and a
// download serves only what the stored hashes vouch for. The exception is the newest month: nothing names it, so its objects
// removed together with its row leave a chain that checks — the events audit_archive_exported / audit_archive_dropped in the
// log cover it in part (audit shipping sends the receiver only their op, id and time; the month, rows and hash stay in the log). Under verify=quick the parts are checked by size only (parts_checked: "size"). Object keys are never taken from the caller: the partition name is
// checked against the pattern of a month partition, the part is a number or "manifest", and the key comes from the manifest
// that matched its row — it must lie under this instance's archive prefix.
//
// The routes GET /api/v1/admin/audit/archive and GET /api/v1/admin/audit/archive/{partition}/{part} (roles memory_admin,
// security_auditor; each download is an audit event, written before the bytes are served) are mounted by
// admin-plane/audit-archive-routes.ts, after authentication and the registry's role gate.
import { createHash } from "node:crypto";
import { pipeline, Readable, Transform } from "node:stream";
import { AUDIT_ARCHIVE_PREFIX, AUDIT_ARCHIVE_SEEN_MARK, AUDIT_ARCHIVE_WAIT_DAYS, archiveSeenSince, auditArchiveBacklog, auditArchiveKeepMonths, auditArchiveMode, auditRetentionMonths, conflict, invalid, log, MemoryError,
         makeS3Client, newId, raiseAlert, s3GetBuffer, s3GetStream, s3Size, S3_TIMEOUT_MS, type AuditArchiveMode, type S3Target } from "@memory/shared";
import { audit } from "./audit.ts";
import type { App, Caller } from "./context.ts";

/** Format of the manifests this reader understands (the worker's ARCHIVE_FORMAT). */
export const ARCHIVE_FORMAT = "prisma-audit-archive/1";
/** A month partition of audit_events: the only partition names the read-back accepts. */
export const ARCHIVE_PARTITION_RE = /^audit_events_\d{4}_(0[1-9]|1[0-2])$/;
/** Upper bound of a manifest read into memory (a month of 32 MB parts has a few hundred of them: kilobytes). */
const MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
/** Runs listed at most: one per month — 20 years. */
const LIST_MAX = 240;

// ---------------------------------------------------------------- storage seam (tests)

let storageOf = (app: App): S3Target | null => makeS3Client(app.settings, "closed");
/** Tests: the storage of closed data the read-back uses (null — not configured). */
export function setArchiveStorageForTests(f: ((app: App) => S3Target | null) | null): void {
  storageOf = f ?? ((app) => makeS3Client(app.settings, "closed"));
}

/** Archive storage cannot serve a download (503); lists report their unchecked storage state instead. */
export class ArchiveStorageUnavailable extends Error {
  constructor(readonly reason: "storage_not_configured" | "storage_unavailable" = "storage_not_configured") {
    super(reason === "storage_not_configured" ? "The storage for closed data is not configured" : "The archive storage is unavailable; try again later");
  }
}

/** A download is refused when its strict audit event could not be written. */
export class ArchiveAuditUnavailable extends Error {
  readonly reason = "audit_unavailable";
  constructor() { super("The audit log is unavailable; the archive cannot be downloaded"); }
}

// ---------------------------------------------------------------- parameters

export type ArchiveVerify = "quick" | "full";

/** `verify` of the list: quick (default) — manifests and the size of every part; full — every part downloaded and hashed. */
export function parseArchiveVerify(v: string | undefined | null): ArchiveVerify {
  if (v === undefined || v === null || v === "" || v === "quick") return "quick";
  if (v === "full") return "full";
  throw invalid("verify: quick or full");
}

/** Path of a download: a month partition name and a part number (1–9999) or "manifest". Anything else — 400. */
export function parseArchivePart(partition: string, part: string): { partition: string; part: number | "manifest" } {
  if (typeof partition !== "string" || !ARCHIVE_PARTITION_RE.test(partition)) throw invalid("partition: the name of a month partition, audit_events_YYYY_MM");
  if (part === "manifest") return { partition, part };
  if (typeof part !== "string" || !/^\d{1,4}$/.test(part) || Number(part) < 1) throw invalid("part: a part number from 1 to 9999, or manifest");
  return { partition, part: Number(part) };
}

// ---------------------------------------------------------------- list

interface RunRow {
  partition_name: string; status: string; rows: string | null; parts: number | null; bytes: string | null; sha256: string | null;
  manifest_key: string | null; manifest_sha256: string | null; range_from: Date | null; range_to: Date | null; min_at: Date | null; max_at: Date | null;
  error: string | null; attempts: number; started_at: Date | null; verified_at: Date | null; dropped_at: Date | null; expired_at: Date | null; updated_at: Date;
}
interface ManifestPart { key: string; rows: number; bytes: number; sha256: string }
interface Manifest { format: string; partition: string; rows: number; parts: ManifestPart[]; sha256: string; prev_manifest_sha256: string | null }

/**
 * State of a month's archive in the list: ok — the manifest equals its row, links to the previous month and every part is
 * there as written; broken — something of that is not so (`problem` says what); unchecked — the storage did not answer, or an
 * older month is being exported again (its new manifest is not linked yet); expired — removed by the archive retention (its
 * row keeps the hash the next month links to); not_archived — the export is running or failed (the month is in the log).
 */
export type ArchiveChain = "ok" | "broken" | "unchecked" | "expired" | "not_archived";

export interface ArchiveItem {
  partition: string; status: string; rows: number | null; parts: number | null; bytes: number | null; sha256: string | null; manifest_sha256: string | null;
  range_from: string | null; range_to: string | null; min_at: string | null; max_at: string | null; error: string | null; attempts: number;
  started_at: string | null; verified_at: string | null; dropped_at: string | null; expired_at: string | null;
  /** The month is still in the audit log (status verified, exporting or failed); dropped and expired months are only in the archive. */
  in_log: boolean;
  chain: ArchiveChain; problem: string | null;
}

export interface ArchiveList {
  mode: AuditArchiveMode; retention_months: number; keep_months: number; verify: ArchiveVerify;
  /** What `chain: "ok"` says about the parts: size — each is there with the size its manifest names (verify=quick, the default;
   *  a part changed to bytes of the same length is not seen); sha256 — each was downloaded and hashed (verify=full). The
   *  manifests and their links are checked in full either way; a download always checks the bytes it serves. */
  parts_checked: "size" | "sha256";
  storage: "ok" | "not_configured" | "error";
  /** true — every archived month checked and whole; false — at least one broken; null — not every month could be checked. */
  chain_ok: boolean | null;
  items: ArchiveItem[];
}

const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const errCode = (e: unknown): string => {
  const c = (e as { code?: unknown } | null)?.code;
  if (typeof c === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(c)) return c;
  const n = (e as Error | null)?.name;
  return typeof n === "string" && /^[A-Za-z0-9_]{1,40}$/.test(n) ? n : "error";
};
const missing = (e: unknown): boolean => ["NoSuchKey", "NotFound", "NoSuchObject"].includes(errCode(e));
/** Where this instance's archive objects live; a part key outside it is never read. */
const archiveBase = (instanceId: string): string => `${AUDIT_ARCHIVE_PREFIX}${encodeURIComponent(instanceId)}/`;

async function runsOf(app: App): Promise<RunRow[]> {
  return (await app.db.auditRead().query(
    `SELECT partition_name, status, rows::text AS rows, parts, bytes::text AS bytes, sha256, manifest_key, manifest_sha256, range_from, range_to, min_at, max_at,
            error, attempts, started_at, verified_at, dropped_at, expired_at, updated_at
       FROM audit_archive_runs WHERE instance_id = $1 ORDER BY partition_name LIMIT $2`, [app.instanceId, LIST_MAX])).rows as RunRow[];
}

/**
 * The manifest of an archived month as its row vouches for it: downloaded, its SHA-256 equal to the row's, the fields that the
 * row also holds equal, every part under this instance's prefix. Problems are codes (never storage error texts — they may name
 * hosts); `storage` — the storage did not answer (not a proof of anything).
 */
async function manifestOf(t: S3Target, app: App, r: RunRow): Promise<{ m: Manifest; buf: Buffer } | { problem: string; storage?: true }> {
  if (!r.manifest_key || !r.manifest_sha256) return { problem: "no_manifest_in_run" };
  let buf: Buffer;
  try { buf = await s3GetBuffer(t, r.manifest_key, S3_TIMEOUT_MS.transfer, MANIFEST_MAX_BYTES); }
  catch (e) { return missing(e) ? { problem: "manifest_missing" } : { problem: `storage: ${errCode(e)}`, storage: true }; }
  if (sha(buf) !== r.manifest_sha256) return { problem: "manifest_changed" };
  let m: Manifest;
  try { m = JSON.parse(buf.toString("utf8")) as Manifest; } catch { return { problem: "manifest_changed" }; }
  if (m.format !== ARCHIVE_FORMAT || m.partition !== r.partition_name || String(m.rows) !== String(r.rows) || m.sha256 !== r.sha256
      || !Array.isArray(m.parts) || (r.parts !== null && m.parts.length !== r.parts)) return { problem: "manifest_mismatch" };
  const base = archiveBase(app.instanceId);
  for (const p of m.parts) {
    if (!p || typeof p.key !== "string" || !p.key.startsWith(base) || p.key.includes("..") || typeof p.sha256 !== "string" || !Number.isInteger(p.bytes)) {
      return { problem: "part_outside_archive" };
    }
  }
  return { m, buf };
}

/** Every part of a verified manifest: quick — present with the size written; full — downloaded and hashed. null — all there. */
async function partsProblem(t: S3Target, m: Manifest, verify: ArchiveVerify): Promise<{ problem: string; storage?: true } | null> {
  for (const [i, p] of m.parts.entries()) {
    const n = String(i + 1).padStart(4, "0");
    try {
      if (verify === "quick") {
        if ((await s3Size(t, p.key)) !== p.bytes) return { problem: `part_changed: ${n}` };
      } else {
        const h = createHash("sha256");
        let size = 0;
        for await (const c of await s3GetStream(t, p.key)) { size += (c as Buffer).length; if (size > p.bytes) break; h.update(c as Buffer); }
        if (size !== p.bytes || h.digest("hex") !== p.sha256) return { problem: `part_changed: ${n}` };
      }
    } catch (e) {
      return missing(e) ? { problem: `part_missing: ${n}` } : { problem: `storage: ${errCode(e)}`, storage: true };
    }
  }
  return null;
}

/**
 * The list of the monthly archives of this instance, oldest first, each with the state of its chain (ArchiveChain). The hash a
 * manifest names as its predecessor must be the manifest hash of the nearest older month that has one (the order the job
 * links them in); the oldest manifest names none. The storage not configured — every month `unchecked`, `storage:
 * "not_configured"`, `chain_ok: null`.
 */
export async function listArchiveRuns(app: App, o: { verify?: ArchiveVerify } = {}): Promise<ArchiveList> {
  const verify = o.verify ?? "quick";
  const runs = await runsOf(app);
  const t = storageOf(app);
  let storage: ArchiveList["storage"] = t ? "ok" : "not_configured";
  const items: ArchiveItem[] = [];
  // manifest hash of the nearest older month that has one, and whether an older month is being exported again
  let prev: string | null = null, olderPending = false;
  for (const r of runs) {
    const item: ArchiveItem = {
      partition: r.partition_name, status: r.status, rows: r.rows === null ? null : Number(r.rows), parts: r.parts, bytes: r.bytes === null ? null : Number(r.bytes),
      sha256: r.sha256, manifest_sha256: r.manifest_sha256, range_from: iso(r.range_from), range_to: iso(r.range_to), min_at: iso(r.min_at), max_at: iso(r.max_at),
      error: r.error, attempts: Number(r.attempts), started_at: iso(r.started_at), verified_at: iso(r.verified_at), dropped_at: iso(r.dropped_at),
      expired_at: iso(r.expired_at), in_log: !["dropped", "expired"].includes(r.status), chain: "unchecked", problem: null,
    };
    items.push(item);
    const expected = prev;
    if (r.manifest_sha256) prev = r.manifest_sha256;
    if (r.status === "exporting" || r.status === "failed") { item.chain = "not_archived"; olderPending = true; continue; }
    if (r.status === "expired") { item.chain = "expired"; continue; }
    if (!t) continue;
    const got = await manifestOf(t, app, r);
    if ("problem" in got) {
      if (got.storage) { storage = "error"; item.problem = got.problem; continue; }
      item.chain = "broken"; item.problem = got.problem; continue;
    }
    if (got.m.prev_manifest_sha256 !== expected) {
      // an older month exported again links its newer months when it is verified: until then the link is not a proof of loss
      if (olderPending) { item.chain = "unchecked"; item.problem = "older_month_pending"; continue; }
      item.chain = "broken"; item.problem = "chain_mismatch"; continue;
    }
    const pp = await partsProblem(t, got.m, verify);
    if (pp?.storage) { storage = "error"; item.problem = pp.problem; continue; }
    if (pp) { item.chain = "broken"; item.problem = pp.problem; continue; }
    item.chain = "ok";
  }
  const checked = items.filter((i) => i.chain !== "not_archived" && i.chain !== "expired");
  const chainOk = checked.some((i) => i.chain === "broken") ? false : checked.every((i) => i.chain === "ok") ? true : null;
  if (chainOk === false) log.warn("audit_archive_chain_broken", { months: items.filter((i) => i.chain === "broken").map((i) => i.partition).slice(0, 12) });
  return {
    mode: auditArchiveMode(app.settings.get<unknown>("observability.audit_archive_mode", "off")),
    retention_months: auditRetentionMonths(app.settings.get<unknown>("observability.audit_retention_months", 12)),
    keep_months: auditArchiveKeepMonths(app.settings.get<unknown>("observability.audit_archive_keep_months", 24)),
    verify, parts_checked: verify === "full" ? "sha256" : "size", storage, chain_ok: chainOk, items,
  };
}

// ---------------------------------------------------------------- download

export interface ArchiveDownload {
  /** The bytes; the stream fails (and the response is cut) if they differ from `bytes` / `sha256`. */
  stream: Readable;
  filename: string; contentType: "application/gzip" | "application/json"; bytes: number; sha256: string;
}

/**
 * What a download found wrong with the stored bytes (contract: downloadAuditArchivePart). hash_mismatch — the whole
 * object was read, its size is right and its SHA-256 is not; size_short — it ended before the recorded size; size_long — it went
 * past the recorded size and reading stopped there (actual_bytes is then only a count above the expected size, no hash).
 */
export interface ArchiveMismatch { reason: "hash_mismatch" | "size_short" | "size_long"; actual_bytes: number; actual_sha256: string | null }

/**
 * Keep the final nonempty chunk until size and hash pass, so a corrupt object always gives a short response. `onMismatch` is
 * told once when a mismatch is established; a consumer that goes away or a storage that fails first establishes none (the
 * check is destroyed before its flush).
 */
function vouched(src: Readable, bytes: number, sum: string, onMismatch?: (m: ArchiveMismatch) => void): Readable {
  const h = createHash("sha256");
  let n = 0;
  let tail: Buffer | null = null;
  const check = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (chunk.length === 0) { cb(); return; }
      n += chunk.length;
      if (n > bytes) {
        onMismatch?.({ reason: "size_long", actual_bytes: n, actual_sha256: null });
        cb(new Error("audit archive: the object is longer than its manifest says")); return;
      }
      h.update(chunk);
      const previous = tail;
      tail = chunk;
      cb(null, previous);
    },
    flush(cb) {
      const digest = h.digest("hex");
      if (n !== bytes || digest !== sum) {
        onMismatch?.({ reason: n < bytes ? "size_short" : "hash_mismatch", actual_bytes: n, actual_sha256: digest });
        cb(new Error("audit archive: the object differs from its manifest")); return;
      }
      if (tail) this.push(tail);
      cb();
    },
  });
  // pipeline, not pipe: a check that fails or a consumer that goes away destroys the storage stream too (the object stream
  // would otherwise stay open and paused — the storage client has no request timeout)
  pipeline(src, check, () => undefined);
  return check;
}

/**
 * A download whose bytes failed their recorded size or SHA-256: the admin event audit_archive_download_mismatch and
 * a HIGH alert of the same code, one per download (dedupe key = the start event), both naming the start event in
 * download_event_id — that download failed. Only identifiers, sizes and hashes; no content, storage path or error text. Neither
 * write may throw into the stream: a failed event goes the outbox way of audit(), a failed alert is logged.
 */
async function reportMismatch(app: App, caller: Caller | null, d: { download_event_id: string; partition: string; part: number | "manifest"; expected_bytes: number;
  expected_sha256: string } & ArchiveMismatch): Promise<void> {
  const details = { download_event_id: d.download_event_id, partition: d.partition, part: d.part, reason: d.reason, expected_bytes: d.expected_bytes,
    actual_bytes: d.actual_bytes, expected_sha256: d.expected_sha256, actual_sha256: d.actual_sha256 };
  log.warn("audit_archive_download_mismatch", details);
  await audit(app, caller, { event_type: "admin", details: { op: "audit_archive_download_mismatch", ...details } });
  await raiseAlert({ control: app.db.control, audit: app.db.audit }, {
    instanceId: app.instanceId, level: "high", code: "audit_archive_download_mismatch", dedupeKey: `audit_archive_download_mismatch:${d.download_event_id}`,
    summary: `Downloaded audit archive bytes differ from the recorded hash: ${d.part === "manifest" ? "the manifest" : `part ${d.part}`} of ${d.partition} (${d.reason}); `
      + `download ${d.download_event_id} failed — do not restore its bytes, check the closed-data bucket and compare the manifest with audit_archive_runs before retrying`,
    details,
  }).catch((e: unknown) => log.warn("audit_archive_mismatch_alert_failed", { partition: d.partition, error: errCode(e) }));
}

/**
 * One part (1…) or the manifest of an archived month, for the panel's download. 400 — a path that is not a month partition and
 * a part number or "manifest"; 404 — no archive of that month here (no run, not archived yet, expired) or no such part; 409 —
 * the archive in the storage is not the one the job wrote (the manifest differs from its row, a part key outside the archive)
 * or its object is gone; ArchiveStorageUnavailable — the storage is not configured. The audit event (admin
 * audit_archive_download: partition, part, bytes, sha256) is written strictly before the bytes are returned: the journal not
 * answering refuses the download. The bytes are checked against the manifest while they are streamed; a mismatch cuts the
 * response and is recorded by reportMismatch with the id of that start event.
 */
export async function openArchivePart(app: App, caller: Caller | null, partitionRaw: string, partRaw: string): Promise<ArchiveDownload> {
  const { partition, part } = parseArchivePart(partitionRaw, partRaw);
  const r = (await runsOf(app)).find((x) => x.partition_name === partition);
  if (!r || !["verified", "dropped"].includes(r.status) || !r.manifest_key || !r.manifest_sha256) throw new MemoryError("not_found", `No archive of ${partition}`);
  const t = storageOf(app);
  if (!t) throw new ArchiveStorageUnavailable();
  const got = await manifestOf(t, app, r);
  if ("problem" in got) {
    if (got.storage) throw new ArchiveStorageUnavailable("storage_unavailable");
    throw conflict(`The archive of ${partition} in the storage is not the one the archive job wrote (${got.problem})`, { reason: "archive_broken", problem: got.problem });
  }
  let dl: Omit<ArchiveDownload, "stream"> & { open: () => Promise<Readable> };
  if (part === "manifest") {
    const buf = got.buf;
    dl = { filename: `${partition}.manifest.json`, contentType: "application/json", bytes: buf.length, sha256: r.manifest_sha256, open: async () => Readable.from([buf]) };
  } else {
    const p = got.m.parts[part - 1];
    if (!p) throw new MemoryError("not_found", `The archive of ${partition} has ${got.m.parts.length} parts`);
    dl = { filename: p.key.slice(p.key.lastIndexOf("/") + 1), contentType: "application/gzip", bytes: p.bytes, sha256: p.sha256,
      open: async () => {
        try { return await s3GetStream(t, p.key); }
        catch (e) {
          if (missing(e)) throw conflict(`Part ${part} of the archive of ${partition} is missing in the storage`, { reason: "archive_broken", problem: "part_missing" });
          throw new ArchiveStorageUnavailable("storage_unavailable");
        }
      } };
  }
  const src = await dl.open();
  // Storage may fail while the strict event is still being written. Keep the error handled until the pipeline takes over.
  let storageFailed = false;
  const onStorageError = () => { storageFailed = true; };
  src.on("error", onStorageError);
  const label: number | "manifest" = part === "manifest" ? "manifest" : part;
  const started = newId();
  try {
    try {
      await audit(app, caller, { id: started, event_type: "admin", details: { op: "audit_archive_download", partition, part: label, bytes: dl.bytes, sha256: dl.sha256 } },
        { strict: true });
    } catch {
      src.destroy();
      throw new ArchiveAuditUnavailable();
    }
    if (storageFailed) {
      src.destroy();
      throw new ArchiveStorageUnavailable("storage_unavailable");
    }
    const onMismatch = (m: ArchiveMismatch) => void reportMismatch(app, caller,
      { download_event_id: started, partition, part: label, expected_bytes: dl.bytes, expected_sha256: dl.sha256, ...m });
    return { stream: vouched(src, dl.bytes, dl.sha256, onMismatch), filename: dl.filename, contentType: dl.contentType, bytes: dl.bytes, sha256: dl.sha256 };
  } finally {
    src.off("error", onStorageError);
  }
}

// ---------------------------------------------------------------- Readiness

/** When the stored observability.audit_archive_mode and audit_retention_months got the values `mode` and `months` (the later
 *  updated_at of the two rows); null — a row is missing, holds other values, or cannot be read. */
async function settingsStoredSince(app: App, mode: AuditArchiveMode, months: number): Promise<number | null> {
  try {
    const rows = (await app.db.control.query(
      `SELECT key, value, updated_at FROM settings WHERE instance_id = $1 AND category = 'observability' AND key IN ('audit_archive_mode', 'audit_retention_months')`,
      [app.instanceId])).rows as Array<{ key: string; value: unknown; updated_at: Date | string }>;
    const m = rows.find((r) => r.key === "audit_archive_mode"), k = rows.find((r) => r.key === "audit_retention_months");
    if (!m || !k || auditArchiveMode(m.value) !== mode || auditRetentionMonths(k.value) !== months) return null;
    const t = Math.max(new Date(m.updated_at).getTime(), new Date(k.updated_at).getTime());
    return Number.isFinite(t) ? t : null;
  } catch (e) {
    log.warn("readiness_audit_archive_settings", { code: errCode(e) });
    return null;
  }
}

export interface ArchiveReadiness { id: "audit_archive"; status: "ok" | "warn"; title: string; detail?: string }

/**
 * Readiness item audit_archive: warn — the archive is off; the storage for closed data is not configured; the state cannot be
 * read; a month older than the retention has waited more than AUDIT_ARCHIVE_WAIT_DAYS (auditArchiveBacklog: not exported in
 * the mode export, still in the log in export_and_drop); the retention of the archive could not remove a month. Otherwise ok
 * with the counts. Not a precondition of the advanced mode. `v` — the three settings as Readiness sees them (with an overlay).
 */
export async function auditArchiveReadiness(app: App, v: { mode: unknown; retention: unknown; keep: unknown }): Promise<ArchiveReadiness> {
  const mode = auditArchiveMode(v.mode);
  const months = auditRetentionMonths(v.retention);
  const keep = auditArchiveKeepMonths(v.keep);
  const warn = (title: string, detail?: string): ArchiveReadiness => ({ id: "audit_archive", status: "warn", title, ...(detail ? { detail } : {}) });
  if (mode === "off") return warn("The audit archive is off: months older than the retention stay in the audit log", "observability.audit_archive_mode = off");
  let cands: Array<{ partition_name: string; month_start: string; status: string | null; error: string | null }>;
  let runs: Array<{ partition_name: string; status: string; verified_at: Date | null; dropped_at: Date | null }>;
  let counts: { verified: number; dropped: number; expired: number; expire_errors: number };
  try {
    const q = app.db.auditRead();
    cands = (await q.query(
      `SELECT c.partition_name, c.month_start::text AS month_start, r.status, r.error
         FROM audit_archive_candidates($1) c LEFT JOIN audit_archive_runs r ON r.partition_name = c.partition_name ORDER BY c.partition_name`, [months])).rows;
    runs = (await q.query("SELECT partition_name, status, verified_at, dropped_at FROM audit_archive_runs WHERE instance_id = $1 ORDER BY partition_name LIMIT $2",
      [app.instanceId, LIST_MAX])).rows;
    counts = (await q.query(
      `SELECT count(*) FILTER (WHERE status = 'verified')::int AS verified, count(*) FILTER (WHERE status = 'dropped')::int AS dropped,
              count(*) FILTER (WHERE status = 'expired')::int AS expired, count(*) FILTER (WHERE status = 'dropped' AND error LIKE 'expire:%')::int AS expire_errors
         FROM audit_archive_runs WHERE instance_id = $1`, [app.instanceId])).rows[0];
  } catch (e) {
    log.warn("readiness_audit_archive_unreadable", { code: errCode(e) });
    return warn("The state of the audit archive could not be read", `The audit log did not answer for memory_audit_reader (${errCode(e)})`);
  }
  // the job has not run with these settings yet (no mark, or a mark of another mode or retention): the wait starts when the
  // present values were stored (settings.updated_at — written by the seed and by an administrator's change, not by later seed
  // runs), so a job that never gets as far as its mark still shows after seven days; values that are not the stored ones (an
  // overlay of Readiness) or rows that cannot be read — now
  let seenSince: number | null = Date.now();
  try {
    const mark = (await app.db.control.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = $2", [app.instanceId, AUDIT_ARCHIVE_SEEN_MARK])).rows[0]?.value;
    seenSince = archiveSeenSince(mark, mode, months) ?? await settingsStoredSince(app, mode, months) ?? Date.now();
  } catch (e) {
    log.warn("readiness_audit_archive_mark", { code: errCode(e) });
    seenSince = null;
  }
  const { pending, overdue } = auditArchiveBacklog(cands.map((c) => ({ partition: c.partition_name, month_start: c.month_start, status: c.status, error: c.error })),
    { mode, retentionMonths: months, seenSince,
      runs: runs.map((r) => ({ partition: r.partition_name, status: r.status, verified_at: r.verified_at, dropped_at: r.dropped_at })) });
  const kept = keep ? `the archive keeps a month ${keep} months after it leaves the log` : "the archive is kept forever";
  let configured = false;
  try { configured = !!storageOf(app); } catch (e) { log.warn("readiness_audit_archive_storage", { code: errCode(e) }); }
  if (!configured) {
    return warn("The storage for closed data is not configured: the audit archive does not run",
      `${pending.length} ${pending.length === 1 ? "month" : "months"} older than the retention (${months} months) ${pending.length === 1 ? "waits" : "wait"} for the archive; set up storage.* for the closed class`);
  }
  if (overdue.length) {
    const o = overdue[0]!;
    const state = o.status === "failed" ? `the last attempt failed${o.error ? ` (${o.error.slice(0, 80)})` : ""}` : o.status ? `its archive is ${o.status}` : "not exported yet";
    return warn(`${overdue.length} audit log ${overdue.length === 1 ? "month has" : "months have"} waited more than ${AUDIT_ARCHIVE_WAIT_DAYS} days for the archive`,
      `Oldest: ${o.partition}, since ${o.since.slice(0, 10)}, ${state}. Mode ${mode}; the state of every month is in audit_archive_runs of the audit database`);
  }
  if (counts.expire_errors) {
    return warn(`The archive retention could not remove ${counts.expire_errors} ${counts.expire_errors === 1 ? "month" : "months"} from the storage`,
      "The job audit_archive retries every hour; the error is in audit_archive_runs");
  }
  return { id: "audit_archive", status: "ok", title: `Audit archive (${mode}): ${counts.verified} exported months in the log, ${counts.dropped} only in the archive, ${counts.expired} expired`,
    detail: `Retention ${months} months in the log; ${kept}; ${pending.length} ${pending.length === 1 ? "month waits" : "months wait"} for the archive` };
}
