// Due dates written in words, resolved to a day YYYY-MM-DD in the memory's time zone.
// The phrase set follows the output language: processing.output_language when it names a supported language, else the
// installation language (locale.language), English when neither is set. Russian uses the Russian phrase set of
// ru-date.ts; every other language uses the English set below.
//
// English phrases (case-insensitive; a leading "by", "until", "till", "before", "on", "due" or "no later than" is
// ignored): an ISO day "2026-10-16"; "today", "tonight", "end of day", "eod"; "tomorrow"; "the day after tomorrow";
// "yesterday"; "this week", "end of the week", "next week", "end of next week"; "this month", "end of the month",
// "next month"; "in N days", "in N weeks"; weekday names ("Friday", "this Friday", "next Friday", "last Friday").
// The role picks the edge of a period: due — the end ("next week" is that Sunday), as_of — the start (its Monday).
// A bare weekday as a due date is the first one after the anchor day ("by Friday" on a Friday is a week later); as an
// as_of date it is the last one on or before the anchor day. "This Friday" counts from the anchor day itself; "next" and
// "last" name the weekday in the following or previous Monday-to-Sunday week. Anything else is null: no guessing.
import { DEFAULT_LOCALE, LOCALES, type Locale } from "@memory/i18n";
import { anchorDay, resolveRuDate, RU_DATE_MAX_TEXT, type RuDateRole } from "./ru-date.ts";
import { instanceLocaleOf } from "./locale.ts";
import { fallbackTz, tzValid } from "./zoned-time.ts";

export const DUE_LANGUAGE_SETTING = "processing.output_language";

export interface DueDateOptions {
  role: RuDateRole;
  /** Memory time zone; empty or not an IANA zone falls back to fallbackTz(). */
  tz?: string;
  /** Language of the phrase set; anything but "ru" reads English phrases. Defaults to English. */
  language?: string;
}

interface SettingsLike { get<T>(path: string, fallback: T): T }

/** Language of due phrases: processing.output_language when it is a supported language, else the installation language. */
export function dueLanguageOf(settings: SettingsLike): Locale {
  const v = settings.get<unknown>(DUE_LANGUAGE_SETTING, null);
  return (LOCALES as readonly unknown[]).includes(v) ? (v as Locale) : instanceLocaleOf(settings);
}

/** A due or as-of phrase in the given language as a day YYYY-MM-DD, or null when no single day is named. */
export function resolveDueDate(text: string | null | undefined, anchor: string | number | Date, opts: DueDateOptions): string | null {
  const language = opts.language ?? DEFAULT_LOCALE;
  if (language === "ru") return resolveRuDate(text, anchor, { role: opts.role, tz: opts.tz });
  return resolveEnDate(text, anchor, { role: opts.role, tz: opts.tz });
}

const DAY_MS = 86_400_000;
const WEEKDAYS: Record<string, number> = {
  monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6, sunday: 7, sun: 7,
};
const NUMBERS: Record<string, number> = { one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

const isoOf = (dn: number): string => new Date(dn * DAY_MS).toISOString().slice(0, 10);
const isoDow = (dn: number): number => ((new Date(dn * DAY_MS).getUTCDay() + 6) % 7) + 1;
const weekMon = (dn: number): number => dn - (isoDow(dn) - 1);
const ymd = (dn: number): { y: number; m: number } => { const t = new Date(dn * DAY_MS); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1 }; };
const monthStart = (y: number, m: number): number => Date.UTC(y, m - 1, 1) / DAY_MS;
const monthEnd = (y: number, m: number): number => Date.UTC(y, m, 0) / DAY_MS;

function isoDay(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? t.getTime() / DAY_MS : null;
}

function normalize(text: string): string {
  return text.toLowerCase()
    .replace(/[  -​  　\t\r\n]/g, " ")
    .replace(/[‐-―−]/g, "-")
    .replace(/[.,;:!?"'()[\]‘’“”]/g, " ")
    .replace(/\s+/g, " ").trim()
    .replace(/^(?:(?:by|until|till|before|on|due|no later than|not later than|at the latest) )+/, "")
    .replace(/ at the latest$/, "")
    .replace(/^the /, "");
}

/** An English due or as-of phrase as a day YYYY-MM-DD in the memory's time zone, or null. */
export function resolveEnDate(text: string | null | undefined, anchor: string | number | Date, opts: { role: RuDateRole; tz?: string }): string | null {
  if (typeof text !== "string" || !text.trim() || text.length > RU_DATE_MAX_TEXT) return null;
  const a = anchorDay(anchor, tzValid(opts.tz) ? opts.tz : fallbackTz());
  if (a === null) return null;
  const due = opts.role !== "as_of";
  const s = normalize(text);
  const dn = phrase(s, a, due);
  return dn === null ? null : isoOf(dn);
}

function phrase(s: string, a: number, due: boolean): number | null {
  const iso = isoDay(s);
  if (iso !== null) return iso;
  switch (s) {
    case "today": case "tonight": case "eod": case "end of day": case "end of the day": case "end of today": case "close of business": case "cob":
      return a;
    case "tomorrow": case "end of tomorrow":
      return a + 1;
    case "day after tomorrow":
      return a + 2;
    case "yesterday":
      return a - 1;
    case "this week": case "week": case "end of week": case "end of the week": case "end of this week": case "this weekend":
      return due ? weekMon(a) + 6 : weekMon(a);
    case "next week": case "end of next week":
      return s === "end of next week" || due ? weekMon(a) + 13 : weekMon(a) + 7;
    case "this month": case "month": case "end of month": case "end of the month": case "end of this month": {
      const { y, m } = ymd(a);
      return due ? monthEnd(y, m) : monthStart(y, m);
    }
    case "next month": case "end of next month": {
      const { y, m } = ymd(monthEnd(ymd(a).y, ymd(a).m) + 1);
      return s === "end of next month" || due ? monthEnd(y, m) : monthStart(y, m);
    }
  }
  const rel = /^in (\d{1,3}|[a-z]+) (day|days|week|weeks)$/.exec(s);
  if (rel) {
    const n = /^\d+$/.test(rel[1]!) ? Number(rel[1]) : NUMBERS[rel[1]!];
    if (n === undefined) return null;
    return a + (rel[2]!.startsWith("week") ? 7 * n : n);
  }
  const wd = /^(?:(this|next|last|coming) )?([a-z]+)$/.exec(s);
  const dow = wd ? WEEKDAYS[wd[2]!] : undefined;
  if (!wd || dow === undefined) return null;
  const mod = wd[1];
  if (mod === "next") return weekMon(a) + 7 + dow - 1;
  if (mod === "last") return weekMon(a) - 7 + dow - 1;
  const diff = (dow - isoDow(a) + 7) % 7;
  if (mod === "this" || mod === "coming") return a + diff;
  if (due) return a + (diff === 0 ? 7 : diff);
  return a - ((isoDow(a) - dow + 7) % 7);
}
