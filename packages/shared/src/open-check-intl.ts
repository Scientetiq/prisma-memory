// The rules follow the module's rule for speed (open-check.ts): every pattern starts with a literal, a word boundary or a
// bounded class and uses bounded repeats only; a `check` reads a bounded window around its match. What a check needs from
// the whole text (account numbers near a routing number) is found once per text and kept in `scratch`.
//
// The texts are normalized (open-check.ts): Unicode spaces are " ", dashes are "-", soft hyphens and zero-width characters
// are gone. Patterns are case-insensitive unless the rule says otherwise; a check that needs capital letters reads them from
// the text.
//
// Leaf module: a type import of open-check.ts and the check digits of open-check-intl-checksums.ts.
import type { OpenCheckRule } from "./open-check.ts";
import {
  abaOk, auTfnOk, brCpfOk, caSinOk, cnIdOk, dateOk, deSteuerIdOk, esDniOk, frNirOk, ibanLength, ibanOk, inAadhaarOk, inPanOk, itCfOk,
  jpMyNumberOk, krRrnOk, mrzTd3Ok, mxCurpOk, nlBsnOk, plPeselOk, sePersonnummerOk, sgNricOk, trTcknOk, ukNinoOk, usItinOk, usSsnOk, zaIdOk,
} from "./open-check-intl-checksums.ts";

const re = String.raw;
type Scratch = Record<string, unknown>;
const isAlnum = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);
/** The match at `i` is the last word of a snake_case key: "_" right before it, a letter or digit before that ("x_sin";
 * not "__SIN:__", which is emphasis). */
const inSnakeKey = (text: string, i: number): boolean => text[i - 1] === "_" && isAlnum(text[i - 2]);

/**
 * A pattern made case-insensitive by hand, for a rule compiled without the flag i (`caseSensitive`): each lowercase letter
 * outside an escape becomes [xX], a character class gets the capitals of its letters and ranges. The flag i with u folds the
 * case of every character it compares and makes a long alternation of words two to three times slower (measured for the names
 * of national_id; the shorter word lists of the other rules gain nothing). Not for a pattern with group names.
 */
export function ci(src: string): string {
  return src.replace(/\\p\{[^}]+\}|\\.|\[(?:\\.|[^\]\\])*\]|\p{Ll}/gu, (t) => {
    if (t[0] === "\\") return t;
    if (t[0] === "[") {
      return "[" + t.slice(1, -1).replace(/\\p\{[^}]+\}|\\.|(\p{Ll})-(\p{Ll})|\p{Ll}/gu, (x, a?: string, b?: string) =>
        x[0] === "\\" ? x : a && b ? `${a}-${b}${a.toUpperCase()}-${b.toUpperCase()}` : x + capital(x)) + "]";
    }
    return capital(t) ? `[${t}${capital(t)}]` : t;
  });
}
/** The capital of a lowercase letter that has a single-character one, otherwise "". */
function capital(c: string): string {
  const u = c.toUpperCase();
  return u !== c && u.length === 1 ? u : "";
}

/**
 * Sorted starts of every match of `rx` in the text, found once per search of the rule (`scratch`): a text with a million
 * routing numbers is searched for account numbers once, not once per routing number.
 */
function startsOf(scratch: Scratch, key: string, text: string, rx: RegExp): number[] {
  let list = scratch[key] as number[] | undefined;
  if (!list) {
    list = [];
    rx.lastIndex = 0;
    for (let m = rx.exec(text); m; m = rx.exec(text)) list.push(m.index);
    scratch[key] = list;
  }
  return list;
}

/** Is any start of the list within [from, to)? Binary search over the sorted list. */
function anyIn(list: readonly number[], from: number, to: number): boolean {
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < from) lo = mid + 1; else hi = mid;
  }
  return lo < list.length && list[lo] < to;
}

// Markup around a label or its value, accepted by every label of the pack wherever a mark may stand, so the label of a
// record written in Markdown or HTML reads as in plain text: emphasis and code marks ("**Phone:** …", "`dob`: …",
// "Phone: **030 …**"), a closing "_" of emphasis ("__DOB:__ …"; not a "_" before a letter or digit: "phone_count" and
// "phone_1234567" stay keys), a backslash of an escaped quote (JSON inside a JSON string: {\"dob\": \"…\"}), ";" of
// "key;value", and an HTML tag with up to 60 characters of attributes ("<b>Phone:</b> …", "<td>Phone</td><td>…") with a
// line break and indentation around it (a table row or a definition list over several lines: "<td>Phone</td>\n  <td>…"; the
// line breaks are read by the gap, see gap()). The older rules of core and ru read the same shapes through their own wide
// gaps. ASCII only.
const NOISE = re`[*\x60~\\;]|_(?![A-Za-z0-9])|<\/?[a-zA-Z][a-zA-Z0-9]{0,9}(?:[ \t][^<>\n]{0,60})?>`;

