/**
 * Memory pipeline · chunker — a port of the reference Python implementation.
 *
 * Index unit = a unit of meaning with a token budget:
 *   • transcript — by turns and time blocks: turns are glued up to the target, a turn is never split
 *     (a long one — by sentences), overlap — the last turn of the previous fragment;
 *   • converter markdown — by structure: a heading opens a fragment, a table is atomic (or by rows with the header
 *     repeated), small neighbours merge, overlap — the last sentence of the previous fragment within a section;
 *   • a short record (event, note, profile, summary) — one fragment, if it fits.
 *
 * A fragment is never over `maximum`: a turn, paragraph, list and code are cut by sentences and words, a table — by
 * rows with the header repeated; an indivisible unit over the limit (word, URL, table row, heading) — by chars into
 * pieces with a small overlap; the pieces share locators (page, section, time, speaker).
 *
 * The reference decides: the port repeats its choices exactly, disputed places too, and is
 * checked by golden tests. Token counter: `str -> int` (`tokens.ts`).
 */
import { pipelineText } from "./verify.ts";
const {
  PY_DIGIT_CLASS, PY_WS_CLASS, pyInt, pyLstrip, pyRstrip, pySplit, pySplitOnce, pySplitlines, pyStrip, pyStripChars, withDefaults,
} = pipelineText.pytext;
import { heuristicTokens, type TokenCounter } from "./tokens.ts";

// ---------------------------------------------------------------- params and types

export interface ChunkParams {
  /** what we aim at */
  readonly target: number;
  /** hard limit (embedder limit — 512 with instruction and heading) */
  readonly maximum: number;
  /** shorter — join a neighbour */
  readonly minimum: number;
  /** overlap (turn / sentence) at most this long */
  readonly overlapMax: number;
}

export const DEFAULT_CHUNK_PARAMS: ChunkParams = Object.freeze({ target: 380, maximum: 480, minimum: 60, overlapMax: 120 });

/** Params, reference check: `0 < minimum <= target <= maximum`. */
export function chunkParams(overrides: Partial<ChunkParams> = {}): ChunkParams {
  const p = withDefaults(DEFAULT_CHUNK_PARAMS, overrides);
  if (!(0 < p.minimum && p.minimum <= p.target && p.target <= p.maximum)) {
    throw new RangeError("expected 0 < minimum <= target <= maximum");
  }
  return Object.freeze(p);
}

export type Segment = pipelineText.Segment;

export interface Chunk {
  ordinal: number;
  text: string;
  tokenCount: number;
  sectionPath: string | null;
  pageFrom: number | null;
  pageTo: number | null;
  timeFromSec: number | null;
  timeToSec: number | null;
  speakers: string[];
  /** tokens at the start — the overlap with the previous fragment */
  overlapTokens: number;
}

/** Fields of table `chunks` — column names. */
export interface ChunkRow {
  ordinal: number;
  text: string;
  token_count: number;
  section_path: string | null;
  page_from: number | null;
  page_to: number | null;
  time_from_sec: number | null;
  time_to_sec: number | null;
}

export function chunkAsRow(c: Chunk): ChunkRow {
  return {
    ordinal: c.ordinal, text: c.text, token_count: c.tokenCount,
    section_path: c.sectionPath, page_from: c.pageFrom, page_to: c.pageTo,
    time_from_sec: c.timeFromSec, time_to_sec: c.timeToSec,
  };
}

function newChunk(ordinal: number, text: string, tokenCount: number, rest: Partial<Chunk> = {}): Chunk {
  return {
    ordinal, text, tokenCount, sectionPath: null, pageFrom: null, pageTo: null, timeFromSec: null, timeToSec: null,
    speakers: [], overlapTokens: 0, ...rest,
  };
}

// ---------------------------------------------------------------- text splitting

// Char classes — as in the reference: sentence end `.!?…`, then spaces, then an optional `«"“([` and
// a capital Latin or Cyrillic letter (incl. Yo) or a digit. Python `\s` ≠ JS `\s`, so spaces are an explicit set.
const SENT_SPLIT = new RegExp(`(?<=[.!?\\u2026])[${PY_WS_CLASS}]+(?=[\\u00ab"\\u201c(\\[]?[A-Z0-9\\u0410-\\u042f\\u0401])`, "u");
const WS_RUN = new RegExp(`[${PY_WS_CLASS}]+`, "g");

