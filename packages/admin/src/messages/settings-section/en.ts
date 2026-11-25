export const SETTINGS_SECTION_TEXT = {
  unknownSection: (category: string): string => `The gateway does not know section ${category}. Update the schema (contracts/schema) and restart the gateway`,
  stale: "Nothing saved: some settings changed in another window. Reload the page and try again",
  staleFields: (labels: string): string => `Changed in another window: ${labels}`,
  fixFields: "Fix the highlighted fields. Nothing saved",
  noChanges: "No changes to save",
  notSavedFields: "Not saved: fix the highlighted fields",
  notSaved: (message: string): string => `Not saved: ${message}`,
  changed: (labels: string): string => `Changed: ${labels}`,
  sessionsEnded: (label: string, n: number): string => `${label}: ${n} — sign-in settings changed; people will need to sign in again`,
  saved: (n: number): string => `Saved: ${n}`,
};
