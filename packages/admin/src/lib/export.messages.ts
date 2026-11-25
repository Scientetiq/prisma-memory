// Texts of the space export in the workplace: the button on the space page, the page "what goes
// into the archive" and the refusals of the download route. Flat ids with {placeholders}, no concatenation in JSX, so the
// locale catalogs can lift them as they are. English is the default; nothing here is shown to agents.

export const EXPORT_MESSAGES = {
  "button.label": "Export this space",
  "button.hint": "Download everything you can read here as one archive in open formats",

  "page.title": "Export “{name}”",
  "page.title_plain": "Export a space",
  "page.lead": "One archive with every record you can read in this space: text as Markdown, details as JSON and the original files as they were uploaded.",
  "page.back": "Back to “{name}”",
  "page.back_plain": "Spaces and projects",
  "page.what_title": "What goes into the archive",
  "page.records": "{n} records",
  "page.records_one": "1 record",
  "page.records_none": "No records you can read yet: the archive will contain only the description of the space.",
  "page.originals": "{n} of them with the original file",
  "page.originals_one": "1 of them with the original file",
  "page.size": "About {size} before compression",
  "page.classes_both": "Records visible to agents and records hidden from agents are both included.",
  "page.classes_open": "Only records visible to agents are included.",
  "page.versions": "Earlier versions are included; the trash is not.",
  "page.no_access": "{n} records of this space are left out: they are shared with other people only.",
  "page.no_access_one": "1 record of this space is left out: it is shared with other people only.",
  "page.moving": "{n} records are being made visible to agents or hidden right now and are left out; export again in a few minutes to include them.",
  "page.moving_one": "1 record is being made visible to agents or hidden right now and is left out; export again in a few minutes to include it.",
  "page.format_title": "How to open the archive",
  "page.format_line": "It is a .tar.gz file: open it with the archive tool of your computer. Each record is a Markdown file with a JSON file of its details next to it; the original files are in the folder originals. The file manifest.json comes last: an archive without it is incomplete.",
  "page.audit_line": "The export is recorded in your activity and in the activity of the space owner. The archive is a full copy of the records: keep it where only you can open it.",
  "page.download": "Download archive",
  "page.download_hint": "The download starts at once; a large space takes a while. Keep this page open until the file is saved.",
  "page.preview_denied": "Export is not available in preview mode.",
  "page.bad_space": "This space cannot be exported: open a space and use “Export this space” there.",
  "page.preview_failed": "The numbers could not be loaded right now. Try again in a minute.",

  "error.forbidden_origin": "Exports start only from the pages of the workplace.",
  "error.session": "Your session has ended. Sign in again and repeat the export.",
  "error.preview": "Export is not available in preview mode.",
  "error.bad_request": "Choose a space to export.",
  "error.disabled": "Export of spaces is switched off by the administrator.",
  "error.denied": "Your role in this space does not allow exporting it. Ask its owner.",
  "error.not_found": "This space was not found, or you no longer have access to it.",
  "error.running": "An export of yours is already running. Wait until it has finished.",
  "error.busy": "Too many exports are running right now. Try again in a minute.",
  "error.daily_limit": "You have reached the number of exports allowed per day. Try again later.",
  "error.rate_limited": "Too many requests. Try again in a minute.",
  "error.unavailable": "The export cannot start right now. Try again later.",
  "error.unreachable": "The memory service does not answer. Try again in a minute.",
} as const;

export type ExportMessageId = keyof typeof EXPORT_MESSAGES;

/** A text by id with its {placeholders} filled in; a placeholder without a value stays as it is. */
export function exportText(id: ExportMessageId, vars: Record<string, string | number> = {}): string {
  return EXPORT_MESSAGES[id].replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}
