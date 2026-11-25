import { formatCount } from "../../i18n/format";
import { pluralEn } from "../../i18n/core";
const daysText = (n: number): string => `${formatCount(n)} ${pluralEn(n, "day", "days")}`;
const copiesText = (n: number): string => `${formatCount(n)} ${pluralEn(n, "backup", "backups")}`;

export const backupText = {
  retention: (days: number): string => `Server database backups are kept for ${daysText(days)}, then deleted. The three latest valid backups are always kept. Change the retention period in Settings, “Storage” (“Days to keep server backups”).`,
  pruneSummary: (at: string, by: string, copies: number, retention: number, removed: number, freed: string, kept: number, consistent: number, nothing: boolean): string => { const head = `Last pruning — ${at}, ${BY_TEXT[by] ?? BY_TEXT.manual}: started with ${copiesText(copies)}`;
    return nothing ? `${head}; nothing deleted.` : removed ? `${head}; deleted ${formatCount(removed)} older than ${daysText(retention)} (freed ${freed}); kept ${formatCount(kept)}, including ${formatCount(consistent)} valid backups.` : `${head}; no backups older than ${daysText(retention)}, so nothing deleted. Valid backups — ${formatCount(consistent)}.`; },
  noFresh: (retention: number): string => `No valid backup is newer than ${daysText(retention)}; backups may have stopped working. Old backups are kept so the server is not left without any. Create and verify a fresh backup; the next pruning run will remove old ones.`,
  unverified: (count: number): string => `${copiesText(count)} without a content manifest ${count === 1 ? "was" : "were"} created using the old method and ${count === 1 ? "is" : "are"} unverified. They count as valid only while the server has no verified backups.`,
  waiting: (count: number, bytes: string): string => `${copiesText(count)} without a manifest, beyond retention (${bytes}), ${count === 1 ? "awaits" : "await"} three newer verified backups and will be deleted automatically. Nightly backups now include a manifest; this usually takes about three nights.`,
  oldestOverdue: (days: number): string => `The oldest server backup is ${daysText(days)} old, beyond retention. It is kept as one of the three latest valid backups, marked “keep”, or awaiting three verified backups because it has no manifest. It still contains data deleted by people until fresh valid backups arrive or the marker is cleared.`,
  oldest: (days: number): string => `The oldest server backup is ${daysText(days)} old.`,
  stale: (freshDays: number, age: number | null): string => `No valid backup is newer than ${daysText(freshDays)}${age === null ? " — no valid backups exist on the server" : ` — the latest is ${daysText(age)} old`}. Create a backup.`,
  unknownCount: (count: number): string => `${copiesText(count)} ${count === 1 ? "has an unknown age" : "have an unknown age"}. Pruning leaves ${count === 1 ? "it" : "them"} alone. Decide manually whether ${count === 1 ? "it is" : "they are"} needed.`,
  failedCount: (count: number): string => `Could not delete ${copiesText(count)}; ${count === 1 ? "it still takes" : "they still take"} up disk space. Check server permissions on the backup directory.`,
  unreadableCount: (count: number): string => `Cannot read ${formatCount(count)} ${pluralEn(count, "record", "records")} in the backup directory. Pruning leaves ${count === 1 ? "it" : "them"} alone, and its plan is incomplete. Check the directory permissions and disk following the runbook.`,
  markedCount: (count: number): string => `${copiesText(count)} ${count === 1 ? "is" : "are"} marked “keep”; pruning does not delete ${count === 1 ? "it" : "them"}. Clear the marker when the backup is no longer needed.`,
  skippedOverdue: (count: number, retention: number): string => `Of the untouched backups, ${copiesText(count)} ${count === 1 ? "has" : "have"} remained longer than ${daysText(retention)}. Data deleted by people remains in ${count === 1 ? "it" : "them"}. Delete ${count === 1 ? "it" : "them"} manually on the server following the runbook.`,
  migrationOverdue: (retention: number): string => `Database migration leftovers have remained longer than ${daysText(retention)}. They contain a full unencrypted database copy. After verifying the migration, delete them manually following the runbook.`,
  dailyFailed: (at: string, reason: string): string => `Nightly backup ${at} ${DAILY_SKIP[reason] ?? DAILY_SKIP.dump_failed}. Create another backup.`,
  todayAt: (value1: string | number): string => `today at ${value1}`,
  yesterdayAt: (value1: string | number): string => `yesterday at ${value1}`,
  at: (value1: string | number, value2: string | number): string => `${value1} at ${value2}`,
  couldNotReadBackupInformationOpenThe: "Could not read backup information — open the report later.",
  oldBackupsHaveNotBeenPrunedYet: "Old backups have not been pruned yet. Pruning runs after each backup, during deployment and once each night.",
  theBackupRetentionPeriodInTheDatabase: "The backup retention period in the database is missing or invalid, so old backups are kept. Set it again in Settings, “Storage”.",
  backupPruningIsHeldByAMarker: "Backup pruning is held by a marker on the server. Nothing is deleted until it is cleared. This happens on the first pruning run (deployment, backup, nightly or manual, before state/backup-prune.reviewed exists), or during recovery. Review the pruning plan, decide what to do with backups of unknown age, then clear the marker following the runbook.",
  pruningHasNotRunForOverTwo: "Pruning has not run for over two days; the nightly schedule may have stopped. Check it following the runbook.",
  latestValidBackup: (value1: string | number): string => `Latest valid backup — ${value1}.`,
  leftUntouchedLinksBackupsOwnedBySomeone: (value1: string | number): string => `Left untouched — ${value1}: links, backups owned by someone else, and backup-service copies are excluded from pruning.`,
  databaseMigrationLeftoversRemainOnTheServer: "Database migration leftovers remain on the server. Delete them manually after verification; pruning leaves them alone.",
  nightlyBackupCreated: (value1: string | number): string => `Nightly backup created ${value1}.`,
  theNightlyBackupIsUnencryptedNoBackup: "The nightly backup is unencrypted: no backup encryption key is set on the server. Anyone with access to the server disk or its snapshots can read it. Set the key following the runbook.",
  noNightlyBackupHasBeenCreatedFor: "No nightly backup has been created for over two days. Check the server's nightly schedule.",
  noNightlyBackupHasBeenCreatedYet: "No nightly backup has been created yet. The server did not report whether the schedule is enabled. If there is no backup by morning, check the schedule following the runbook.",
  unknownAge: "Unknown age",
  couldNotDelete: "Could not delete",
  unreadable: "Unreadable",
  markedKeep: "Marked “keep”",
  awaitingThreeVerifiedBackups: "Awaiting three verified backups",
  untouched: "Untouched",
};

export const BY_TEXT: Record<string, string> = { "db-dump": "immediately after backup", deploy: "during deployment", daily: "on the nightly schedule", manual: "manually" };

export const TIMER_OFF: Record<string, string> = {
  disabled: "The server's nightly backup schedule is disabled; neither backups nor pruning run nightly. Enable it following the runbook (the next deployment will also enable it).",
  missing: "The server's nightly backup schedule is not installed; neither backups nor pruning run nightly. Deployment installs it; check its output following the runbook.",
};

export const DAILY_SKIP: Record<string, string> = {
  deploy_busy: "was not created: deployment took over an hour",
  disk_low: "was not created: insufficient disk space — free space on the server",
  dump_failed: "failed — see the server log for the reason",
};
