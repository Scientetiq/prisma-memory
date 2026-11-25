// Core of the message catalog: locales, typed two-language messages, single-pass substitution, plural rules and
// Accept-Language negotiation. Pure and dependency-free, safe for the browser: no module state, no host objects, no
// regional literals. The panel keeps a byte copy (byte copy: packages/admin/src/i18n/core.ts) — change both in one commit;
// A unit test compares the two files and keeps this one free of everything above.

/** Supported languages. English is the default; Russian is a locale an installation switches on. */
export const LOCALES = ["en", "ru"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

/** A supported locale exactly as given; anything else (other case, region tags, empty, non-strings) is English. */
export function localeOf(v: unknown): Locale {
  return (LOCALES as readonly unknown[]).includes(v) ? (v as Locale) : DEFAULT_LOCALE;
}

// ---------------------------------------------------------------------------------------------------------------- plurals

export type PluralCategory = "one" | "few" | "many" | "other";

/**
 * Plural category of n, coded so that the result does not depend on the runtime's locale data. Russian: fractions and
 * non-finite numbers are "other"; for integers 11–19 (mod 100) are "many", 1 (mod 10) "one", 2–4 (mod 10) "few", the rest
 * "many". English: |n| = 1 is "one", everything else "other".
 */
export function pluralCategory(locale: Locale, n: number): PluralCategory {
  if (locale === "ru") {
    if (!Number.isInteger(n)) return "other";
    const a = Math.abs(n) % 100, b = a % 10;
    if (a >= 11 && a <= 19) return "many";
    if (b === 1) return "one";
    if (b >= 2 && b <= 4) return "few";
    return "many";
  }
  return Math.abs(n) === 1 ? "one" : "other";
}

/**
 * Russian noun form for n: pluralRu(5, [one, few, many]) is the "many" form. The algorithm of the panel's former plural
 * helper, kept as it was (also for fractions: 2.5 takes the "few" form).
 */
export function pluralRu(n: number, forms: readonly [string, string, string]): string {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b === 1) return forms[0];
  if (b >= 2 && b <= 4) return forms[1];
  return forms[2];
}

/** English noun form for n: one for |n| = 1, other otherwise. */
export function pluralEn(n: number, one: string, other: string): string {
  return Math.abs(n) === 1 ? one : other;
}

// --------------------------------------------------------------------------------------------------------- typed catalogs

/**
 * Shape of a typed catalog in another language: ru is typed Messages<typeof en>. Strings widen to string, functions keep
 * their parameter lists, objects and arrays keep their keys.
 */
export type Messages<T> =
  T extends string ? string
  : T extends (...args: infer A) => infer R ? (...args: A) => Messages<R>
  : T extends object ? { readonly [K in keyof T]: Messages<T[K]> }
  : T;

/** Forms of a plural message; the form is chosen by the parameter count. */
export interface PluralForms { readonly one?: string; readonly few?: string; readonly many?: string; readonly other: string }
export interface PluralMessage<F extends PluralForms = PluralForms> { readonly plural: F }

/** A plural text: en takes one and other, ru takes one, few, many and other. */
export function plural<const F extends PluralForms>(forms: F): PluralMessage<F> {
  return Object.freeze({ plural: Object.freeze({ ...forms }) }) as PluralMessage<F>;
}

type EnText = string | PluralMessage<{ readonly one: string; readonly other: string }>;
type RuText = string | PluralMessage<{ readonly one: string; readonly few: string; readonly many: string; readonly other: string }>;

/** A table of messages as written in a messages file: every entry has both languages. */
export type Table = Record<string, { readonly en: EnText; readonly ru: RuText }>;

/** Parameters filled from the installation (setGlobalParams); a caller may still pass its own. */
export const RESERVED_PARAMS = ["product", "org"] as const;
type ReservedParam = (typeof RESERVED_PARAMS)[number];

declare const PARAMS: unique symbol;

/** One message: its key and both texts. P (the parameters) exists only for the type checker. */
export interface Message<P = {}> {
  readonly key: string;
  readonly en: EnText;
  readonly ru: RuText;
  readonly [PARAMS]?: P;
}

/** The parameter argument of t/tr: optional when the message needs none. */
export type ParamsArg<P> = {} extends P ? [params?: P] : [params: P];

type Upper = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J" | "K" | "L" | "M" | "N" | "O" | "P" | "Q" | "R" | "S" | "T"
  | "U" | "V" | "W" | "X" | "Y" | "Z";
