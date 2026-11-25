// Texts of the memory export: the README inside every archive, the note of an incomplete archive and the refusals of the
// export routes. English; flat ids so that a locale catalog can take them over.

export const EXPORT_MESSAGES = {
  "export.readme": [
    "# Memory export",
    "",
    "This archive is an export of company memory in open formats (format `prisma-memory-export/1`).",
    "",
    "- `spaces/<slug>/space.json` describes a space: name, kind, default class, description, owner and what was exported.",
    "- `spaces/<slug>/<type>/<yyyy>/<mm>/<id>.md` is a record: YAML front matter, then the text in Markdown.",
    "- `spaces/<slug>/<type>/<yyyy>/<mm>/<id>.json` holds the full metadata of the same record.",
    "- `spaces/<slug>/originals/<id>/<file name>` is the original file, byte for byte as it was stored.",
    "- `index.jsonl` lists every record with its path and the SHA-256 of its Markdown file and of its original.",
    "- `manifest.json` is the last entry: what was exported, by whom, when, the counts and what was skipped.",
    "",
    "The path of a record in this archive is the path agents cite (`/spaces/<slug>/<type>/<yyyy>/<mm>/<id>`), so a",
    "citation resolves to a file here. Previous versions of a record are included with `is_current: false`; the trash",
    "is not. Search indexes, embeddings and access-control internals are not part of the export.",
    "",
    "**An archive without `manifest.json` is incomplete**: the export stopped early, and `EXPORT-INCOMPLETE.txt` says why.",
    "",
    "The archive is plain data: anyone who holds the file can read every record in it, including those that were hidden",
    "from AI agents. Store it like the database itself.",
    "",
  ].join("\n"),
  "export.incomplete": [
    "This export is INCOMPLETE: it stopped before the end, and manifest.json was not written.",
    "Reason: {reason}",
    "Last record written: {last}",
    "Records written: {records}",
    "Run the export again to get a complete archive.",
    "",
  ].join("\n"),
  "export.disabled": "Export of spaces is switched off by the administrator",
  "export.human_only": "Only a person in the workplace can export a space",
  "export.role_owner": "Only the owner of this space can export it",
  "export.role_member": "Only the owner or a member of this space can export it",
  "export.personal_owner": "Only the owner of a personal space can export it",
  "export.daily_limit": "You have reached the number of exports allowed per day ({limit}); try again later",
  "export.busy_person": "An export of yours is already running; wait for it to finish",
  "export.busy_total": "Too many exports are running right now; try again in a minute",
  "export.audit_unavailable": "The audit log is unavailable, so the export cannot start; try again later",
  // the whole-instance export job of the server operator (workers, run-job.ts export_instance)
  "export.at_rest_notice": "The archive is plain data: anyone who holds the file can read every record in it, including those hidden from AI agents. Store it like the database itself.",
  "export.job.bad_args": "Usage: run-job.ts export_instance --out <directory> [--space <slug>] [--no-originals]; each option at most once",
  "export.job.out_required": "Name the directory for the archive with --out <directory> (inside MEMORY_EXPORT_DIR)",
  "export.job.export_dir_invalid": "MEMORY_EXPORT_DIR must be an absolute path to an existing directory other than the root; mount a directory for exports into the workers container",
  "export.job.out_not_directory": "The --out directory does not exist or is not a directory",
  "export.job.out_outside_export_dir": "The --out directory is outside MEMORY_EXPORT_DIR (after resolving symbolic links); exports are written only there",
  "export.job.out_exists": "A file with the archive name (or its .partial name) already exists; nothing was overwritten",
  "export.job.out_refused": "The archive file could not be created safely in that directory; nothing was written",
  "export.job.space_not_found": "No space with that slug in this instance",
  "export.job.audit_unavailable": "The audit log did not accept the start of the export, so nothing was read or written; try again later",
  "export.job.alert_unavailable": "The alert for the security auditor could not be raised, so the export did not start; try again later",
} as const;

export type ExportMessageId = keyof typeof EXPORT_MESSAGES;

/** A message with its {name} placeholders filled in. */
export function exportMessage(id: ExportMessageId, vars: Record<string, string | number> = {}): string {
  return EXPORT_MESSAGES[id].replace(/\{([a-z_]+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
