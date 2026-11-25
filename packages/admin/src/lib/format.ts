import { instanceTz, isZone } from "../i18n/runtime";
import { formatDecimal, zonedParts } from "../i18n/format";
import { dates } from "../messages/common";

/** Date, month, year and time of moment t on the clock of zone tz (no zone: the process zone, in the browser the person's). */
const wallOf = (t: Date, tz?: string) => zonedParts(t, tz);

export interface WhenOptions {
  tz?: string;
  now?: Date;
  seconds?: boolean;
  relative?: boolean;
  year?: boolean;
  dayOnly?: boolean;
}

export function formatWhen(iso: string | null | undefined, o: WhenOptions = {}): string {
  if (!iso) return "—";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  const w = wallOf(t, o.tz);
  const now = wallOf(o.now ?? new Date(), o.tz);
  let day: string;
  const prev = new Date(Date.UTC(now.y, now.m - 1, now.d - 1));
  const isToday = w.y === now.y && w.m === now.m && w.d === now.d;
  const isYesterday = w.y === prev.getUTCFullYear() && w.m === prev.getUTCMonth() + 1 && w.d === prev.getUTCDate();
  if (o.relative !== false && !o.dayOnly && isToday) day = dates.today;
  else if (o.relative !== false && !o.dayOnly && isYesterday) day = dates.yesterday;
  else day = o.year === true || (o.year !== false && w.y !== now.y) ? dates.dayMonthYear(w.d, w.m, w.y) : dates.dayMonth(w.d, w.m);
  if (o.dayOnly) return day;
  return dates.dateTime(day, w.hh, w.mm, o.seconds ? w.ss : undefined);
}

export const formatWhenFull = (iso: string, tz?: string): string => formatWhen(iso, { tz, relative: false, year: true, seconds: true });

/**
 * A share as a percentage with one decimal in the current locale: 0.123 is "12,3 %" in Russian, "12.3 %" in English.
 * Rounded as toFixed rounds (the former Russian formula, exact halves included); only the separator follows the locale.
 */
export function formatShare(share: number | null | undefined): string {
  return share === null || share === undefined ? "—" : `${formatDecimal(share * 100, 1)} %`;
}

export const shortId = (id: string): string => (id.length > 12 ? `${id.slice(0, 8)}…` : id);

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function compactValue(v: unknown, max = 60): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return truncate(v, max);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return truncate(JSON.stringify(v), max);
}

export const inDaysUtc = (n: number, now = Date.now()): string => new Date(now + n * 86_400_000).toISOString().slice(0, 10);

export const personKeyLimitIso = (maxDays: number, now = Date.now()): string => `${inDaysUtc(maxDays, now)}T23:59:59Z`;

export function endOfDayIso(date: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T23:59:59Z`)) ? `${date}T23:59:59Z` : null;
}

/** An IANA time zone that Intl of this process knows; junk and other strings are not. */
export function isTimeZone(tz: string | null | undefined): tz is string {
  return isZone(tz);
}

/** Offset of zone tz at moment t (ms): local time minus UTC. */
function zoneOffsetMs(tz: string, t: number): number {
  const p = zonedParts(new Date(t), tz);
  return Date.UTC(p.y, p.m - 1, p.d, Number(p.hh), Number(p.mm), Number(p.ss)) - Math.floor(t / 1000) * 1000;
}

/**
 * Time from an <input type="datetime-local"> field → ISO in UTC. The field sends a wall time without a zone; Date.parse
 * would read it in the zone of the Next process (UTC in the container) and shift it by the person's offset. The zone is
 * the person's browser zone (hidden field tz, components/tz-field.tsx); without it, or an unknown one, the zone of the
 * installation (instanceTz). A string with an explicit offset or Z is taken as it is. Not a date is null.
 */
export function localDateTimeToIso(value: string, tz?: string | null): string | null {
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(v)) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map((x) => Number(x ?? 0)) as [number, number, number, number, number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(wall);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null;
  const zone = isTimeZone(tz) ? tz : instanceTz();
  let at = wall - zoneOffsetMs(zone, wall);
  at = wall - zoneOffsetMs(zone, at);
  return new Date(at).toISOString();
}
