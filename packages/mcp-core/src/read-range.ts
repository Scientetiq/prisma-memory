// memory_read logic with no I/O: contents, range choice, a part up to the limit and its continuation — shared by the
// gateway and edge. No database — checked by the unit tests of this package and of the gateway: «follow next_range
// to null — all of it».
import { approxTokens, takeTokens } from "./budget.ts";
import { invalid, MemoryError, notFound } from "./errors.ts";
import type { McpTexts } from "./texts/index.ts";

/**
 * Transcript time mark — the same expression as TIME_MARK in @memory/shared (transcript-format.ts):
 * the package has no dependencies, hence a copy; the gateway's golden tests check it.
 */
export const TIME_MARK = /^\s*\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]/;

/**
 * Read range. `offset` — how many code points of the chosen range were already given; with no other fields — from the
 * record start. The continuation (`next_range`) — the same range and `offset` after the last one given; the agent
 * takes it as is (the old `{page_from: page + 1}` lost the tail of the cut page, and a transcript without
 * time marks was never read to the end). A section chosen by `section` continues by its `anchor` (anchors in a record
 * are unique — uniqueAnchor); outside the data markers the continuation line has no section at all — no title, no copy
 * of the heading as an anchor (continuationView).
 */
export interface Range { section?: string; anchor?: string; page_from?: number; page_to?: number; time_from?: number; time_to?: number; offset?: number }
export interface TocEntry { anchor: string; title: string; level: number; page: number | null; time_from: number | null; token_offset: number }
/**
 * A contents entry with its line number — to pick a section by the same pass that built the contents (fence-aware) — and
 * the full heading path by the chunker's rule (workers/src/pipeline/chunker.ts, parseBlocks: the stack drops headings
 * of a level not below the current, links joined by « > »): this is `locator.section` of a search hit.
 */
export interface TocLine extends TocEntry { line: number; path: string }

// time mark — one rule with the gateway and the pipeline (shared/transcript-format.ts): the gateway brings
// a transcript to [hh:mm:ss] at intake, [100:05] never occurs in stored text; hours are optional (events — [h:mm:ss])
export const PAGE = /^\s*<!--\s*page:\s*(\d+)\s*-->\s*$/;
const TS = TIME_MARK;
// anchor — from the title in NFC: in an NFD text from a Mac the mark U+0306/U+0308 is no letter, and the anchor of a
// title with such a letter split there; the same rule is in the workplace (admin/src/lib/markdown.ts), so old NFD
// records' anchors all match
const anchorOf = (title: string): string => title.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "section";
const WS = /\s/, LINE_BREAK = /[\n\r\u2028\u2029]/;
/**
 * Text lines: a line break is LF, CRLF or a lone CR. New records are stored with LF; old ones from a Mac may have
 * only CR — before, such a record had empty contents and reading a section found nothing.
 */
const splitLines = (text: string): string[] => text.split(/\r\n?|\n/);

/**
 * A markdown heading `# …` — a linear parse: the old `^(#{1,6})\s+(.*?)\s*#*\s*$` on a line «# a», thousands
 * of spaces and «b» tried variants for hours, and the gateway (one process) answered nobody. Same result as the regex:
 * level — 1–6 «#» then a whitespace character; heading — from the first non-space character to a tail of the form
 * «spaces, #, spaces»; a line break (\r, U+2028, U+2029) inside a heading — not a heading (the dot did not pass them).
 */
export function headingOf(line: string): { level: number; title: string } | null {
  let level = 0;
  while (level < line.length && line[level] === "#") level++;
  if (level < 1 || level > 6) return null;
  let i = level, j = line.length;
  while (i < j && WS.test(line[i]!)) i++;
  if (i === level) return null;
  while (j > i && WS.test(line[j - 1]!)) j--;
  while (j > i && line[j - 1] === "#") j--;
  while (j > i && WS.test(line[j - 1]!)) j--;
  const title = line.slice(i, j);
  return LINE_BREAK.test(title) ? null : { level, title };
}
export const lineTime = (l: string): number | null => { const m = TS.exec(l); return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null; };

/**
 * A heading anchor unique in the record: a repeat gets the suffix `-n`, a taken one (heading «Terms 2» gives `terms-2`)
 * is skipped up to a free one. Before, anchors coincided: `toc.find` took the first, and a section continuation
 * by `anchor` or a same-name anchor opened another's section. No collisions — anchors as before. By the same rule
 * the workplace sets heading ids (admin/src/lib/markdown.ts) — contents links lead to their own section.
 */