// ---------------------------------------------------------------- the gap between a label word and its value
// Every rule of the pack reads "label word, label items, value": "Phone (office): 030 …", "<td>DOB</td>\n  <td>1985-…".
// The gap is built here and nowhere else, by one rule: every character of a
// gap has exactly one reader. White space and line breaks are read only by GAP_WS, no item starts or ends with a space, a
// tab or a line break, and GAP_WS and each element (GAP_WS and one item) are atomic — the engine takes the first way and
// never tries another. So the items are an ordered choice (an item that is a prefix of another stands after it), and a
// label word costs at most GAP_ITEMS + 1 tries of its value, whatever the text after it: two neighbours that could both
// read the same indentation gave 4^8 ways per label word. Past a bound the gap does not match and the
// rule does not find; a new shape is a new item or a larger bound, never another optional token.
/** Spaces or tabs on one line, line breaks, indentation after a line break, items between a label word and its value. */
export const GAP_INLINE = 3, GAP_BREAKS = 2, GAP_INDENT = 40, GAP_ITEMS = 8;
const GAP_WS = re`[ \t]{0,${GAP_INLINE}}(?:\r?\n[ \t]{0,${GAP_INDENT}}){0,${GAP_BREAKS}}`;
let atoms = 0;
/** x matched once, atomically: a look ahead captures it, the back reference consumes exactly that. */
const atom = (x: string): string => { const n = `pmGap${atoms++}`; return re`(?=(?<${n}>${x}))\k<${n}>`; };
/** The item lists of the gaps, by gap (for the structure test: no item reads white space). */
export const INTL_GAP_ITEMS: Record<string, string> = {};
/** The gaps, by name (for the structure test). */
export const INTL_GAPS: Record<string, string> = {};
/**
 * The gap between a label word and its value over the items given (an ordered choice). `bar`: a table bar at the start of
 * the value's line ("| Phone |\n| 030 …", up to three bars and spaces) is read by the last token too, beyond the GAP_ITEMS
 * items — as the hand-made gaps of the labels that read the next line did; it stands once, at the end, inside the atomic
 * last token, so it adds at most one try of the value per count of items.
 */
function gap(name: string, items: string, bar = false): string {
  const last = bar ? re`${GAP_WS}(?:(?<=\n[ \t]{0,${GAP_INDENT}})\|[ \t|]{0,2})?` : GAP_WS;
  const g = re`(?:${atom(re`${atom(GAP_WS)}(?:${items})`)}){0,${GAP_ITEMS}}${atom(last)}`;
  INTL_GAP_ITEMS[name] = items;
  INTL_GAPS[name] = g;
  return g;
}

// ---------------------------------------------------------------- bank_account
// IBAN: two letters, two check digits, 11–30 characters of the account with single spaces anywhere (print form groups of
// four); the check takes exactly the country's length from the start and wants a boundary right after it, so a word that
// follows ("… 7034 Brussels") is not read as part of the number. Lowercase is accepted (the check digits decide). The match
// is the first check digit alone: it looks back at the country code (a pattern that starts with a letter is tried at every
// word of the text: four to ten times slower) and ahead at the body, and the check reads the body from the text. So the
// finding points at the check digits, and a refused candidate ("FY24 budget … DE89 3704 …": no country FY) does not swallow
// the IBAN that follows within its 30 characters — the search goes on from the next character.
// ABA routing number after "routing", "ABA", "RTN" (nine digits, checksum) — a finding only with an account number within
// 150 characters. UK sort code after "sort code" — only with an account number of 7–10 digits within 80 characters. BIC or
// SWIFT code after "BIC"/"SWIFT" — only with an account number within 150 characters: the code alone names a bank, not a
// person's account.
const ACCOUNT_WORDS = re`(?:account|acct|acc|a/c|konto|kontonummer|kontonr|compte|cuenta|conto)`;
// label words between a keyword and its number: "routing number is 021000021", "account no.: 123…", "ABA (RTN) #"; in
// structured text a key's quote, "_" of a snake_case key, the separator and the value's quote, ">" of an XML element:
// "routing_number": "021000021", <sortCode>12-34-56, routingNumber=021000021 (the case of a camelCase key is folded away),
// "]" of a bracketed form key: customer[routing_number]=021000021
const MARKS = re`[:=.#_"'“”‘’>\]-]`;
const LABEL = (name: string, words: string) => gap(name, re`\((?:aba|rtn)\)|${words}|is|n°|${MARKS}|${NOISE}`);
const NUM_LABEL = re`number|num|no\.?|nr\.?|code`;
// the word with "number" or "no" glued on is a camelCase or snake_case key (routingNumber, account_no)
const GLUED = re`(?:[_-]?(?:number|num|no|nr))?`;
const BANK_ACCOUNT = re`(?<iban>\d)(?<=(?<![\p{L}\p{N}])[a-z]{2}\d)(?=\d(?:[ ]?[a-z0-9]){11,30})`
  + re`|(?<![\p{L}])(?:routing|aba|rtn)${GLUED}(?![\p{L}])${LABEL("aba", re`transit|routing|aba|rtn|${NUM_LABEL}`)}(?<aba>\d{9})(?!\d)`
  + re`|(?<![\p{L}])sort[ \t_-]?code${gap("sort", re`${MARKS}|${NOISE}`)}(?<sort>\d{2}[ -]?\d{2}[ -]?\d{2})(?![\d-])`
  + re`|(?<![\p{L}])(?:bic|swift)(?:[ \t/_]{1,3}(?:bic|swift|code)){0,2}${gap("bic", re`${MARKS}|${NOISE}`)}(?<bic>[a-z]{6}[a-z0-9]{2}(?:[a-z0-9]{3})?)(?![\p{L}\p{N}])`;

// an account number: the word and up to 17 digits with single spaces or dashes; found once per text
const ACCOUNT_NO = new RegExp(re`(?<![\p{L}])${ACCOUNT_WORDS}${GLUED}(?![\p{L}])${LABEL("account", NUM_LABEL)}\d(?:[ -]?\d){5,16}(?!\d)`, "giu");
// an account number next to a UK sort code: 7–10 digits (or 4 + 4) not inside a longer number
const UK_ACCOUNT = /(?<![\d-])(?:\d{4} \d{4}|\d{7,10})(?![\d-])/g;

/**
 * IBAN: the country's length taken from the code before the match, the body read from the text (letters and digits with
 * single spaces, as the pattern's look ahead), a boundary after exactly that length, check digits (mod 97).
 */
