import { readFileSync } from "node:fs";

import { CASEFOLD_RUNS, CASEFOLD_SINGLES, ND_ZEROS } from "./unicode-data.ts";

export const PY_WS_CLASS = "\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

export const PY_WORD_CLASS = "\\p{L}\\p{N}_";

export const PY_DIGIT_CLASS = ND_ZEROS.map((z) => `\\u{${z.toString(16)}}-\\u{${(z + 9).toString(16)}}`).join("");

function isPyWs(c: number): boolean {
  if (c <= 0x20) return (c >= 0x09 && c <= 0x0d) || c >= 0x1c;
  if (c < 0x85) return false;
  return (
    c === 0x85 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
    c === 0x202f || c === 0x205f || c === 0x3000
  );
}

function isPyLineBreak(c: number): boolean {
  return (c >= 0x0a && c <= 0x0d) || (c >= 0x1c && c <= 0x1e) || c === 0x85 || c === 0x2028 || c === 0x2029;
}

// ---------------------------------------------------------------- strip / split / splitlines

export function pyLstrip(s: string): string {
  let i = 0;
  while (i < s.length && isPyWs(s.charCodeAt(i))) i++;
  return i ? s.slice(i) : s;
}

export function pyRstrip(s: string): string {
  let j = s.length;
  while (j > 0 && isPyWs(s.charCodeAt(j - 1))) j--;
  return j < s.length ? s.slice(0, j) : s;
}

export function pyStrip(s: string): string {
  return pyLstrip(pyRstrip(s));
}

export function pyStripChars(s: string, chars: string): string {
  let i = 0;
  let j = s.length;
  while (i < j && chars.includes(s[i] as string)) i++;
  while (j > i && chars.includes(s[j - 1] as string)) j--;
  return s.slice(i, j);
}

export function pySplit(s: string): string[] {
  const out: string[] = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    while (i < n && isPyWs(s.charCodeAt(i))) i++;
    if (i >= n) break;
    let j = i;
    while (j < n && !isPyWs(s.charCodeAt(j))) j++;
    out.push(s.slice(i, j));
    i = j;
  }
  return out;
}

export function pySplitOnce(s: string, sep: string): [string] | [string, string] {
  const k = s.indexOf(sep);
  return k < 0 ? [s] : [s.slice(0, k), s.slice(k + sep.length)];
}

export function pySplitlines(s: string): string[] {
  const out: string[] = [];
  const n = s.length;
  let start = 0;
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (isPyLineBreak(c)) {
      out.push(s.slice(start, i));
      if (c === 0x0d && i + 1 < n && s.charCodeAt(i + 1) === 0x0a) i++;
      i++;
      start = i;
    } else {
      i++;
    }
  }
  if (start < n) out.push(s.slice(start));
  return out;
}

const HAS_SURROGATE = /[\ud800-\udfff]/;

export function pyLen(s: string): number {
  if (!HAS_SURROGATE.test(s)) return s.length;
  let n = 0;
  for (const _ of s) n++;
  return n;
}

export function pyPrefix(s: string, n: number): string {
  if (!HAS_SURROGATE.test(s)) return s.slice(0, n);
  return Array.from(s).slice(0, n).join("");
}

export function isWellFormed(s: string): boolean {
  return !/[\ud800-\udfff]/u.test(s);
}

export function cmpCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i) as number;
    const cb = b.codePointAt(j) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  return Math.sign(a.length - i - (b.length - j));
}

function digitValue(cp: number): number {
  let lo = 0;
  let hi = ND_ZEROS.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((ND_ZEROS[mid] as number) <= cp) lo = mid;
    else hi = mid - 1;
  }
  const v = cp - (ND_ZEROS[lo] as number);
  if (v < 0 || v > 9) throw new RangeError(`not a decimal digit: U+${cp.toString(16).toUpperCase()}`);
  return v;
}

export function pyInt(digits: string): number {
  if (/^[0-9]+$/.test(digits)) return Number(digits);
  let v = 0;
  for (const ch of digits) v = v * 10 + digitValue(ch.codePointAt(0) as number);
  return v;
}

export function pyDivmod(x: number, y: number): [number, number] {
  let mod = x % y;
  let div = (x - mod) / y;
  if (mod) {
    if (y < 0 !== mod < 0) {
      mod += y;
      div -= 1.0;
    }
  } else {
    mod = y < 0 || Object.is(y, -0) ? -0 : 0;
  }
  let floordiv: number;
  if (div) {
    floordiv = Math.floor(div);
    if (div - floordiv > 0.5) floordiv += 1.0;
  } else {
    floordiv = x / y < 0 || Object.is(x / y, -0) ? -0 : 0;
  }
  return [floordiv, mod];
}

// ---------------------------------------------------------------- casefold

const CASEFOLD_MAP: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [from, to, delta] of CASEFOLD_RUNS) {
    for (let cp = from; cp <= to; cp++) m.set(String.fromCodePoint(cp), String.fromCodePoint(cp + delta));
  }
  for (const [cp, folded] of CASEFOLD_SINGLES) m.set(String.fromCodePoint(cp), folded);
  return m;
})();

const CASEFOLD_TRIGGER = new RegExp(
  "[\\u03a3" +
    CASEFOLD_RUNS.map(([a, b]) => `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`).join("") +
    CASEFOLD_SINGLES.map(([cp]) => `\\u{${cp.toString(16)}}`).join("") +
    "]",
  "u",
);

export function casefold(s: string): string {
  if (!CASEFOLD_TRIGGER.test(s)) return s.toLowerCase();
  let out = "";
  for (const ch of s) out += CASEFOLD_MAP.get(ch) ?? ch.toLowerCase();
  return out;
}

export function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  switch (typeof v) {
    case "string":
      return v.length > 0;
    case "number":
      return v !== 0;
    case "boolean":
      return v;
    case "object":
      return Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0;
    default:
      return true;
  }
}

export function pyEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const ta = typeof a;
  const tb = typeof b;
  if ((ta === "number" || ta === "boolean") && (tb === "number" || tb === "boolean")) return Number(a) === Number(b);
  if (ta !== "object" || tb !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => pyEquals(x, b[i]));
  }
  const oa = a as Record<string, unknown>;
  const ob = b as Record<string, unknown>;
  const ka = Object.keys(oa);
  if (ka.length !== Object.keys(ob).length) return false;
  return ka.every((k) => Object.hasOwn(ob, k) && pyEquals(oa[k], ob[k]));
}

export function pyRepr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  const body = s.replace(/[\\\n\r\t'"]/g, (ch) => {
    if (ch === "\n") return "\\n";
    if (ch === "\r") return "\\r";
    if (ch === "\t") return "\\t";
    return ch === "\\" || ch === q ? "\\" + ch : ch;
  });
  return q + body + q;
}

export function pyReprList(items: readonly string[]): string {
  return "[" + items.map(pyRepr).join(", ") + "]";
}

const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function readTextUtf8(path: string): string {
  return UTF8_STRICT.decode(readFileSync(path)).replace(/\r\n?/g, "\n");
}

export function withDefaults<T extends object>(defaults: T, overrides: Partial<T>): T {
  const out = { ...defaults };
  for (const key of Object.keys(overrides) as Array<keyof T>) {
    const v = overrides[key];
    if (v !== undefined) out[key] = v as T[keyof T];
  }
  return out;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
