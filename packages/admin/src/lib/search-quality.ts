import { derived } from "../i18n/runtime";
import { formatShare } from "./format";
import { formatDecimal } from "../i18n/format";
import { dayMonth, plusDays } from "./plain";
import { searchQuality as m, SQ_TEXT, METRIC_WHAT } from "../messages/search-quality";
import type { SearchBuildState, SearchQualityWeek } from "./types";

export const fewerPeople = (n: number): string => m.fewerPeople(n);
export const fewerMembers = (n: number): string => m.fewerMembers(n);
export const peopleCount = (n: number): string => m.peopleCount(n);

export { SQ_TEXT } from "../messages/search-quality";

export const smallWeek = (minGroup: number): string => m.smallWeek(minGroup);
export const smallSessions = (minGroup: number): string => m.smallSessions(minGroup);
export const smallSpaces = (minGroup: number, spaces: number): string => m.smallSpaces(minGroup, spaces);
export const smallNote = (minGroup: number): string => m.smallNote(minGroup);
export const emptyNothing = (minGroup: number): string => m.emptyNothing(minGroup);
export const sliceHidden = (minGroup: number): string => m.sliceHidden(minGroup);
export const emptyQueriesLead = (minGroup: number): string => m.emptyQueriesLead(minGroup);
export const emptyQueriesTail = (hidden: number, minGroup: number): string => m.emptyQueriesTail(hidden, minGroup);
export const emptyQueriesNone = (minGroup: number): string => m.emptyQueriesNone(minGroup);

export function correctionsNote(w: Pick<SearchQualityWeek, "current" | "corrections_complete" | "week_end">): string | null {
  return w.current || w.corrections_complete ? null : m.corrections(dayMonth(plusDays(w.week_end, 7)));
}

export function buildStatus(enabled: boolean, lb: SearchBuildState | null, now = Date.now()): { tone: "ok" | "warn" | "off" | "none"; text: string; at?: string } {
  if (!enabled) return { tone: "off", text: SQ_TEXT.off };
  if (!lb) return { tone: "none", text: m.notBuilt };
  const behind = Math.max(lb.lag_sec, Math.max(0, (now - Date.parse(lb.at)) / 1000));
  if (behind > 3600) return { tone: "warn", text: m.behind(Math.floor(behind / 3600)) };
  return { tone: "ok", text: m.lastBuilt, at: lb.at };
}

export const share = (v: number | null | undefined): string => formatShare(v ?? null);
export const rank = (v: number | null | undefined): string => (v === null || v === undefined ? "—" : formatDecimal(v, 1));

export const numbersAppear = (minGroup: number): string => m.numbersAppear(minGroup);

export type ShareKey = "zero_share" | "read1_share" | "read3_share" | "no_read_share" | "reformulated_share" | "corrected_share" | "outdated_share" | "useful_share";

export const METRIC_DIRECTION = derived((): Record<ShareKey, { up: "good" | "bad"; what: string }> => ({
  zero_share: { up: "bad", what: METRIC_WHAT.zero_share },
  read1_share: { up: "good", what: METRIC_WHAT.read1_share },
  read3_share: { up: "good", what: METRIC_WHAT.read3_share },
  no_read_share: { up: "bad", what: METRIC_WHAT.no_read_share },
  reformulated_share: { up: "bad", what: METRIC_WHAT.reformulated_share },
  corrected_share: { up: "bad", what: METRIC_WHAT.corrected_share },
  outdated_share: { up: "bad", what: METRIC_WHAT.outdated_share },
  useful_share: { up: "good", what: METRIC_WHAT.useful_share },
}));

const SAME = 0.005;

export interface WeekDelta { arrow: "▲" | "▼"; tone: "good" | "bad"; title: string }

const hasNumbers = (w: SearchQualityWeek | null | undefined): w is SearchQualityWeek => !!w && !w.small;

export function weekDelta(cur: SearchQualityWeek | null | undefined, prev: SearchQualityWeek | null | undefined, key: ShareKey): WeekDelta | null {
  if (!hasNumbers(cur) || !hasNumbers(prev)) return null;
  const a = prev[key], b = cur[key];
  if (typeof a !== "number" || typeof b !== "number" || Math.abs(b - a) < SAME) return null;
  const up = b > a, dir = METRIC_DIRECTION[key];
  return { arrow: up ? "▲" : "▼", tone: (up ? dir.up : dir.up === "good" ? "bad" : "good"), title: m.previousWeek(share(a)) };
}

export function topChange(cur: SearchQualityWeek | null | undefined, prev: SearchQualityWeek | null | undefined, summary = false): string | null {
  if (!hasNumbers(cur) || !hasNumbers(prev)) return null;
  let best: { key: ShareKey; d: number } | null = null;
  for (const key of Object.keys(METRIC_DIRECTION) as ShareKey[]) {
    const a = prev[key], b = cur[key];
    if (typeof a !== "number" || typeof b !== "number") continue;
    const d = Math.abs(b - a);
    if (d >= SAME && (!best || d > best.d)) best = { key, d };
  }
  if (!best) return null;
  const a = prev[best.key] as number, b = cur[best.key] as number;
  return m.metricChange(best.key, b > a, share(a), share(b), summary);
}

export function previousWeek(weeks: readonly SearchQualityWeek[], cur: SearchQualityWeek | null | undefined): SearchQualityWeek | null {
  if (!cur) return null;
  const at = weeks.indexOf(cur);
  const prev = at >= 0 ? weeks[at + 1] : undefined;
  return prev && plusDays(prev.week_start, 7) === cur.week_start ? prev : null;
}

export const pooledLead = (weeks: number): string => m.pooledLead(weeks);
export { searchQuality as SEARCH_QUALITY_TEXT } from "../messages/search-quality";
