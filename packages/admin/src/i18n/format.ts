// Numbers, dates, sorting, zone labels and wall-clock parts for the panel, in the locale of the current request. The
// only place of the panel that names locale tags and zone ids and creates Intl objects; formatters are created lazily
// and cached per tag, options or zone. No DOM types: lib modules that the tests of other packages compile import it.
import type { Locale } from "./core";
import { currentLocale } from "./runtime";

/** The Intl tag of a locale: Russian formats as ru-RU, English as en-GB (day first, 24-hour clock). */
export function intlTag(locale: Locale = currentLocale()): "ru-RU" | "en-GB" {
  return locale === "ru" ? "ru-RU" : "en-GB";
}

/** Formatters by tag and options; cleared when full (the set of option shapes in the code is small, zones are not). */
const CACHE_MAX = 128;
const NUMBERS = new Map<string, Intl.NumberFormat>();
const DATES = new Map<string, Intl.DateTimeFormat>();

function cached<F>(cache: Map<string, F>, key: string, make: () => F): F {
  let f = cache.get(key);
  if (!f) {
    f = make();
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(key, f);
  }
  return f;
}

/** A count with digit grouping in the current locale: 2895 is "2,895" in English. */
export function formatCount(n: number): string {
  return formatNumber(n);
}

/** A number in the current locale with Intl options (fraction digits and the like): 4.2 is "4,2" in Russian. */
export function formatNumber(n: number, options?: Intl.NumberFormatOptions): string {
  const tag = intlTag();
  return cached(NUMBERS, options ? `${tag} ${JSON.stringify(options)}` : tag, () => new Intl.NumberFormat(tag, options)).format(n);
}

const SEPARATORS = new Map<string, string>();

/**
 * A decimal exactly as Number#toFixed(digits) writes it (without digits: as String(n) does), with the decimal separator
 * of the current locale and no digit grouping: 3.5 is "3,5" in Russian, "3.5" in English. The rounding is toFixed's, so
 * a Russian text built with toFixed and a fixed comma stays byte for byte the same.
 */
export function formatDecimal(n: number, digits?: number): string {
  const tag = intlTag();
  let sep = SEPARATORS.get(tag);
  if (sep === undefined) {
    sep = new Intl.NumberFormat(tag).formatToParts(1.5).find((p) => p.type === "decimal")?.value ?? ".";
    SEPARATORS.set(tag, sep);
  }
  const text = digits === undefined ? String(n) : n.toFixed(digits);
  return sep === "." ? text : text.replace(".", sep);
}

/**
 * A moment as Intl writes it in the current locale with these options (the zone is options.timeZone; without it the
 * zone of the process). Under Russian it is exactly what Intl.DateTimeFormat("ru-RU", options) gives. Not a date is a
 * RangeError, as with Intl.
 */
export function formatDate(at: Date | string | number, options: Intl.DateTimeFormatOptions): string {
  const tag = intlTag();
  return cached(DATES, `${tag} ${JSON.stringify(options)}`, () => new Intl.DateTimeFormat(tag, options)).format(at instanceof Date ? at : new Date(at));
}

/**
 * Date and time with seconds, in figures, on the clock of zone tz — what Date#toLocaleString writes in the current
 * locale: "05.10.2030, 16:03:43" in Russian, "05/10/2030, 16:03:43" in English. Not a date is "Invalid Date", as there.
 */
export function formatDateTime(at: Date | string | number, tz: string): string {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return String(d);
  return formatDate(d, { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
}

const COLLATORS = new Map<Locale, Intl.Collator>();

/**
 * Order of two texts for display in the current locale. The collator takes the locale code itself, so under Russian it
 * orders exactly like a.localeCompare(b, "ru") does today.
 */
export function compareText(a: string, b: string): number {
  const locale = currentLocale();
  let c = COLLATORS.get(locale);
  if (!c) {
    c = new Intl.Collator(locale);
    COLLATORS.set(locale, c);
  }
  return c.compare(a, b);
}

/** The time zone ID as supplied by the caller. */
export function zoneLabel(tz: string): string {
  return tz;
}

/** Date and time of a moment on the clock of a zone: month 1–12, two-digit hours (00–23), minutes and seconds. */
export interface WallParts {
  y: number;
  m: number;
  d: number;
  hh: string;
  mm: string;
  ss: string;
}

const WALL = new Map<string, Intl.DateTimeFormat>();
const WALL_MAX = 64;

/**
 * Wall-clock parts of the moment at in zone tz (without a zone: the zone of the process, in the browser the person's).
 * Date arithmetic, not display: the parts do not depend on the interface language. An unknown zone is a RangeError.
 */
export function zonedParts(at: Date, tz?: string): WallParts {
  const key = tz ?? "";
  let f = WALL.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { ...(tz ? { timeZone: tz } : {}), hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    if (WALL.size >= WALL_MAX) WALL.clear();
    WALL.set(key, f);
  }
  const p = f.formatToParts(at);
  const get = (k: string) => p.find((x) => x.type === k)?.value ?? "0";
  return { y: Number(get("year")), m: Number(get("month")), d: Number(get("day")), hh: get("hour").padStart(2, "0").replace(/^24$/, "00"), mm: get("minute"), ss: get("second") };
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** The calendar day of a moment on the clock of zone tz (without a zone: the zone of the process): "2026-10-05". */
export function dayKey(at: Date, tz?: string): string {
  const p = zonedParts(at, tz);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
}

/**
 * The calendar day `days` days after the day of moment at on the clock of zone tz (negative: before), in the form of
 * dayKey. Calendar arithmetic, not 24-hour steps: a day of 23 or 25 hours at a change of daylight saving time is still
 * one day.
 */
export function dayKeyAfter(at: Date, days: number, tz?: string): string {
  const p = zonedParts(at, tz);
  const d = new Date(0);
  d.setUTCFullYear(p.y, p.m - 1, p.d + days);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** True when Intl of this runtime accepts tz as a time zone (no check of its shape: see isZone for that). */
export function zoneKnown(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The time zone of this process — in the browser the person's; "" when Intl does not tell. */
export function systemZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}
