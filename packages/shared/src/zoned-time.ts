import { addDays, zonedMidnight } from "./outcomes-week.ts";

interface SettingsLike { get<T>(path: string, fallback: T): T }

export function tzValid(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try { new Intl.DateTimeFormat("en-GB", { timeZone: tz }); return true; } catch { return false; }
}

/** The zone of an installation where nothing names one (no regional default). */
export const INSTANCE_TZ_DEFAULT = "UTC";

/** The last fallback of the instance zone: UTC, unless a test set another zone through the test-only setter. */
export function fallbackTz(): string {
  return instanceTzFallbackForTests() ?? INSTANCE_TZ_DEFAULT;
}

/**
 * The time zone of the installation: a valid locale.timezone; else the zone of the night window,
 * which earlier versions used as the instance zone (processing.night_window.tz — an installation set up before the
 * setting existed and not seeded since); else UTC (fallbackTz). An invalid or empty value is skipped, never thrown.
 */
export function instanceTz(settings: SettingsLike): string {
  const own = settings.get<unknown>("locale.timezone", null);
  if (tzValid(own)) return own;
  const legacy = settings.get<unknown>("processing.night_window", null);
  const tz = legacy && typeof legacy === "object" && !Array.isArray(legacy) ? (legacy as { tz?: unknown }).tz : undefined;
  return tzValid(tz) ? tz : fallbackTz();
}

/**
 * The zone of a stored object with an optional tz: its own valid tz, else the instance zone; absent tz means «follows the
 * installation». The curators' digest and the work hours of alerts apply the same rule in their parsers; the night window
 * keeps a stored tz that is not a zone (nightWindowOf).
 */
export function zoneFor(settings: SettingsLike, obj: unknown): string {
  const tz = obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as { tz?: unknown }).tz : undefined;
  return tzValid(tz) ? tz : instanceTz(settings);
}

export function dayExists(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === day;
}

export const WALL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/;

function offsetAt(t: number, tz: string): number {
  const base = Math.floor(t / 1000) * 1000;
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(base));
  const g = (k: string) => Number(p.find((x) => x.type === k)!.value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - base;
}

export function zonedWallToInstant(wall: string, tz: string): number | null {
  const m = WALL_TIME.exec(wall);
  if (!m || !dayExists(`${m[1]}-${m[2]}-${m[3]}`)) return null;
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)];
  if (h > 23 || mi > 59 || s > 59) return null;
  const ms = Number((m[7] ?? "").padEnd(3, "0").slice(0, 3));
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), h, mi, s, ms);
  let t = utc - offsetAt(utc, tz);
  t = utc - offsetAt(t, tz);
  return t;
}

export interface DateBound { at: Date; strict: boolean }

const ZONED = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function parseDateBound(value: string, side: "from" | "to", tz: string): DateBound | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    if (!dayExists(value)) return null;
    return side === "to" ? { at: new Date(zonedMidnight(addDays(value, 1), tz)), strict: true } : { at: new Date(zonedMidnight(value, tz)), strict: false };
  }
  if (WALL_TIME.test(value)) {
    const t = zonedWallToInstant(value, tz);
    return t === null ? null : { at: new Date(t), strict: false };
  }
  const z = ZONED.exec(value);
  if (!z || !dayExists(z[1]!)) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? { at: new Date(t), strict: false } : null;
}

export function reversedRange(from: DateBound, to: DateBound): boolean {
  return to.strict ? to.at.getTime() <= from.at.getTime() : to.at.getTime() < from.at.getTime();
}

export const upperBoundOp = (b: DateBound): "<" | "<=" => (b.strict ? "<" : "<=");

// Fallback zone a test may set; the product falls back to UTC. Test-only: the setter throws
// unless process.env.VITEST is set at the moment of the call. State lives on globalThis (test files re-import modules).
const TZ_FALLBACK = Symbol.for("@memory/shared/tz-fallback/1");
function tzFallbackBox(): { tz: string | null } {
  const g = globalThis as unknown as Record<symbol, { tz: string | null } | undefined>;
  const found = g[TZ_FALLBACK];
  if (found) return found;
  const box = { tz: null as string | null };
  Object.defineProperty(globalThis, TZ_FALLBACK, { value: box, enumerable: false, writable: false, configurable: false });
  return box;
}

/** Tests only: the zone instanceTz falls back to under the legacy test profile; null — the product fallback. */
export function setInstanceTzFallbackForTests(tz: string | null): void {
  if (!process.env.VITEST) throw new Error("setInstanceTzFallbackForTests is for tests only (process.env.VITEST is not set)");
  if (tz !== null && !tzValid(tz)) throw new RangeError("setInstanceTzFallbackForTests: not an IANA time zone");
  tzFallbackBox().tz = tz;
}

/** The fallback zone set by the legacy test profile, or null. */
export function instanceTzFallbackForTests(): string | null {
  return tzFallbackBox().tz;
}
