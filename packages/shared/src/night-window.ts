import { instanceTz } from "./zoned-time.ts";

interface SettingsLike { get<T>(path: string, fallback: T): T }

export interface NightWindow { weekdays: string; weekends: string; tz: string; mode?: "window" | "off" }
/** A complete window (functions read w.tz directly); the stored setting has no tz since — see nightWindowOf. */
export const DEFAULT_WINDOW: NightWindow = { weekdays: "21:00-06:00", weekends: "20:00-09:00", tz: "UTC" };

/**
 * The night window of the installation — the one reader of processing.night_window: hours from
 * the value, the seed default and DEFAULT_WINDOW (the merge of Settings.get); tz — the stored one, else the instance zone
 * (locale.timezone). A window without tz follows the installation; read past this function it would run in UTC, the zone
 * of the constant. A tz that is missing, null, empty or not a string names no zone and is the instance zone too (the code
 * of earlier versions read such a window in its fallback zone). A non-empty tz that is not a zone is kept as it is (not
 * zoneFor): the window then stays broken the way the readers already handle it — a warning and the night work waits
 * (night-cap) — instead of silently moving to another zone.
 */
export function nightWindowOf(settings: SettingsLike): NightWindow {
  const stored = settings.get<unknown>("processing.night_window", { weekdays: "21:00-06:00", weekends: "20:00-09:00" });
  const w = stored && typeof stored === "object" && !Array.isArray(stored) ? stored as Partial<NightWindow> : {};
  return { ...DEFAULT_WINDOW, ...w, tz: typeof w.tz === "string" && w.tz !== "" ? w.tz : instanceTz(settings) };
}

const minutes = (hhmm: string): number => { const [h, m] = hhmm.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };

function local(at: Date, tz: string): { dow: number; min: number } {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (t: string) => p.find((x) => x.type === t)!.value;
  return { dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")), min: Number(get("hour")) * 60 + Number(get("minute")) };
}

function rule(w: NightWindow, dow: number): { start: number; end: number } {
  const [s, e] = (dow === 0 || dow === 6 ? w.weekends : w.weekdays).split("-");
  return { start: minutes(s!), end: minutes(e!) };
}

export function inWindow(w: NightWindow, at = new Date()): boolean {
  if (w.mode === "off") return true;
  const { dow, min } = local(at, w.tz), today = rule(w, dow), yesterday = rule(w, (dow + 6) % 7);
  if (today.start > today.end ? min >= today.start : min >= today.start && min < today.end) return true;
  return yesterday.start > yesterday.end && min < yesterday.end;
}

function offsetAt(t: number, tz: string): number {
  const base = Math.floor(t / 1000) * 1000;
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(base));
  const g = (k: string) => Number(p.find((x) => x.type === k)!.value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - base;
}

export function windowStartOf(w: NightWindow, at = new Date()): Date {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: w.tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const g = (k: string) => Number(p.find((x) => x.type === k)!.value);
  // Off removes the scheduling restriction, not the token guard. Its accounting period is the local calendar day.
  if (w.mode === "off") {
    const utc = Date.UTC(g("year"), g("month") - 1, g("day"));
    const t = utc - offsetAt(utc, w.tz);
    return new Date(utc - offsetAt(t, w.tz));
  }
  for (let k = 0; k <= 7; k++) {
    const day = new Date(Date.UTC(g("year"), g("month") - 1, g("day") - k));
    const utc = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 0, rule(w, day.getUTCDay()).start);
    let t = utc - offsetAt(utc, w.tz);
    t = utc - offsetAt(t, w.tz);
    if (t <= at.getTime()) return new Date(t);
  }
  return at;
}

export function nextWindowStart(w: NightWindow, at = new Date()): Date {
  if (inWindow(w, at)) return at;
  for (let step = 0; step < 8 * 24 * 60; step += 5) { const t = new Date(at.getTime() + step * 60_000); if (inWindow(w, t)) return t; }
  return at;
}

/** End of an accounting period: the next local day's start, including a DST offset change. */
export function windowEndOf(w: NightWindow, start: Date): Date {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: w.tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(start);
  const g = (k: string) => Number(p.find((x) => x.type === k)!.value);
  const day = new Date(Date.UTC(g("year"), g("month") - 1, g("day") + 1));
  const minute = w.mode === "off" ? 0 : rule(w, day.getUTCDay()).start;
  if (!Number.isInteger(minute) || minute < 0 || minute >= 24 * 60) throw new Error("invalid night accounting period");
  const utc = day.getTime() + minute * 60_000;
  const t = utc - offsetAt(utc, w.tz);
  return new Date(utc - offsetAt(t, w.tz));
}
