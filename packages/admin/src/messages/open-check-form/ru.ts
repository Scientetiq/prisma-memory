import type { Messages } from "../../i18n/core";
import type * as en from "./en";
import type { OpenCheckPackName } from "../../lib/open-check-form";

export const REGEXP_PROBLEMS: Messages<typeof en.REGEXP_PROBLEMS> = {
  "Unterminated group": "незакрытая скобка «(»",
  "Unmatched ')'": "лишняя скобка «)»",
  "Unterminated character class": "незакрытая скобка «[»",
  "Lone quantifier brackets": "одиночная «{», «}» или «]» — экранируйте её: \\{",
  "Nothing to repeat": "квантификатору (*, +, ?, {n}) не к чему относиться",
  "Incomplete quantifier": "незаконченный квантификатор {…}",
  "numbers out of order in {} quantifier": "в квантификаторе {n,m} число n больше m",
  "Range out of order in character class": "диапазон в […] задан в обратном порядке",
  "Invalid escape": "лишний «\\»: с флагом u экранируются только особые знаки",
  "\\ at end of pattern": "«\\» в конце шаблона",

  "Invalid group": "неверная группа (?…); модификаторы вроде (?s:…) и (?i:…) сервер не поддерживает — регистр и так не различается",
};

export const OPEN_CHECK_PACK_TITLES: Messages<typeof en.OPEN_CHECK_PACK_TITLES> = {
  core: /* i18n */ "core — secrets, keys, tokens, passwords, cards, phones, e-mail next to a name, contract numbers, amounts (always on)",
  ru: /* i18n */ "ru — Russian identifiers: passport, INN, SNILS",
  intl: /* i18n */ "intl — international personal data",
};

export const TEXT: Messages<typeof en.TEXT> = {
  unknownRulePack: (name: string): string => `Unknown rule pack: ${name}`,
  upTo200Characters: "до 200 знаков",
  aLegalFormWithoutAName: "одна форма собственности без названия",
  atLeast3LettersOr2CharactersIncluding: "от 3 букв (или 2 знака с цифрой) без формы собственности",
  customerNamesMustContain3LettersOr2: (p0: string | number): string => `Название заказчика — от 3 букв (или 2 знака с цифрой: X5) до 200 знаков: ${p0}`,
  atMostNamesTheListHas: (p0: string | number, p1: string | number): string => `Не больше ${p0} названий, в списке ${p1}`,
  matchedInAnyLetterCaseForNames: "ищется в любом регистре",
  matchedInAnyLetterCase: "ищется в любом регистре",
  matchedExactlyAsWrittenUseLowercaseToAlso: (p0: string | number): string => `в тексте ищется только как записано; чтобы искать и «${p0}», запишите строчными`,
  matchedInUppercaseOnly: "ищется только заглавными",
  abbreviationMatchedInAnyLetterCase: "аббревиатура — ищется в любом регистре",
  matchedAs: (p0: string | number): string => `ищется как «${p0}»`,
  ruleNameLatinLettersDigitsAndFrom2: "Имя правила: латиница, цифры и «_», от 2 до 64 знаков",
  theNameNdaIsReservedForTheRule: "Имя nda занято: это правило собирается из списка заказчиков со строгим NDA",
  ruleAlreadyExistsDeleteItOrChooseAnother: (p0: string | number): string => `Правило ${p0} уже есть — удалите его или выберите другое имя`,
  ruleKindMustBeOneOf: (p0: string | number): string => `Вид правила — один из: ${p0}`,
  patternAJavaScriptRegularExpression: "Шаблон: регулярное выражение JavaScript",
  patternMustBeAtMost1000Characters: "Шаблон — до 1000 знаков",
  patternCouldNotBeParsed: (p0: string | number): string => `Шаблон не разбирается: ${p0}`,
  reasonTheRecordSAuthorSeesItIn: "Причина: её увидит автор записи в отказе («похоже на …»)",
  reasonMustBeAtMost200Characters: "Причина — до 200 знаков",
  atMostCustomRules: (p0: string | number): string => `Своих правил не больше ${p0}`,
  ruleFieldFromCharacter: (p0: string | number, p1: string | number, p2: string | number, p3: string | number): string => `${p0} — правило ${p1}, поле «${p2}», с ${p3}-го знака`,
  textInsideImagesAndScannedPagesIsNot: "Text inside images and scanned pages is not checked.",
  ndaProblemEntry: (name: string, reason: string): string => `«${name.slice(0, 40)}${name.length > 40 ? "…" : ""}» — ${reason}`,
  ndaProblems: (problems: readonly string[]): string => problems.join("; "),
  ruleKinds: (kinds: readonly string[]): string => kinds.join(", "),
};

export const OPEN_CHECK_MEDIA_NOTE: Messages<typeof en.OPEN_CHECK_MEDIA_NOTE> = "Text inside images and scanned pages is not checked.";
