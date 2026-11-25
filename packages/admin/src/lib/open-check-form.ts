import { REGEXP_PROBLEMS, OPEN_CHECK_PACK_TITLES, TEXT } from "../messages/open-check-form";
import { OPEN_CHECK_EXTRA_KINDS, OPEN_CHECK_FIELD_TITLES } from "./labels";
import type { OpenCheckExtraRule, OpenCheckFinding } from "./types";

export const NDA_MAX = 1000;
export const EXTRA_RULES_MAX = 100;
export const TEST_TEXT_MAX = 200_000;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const NDA_LEGAL_SHORT: ReadonlySet<string> = new Set(("ооо оао зао пао ао нао нко ано ип фгуп гуп муп фгбу фгбоу гбу мбу мку тоо чп гк нпо нпп нпф нии тд "
  + "llc ltd inc gmbh jsc pjsc ojsc cjsc plc corp co ag sa bv oy ab lp llp").split(" "));
const NDA_LEGAL_LONG = ["общество с ограниченной ответственностью", "непубличное акционерное общество", "публичное акционерное общество",
  "закрытое акционерное общество", "открытое акционерное общество", "акционерное общество", "индивидуальный предприниматель",
  "федеральное государственное унитарное предприятие", "государственное унитарное предприятие", "муниципальное унитарное предприятие",
  "автономная некоммерческая организация", "некоммерческая организация", "limited liability company", "joint stock company"].map((f) => f.split(" "));
const NDA_ORG_LEAD = ["группа компаний", "торговый дом", "научно производственное объединение", "научно производственное предприятие",
  "концерн", "холдинг", "корпорация", "компания", "group of companies"].map((f) => f.split(" "));

interface NdaWord { w: string; low: string; at: number }

function ndaSignificant(name: string): NdaWord[] {
  const words: NdaWord[] = [...name.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({ w: m[0], low: m[0].toLowerCase().replace(/ё/g, "е"), at: m.index ?? 0 }));
  const startsWith = (f: string[], at: number) => at >= 0 && f.every((x, i) => words[at + i]?.low === x);
  for (let changed = true; changed && words.length;) {
    changed = false;
    if (NDA_LEGAL_SHORT.has(words[0].low)) { words.splice(0, 1); changed = true; }
    else if (NDA_LEGAL_SHORT.has(words[words.length - 1].low)) { words.splice(words.length - 1, 1); changed = true; }
    for (const f of NDA_LEGAL_LONG) {
      if (startsWith(f, 0)) { words.splice(0, f.length); changed = true; }
      else if (words.length > f.length && startsWith(f, words.length - f.length)) { words.splice(words.length - f.length, f.length); changed = true; }
    }
    for (const f of NDA_ORG_LEAD) if (words.length > f.length && startsWith(f, 0)) { words.splice(0, f.length); changed = true; }
  }
  return words;
}

const ndaShort = (s: string): boolean => s.length === 2 && /\d/.test(s) && /\p{L}/u.test(s);

function ndaNameProblem(name: string): string | null {
  if (name.length > 200) return TEXT.upTo200Characters;
  const words = ndaSignificant(name), joined = words.map((x) => x.w).join("");
  if (!words.length) return TEXT.aLegalFormWithoutAName;
  if (joined.length < 3 && !ndaShort(joined)) return TEXT.atLeast3LettersOr2CharactersIncluding;
  return null;
}

export function parseNdaLines(raw: string): Parsed<string[]> {
  const out: string[] = [], seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const name = line.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  const bad = out.map((n) => [n, ndaNameProblem(n)] as const).filter(([, why]) => why !== null);
  if (bad.length) {
    const list = TEXT.ndaProblems(bad.slice(0, 3).map(([n, why]) => TEXT.ndaProblemEntry(n, String(why))));
    return { ok: false, error: TEXT.customerNamesMustContain3LettersOr2(String(list)) };
  }
  if (out.length > NDA_MAX) return { ok: false, error: TEXT.atMostNamesTheListHas(String(NDA_MAX), String(out.length)) };
  return { ok: true, value: out };
}

export function ndaCaseNote(name: string): string | null {
  const words = ndaSignificant(name);
  if (!words.length) return null;
  const joined = words.map((x) => x.w).join("");
  if (ndaShort(joined)) {
    const low = joined.toLowerCase();
    return joined === low ? TEXT.matchedInAnyLetterCase : TEXT.matchedExactlyAsWrittenUseLowercaseToAlso(String(low));
  }
  const lead = words.length > 1 && words[0].low === "банк" ? 1 : 0;
  const rest = words.slice(lead), letters = rest.map((x) => x.w).join("").replace(/[^\p{L}]/gu, ""), first = letters[0] ?? "";
  if (!first) return null;
  if (first !== first.toUpperCase()) return TEXT.matchedInAnyLetterCaseForNames;
  if (letters.length < 2 || letters !== letters.toUpperCase()) return null;
  const w = rest.find((x) => /\p{L}/u.test(x.w))?.low ?? "";
  if (/^[a-z]/.test(w) && letters.length <= 3) return TEXT.matchedInUppercaseOnly;
  if (!/^[a-z]/.test(w) && !/[аеиоуыэюя]/.test(w)) return TEXT.abbreviationMatchedInAnyLetterCase;
  let cap = "", pos = 0;
  for (const x of words) {
    cap += name.slice(pos, x.at) + (/^\p{L}/u.test(x.w) ? x.w[0] + x.w.slice(1).toLowerCase() : x.w.toLowerCase());
    pos = x.at + x.w.length;
  }
  return TEXT.matchedAs(String((cap + name.slice(pos)).trim()));
}


