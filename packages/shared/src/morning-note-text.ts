// Text of the personal morning note. English, by message id, so that a locale catalog can take the table
// over; until then this is the only place of the note's words. The e-mail carries numbers and links only —
// no title, text or id of a record, and no address but the workspace's own (access.workplace_url). The only personal datum
// is the name in the greeting (greetingName). All counters zero — no e-mail (null).
import { countsTotal, type MorningNoteCounts } from "./morning-note.ts";

type Plural = { one: string; other: string };
export const MORNING_NOTE_MESSAGES = {
  "subject.meetings": { one: "Memory: your morning note — {n} meeting summarised", other: "Memory: your morning note — {n} meetings summarised" },
  "subject.documents": { one: "Memory: your morning note — {n} document processed", other: "Memory: your morning note — {n} documents processed" },
  "subject.failed": { one: "Memory: your morning note — {n} document could not be processed", other: "Memory: your morning note — {n} documents could not be processed" },
  "subject.waiting": { one: "Memory: your morning note — {n} thing waiting for you", other: "Memory: your morning note — {n} things waiting for you" },
  "greeting.name": "Good morning, {name}.",
  "greeting.plain": "Good morning.",
  "since": "Since {weekday} {time}:",
  "meetings": { one: "{n} meeting summarised", other: "{n} meetings summarised" },
  "events.decision": { one: "{n} decision", other: "{n} decisions" },
  "events.action": { one: "{n} action item", other: "{n} action items" },
  "events.question_risk": { one: "{n} open question or risk", other: "{n} open questions and risks" },
  "events.fact": { one: "{n} fact", other: "{n} facts" },
  "documents.processed": { one: "{n} document processed", other: "{n} documents processed" },
  "documents.failed": { one: "{n} document could not be processed", other: "{n} documents could not be processed" },
  "waiting": "Waiting for you: {list}",
  "waiting.plans": { one: "{n} bulk change to apply", other: "{n} bulk changes to apply" },
  "waiting.deletion": { one: "{n} request to delete your meeting", other: "{n} requests to delete your meetings" },
  "waiting.held": { one: "{n} record kept hidden by the secrets check", other: "{n} records kept hidden by the secrets check" },
  "waiting.keys": { one: "{n} agent key expiring soon", other: "{n} agent keys expiring soon" },
  "line.link": "- {text} — {url}",
  "line.plain": "- {text}",
  "footer": "Titles and text are not included in this e-mail.",
  "off.link": "Turn the note off: {url} (card \"Morning note\").",
  "off.plain": "Turn the note off in the workspace: card \"Morning note\" on the Overview.",
} as const satisfies Record<string, string | Plural>;
export type MorningNoteMessageId = keyof typeof MORNING_NOTE_MESSAGES;

const fill = (s: string, p: Record<string, string | number>): string => s.replace(/\{(\w+)\}/g, (_, k: string) => String(p[k] ?? ""));

/** One message: a plural one takes `n` (English: one for 1, other for every other number). */
export function morningNoteMessage(id: MorningNoteMessageId, p: Record<string, string | number> = {}): string {
  const m = MORNING_NOTE_MESSAGES[id] as string | Plural;
  return fill(typeof m === "string" ? m : p.n === 1 ? m.one : m.other, p);
}

