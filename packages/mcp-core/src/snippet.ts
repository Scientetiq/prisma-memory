// Snippet of a chunk in a memory_search hit — shared by the gateway and the edge.

/** How the snippet window is placed: by match density (default) or at the earliest match (the earlier rule). */
export type SnippetWindow = "density" | "first";
export const SNIPPET_WINDOWS: readonly SnippetWindow[] = Object.freeze(["density", "first"]);

/** The window a value of the setting `search.snippet_window` asks for: "first" keeps the earlier one, anything else is "density". */
export function snippetWindowOf(value: unknown): SnippetWindow {
  return value === "first" ? "first" : "density";
}

export interface SnippetOptions {
  /**
   * Words to place the window by. The gateway passes the query words that are not stop words of the applied full-text
   * configurations; absent, the query itself is split into words (what the edge does). An empty list places the window
   * at the start of the text.
   */
  terms?: readonly string[];
  /**
   * Weight of a term, keyed by the lower-case term (e.g. its rarity); a term missing here, or a weight that is not a
   * finite number ≥ 0, weighs 1.
   */
  weights?: Readonly<Record<string, number>>;
  /**
   * "density" (default): the window with the largest sum of weights of distinct matched terms; "first": the window
   * around the earliest match (the older rule).
   */
  window?: SnippetWindow;
}

/** At most this many distinct terms place a window: a longer query keeps its first words. */
const MAX_TERMS = 64;
const WORD_SPLIT = /[^\p{L}\p{M}\p{N}-]+/u;
const FIRST_WORD_SPLIT = /[^\p{L}\p{N}-]+/u;
const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;

/** Query words of at least 3 characters, lower-case, hyphens kept (today's split of the query). */
function splitWords(s: string, first = false): string[] {
  return s.toLowerCase().split(first ? FIRST_WORD_SPLIT : WORD_SPLIT).filter((w) => w.length >= 3);
}

/**
 * The distinct words of a query as snippetOf takes them (at most MAX_TERMS): the gateway filters these by the stop
 * words of the applied full-text configurations and passes the rest back as `terms`.
 */
export function snippetWords(query: string | undefined): string[] {
  return [...new Set(splitWords(query ?? ""))].slice(0, MAX_TERMS);
}

/**
 * Snippet: the whitespace-collapsed text, cut to `tokens × 4` characters with "…" on each cut edge. Where the window
 * stands:
 * - "density" (default): every place where a term matches is marked — the term's stem (the word without its last two
 *   letters, at least 3) at the start of a word of the text. A hyphenated term that is absent as a whole is looked for by
 *   its parts (full-text search finds "Beta-Plus" by "plus" alone), each part only at the start of a
 *   word and with a stem of at least 4 characters ("alp" of "Alpha-Test" must not match inside
 *   another word). A term found nowhere at a word start (Chinese or Japanese text, a compound, an identifier) is looked
 *   for anywhere, as the earlier window did. The window holds the largest sum of weights of distinct matched terms (ties:
 *   the tighter group — up to the match by which every term of the window has appeared once —, then the earliest); the
 *   matched span stands a third of the window from its left edge (centred when it is long), the window starts at a word
 *   boundary and is moved left to fill up when it would run past the end. No match: the start of the text. The work is
 *   linear in the number of matches, which the text bounds.
 * - "first": the window starts a third of its length before the earliest match of any term (the older rule,
 *   byte for byte).
 */
export function snippetOf(text: string, query: string | undefined, tokens: number, opts: SnippetOptions = {}): string {
  const max = tokens * 4, flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  // distinct words: a word repeated in the query is one term (the earliest match over a set is the same for "first")
  const first = opts.window === "first";
  const words = [...new Set(opts.terms ? opts.terms.flatMap((t) => (typeof t === "string" ? splitWords(t, first) : [])) : splitWords(query ?? "", first))];
  let start = first ? firstStart(flat, words, max) : densityStart(flat, words.slice(0, MAX_TERMS), max, opts.weights);
  let end = start + max;
  if ((flat.codePointAt(start - 1) ?? 0) > 0xffff) start++;
  // Complete a split pair if the result fits the window's allowance for two ellipses.
  if ((flat.codePointAt(end - 1) ?? 0) > 0xffff) end += start === 0 || end + 1 === flat.length ? 1 : -1;
  return (start > 0 ? "…" : "") + flat.slice(start, end) + (end < flat.length ? "…" : "");
}