export function uniqueAnchor(base: string, seen: Map<string, number>, used: Set<string>): string {
  let n = seen.get(base) ?? 0, anchor: string;
  do { n++; anchor = n > 1 ? `${base}-${n}` : base; } while (used.has(anchor));
  seen.set(base, n);
  used.add(anchor);
  return anchor;
}

export function tocLines(text: string, type: string): TocLine[] {
  const toc: TocLine[] = [], lines = splitLines(text), stack: Array<[number, string]> = [];
  let page: number | null = null, chars = 0, nextMark = 0, fence = false;
  const seen = new Map<string, number>(), used = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\s*```/.test(l)) fence = !fence;
    const pm = PAGE.exec(l);
    if (pm) page = Number(pm[1]);
    if (type === "transcript") {
      const t = lineTime(l);
      if (t !== null && t >= nextMark) {
        const title = `[${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}]`;
        toc.push({ anchor: `t-${t}`, title, level: 1, page: null, time_from: t, token_offset: Math.ceil(chars / 4), line: i, path: title });
        nextMark = (Math.floor(t / 300) + 1) * 300;
      }
    } else if (!fence) {
      const h = headingOf(l);
      if (h) {
        const level = h.level, anchor = uniqueAnchor(anchorOf(h.title), seen, used);
        while (stack.length && stack[stack.length - 1]![0] >= level) stack.pop();
        stack.push([level, h.title.trim()]);
        toc.push({ anchor, title: h.title, level, page, time_from: null, token_offset: Math.ceil(chars / 4), line: i,
                   path: stack.map(([, t]) => t).join(" > ") });
      }
    }
    chars += [...l].length + 1;
  }
  return toc;
}

/** Contents: for a document — headings with their page (headings inside ``` do not count), for a transcript — marks every 5 minutes. */
export function buildToc(text: string, type: string): TocEntry[] {
  return tocLines(text, type).map(({ line: _l, path: _p, ...e }) => e);
}

/** Links of a section path to compare: « > » splits; case, extra spaces, Unicode form (NFC/NFD) do not matter. */
const links = (s: string): string[] => s.normalize("NFC").split(">").map((x) => x.trim().toLowerCase().replace(/\s+/g, " ")).filter(Boolean);
const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** How many same-named sections an error names; the agent finds the rest in toc. */
export const SECTION_CANDIDATES_MAX = 20;

/**
 * A section by `range.section`: before, only the last link «A > B» was compared via startsWith, and with
 * two «Terms» of different projects the agent silently got the first. Now by steps, each only with a single
 * match: (1) a path of several links — whole; (2) the end links of the path (one title — the exact title
 * of a section); (3) the same, but the last link as a title start («2.1» → «2.1 Terms», as before). Several at a
 * step — invalid_argument with a list of anchors: the agent picks, not document order.
 */
export function findSection(toc: readonly TocLine[], section: string, texts: McpTexts): TocLine {
  const want = links(section);
  if (!want.length) throw notFound();
  const n = want.length, head = want.slice(0, -1), last = want[n - 1]!;
  const tiers: Array<(p: string[]) => boolean> = [
    ...(n > 1 ? [(p: string[]) => same(p, want)] : []),
    (p) => p.length >= n && same(p.slice(p.length - n), want),
    (p) => p.length >= n && same(p.slice(p.length - n, -1), head) && p[p.length - 1]!.startsWith(last),
  ];
  for (const tier of tiers) {
    const hit = toc.filter((e) => tier(links(e.path)));
    if (hit.length === 1) return hit[0]!;
    if (hit.length > 1) {
      // no title repeated: a heading is record text, the message the error's first line outside the data markers;
      // section paths — in details.candidates and in the error text between markers (error-text.ts)
      throw new MemoryError("invalid_argument", texts.read.sectionsAmbiguous(hit.length), {
        hint: texts.read.sectionsAmbiguousHint,
        details: { candidates: hit.slice(0, SECTION_CANDIDATES_MAX).map((e) => ({ anchor: e.anchor, path: e.path, page: e.page })) },
      });
    }
  }
  throw notFound();
}

/**
 * Chosen lines of the record, their numbers in the full text (for the «further on» contents) and `range` — the fields
 * chosen by, for the continuation: by `section` — its `anchor` (same lines); fields the choice skipped are not
 * repeated. No section title in the continuation; the anchor copies the heading, so outside the data markers
 * it stays out (continuationView).
 */
