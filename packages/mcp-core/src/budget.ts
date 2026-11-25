// Read budget in estimated real tokens. A model's tokenizer spends very different numbers of tokens on one character
// of English, Russian or Chinese text, so "4 characters = 1 token" let a default read of a Russian record return two to three
// times the tokens it promised. The estimate here is a weighted count of code points by script class; the weights are
// calibrated against real tokenizers (a test fixture: Anthropic count_tokens and OpenAI o200k_base, the
// larger count is the reference) so that the estimate lies between 0.95 and 1.30 of the reference for at least 90 % of the
// calibration documents. It deliberately errs on the high side: a part never costs the agent much more than it asked for.
// Not a tokenizer: model-specific and wrong for the next model anyway. `estimateTokens` of @memory/shared (chars / 4) is a
// different contract (the chunker's and records.token_count) and is not changed by this module.

/** Script classes of the estimate. */
export const TOKEN_CLASSES = ["latin", "digit", "space", "punct", "cyrillic", "alphabet", "cjk", "hangul", "other"] as const;
export type TokenClass = (typeof TOKEN_CLASSES)[number];

/**
 * Estimated tokens per code point of each class.
 * latin — letters of the Latin script; digit — decimal digits (current tokenizers split numbers into single digits); space —
 * whitespace; punct — ASCII and general punctuation and symbols; cyrillic — Cyrillic letters; alphabet — Greek, Hebrew and
 * Arabic letters; cjk — Han, kana, CJK punctuation and full-width forms; hangul — Hangul syllables and jamo; other —
 * everything else (emoji, combining marks, control characters, scripts without calibration data: counted high on purpose).
 * Calibrated on 44 documents (Russian, English, mixed Russian/English prose and code, Chinese, Japanese, Korean,
 * Greek, Arabic): estimate / reference between 0.97 and 1.23 for every document. Latin-script languages other than English
 * (German, Polish, Vietnamese…) had no calibration document: their letters get the English weight and may be counted low.
 */
export const TOKEN_WEIGHTS: Readonly<Record<TokenClass, number>> = Object.freeze({
  latin: 0.35, digit: 1.3, space: 0.3, punct: 0.8, cyrillic: 0.45, alphabet: 0.8, cjk: 1.1, hangul: 1.55, other: 1,
});

const UNITS_PER_TOKEN = 20;
const WEIGHT_UNITS = TOKEN_CLASSES.map((c) => Math.round(TOKEN_WEIGHTS[c] * UNITS_PER_TOKEN));
const LATIN = 0, DIGIT = 1, SPACE = 2, PUNCT = 3, CYRILLIC = 4, ALPHABET = 5, CJK = 6, HANGUL = 7, OTHER = 8;

/** Class index of one code point (fixed ranges: deterministic, fast, the same on the gateway and the edge). */
function classOf(cp: number): number {
  if (cp < 0x80) {
    if ((cp >= 0x61 && cp <= 0x7a) || (cp >= 0x41 && cp <= 0x5a)) return LATIN;
    if (cp >= 0x30 && cp <= 0x39) return DIGIT;
    if (cp === 0x20 || (cp >= 0x09 && cp <= 0x0d)) return SPACE;
    return cp < 0x20 || cp === 0x7f ? OTHER : PUNCT;
  }
  if (cp === 0xa0 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x2028 || cp === 0x2029 || cp === 0x202f || cp === 0x205f) return SPACE;
  if (cp === 0x3000) return SPACE;
  if (cp <= 0xbf) return PUNCT;                                            // Latin-1 punctuation and symbols: « » § ° ±
  if (cp <= 0x24f) return cp === 0xd7 || cp === 0xf7 ? PUNCT : LATIN;     // Latin-1 letters, Latin Extended-A/B
  if (cp >= 0x1e00 && cp <= 0x1eff) return LATIN;                         // Latin Extended Additional
  if (cp >= 0x400 && cp <= 0x52f) return CYRILLIC;                        // Cyrillic and its supplement
  if ((cp >= 0x1c80 && cp <= 0x1c8f) || (cp >= 0x2de0 && cp <= 0x2dff) || (cp >= 0xa640 && cp <= 0xa69f)) return CYRILLIC;
  if ((cp >= 0x370 && cp <= 0x3ff) || (cp >= 0x1f00 && cp <= 0x1fff)) return ALPHABET;              // Greek
  if ((cp >= 0x590 && cp <= 0x5ff) || (cp >= 0xfb1d && cp <= 0xfb4f)) return ALPHABET;              // Hebrew
  if ((cp >= 0x600 && cp <= 0x6ff) || (cp >= 0x750 && cp <= 0x77f) || (cp >= 0x8a0 && cp <= 0x8ff)
      || (cp >= 0xfb50 && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff)) return ALPHABET;          // Arabic
  if (cp >= 0x2010 && cp <= 0x2bff) return PUNCT;                         // general punctuation, currency, arrows, maths, boxes
  if ((cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x3130 && cp <= 0x318f) || (cp >= 0xa960 && cp <= 0xa97f)
      || (cp >= 0xac00 && cp <= 0xd7ff)) return HANGUL;
  if ((cp >= 0x2e80 && cp <= 0x2fdf) || (cp >= 0x3001 && cp <= 0x31ff) || (cp >= 0x3400 && cp <= 0x4dbf)
      || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f)
      || (cp >= 0xff00 && cp <= 0xffef) || (cp >= 0x20000 && cp <= 0x3ffff)) return CJK;
  return OTHER;
}

/** Rounded up; a sum a hair above a whole number from adding decimal weights is that whole number. */
const ceilTokens = (s: number): number => (s > 1e-9 ? Math.ceil(s - 1e-9) : 0);

/** Code points of `text` by class — what the calibration fixture records per document. */
export function tokenClassCounts(text: string): Record<TokenClass, number> {
  const n = TOKEN_CLASSES.map(() => 0);
  for (const ch of text) n[classOf(ch.codePointAt(0)!)]!++;
  return Object.fromEntries(TOKEN_CLASSES.map((c, i) => [c, n[i]!])) as Record<TokenClass, number>;
}

/** Estimated tokens of a weighted class count (rounded up). */
export function tokensOfCounts(counts: Readonly<Record<TokenClass, number>>): number {
  let units = 0;
  for (let i = 0; i < TOKEN_CLASSES.length; i++) units += (counts[TOKEN_CLASSES[i]!] ?? 0) * WEIGHT_UNITS[i]!;
  return ceilTokens(units / UNITS_PER_TOKEN);
}

/** Estimated real tokens of `text`. */
export function approxTokens(text: string): number {
  let units = 0;
  for (const ch of text) units += WEIGHT_UNITS[classOf(ch.codePointAt(0)!)]!;
  return ceilTokens(units / UNITS_PER_TOKEN);
}

/**
 * How many code points of `chars` (one string per code point), starting at `from`, fit into `maxTokens` estimated tokens.
 * At least one code point when any is left (a read always moves forward), never past the end.
 */
export function takeTokens(chars: readonly string[], from: number, maxTokens: number): number {
  let units = 0, i = from;
  const budgetUnits = (Math.max(0, maxTokens) + 1e-9) * UNITS_PER_TOKEN;
  while (i < chars.length) {
    const nextUnits = units + WEIGHT_UNITS[classOf(chars[i]!.codePointAt(0)!)]!;
    if (nextUnits > budgetUnits) break;
    units = nextUnits;
    i++;
  }
  return Math.max(i - from, Math.min(1, chars.length - from));
}