function ibanCheck(m: RegExpExecArray, text: string): boolean {
  const start = m.index - 2, len = ibanLength(text.slice(start, m.index).toUpperCase());
  if (!len) return false;
  let compact = "", i = start;
  for (; i < text.length && compact.length < len; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 48 && c <= 57) || ((c | 32) >= 97 && (c | 32) <= 122)) compact += text[i];
    else if (c !== 32 || text.charCodeAt(i - 1) === 32 || compact.length < 4) return false;
  }
  if (compact.length < len) return false;
  if (isAlnum(text[i])) return false;
  return ibanOk(compact.toUpperCase());
}

function bankAccountOk(m: RegExpExecArray, text: string, scratch: Scratch): boolean {
  const g = m.groups!;
  if (g.iban !== undefined) return ibanCheck(m, text);
  const end = m.index + m[0].length;
  if (g.aba !== undefined) return abaOk(g.aba) && anyIn(startsOf(scratch, "acct", text, ACCOUNT_NO), m.index - 150, end + 150);
  if (g.sort !== undefined) {
    // the sort code itself is six digits with dashes: an account number is another run of digits within 80 characters
    const list = startsOf(scratch, "uk", text, UK_ACCOUNT);
    return anyIn(list, m.index - 80, m.index) || anyIn(list, end, end + 80);
  }
  if (g.bic !== undefined) {
    const code = text.slice(end - g.bic.length, end);
    if (code !== code.toUpperCase() || !/^[A-Z]{6}/.test(code)) return false;
    return anyIn(startsOf(scratch, "acct", text, ACCOUNT_NO), m.index - 150, end + 150);
  }
  return false;
}

// ---------------------------------------------------------------- national_id
// Two kinds of branch. A name of the number ("SSN", "PESEL", "codice fiscale", "passport", …) — the check reads the first
// value of the right shape after it, up to 30 characters away (passport: 40) with no other digit in between, and validates
// it by the number's own rule (check digits, ranges). A number whose shape and check digits are strong enough on their own —
// a dashed US SSN in valid ranges, a formatted CPF, a spaced NINO or NIR, a codice fiscale, a Chinese resident ID, a dashed
// Korean RRN, an NRIC, a CURP and the second line of a passport's machine readable zone — is found without a name (capital
// letters where the number has them). Such a number that starts with letters is matched from its first digit (the NINO, the
// codice fiscale, the NRIC, the CURP; the MRZ line from the check digit of the document number) with the letters looked at
// behind: a pattern that starts with a letter is tried at every word of the text. The finding points at that digit. A codice
// fiscale with every digit replaced by a letter (full omocodia, issued only after seven collisions) is not found.
interface IdFamily { loose: RegExp; strict: RegExp; ok: (v: string) => boolean }
const compact = (v: string): string => v.replace(/[\s./-]+/g, "").toUpperCase();
// between a short, ambiguous name ("sin", "pan", "nie", "fin" are also words) and its number only label words and marks
// (and in structured text a key's quote, "_", the separator, the value's quote, ">" of an XML element, "]" of a bracketed
// form key: "bsn": "…", <sin>…, customer[bsn]=…)
const STRICT_GAP = gap("strict", re`number|no\.?|nr\.?|num[ée]ro|número|nummer|n°|is|card|code|id|#|[:=|(),."'“”‘’>\]-]|_|${NOISE}`, true);

/**
 * A family: the value pattern after the name — after at most `gap` characters without a digit (loose) or after label words
 * only (strict) — sticky at the name's end; case-insensitive (a check that needs capital letters says so).
 */