interface Selection { lines: string[]; at: number[]; range: Range }

function selectRange(text: string, type: string, r: Range, texts: McpTexts): Selection {
  const lines = splitLines(text), out: Selection = { lines: [], at: [], range: {} };
  const take = (i: number) => { out.lines.push(lines[i]!); out.at.push(i); };
  if (r.page_from !== undefined || r.page_to !== undefined) {
    out.range = { ...(r.page_from !== undefined ? { page_from: r.page_from } : {}), ...(r.page_to !== undefined ? { page_to: r.page_to } : {}) };
    const from = r.page_from ?? 1, to = r.page_to ?? from;
    if (to < from) throw invalid(texts.read.pageOrder);
    let page = 1, seenMarker = false;
    for (let i = 0; i < lines.length; i++) { const m = PAGE.exec(lines[i]!); if (m) { page = Number(m[1]); seenMarker = true; } if (page >= from && page <= to) take(i); }
    if (!seenMarker && from > 1) throw notFound();
    return out;
  }
  if (r.time_from !== undefined || r.time_to !== undefined) {
    out.range = { ...(r.time_from !== undefined ? { time_from: r.time_from } : {}), ...(r.time_to !== undefined ? { time_to: r.time_to } : {}) };
    const from = r.time_from ?? 0, to = r.time_to ?? Number.POSITIVE_INFINITY;
    if (to < from) throw invalid(texts.read.timeOrder);
    let cur: number | null = null;
    for (let i = 0; i < lines.length; i++) { const t = lineTime(lines[i]!); if (t !== null) cur = t; if (cur !== null && cur >= from && cur <= to) take(i); }
    return out;
  }
  if (r.anchor || r.section) {
    // a section is cut by line numbers from the same pass that builds the contents: headings inside ``` do not move the anchors
    const toc = tocLines(text, type);
    // an anchor copied in NFD is the same anchor (anchors are in NFC)
    const anchor = r.anchor?.normalize("NFC");
    const start = anchor ? toc.find((e) => e.anchor === anchor) : findSection(toc, r.section ?? "", texts);
    if (!start) throw notFound();
    out.range = { anchor: start.anchor };
    const at = toc.indexOf(start);
    // transcript: anchor t-<sec> — the piece up to the next mark; document — up to the next heading of the same or a higher level
    const end = toc.slice(at + 1).find((e) => type === "transcript" || e.level <= start.level);
    for (let i = start.line; i < (end ? end.line : lines.length); i++) take(i);
    return out;
  }
  for (let i = 0; i < lines.length; i++) take(i);
  return out;
}

/**
 * Text of a range without `offset` (pages, time, section or anchor; an empty range — the whole record as is: so it is
 * given by readPart too). The chosen lines are joined with LF — an old record with CR or CRLF gives its section with LF.
 */
export function sliceRange(text: string, type: string, r: Range, texts: McpTexts): string {
  return Object.keys(r).length ? selectRange(text, type, r, texts).lines.join("\n") : text;
}

/**
 * A part of a record given by one memory_read: `start`–`end` — code points of the chosen range, `total` — its length,
 * `ranged` — a range was chosen (pages, time, section, anchor), not the whole text.
 * `left_tokens` — estimated tokens of the selected text after the part (0 when nothing is left).
 */
export interface ReadPart {
  content: string; truncated: boolean; next_range: Range | null; start: number; end: number; total: number; ranged: boolean; left_tokens: number;
  /** Contents sections after the cut inside the chosen range (only when truncated). */
  ahead: TocLine[];
}

/**
 * A part of a record up to the limit and the exact continuation. Cut at the last line break in the second half of the
 * limit, else exactly at the limit; the line break at the cut is given neither in this part nor in the next.
 * `budget` — how `maxTokens` is counted. `estimated`: estimated real tokens (budget.ts, weights by script class) —
 * what memory_read uses on the gateway and the edge: a Russian or Chinese part is shorter in characters than an English one
 * of the same budget. `chars` (the default, the older rule): 4 code points per token — kept for the callers whose
 * limit is a promise in characters (the custody page shows a text without a file up to the 2,000,000 characters of intake).
 * Offsets stay in code points either way, so a cut never falls inside a surrogate pair.
 * `truncated` ⇒ `next_range` is not null and moves on by at least a character: one can always read on, never loop.
 * `next_range` — the fields the range was chosen by (by `section` — its `anchor`), and `offset`.
 * `offset` past the end — an empty part, no continuation.
 */