/** Sentences: boundary = end mark + space + capital/digit/quote. Abbreviations are not cut. */
export function splitSentences(text: string): string[] {
  const t = pyStrip(text);
  if (!t) return [];
  return t.split(SENT_SPLIT).filter((s) => pyStrip(s));
}

/**
 * An indivisible unit (word, URL, table row) over the limit — by code points (like `str` slices of the reference):
 * a piece is the longest prefix of the rest for which `prefix + piece` fits in limit (counter monotone in prefix
 * length); the next piece starts with an overlap of an eighth of the previous one.
 * Search by index, no copy of the rest: the boundary is found by doubling the step from the piece start, then by binary
 * search in the window found. The old binary search over the whole rest glued up to half of it at each probe — on a
 * word of millions of chars — minutes of CPU. The counter is monotone: pieces as before (and as the reference).
 */
function cutByChars(text: string, limit: number, counter: TokenCounter, prefix = ""): string[] {
  const cps = Array.from(text);
  const pieces: string[] = [];
  let start = 0;
  const n = cps.length;
  const fits = (len: number): boolean => counter(prefix + cps.slice(start, start + len).join("")) <= limit;
  while (start < n) {
    const restLen = n - start;
    // answer window: lo — a sure valid bound (like lo = 1 of the old search), hi — the last length before a bad one
    let lo = 1;
    let step = 2;
    while (step <= restLen && fits(step)) {
      lo = step;
      step *= 2;
    }
    let hi = Math.min(step - 1, restLen);
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (fits(mid)) lo = mid;
      else hi = mid - 1;
    }
    pieces.push(cps.slice(start, start + lo).join(""));
    if (lo >= restLen) break;
    start += lo - (lo >> 3);
  }
  return pieces;
}

/**
 * Cuts text into pieces ≤ limit tokens: by sentences, if needed by words, a word over the limit — by chars.
 * Exported for the parts of a long transcript for the model (jobs/llm.ts splitParts): a turn longer than a part is cut
 * like a turn longer than an index fragment.
 */
export function splitToFit(text: string, limit: number, counter: TokenCounter): string[] {
  if (counter(text) <= limit) return [text];
  const pieces: string[] = [];
  let cur = "";
  let sentences = splitSentences(text);
  if (!sentences.length) sentences = [text];
  for (const sent of sentences) {
    if (counter(sent) > limit) { // one very long sentence — by words
      if (cur) {
        pieces.push(cur);
        cur = "";
      }
      let buf = "";
      for (const w of pySplit(sent)) {
        if (counter(w) > limit) { // indivisible word (URL, number, glued) — by chars with overlap
          if (buf) pieces.push(buf);
          const parts = cutByChars(w, limit, counter);
          pieces.push(...parts.slice(0, -1));
          buf = parts[parts.length - 1] as string;
          continue;
        }
        const cand = pyStrip(buf + " " + w);
        if (counter(cand) > limit && buf) {
          pieces.push(buf);
          buf = w;
        } else {
          buf = cand;
        }
      }
      if (buf) pieces.push(buf);
      continue;
    }
    const cand = pyStrip(cur + " " + sent);
    if (counter(cand) > limit && cur) {
      pieces.push(cur);
      cur = sent;
    } else {
      cur = cand;
    }
  }
  if (cur) pieces.push(cur);
  return pieces;
}

// ---------------------------------------------------------------- transcript

const D = PY_DIGIT_CLASS;
export const { parseTranscriptText } = pipelineText;

function segLine(seg: Segment): string {
  return seg.speaker ? `${seg.speaker}: ${pyStrip(seg.text)}` : pyStrip(seg.text);
}

type Piece = readonly [seg: Segment, line: string, tokens: number];

