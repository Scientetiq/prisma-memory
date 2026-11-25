// Texts of the person's default for new records in the personal space: English, one flat catalogue with
// message ids so that locale work can lift it mechanically. Slots: {path} — the record path, {fields} — the
// names of refused body fields. No tool names: these answers go to the workspace, not to an agent.
export const UPLOAD_DEFAULT_MESSAGES = {
  saved_open: "Saved and visible to your agents: {path}. Colleagues do not see it. You can hide it again on the record page.",
  saved_open_pending_conversion: "Accepted: {path}. The text is checked for passwords, keys and personal data after conversion; until then agents do not see the file. If the check finds something, the document stays hidden from agents.",
  saved_hidden_by_check: "Saved, but hidden from agents: {path}. The secrets check found something agents should not see; the record page shows what it found.",
  human_only: "Only you, signed in to the workspace, can see this page and change this choice.",
  human_only_hint: "Open the workspace",
  choice_disabled: "Your administrator set one default for everyone; a personal choice is not available.",
  value_invalid: "value: \"closed\", \"open\" or null (the default of your administrator).",
  unknown_fields: "Unknown fields: {fields}; only value is accepted.",
} as const;

export type UploadDefaultMessage = keyof typeof UPLOAD_DEFAULT_MESSAGES;
type Slots = Partial<Record<"path" | "fields", string>>;

/** The text of a message with its slots filled in; a string is the {path} (a slot value is inserted as is, never as a pattern). */
export const uploadDefaultText = (id: UploadDefaultMessage, slots: string | Slots = ""): string => {
  const s: Slots = typeof slots === "string" ? { path: slots } : slots;
  return UPLOAD_DEFAULT_MESSAGES[id].replace(/\{(path|fields)\}/g, (_m, k: keyof Slots) => s[k] ?? "");
};