export type ReadBudget = "estimated" | "chars";

export function readPart(full: string, type: string, range: Range | undefined, maxTokens: number, texts: McpTexts, budget: ReadBudget = "chars"): ReadPart {
  const { offset = 0, ...base } = range ?? {};
  if (!Number.isInteger(offset) || offset < 0) throw invalid(texts.read.badOffset);
  const sel = Object.keys(base).length ? selectRange(full, type, base, texts) : null;
  const chars = [...(sel ? sel.lines.join("\n") : full)], total = chars.length, ranged = sel !== null && Object.keys(sel.range).length > 0;
  if (offset >= total) return { content: "", truncated: false, next_range: null, start: total, end: total, total, ranged, left_tokens: 0, ahead: [] };
  const limit = budget === "estimated" ? takeTokens(chars, offset, maxTokens) : maxTokens * 4;   // chars: estimateTokens = ceil(code points / 4)
  if (total - offset <= limit) return { content: chars.slice(offset).join(""), truncated: false, next_range: null, start: offset, end: total, total, ranged, left_tokens: 0, ahead: [] };
  const cut = chars.slice(offset, offset + limit), nl = cut.lastIndexOf("\n");
  const breakAtNewline = nl > cut.length * 0.5;
  const kept = breakAtNewline ? cut.slice(0, nl) : cut;
  const end = offset + kept.length, next = end + (breakAtNewline ? 1 : 0);
  // the line of the chosen text where the continuation starts — and its number in the full text; line breaks count as
  // splitLines splits: CRLF — one, a lone CR — one too (a whole old record from a Mac)
  let lineSel = 0;
  for (let i = 0; i < next; i++) if (chars[i] === "\r" || (chars[i] === "\n" && chars[i - 1] !== "\r")) lineSel++;
  const fromLine = sel ? sel.at[lineSel] ?? Number.POSITIVE_INFINITY : lineSel;
  const lastLine = sel ? sel.at[sel.at.length - 1] ?? -1 : Number.POSITIVE_INFINITY;
  const inSel = sel ? new Set(sel.at) : null;
  const ahead = tocLines(full, type).filter((e) => e.line >= fromLine && e.line <= lastLine && (!inSel || inSel.has(e.line)));
  return { content: kept.join(""), truncated: true, next_range: { ...(sel?.range ?? {}), offset: next }, start: offset, end, total, ranged,
           left_tokens: approxTokens(chars.slice(next).join("")), ahead };
}

/** How many «further on» sections to show in the answer text; the full contents is in toc. */
export const AHEAD_TOC_MAX = 40;

/**
 * Continuation and contents in the answer TEXT: the memory:// resource and clients that give the model only text,
 * without structuredContent, saw no next_range or toc. `head` — the header line's tail, `next` — the continuation line
 * (server text outside the data markers), `toc` — up to AHEAD_TOC_MAX lines «anchor — path (p.)»: section titles from
 * the record, so they go in a data block of their own, `more` — how many are not shown.
 * The continuation line carries only what is not record text: id, range numbers, max_tokens, the request's search_id.
 * A section (`anchor` in next_range — by `section` or the agent's anchor) copies the heading (`terms-2`, `ignore-…`), and
 * it is not repeated outside the markers: a section continuation is «the same range as in the request, and offset N».
 * readPart picks by `section` + `offset` the same lines as by the anchor. Whole, pages and time — the JSON call, as is.
 */
export function continuationView(part: ReadPart, call: { id: string; search_id?: string; max_tokens?: number }, texts: McpTexts):
  { head: string; next: string; toc: string[]; more: number } | null {
  if (!part.truncated || !part.next_range) return null;
  const nr = part.next_range;
  const args = { id: call.id, range: nr, ...(call.max_tokens !== undefined ? { max_tokens: call.max_tokens } : {}), ...(call.search_id ? { search_id: call.search_id } : {}) };
  const t = texts.read;
  const how = nr.anchor !== undefined ? t.sameRange(JSON.stringify(call.id), nr.offset ?? 0) : `memory_read ${JSON.stringify(args)}`;
  return {
    head: t.truncated(part.start + 1, part.end, part.total, part.ranged, part.left_tokens),
    next: t.continuation(how),
    toc: part.ahead.slice(0, AHEAD_TOC_MAX).map((e) => `${e.anchor} — ${e.path}${e.page !== null ? ` (${t.page(e.page)})` : ""}`),
    more: Math.max(0, part.ahead.length - AHEAD_TOC_MAX),
  };
}