export function chunkTranscript(
  segments: Iterable<Segment>, counter: TokenCounter = heuristicTokens, params: ChunkParams = DEFAULT_CHUNK_PARAMS,
): Chunk[] {
  // 1) unfold: a turn longer than the maximum is cut by sentences, the time stays
  const pieces: Piece[] = [];
  for (const seg of segments) {
    if (!seg.text || !pyStrip(seg.text)) continue;
    const line = segLine(seg);
    const t = counter(line);
    if (t <= params.maximum) {
      pieces.push([seg, line, t]);
    } else {
      const prefix = seg.speaker ? `${seg.speaker}: ` : "";
      for (const part of splitToFit(pyStrip(seg.text), Math.max(1, params.maximum - counter(prefix) - 4), counter)) {
        const sub: Segment = { startSec: seg.startSec, endSec: seg.endSec, text: part, speaker: seg.speaker };
        const ln = segLine(sub);
        pieces.push([sub, ln, counter(ln)]);
      }
    }
  }

  // 2) glue up to the target; overlap — the last turn of the previous fragment
  const chunks: Chunk[] = [];
  let cur: Piece[] = [];
  let overlap: Piece | null = null; // overlap at cur start (part of cur)

  const ownTokens = (): number => cur.reduce((sum, p) => sum + p[2], 0) - (overlap ? overlap[2] : 0);

  /** Exact count over the glued text: separators and joins tokenize not as a sum of parts. */
  const joinedTokens = (extra: Piece): number => counter([...cur.map((p) => p[1]), extra[1]].join("\n"));

  const flush = (withOverlap = true): void => {
    if (!cur.length) return;
    const text = cur.map((p) => p[1]).join("\n");
    const speakers: string[] = [];
    for (const [sg] of cur) if (sg.speaker && !speakers.includes(sg.speaker)) speakers.push(sg.speaker);
    const first = cur[0] as Piece;
    const last = cur[cur.length - 1] as Piece;
    chunks.push(newChunk(chunks.length, text, counter(text), {
      timeFromSec: first[0].startSec, timeToSec: last[0].endSec, speakers, overlapTokens: overlap ? overlap[2] : 0,
    }));
    cur = [];
    overlap = null;
    if (withOverlap && last[2] <= params.overlapMax) {
      cur = [last];
      overlap = last;
    }
  };

  for (const piece of pieces) {
    if (cur.length && joinedTokens(piece) > params.target && ownTokens() >= params.minimum) flush();
    if (cur.length && joinedTokens(piece) > params.maximum) { // hard limit
      if (overlap && cur.length === 1) { // one overlap + turn do not fit — no overlap
        cur = [];
        overlap = null;
      } else {
        flush(false);
      }
    }
    cur.push(piece);
  }
  flush(false);

  mergeSmallTail(chunks, counter, params, "\n");
  return renumber(chunks);
}

// ---------------------------------------------------------------- markdown

const FRONT = new RegExp(`^---[${PY_WS_CLASS}]*\\n([\\s\\S]*?)\\n---[${PY_WS_CLASS}]*\\n`, "u");
const PAGE = new RegExp(`^[${PY_WS_CLASS}]*<!--[${PY_WS_CLASS}]*page:[${PY_WS_CLASS}]*([${D}]+)[${PY_WS_CLASS}]*-->[${PY_WS_CLASS}]*$`, "u");
const HEAD_PREFIX = new RegExp(`^(#{1,6})[${PY_WS_CLASS}]+`, "u");
const LIST = new RegExp(`^[${PY_WS_CLASS}]*(?:[-*+]|[${D}]+[.)])[${PY_WS_CLASS}]+`, "u");
const FENCE = new RegExp(`^[${PY_WS_CLASS}]*\`\`\``, "u");

/**
 * Heading `# …` — as `_heading` of the reference: prefix `#{1,6}` with Python whitespace — by a regex with no tail,
 * the tail «spaces, #, spaces» — by slices from the end. The earlier `^(#{1,6})\s+([^\n]*?)\s*#*\s*$` on a line «# a»,
 * thousands of spaces and «b» tried variants for hours, and the indexing queue stood. Same result: level, heading
 * (before pyStrip) or null; `\n` inside — not a heading, as with the old regex.
 */