function fam(value: string, ok: (v: string) => boolean, gap = 30): IdFamily {
  return { loose: new RegExp(re`[^\d]{0,${gap}}?(?<v>${value})`, "iy"), strict: new RegExp(re`${STRICT_GAP}(?<v>${value})`, "iy"), ok };
}
const F = {
  ssn: fam(re`(?<![\dA-Za-z])\d{3}[- .]?\d{2}[- .]?\d{4}(?![\dA-Za-z])`, (v) => usSsnOk(compact(v)) || usItinOk(compact(v))),
  nino: fam(re`(?<![A-Za-z0-9])[A-Za-z]{2} ?\d{2} ?\d{2} ?\d{2} ?[A-Da-d](?![A-Za-z0-9])`, (v) => ukNinoOk(compact(v))),
  sin: fam(re`(?<![\dA-Za-z])\d{3}[- ]?\d{3}[- ]?\d{3}(?![\dA-Za-z])`, (v) => caSinOk(compact(v))),
  tfn: fam(re`(?<![\dA-Za-z])\d{3}[- ]?\d{3}[- ]?\d{2,3}(?![\dA-Za-z])`, (v) => auTfnOk(compact(v))),
  aadhaar: fam(re`(?<![\dA-Za-z])\d{4}[- ]?\d{4}[- ]?\d{4}(?![\dA-Za-z])`, (v) => inAadhaarOk(compact(v))),
  pan: fam(re`(?<![A-Za-z0-9])[A-Za-z]{5}\d{4}[A-Za-z](?![A-Za-z0-9])`, (v) => inPanOk(compact(v))),
  cpf: fam(re`(?<![\d.])\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?![\d])`, (v) => brCpfOk(compact(v))),
  pesel: fam(re`(?<![\dA-Za-z])\d{11}(?![\dA-Za-z])`, (v) => plPeselOk(v)),
  bsn: fam(re`(?<!\d|\d\.)(?:\d{4}\.\d{2}\.\d{3}|\d{8,9})(?!\d|\.\d)`, (v) => nlBsnOk(compact(v))),
  nir: fam(re`(?<![\dA-Za-z])[1278] ?\d{2} ?\d{2} ?(?:\d{2}|2[ABab]) ?\d{3} ?\d{3} ?\d{2}(?![\dA-Za-z])`, (v) => frNirOk(compact(v))),
  dni: fam(re`(?<![A-Za-z0-9])[XYZxyz]?-?\d{7,8}[- ]?[A-Za-z](?![A-Za-z0-9])`, (v) => esDniOk(compact(v))),
  cf: fam(re`(?<![A-Za-z0-9])(?=[A-Za-z]{0,15}\d)[A-Za-z]{6}[\dA-Za-z]{2}[A-Za-z][\dA-Za-z]{2}[A-Za-z][\dA-Za-z]{3}[A-Za-z](?![A-Za-z0-9])`, (v) => itCfOk(compact(v))),
  se: fam(re`(?<![\dA-Za-z])(?:19|20)?\d{6}[-+ ]?\d{4}(?![\dA-Za-z])`, (v) => { const d = v.replace(/\D/g, ""); return sePersonnummerOk(d.length === 12 ? d.slice(2) : d); }),
  steuer: fam(re`(?<![\dA-Za-z])\d{2} ?\d{3} ?\d{3} ?\d{3}(?![\dA-Za-z])`, (v) => deSteuerIdOk(compact(v))),
  cn: fam(re`(?<![\dA-Za-z])\d{17}[\dXx](?![\dA-Za-z])`, (v) => cnIdOk(compact(v))),
  kr: fam(re`(?<![\dA-Za-z])\d{6}-?\d{7}(?![\dA-Za-z])`, (v) => krRrnOk(compact(v))),
  sg: fam(re`(?<![A-Za-z0-9])[STFGstfg]\d{7}[A-Za-z](?![A-Za-z0-9])`, (v) => sgNricOk(compact(v))),
  za: fam(re`(?<![\dA-Za-z])\d{6} ?\d{4} ?\d{3}(?![\dA-Za-z])`, (v) => zaIdOk(compact(v))),
  tr: fam(re`(?<![\dA-Za-z])\d{11}(?![\dA-Za-z])`, (v) => trTcknOk(v)),
  curp: fam(re`(?<![A-Za-z0-9])[A-Za-z]{4}\d{6}[A-Za-z]{6}[A-Za-z\d]\d(?![A-Za-z0-9])`, (v) => mxCurpOk(compact(v))),
  jp: fam(re`(?<![\dA-Za-z])\d{4} ?\d{4} ?\d{4}(?![\dA-Za-z])`, (v) => jpMyNumberOk(compact(v))),
  // a passport number: 6–9 capital letters and digits, at least four digits, within 40 characters of the word
  // (the value has a digit: a label word such as "number" is not taken for it)
  passport: fam(re`(?<![A-Za-z0-9])(?=[A-Za-z]{0,8}\d)[A-Z0-9]{6,9}(?![A-Za-z0-9])`, passportNoOk, 40),
};
/** Families of the numbers that "ID number", "national ID", "identity card" may name: those with strong check digits. */
// (strong ones only: "customer ID number 1234567890" must not pass a one-in-ten check digit)
const ANY_ID: readonly IdFamily[] = [F.za, F.cn, F.kr, F.tr, F.sg, F.dni, F.cf, F.curp, F.cpf, F.nir];

function passportNoOk(v: string): boolean {
  if (v !== v.toUpperCase()) return false;
  const digits = v.replace(/\D/g, "");
  if (digits.length < 4 || new Set(v).size < 4) return false;
  // a date or a year range after the word ("passport valid until 20300115") is not the number
  if (/^\d{8}$/.test(v) && /^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/.test(v)) return false;
  return true;
}

// names of the numbers (lower case, spaces collapsed), the families each one may name, and whether the gap is strict
const ID_NAMES: Array<[RegExp, readonly IdFamily[], boolean?]> = [
  [/^(?:ssn|social ?security|soc\.? sec)/, [F.ssn]],
  [/^(?:itin|taxpayer|tax ?id|tax ?identification)/, [F.ssn, F.steuer, F.pan]],
  [/^tin$/, [F.ssn, F.steuer, F.pan], true],
  [/^(?:nino|national insurance|ni n)/, [F.nino]],
  [/^(?:social insurance|num[ée]ro d.assurance)/, [F.sin]],
  [/^(?:sin|nas)$/, [F.sin], true],
  [/^tax file/, [F.tfn]],
  [/^tfn$/, [F.tfn], true],
  [/^(?:aadhaa?r|uidai)/, [F.aadhaar]],
  [/^permanent account/, [F.pan]],
  [/^pan$/, [F.pan], true],
  [/^cpf$/, [F.cpf], true],
  [/^pesel/, [F.pesel]],
  [/^(?:burgerservice|sofi)/, [F.bsn]],
  [/^bsn$/, [F.bsn], true],
  [/^(?:insee|s[ée]curit[ée] sociale|n° ss|num[ée]ro ss)/, [F.nir]],
  [/^nir$/, [F.nir], true],
  [/^(?:d\.n\.i|documento nacional)/, [F.dni]],
  [/^(?:dni|nie|nif)$/, [F.dni], true],
  [/^(?:codice fiscale|cod\.? fisc)/, [F.cf]],
  [/^(?:personnummer|samordningsnummer|personal identity number)/, [F.se]],
  [/^(?:steuer|identifikationsnummer)/, [F.steuer]],
  [/^idnr$/, [F.steuer], true],
  [/^resident registration/, [F.kr]],
  [/^rrn$/, [F.kr], true],
  [/^nric$/, [F.sg]],
  [/^fin$/, [F.sg], true],
  [/^(?:tckn|t\.? ?c\.? kimlik|kimlik)/, [F.tr]],
  [/^tc no/, [F.tr], true],
  [/^curp/, [F.curp]],
  [/^(?:my number|individual number)/, [F.jp]],
  [/^(?:passport|reisepass|passeport|pasaporte|passaporte|passaporto)/, [F.passport]],
  [/^(?:resident id|resident identity)/, [F.cn]],
  [/^(?:south african|rsa) id/, [F.za]],
  [/^(?:id|identity|national ?id|national ?identity|citizen id|personal id)/, ANY_ID],
];
const CJK_NAMES: Array<[RegExp, readonly IdFamily[]]> = [
  [/^(?:身份证|居民身份证)/u, [F.cn]], [/^주민등록번호/u, [F.kr]], [/^(?:マイナンバー|個人番号)/u, [F.jp]],
];

