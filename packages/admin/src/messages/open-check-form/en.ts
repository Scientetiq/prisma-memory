import type { OpenCheckPackName } from "../../lib/open-check-form";

export const REGEXP_PROBLEMS: Record<string, string> = {
  "Unterminated group": "unclosed “(”",
  "Unmatched ')'": "extra “)”",
  "Unterminated character class": "unclosed “[”",
  "Lone quantifier brackets": "unpaired “{”, “}” or “]” — escape it: \\{",
  "Nothing to repeat": "quantifier (*, +, ?, {n}) has nothing to repeat",
  "Incomplete quantifier": "incomplete quantifier {…}",
  "numbers out of order in {} quantifier": "in quantifier {n,m}, n is greater than m",
  "Range out of order in character class": "character range in […] is reversed",
  "Invalid escape": "extra “\\”: with the u flag, escape only special characters",
  "\\ at end of pattern": "“\\” at the end of the pattern",

  "Invalid group": "invalid group (?…); the server does not support modifiers such as (?s:…) or (?i:…) — matching is already case-insensitive",
};

export const OPEN_CHECK_PACK_TITLES: Record<OpenCheckPackName, string> = {
  core: /* i18n */ "core — secrets, keys, tokens, passwords, cards, phones, e-mail next to a name, contract numbers, amounts (always on)",
  ru: /* i18n */ "ru — Russian identifiers: passport, INN, SNILS",
  intl: /* i18n */ "intl — international personal data",
};

export const TEXT = {
  unknownRulePack: (name: string): string => `Unknown rule pack: ${name}`,
  upTo200Characters: "up to 200 characters",
  aLegalFormWithoutAName: "a legal form without a name",
  atLeast3LettersOr2CharactersIncluding: "at least 3 letters (or 2 characters including a digit), excluding the legal form",
  customerNamesMustContain3LettersOr2: (p0: string | number): string => `Customer names must contain 3 letters (or 2 characters including a digit, such as X5) to 200 characters: ${p0}`,
  atMostNamesTheListHas: (p0: string | number, p1: string | number): string => `At most ${p0} names; the list has ${p1}`,
  matchedInAnyLetterCaseForNames: "matched in any letter case",
  matchedInAnyLetterCase: "matched in any letter case",
  matchedExactlyAsWrittenUseLowercaseToAlso: (p0: string | number): string => `matched exactly as written; use lowercase to also match “${p0}”`,
  matchedInUppercaseOnly: "matched in uppercase only",
  abbreviationMatchedInAnyLetterCase: "abbreviation — matched in any letter case",
  matchedAs: (p0: string | number): string => `matched as “${p0}”`,
  ruleNameLatinLettersDigitsAndFrom2: "Rule name: Latin letters, digits and “_”, from 2 to 64 characters",
  theNameNdaIsReservedForTheRule: "The name nda is reserved for the rule built from the strict NDA customer list",
  ruleAlreadyExistsDeleteItOrChooseAnother: (p0: string | number): string => `Rule ${p0} already exists — delete it or choose another name`,
  ruleKindMustBeOneOf: (p0: string | number): string => `Rule kind must be one of: ${p0}`,
  patternAJavaScriptRegularExpression: "Pattern: a JavaScript regular expression",
  patternMustBeAtMost1000Characters: "Pattern must be at most 1000 characters",
  patternCouldNotBeParsed: (p0: string | number): string => `Pattern could not be parsed: ${p0}`,
  reasonTheRecordSAuthorSeesItIn: "Reason: the record’s author sees it in the rejection (“looks like …”)",
  reasonMustBeAtMost200Characters: "Reason must be at most 200 characters",
  atMostCustomRules: (p0: string | number): string => `At most ${p0} custom rules`,
  ruleFieldFromCharacter: (p0: string | number, p1: string | number, p2: string | number, p3: string | number): string => `${p0} — rule ${p1}, field “${p2}”, from character ${p3}`,
  textInsideImagesAndScannedPagesIsNot: "Text inside images and scanned pages is not checked.",
  ndaProblemEntry: (name: string, reason: string): string => `“${name.slice(0, 40)}${name.length > 40 ? "…" : ""}” — ${reason}`,
  ndaProblems: (problems: readonly string[]): string => problems.join("; "),
  ruleKinds: (kinds: readonly string[]): string => kinds.join(", "),
};

// Compatibility for consumers outside this area; request-scoped UI reads TEXT.
export const OPEN_CHECK_MEDIA_NOTE = "Text inside images and scanned pages is not checked.";
