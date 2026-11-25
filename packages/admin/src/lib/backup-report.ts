import { backupText } from "../messages/backup-report";
import { bytesText } from "./converter-state";
import { formatCount } from "../i18n/format";
import type { BackupsReport } from "./types";
import { dayKey, dayKeyAfter, formatDate } from "../i18n/format";
import { instanceTz } from "../i18n/runtime";

export interface BackupLine { text: string; tone: "info" | "warn" }
export interface BackupView {
  lines: BackupLine[];
  names: Array<{ title: string; names: string[]; more: number }>;
  problems: number;
}

const OVERDUE_MS = 48 * 3_600_000;
const DAY_MS = 86_400_000;
const FRESH_DAYS = 7;
export function whenText(iso: string, now: Date, tz = instanceTz()): string {
  const at = new Date(iso);
  const hm = formatDate(at, { timeZone: tz, hour: "2-digit", minute: "2-digit" });
  const day = dayKey(at, tz);
  if (day === dayKey(now, tz)) return backupText.todayAt(hm);
  if (day === dayKeyAfter(now, -1, tz)) return backupText.yesterdayAt(hm);
  return backupText.at(formatDate(at, { timeZone: tz, day: "numeric", month: "long" }), hm);
}

import { TIMER_OFF } from "../messages/backup-report";

export function backupView(b: BackupsReport | null | undefined, now: Date = new Date(), tz = instanceTz()): BackupView {
  if (b === undefined) return { lines: [], names: [], problems: 0 };
  if (b === null) return { lines: [{ text: backupText.couldNotReadBackupInformationOpenThe, tone: "warn" }], names: [], problems: 1 };
  const lines: BackupLine[] = [];
  const warn = (text: string) => lines.push({ text, tone: "warn" });
  const info = (text: string) => lines.push({ text, tone: "info" });
  let problems = 0;
  const ret = b.retention_days;
  info(backupText.retention(ret));

  const l = b.last;
  if (!l) {
    info(backupText.oldBackupsHaveNotBeenPrunedYet);
  } else {
    const cleanup = () => backupText.pruneSummary(whenText(l.at, now, tz), l.by, l.copies, ret, l.removed_count, bytesText(l.freed_bytes), l.kept_count, l.consistent, Boolean(l.blocked || l.held));
    if (l.blocked === "no_fresh_consistent") {
      problems++;
      info(cleanup());
      warn(backupText.noFresh(ret));
    } else if (l.blocked === "invalid_setting") {
      problems++;
      info(cleanup());
      warn(backupText.theBackupRetentionPeriodInTheDatabase);
    } else if (l.held) {
      problems++;
      info(cleanup());
      warn(backupText.backupPruningIsHeldByAMarker);
    } else if (l.removed_count) {
      info(cleanup());
    } else {
      info(cleanup());
    }
    if (l.unverified_count) {
      info(backupText.unverified(l.unverified_count));
    }
    if (l.waiting_count) {
      info(backupText.waiting(l.waiting_count, bytesText(l.waiting_bytes ?? 0)));
    }
    if (now.getTime() - Date.parse(l.at) > OVERDUE_MS) {
      problems++;
      warn(backupText.pruningHasNotRunForOverTwo);
    }
    if (l.newest_consistent_at) info(backupText.latestValidBackup(whenText(l.newest_consistent_at, now, tz)));
    if (l.oldest_kept_days !== null && l.oldest_kept_days > ret && l.blocked !== "no_fresh_consistent") {
      problems++;
      warn(backupText.oldestOverdue(l.oldest_kept_days));
    } else if (l.oldest_kept_days !== null) {
      info(backupText.oldest(l.oldest_kept_days));
    }
    if (l.stale) {
      problems++;
      const age = l.newest_consistent_at ? Math.floor((now.getTime() - Date.parse(l.newest_consistent_at)) / DAY_MS) : null;
      warn(backupText.stale(FRESH_DAYS, age));
    }
    if (l.unknown_age_count) {
      problems += l.unknown_age_count;
      warn(backupText.unknownCount(l.unknown_age_count));
    }
    if (l.failed_count) {
      problems += l.failed_count;
      warn(backupText.failedCount(l.failed_count));
    }
    if (l.unreadable_count) {
      problems += l.unreadable_count;
      warn(backupText.unreadableCount(l.unreadable_count));
    }
    if (l.marked_count) info(backupText.markedCount(l.marked_count));
    if (l.skipped_count) info(backupText.leftUntouchedLinksBackupsOwnedBySomeone(formatCount(l.skipped_count)));
    if (l.skipped_overdue) {
      problems++;
      warn(backupText.skippedOverdue(l.skipped_overdue, ret));
    }
    if (l.traces_overdue) {
      problems++;
      warn(backupText.migrationOverdue(ret));
    } else if (l.traces.length) {
      info(backupText.databaseMigrationLeftoversRemainOnTheServer);
    }
  }

  const d = b.daily;
  if (d && !d.ok) {
    problems++;
    warn(backupText.dailyFailed(whenText(d.at, now, tz), d.reason ?? "dump_failed"));
  } else if (d) {
    info(backupText.nightlyBackupCreated(whenText(d.at, now, tz)));
    if (d.encrypted === false) {
      problems++;
      warn(backupText.theNightlyBackupIsUnencryptedNoBackup);
    }
  }
  const dailyOld = !d || now.getTime() - Date.parse(d.at) > OVERDUE_MS;
  if (d && dailyOld) {
    problems++;
    warn(backupText.noNightlyBackupHasBeenCreatedFor);
  }
  if (l && dailyOld && TIMER_OFF[l.timer]) {
    problems++;
    warn(TIMER_OFF[l.timer]!);
  } else if (l && !d && l.timer === "unknown") {
    info(backupText.noNightlyBackupHasBeenCreatedYet);
  }

  const names: BackupView["names"] = [];
  const list = (title: string, xs: string[], total: number) => { if (xs.length) names.push({ title, names: xs, more: Math.max(0, total - xs.length) }); };
  if (l) {
    list(backupText.unknownAge, l.unknown_age, l.unknown_age_count);
    list(backupText.couldNotDelete, l.failed, l.failed_count);
    list(backupText.unreadable, l.unreadable ?? [], l.unreadable_count ?? 0);
    list(backupText.markedKeep, l.marked, l.marked_count);
    list(backupText.awaitingThreeVerifiedBackups, l.waiting ?? [], l.waiting_count ?? 0);
    list(backupText.untouched, l.skipped, l.skipped_count);
  }
  return { lines, names, problems };
}
