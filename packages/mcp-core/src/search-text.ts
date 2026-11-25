// Text of the memory_search answer — shared by gateway and edge. Hit lines go in the data block.
import { asData } from "./markers.ts";
import type { McpTexts } from "./texts/index.ts";

/** A hit in the text: path, kind, date, origin, marks, title and snippet. */
export interface SearchHitView {
  path: string; type: string; event_kind?: string | null; occurred_at: string; origin: string; title: string; snippet: string;
  /** «confirmed» — when the record has no company knowledge review state. */
  confirmed?: boolean | null;
  /** Review state of the company knowledge space (key texts.search.orgReview) — instead of «confirmed». */
  org_review?: string | null;
  /** Written by an agent with extended access: a non-empty value — the «extended access» mark. */
  extended_write?: unknown;
  /**
   * Where in the record the hit is: pages, section path, anchor, time of a transcript — the structured hit's
   * `locator`. The hit line shows it with a ready `range` for memory_read; null or absent — the line as before.
   */
  locator?: HitLocator | null;
}

/** The locator of a hit as the search gives it (contract `$defs/Locator`): every field optional. */
export interface HitLocator { page?: unknown; page_to?: unknown; section?: unknown; anchor?: unknown; time_from?: unknown; time_to?: unknown }

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
/** A page number memory_read takes in `range`: a whole number from 1 (anything else — no page). */
const pageNum = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 1 ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
/** Seconds as hh:mm:ss (whole seconds). */
const clock = (sec: number): string => {
  const s = Math.floor(sec);
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, "0")).join(":");
};
/** Line breaks and other separators of a section title — spaces: one hit, one line (the title is record text). */
const oneLine = (s: string): string => s.replace(/[\r\n\u0085\u2028\u2029\t\v\f]+/g, " ").trim();
const cps = (s: string): number => [...s].length;

/**
 * At most this many characters of a section path shown after `§`, or of an anchor, in a hit line: a
 * heading is record text of any length (the chunker joins the headings as they are), and the line of every hit carries it.
 */
export const HIT_SECTION_MAX = 80;

/**
 * At most this many characters (of its JSON string) of a section path given as `range.section`.
 * The range carries the WHOLE path or nothing: a cut path is a different address — its last links may be the whole path of
 * a shallower section (memory_read takes the exact path first and silently reads that other section), or a repeated title
 * (memory_read asks to choose and the line no longer says which one is the hit), and the beginning of a long title can end
 * between a letter and its combining mark. A longer path shows its cut form after `§` and gets no range by section.
 */
export const HIT_SECTION_RANGE_MAX = 240;

/** The first `max` code points of `s`, never ending between a letter and its combining marks. */
function clip(s: string, max: number): string {
  const c = [...s];
  let n = max;
  while (n > 0 && /\p{M}/u.test(c[n] ?? "")) n--;
  return c.slice(0, n).join("").trimEnd();
}

/**
 * A section path for the hit line: `ref` — the whole path for `range.section` when it fits HIT_SECTION_RANGE_MAX, else null;
 * `shown` — the path cut to HIT_SECTION_MAX for `§` (the last links that fit; a single longer link — its beginning), with an
 * ellipsis where something was cut. The cut form is for the eye only: it never goes into a range.
 */
function sectionRef(path: string): { ref: string | null; shown: string } | null {
  const ref = cps(JSON.stringify(path)) - 2 <= HIT_SECTION_RANGE_MAX ? path : null;
  if (cps(path) <= HIT_SECTION_MAX) return { ref, shown: path };
  const links = path.split(">").map((x) => x.trim()).filter(Boolean);
  if (!links.length) return null;
  let tail = links[links.length - 1]!;
  if (cps(tail) > HIT_SECTION_MAX) return { ref, shown: `${clip(tail, HIT_SECTION_MAX)}…` };
  for (let i = links.length - 2; i >= 0; i--) {
    const next = `${links[i]} > ${tail}`;
    if (cps(next) > HIT_SECTION_MAX) break;
    tail = next;
  }
  return { ref, shown: `… > ${tail}` };
}

/**
 * The locator part of a hit line, starting with " · " — or empty when the hit has no locator. Pages ("p. 12–13"),
 * the section path (`§ "A > B"`), the time ("00:05:50–00:07:10") and the ready range of memory_read: pages first, then
 * time, then the anchor, then the section path (the same fields memory_read takes in `range`). The section is record text
 * and stays inside the data block with the rest of the hit.
 *
 * What the line guarantees:
 * - the range addresses the text of the hit's own record. A time range reads the time marks at the line starts of a
 *   transcript; any other record with a time (an event of a meeting keeps the time of its quote in the parent transcript)
 *   shows it as "in the source …" and gets no time range;
 * - the section title is printed as a JSON string, so a heading cannot add server marks (origin, confirmed, org) or a second
 *   range to the line; it is printed once: inside the range when the range is by section — the whole path, up to
 *   HIT_SECTION_RANGE_MAX — otherwise after `§`, cut to HIT_SECTION_MAX; a path too long for a range gets none;
 * - only values memory_read accepts: pages are whole numbers from 1, an end before the start is not printed.
 */
