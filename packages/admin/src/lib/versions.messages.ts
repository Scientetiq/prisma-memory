// Texts of document versions in the workspace: the "Versions" block of the record page, the "Upload new version"
// form, the pending state of a converted version, the badge of "My records" and the delete warning. One flat table, so
// that the locale catalog can take it over without touching the components; nothing here is built from words elsewhere.

export const VERSIONS_TEXT = {
  title: "Versions",
  hint: "A new version replaces the previous one in search and for agents. Earlier versions are kept: open one to read it or download its file.",
  version: (n: number): string => `Version ${n}`,
  current: "current",
  thisPage: "you are here",
  open: "Open",
  by: (who: string): string => `by ${who}`,
  unknownSize: "size unknown",
  processing: "being processed",
  notAccepted: "not accepted",
  olderNotice: "This is an earlier version of the document. Search and agents use the current version.",
  openCurrent: "Open the current version",

  /** The page of a converted new version that the worker has not finished yet. */
  pendingLead: "New version, being processed.",
  pendingText: "It replaces the current version once the file is converted and checked. Until then search and agents use the current version.",
  /** A converted new version that did not replace the current one. */
  refusedLead: "This new version was not accepted.",
  refusedFallback: "The previous version is still the current one.",
  forDocument: "Open the document",

  upload: {
    button: "Upload new version",
    summary: "Upload a new version",
    hint: "Choose the updated file. It replaces this document in search; the current version stays in the history. To bring an earlier version back, download it and upload it here.",
    file: "File",
    busy: "Uploading…",
    noFile: "Choose a file first",
    accepted: (n: number): string => `Version ${n} is uploaded and is now the current version.`,
    acceptedPending: (n: number): string => `Version ${n} is uploaded. It becomes the current version once the file is processed; until then the current version stays in use.`,
    same: "This file is already the current version of the document.",
    samePending: (n: number): string => `This file is already being processed as version ${n}. It becomes the current version once processing ends; until then the previous version stays in use.`,
    failed: "The new version was not uploaded.",
    notCurrent: "A newer version of this document exists. Open the current version and upload the file there.",
    network: "The upload did not reach the memory. Check the connection and try again.",
  },

  /** "My records": a document with earlier versions, and a converted new version still waiting. */
  badge: (n: number): string => `${n} versions`,
  badgeTitle: "This document has earlier versions: they are listed on its page",
  badgePending: "New version · processing",
  badgeRefused: "New version · not accepted",

  /** Delete of a document with earlier versions: the whole chain goes to the trash and comes back together. */
  deleteConfirm: (n: number): string =>
    `Delete this document with ${n === 1 ? "its previous version" : `its ${n} previous versions`}? They disappear from search and reading at once and go to the trash together; you can restore them together until the trash period ends (30 days).`,

  /** Delete on the page of a new version still being processed or not accepted: only this upload goes, not the document. */
  deletePendingConfirm: "Delete this uploaded new version? Only this upload goes to the trash; the document and its versions stay as they are. You can restore it until the trash period ends (30 days).",

  /** Stage hints of the worker's finisher (codes `version_wait:*` and `version_refused`). */
  stageWait: { title: "waits for the current version of the document", advice: "Nothing to do: attempts are not spent; the new version is finished as soon as the document is free." },
  stageRefused: { title: "the new version was not added to the document", advice: "Retrying gives the same result. Open the record: it says why, and what to do with the file." },

  badId: "Unknown document: open the document and upload the new version from its page",
} as const;
