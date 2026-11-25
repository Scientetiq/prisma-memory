// Check digits and structure tests of international account and identity numbers, for the rules of the pack intl
// (open-check-intl.ts). Pure functions over strings of ASCII digits and capital letters: the caller strips
// separators first. Every function is linear in the length of its argument, and every argument is short (at most 34
// characters), so the rules stay linear in the length of the text.
//
// Sources: the IBAN registry (ISO 13616, country lengths), ISO 7064 (MOD 97-10, MOD 11-2, MOD 11,10), the ABA routing
// number checksum, Luhn, Verhoeff, ICAO Doc 9303 (machine readable zone, weights 7-3-1) and the published rules of each
// national number. Nothing is copied from a library.
//
// Leaf module: no imports.

/** Digits only (separators removed). */
export const digitsOnly = (s: string): string => s.replace(/\D+/g, "");

const allSame = (s: string): boolean => s.length > 0 && s.split("").every((c) => c === s[0]);

// ---------------------------------------------------------------- generic algorithms

/** Luhn (mod 10): the last digit is the check digit. */
export function luhn(d: string): boolean {
  if (!/^\d{2,}$/.test(d)) return false;
  let sum = 0;
  for (let i = d.length - 1, alt = false; i >= 0; i--, alt = !alt) {
    let x = d.charCodeAt(i) - 48;
    if (alt) { x *= 2; if (x > 9) x -= 9; }
    sum += x;
  }
  return sum % 10 === 0;
}

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1], [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1], [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** Verhoeff (dihedral group D5): the last digit is the check digit. */
export function verhoeff(d: string): boolean {
  if (!/^\d{2,}$/.test(d)) return false;
  let c = 0;
  for (let i = 0; i < d.length; i++) c = VERHOEFF_D[c][VERHOEFF_P[i % 8][d.charCodeAt(d.length - 1 - i) - 48]];
  return c === 0;
}

/** Sum of digit × weight over the first weights.length digits. */
function weighted(d: string, w: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += (d.charCodeAt(i) - 48) * w[i];
  return s;
}

/** Remainder of a long decimal string modulo m, computed in chunks (the string may be longer than a safe integer). */
function modDecimal(s: string, m: number): number {
  let r = 0;
  for (let i = 0; i < s.length; i += 7) r = Number(String(r) + s.slice(i, i + 7)) % m;
  return r;
}

// ---------------------------------------------------------------- bank accounts

/** Length of the IBAN of each country of the IBAN registry (ISO 13616). */
export const IBAN_LENGTHS: Readonly<Record<string, number>> = Object.freeze({
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BI: 27, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28,
  CZ: 24, DE: 22, DJ: 27, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FK: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23,
  GL: 18, GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32,
  LI: 21, LT: 20, LU: 20, LV: 21, LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MN: 20, MR: 27, MT: 31, MU: 30, NI: 28, NL: 18,
  NO: 15, OM: 23, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, RU: 33, SA: 24, SC: 31, SD: 18, SE: 24, SI: 19,
  SK: 24, SM: 27, SO: 23, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20,
});

/** Length of the IBAN of a country code, or 0 when the country has no IBAN. */
export const ibanLength = (country: string): number =>
  Object.prototype.hasOwnProperty.call(IBAN_LENGTHS, country) ? IBAN_LENGTHS[country] : 0;

/**
 * IBAN without separators, capital letters: the country is in the registry, the length is the country's, the check
 * digits are 02–98 and the whole number is 1 modulo 97 (ISO 7064 MOD 97-10).
 */
export function ibanOk(iban: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  if (ibanLength(iban.slice(0, 2)) !== iban.length) return false;
  const check = Number(iban.slice(2, 4));
  if (check < 2 || check > 98) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let num = "";
  for (const ch of moved) num += ch >= "A" ? String(ch.charCodeAt(0) - 55) : ch;
  return modDecimal(num, 97) === 1;
}

/** US ABA routing number: nine digits, 3-7-1 weights sum to a multiple of 10; the first two digits are a valid Federal Reserve prefix. */
export function abaOk(d: string): boolean {
  if (!/^\d{9}$/.test(d) || allSame(d)) return false;
  const p = Number(d.slice(0, 2));
  if (!((p <= 12) || (p >= 21 && p <= 32) || (p >= 61 && p <= 72) || p === 80)) return false;
  return weighted(d, [3, 7, 1, 3, 7, 1, 3, 7, 1]) % 10 === 0;
}

// ---------------------------------------------------------------- national identifiers

/** US SSN (nine digits): area not 000, 666 or 900–999; group not 00; serial not 0000; not a well-known advertising or placeholder number. */
export function usSsnOk(d: string): boolean {
  if (!/^\d{9}$/.test(d)) return false;
  const area = d.slice(0, 3), group = d.slice(3, 5), serial = d.slice(5);
  if (area === "000" || area === "666" || area[0] === "9" || group === "00" || serial === "0000") return false;
  return !SSN_PLACEHOLDERS.has(d);
}
// 078-05-1120 (the wallet card of 1938), 219-09-9999 (an SSA leaflet), 123-45-6789 (the usual placeholder)
const SSN_PLACEHOLDERS: ReadonlySet<string> = new Set(["078051120", "219099999", "123456789"]);

/** US ITIN (nine digits): area 9xx, group 50–65, 70–88, 90–92 or 94–99. */
export function usItinOk(d: string): boolean {
  if (!/^9\d{8}$/.test(d)) return false;
  const g = Number(d.slice(3, 5));
  return (g >= 50 && g <= 65) || (g >= 70 && g <= 88) || (g >= 90 && g <= 92) || (g >= 94 && g <= 99);
}

/** UK National Insurance number: two letters (excluded prefixes and letters), six digits, suffix A–D. */
export function ukNinoOk(s: string): boolean {
  const m = /^([A-CEGHJ-PR-TW-Z])([A-CEGHJ-NPR-TW-Z])\d{6}[A-D]$/.exec(s);
  if (!m) return false;
  return !NINO_BAD_PREFIX.has(m[1] + m[2]);
}
const NINO_BAD_PREFIX: ReadonlySet<string> = new Set(["BG", "GB", "KN", "NK", "NT", "TN", "ZZ"]);

/** Canadian Social Insurance Number: nine digits, Luhn, first digit not 8 (business numbers). */
export const caSinOk = (d: string): boolean => /^[0-79]\d{8}$/.test(d) && luhn(d) && !allSame(d);

/** Australian Tax File Number: nine digits (weights 1,4,3,7,5,8,6,9,10) or eight digits (10,7,8,4,6,3,5,1), sum divisible by 11. */
export function auTfnOk(d: string): boolean {
  if (allSame(d)) return false;
  if (/^\d{9}$/.test(d)) return weighted(d, [1, 4, 3, 7, 5, 8, 6, 9, 10]) % 11 === 0;
  if (/^\d{8}$/.test(d)) return weighted(d, [10, 7, 8, 4, 6, 3, 5, 1]) % 11 === 0;
  return false;
}

/** Indian Aadhaar: twelve digits, the first 2–9, Verhoeff check digit; not a palindrome or a run of one digit. */
export const inAadhaarOk = (d: string): boolean =>
  /^[2-9]\d{11}$/.test(d) && verhoeff(d) && !allSame(d.slice(0, 11)) && d !== d.split("").reverse().join("");

/** Indian PAN: five letters (the fourth is the holder type), four digits, one letter. */
export const inPanOk = (s: string): boolean => /^[A-Z]{3}[ABCFGHJLPT][A-Z]\d{4}[A-Z]$/.test(s) && !/^(.)\1{4}/.test(s) && s.slice(5, 9) !== "0000";

/** Brazilian CPF: eleven digits, two mod-11 check digits; not a run of one digit. */
export function brCpfOk(d: string): boolean {
  if (!/^\d{11}$/.test(d) || allSame(d)) return false;
  const dv = (n: number): number => {
    let s = 0;
    for (let i = 0; i < n; i++) s += (d.charCodeAt(i) - 48) * (n + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === d.charCodeAt(9) - 48 && dv(10) === d.charCodeAt(10) - 48;
}

/** Calendar date check; year of four digits. */
export function dateOk(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const days = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return d <= days;
}

/** Polish PESEL: eleven digits, weights 1,3,7,9 repeated, check digit; the month carries the century (+20, +40, +60, +80). */
export function plPeselOk(d: string): boolean {
  if (!/^\d{11}$/.test(d) || allSame(d)) return false;
  if ((10 - (weighted(d, [1, 3, 7, 9, 1, 3, 7, 9, 1, 3]) % 10)) % 10 !== d.charCodeAt(10) - 48) return false;
  const yy = Number(d.slice(0, 2)), mm = Number(d.slice(2, 4)), dd = Number(d.slice(4, 6));
  const century = [1900, 2000, 2100, 2200, 1800][Math.floor(mm / 20)] ?? 0;
  return century > 0 && dateOk(century + yy, mm % 20, dd);
}

/** Dutch BSN: nine digits (or eight with a leading zero dropped), 11-test with weights 9…2 and −1. */
export function nlBsnOk(raw: string): boolean {
  const d = raw.length === 8 ? "0" + raw : raw;
  if (!/^\d{9}$/.test(d) || allSame(d) || d.startsWith("00")) return false;
  return (weighted(d, [9, 8, 7, 6, 5, 4, 3, 2]) - (d.charCodeAt(8) - 48)) % 11 === 0;
}

/**
 * French NIR (numéro de sécurité sociale): sex 1/2 (7/8 provisional), year, month 01–12 or 20–42/50–99 (unknown), department
 * (2A/2B for Corsica), commune, order, and a key 97 − (number mod 97).
 */
export function frNirOk(s: string): boolean {
  const m = /^([1278])(\d{2})(\d{2})(\d{2}|2A|2B)(\d{3})(\d{3})(\d{2})$/.exec(s);
  if (!m) return false;
  const month = Number(m[3]);
  if (!((month >= 1 && month <= 12) || (month >= 20 && month <= 42) || (month >= 50 && month <= 99))) return false;
  if (m[6] === "000") return false;
  const body = (m[1] + m[2] + m[3] + m[4] + m[5] + m[6]).replace("2A", "19").replace("2B", "18");
  return 97 - modDecimal(body, 97) === Number(m[7]);
}

const DNI_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";
/** Spanish DNI (eight digits and a letter) or NIE (X/Y/Z, seven digits, a letter): the letter is the number mod 23. */
export function esDniOk(s: string): boolean {
  const m = /^([XYZ]?)(\d{7,8})([A-Z])$/.exec(s);
  if (!m) return false;
  if (m[1] ? m[2].length !== 7 : m[2].length !== 8) return false;
  if (allSame(m[2])) return false;
  const n = Number((m[1] ? String("XYZ".indexOf(m[1])) : "") + m[2]);
  return DNI_LETTERS[n % 23] === m[3];
}

// codice fiscale: values of the odd and even positions (1-based odd = index 0, 2, …); letters that replace digits (omocodia)
const CF_ODD: readonly number[] = [1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16, 10, 22, 25, 24, 23];
const CF_OMO = "LMNPQRSTUV";
/** Italian codice fiscale: 16 characters, structure (month letter, day 1–31 or 41–71), check letter by the odd/even tables. */
export function itCfOk(s: string): boolean {
  if (!/^[A-Z]{6}[\dLMNPQRSTUV]{2}[ABCDEHLMPRST][\dLMNPQRSTUV]{2}[A-Z][\dLMNPQRSTUV]{3}[A-Z]$/.test(s)) return false;
  const num = (c: string): number => (c >= "0" && c <= "9" ? Number(c) : CF_OMO.indexOf(c));
  const day = num(s[9]) * 10 + num(s[10]);
  if (!((day >= 1 && day <= 31) || (day >= 41 && day <= 71))) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    const c = s[i], digit = c >= "0" && c <= "9", v = digit ? Number(c) : c.charCodeAt(0) - 65;
    sum += i % 2 === 0 ? CF_ODD[v] : v;
  }
  return String.fromCharCode(65 + (sum % 26)) === s[15];
}

/** Swedish personnummer: YYMMDDNNNC (ten digits; the day + 60 for a coordination number), Luhn over the ten digits. */
export function sePersonnummerOk(d: string): boolean {
  if (!/^\d{10}$/.test(d)) return false;
  const mm = Number(d.slice(2, 4)), dd = Number(d.slice(4, 6)) % 60;
  if (!dateOk(2000, mm, dd) || d.slice(6, 9) === "000") return false;
  return luhn(d);
}

/**
 * German Steuer-ID (steuerliche Identifikationsnummer): eleven digits, the first not 0; in the first ten one digit is
 * repeated two or three times (three only next to each other is not allowed); ISO 7064 MOD 11,10 check digit.
 */
export function deSteuerIdOk(d: string): boolean {
  if (!/^[1-9]\d{10}$/.test(d)) return false;
  const counts = new Map<string, number>();
  for (const c of d.slice(0, 10)) counts.set(c, (counts.get(c) ?? 0) + 1);
  const rep = [...counts.values()].filter((n) => n > 1);
  if (rep.length !== 1 || rep[0] > 3) return false;
  if (rep[0] === 3 && /(\d)\1\1/.test(d.slice(0, 10))) return false;
  let p = 10;
  for (let i = 0; i < 10; i++) {
    let s = (d.charCodeAt(i) - 48 + p) % 10;
    if (s === 0) s = 10;
    p = (s * 2) % 11;
  }
  const check = (11 - p) % 10;
  return check === d.charCodeAt(10) - 48;
}

/** Chinese resident identity number: region (first digit 1–8), birth date YYYYMMDD, order, ISO 7064 MOD 11-2 check (0–9 or X). */
export function cnIdOk(s: string): boolean {
  if (!/^[1-8]\d{16}[\dX]$/.test(s)) return false;
  const y = Number(s.slice(6, 10)), m = Number(s.slice(10, 12)), d = Number(s.slice(12, 14));
  if (y < 1900 || y > 2100 || !dateOk(y, m, d)) return false;
  const sum = weighted(s, [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]);
  return "10X98765432"[sum % 11] === s[17];
}

/** Korean resident registration number: YYMMDD, a digit 1–8 (sex and century), five digits, check digit (weights 2–9, 2–5). */
export function krRrnOk(d: string): boolean {
  if (!/^\d{6}[1-8]\d{6}$/.test(d)) return false;
  if (!dateOk(2000, Number(d.slice(2, 4)), Number(d.slice(4, 6)))) return false;
  const sum = weighted(d, [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5]);
  return (11 - (sum % 11)) % 10 === d.charCodeAt(12) - 48;
}

/** Singapore NRIC / FIN (series S, T, F, G): seven digits, weights 2,7,6,5,4,3,2 (+4 for T and G), check letter. */
export function sgNricOk(s: string): boolean {
  const m = /^([STFG])(\d{7})([A-Z])$/.exec(s);
  if (!m || allSame(m[2])) return false;
  const sum = weighted(m[2], [2, 7, 6, 5, 4, 3, 2]) + (m[1] === "T" || m[1] === "G" ? 4 : 0);
  const table = m[1] === "S" || m[1] === "T" ? "JZIHGFEDCBA" : "XWUTRQPNMLK";
  return table[sum % 11] === m[3];
}

/** South African ID number: YYMMDD, four digits, citizenship 0/1/2, one digit, Luhn check digit. */
export function zaIdOk(d: string): boolean {
  if (!/^\d{13}$/.test(d)) return false;
  if (!dateOk(2000, Number(d.slice(2, 4)), Number(d.slice(4, 6))) || !"012".includes(d[10])) return false;
  return luhn(d);
}

/** Turkish identity number (T.C. Kimlik No): eleven digits, the first not 0, two check digits. */
export function trTcknOk(d: string): boolean {
  if (!/^[1-9]\d{10}$/.test(d) || allSame(d)) return false;
  const n = d.split("").map(Number);
  const odd = n[0] + n[2] + n[4] + n[6] + n[8], even = n[1] + n[3] + n[5] + n[7];
  if ((((odd * 7 - even) % 10) + 10) % 10 !== n[9]) return false;
  return n.slice(0, 10).reduce((a, b) => a + b, 0) % 10 === n[10];
}

const CURP_CHARS = "0123456789ABCDEFGHIJKLMNÑOPQRSTUVWXYZ";
/** Mexican CURP: four letters, birth date, sex H/M/X, state, three consonants, a homonym character and a check digit. */
export function mxCurpOk(s: string): boolean {
  if (!/^[A-Z][AEIOUX][A-Z]{2}\d{6}[HMX][A-Z]{2}[B-DF-HJ-NP-TV-Z]{3}[A-Z\d]\d$/.test(s)) return false;
  if (!dateOk(2000, Number(s.slice(6, 8)), Number(s.slice(8, 10)))) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += CURP_CHARS.indexOf(s[i]) * (18 - i);
  return (10 - (sum % 10)) % 10 === Number(s[17]);
}

/** Japanese Individual Number (My Number): twelve digits, check digit by weights 2–7, 2–6 from the right. */
export function jpMyNumberOk(d: string): boolean {
  if (!/^\d{12}$/.test(d) || allSame(d)) return false;
  let sum = 0;
  for (let n = 1; n <= 11; n++) sum += (d.charCodeAt(11 - n) - 48) * (n <= 6 ? n + 1 : n - 5);
  const r = sum % 11;
  return (r <= 1 ? 0 : 11 - r) === d.charCodeAt(11) - 48;
}

// ---------------------------------------------------------------- machine readable zone (ICAO Doc 9303)

const mrzValue = (c: string): number => (c === "<" ? 0 : c <= "9" ? c.charCodeAt(0) - 48 : c.charCodeAt(0) - 55);

/** Check digit of an MRZ field: values × 7, 3, 1 repeated, mod 10. */
export function mrzCheck(field: string): number {
  let s = 0;
  for (let i = 0; i < field.length; i++) s += mrzValue(field[i]) * [7, 3, 1][i % 3];
  return s % 10;
}

/**
 * Second line of a TD3 (passport) MRZ, 44 characters: the check digits of the document number, the birth date, the expiry
 * date and the composite agree; the dates are calendar dates. The personal number's check digit may be "<" when it is empty.
 */
export function mrzTd3Ok(line: string): boolean {
  if (!/^[A-Z0-9<]{9}\d[A-Z<]{3}\d{6}\d[MFX<]\d{6}\d[A-Z0-9<]{14}[\d<]\d$/.test(line)) return false;
  const digit = (i: number): number => line.charCodeAt(i) - 48;
  if (mrzCheck(line.slice(0, 9)) !== digit(9)) return false;
  if (mrzCheck(line.slice(13, 19)) !== digit(19)) return false;
  if (mrzCheck(line.slice(21, 27)) !== digit(27)) return false;
  const personal = line.slice(28, 42);
  if (line[42] === "<" ? !/^<{14}$/.test(personal) : mrzCheck(personal) !== digit(42)) return false;
  if (!dateOk(2000, Number(line.slice(15, 17)), Number(line.slice(17, 19)))) return false;
  if (!dateOk(2000, Number(line.slice(23, 25)), Number(line.slice(25, 27)))) return false;
  return mrzCheck(line.slice(0, 10) + line.slice(13, 20) + line.slice(21, 43)) === digit(43);
}