/** The workspace address for links: http(s) only, no trailing slash; anything else — no links (as the curators' digest). */
export function workplaceBase(url: string | null | undefined): string | null {
  const u = String(url ?? "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(u) ? u : null;
}

/**
 * A word of a name: letters with their combining marks (Devanagari vowel signs, Arabic vowels, Thai tone marks — a mark never
 * opens a word), inner apostrophes and hyphens; no digits, dots, signs or addresses.
 */
const NAME_WORD = /^\p{L}[\p{L}\p{M}]*(?:['\u2019-]\p{L}[\p{L}\p{M}]*)*$/u;
const LATIN = /^[\p{Script=Latin}'\u2019\-\s,.]+$/u;
/** Titles and honorifics that may open a display name ("Dr. Anna Weber"): then the name is not guessed. */
const TITLES = new Set(["dr", "mr", "mrs", "ms", "mx", "miss", "prof", "sir", "dame", "herr", "frau", "mme", "mlle", "dott", "ing", "mag"]);
/** One line of a name, NFC (a decomposed "Jose\u0301" reads as "Jos\u00e9"), without control and format characters. */
const oneLine = (s: string | null | undefined): string => String(s ?? "").normalize("NFC").replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim();
/** Up to three words of a name, 40 characters at most. */
const nameWords = (s: string): string | null => {
  const words = s.split(" ");
  return s && s.length <= 40 && words.length <= 3 && words.every((w) => NAME_WORD.test(w)) ? s : null;
};

/**
 * The name for the greeting. First the name the product addresses the person by (people.attrs.given_name: the directory's
 * givenName, the sign-in provider's given_name or the people table — the workspace greets by it too). Without it, from the
 * display name only where the order is clear: "Surname, Given" — the part after the comma; a Latin-script "Given Surname" —
 * the first word, when it starts with a capital letter and is no title. Anything else (other scripts, where the surname may
 * come first; initials, titles, dots, digits, host-like words) — no name, the plain "Good morning.": a surname instead of the
 * name is worse than no name.
 */
export function greetingName(givenName: string | null | undefined, displayName: string | null | undefined): string | null {
  const given = nameWords(oneLine(givenName));
  if (given) return given;
  const display = oneLine(displayName);
  if (!display || !LATIN.test(display)) return null;
  const comma = display.split(",");
  if (comma.length === 2) {
    const first = comma[1]!.trim().split(" ")[0] ?? "";
    return NAME_WORD.test(first) && /^\p{Lu}/u.test(first) && !TITLES.has(first.toLowerCase()) ? first : null;
  }
  if (comma.length > 2) return null;
  const w = display.split(" ")[0] ?? "";
  return w.length <= 40 && NAME_WORD.test(w) && /^\p{Lu}/u.test(w) && !TITLES.has(w.toLowerCase()) ? w : null;
}

export interface MorningNoteTextInput {
  counts: MorningNoteCounts;
  /** Start of the window (the previous slot) and the zone the weekday and time are written in. */
  since: Date; tz: string;
  displayName?: string | null;
  /** people.attrs.given_name — preferred over the display name. */
  givenName?: string | null;
  workplaceUrl?: string | null;
}

/** Subject and body of the e-mail; null — all counters are zero (no e-mail). */
export function morningNoteText(i: MorningNoteTextInput): { subject: string; text: string } | null {
  const c = i.counts;
  if (countsTotal(c) === 0) return null;
  const base = workplaceBase(i.workplaceUrl);
  const line = (text: string, path: string) => base ? morningNoteMessage("line.link", { text, url: `${base}${path}` }) : morningNoteMessage("line.plain", { text });
  const list = (parts: Array<[MorningNoteMessageId, number]>) => parts.filter(([, n]) => n > 0).map(([id, n]) => morningNoteMessage(id, { n })).join(", ");
  const docs = c.documents_processed + c.documents_failed;
  const waiting = c.plans_pending + c.deletion_requests + c.held_by_check + c.keys_expiring;
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: i.tz, weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(i.since);
  const g = (t: string) => fmt.find((x) => x.type === t)?.value ?? "";
  const name = greetingName(i.givenName, i.displayName);
  const lines = [name ? morningNoteMessage("greeting.name", { name }) : morningNoteMessage("greeting.plain"),
                 morningNoteMessage("since", { weekday: g("weekday"), time: `${g("hour")}:${g("minute")}` })];
  if (c.meetings) {
    const events = list([["events.decision", c.decisions], ["events.action", c.actions], ["events.question_risk", c.questions_risks], ["events.fact", c.facts]]);
    const head = morningNoteMessage("meetings", { n: c.meetings });
    lines.push(line(events ? `${head}: ${events}` : head, "/meetings"));
  }
  if (docs) lines.push(line(list([["documents.processed", c.documents_processed], ["documents.failed", c.documents_failed]]), "/materials"));
  if (waiting) lines.push(line(morningNoteMessage("waiting", { list: list([["waiting.plans", c.plans_pending], ["waiting.deletion", c.deletion_requests],
                                                                             ["waiting.held", c.held_by_check], ["waiting.keys", c.keys_expiring]]) }), "/"));
  lines.push("", morningNoteMessage("footer"), base ? morningNoteMessage("off.link", { url: `${base}/` }) : morningNoteMessage("off.plain"));
  const subject = c.meetings ? morningNoteMessage("subject.meetings", { n: c.meetings })
    : c.documents_processed ? morningNoteMessage("subject.documents", { n: c.documents_processed })
    : c.documents_failed ? morningNoteMessage("subject.failed", { n: c.documents_failed })
    : morningNoteMessage("subject.waiting", { n: waiting });
  return { subject, text: lines.join("\n") };
}