type NameHead = Upper | Lowercase<Upper> | "_";
type NameChar = NameHead | "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
type NameTail<S extends string> = S extends "" ? true : S extends `${infer C}${infer R}` ? (C extends NameChar ? NameTail<R> : false) : false;
type IsName<S extends string> = S extends `${infer C}${infer R}` ? (C extends NameHead ? NameTail<R> : false) : false;

/**
 * Placeholder names of one text, by the same rule as the substitution: {name} with name = [A-Za-z_][A-Za-z0-9_]*.
 * Tail-recursive (names are collected in Acc), so a long text with many placeholders keeps its parameter check.
 */
type NamesIn<S extends string, Acc extends string = never> =
  S extends `${string}{${infer Body}}${infer Rest}`
    ? Body extends `${string}{${infer Inner}`
      ? NamesIn<`{${Inner}}${Rest}`, Acc>
      : NamesIn<Rest, Acc | (IsName<Body> extends true ? Body : never)>
    : Acc;

type FormNames<F> = { [K in keyof F]-?: NonNullable<F[K]> extends string ? NamesIn<NonNullable<F[K]>> : never }[keyof F];
type TextNames<T> = T extends string ? NamesIn<T> : T extends PluralMessage<infer F> ? FormNames<F> : never;
type IsPluralText<T> = T extends PluralMessage<PluralForms> ? true : false;
type AnyPlural<E extends Table[string]> = true extends IsPluralText<E["en"]> | IsPluralText<E["ru"]> ? true : false;

/** Parameters of an entry: names of the English text(s); count is a number when either language is plural. */
export type ParamsOf<E extends Table[string]> =
  { [K in Extract<Exclude<TextNames<E["en"]>, ReservedParam | "count">, string>]: string | number }
  & (AnyPlural<E> extends true ? { count: number } : "count" extends TextNames<E["en"]> ? { count: string | number } : {})
  & { [K in ReservedParam]?: string | number };

export type MessageSet<T extends Table> = { readonly [K in keyof T]: Message<ParamsOf<T[K]>> };

/** A ru text may leave out a parameter of the en text, never use one the en text lacks. */
type RuCheck<E> = E extends Table[string]
  ? [Exclude<TextNames<E["ru"]>, TextNames<E["en"]> | ReservedParam>] extends [never]
    ? unknown
    : { readonly ru: `ru uses a placeholder the en text lacks: ${Exclude<TextNames<E["ru"]>, TextNames<E["en"]> | ReservedParam>}` }
  : unknown;

/**
 * Messages of one area. Keys are `${ns}.${name}`. Nothing is registered: defining the same namespace twice (a module
 * evaluated again) is harmless. The result and its entries are frozen.
 */
export function defineMessages<const T extends Table>(ns: string, table: T & { readonly [K in keyof T]: RuCheck<T[K]> }): MessageSet<T> {
  const entries = Object.keys(table).map((name) => {
    const e = table[name]!;
    return [name, Object.freeze({ key: `${ns}.${name}`, en: e.en, ru: e.ru })] as const;
  });
  return Object.freeze(Object.fromEntries(entries)) as unknown as MessageSet<T>;
}

// ------------------------------------------------------------------------------------------------------------ rendering

type Params = Readonly<Record<string, unknown>>;

const paramsOf = (args: readonly unknown[]): Params | undefined => {
  const p = args[0];
  return typeof p === "object" && p !== null ? (p as Params) : undefined;
};

const own = (p: Params | undefined, name: string): unknown => (p !== undefined && Object.hasOwn(p, name) ? p[name] : undefined);

const usable = (v: unknown): v is string | number => typeof v === "string" || typeof v === "number";

const isPlural = (v: unknown): v is PluralMessage =>
  typeof v === "object" && v !== null && Object.hasOwn(v, "plural") && typeof (v as PluralMessage).plural === "object"
  && (v as PluralMessage).plural !== null && typeof (v as PluralMessage).plural.other === "string";

/** The text to render: the locale's text (the plural form by count), else the English one; null when neither exists. */
function textOf(locale: Locale, m: Message<unknown>, p: Params | undefined): string | null {
  for (const loc of locale === "en" ? (["en"] as const) : ([locale, "en"] as const)) {
    const raw: unknown = m[loc];
    if (typeof raw === "string") return raw;
    if (isPlural(raw)) {
      const count = own(p, "count");
      const cat = typeof count === "number" ? pluralCategory(loc, count) : "other";
      const form = Object.hasOwn(raw.plural, cat) ? raw.plural[cat] : undefined;
      return typeof form === "string" ? form : raw.plural.other;
    }
  }
  return null;
}

