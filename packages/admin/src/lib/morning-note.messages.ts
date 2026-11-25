// Texts of the morning note card on the Overview: English, one flat catalogue with message
// ids so that the locale work can lift it mechanically. The counting phrases are the e-mail's own words (@memory/shared
// morning-note-text.ts — the panel image is built without packages/shared, so they are copied here; the parity test
// a parity test compares the two). Slots in braces are filled by mnText(); a slot value
// is inserted as is, never as a pattern.
type Plural = { one: string; other: string };
export const MORNING_NOTE_CARD_MESSAGES = {
  title: "Morning note",
  since: "Since {weekday} {time}",

  meetings: { one: "{n} meeting summarised", other: "{n} meetings summarised" },
  "events.decision": { one: "{n} decision", other: "{n} decisions" },
  "events.action": { one: "{n} action item", other: "{n} action items" },
  "events.question_risk": { one: "{n} open question or risk", other: "{n} open questions and risks" },
  "events.fact": { one: "{n} fact", other: "{n} facts" },
  "documents.processed": { one: "{n} document processed", other: "{n} documents processed" },
  "documents.failed": { one: "{n} document could not be processed", other: "{n} documents could not be processed" },
  waiting: "Waiting for you:",
  nothing_new: "Nothing new for you in this note.",
  "waiting.plans": { one: "{n} bulk change to apply", other: "{n} bulk changes to apply" },
  "waiting.deletion": { one: "{n} request to delete your meeting", other: "{n} requests to delete your meetings" },
  "waiting.held": { one: "{n} record kept hidden by the secrets check", other: "{n} records kept hidden by the secrets check" },
  "waiting.keys": { one: "{n} agent key expiring soon", other: "{n} agent keys expiring soon" },

  email_on: "This note is also e-mailed to you at {time} ({tz} time), {days}, when something is new.",
  email_off: "You turned off the e-mail of this note.",
  email_turn_on: "E-mail me this note",
  email_turn_off: "Don't e-mail me this note",
  email_saving: "Saving…",
  why_not_ready: "This installation cannot send the note by e-mail yet.",
  why_no_smtp: "This installation does not send e-mail, so the note is shown here only.",
  why_admin_off: "Your administrator has not turned on morning e-mails, so the note is shown here only.",
  why_no_days: "Your administrator has not chosen any days for the e-mail, so the note is shown here only.",
  why_no_address: "Your sign-in name is not an e-mail address, so the note is shown here only.",
  why_excluded: "Test and demo accounts do not get this e-mail, so the note is shown here only.",
  days_every: "every day",
  days_weekdays: "Monday to Friday",
  days_list: "on {list}",

  saved_on: "The e-mail of the morning note is on.",
  saved_on_line: "It comes on the mornings when something is new; nothing is sent when there is nothing to tell. If the e-mail cannot reach you now, the card says why.",
  saved_off: "The morning note will not be e-mailed to you.",
  saved_off_line: "The card on the Overview stays; you can turn the e-mail back on here.",
  switch_invalid: "Choose whether to e-mail you this note.",
  not_saved: "Not saved: {message}",
} as const satisfies Record<string, string | Plural>;
export type MorningNoteCardMessage = keyof typeof MORNING_NOTE_CARD_MESSAGES;

// numbers are written as the e-mail writes them (plain digits): the card and the e-mail must read the same
const fill = (s: string, p: Record<string, string | number>): string =>
  s.replace(/\{(\w+)\}/g, (_, k: string) => (Object.hasOwn(p, k) ? String(p[k]) : ""));

/** One message: a plural one takes `n` (English: one for 1, other for every other number). */
export function mnText(id: MorningNoteCardMessage, p: Record<string, string | number> = {}): string {
  const m = MORNING_NOTE_CARD_MESSAGES[id] as string | Plural;
  return fill(typeof m === "string" ? m : p.n === 1 ? m.one : m.other, p);
}
