// Audit archive: settings and the journal horizon. The worker job audit_archive (packages/workers/src/jobs/audit-archive.ts)
// exports a month partition of audit_events older than observability.audit_retention_months to the closed-class bucket, verifies it
// and, in the mode export_and_drop, drops the partition (03-audit.sql / 08-audit-extras.sql: audit_archive_runs, audit_archive_drop).
//
// Readers that keep state in the journal (an event that proves a decision, read without a time bound) must not take "the event is
// not there" for "it never happened" once older months are gone: auditArchivedBefore() tells them from when on the journal is
// complete. Before the first drop it is null and nothing changes. A guard test
// keeps the list of such readers reviewed.

/** observability.audit_archive_mode: off — nothing is archived; export — months are exported and verified, the base keeps them;
 *  export_and_drop — a verified month is detached and dropped inside the night window. */
export const AUDIT_ARCHIVE_MODES = ["off", "export", "export_and_drop"] as const;
export type AuditArchiveMode = (typeof AUDIT_ARCHIVE_MODES)[number];
export const AUDIT_ARCHIVE_MODE_SETTING = "observability.audit_archive_mode";
/** observability.audit_retention_months: full months kept in the base before a month is archived. The floor 3 is also enforced by
 *  the database functions (the caller cannot pass less). */
export const AUDIT_RETENTION_SETTING = "observability.audit_retention_months";
export const AUDIT_RETENTION_MONTHS = { min: 3, max: 120, default: 12 } as const;
/** Top-level prefix of archive objects in the closed-class bucket — outside `<instance>/`, which the storage sweepers list. */
export const AUDIT_ARCHIVE_PREFIX = "audit-archive/";

/**
 * maintenance_state key (control DB) of the decision on admin.tool_sessions made through an SSO session (Readiness item
 * tool_sessions, a precondition of strict mode): {at, person} of its setting_change event. The event itself goes to the archive
 * with its month, so the fact is kept here — written by Readiness when it sees the event and by the archive job before it drops
 * the month that holds it. Readiness accepts it only for a time before auditArchivedBefore().
 */
export const TOOL_SESSIONS_DECISION_MARK = "tool_sessions_sso_decision";
/** The setting_change event of admin.tool_sessions made through an SSO session (the WHERE clause of both writers of the mark). */
export const TOOL_SESSIONS_DECISION_SQL =
  "event_type = 'admin' AND details->>'op' = 'setting_change' AND details->>'key' = 'admin.tool_sessions' AND details->>'admin_auth' IN ('sso', 'sso_webauthn') AND details->>'admin_person' IS NOT NULL";

/** End of an archived month in audit_archive_runs: the partition's own upper bound, or (a run without it) the month by name. */
export const AUDIT_ARCHIVED_UPTO_SQL =
  "COALESCE(range_to, (to_date(substring(partition_name from '[0-9]{4}_[0-9]{2}$'), 'YYYY_MM') + interval '1 month')::timestamptz)";

interface Queryable { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }

/**
 * Time before which the journal may miss events: the upper bound of the newest month partition that was dropped after its
 * archive was verified (runs 'dropped' or 'expired'). null — nothing was dropped (or the table is not there yet): the journal is complete.
 * `q` is a pool of a role that reads audit_archive_runs (memory_audit_reader or memory_audit_maint). Other errors are thrown —
 * the caller decides (a reader that cannot tell must not pretend the journal is complete).
 */
export async function auditArchivedBefore(q: Queryable): Promise<Date | null> {
  try {
    // asked first, so that a caller inside a transaction (the read-only plans of the test purge) is not aborted by a missing table
    if ((await q.query("SELECT to_regclass('public.audit_archive_runs') IS NOT NULL AS e")).rows[0]?.e !== true) return null;
    const r = (await q.query(
      `SELECT max(${AUDIT_ARCHIVED_UPTO_SQL}) AS before FROM audit_archive_runs WHERE status IN ('dropped', 'expired')`)).rows[0];
    return r?.before ? new Date(r.before) : null;
  } catch (e) {
    if ((e as { code?: string } | null)?.code === "42P01") return null;   // the schema of is not applied: nothing was dropped
    throw e;
  }
}

/** Retention in months from a settings value: an integer within the range, otherwise the default. */
export function auditRetentionMonths(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) && v >= AUDIT_RETENTION_MONTHS.min && v <= AUDIT_RETENTION_MONTHS.max ? v : AUDIT_RETENTION_MONTHS.default;
}

/** Archive mode from a settings value; an unknown value is "off" (nothing is exported or dropped by a typo). */
export function auditArchiveMode(v: unknown): AuditArchiveMode {
  return (AUDIT_ARCHIVE_MODES as readonly unknown[]).includes(v) ? (v as AuditArchiveMode) : "off";
}

// ---------------------------------------------------------------- retention of the archive and the backlog

/**
 * observability.audit_archive_keep_months: how many more months the archive keeps a month after the month was dropped from the
 * audit log (the rule "12 months in the log, then 24 more in the archive"). The archive job removes the parts and the manifest
 * of a month whose run was 'dropped' longer ago than this (run 'expired'); counted from the drop, so a month is never removed
 * from the archive earlier than promised, also when it was dropped late or the retention was changed. Months the log still
 * keeps are never removed. 0 — the archive is kept forever.
 */
export const AUDIT_ARCHIVE_KEEP_SETTING = "observability.audit_archive_keep_months";
export const AUDIT_ARCHIVE_KEEP_MONTHS = { min: 0, max: 240, default: 24 } as const;