/**
 * Render a message in a locale. Pure: never throws on a missing parameter, never logs. Substitution is one pass over the
 * text — a parameter value is never scanned for placeholders. Values are strings or numbers (String(v), no digit
 * grouping); a missing parameter or a value of another type leaves the placeholder as it is. An unknown locale is English.
 */
export function t<P>(locale: Locale, m: Message<P>, ...params: ParamsArg<P>): string {
  const loc = localeOf(locale);
  const p = paramsOf(params);
  const text = textOf(loc, m as Message<unknown>, p);
  if (text === null) return m.key;
  return text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole: string, name: string) => {
    const v = own(p, name);
    return usable(v) ? String(v) : whole;
  });
}

/** What would go wrong rendering a message: names only, never parameter values or text. */
export interface I18nProblem {
  readonly kind: "missing_param" | "bad_count" | "missing_text";
  readonly key: string;
  readonly param?: string;
  readonly locale: Locale;
}

/** The companion of t for callers that report problems: same text choice, same placeholder scan. */
export function explain<P>(locale: Locale, m: Message<P>, ...params: ParamsArg<P>): I18nProblem[] {
  const loc = localeOf(locale);
  const p = paramsOf(params);
  const out: I18nProblem[] = [];
  const text = textOf(loc, m as Message<unknown>, p);
  if (text === null) return [{ kind: "missing_text", key: m.key, locale: loc }];
  const raw: unknown = m[loc];
  if (typeof raw !== "string" && isPlural(raw)) {
    const count = own(p, "count");
    if (count === undefined) out.push({ kind: "missing_param", key: m.key, param: "count", locale: loc });
    else if (typeof count !== "number" || !Number.isFinite(count)) out.push({ kind: "bad_count", key: m.key, param: "count", locale: loc });
  } else if (typeof raw !== "string") {
    out.push({ kind: "missing_text", key: m.key, locale: loc });
  }
  const seen = new Set<string>();
  for (const match of text.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    const name = match[1]!;
    if (seen.has(name)) continue;
    seen.add(name);
    if (!usable(own(p, name)) && !(name === "count" && out.some((x) => x.param === "count"))) {
      out.push({ kind: "missing_param", key: m.key, param: name, locale: loc });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------- negotiation

const TAG = /^[a-z]{1,8}(-[a-z0-9]{1,8})*$/;
const QVALUE = /^(0(\.\d{0,3})?|1(\.0{0,3})?)$/;

/**
 * The best supported locale of an Accept-Language header, or null. Bounded work: the first 256 characters and the first
 * 10 ranges; a range cut by the 256-character bound is dropped (read whole or not at all). Each range is a language tag
 * with at most one q parameter; a malformed range is ignored, q=0 never wins, the highest q wins and ties go to the
 * earlier range. Only the primary subtag counts (a region tag is its language); "*" and other languages are ignored.
 * Never throws.
 */
export function negotiate(acceptLanguage: string | null | undefined): Locale | null {
  if (typeof acceptLanguage !== "string") return null;
  let head = acceptLanguage.slice(0, 256);
  if (acceptLanguage.length > 256 && acceptLanguage[256] !== ",") head = head.slice(0, Math.max(0, head.lastIndexOf(",")));
  let best: Locale | null = null;
  let bestQ = 0;
  for (const range of head.split(",", 10)) {
    const parts = range.split(";");
    if (parts.length > 2) continue;
    const tag = parts[0]!.trim().toLowerCase();
    if (!TAG.test(tag)) continue;
    let q = 1;
    if (parts.length === 2) {
      const param = parts[1]!.trim();
      if (param.slice(0, 2).toLowerCase() !== "q=") continue;
      const value = param.slice(2);
      if (!QVALUE.test(value)) continue;
      q = Number(value);
    }
    if (q <= 0) continue;
    const primary = tag.split("-", 1)[0];
    const loc = primary === "ru" ? "ru" : primary === "en" ? "en" : null;
    if (loc !== null && q > bestQ) {
      best = loc;
      bestQ = q;
    }
  }
  return best;
}
