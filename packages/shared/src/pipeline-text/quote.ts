import type { Segment } from "./transcript.ts";
import { SequenceMatcher, codePoints } from "./difflib.ts";
import { PY_WORD_CLASS, PY_WS_CLASS, casefold, pyLen, pyPrefix, pySplit, pyStrip } from "./pytext.ts";

const NON_ALNUM = new RegExp(`[^${PY_WORD_CLASS}]+`, "gu");
const WS_RUN = new RegExp(`[${PY_WS_CLASS}]+`, "g");
const MARKS = /\p{M}+/gu;

export function normalize(text: string | null | undefined): string {
  let t = casefold((text || "").normalize("NFKC")).replaceAll("\u0451", "\u0435");
  t = t.replace(MARKS, "");
  t = t.replace(NON_ALNUM, " ");
  return pyStrip(t.replace(WS_RUN, " "));
}

export class NormalizedTranscript {
  readonly segments: readonly Segment[];
  readonly words: string[] = [];
  readonly wordSeg: number[] = [];
  readonly text: string;
  readonly wordOffsets: number[] = [];

  constructor(segments: readonly Segment[]) {
    this.segments = segments;
    segments.forEach((seg, i) => {
      for (const w of pySplit(normalize(seg.text))) {
        this.words.push(w);
        this.wordSeg.push(i);
      }
    });
    this.text = this.words.join(" ");
    let pos = 0;
    for (const w of this.words) {
      this.wordOffsets.push(pos);
      pos += w.length + 1;
    }
  }

  wordIndexAt(charPos: number): number {
    let lo = 0;
    let hi = this.wordOffsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.wordOffsets[mid] as number) <= charPos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  timeRange(wFrom: number, wTo: number): [number | null, number | null] {
    if (!this.words.length) return [null, null];
    const last = Math.max(wFrom, Math.min(wTo - 1, this.words.length - 1));
    const s1 = this.segments[this.wordSeg[wFrom] as number] as Segment;
    const s2 = this.segments[this.wordSeg[last] as number] as Segment;
    return [s1.startSec, s2.endSec !== null ? s2.endSec : s2.startSec];
  }
}

export interface Match {
  kind: "exact" | "fuzzy";
  wordFrom: number;
  wordTo: number;
  ratio: number;
}

export interface QuoteBudget { readonly deadline: number; readonly now?: () => number; abandoned: number }
const BUDGET_CHECK_EVERY = 64;

export function findQuote(quote: string, nt: NormalizedTranscript, params: { readonly fuzzyThreshold: number; readonly budget?: QuoteBudget } = { fuzzyThreshold: 0.9 }): Match | null {
  const nq = normalize(quote);
  if (!nq || !nt.words.length) return null;
  let chosen = -1;
  let pos = nt.text.indexOf(nq);
  while (pos >= 0) {
    const end = pos + nq.length;
    if ((pos === 0 || nt.text[pos - 1] === " ") && (end === nt.text.length || nt.text[end] === " ")) {
      chosen = pos;
      break;
    }
    if (chosen < 0) chosen = pos;
    pos = nt.text.indexOf(nq, pos + 1);
  }
  if (chosen >= 0) {
    const w0 = nt.wordIndexAt(chosen);
    return { kind: "exact", wordFrom: w0, wordTo: w0 + pySplit(nq).length, ratio: 1.0 };
  }
  const qw = pySplit(nq);
  const n = qw.length;
  if (n < 3) return null;
  const budget = params.budget, clock = budget?.now ?? Date.now;
  const expired = (): boolean => { if (budget && clock() > budget.deadline) { budget.abandoned++; return true; } return false; };
  if (expired()) return null;
  const anchors = new Set(qw.slice(0, 3));
  let best: Match | null = null, compared = 0;
  for (let i = 0; i < nt.words.length; i++) {
    if (!anchors.has(nt.words[i] as string)) continue;
    for (const start of [i, i - 1, i - 2]) {
      if (start < 0) continue;
      for (const length of [n, n + 1, n - 1]) {
        if (length <= 0 || start + length > nt.words.length) continue;
        if (budget && ++compared % BUDGET_CHECK_EVERY === 0 && expired()) return null;
        const window = nt.words.slice(start, start + length);
        const ratio = new SequenceMatcher(qw, window, { autojunk: false }).ratio();
        if (ratio >= params.fuzzyThreshold && (best === null || ratio > best.ratio)) {
          best = { kind: "fuzzy", wordFrom: start, wordTo: start + length, ratio };
        }
      }
    }
  }
  return best;
}

function stems(text: string): Set<string> {
  return new Set(pySplit(normalize(text)).map((w) => (pyLen(w) > 4 ? pyPrefix(w, 4) : w)));
}

export function titleSimilar(a: string, b: string, threshold: number): boolean {
  const charRatio = new SequenceMatcher(codePoints(normalize(a)), codePoints(normalize(b)), { autojunk: false }).ratio();
  const sa = stems(a);
  const sb = stems(b);
  let common = 0;
  for (const s of sa) if (sb.has(s)) common++;
  const union = sa.size + sb.size - common;
  const jaccard = union ? common / union : 0.0;
  return Math.max(charRatio, jaccard) >= threshold;
}


export function quoteInText(text: string, quote: string, threshold = 0.9): Match | null {
  return findQuote(quote, new NormalizedTranscript([{ text, startSec: null, endSec: null, speaker: null }]), { fuzzyThreshold: threshold });
}
