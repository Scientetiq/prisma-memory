import { param, type SearchParams } from "./paging";
import type { ReadRange, TocEntry } from "./types";

const T_MAX = 360_000, PAGE_MAX = 100_000, OFFSET_MAX = 100_000_000;
const ANCHOR = /^[\p{L}\p{N}-]{1,100}$/u;

const int = (s: string, max: number, min = 0): number | null => (/^\d{1,9}$/.test(s) && Number(s) >= min && Number(s) <= max ? Number(s) : null);

export function parseRecordRange(sp: SearchParams): ReadRange | null {
  const r: ReadRange = {};
  const t = int(param(sp, "t"), T_MAX), part = param(sp, "part").toLowerCase(), page = int(param(sp, "page"), PAGE_MAX, 1),
        pto = int(param(sp, "pto"), PAGE_MAX, 1), o = int(param(sp, "o"), OFFSET_MAX);
  if (t !== null) r.time_from = t;
  else if (part && ANCHOR.test(part)) r.anchor = part;
  else if (page !== null) { r.page_from = page; if (pto !== null && pto >= page) r.page_to = pto; }
  if (o !== null) r.offset = o;
  return Object.keys(r).length ? r : null;
}

export function rangeHref(id: string, r: ReadRange | null | undefined, hash?: string): string {
  const u = new URLSearchParams();
  if (typeof r?.time_from === "number") u.set("t", String(Math.max(0, Math.floor(r.time_from))));
  else if (r?.anchor) u.set("part", r.anchor);
  else if (typeof r?.page_from === "number") { u.set("page", String(r.page_from)); if (typeof r.page_to === "number") u.set("pto", String(r.page_to)); }
  if (typeof r?.offset === "number") u.set("o", String(r.offset));
  const q = u.toString();
  return `/records/${id}${q ? `?${q}` : ""}${hash ? `#${hash}` : ""}`;
}

export function renderedIds(html: string): Set<string> {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&")));
}

export function tocHref(id: string, e: Pick<TocEntry, "anchor" | "time_from">, ids: ReadonlySet<string>): string {
  if (ids.has(e.anchor)) return `#${e.anchor}`;
  return typeof e.time_from === "number" ? rangeHref(id, { time_from: e.time_from }, e.anchor) : rangeHref(id, { anchor: e.anchor }, e.anchor);
}

const TIME_MARK = /^\s*\[(?:(\d{1,2}):)?(\d{1,3}):(\d{2})\]\s?/;

export function transcriptLines(content: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const l of content.split("\n")) {
    const m = TIME_MARK.exec(l);
    if (!m) continue;
    const sec = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    if (!out.has(sec)) out.set(sec, l.slice(m[0].length).trim());
  }
  return out;
}

export function firstWords(line: string | undefined, n = 8): string {
  if (!line) return "";
  const said = line.replace(/^[^:]{1,60}:\s+/, "");
  const words = said.split(/\s+/).filter(Boolean);
  return words.length > n ? `${words.slice(0, n).join(" ")}…` : words.join(" ");
}

export function nearestMark(sec: number, marks: Iterable<number>): number | null {
  let best: number | null = null, first: number | null = null;
  for (const s of marks) {
    if (first === null || s < first) first = s;
    if (s <= sec && (best === null || s > best)) best = s;
  }
  return best ?? first;
}

export function meetingTimeHref(meetingId: string, sec: number, shown?: { marks: ReadonlySet<number>; last: number | null; first: number | null } | null): string {
  if (shown && shown.first !== null && shown.last !== null && sec >= shown.first - 300 && sec <= shown.last) {
    const s = nearestMark(sec, shown.marks);
    if (s !== null) return `#t-${s}`;
  }
  return rangeHref(meetingId, { time_from: sec }, "transcript");
}
