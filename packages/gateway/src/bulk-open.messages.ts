// Texts of bulk "show to agents": English, one flat catalogue with message ids so that the locale work
// can lift it mechanically. Slots: {n} — a number, {fields} — the names of refused body fields. No tool names: these
// answers go to the workspace, not to an agent.
export const BULK_OPEN_MESSAGES = {
  label: "Show to agents",
  effect: "Show to agents after the check for passwords, keys and personal data",
  effect_derived: "Show to agents together with its parts ({n}) after the check for passwords, keys and personal data",
  human_only: "Only you, signed in to the workspace, can show your records to agents in bulk.",
  disabled: "Your administrator has turned off showing records to agents in bulk; you can still show them one by one on the record page.",
  check_disabled: "The check for passwords, keys and personal data is turned off, so records cannot be shown to agents in bulk now.",
  types_invalid: "types: a non-empty list of \"document\" and \"note\" without repeats.",
  space_invalid: "space: the short name of one of your spaces.",
  body_invalid: "The request must be a JSON object with the optional fields space and types.",
  unknown_fields: "Unknown fields: {fields}; only space and types are accepted.",
  space_org: "Records of the company space are shown to agents one by one, on the record page.",
  ids_only: "A plan that shows records to agents takes a list of record ids only.",
} as const;

export type BulkOpenMessage = keyof typeof BULK_OPEN_MESSAGES;
type Slots = Partial<Record<"n" | "fields", string>>;

/** The text of a message with its slots filled in (a slot value is inserted as is, never as a pattern). */
export const bulkOpenText = (id: BulkOpenMessage, slots: Slots = {}): string =>
  BULK_OPEN_MESSAGES[id].replace(/\{(n|fields)\}/g, (_m, k: keyof Slots) => slots[k] ?? "");