export function hitLocatorText(loc: HitLocator | null | undefined, texts: McpTexts, type?: string): string {
  if (!loc || typeof loc !== "object") return "";
  const page = pageNum(loc.page), pageTo0 = pageNum(loc.page_to), from = num(loc.time_from), to0 = num(loc.time_to);
  const pageTo = page !== null && pageTo0 !== null && pageTo0 > page ? pageTo0 : null;
  const to = from !== null && to0 !== null && to0 > from ? to0 : null;
  const s = str(loc.section), section = s === null ? null : sectionRef(oneLine(s));
  const a = str(loc.anchor), anchor = a === null || cps(oneLine(a)) > HIT_SECTION_MAX ? null : oneLine(a);
  const timed = from !== null && type === "transcript";
  const range: Record<string, unknown> | null = page !== null ? { page_from: page, ...(pageTo !== null ? { page_to: pageTo } : {}) }
    // whole seconds outward: the time marks of a transcript are whole seconds, a chunk's start may be a fraction
    : timed ? { time_from: Math.floor(from), ...(to0 !== null && to0 >= from ? { time_to: Math.ceil(to0) } : {}) }
    : anchor !== null ? { anchor }
    // Section lookup treats U+0085 as heading text. oneLine changes it to a space for display.
    : section?.ref && /[^>\s]/u.test(section.ref) && !s?.includes("\u0085") ? { section: section.ref }
    : null;
  const parts: string[] = [];
  if (page !== null) parts.push(texts.search.pages(page, pageTo));
  if (section !== null && !(range && "section" in range)) parts.push(`§ ${JSON.stringify(section.shown)}`);
  if (from !== null) {
    const time = `${clock(from)}${to !== null ? `–${clock(to)}` : ""}`;
    parts.push(timed ? time : texts.search.sourceTime(time));
  }
  if (range) parts.push(`range ${JSON.stringify(range)}`);
  return parts.length ? ` · ${parts.join(" · ")}` : "";
}

export interface SearchView<H extends SearchHitView = SearchHitView> {
  hits: readonly H[]; total_estimate: number; mode: string; current_space?: string | null; search_id: string; notes?: readonly string[] | null;
}

/**
 * Under the header, a line on how to read a hit; in each hit line, where the hit is in its record and a ready range
 * (hitLocatorText).
 * Header and hit lines. Each hit has marks: the review state of the company knowledge space, «extended access» and
 * the caller's tail (`hitTail`: gateway — agent's summary, source paths without titles; « · »-led or empty).
 * search_id is in the header, outside the data markers: many clients give the model only text, and «reading a hit,
 * pass search_id» (SKILL.md, instructions) cannot be kept without it.
 */
export function searchText<H extends SearchHitView>(view: SearchView<H>, o: { readonly texts: McpTexts; readonly hitTail?: (hit: H, index: number) => string;
  /** The key has memory_read (default true): without it the line on how to read a hit is not printed. */
  readonly canRead?: boolean }): string {
  const t = o.texts.search;
  // an unknown review state prints as before the catalogue: «org: undefined» (own keys only — not Object.prototype)
  const word = (s: string): string | undefined => Object.hasOwn(t.orgReview, s) ? t.orgReview[s] : undefined;
  const org = (h: H): string => h.org_review ? ` · org: ${word(h.org_review)}` : h.confirmed ? ` · ${t.confirmed}` : "";
  const lines = view.hits.map((h, i) => `${i + 1}. ${h.path} · ${h.type}${h.event_kind ? `/${h.event_kind}` : ""} · ${h.occurred_at.slice(0, 10)} · origin: ${h.origin}${org(h)}${h.extended_write ? ` · ${t.extended}` : ""}${hitLocatorText(h.locator, o.texts, h.type)}${o.hitTail?.(h, i) ?? ""}\n   ${h.title}\n   ${h.snippet}`);
  const head = t.header({ shown: view.hits.length, total: view.total_estimate, mode: view.mode, space: view.current_space || null, searchId: view.search_id,
                          notes: view.notes?.length ? view.notes.join("; ") : null });
  // how to read a hit — server words under the header, only when there is a hit to read and the key can read it
  return `${head}\n${view.hits.length && o.canRead !== false ? `${t.readHint(view.search_id)}\n` : ""}${asData(lines.join("\n") || t.nothing, o)}`;
}