export function headingOf(ln: string): { level: number; title: string } | null {
  const m = HEAD_PREFIX.exec(ln);
  if (!m) return null;
  let title = pyRstrip(ln.slice(m[0].length)), j = title.length;
  while (j > 0 && title[j - 1] === "#") j--;
  title = pyRstrip(title.slice(0, j));
  return title.includes("\n") ? null : { level: (m[1] as string).length, title };
}

/** Flat YAML header `--- … ---` at the text start: pairs and header length; `null` — no header. */
export function matchFrontMatter(text: string): { block: string; end: number } | null {
  const m = FRONT.exec(text);
  return m ? { block: m[1] as string, end: m[0].length } : null;
}

/** Strips the YAML header (flat `name: value`), returns [meta, body]. */
export function splitFrontMatter(md: string): [Record<string, string>, string] {
  const fm = matchFrontMatter(md);
  if (!fm) return [{}, md];
  const entries: Array<[string, string]> = [];
  for (const line of pySplitlines(fm.block)) {
    if (line.includes(":") && !line.startsWith(" ")) {
      const [k, v] = pySplitOnce(line, ":") as [string, string];
      entries.push([pyStrip(k), pyStripChars(pyStrip(v), "'\"")]);
    }
  }
  return [Object.fromEntries(entries), md.slice(fm.end)];
}

type BlockKind = "heading" | "paragraph" | "table" | "list" | "code";

interface Block {
  readonly kind: BlockKind;
  readonly text: string;
  readonly page: number | null;
  readonly section: string;
  /** for headings */
  readonly level: number;
}

function parseBlocks(body: string): Block[] {
  const lines = pySplitlines(body);
  const blocks: Block[] = [];
  const stack: Array<[number, string]> = [];
  let page: number | null = null;
  let i = 0;

  const section = (): string => stack.map(([, t]) => t).join(" > ");
  const line = (k: number): string => lines[k] as string;
  const isTableRow = (s: string): boolean => pyLstrip(s).startsWith("|");

  while (i < lines.length) {
    const ln = line(i);
    if (!pyStrip(ln)) {
      i++;
      continue;
    }
    const pm = PAGE.exec(ln);
    if (pm) {
      page = pyInt(pm[1] as string);
      i++;
      continue;
    }
    const hm = headingOf(ln);
    if (hm) {
      const level = hm.level;
      const title = pyStrip(hm.title);
      while (stack.length && (stack[stack.length - 1] as [number, string])[0] >= level) stack.pop();
      stack.push([level, title]);
      blocks.push({ kind: "heading", text: pyStrip(ln), page, section: section(), level });
      i++;
      continue;
    }
    if (FENCE.test(ln)) {
      let j = i + 1;
      while (j < lines.length && !FENCE.test(line(j))) j++;
      blocks.push({ kind: "code", text: lines.slice(i, j + 1).join("\n"), page, section: section(), level: 0 });
      i = j + 1;
      continue;
    }
    if (isTableRow(ln)) {
      let j = i;
      while (j < lines.length && isTableRow(line(j))) j++;
      blocks.push({ kind: "table", text: lines.slice(i, j).map(pyRstrip).join("\n"), page, section: section(), level: 0 });
      i = j;
      continue;
    }
    if (LIST.test(ln)) {
      let j = i;
      while (j < lines.length && (LIST.test(line(j)) || (line(j).startsWith("  ") && pyStrip(line(j))))) j++;
      blocks.push({ kind: "list", text: lines.slice(i, j).map(pyRstrip).join("\n"), page, section: section(), level: 0 });
      i = j;
      continue;
    }
    let j = i;
    while (
      j < lines.length && pyStrip(line(j)) && !PAGE.test(line(j)) && !headingOf(line(j)) && !FENCE.test(line(j)) &&
      !isTableRow(line(j)) && !LIST.test(line(j))
    ) j++;
    const text = lines.slice(i, j).map(pyStrip).join(" ").replace(WS_RUN, " ");
    blocks.push({ kind: "paragraph", text, page, section: section(), level: 0 });
    i = j;
  }
  return blocks;
}