const ID_WORDS = re`ssn|social[ \t_]?security(?:[ \t_]?(?:number|no\.?))?|soc\.?[ \t]sec\.?|itin|tin|taxpayer[ \t_]?id(?:entification)?(?:[ \t_]?number)?`
  + re`|tax[ \t_]?(?:id|identification)(?:[ \t_]?(?:number|no\.?))?|nino|national[ \t_]insurance(?:[ \t_](?:number|no\.?))?|ni[ \t_](?:number|no\.?)`
  + re`|sin|social[ \t]insurance(?:[ \t]number)?|nas|num[ée]ro[ \t]d.assurance[ \t]sociale|tfn|tax[ \t]file[ \t]number|aadhaa?r|uidai`
  + re`|pan|permanent[ \t]account[ \t]number|cpf|pesel|bsn|burgerservicenummer|sofi-?nummer|nir|insee|s[ée]curit[ée][ \t]sociale|n°[ \t]ss`
  + re`|num[ée]ro[ \t]ss|dni|nie|nif|d\.n\.i\.?|documento[ \t]nacional[ \t]de[ \t]identidad|codice[ \t]fiscale|cod\.?[ \t]fisc\.?`
  + re`|personnummer|samordningsnummer|personal[ \t]identity[ \t]number|steuer-?id|steuer-?identifikationsnummer|steuerliche[ \t]identifikationsnummer`
  + re`|identifikationsnummer|idnr|rrn|resident[ \t]registration[ \t]number|nric|fin|tckn|t\.?[ \t]?c\.?[ \t]kimlik(?:[ \t]no)?|kimlik[ \t](?:no|numaras[ıi])`
  + re`|tc[ \t]no|curp|my[ \t_]number|individual[ \t_]number|passport(?:[ \t_]?(?:number|no|nr|num))?|reisepass(?:nummer)?|passeport|pasaporte|passaporte|passaporto`
  + re`|resident[ \t]identity(?:[ \t]card)?(?:[ \t]number)?|resident[ \t]id|(?:south[ \t]african|rsa)[ \t]id(?:entity)?(?:[ \t](?:card|number|no\.?|document))?|national[ \t_]?id(?:entity)?(?:[ \t_]?(?:card|number|no\.?))?`
  + re`|identity[ \t_]?(?:card|number|no\.?)|id[ \t_]?(?:card|number|no\.?)|citizen[ \t_]id|personal[ \t_]id`;

// compiled without the flag i (see ci): the names case-insensitive by hand, the numbers without a name in capitals only;
// a name after "_" counts (employee_ssn, user_national_id), after a letter it does not (camelCase employeeSsn — not found)
const NATIONAL_ID = re`(?<![\p{L}\p{N}])(?<name>${ci(ID_WORDS)})(?![\p{L}])`
  + re`|(?<cjk>居民身份证|身份证|주민등록번호|マイナンバー|個人番号)`
  + re`|(?<![\p{L}\p{N}-])(?<ssn>\d{3}-\d{2}-\d{4})(?![\p{N}]|-\d)`
  + re`|(?<![\p{N}.])(?<cpf>\d{3}\.\d{3}\.\d{3}-\d{2})(?![\p{N}])`
  + re`|(?<nino>\d)(?<=(?<![\p{L}\p{N}])[A-Z]{2} \d)\d \d{2} \d{2} [A-D](?![\p{L}\p{N}])`
  + re`|(?<![\p{N}])(?<nir>[1278] \d{2} \d{2} (?:\d{2}|2[AB]) \d{3} \d{3} \d{2})(?![\p{N}])`
  + re`|(?<cf>\d)(?=[\dLMNPQRSTUV][ABCDEHLMPRST])(?<=(?<![\p{L}\p{N}])[A-Z]{6}\d)[\dLMNPQRSTUV][ABCDEHLMPRST][\dLMNPQRSTUV]{2}[A-Z][\dLMNPQRSTUV]{3}[A-Z](?![\p{L}\p{N}])`
  + re`|(?<![\p{N}])(?<cn>[1-8]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx])(?![\p{N}])`
  + re`|(?<![\p{N}-])(?<kr>\d{6}-[1-8]\d{6})(?![\p{N}])`
  + re`|(?<sg>\d)(?<=(?<![\p{L}\p{N}])[STFG]\d)\d{6}[A-Z](?![\p{L}\p{N}])`
  + re`|(?<curp>\d)(?<=(?<![\p{L}\p{N}])[A-Z][AEIOUX][A-Z]{2}\d)\d{5}[HMX][A-Z]{2}[B-DF-HJ-NP-TV-Z]{3}[A-Z\d]\d(?![\p{L}\p{N}])`
  + re`|(?<mrz>\d)(?=[A-Z<]{3}\d{7}[MFX<]\d{7})(?<=(?<![A-Za-z0-9<])[A-Z0-9<]{9}\d)[A-Z<]{3}\d{7}[MFX<]\d{7}[A-Z0-9<]{14}[\d<]\d(?![A-Za-z0-9<])`;