/** Archive retention in months from a settings value: an integer within the range (0 — forever), otherwise the default. */
export function auditArchiveKeepMonths(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) && v >= AUDIT_ARCHIVE_KEEP_MONTHS.min && v <= AUDIT_ARCHIVE_KEEP_MONTHS.max ? v : AUDIT_ARCHIVE_KEEP_MONTHS.default;
}

/** A month older than the retention may wait this long for its archive; then the Readiness item audit_archive warns and the
 *  archive job raises the medium alert audit_archive_waiting. */
export const AUDIT_ARCHIVE_WAIT_DAYS = 7;
const DAY_MS = 86_400_000;

/** A month partition still in the log and older than the retention (audit_archive_candidates), with the state of its archive. */
export interface ArchiveCandidateState { partition: string; month_start: string; status: string | null; error?: string | null }
/** A run of audit_archive_runs with the times the archive finished with it (the month before the oldest waiting one). */
export interface ArchiveRunTimes { partition: string; status: string; verified_at?: string | Date | null; dropped_at?: string | Date | null }
/** A month that waits for the archive: since when the archive could work on it (ArchiveBacklogOpts), its run state. */
export interface ArchiveWaiting { partition: string; since: string; status: string | null; error: string | null }
export interface ArchiveBacklogOpts {
  mode: AuditArchiveMode; retentionMonths: number; now?: number;
  /** When the archive job first ran with the present mode and retention (AUDIT_ARCHIVE_SEEN_MARK; archiveSeenSince): no month
   *  waits from before it — switching the archive on, lowering the retention or an upgrade of an old install is a backlog the
   *  job works through, not a stall. null / absent — no such bound. */
  seenSince?: number | null;
  /** Runs of this instance (any status): the time the month before the oldest waiting one was finished starts that month's wait. */
  runs?: readonly ArchiveRunTimes[];
}

/** First moment the month starting at `monthStart` (YYYY-MM-DD) is older than `retentionMonths` full months (UTC). */
export function archiveDueAt(monthStart: string, retentionMonths: number): Date {
  const [y, m] = monthStart.slice(0, 7).split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + retentionMonths + 1, 1));
}

/**
 * maintenance_state key (control DB) written by the archive job: {mode, retention_months, at} — when it first ran with the
 * present mode and retention. A change of either restarts the wait of the backlog (archiveSeenSince).
 */
export const AUDIT_ARCHIVE_SEEN_MARK = "audit_archive_settings_seen";

/** The time of the mark if it was written for this mode and retention, otherwise null (the job has not run with them yet). */
export function archiveSeenSince(value: unknown, mode: AuditArchiveMode, retentionMonths: number): number | null {
  const v = value as { mode?: unknown; retention_months?: unknown; at?: unknown } | null | undefined;
  if (!v || v.mode !== mode || v.retention_months !== retentionMonths || typeof v.at !== "string") return null;
  const t = Date.parse(v.at);
  return Number.isFinite(t) ? t : null;
}

const timeOf = (d: string | Date | null | undefined): number => (d ? new Date(d).getTime() : Number.NaN);

/**
 * Months older than the retention that the archive has not finished with: in the mode export — no verified archive yet; in the
 * mode export_and_drop — still in the log (a verified month waits for the night window and the shipping cursors). A run
 * 'dropped' or 'expired' whose table is back (made by hand) is not waiting: the job never touches it. Mode off — nothing waits.
 * Both lists oldest first.
 *
 * The job works in month order, one month per pass, so only the oldest waiting month can be stalled; the newer ones queue
 * behind it. Its wait (`since`) starts at the latest of: the day it became older than the retention, the first pass with the
 * present settings (`seenSince`) and the moment the archive finished the month before it (verified in the mode export,
 * dropped in export_and_drop) — so a backlog the job works through raises nothing. The newer months wait from the later of
 * their due day and `seenSince`. `overdue` — empty unless the oldest month has waited longer than AUDIT_ARCHIVE_WAIT_DAYS;
 * then every waiting month that has waited that long.
 */
export function auditArchiveBacklog(cands: readonly ArchiveCandidateState[], o: ArchiveBacklogOpts): { pending: ArchiveWaiting[]; overdue: ArchiveWaiting[] } {
  if (o.mode === "off") return { pending: [], overdue: [] };
  const now = o.now ?? Date.now();
  const seen = typeof o.seenSince === "number" && Number.isFinite(o.seenSince) ? o.seenSince : Number.NEGATIVE_INFINITY;
  const finished = (o.runs ?? []).filter((r) => r.status === "dropped" || r.status === "expired" || (o.mode === "export" && r.status === "verified"));
  const sorted = [...cands]
    .filter((c) => c.status !== "dropped" && c.status !== "expired" && !(o.mode === "export" && c.status === "verified"))
    .sort((a, b) => a.partition.localeCompare(b.partition));
  const pending = sorted.map((c, i) => {
    let start = Math.max(archiveDueAt(c.month_start, o.retentionMonths).getTime(), seen);
    if (i === 0) {
      // the month before it that the archive finished last: its time starts this month's turn
      const before = finished.filter((r) => r.partition < c.partition).sort((a, b) => b.partition.localeCompare(a.partition))[0];
      if (before) {
        const t = Math.max(...[timeOf(before.verified_at), timeOf(before.dropped_at)].filter(Number.isFinite));
        if (Number.isFinite(t)) start = Math.max(start, t);
      }
    }
    return { partition: c.partition, since: new Date(start).toISOString(), status: c.status ?? null, error: c.error ?? null };
  });
  const late = (p: ArchiveWaiting) => now - Date.parse(p.since) > AUDIT_ARCHIVE_WAIT_DAYS * DAY_MS;
  return { pending, overdue: pending[0] && late(pending[0]) ? pending.filter(late) : [] };
}
