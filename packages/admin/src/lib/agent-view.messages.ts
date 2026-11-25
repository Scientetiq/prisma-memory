// Texts of "What my agent sees" and of the plan op `open` (bulk "show to agents"): English, one flat catalogue
// with message ids so that the locale work can lift it mechanically. Slots in braces are filled by avText(); a slot value
// is inserted as is, never as a pattern. Number words ("1 record", "3 records") come from countOf(). It lives in lib/, not next
// to the page, because the plans library and the plan page use the op `open` texts too.
// numbers through the panel formatter: grouping of the current locale, as every count of the panel
import { formatCount } from "../i18n/format";
export const AGENT_VIEW_MESSAGES = {
  title: "What my agent sees",
  lead: "Your AI agents find only records that are visible to agents. Everything else stays here, in the workspace, for you.",
  load_what: "what your agents see",
  visible_label: "Visible to your agents",
  hidden_label: "Hidden from agents",
  meetings_label: "Meetings with you",
  incomplete: "Some numbers could not be counted right now: {parts}. Reload the page in a minute.",
  part_visible: "what agents see",
  part_hidden: "your hidden records",
  part_held_by_check: "records kept hidden by the check",
  part_meetings: "meetings",
  part_bulk_open: "what can be shown in bulk",

  spaces_title: "By space",
  spaces_hint: "Visible: what the agents of everyone who reads the space can find. Hidden: only your own records.",
  spaces_empty: "You have no spaces yet.",
  col_space: "Space",
  col_visible: "Visible to agents",
  col_hidden: "Your hidden records",
  col_default: "New records are",
  kind_personal: "Personal",
  kind_team: "Team",
  kind_project: "Project",
  kind_org: "Company",
  archived: "archived",
  class_open: "visible to agents",
  class_closed: "hidden from agents",

  hidden_title: "What is hidden and what you can do",
  hidden_none: "Nothing of yours is hidden from agents.",
  bulk_line: "{records} can be shown to agents in one go.",
  bulk_button: "Show {records} to agents…",
  bulk_how: "You will see the exact list and who will be able to read it before anything changes. Every record passes the same check as when you show one record.",
  bulk_more: "One plan takes up to {max}, the newest first; show the rest with the next plan.",
  bulk_off_admin: "Your administrator has turned off showing records to agents in bulk; you can still show them one by one on the record page.",
  bulk_off_check: "The check for passwords, keys and personal data is turned off, so records cannot be shown to agents now.",
  held_line: "{records} were kept hidden by the check for passwords, keys and personal data.",
  meetings_line: "{records} are meetings and their parts. Meetings stay with their participants; open one on its page if you need to.",
  other_line: "{records} need a decision one by one, on the record page.",
  review_action: "Review one by one",
  meetings_action: "Meetings with me",
  by_type: "By type: {list}.",
  meetings_with_me: "Meetings with you: {n}. They are always hidden from agents.",

  default_title: "New records in my personal space",
  default_hint: "Files and notes you add here, in the workspace. Records added by agents, scripts and services are not affected; records you already have do not change.",
  default_hidden: "Hidden from agents",
  default_visible: "Visible to agents after the secrets check",
  default_visible_note: "Checked for passwords, keys and personal data first; text inside images and scanned pages is not checked.",
  default_admin: "Same as my administrator's default (now: {value})",
  default_save: "Save",
  default_saving: "Saving…",
  default_fixed: "Your administrator set one default for everyone: new records in your personal space are {value}.",
  default_check_off: "The check for passwords, keys and personal data is turned off, so new records stay hidden from agents whatever you choose here.",
  default_saved_open: "New records in your personal space will be visible to your agents after the check.",
  default_saved_closed: "New records in your personal space will be hidden from agents.",
  default_saved_admin: "New records in your personal space follow your administrator's default: {value}.",
  default_existing: "Records you already have do not change.",
  default_invalid: "Choose one of the options.",
  not_saved: "Not saved: {message}",

  plan_empty: "Nothing can be shown to agents in bulk right now.",
  plan_not_made: "The plan was not made: {message}",
  plan_bad_answer: "The plan was not made: the answer of the memory had no plan.",

  plan_op: "Show to agents",
  plan_apply: "Show {records} to agents",
  plan_continue: "Continue: {records} left",
  plan_apply_reason: "Only you show records to agents, here in the workspace",
  plan_readers_title: "Who will be able to read them",
  plan_readers_self: "{space}: only your agents — {records}",
  plan_readers_list: "{space}: {people} and their agents — {records}",
  plan_readers_all: "{space}: everyone in the company — {records}",
  plan_unchecked: "Text inside images and scanned pages is not checked.",
  plan_keep_hidden: "Records you hid on purpose are in the list too: keep any of them hidden with the “{button}” button in its row.",
  plan_confirm: "I understand: agents will read these records; text inside images and scanned pages is not checked",
  plan_confirm_missing: "Confirm first: tick the box above the button.",
  plan_stop: "Stop and keep the rest hidden",
  plan_stopped: "The plan was stopped. Already shown to agents: {records}; the rest stay hidden.",
  plan_expired: "Make it again on the page “What my agent sees”: the list may have changed.",
  reason_open_check: "The check found passwords, keys or personal data — the record stays hidden",
  reason_never_open: "Your administrator never shows records like this to agents",
  reason_failed: "Not done — make a new plan on the page “What my agent sees”",

  zero_step_text: "Your agent finds nothing yet: everything you added is hidden from agents.",
  zero_step_action: "See what it sees",
} as const;

export type AgentViewMessage = keyof typeof AGENT_VIEW_MESSAGES;

/** The text of a message with its slots filled in. */
export const avText = (id: AgentViewMessage, slots: Record<string, string | number> = {}): string =>
  AGENT_VIEW_MESSAGES[id].replace(/\{([a-z]+)\}/g, (m, k: string) => (k in slots ? String(slots[k]) : m));

/** English number words: "1 record", "3 records", "1,200 documents". */
const COUNT_FORMS = {
  record: ["record", "records"], person: ["person", "people"],
  document: ["document", "documents"], note: ["note", "notes"], transcript: ["transcript", "transcripts"],
  event: ["event", "events"], summary: ["summary", "summaries"], profile: ["profile", "profiles"],
} as const;
export type CountWord = keyof typeof COUNT_FORMS;
export const countOf = (n: number, word: CountWord): string => `${formatCount(n)} ${COUNT_FORMS[word][n === 1 ? 0 : 1]}`;
/** A record type in a count; an unknown type is counted as records (a new type of the gateway must not break the page). */
export const typeCount = (type: string, n: number): string => countOf(n, Object.hasOwn(COUNT_FORMS, type) && type !== "record" && type !== "person" ? type as CountWord : "record");
export const formatNumber = (n: number): string => formatCount(n);
