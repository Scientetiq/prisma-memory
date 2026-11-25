// The morning note card on the Overview: the answer of GET /api/v1/me/morning-note
// and the pure rules of the card — the lines with the e-mail's numbers and the workspace pages they lead to, "Since <weekday>
// <time>" in the installation's zone, and what the e-mail switch says. No gateway calls here: the Overview and its action call
// meGw. Numbers only: the gateway sends no titles.
import { zonedParts, type WallParts } from "../i18n/format";
import { mnText, type MorningNoteCardMessage } from "./morning-note.messages";

export const MORNING_NOTE_PATH = "/api/v1/me/morning-note";

export interface MorningNoteCounts {
  meetings: number; decisions: number; actions: number; questions_risks: number; facts: number;
  documents_processed: number; documents_failed: number;
  plans_pending: number; deletion_requests: number; held_by_check: number; keys_expiring: number;
}
export interface MorningNoteEmail {
  /** The person's switch: false — turned off; null — never touched (the installation decides). */
  personal: boolean | null;
  instance_enabled: boolean; smtp_enabled: boolean; address: boolean; weekdays: number[]; kind_ready: boolean; will_send: boolean;
}
export interface MorningNoteView {
  window: { from: string; to: string; tz: string; time: string };
  counts: MorningNoteCounts;
  total: number;
  email: MorningNoteEmail;
}

export interface NoteLine { text: string; href: string }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";

/**
 * The answer of GET /me/morning-note as the card reads it, or null — then there is no card. A body of another gateway version
 * or one damaged on the way (no window, no e-mail state, no day list) must leave only the card out, never break the Overview.
 * The e-mail state is read strictly (only true is true); counters stay as sent — noteLines() treats broken ones as zero.
 */
export function parseNoteView(data: unknown): MorningNoteView | null {
  if (!isObj(data) || !isObj(data.window) || !isObj(data.email)) return null;
  const w = data.window; const e = data.email;
  if (!isStr(w.from) || !isStr(w.tz) || !isStr(w.time) || !Array.isArray(e.weekdays)) return null;
  const yes = (v: unknown) => v === true;
  return {
    window: { from: w.from, to: isStr(w.to) ? w.to : "", tz: w.tz, time: w.time },
    counts: (isObj(data.counts) ? data.counts : {}) as unknown as MorningNoteCounts,
    total: typeof data.total === "number" ? data.total : 0,
    email: {
      personal: typeof e.personal === "boolean" ? e.personal : null,
      instance_enabled: yes(e.instance_enabled), smtp_enabled: yes(e.smtp_enabled), address: yes(e.address),
      weekdays: e.weekdays.filter((d): d is number => Number.isInteger(d)), kind_ready: yes(e.kind_ready), will_send: yes(e.will_send),
    },
  };
}

/**
 * Whether the switch matters when there is nothing to tell: the e-mail would come (the e-mail sends the person to this card to
 * turn it off), or the person turned it off and may want it back. Otherwise an empty card would be noise.
 */
export function switchMatters(e: MorningNoteEmail): boolean {
  return e.will_send || e.personal === false;
}

/** A counter as a whole number ≥ 0: a missing or broken field of a newer or older gateway counts as zero, never as NaN. */
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const list = (parts: Array<[MorningNoteCardMessage, number]>): string => parts.filter(([, n]) => n > 0).map(([id, n]) => mnText(id, { n })).join(", ");

/**
 * The lines of the card, in the e-mail's order and words: meetings with their events (→ "Meetings with me"), documents
 * (→ "My records"), and what waits for the person — one line per kind, each leading to the page where it is done (the e-mail
 * has one line leading to the Overview, which is this page). Nothing to tell — no lines.
 */
export function noteLines(c: Partial<MorningNoteCounts> | null | undefined): { lines: NoteLine[]; waiting: NoteLine[] } {
  const k = (f: keyof MorningNoteCounts) => count(c?.[f]);
  const lines: NoteLine[] = [];
  if (k("meetings")) {
    const events = list([["events.decision", k("decisions")], ["events.action", k("actions")], ["events.question_risk", k("questions_risks")], ["events.fact", k("facts")]]);
    const head = mnText("meetings", { n: k("meetings") });
    lines.push({ text: events ? `${head}: ${events}` : head, href: "/meetings" });
  }
  const docs = list([["documents.processed", k("documents_processed")], ["documents.failed", k("documents_failed")]]);
  if (docs) lines.push({ text: docs, href: "/materials" });
  const waiting: NoteLine[] = ([
    ["waiting.plans", k("plans_pending"), "/plans"],
    ["waiting.deletion", k("deletion_requests"), "/meetings"],
    ["waiting.held", k("held_by_check"), "/agent-view"],
    ["waiting.keys", k("keys_expiring"), "/keys"],
  ] as Array<[MorningNoteCardMessage, number, string]>).filter(([, n]) => n > 0).map(([id, n, href]) => ({ text: mnText(id, { n }), href }));
  return { lines, waiting };
}

/**
 * "Since Friday 08:00": the start of the window in the installation's zone, written as the e-mail writes it. A zone the
 * runtime does not know — UTC; a broken date — no line.
 */
export function sinceText(fromIso: string, tz: string): string | null {
  const at = new Date(fromIso);
  if (!fromIso || Number.isNaN(at.getTime())) return null;
  // wall-clock parts through the panel formatter; the weekday from the zoned calendar day
  let p: WallParts;
  try { p = zonedParts(at, tz || "UTC"); } catch { p = zonedParts(at, "UTC"); }
  const iso = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() || 7;
  return mnText("since", { weekday: DAY[iso], time: `${p.hh}:${p.mm}` });
}

const DAY = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
/** The days of the e-mail in words: "every day", "Monday to Friday", or "on Monday, Wednesday and Friday". */
export function daysText(weekdays: readonly number[]): string {
  const days = [...new Set(weekdays.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7))].sort((a, b) => a - b);
  if (days.length === 7) return mnText("days_every");
  if (days.join() === "1,2,3,4,5") return mnText("days_weekdays");
  const names = days.map((d) => DAY[d]!);
  return mnText("days_list", { list: names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "") });
}

/**
 * What the switch says. on — the person has not turned the e-mail off (null: the installation decides); line — the state in
 * words: when it comes, or the one reason it cannot come now (the switch still saves the person's choice for later).
 */
export function emailState(e: MorningNoteEmail, time: string, tz: string): { on: boolean; line: string } {
  const on = e.personal !== false;
  if (!on) return { on, line: mnText("email_off") };
  if (e.will_send) return { on, line: mnText("email_on", { time, tz, days: daysText(e.weekdays) }) };
  const why: MorningNoteCardMessage = !e.kind_ready ? "why_not_ready" : !e.smtp_enabled ? "why_no_smtp" : !e.instance_enabled ? "why_admin_off"
    : !e.weekdays.length ? "why_no_days" : !e.address ? "why_no_address" : "why_excluded";
  return { on, line: mnText(why) };
}

/** Form value of the switch → the PUT value; undefined — not one of the two. */
export function parseNoteSwitch(raw: FormDataEntryValue | null): boolean | undefined {
  return raw === "true" ? true : raw === "false" ? false : undefined;
}
