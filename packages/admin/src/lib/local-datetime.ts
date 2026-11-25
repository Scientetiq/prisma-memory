// Date-and-time fields (input type="datetime-local": "When was it" of "Remember", "Failed after" of "Unprocessed") send a
// wall time without a zone: "2026-10-05T10:00". The panel server runs in UTC, so Date.parse read it as 10:00 UTC while
// LocalTime showed the person a shifted time. The time is read in the zone of the person's browser — "by your clock", as
// LocalTime shows it: ActionForm puts it into the hidden field client_tz. Without JavaScript (a plain POST) there is no
// zone, and the zone of the installation is used (instanceTz). The algorithm is a copy of zonedWallToInstant of
// packages/shared/src/zoned-time.ts (the panel image is built without packages/shared); a unit test
// checks they agree. Imports only the i18n layer of the panel, by relative path and without DOM types.
import { instanceTz } from "../i18n/runtime";
import { systemZone, zonedParts, zoneKnown } from "../i18n/format";

export const CLIENT_TZ_FIELD = "client_tz";

const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/;

const tzValid = (tz: string): boolean => Boolean(tz) && tz.length <= 64 && zoneKnown(tz);

/** The zone from the form if it is an IANA zone; otherwise the fallback (by default the zone of the installation). */
export const clientTz = (raw: unknown, fallback: string = instanceTz()): string => (typeof raw === "string" && tzValid(raw.trim()) ? raw.trim() : fallback);

function dayExists(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function offsetAt(t: number, tz: string): number {
  const base = Math.floor(t / 1000) * 1000;
  const p = zonedParts(new Date(base), tz);
  return Date.UTC(p.y, p.m - 1, p.d, Number(p.hh), Number(p.mm), Number(p.ss)) - base;
}

export function wallToInstant(wall: string, tz: string): number | null {
  const m = WALL.exec(wall);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? 0)) as [number, number, number, number, number, number];
  if (!dayExists(y, mo, d) || h > 23 || mi > 59 || s > 59) return null;
  const ms = Number((m[7] ?? "").padEnd(3, "0").slice(0, 3));
  const utc = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  let t = utc - offsetAt(utc, tz);
  t = utc - offsetAt(t, tz);
  return t;
}

export const formTz = (data: FormData): unknown => data.get(CLIENT_TZ_FIELD) || data.get("tz");

/** A datetime-local value → ISO moment; the zone is client_tz of the form (wrong or empty: the fallback, by default the installation's). */
export function wallToIso(value: string, tz?: unknown, fallback: string = instanceTz()): string | null {
  const t = wallToInstant(value.trim(), clientTz(tz, fallback));
  return t === null ? null : new Date(t).toISOString();
}

export function withClientTz(data: FormData, tz = systemZone()): FormData {
  if (tz) data.set(CLIENT_TZ_FIELD, tz);
  return data;
}
