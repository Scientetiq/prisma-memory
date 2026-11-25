// Tested connector-secret spellings, longest first, within REDACTION_BUDGET per secret:
// raw/NFC/NFD; encodeURIComponent, strict RFC 3986, encodeURI, WHATWG query/special-query/path percent sets
// (including special-URL apostrophes, old/new caret handling and path backslashes); WHATWG, Python/Go, PHP,
// strict Appendix B form bytes (ASCII letters/digits literal, spaces '+' or '%20'). JSON string contents:
// ECMAScript short escapes, optional '\/', ASCII-only UTF-16 including DEL (Python ensure_ascii), HTML-safe
// <>& and U+2028/2029; .NET default fixtures: numeric escapes for "'&+<>`, DEL/non-ASCII and non-short C0,
// short escapes for backspace/tab/LF/FF/CR/backslash, uppercase numeric hex (lowercase spellings retained).
// Only encoder-introduced hex may mix case in text; a secret's own letters/escape-looking text stay exact.
// Each concrete upper/lower serializer spelling also becomes UTF-8 base64/base64url, padded/unpadded,
// whole or at all three offsets in longer base64 (including client_secret_basic). Each text/base64 form gets
// one further JSON/URI/form layer, without recursion. This enumerates fixtures, not arbitrary serializers.
// prepareRedactor refuses over-budget secrets (null); createRedactor then masks every text — the runner and the
// entity lookup take it, so a run with such a secret writes only constant refusals as diagnostics. Input bytes, individual patterns, distinct count and total regex-source bytes are bounded before
// compilation. Unexpected construction/replacement errors also fail closed. errorCode keeps codes, not messages.
// Known gaps: up to two base64 characters sharing secret/neighbour bits; mixed-case escapes BEFORE base64;
// deeper layers, arbitrary escaped/literal mixtures, further WHATWG trimming/control removal/path normalization,
// custom encoder allow-lists and malformed-UTF-16 replacement policies beyond the tested spellings;
// HTML entities (named/decimal/hex), wrapped/MIME base64, repr (\xXX, %uXXXX, util.inspect quoting);
// hex/base32, case-folded copies, base64 of non-UTF-8 bytes.
// Values shorter than four UTF-16 units are skipped; there is no entropy check. Common words/numbers may blank
// unrelated text, and an error code containing one becomes "internal". These are deliberate precision limits.
// Coverage applies only where this helper is called: connector_log event/field names, admin cursor/state display,
// gateway delivery logs and the test kit's separate redactor remain outside this repair's sink verification.
import { safeLogFields } from "./sdk/ctx.ts";
import type { LogFields } from "./sdk/types.ts";

export const REDACTED = "[secret]";
/** Shorter values are not searched for: they would redact ordinary words and prove nothing. */
const MIN_SECRET_CHARS = 4;

/** Per secret, counting distinct regex sources in UTF-8 after hex-case deduplication. Fixed resource limits, not settings. */
export const REDACTION_BUDGET = Object.freeze({
  secretBytes: 4096,
  patterns: 960,
  patternBytes: 256 * 1024,
  singlePatternBytes: 16 * 1024,
});
const failClosed = (_text: string): string => REDACTED;
/**
 * The longest text a redactor reads: its cost grows with the length of the text, so a
 * longer text is not scanned at all — the answer is REDACTED, which every caller reads as a change, so a refusal.
 */
export const REDACTION_INPUT_MAX = 64 * 1024;

