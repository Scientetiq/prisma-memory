// User-visible texts of document versions: one flat table of message ids, so that the locale catalog can take them
// over without touching the code. No text is built by concatenating words in other modules.

export const DOC_VERSION_TEXT = {
  bad_id: "replaces: the id of the document this file is a new version of (a record id)",
  not_versionable: "Only an uploaded document can get a new version: meetings, notes, derived records, directory cards, work profiles and space guides cannot",
  not_current: "This is not the current version of the document: upload the new version with replaces set to the current one",
  version_denied: "Only the author of the document can upload a new version of it",
  version_denied_key: "Only the author of the document can upload a new version of it with a key; the owner of the space can replace somebody else's document in the workspace",
  version_space: "A new version stays in the space of the document: leave space out or name the document's own space",
  version_format_org: "In Company knowledge a PDF or office file cannot become a new version yet: upload the text (.md, .txt) as the new version, or upload the file as a separate document",
  original_not_stored: "The file could not be stored, so it cannot be processed as a new version: try again later",
  read_only: "This space is read-only for you: a new version cannot be uploaded here",
  open_check_hint: "The document is visible to agents, so its new version must pass the secrets check. Remove these details from the file, or hide the document from agents (Close) and then upload the new version",
  same_bytes: "This file is already the current version of the document",
  /** `{n}` — the version the bytes belong to, `{m}` — the current version, `{id}` — the id of the current version. */
  older_version: "These bytes are version {n} of this document; the current version is {m}. To bring them back, upload the file with replaces={id}",
  /** The same, for a key that does not read the document's class: it cannot upload the version itself. */
  older_version_workspace: "These bytes are version {n} of this document; the current version is {m}. To bring them back, upload the file as a new version of the document in the workspace",
  /** MCP text of a repeat that resolved to the current version; `{note}` — older_version. */
  known_older: "This file is already in memory: {path} · {note}",
  head_converting: "The current version of this document is still being processed: try again in a minute",
  head_not_converted: "The current version of this document could not be processed, so it cannot get a new version: upload the file as a separate document",
  placements_dropped: "The new version is not shown in {count} other space(s) where the previous version was placed: you cannot write there any more",
  accepted: "New version {v} of the document accepted: {path} · class {cls} · indexing started; the previous version stays readable by id",
  /** A PDF or office file as a new version — it replaces the current version only after conversion and the checks. */
  accepted_pending: "New version {v} of the document accepted: {path} · class {cls} · it replaces the current version once it is converted and checked; until then search finds the current version",
  pending_same_bytes: "This file is already being processed as new version {v} of the document",
  placements_dropped_pending: "Once processed, the new version will not be shown in {count} other space(s) where the previous version is placed: you cannot write there any more",
  /** Why a pending version did not replace the current one (history, the record page). */
  pending_conversion_failed: "The new version could not be converted, so the previous version is still the current one",
  pending_open_check: "The new version did not pass the secrets check, so the previous version is still the current one",
  pending_head_gone: "The document was deleted while this file was being processed as its new version: the file was not added and only you can see it. Delete it, or upload it as a separate document",
  pending_head_moved: "The document was moved to another space, or hidden from or shown to agents, while this file was being processed as its new version: the file was not added and only you can see it. Upload it again as a new version of the document where it is now, or delete it",
  pending_head_changed: "The document's owner or audience changed while this file was being processed as its new version: the file was not added and only you can see it. Upload it again as a new version, or delete it",
  pending_head_newer: "A newer version of the document was added after this file failed to process, so the file was not added and only you can see it. Upload it again as a new version if it is still needed, or delete it",
} as const;

export type DocVersionTextId = keyof typeof DOC_VERSION_TEXT;

/** A text with its `{name}` slots filled in. Unknown slots stay as they are. */
export function docVersionText(id: DocVersionTextId, params: Record<string, string | number> = {}): string {
  return DOC_VERSION_TEXT[id].replace(/\{([a-z]+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}
