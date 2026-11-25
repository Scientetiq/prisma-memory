import { text as M } from "../messages/due-check";
import { derived } from "../i18n/runtime";
import { zonedParts } from "../i18n/format";
import { currentLocale, instanceTz } from "../i18n/runtime";

// Month names written in words: English ones always, Russian ones only when the language is Russian.
const EN_MONTH = "(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)(?![a-z])\\.?";
const EN_DAY_MONTH = new RegExp(`(?<![\\d.])(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${EN_MONTH}(?:,?\\s+(\\d{4}))?`, "i");
const EN_MONTH_DAY = new RegExp(`(?<![a-z])${EN_MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?![\\d])(?:,?\\s+(\\d{4}))?`, "i");
const EN_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const RU_MONTHS = ["январ", "феврал", "март", "апрел", "ма", "июн", "июл", "август", "сентябр", "октябр", "ноябр", "декабр"];
const RU_MONTH_WORD = /(\d{1,2})(?:-?го)?\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\s+(\d{4}))?/iu;
const ISO = /(\d{4})-(\d{2})-(\d{2})/;
const DOTTED = /(?<![\d.])(\d{1,2})\.(\d{1,2})(?:\.(\d{2}|\d{4}))?(?![\d])/;
/** The meeting day on the clock of zone tz as [year, month, day] (meeting deadlines, as in meeting-state.ts). */
function meetingDay(iso: string, tz: string): [number, number, number] | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = zonedParts(d, tz);
  return [p.y, p.m, p.d];
}

function firstDate(text: string, language: string): { y: number | null; m: number; d: number } | null {
  const found: Array<{ at: number; y: number | null; m: number; d: number }> = [];
  const iso = ISO.exec(text);
  if (iso) found.push({ at: iso.index, y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) });
  const enMonth = (w: string): number => EN_MONTHS.indexOf(w.slice(0, 3).toLowerCase()) + 1;
  const dm = EN_DAY_MONTH.exec(text);
  if (dm) found.push({ at: dm.index, y: dm[3] ? Number(dm[3]) : null, m: enMonth(dm[2]!), d: Number(dm[1]) });
  const md = EN_MONTH_DAY.exec(text);
  if (md) found.push({ at: md.index, y: md[3] ? Number(md[3]) : null, m: enMonth(md[1]!), d: Number(md[2]) });
  const word = language === "ru" ? RU_MONTH_WORD.exec(text) : null;
  if (word) {
    const w = word[2]!.toLowerCase();
    const m = w === "мая" ? 5 : RU_MONTHS.findIndex((p) => p !== "ма" && w.startsWith(p)) + 1;
    if (m > 0) found.push({ at: word.index, y: word[3] ? Number(word[3]) : null, m, d: Number(word[1]) });
  }
  const dot = DOTTED.exec(iso ? text.replace(ISO, " ".repeat(iso[0].length)) : text);
  if (dot) {
    const yy = dot[3] ? Number(dot[3]) : null;
    found.push({ at: dot.index, y: yy === null ? null : yy < 100 ? 2000 + yy : yy, m: Number(dot[2]), d: Number(dot[1]) });
  }
  const ok = found.filter((f) => f.m >= 1 && f.m <= 12 && f.d >= 1 && f.d <= 31).sort((a, b) => a.at - b.at);
  return ok[0] ?? null;
}

/** True when the first date named in a due text is earlier than the meeting day; month names follow the language. */
export function dueLooksPast(due: string | null | undefined, occurredAt: string | null | undefined, tz: string = instanceTz(),
  language: string = currentLocale()): boolean {
  if (!due || !occurredAt) return false;
  const day = meetingDay(occurredAt, tz), f = firstDate(due, language);
  if (!day || !f) return false;
  const meeting = Date.UTC(day[0], day[1] - 1, day[2]);
  const at = Date.UTC(f.y ?? day[0], f.m - 1, f.d);
  if (Number.isNaN(at) || at >= meeting) return false;
  return f.y !== null || meeting - at <= 183 * 86_400_000;
}



export const dueCheckNotice = (due: string): string =>
  M.theDueDateIsEarlierThan(due.trim());

export const DUE_CHECK_COPY = derived(() => ({
  dueCheck: M.checkTheDueDate,
  dueCheckHint: M.thisDueDateIsEarlierThan,
}));