const toUrlAlphabet = (b64: string): string => b64.replace(/\+/g, "-").replace(/\//g, "_");

/** Only hex letters introduced by an encoder may vary in case; literal secret characters never do. */
interface Form { text: string; hex: ReadonlySet<number> }
const literalForm = (text: string): Form => ({ text, hex: new Set() });
const regexLiteral = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Keep the established escape grammar; provenance decides which of its hex characters are flexible. */
function flexibleHex(form: Form): Set<number> {
  const out = new Set<number>();
  for (const match of form.text.matchAll(/\\u[\da-fA-F]{4}|%5[cC]u[\da-fA-F]{4}|%[\da-fA-F]{2}/g)) {
    for (let i = 0; i < match[0].length; i++) if (form.hex.has(match.index + i)) out.add(match.index + i);
  }
  return out;
}

function hexCasePattern(form: Form): string {
  let pattern = "", offset = 0;
  for (const i of flexibleHex(form)) {
    const c = form.text[i]!;
    pattern += regexLiteral(form.text.slice(offset, i)) + `[${c.toLowerCase()}${c.toUpperCase()}]`;
    offset = i + 1;
  }
  return pattern + regexLiteral(form.text.slice(offset));
}

function unique(forms: Iterable<Form>): Form[] {
  return [...new Map(Array.from(forms, (f) => [`${f.text}\0${[...f.hex].join(",")}`, f])).values()];
}

/** Serializers leave ASCII letters unchanged, so their existing provenance survives an outer layer. */
function encodeForm(form: Form, encode: (c: string) => string): Form {
  let text = "", offset = 0;
  const hex = new Set<number>();
  const cache = new Map<string, { text: string; hex: number[] }>();
  for (const c of form.text) {
    let part = cache.get(c);
    if (!part) {
      const encoded = encode(c), positions: number[] = [];
      if (encoded !== c) {
        for (const match of encoded.matchAll(/\\u[\da-fA-F]{4}|%[\da-fA-F]{2}/g)) {
          for (let i = 0; i < match[0].length; i++) {
            if (/[a-fA-F]/.test(match[0][i]!)) positions.push(match.index + i);
          }
        }
      }
      part = { text: encoded, hex: positions };
      cache.set(c, part);
    }
    const start = text.length;
    if (part.text === c) {
      for (let i = 0; i < c.length; i++) if (form.hex.has(offset + i)) hex.add(start + i);
    } else {
      for (const i of part.hex) hex.add(start + i);
    }
    text += part.text;
    offset += c.length;
  }
  return { text, hex };
}

function lowerHex(form: Form): Form {
  const hex = flexibleHex(form);
  return { text: form.text.split("").map((c, i) => hex.has(i) ? c.toLowerCase() : c).join(""), hex: form.hex };
}

function percentForms(s: Form): Form[] {
  const form = encodeForm(s, (c) => new URLSearchParams([["", c]]).toString().slice(1));
  const out: Form[] = [form];
  // Appendix B clients may escape every byte except ASCII letters/digits, including hyphen, dot and underscore.
  const strict = encodeForm(s, percentByte);
  // Space changes are applied to the original characters, never to literal percent triplets in a secret.
  out.push(strict, encodeForm(s, (c) => c === " " ? "+" : percentByte(c)));
  try {
    // Validate the whole value first: encodeURIComponent must still refuse lone surrogates.
    encodeURIComponent(s.text);
    const uri = encodeForm(s, encodeURIComponent);
    const rfc3986 = (c: string): string => /[!'()*]/.test(c)
      ? `%${c.charCodeAt(0).toString(16).toUpperCase()}` : encodeURIComponent(c);
    const python = (c: string): string => c === " " ? "+" : rfc3986(c);
    out.push(uri, encodeForm(s, rfc3986), encodeForm(s, python),
      encodeForm(s, (c) => c === "~" ? "%7E" : python(c)), encodeForm(s, encodeURI));
    // Older WHATWG implementations leave the caret literal in paths; current ones encode it.
    for (const set of ['"#<>', '"#<>\'', '"#<>?`{}', '"#<>?^`{}']) {
      const encode = (c: string): string => set.includes(c) ? `%${c.charCodeAt(0).toString(16).toUpperCase()}`
        : c <= " " || c > "~" ? encodeURIComponent(c) : c;
      out.push(encodeForm(s, encode));
      if (set.includes("?")) out.push(encodeForm(s, (c) => c === "\\" ? "/" : encode(c)));
    }
  } catch { /* a lone surrogate has no URI form; the form serializer replaces it with U+FFFD */ }
  // Both concrete spellings are needed before base64. Literal %ab or backslash-u text keeps its case.
  return unique(out.flatMap((f) => [f, lowerHex(f)]));
}

function percentByte(c: string): string {
  return Array.from(Buffer.from(c, "utf8"), (byte) =>
    (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122)
      ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join("");
}

function jsonForms(s: Form): Form[] {
  const out: Form[] = [];
  const jsonChar = (c: string): string => JSON.stringify(c).slice(1, -1);
  const json = encodeForm(s, jsonChar);
  for (const upper of [false, true]) {
    const escape = (c: string): string => c.split("").map((unit) => {
      const hex = unit.charCodeAt(0).toString(16).padStart(4, "0");
      return `\\u${upper ? hex.toUpperCase() : hex}`;
    }).join("");
    // PHP/Jackson leave DEL literal; Python ensure_ascii also escapes it, independently of punctuation.
    const ascii = encodeForm(json, (c) => c >= "\u0080" ? escape(c) : c);
    const asciiDel = encodeForm(json, (c) => c >= "\u007f" ? escape(c) : c);
    // JavaScriptEncoder.Default: BasicLatin, HTML-sensitive punctuation plus backtick and backslash.
    // Numeric escapes are uppercase in .NET; keep the earlier lowercase spelling as well.
    const numeric = (c: string): boolean => /["'&+<>`\u007f-\uffff]/.test(c);
    const legacyDotnet = encodeForm(s, (c) => numeric(c) ? escape(c) : jsonChar(c));
    const dotnet = encodeForm(s, (c) => numeric(c)
      || (c < " " && !"\b\t\n\f\r".includes(c)) ? escape(c) : jsonChar(c));
    for (const f of [json, ascii, asciiDel, legacyDotnet, dotnet]) {
      for (const html of [f, encodeForm(f, (c) => /[<>&\u2028\u2029]/.test(c) ? escape(c) : c)]) {
        out.push(html, encodeForm(html, (c) => c === "/" ? "\\/" : c));
      }
    }
  }
  return unique(out);
}

function* formsOf(secret: string): Generator<Form> {
  for (const text of new Set([secret, secret.normalize("NFC"), secret.normalize("NFD")])) {
    const s = literalForm(text), percent = percentForms(s), json = jsonForms(s);
    const forms = unique([s, ...percent, ...json]);
    // Encode concrete serializer bytes, percent/form first (OAuth Basic), then JSON, then the original value.
    // Generated base64 is never fed back into this loop; its characters are exact, not encoder hex.
    for (const text of new Set([...percent, ...json, s].map((f) => f.text))) {
      const bytes = Buffer.from(text, "utf8");
      const b64 = bytes.toString("base64"), b64u = bytes.toString("base64url");
      forms.push(...[b64, b64.replace(/=+$/, ""), b64u, `${b64u}${"=".repeat((4 - (b64u.length % 4)) % 4)}`].map(literalForm));
      // Only the 6-bit groups wholly inside the secret are independent of its neighbouring bytes.
      for (const k of [0, 1, 2]) {
        const enc = Buffer.concat([Buffer.alloc(k), bytes]).toString("base64");
        const inner = enc.slice(Math.ceil((8 * k) / 6), Math.floor((8 * (k + bytes.length)) / 6));
        forms.push(literalForm(inner), literalForm(toUrlAlphabet(inner)));
      }
    }
    // The same bounded expansion for text and base64, never recursive decoding or parsing of the logged text.
    for (const f of unique(forms)) {
      yield f;
      yield* jsonForms(f);
      yield* percentForms(f);
    }
  }
}

/**
 * Builds all matchers before a connector can run. Null means refusal (budget or construction error), never partial
 * coverage. The input and single-pattern guards also bound temporary serializer allocations and V8 regex size.
 */
export function prepareRedactor(secrets: Iterable<string | null | undefined>): ((text: string) => string) | null {
  try {
    const patterns = new Map<string, { form: string; matcher: RegExp | null }>();
    for (const secret of secrets) {
      if (typeof secret !== "string" || secret.length < MIN_SECRET_CHARS) continue;
      // Check length before UTF-8 conversion, normalization or any expansion of an untrusted configured value.
      if (secret.length > REDACTION_BUDGET.secretBytes || Buffer.byteLength(secret, "utf8") > REDACTION_BUDGET.secretBytes) return null;
      const own = new Set<string>();
      let bytes = 0;
      // Consume lazily: stop at the first over-budget form, before generating the rest of the expansion.
      for (const form of formsOf(secret)) {
        if (form.text.length < MIN_SECRET_CHARS) continue;
        if (form.text.length > REDACTION_BUDGET.singlePatternBytes) return null;
        const pattern = hexCasePattern(form);
        if (own.has(pattern)) continue;
        const size = Buffer.byteLength(pattern, "utf8");
        if (size > REDACTION_BUDGET.singlePatternBytes || own.size >= REDACTION_BUDGET.patterns
          || bytes + size > REDACTION_BUDGET.patternBytes) return null;
        own.add(pattern);
        bytes += size;
        if (!patterns.has(pattern)) patterns.set(pattern, { form: form.text, matcher: pattern === regexLiteral(form.text) ? null : new RegExp(pattern, "g") });
      }
    }
    const ordered = [...patterns.values()].sort((a, b) => b.form.length - a.form.length);
    const replace = (text: string): string => {
      for (const { form, matcher } of ordered) {
        if (matcher) text = text.replace(matcher, REDACTED);
        else if (text.includes(form)) text = text.split(form).join(REDACTED);
      }
      return text;
    };
    return (text) => {
      if (typeof text !== "string") return text;
      if (text.length > REDACTION_INPUT_MAX) return REDACTED;
      try {
        let t = replace(text);
        // Find a decomposed secret inside composed text (or the other way round) in the NFC form.
        const n = t.normalize("NFC");
        if (n !== t) {
          const m = replace(n);
          if (m !== n) t = m;
        }
        return t;
      } catch { return REDACTED; }
    };
  } catch { return null; }
}

/** Replaces the listed forms; null, undefined and short secrets are skipped. Refused preparation masks every line. */
export function createRedactor(secrets: Iterable<string | null | undefined>): (text: string) => string {
  return prepareRedactor(secrets) ?? failClosed;
}

/** Log fields with secrets redacted first, then reduced to what a log line accepts (scalars, short single-line strings). */
export function redactFields(redact: (text: string) => string, fields: LogFields | undefined): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields ?? {})) out[k] = typeof v === "string" ? redact(v) : v;
  return safeLogFields(out);
}

const OWN_CODE = /^[a-z][a-z0-9_:]{0,63}$/;

/**
 * The code to store and log for an error: the code of an egress or secret error, or an own string `code` of the form
 * of a code (for example the state error of the test kit); anything else is "internal". Node's error codes (ECONNRESET)
 * and PostgreSQL's (42501) are not codes of this kind. With a redactor, a code that contains a secret is "internal".
 */
export function errorCode(e: unknown, redact?: (text: string) => string): string {
  if (e === null || typeof e !== "object" || !Object.hasOwn(e, "code")) return "internal";
  const code = (e as { code?: unknown }).code;
  if (typeof code !== "string" || !OWN_CODE.test(code)) return "internal";
  if (redact && redact(code) !== code) return "internal";
  return code;
}