/**
 * A table over the limit — by rows, header repeated (first two rows: heading and separator). A row that does
 * not fit even with one header is cut by chars with overlap, the header repeated before each piece; a header
 * leaving no room for a row is not repeated — the rows go as they are.
 */
function splitTable(text: string, limit: number, counter: TokenCounter): string[] {
  const rows = pySplitlines(text);
  const isSeparator = (row: string): boolean => Array.from(pyStrip(row.replaceAll("|", ""))).every((ch) => "-: ".includes(ch));
  let header = rows.length >= 2 && isSeparator(rows[1] as string) ? rows.slice(0, 2) : rows.slice(0, 1);
  if (counter(header.join("\n") + "\n") >= limit) header = [];
  const body = rows.slice(header.length);
  const pieces: string[] = [];
  let cur = [...header];
  const fits = (rows_: string[]): boolean => counter(rows_.join("\n")) <= limit;
  for (const r of body) {
    if (fits([...cur, r])) {
      cur.push(r);
      continue;
    }
    if (cur.length > header.length) {
      pieces.push(cur.join("\n"));
      cur = [...header];
      if (fits([...cur, r])) {
        cur.push(r);
        continue;
      }
    }
    const prefix = [...cur, ""].join("\n"); // header with a line feed (or empty)
    const parts = cutByChars(r, limit, counter, prefix);
    pieces.push(...parts.slice(0, -1).map((p) => prefix + p));
    cur.push(parts[parts.length - 1] as string);
  }
  if (cur.length > header.length || !pieces.length) pieces.push(cur.join("\n"));
  return pieces;
}

function splitBlock(b: Block, limitIn: number, counter: TokenCounter): string[] {
  const limit = Math.max(1, limitIn - 4); // margin for joins of pieces
  if (counter(b.text) <= limit) return [b.text];
  if (b.kind === "table") return splitTable(b.text, limit, counter);
  if (b.kind === "list" || b.kind === "code") {
    const pieces: string[] = [];
    let cur = "";
    for (const ln of pySplitlines(b.text)) {
      const cand = cur ? cur + "\n" + ln : ln;
      if (counter(cand) > limit && cur) {
        pieces.push(cur);
        cur = ln;
      } else {
        cur = cand;
      }
    }
    if (cur) pieces.push(cur);
    return pieces.some((p) => counter(p) > limit) ? pieces.flatMap((p) => splitToFit(p, limit, counter)) : pieces;
  }
  return splitToFit(b.text, limit, counter);
}

type MdPiece = readonly [text: string, tokens: number, block: Block];