export function regexpProblem(e: unknown): string {
  const why = String(e instanceof Error ? e.message : e).replace(/^Invalid regular expression: \/[\s\S]*\/[a-z]*: /, "");
  return REGEXP_PROBLEMS[why] ?? why.slice(0, 160);
}

export function parseExtraRule(input: { name: string; kind: string; pattern: string; reason: string }, existing: readonly OpenCheckExtraRule[]): Parsed<OpenCheckExtraRule> {
  const name = input.name.trim(), kind = input.kind.trim(), pattern = input.pattern, reason = input.reason.trim();
  if (!/^[A-Za-z0-9_]{2,64}$/.test(name)) return { ok: false, error: TEXT.ruleNameLatinLettersDigitsAndFrom2 };
  if (name === "nda") return { ok: false, error: TEXT.theNameNdaIsReservedForTheRule };
  if (existing.some((r) => r.name === name)) return { ok: false, error: TEXT.ruleAlreadyExistsDeleteItOrChooseAnother(String(name)) };
  if (!(OPEN_CHECK_EXTRA_KINDS as readonly string[]).includes(kind)) return { ok: false, error: TEXT.ruleKindMustBeOneOf(TEXT.ruleKinds(OPEN_CHECK_EXTRA_KINDS)) };
  if (!pattern.trim()) return { ok: false, error: TEXT.patternAJavaScriptRegularExpression };
  if (pattern.length > 1000) return { ok: false, error: TEXT.patternMustBeAtMost1000Characters };
  try { new RegExp(pattern, "giu"); } catch (e) { return { ok: false, error: TEXT.patternCouldNotBeParsed(String(regexpProblem(e))) }; }
  if (!reason) return { ok: false, error: TEXT.reasonTheRecordSAuthorSeesItIn };
  if (reason.length > 200) return { ok: false, error: TEXT.reasonMustBeAtMost200Characters };
  if (existing.length >= EXTRA_RULES_MAX) return { ok: false, error: TEXT.atMostCustomRules(String(EXTRA_RULES_MAX)) };
  return { ok: true, value: { name, kind, pattern, reason } };
}

export const findingLine = (f: OpenCheckFinding): string =>
  TEXT.ruleFieldFromCharacter(String(f.reason), String(f.rule), String(OPEN_CHECK_FIELD_TITLES[f.field] ?? f.field), String(f.at + 1));

// ---------------------------------------------------------------- rule packs
/**
 * Rule packs of the open check — a hand copy of OPEN_CHECK_PACKS in packages/shared/src/open-check-packs.ts (the panel is
 * built without @memory/shared; a unit test compares the two). core cannot be removed.
 */
export const OPEN_CHECK_PACK_NAMES = ["core", "ru", "intl"] as const;
export type OpenCheckPackName = (typeof OPEN_CHECK_PACK_NAMES)[number];
const PACK_NAMES: ReadonlySet<string> = new Set(OPEN_CHECK_PACK_NAMES);

/** Short description of each pack for the panel. */
export { OPEN_CHECK_PACK_TITLES } from "../messages/open-check-form";

/** The fact the open check states everywhere a record is shown to agents: it reads text only. */
export { OPEN_CHECK_MEDIA_NOTE } from "../messages/open-check-form/en";

/** Packs in force for a stored value, as the gateway reads it: a valid list — its packs; anything else — every pack. */
export function effectivePacks(value: unknown): OpenCheckPackName[] {
  const ok = Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string" && PACK_NAMES.has(v))
    && new Set(value).size === value.length && value.includes("core");
  return OPEN_CHECK_PACK_NAMES.filter((p) => (ok ? (value as string[]).includes(p) : true));
}

/** Packs from the form (check boxes named `pack`): core is always kept, the order is the canonical one, an unknown name is refused. */
export function parsePacks(fd: FormData): Parsed<OpenCheckPackName[]> {
  const picked = fd.getAll("pack").map(String);
  const unknown = picked.filter((p) => !PACK_NAMES.has(p));
  if (unknown.length) return { ok: false, error: TEXT.unknownRulePack(unknown[0].slice(0, 40)) };
  const on = new Set<string>(["core", ...picked]);
  return { ok: true, value: OPEN_CHECK_PACK_NAMES.filter((p) => on.has(p)) };
}