/** The older rule: a third of the window before the earliest match (substring of the stem; hyphen parts at a word start). */
function firstStart(flat: string, words: readonly string[], max: number): number {
  const lower = flat.toLowerCase();
  let at = -1;
  const take = (i: number) => { if (i >= 0 && (at < 0 || i < at)) at = i; };
  for (const w of words) {
    const i = lower.indexOf(w.slice(0, Math.max(3, w.length - 2)));
    if (i >= 0 || !w.includes("-")) { take(i); continue; }
    for (const p of w.split("-").filter((x) => x.length >= 3)) {
      // parts hold letters and digits only (the query was split on everything else): nothing to escape in the expression
      take(lower.search(new RegExp(`(?<![\\p{L}\\p{N}])${p.slice(0, Math.max(4, p.length - 2))}`, "u")));
    }
  }
  return at < 0 ? 0 : Math.max(0, at - Math.floor(max / 3));
}

/** A stem found nowhere at a word start is looked for inside words: at most this many places (bounded work). */
const MAX_INSIDE = 64;

/** Full lower case, with original UTF-16 positions when a character expands (İ becomes i plus a combining dot). */
function lowerWithOffsets(flat: string): { lower: string; offsets?: number[] } {
  const lower = flat.toLowerCase();
  if (lower.length === flat.length) return { lower };
  const offsets: number[] = [];
  let at = 0;
  for (const ch of flat) {
    for (let i = 0; i < ch.toLowerCase().length; i++) offsets.push(at);
    at += ch.length;
  }
  return { lower, offsets };
}

/** Whether the code point belongs to a word (ASCII without the expression: this runs for every character). */
function isWordChar(c: number): boolean {
  if (c < 128) return (c >= 48 && c <= 57) || (c >= 97 && c <= 122) || (c >= 65 && c <= 90);
  return WORD_CHAR.test(String.fromCodePoint(c));
}

/** Places of `stem` at the given starts of words of `lower`, as [start, end] pairs. */
function placesAtStarts(lower: string, starts: readonly number[], stem: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const i of starts) if (lower.startsWith(stem, i)) out.push([i, i + stem.length]);
  return out;
}

/** Places of `stem` anywhere in `lower`, not overlapping, at most MAX_INSIDE of them. */
function placesInside(lower: string, stem: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = lower.indexOf(stem); i >= 0 && out.length < MAX_INSIDE; i = lower.indexOf(stem, i + stem.length)) out.push([i, i + stem.length]);
  return out;
}

interface Hit { at: number; end: number; unit: number }