/** A phone word in the gap before a value: "Passport office phone 5551234" names a phone number, not the passport's. */
const PHONE_IN_GAP = /(?<![\p{L}])(?:phone|tel|fax|mobile|cell|call)(?![\p{L}])/iu;

/** The first value of one of the families after the name, validated. */
function namedIdOk(families: readonly IdFamily[], text: string, end: number, strict = false): boolean {
  for (const f of families) {
    const rx = strict ? f.strict : f.loose;
    rx.lastIndex = end;
    const m = rx.exec(text);
    if (m && f.ok(m.groups!.v) && !(f === F.passport && PHONE_IN_GAP.test(m[0].slice(0, m[0].length - m.groups!.v.length)))) return true;
  }
  return false;
}

/** The exact text of a strong branch is in capital letters (the pattern is case-insensitive). */
const upper = (v: string): boolean => v === v.toUpperCase();

function nationalIdOk(m: RegExpExecArray, text: string): boolean {
  const g = m.groups!, end = m.index + m[0].length;
  if (g.name !== undefined) {
    const name = g.name.toLowerCase().replace(/[ \t_]+/g, " ");
    // a short name that is also a word (sin, pan, nie, nas, tin, fin) reads only label words and marks before its value
    // (strict) and wants the value's format and check digits — also at the end of a snake_case key: math_sin = 0.84 is no
    // number, employee_sin=046454286 is (a guard that dropped every such key lost the second)
    for (const [rx, families, strict] of ID_NAMES) if (rx.test(name)) return namedIdOk(families, text, end, strict);
    return false;
  }
  if (g.cjk !== undefined) {
    for (const [rx, families] of CJK_NAMES) if (rx.test(g.cjk)) return namedIdOk(families, text, end);
    return false;
  }
  if (g.ssn !== undefined) { const d = compact(g.ssn); return usSsnOk(d) || usItinOk(d); }
  if (g.cpf !== undefined) return brCpfOk(compact(g.cpf));
  // the branches that start with letters match from their first digit (see NATIONAL_ID): the value starts `head` characters before
  const val = (head: number): string => text.slice(m.index - head, end);
  if (g.nino !== undefined) { const v = val(3); return upper(v) && ukNinoOk(compact(v)); }
  if (g.nir !== undefined) return upper(g.nir) && frNirOk(compact(g.nir));
  if (g.cf !== undefined) { const v = val(6); return upper(v) && itCfOk(v); }
  if (g.cn !== undefined) return cnIdOk(g.cn.toUpperCase());
  if (g.kr !== undefined) return krRrnOk(compact(g.kr));
  if (g.sg !== undefined) { const v = val(1); return upper(v) && sgNricOk(v); }
  if (g.curp !== undefined) { const v = val(4); return upper(v) && mxCurpOk(v); }
  if (g.mrz !== undefined) { const v = val(9); return upper(v) && mrzTd3Ok(v); }
  return false;
}

// ---------------------------------------------------------------- phone_intl
// A national phone number without "+" (the rule phone finds E.164 and Russian numbers) right after a phone word — label
// words and marks only in between ("Tel.: ", "Phone (office): ", "Mobil-Nr. ", "téléphone : ", "Teléfono: "). The number:
// groups of digits with single spaces, dots, dashes, slashes or brackets, 7–15 digits in all; a date, an IP address, an
// amount with thousands groups, a run of one or two digits, more than two one-digit groups are not phones.
const PHONE_WORDS = re`telephone|phone|tel|tél|telefon|telefonnummer|rufnummer|handy|handynummer|mobil|mobilnummer|mobile|mob`
  + re`|cellphone|cell[ \t]phone|cell|call|fax|whats[ \t]?app|téléphone|portable|teléfono|telefono|telefone|telemóvel|telemovel|móvil|movil|celular|cellulare`;
// label words and marks between the word and the number; in structured text a key's quote, the separator, the value's quote
// and ">" of an XML element ("phone": "030 1234567", <phone>030 1234567), "]" of a bracketed form key
// (customer[phone]=…); an ordinal of a form line ("Phone 1:", "Tel 2 -"); the number may stand on the next line ("Phone:\n…")
// ("del" before its prefix "de": the items are an ordered choice, see gap())
const PHONE_LABEL = gap("phone", re`[:#=/),|"'“”‘’>\]-]|${NOISE}|\((?=\p{L})|\.|no\.?|nr\.?|number|num[ée]ro|número|nummer|n°|office|work|home|mobile|cell|direct|main`
  + re`|fixe|privat|personal|del|de|du|is|at|on|me|us|uk|\d{1,2}(?=[ \t]{0,2}(?:[:)=]|-[ \t]))`, true);
// a word after "_" of a snake_case key counts (home_phone), after a letter or "-" it does not (telemetry, mobile-first);
// the word with "number" or "no" glued on is a camelCase or snake_case key (phoneNumber, phone_number, mobile_no)
const PHONE_INTL = re`(?<![\p{L}\p{N}-])(?<w>(?:${PHONE_WORDS})(?:[_-]?(?:number|no|nr|num))?)(?:\.|(?![\p{L}]))${PHONE_LABEL}(?<num>\(?\d{1,15}\)?(?:[ .\/-]{1,2}\(?\d{1,10}\)?){0,6})(?![\p{N}])`;

