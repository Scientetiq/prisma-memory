import { fmtNumber } from "@memory/i18n";
import { currentLocale, tr } from "@memory/i18n/context";
import { testHooksEnabled } from "./llm-state.ts";
import { M as UPLOAD_TEXTS } from "./messages/upload-limits.ts";
import { addDays, zonedMidnight } from "./outcomes-week.ts";

export const UPLOAD_DAILY_SETTING = "limits.upload_daily";
export const PER_MINUTE_SETTING = "limits.personal_per_minute";
export const DISK_GUARD_FAULT_SETTING = "processing.disk_guard_fault";

export const UPLOAD_DAILY_DEFAULT = { files: 2000, mib: 5120 } as const;
export interface UploadDaily { files: number; mib: number }
export const UPLOAD_DAILY_RANGES = { files: [1, 1_000_000], mib: [1, 10_485_760] } as const;
export const PER_MINUTE_RANGE = [1, 100_000] as const;
export const DISK_MIN_FREE_PERCENT = 10;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const intIn = (v: unknown, [min, max]: readonly [number, number]): boolean => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

export function uploadDailyProblems(merged: unknown): string[] {
  if (!isObj(merged)) return ["expected values for files and mib"];
  const p: string[] = [];
  if (Object.keys(merged).some((k) => k !== "files" && k !== "mib")) p.push("unexpected fields in the setting. Keep only files and mib");
  if (!intIn(merged.files, UPLOAD_DAILY_RANGES.files)) p.push("files per day must be an integer from 1 to 1 000 000");
  if (!intIn(merged.mib, UPLOAD_DAILY_RANGES.mib)) p.push("daily volume in MiB must be an integer from 1 to 10 485 760");
  return p;
}

export function uploadDailyOf(settings: { get<T>(path: string, fallback: T): T }): UploadDaily {
  const raw = settings.get<unknown>(UPLOAD_DAILY_SETTING, UPLOAD_DAILY_DEFAULT);
  const v = isObj(raw) ? raw : {};
  return {
    files: intIn(v.files, UPLOAD_DAILY_RANGES.files) ? v.files as number : UPLOAD_DAILY_DEFAULT.files,
    mib: intIn(v.mib, UPLOAD_DAILY_RANGES.mib) ? v.mib as number : UPLOAD_DAILY_DEFAULT.mib,
  };
}

export function perMinuteProblems(value: unknown): string[] {
  if (!isObj(value)) return ["expected rate limit buckets: name → count per minute"];
  const p: string[] = [];
  const bad = Object.entries(value).filter(([k, v]) => !/^[a-z][a-z0-9_]{0,63}$/.test(k) || !intIn(v, PER_MINUTE_RANGE)).map(([k]) => k);
  if (bad.length) p.push(`each bucket must be an integer from 1 to 100 000 per minute. A value of 0 would silently block everything (invalid: ${bad.slice(0, 5).join(", ")})`);
  return p;
}

export interface DiskGuardFault { free_percent?: number; unreadable?: boolean; path?: string }
const FAULT_KEYS = new Set(["free_percent", "unreadable", "path"]);

export function diskGuardFaultProblems(value: unknown, hooks = testHooksEnabled()): string[] {
  if (!isObj(value)) return ["expected a set of values"];
  if (!Object.keys(value).length) return [];
  const p: string[] = [];
  if (!hooks) p.push("low disk space can be simulated only on the test installation");
  if (Object.keys(value).some((k) => !FAULT_KEYS.has(k))) p.push("unexpected fields in the setting. Keep only free_percent, unreadable and path");
  const hasFree = value.free_percent !== undefined, hasUnreadable = value.unreadable !== undefined;
  if (hasFree === hasUnreadable) p.push("specify one: free_percent (percentage free) or unreadable: true (the path cannot be read)");
  if (hasFree && !(typeof value.free_percent === "number" && Number.isFinite(value.free_percent) && value.free_percent >= 0 && value.free_percent <= 100))
    p.push("free space must be a percentage from 0 to 100");
  if (hasUnreadable && value.unreadable !== true) p.push("unreadable must be true");
  if (value.path !== undefined && !(typeof value.path === "string" && value.path.startsWith("/") && value.path.length <= 512))
    p.push("path must be in MEMORY_DISK_GUARD_PATHS and start with “/”");
  return p;
}

export function parseDiskGuardFault(value: unknown): DiskGuardFault | null {
  if (!isObj(value) || !Object.keys(value).length || diskGuardFaultProblems(value, true).length) return null;
  return { ...(value.free_percent !== undefined ? { free_percent: value.free_percent as number } : {}), ...(value.unreadable === true ? { unreadable: true } : {}),
           ...(typeof value.path === "string" ? { path: value.path } : {}) };
}

export function diskGuardPaths(raw: string | undefined | null): string[] {
  return [...new Set((raw ?? "").split(/[:,\n]/).map((s) => s.trim()).filter((s) => s.length > 0))];
}

export const diskGuardPathValid = (path: string): boolean => path.startsWith("/");

export function uploadDay(at: number, tz: string): { day: string; resetSec: number } {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(at));
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  const day = `${g("year")}-${g("month")}-${g("day")}`;
  return { day, resetSec: Math.max(1, Math.ceil((zonedMidnight(addDays(day, 1), tz) - at) / 1000)) };
}

/** Refusal texts in plain words (messages/upload-limits.ts): a person sees them in the workspace and an agent retells them; in the locale of the answer. */
/** A volume in words: from 1 GiB in GiB with one decimal, below that in MiB. */
export const mibWords = (mib: number): string =>
  mib >= 1024 ? tr(UPLOAD_TEXTS.gib, { n: fmtNumber(currentLocale(), Math.round(mib / 102.4) / 10) }) : tr(UPLOAD_TEXTS.mib, { n: fmtNumber(currentLocale(), mib) });
export const UPLOAD_DAILY_REFUSAL = (limit: UploadDaily): string =>
  tr(UPLOAD_TEXTS.daily_refusal, { files: fmtNumber(currentLocale(), limit.files), volume: mibWords(limit.mib) });
export const DISK_LOW_REFUSAL = "Memory is almost full. Uploads are paused. Tell the memory administrator. Reading and search are still available";
