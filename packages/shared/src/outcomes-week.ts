export interface WeekQuality {
  chains: number; people: number; zero: number; read1: number; read3: number; read10: number; no_read: number; reform_true: number;
  reform_known: number; wrote_after: number; first_rank_sum: number; first_rank_n: number; explicit: number; heuristic: number;
  corrected: number; outdated: number; useful: number; top10: number;
}

export const outcomesLockKeySql = (param: string): string => `hashtext('search_outcomes:' || ${param})`;

export const SLICE_DIMS = ["channel", "mode", "key_kind", "client_kind", "closed_seen"] as const;
export type SliceDim = typeof SLICE_DIMS[number];

export function weekStartOf(at: number, tz: string): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(new Date(at));
  const get = (t: string) => p.find((x) => x.type === t)!.value;
  const dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday"));
  const d = new Date(Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day"))));
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
export const addDays = (date: string, n: number): string => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export function zonedMidnight(date: string, tz: string): number {
  const utc = Date.parse(`${date}T00:00:00Z`);
  const off = (t: number) => {
    const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(t));
    const g = (k: string) => Number(p.find((x) => x.type === k)!.value);
    return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - t;
  };
  let t = utc - off(utc);
  t = utc - off(t);
  return t;
}

