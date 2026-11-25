// Formats by locale: numbers, dates and times in a time zone, sorting. Kept out of core.ts so that
// the byte-copied core stays free of Intl and of regional literals; the panel has formats of its own.
import { localeOf, type Locale } from "./core.ts";

const MAX_CACHED = 64;
const numbers = new Map<Locale, Intl.NumberFormat>();
const collators = new Map<Locale, Intl.Collator>();
const clocks = new Map<string, Intl.DateTimeFormat>();

/** A number with the locale's digit grouping: ru 2 895 → «2 895» (no-break space U+00A0), en → "2,895". */
export function fmtNumber(locale: Locale, n: number): string {
  const loc = localeOf(locale);
  let f = numbers.get(loc);
  if (!f) {
    f = new Intl.NumberFormat(loc === "ru" ? "ru-RU" : "en-GB");
    numbers.set(loc, f);
  }
  return f.format(n);
}

export type DateTimeStyle = "date" | "time" | "dateTime" | "dateTimeZone";

/** Wall clock parts of an instant in a zone; RangeError for an unknown zone. */
function clockOf(tz: string): Intl.DateTimeFormat {
  let f = clocks.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    if (clocks.size >= MAX_CACHED) clocks.clear();
    clocks.set(tz, f);
  }
  return f;
}

/**
 * An instant as text in the zone tz. ru: DD.MM.YYYY · HH:MM · DD.MM.YYYY HH:MM · DD.MM.YYYY, HH:MM (<tz>) — the shapes of
 * the existing Russian texts; en: YYYY-MM-DD · HH:MM · YYYY-MM-DD HH:MM · YYYY-MM-DD HH:MM (<tz>). An invalid date or zone
 * throws RangeError (callers keep their own fallback text).
 */
export function fmtDateTime(locale: Locale, tz: string, at: Date | string | number, style: DateTimeStyle): string {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) throw new RangeError("fmtDateTime: invalid date");
  if (typeof tz !== "string" || !tz) throw new RangeError("fmtDateTime: invalid time zone");
  const parts = clockOf(tz).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "";
  const ru = localeOf(locale) === "ru";
  const date = ru ? `${get("day")}.${get("month")}.${get("year")}` : `${get("year")}-${get("month")}-${get("day")}`;
  const time = `${get("hour")}:${get("minute")}`;
  switch (style) {
    case "date": return date;
    case "time": return time;
    case "dateTime": return `${date} ${time}`;
    case "dateTimeZone": return ru ? `${date}, ${time} (${tz})` : `${date} ${time} (${tz})`;
    default: throw new RangeError("fmtDateTime: unknown style");
  }
}

/** A collator for sorting names and titles in the locale's order. */
export function collator(locale: Locale): Intl.Collator {
  const loc = localeOf(locale);
  let c = collators.get(loc);
  if (!c) {
    c = new Intl.Collator(loc);
    collators.set(loc, c);
  }
  return c;
}
