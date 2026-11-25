/**
 * Port of `difflib.SequenceMatcher` (CPython 3.13): exactly the algorithm the reference verifier uses to compute
 * similarity: a greedy search for the longest common block, recursing to the left and right of it,
 * not LCS and not Levenshtein distance. This gives the same `ratio()` values down to the last bit.
 *
 * Sequence elements are strings (words or single code points). `isjunk` is not supported (the reference passes
 * `None`); `autojunk` works as in Python: when b has 200 or more elements, those occurring more often than 1% + 1
 * are excluded from the index. The reference calls it with `autojunk=False`.
 */

export type MatchBlock = readonly [i: number, j: number, size: number];

export interface SequenceMatcherOptions {
  autojunk?: boolean;
}

export function codePoints(s: string): string[] {
  return Array.from(s);
}

export class SequenceMatcher {
  readonly a: readonly string[];
  readonly b: readonly string[];
  private readonly b2j = new Map<string, number[]>();
  private readonly popular = new Set<string>();
  private blocks: MatchBlock[] | null = null;

  constructor(a: readonly string[], b: readonly string[], options: SequenceMatcherOptions = {}) {
    this.a = a;
    this.b = b;
    this.chainB(options.autojunk ?? true);
  }

  private chainB(autojunk: boolean): void {
    const { b, b2j, popular } = this;
    for (let i = 0; i < b.length; i++) {
      const elt = b[i] as string;
      const indices = b2j.get(elt);
      if (indices) indices.push(i);
      else b2j.set(elt, [i]);
    }
    const n = b.length;
    if (autojunk && n >= 200) {
      const ntest = Math.floor(n / 100) + 1;
      for (const [elt, idxs] of b2j) if (idxs.length > ntest) popular.add(elt);
      for (const elt of popular) b2j.delete(elt);
    }
  }

  findLongestMatch(alo = 0, ahi: number = this.a.length, blo = 0, bhi: number = this.b.length): MatchBlock {
    const { a, b, b2j } = this;
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      const indices = b2j.get(a[i] as string);
      if (indices) {
        for (const j of indices) {
          if (j < blo) continue;
          if (j >= bhi) break;
          const k = (j2len.get(j - 1) ?? 0) + 1;
          newj2len.set(j, k);
          if (k > bestsize) {
            besti = i - k + 1;
            bestj = j - k + 1;
            bestsize = k;
          }
        }
      }
      j2len = newj2len;
    }
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti--;
      bestj--;
      bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) {
      bestsize++;
    }
    return [besti, bestj, bestsize];
  }

  getMatchingBlocks(): readonly MatchBlock[] {
    if (this.blocks) return this.blocks;
    const la = this.a.length;
    const lb = this.b.length;
    const queue: Array<[number, number, number, number]> = [[0, la, 0, lb]];
    const found: MatchBlock[] = [];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop() as [number, number, number, number];
      const x = this.findLongestMatch(alo, ahi, blo, bhi);
      const [i, j, k] = x;
      if (k) {
        found.push(x);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    found.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    let i1 = 0;
    let j1 = 0;
    let k1 = 0;
    const merged: MatchBlock[] = [];
    for (const [i2, j2, k2] of found) {
      if (i1 + k1 === i2 && j1 + k1 === j2) {
        k1 += k2;
      } else {
        if (k1) merged.push([i1, j1, k1]);
        i1 = i2;
        j1 = j2;
        k1 = k2;
      }
    }
    if (k1) merged.push([i1, j1, k1]);
    merged.push([la, lb, 0]);
    this.blocks = merged;
    return merged;
  }

  ratio(): number {
    let matches = 0;
    for (const block of this.getMatchingBlocks()) matches += block[2];
    const length = this.a.length + this.b.length;
    return length ? (2.0 * matches) / length : 1.0;
  }
}
