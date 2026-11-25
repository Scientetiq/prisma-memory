// The backups section of the morning report (contract
// `BackupsReport`). The gateway neither takes nor prunes the copies — the deployment's backup and prune jobs on the host do
// that (after a copy, at a release, by a nightly timer); the gateway only reads their outcome from maintenance_state:
// backup_prune — the last pruning, backup_daily — the last nightly copy. The database superuser writes the rows by a host script,
// so here they are checked against the contract form: extras dropped, invalid values made default, lists up to 50 names.
// Copy names are release labels, not data; the gateway does not see the content of the copies.
import type { App } from "./context.ts";

type ReportApp = Pick<App, "db" | "instanceId" | "settings">;

/** Retention: the rule of the host's prune job — an integer from 7, above 3650 is 3650 ("keep longer"), a number as a string is
 * a number; otherwise 30 (then the job deletes nothing and writes blocked: invalid_setting). */
export const BACKUP_RETENTION = { min: 7, max: 3650, fallback: 30 } as const;
const LIST_MAX = 50;
const BY = ["db-dump", "deploy", "daily", "manual"] as const;
const TRACES = ["state/pg-userspace.sql", "state/pg-userspace.counts", "data/pg.userspace"] as const;
const BLOCKED = ["no_fresh_consistent", "invalid_setting"] as const;
const TIMER = ["enabled", "disabled", "missing", "unknown"] as const;
const DAILY_REASON = ["deploy_busy", "disk_low", "dump_failed"] as const;

export interface BackupsLast {
  at: string; by: typeof BY[number]; retention_days: number; copies: number; consistent: number;
  removed: string[]; removed_count: number; freed_bytes: number; kept_count: number;
  unknown_age: string[]; unknown_age_count: number; skipped: string[]; skipped_count: number; skipped_overdue: number;
  marked: string[]; marked_count: number; failed: string[]; failed_count: number;
  newest_consistent_at: string | null; oldest_kept_days: number | null; blocked: typeof BLOCKED[number] | null; held: boolean;
  timer: typeof TIMER[number]; stale: boolean;
  traces: Array<{ path: typeof TRACES[number]; days: number | null }>; traces_overdue: boolean;
  // optional fields: copies without manifest.txt (not verified), those of them waiting for three
  // verified newer copies, and what was not read; the outcome of an older script lacks them — then they are absent here too
  unverified_count?: number; waiting?: string[]; waiting_count?: number; waiting_bytes?: number;
  unreadable?: string[]; unreadable_count?: number;
}
export interface BackupsDaily { at: string; ok: boolean; reason: typeof DAILY_REASON[number] | null; encrypted: boolean | null }
export interface BackupsReport { retention_days: number; last: BackupsLast | null; daily: BackupsDaily | null }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);
const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, LIST_MAX).map((s) => s.slice(0, 120)) : []);
const isoOrNull = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const retention = (v: unknown): number | null => {
  const n = typeof v === "string" && /^\s*\d{1,9}\s*$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < BACKUP_RETENTION.min) return null;
  return Math.min(n, BACKUP_RETENTION.max);
};
const oneOf = <T extends string>(xs: readonly T[], v: unknown): T | null => ((xs as readonly unknown[]).includes(v) ? v as T : null);

/** The retention in force from the settings — as in the host script: above 3650 is 3650, an invalid value is 30. */
export const retentionDays = (settings: Pick<ReportApp["settings"], "get">): number =>
  retention(settings.get<unknown>("storage.backup_retention_days", BACKUP_RETENTION.fallback)) ?? BACKUP_RETENTION.fallback;

/** The last pruning (maintenance_state.backup_prune) per the contract; no time or not an object — as if none ran. */
export function parseBackupsLast(v: unknown): BackupsLast | null {
  if (!isObject(v)) return null;
  const at = isoOrNull(v.at);
  if (!at) return null;
  const list = (k: string) => names(v[k]);
  const total = (k: string, xs: string[]) => Math.max(count(v[k]), xs.length);
  const removed = list("removed"), unknown = list("unknown_age"), skipped = list("skipped"), failed = list("failed"), marked = list("marked");
  // newer fields — only if the script wrote them (as a group: list, count and place together)
  const has = (...ks: string[]) => ks.some((k) => v[k] !== undefined);
  const extra: Partial<BackupsLast> = {};
  if (has("unverified_count")) extra.unverified_count = count(v.unverified_count);
  if (has("waiting", "waiting_count", "waiting_bytes")) {
    const w = list("waiting");
    Object.assign(extra, { waiting: w, waiting_count: total("waiting_count", w), waiting_bytes: count(v.waiting_bytes) });
  }
  if (has("unreadable", "unreadable_count")) {
    const u = list("unreadable");
    Object.assign(extra, { unreadable: u, unreadable_count: total("unreadable_count", u) });
  }
  const traces = (Array.isArray(v.traces) ? v.traces : []).filter(isObject)
    .filter((t): t is { path: typeof TRACES[number]; days: unknown } => (TRACES as readonly unknown[]).includes(t.path))
    .slice(0, TRACES.length).map((t) => ({ path: t.path, days: typeof t.days === "number" && Number.isInteger(t.days) && t.days >= 0 ? t.days : null }));
  return {
    at, by: (BY as readonly unknown[]).includes(v.by) ? v.by as typeof BY[number] : "manual",
    retention_days: retention(v.retention_days) ?? BACKUP_RETENTION.fallback,
    copies: count(v.copies), consistent: count(v.consistent),
    removed, removed_count: total("removed_count", removed), freed_bytes: count(v.freed_bytes), kept_count: count(v.kept_count),
    unknown_age: unknown, unknown_age_count: total("unknown_age_count", unknown),
    skipped, skipped_count: total("skipped_count", skipped), skipped_overdue: count(v.skipped_overdue),
    marked, marked_count: total("marked_count", marked), failed, failed_count: total("failed_count", failed),
    newest_consistent_at: isoOrNull(v.newest_consistent_at),
    oldest_kept_days: typeof v.oldest_kept_days === "number" && Number.isInteger(v.oldest_kept_days) && v.oldest_kept_days >= 0 ? v.oldest_kept_days : null,
    // newer fields; the outcome of an older script lacks them — defaults: not held, the timer state unknown
    blocked: oneOf(BLOCKED, v.blocked), held: v.held === true, timer: oneOf(TIMER, v.timer) ?? "unknown",
    stale: v.stale === true, traces, traces_overdue: v.traces_overdue === true, ...extra,
  };
}

/** The last nightly copy (maintenance_state.backup_daily): time, whether valid, why not taken, whether encrypted. */
export function parseBackupDaily(v: unknown): BackupsReport["daily"] {
  if (!isObject(v)) return null;
  const at = isoOrNull(v.at);
  if (!at || typeof v.ok !== "boolean") return null;
  return { at, ok: v.ok, reason: v.ok ? null : oneOf(DAILY_REASON, v.reason), encrypted: v.ok && typeof v.encrypted === "boolean" ? v.encrypted : null };
}

/** The report section: retention from settings, the last pruning and nightly copy. A read failure throws (section is null). */
export async function backupsReport(app: ReportApp): Promise<BackupsReport> {
  const { rows } = await app.db.control.query(
    "SELECT key, value FROM maintenance_state WHERE instance_id = $1 AND key IN ('backup_prune', 'backup_daily')", [app.instanceId]);
  const by = new Map((rows as Array<{ key: string; value: unknown }>).map((r) => [r.key, r.value]));
  return { retention_days: retentionDays(app.settings), last: parseBackupsLast(by.get("backup_prune")), daily: parseBackupDaily(by.get("backup_daily")) };
}
