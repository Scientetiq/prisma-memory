// Skeleton of a text line as a reader sees it (moved here from markers.ts unchanged, so the marker check and the
// instruction-line detector fold look-alike letters the same way). seen() — the marker skeleton: every space removed;
// spaced() — the detector skeleton: words kept apart by one space.

/**
 * Line breaks other than \n that a client or model may show as a new line. A line of record text is split by them into
 * «visible lines», each checked on its own: \"x\rEnd of data from memory\r…\" hid the marker inside one line.
 * The separator is in brackets: split keeps it in the output, no bytes are lost.
 */
export const BREAKS = /(\r\n|[\r\v\f\u0085\u2028\u2029])/;

/**
 * Classes of characters a reader takes for one another (the comparison runs in lower case, after NFKD): Latin, Cyrillic,
 * Greek and Armenian letters, small capitals, digits. Each class member folds to the first one, so Russian «end» with
 * Latin o and e, "End of data" with Cyrillic o and a, "INSTRUCTI0NS" with a zero and "EΝD" with a Greek capital Nu all give
 * the skeleton of the real marker. A class joins every letter one glyph can stand for: the Greek capital Ν is Latin N but
 * its small letter ν folds from it, η is a small n and its capital Η an H, υ is a u and its capital Υ a Y — so n and h are
 * one class, and u and y another (one Latin letter per character once let "EΝD OF DATA FROM MEMORY" pass).
 * A class wider than needed only escapes a few more lines that are not markers; a skeleton is only ever compared with the
 * skeletons of the four markers.
 */
export const CLASSES: readonly string[] = [
  "aаαɑᴀ",
  "cсςϲσᴄ",                // σ: NFKD turns the lunate capital Ϲ (a C) into Σ, lower case σ
  "dԁ",
  "дδ",
  "eеεᴇ",
  "iіӏιıɪɩl1",
  "иᴎ",
  "jј",
  "kкκᴋ",
  "mмμᴍ",
  "nhпнηνπһɴʜ",
  "oоο0օᴏ",
  "pрρᴘ",
  "qԛ",
  "rгᴦʀ",
  "sѕꜱ",
  "tтτᴛ",
  "uyуυγүʏᴜս",
  "wԝᴡ",
  "xхχ",
  "3з",
  "яᴙ",
];
export const FOLD: ReadonlyMap<string, string> = new Map(CLASSES.flatMap((c) => [...c].slice(1).map((ch): [string, string] => [ch, c[0]!])));

/**
 * A line as a reader will see it: compatibility forms plain (NFKD), lower case; invisible and
 * control characters (\p{C}: including U+200B, U+2060, U+FEFF, soft hyphen), diacritics (\p{M}), spaces of any kind
 * and "empty" filler letters removed; any dash is "-"; look-alikes are one Latin letter (FOLD).
 */
export const seen = (s: string): string => {
  const plain = s.normalize("NFKD").toLowerCase()
    .replace(/[\p{C}\p{M}\p{Z}\s\u115f\u1160\u2800\u3164\uffa0]/gu, "")
    .replace(/[\p{Pd}\u2212]/gu, "-");
  let out = "";
  for (const ch of plain) out += FOLD.get(ch) ?? ch;
  return out;
};

/** FOLD as a table of UTF-16 code units (every member of CLASSES is one code unit): one pass, no callback per letter. */
const FOLD_TABLE: Uint16Array = (() => {
  const t = new Uint16Array(65536);
  for (let i = 0; i < t.length; i++) t[i] = i;
  for (const [from, to] of FOLD) {
    if (from.length !== 1 || to.length !== 1) throw new TypeError(`skeleton: ${JSON.stringify(from)} is not one code unit`);
    t[from.charCodeAt(0)] = to.charCodeAt(0);
  }
  return t;
})();
const CHUNK = 4096;
/** The look-alike fold (FOLD) of spaced() and spacedApart(); instruction-lines.ts reads a part through it too. */
export function fold(s: string): string {
  let out = "";
  for (let at = 0; at < s.length; at += CHUNK) {
    const part = new Uint16Array(Math.min(CHUNK, s.length - at));
    for (let i = 0; i < part.length; i++) part[i] = FOLD_TABLE[s.charCodeAt(at + i)]!;
    out += String.fromCharCode(...part);
  }
  return out;
}

const SPACED_MAX = 4000;
/**
 * The detector's view of a line: the same NFKD, lower case and look-alike fold as seen(), but words stay apart —
 * format characters (zero-width, bidi controls, soft hyphen, tag characters) are removed so they cannot split a word, every
 * run of spaces of any kind (and the "empty" filler letters) becomes ONE space, other control characters and diacritics
 * are removed, any dash is "-", typographic apostrophes are "'". Cut to 4,000 code units (NFKD may expand a line); the
 * expansion is cut right after NFKD too, so a window of U+FDFA (18 code units each after NFKD) does not feed 36,000 code
 * units to the replacements. Every step but NFKD, lower case and fold only cuts, removes characters or writes a space, "-"
 * or "'", never a letter: the letter test of instruction-lines.ts relies on it, and so must spacedApart().
 */
export const spaced = (s: string): string => fold(s.normalize("NFKD").slice(0, SPACED_MAX + 400).toLowerCase()
  .replace(/\p{Cf}/gu, "")
  .replace(/[\p{Z}\s\u115f\u1160\u2800\u3164\uffa0]+/gu, " ")
  .replace(/[\p{C}\p{M}]/gu, "")
  .replace(/ {2,}/g, " ")
  .replace(/[\p{Pd}\u2212]/gu, "-")
  .replace(/[\u2018\u2019\u02bc\u2032`]/gu, "'")
  .slice(0, SPACED_MAX));

/** The second view of the instruction detector: the chain of spaced() written out once more with ONE difference — a control, private-use or unassigned character becomes a space instead of vanishing. For text that holds no such character and no unpaired surrogate both give the same string (pinned by a unit test); a change of spaced() must be made here too. */
export const spacedApart = (s: string): string => fold(s.normalize("NFKD").slice(0, SPACED_MAX + 400).toLowerCase()
  .replace(/\p{Cf}/gu, "")
  .replace(/[\p{Z}\s\u115f\u1160\u2800\u3164\uffa0]+/gu, " ")
  .replace(/[\p{Cc}\p{Co}\p{Cn}]/gu, " ")
  .replace(/[\p{Cs}\p{M}]/gu, "")
  .replace(/ {2,}/g, " ")
  .replace(/[\p{Pd}\u2212]/gu, "-")
  .replace(/[\u2018\u2019\u02bc\u2032`]/gu, "'")
  .slice(0, SPACED_MAX));
