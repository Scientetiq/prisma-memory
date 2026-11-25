// Setting access.morning_note — the personal morning note by e-mail.
// The value carries numbers only: there is no option that adds titles or text, so an unknown field (such as "titles") is
// refused at save time, as access.org_review_digest refuses one.
import { tzValid } from "./zoned-time.ts";

export const MORNING_NOTE_SETTING = "access.morning_note";
const FIELDS = ["enabled", "time", "tz", "weekdays"] as const;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Problems of a value of access.morning_note at save time (settings.ts); an empty list — the value is fine. Other paths — none. */
export function morningNoteSettingProblems(path: string, value: unknown): string[] {
  if (path !== MORNING_NOTE_SETTING || value === null) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["an object {enabled, time, tz, weekdays}"];
  const o = value as Record<string, unknown>, out: string[] = [];
  const extra = Object.keys(o).filter((k) => !(FIELDS as readonly string[]).includes(k));
  if (extra.length) out.push(`unknown fields: ${extra.join(", ")}`);
  if ("enabled" in o && typeof o.enabled !== "boolean") out.push("enabled — true or false");
  if ("time" in o && !(typeof o.time === "string" && TIME_RE.test(o.time))) out.push("time — HH:MM from 00:00 to 23:59, for example 08:00");
  if ("tz" in o && o.tz !== null && !tzValid(o.tz)) out.push("tz — null (the time zone of the instance) or an IANA time zone, for example Europe/Berlin");
  if ("weekdays" in o) {
    const w = o.weekdays;
    const ok = Array.isArray(w) && w.every((d) => typeof d === "number" && Number.isInteger(d) && d >= 1 && d <= 7) && new Set(w).size === w.length;
    if (!ok) out.push("weekdays — a list of distinct whole numbers from 1 (Monday) to 7 (Sunday); an empty list sends nothing");
  }
  return out;
}