export function chunkMarkdown(
  md: string, counter: TokenCounter = heuristicTokens, params: ChunkParams = DEFAULT_CHUNK_PARAMS,
): Chunk[] {
  const [, body] = splitFrontMatter(md);
  const blocks = parseBlocks(body);

  const chunks: Chunk[] = [];
  let cur: MdPiece[] = []; // (text, tokens, block)
  let overlap: MdPiece | null = null; // overlap at cur start (part of cur)

  const ownTokens = (): number => cur.reduce((sum, p) => sum + p[1], 0) - (overlap ? overlap[1] : 0);

  const joinedTokens = (extra?: string): number => {
    const parts = cur.map((p) => p[0]);
    if (extra) parts.push(extra);
    return counter(parts.join("\n\n"));
  };

  const flush = (): void => {
    if (!cur.length) return;
    const text = cur.map((p) => p[0]).join("\n\n");
    const pages = cur.map((p) => p[2].page).filter((p): p is number => p !== null);
    const firstBlock = (cur.find((p) => p[2].kind !== "heading") ?? (cur[0] as MdPiece))[2];
    chunks.push(newChunk(chunks.length, text, counter(text), {
      sectionPath: firstBlock.section || null,
      pageFrom: pages.length ? Math.min(...pages) : null,
      pageTo: pages.length ? Math.max(...pages) : null,
      overlapTokens: overlap ? overlap[1] : 0,
    }));
    cur = [];
    overlap = null;
  };

  /** Overlap in a section — the last sentence of the previous paragraph. */
  const startOverlap = (prev: MdPiece): void => {
    const [prevText, , prevBlock] = prev;
    if (prevBlock.kind !== "paragraph") return;
    const sents = splitSentences(prevText);
    const lastSent = sents[sents.length - 1] as string;
    const t = counter(lastSent);
    if (t <= params.overlapMax) {
      overlap = [lastSent, t, prevBlock];
      cur = [overlap];
    }
  };

  for (const b of blocks) {
    if (b.kind === "heading") {
      if (cur.length && ownTokens() >= params.minimum) {
        flush(); // a heading starts a new fragment
      } else if (cur.length && overlap) { // a tiny fragment merges with the new section — no overlap
        cur = cur.slice(1);
        overlap = null;
      }
      for (const piece of splitBlock(b, params.maximum, counter)) { // a heading over the maximum — by words and chars
        if (cur.length && joinedTokens(piece) > params.maximum) flush();
        cur.push([piece, counter(piece), b]);
      }
      continue;
    }
    // headings under the minimum are not closed alone: block pieces are cut leaving room for them;
    // headings from the minimum — a usual fragment, closed by target and maximum
    const reserve = cur.length && ownTokens() < params.minimum && cur.every((p) => p[2].kind === "heading") ? joinedTokens() + 2 : 0;
    for (const piece of splitBlock(b, Math.max(params.minimum, params.maximum - reserve), counter)) {
      const t = counter(piece);
      if (cur.length && joinedTokens(piece) > params.target && ownTokens() >= params.minimum) {
        const prev = cur[cur.length - 1] as MdPiece;
        flush();
        if (prev[2].section === b.section) startOverlap(prev);
      }
      if (cur.length && joinedTokens(piece) > params.maximum) { // hard limit
        if (overlap && cur.length === 1) {
          cur = [];
          overlap = null;
        } else {
          flush();
        }
      }
      cur.push([piece, t, b]);
    }
  }
  flush();

  mergeSmallTail(chunks, counter, params, "\n\n");
  return renumber(chunks);
}

// ---------------------------------------------------------------- short records, common

/** Event, note, profile, summary: one fragment if it fits; else — as markdown. */
export function chunkShort(
  text: string, counter: TokenCounter = heuristicTokens, params: ChunkParams = DEFAULT_CHUNK_PARAMS,
): Chunk[] {
  const t = pyStrip(text);
  const n = counter(t);
  if (n <= params.maximum) return [newChunk(0, t, n)];
  return chunkMarkdown(t, counter, params);
}

/** Context heading + text: the embedder gets this, `chunks.text` — only the text. */
export function embeddingInput(
  title: string, typeLabel: string, dateLabel: string, locatorLabel: string | null | undefined, text: string,
): string {
  const head = [title, typeLabel, dateLabel, locatorLabel].filter((x) => x).join(" · ");
  return `${head}\n${text}`;
}

/**
 * The last fragment under the minimum — glue to the previous by the fragment separator (turns — `\n`, markdown
 * blocks — `\n\n`), if it fits the maximum.
 */
function mergeSmallTail(chunks: Chunk[], counter: TokenCounter, params: ChunkParams, sep: string): void {
  if (chunks.length < 2) return;
  const prev = chunks[chunks.length - 2] as Chunk;
  const last = chunks[chunks.length - 1] as Chunk;
  if (last.tokenCount - last.overlapTokens >= params.minimum) return;
  let own = last.text;
  if (last.overlapTokens) { // drop the overlap — prev has it
    const parts = pySplitOnce(own, sep);
    own = parts.length === 2 ? parts[1] : "";
  }
  const merged = own ? pyStrip(prev.text + sep + own) : prev.text;
  if (counter(merged) <= params.maximum) {
    prev.text = merged;
    prev.tokenCount = counter(merged);
    prev.timeToSec = last.timeToSec !== null ? last.timeToSec : prev.timeToSec;
    if (last.pageTo !== null) prev.pageTo = Math.max(prev.pageTo || last.pageTo, last.pageTo);
    for (const s of last.speakers) if (!prev.speakers.includes(s)) prev.speakers.push(s);
    chunks.pop();
  }
}

function renumber(chunks: Chunk[]): Chunk[] {
  chunks.forEach((c, i) => {
    c.ordinal = i;
  });
  return chunks;
}