function densityStart(flat: string, words: readonly string[], max: number, weights: SnippetOptions["weights"]): number {
  if (!words.length) return 0;
  const { lower, offsets } = lowerWithOffsets(flat);
  // Places of each term. A hyphenated term absent as a whole is looked for by its parts; a term found nowhere at a word
  // start (text without word spacing — Chinese, Japanese, Thai —, a compound, an identifier) by its stem
  // anywhere, as the earlier window did. Terms with the same places (one stem) form one unit with the sum of their weights:
  // they are present in the same windows, and the work below grows with the places of the text, not with the terms.
  // Where a word may start: the start of the text and after every character that is not a letter, mark or digit.
  const starts: number[] = [0];
  for (let i = 0; i < lower.length;) {
    const c = lower.codePointAt(i)!;
    i += c > 0xffff ? 2 : 1;
    if (i < lower.length && !isWordChar(c)) starts.push(i);
  }
  const memo = new Map<string, Array<[number, number]>>();
  const places = (stem: string, inside: boolean) => {
    const key = (inside ? "i:" : "w:") + stem;
    let p = memo.get(key);
    if (!p) {
      p = inside ? placesInside(lower, stem) : placesAtStarts(lower, starts, stem);
      // Score and place the window in the original text, including a stem ending within an expanded character.
      if (offsets) p = p.map(([at, end]) => {
        const last = offsets[end - 1]!;
        return [offsets[at]!, last + (flat.codePointAt(last)! > 0xffff ? 2 : 1)];
      });
      memo.set(key, p);
    }
    return p;
  };
  const unitOf = new Map<string, number>(), unitWeight: number[] = [], hits: Hit[] = [];
  for (const w of words) {
    const stem = w.slice(0, Math.max(3, w.length - 2));
    let key = "w:" + stem, found = places(stem, false);
    if (!found.length && w.includes("-")) {
      const parts = w.split("-").flatMap((part) => {
        const chars = [...part];
        return chars.length >= 4 ? [chars.slice(0, Math.max(4, chars.length - 2)).join("")] : [];
      });
      key = "p:" + parts.join("-");
      found = parts.flatMap((p) => places(p, false));
    }
    if (!found.length) { key = "i:" + stem; found = places(stem, true); }
    if (!found.length) continue;
    const v = weights?.[w], weight = typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 1;
    let unit = unitOf.get(key);
    if (unit === undefined) {
      unitOf.set(key, (unit = unitWeight.length));
      unitWeight.push(0);
      for (const [at, end] of found) hits.push({ at, end, unit });
    }
    unitWeight[unit]! += weight;
  }
  if (!hits.length) return 0;
  hits.sort((a, b) => a.at - b.at || a.end - b.end || a.unit - b.unit);
  // the next match of the same unit, for every match (hits.length: none)
  const next = new Array<number>(hits.length), last = new Array<number>(unitWeight.length).fill(hits.length);
  for (let k = hits.length - 1; k >= 0; k--) { next[k] = last[hits[k]!.unit]!; last[hits[k]!.unit] = k; }
  // Sliding window over the matches, linear in their number: for each first match i, the matches [i, j) that end within
  // `max` characters of it. `score` is the sum of weights of the units present; `cover` is the match by which every unit
  // present has appeared once — the spread of the group is measured to it, so later repetitions of a word do not make a
  // window wider (a single-word query stands at the first mention of a chain). Ties: the tighter group, then the earliest.
  const count = new Array<number>(unitWeight.length).fill(0);
  let score = 0, cover = 0, j = 0, best = -1, bestI = 0, bestJ = 1, bestSpread = 0;
  const enter = (k: number) => { const u = hits[k]!.unit; if (count[u]!++ === 0) { score += unitWeight[u]!; cover = Math.max(cover, k); } };
  for (let i = 0; i < hits.length; i++) {
    while (j < hits.length && hits[j]!.end - hits[i]!.at <= max) enter(j++);
    if (j === i) enter(j++);                                 // a single match longer than the window still counts
    cover = Math.max(cover, i);
    const spread = hits[cover]!.at - hits[i]!.at;
    // weights may be fractions: sums that differ only by rounding are a tie
    const tol = 1e-9 * Math.max(1, Math.abs(best));
    if (score > best + tol || (Math.abs(score - best) <= tol && spread < bestSpread)) { best = score; bestI = i; bestJ = j; bestSpread = spread; }
    const u = hits[i]!.unit;
    if (--count[u]! === 0) score -= unitWeight[u]!;
    else cover = Math.max(cover, next[i]!);
  }
  const bestFrom = hits[bestI]!.at;
  let bestEnd = 0;
  for (let k = bestI; k < bestJ; k++) bestEnd = Math.max(bestEnd, hits[k]!.end);
  const lead = Math.min(Math.floor(max / 3), Math.max(0, Math.floor((max - (bestEnd - bestFrom)) / 2)));
  let start = Math.max(0, bestFrom - lead);
  if (start + max > flat.length) start = Math.max(0, flat.length - max);
  if (start > 0 && flat[start - 1] !== " ") {
    // mid-word: move to the next word, never past the matched span; when the span starts inside the same word (a part
    // after a hyphen), back to the start of that word if the span still fits, else the span's own start
    const sp = flat.indexOf(" ", start);
    if (sp >= 0 && sp < bestFrom) start = sp + 1;
    else { const back = flat.lastIndexOf(" ", start) + 1; start = bestEnd - back <= max ? back : bestFrom; }
  }
  return start;
}