// Words that end many keys which are not phone numbers ("last_call", "max_cell", "total_mobile", "n_fax"): after "_" of a
// snake_case key such a word with a bare run of digits names a phone only when the digits have a phone's shape.
const WEAK_PHONE_WORD = /^(?:t[eé]l|handy|mobil|mobile|mob|cell|call|fax|portable|m[óo]vil)(?:[_-]?(?:number|no|nr|num))?$/iu;
// A bare run of digits with a phone's shape: a national number with the trunk prefix 0 (9–12 digits: 0301234567,
// 07700900123), a North American number (area code and exchange start with 2–9, optional leading 1), or an international
// number written from its country code without "+" (11–15 digits from 2–9: 491711234567, 33612345678; a run that starts
// with 1 and is no North American number — a time stamp in milliseconds, a size — is not).
const PHONE_SHAPED_RUN = /^(?:0\d{8,11}|1?[2-9]\d{2}[2-9]\d{6}|[2-9]\d{10,14})$/;
const QUOTE_FIRST = /^\\?["'“”‘’]/u, QUOTE_LAST = /["'“”‘’][ \t]*$/u;

function phoneIntlOk(m: RegExpExecArray, text: string): boolean {
  const g = m.groups!, num = g.num, digits = num.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15 || new Set(digits).size < 3) return false;
  // A bare run of digits after a weak word in a weak place must have a phone's shape: at the end of a snake_case key
  // ("first_call=1731500000", "max_cell: 16777216"), and as a JSON number (the value not in quotes) under a quoted key
  // ({"cell": 1048576}, "tel": 1234567). A strong word (phone, telephone, telefon…) names a phone in either place:
  // {"phone": 5551234}.
  if (/^\d+$/.test(num) && !PHONE_SHAPED_RUN.test(num) && WEAK_PHONE_WORD.test(g.w)) {
    const label = m[0].slice(g.w.length, m[0].length - num.length);
    if (inSnakeKey(text, m.index) || (QUOTE_FIRST.test(label) && !QUOTE_LAST.test(label))) return false;
  }
  if ((num.match(/\(/g)?.length ?? 0) !== (num.match(/\)/g)?.length ?? 0)) return false;
  if ((num.match(/(?<!\d)\d(?!\d)/g)?.length ?? 0) > 2) return false;                 // 1/2/3/4/5/6/7: a list, not a number
  if (dateLike(num.trim())) return false;
  if (/^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/.test(num)) return false;   // 20240115: a date
  if (/^(?:19|20)\d{2}([./-])(?:0[1-9]|1[0-2])\1(?:0[1-9]|[12]\d|3[01])(?!\d)/.test(num)) return false; // call-2026-09-24-1500: an id with a date
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(num)) return false;                 // IP address
  if (/^\d{1,2}(?: \d{3})+$/.test(num) || /^\d{1,3}(?:\.\d{3}){2,}$/.test(num)) return false; // 1 000 000, 1.000.000
  return true;
}

/** A numeric date: d/m/y, m/d/y or y-m-d with a valid month and day in one reading. */
function dateLike(s: string): boolean {
  let m = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/.exec(s);
  if (m) return dateOk(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return dateOk(y, Number(m[2]), Number(m[1])) || dateOk(y, Number(m[1]), Number(m[2]));
  }
  return false;
}

// ---------------------------------------------------------------- date_of_birth
// A date right after "date of birth", "DOB", "born (on)", "birth date", "né(e) le", "geboren (am)", "geb.", "Geburtsdatum",
// "date de naissance", "fecha de nacimiento", "nacido el", "data di nascita", "data de nascimento" — label words and marks only in between. The
// date: numeric (d/m/y, m/d/y, y-m-d with dots, slashes or dashes) or with a month name (en, de, fr, es, it, pt); it must be a
// calendar date, the year between 1900 and this year (two-digit years are accepted). A year alone ("born in 1985") is not a
// date of birth.
const MONTHS = re`jan(?:uary|uar)?|j[äa]nner|feb(?:ruary|ruar)?|f[ée]vrier|febrero|febbraio|mar(?:ch)?|m[äa]rz|mars|marzo|apr(?:il)?|avril|abril|aprile`
  + re`|may|mai|mayo|maggio|jun(?:e|i)?|juin|junio|giugno|jul(?:y|i)?|juillet|julio|luglio|aug(?:ust)?|ao[ûu]t|agosto|sep(?:t|tember)?|septembre`
  + re`|septiembre|setiembre|settembre|oct(?:ober)?|okt(?:ober)?|octobre|octubre|ottobre|nov(?:ember)?|novembre|noviembre|dec(?:ember)?`
  + re`|dez(?:ember)?|d[ée]cembre|diciembre|dicembre|enero|gennaio|janvier`
  + re`|janeiro|fevereiro|março|marco|maio|junho|julho|setembro|outubro|novembro|dezembro`;
// "_" or "-" between the words of a key, none in a camelCase key (date_of_birth, dateOfBirth, birth_date, birthDate)
const DOB_WORDS = re`date[ \t_-]?of[ \t_-]?birth|birth[ \t_-]?date|d\.?o\.?b\.?|born(?:[ \t]on)?|n[ée](?:e|\(e\))?[ \t]le|geboren(?:[ \t]am)?|geb\.(?:[ \t]am)?`
  + re`|geburtsdatum|date[ \t_]de[ \t_]naissance|fecha[ \t_]de[ \t_]nacimiento|nacid[oa](?:[ \t]el)?|data[ \t_]di[ \t_]nascita|data[ \t_]de[ \t_]nascimento|nascid[oa](?:[ \t]em)?`;
