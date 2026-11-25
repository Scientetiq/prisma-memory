import { asData } from "./markers.ts";
import type { McpTexts } from "./texts/index.ts";

export interface ListEntryView { path: string; kind: "folder" | "record"; title: string; count?: number | null; summary_line?: string | null }

export interface ListView { path: string; readme: string | null; entries: readonly ListEntryView[]; next_cursor: string | null }

export const TYPE_ORDER: readonly string[] = ["document", "transcript", "event", "summary", "profile", "note"];
const typeRank = (t: string): number => { const i = TYPE_ORDER.indexOf(t); return i < 0 ? TYPE_ORDER.length : i; };

export const inTypeOrder = (counts: Iterable<readonly [string, number]>): Array<readonly [string, number]> =>
  [...counts].sort(([a], [b]) => typeRank(a) - typeRank(b) || (a < b ? -1 : a > b ? 1 : 0));

export const typeCountsLine = (counts: Iterable<readonly [string, number]>, texts: McpTexts): string =>
  texts.list.typeCounts([...counts].map(([t, n]) => `${t} — ${n}`).join(", "));

export const MONTH_UTC_SQL = "to_char(r.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM')";

export const monthsLine = (months: ReadonlyArray<{ ym: string; n: number }>, texts: McpTexts): string =>
  months.length ? texts.list.months(months.map((m) => `${m.ym} — ${m.n}`).join(", ")) : "";

export function spaceAbout(s: { readme?: string | null; description?: string | null; name: string }, on: boolean): string {
  if (!on) return s.readme ?? s.description ?? s.name;
  const parts = [s.description, s.readme].filter((x): x is string => typeof x === "string" && x.length > 0);
  return parts.length ? parts.join("\n") : s.name;
}

export const listEntryLine = (e: ListEntryView): string =>
  `${e.kind === "folder" ? "📁" : "•"} ${e.path} — ${e.title}${e.count != null ? ` (${e.count})` : ""}${e.summary_line ? ` — ${e.summary_line}` : ""}`;

export function listText(view: ListView, extras: readonly string[], texts: McpTexts): string {
  const tail = [view.next_cursor ? texts.list.more(view.next_cursor) : "", ...extras].filter(Boolean).join("\n");
  return `${view.path}\n${asData([view.readme, ...view.entries.map(listEntryLine)].filter(Boolean).join("\n"), { texts })}${tail ? `\n${tail}` : ""}`;
}