// label words and marks; in structured text a key's quote, the separator, the value's quote, ">" of an XML element; the
// format in brackets before the "(" alone (the items are an ordered choice, see gap())
const DOB_LABEL = gap("dob", re`\([dmyjta/. -]{2,14}\)|[:=(),|"'“”‘’>\]-]|${NOISE}|is|was|on|am|le|el|the`, true);
// a word after "_" of a snake_case key counts (user_dob), after a letter or "-" it does not (stillborn, first-born)
const DATE_OF_BIRTH = re`(?<![\p{L}\p{N}-])(?:${DOB_WORDS})(?:(?<=\.)|(?![\p{L}]))${DOB_LABEL}(?<date>`
  + re`\d{1,2}[./-]\d{1,2}[./-](?:\d{4}|\d{2})|\d{4}[./-]\d{1,2}[./-]\d{1,2}`
  + re`|(?<dd>\d{1,2})(?:st|nd|rd|th|er)?\.?[ \t]{1,2}(?:of[ \t]|de[ \t])?(?<mn>${MONTHS})\.?(?:[ \t]de)?[ \t,]{1,3}(?<yy>\d{4})`
  + re`|(?<mn2>${MONTHS})\.?[ \t]{1,2}(?<dd2>\d{1,2})(?:st|nd|rd|th)?,?[ \t]{1,2}(?<yy2>\d{4}))(?![\p{N}]|[./-]\d)`;

const MONTH_INDEX: ReadonlyArray<[RegExp, number]> = [
  [/^(?:jan|j[äa]nner|enero|gennaio|janvier)/, 1], [/^(?:feb|f[ée]v)/, 2], [/^(?:mar|m[äa]r)/, 3], [/^(?:apr|avr|abr)/, 4],
  [/^(?:may|mai|mag)/, 5], [/^(?:jun|juin|giu)/, 6], [/^(?:jul|juil|lug)/, 7], [/^(?:aug|ao[ûu]|ago)/, 8], [/^(?:sep|set)/, 9],
  [/^(?:oct|okt|ott|out)/, 10], [/^nov/, 11], [/^(?:dec|dez|d[ée]c|dic)/, 12],
];
const monthOf = (name: string): number => {
  const n = name.toLowerCase();
  for (const [rx, i] of MONTH_INDEX) if (rx.test(n)) return i;
  return 0;
};

// a verb or participle that ends a snake_case key after a modifier is not a field name ("is_born", "last_born",
// "first_born"); after a noun it is (date_born, child_born), and the nouns always count
// (user_dob, patient_date_of_birth)
const DOB_VERB = /^(?:born|geboren|geb\.|n[ée]|nacid|nascid)/iu;
const DOB_VERB_MODIFIER = /^(?:is|was|were|has|had|been|be|not|never|last|first|second|third|eldest|youngest|still|new|newly|re|un|latest|earliest|min|max|total|count|num|n)$/i;
/** The word of a snake_case key right before "_" at `i` (letters and digits back to the previous "_" or the key's start). */
function keyWordBefore(text: string, i: number): string {
  let s = i - 1;
  while (s > 0 && i - 1 - s < 20 && /[A-Za-z0-9]/.test(text[s - 1])) s--;
  return text.slice(s, i - 1);
}
// a snake_case key is followed by its separator ("user_dob: …", "user_dob=…", "\"user_dob\": …"); "file_dob 2024-01-15" is a
// name in a list of words, not a key with its value
const KEY_SEPARATOR = /[:=>"'“”‘’,;|]/u;

function dateOfBirthOk(m: RegExpExecArray, text: string): boolean {
  const g = m.groups!, now = new Date().getUTCFullYear();
  if (inSnakeKey(text, m.index) && ((DOB_VERB.test(m[0]) && DOB_VERB_MODIFIER.test(keyWordBefore(text, m.index)))
      || !KEY_SEPARATOR.test(m[0].slice(0, m[0].length - g.date.length)))) return false;
  const plausible = (y: number, mo: number, d: number): boolean => (y < 100 || (y >= 1900 && y <= now)) && dateOk(y < 100 ? 2000 : y, mo, d);
  if (g.mn !== undefined) return plausible(Number(g.yy), monthOf(g.mn), Number(g.dd));
  if (g.mn2 !== undefined) return plausible(Number(g.yy2), monthOf(g.mn2), Number(g.dd2));
  const s = g.date;
  let x = /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/.exec(s);
  if (x) return plausible(Number(x[1]), Number(x[2]), Number(x[3]));
  x = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/.exec(s);
  if (!x) return false;
  const y = Number(x[3]);
  return plausible(y, Number(x[2]), Number(x[1])) || plausible(y, Number(x[1]), Number(x[2]));
}

/**
 * Rules of the pack intl, in the order they run (after the rules of core and ru). Each resumes inside a refused match
 * (resumeInside): a match starts at a label word and its gap may hold label
 * words of the same rule — "mobile", "cell" are items of the phone gap, a tag's attributes may name "dob", a long ID name
 * holds a shorter one ("personal identity number") — and a refused key one line above must not hide them.
 */
export function intlRules(): readonly OpenCheckRule[] {
  return [
    { name: "bank_account", kind: "pii", reason: "bank account number", check: bankAccountOk, resumeInside: true, pattern: BANK_ACCOUNT },
    { name: "national_id", kind: "pii", reason: "national ID number", caseSensitive: true, check: nationalIdOk, resumeInside: true, pattern: NATIONAL_ID },
    { name: "phone_intl", kind: "pii", reason: "phone number", check: phoneIntlOk, resumeInside: true, pattern: PHONE_INTL },
    { name: "date_of_birth", kind: "pii", reason: "date of birth", check: dateOfBirthOk, resumeInside: true, pattern: DATE_OF_BIRTH },
  ];
}
