// The locale of the work at hand. A request runs inside withLocale (AsyncLocalStorage); outside any scope — startup,
// timers, jobs — the process default applies (the instance language, registered by each process at start). tr renders
// in the current locale; trInstance in the instance language and is the one for text that is stored and read later
// (alerts, mail, notices, generated content) — the language of such text must not follow whoever triggered it.
// Order of currentLocale: forced (tests only) → scope → default provider → English. instanceLocale ignores the scope.
import { explain, localeOf, t, type I18nProblem, type Locale, type Message, type ParamsArg } from "./core.ts";
import { i18nState, WARNED_MAX, type I18nState, type ProblemSink } from "./state.ts";

/** A message problem under strict mode (vitest): a missing parameter, a bad count, a missing text. */
export class I18nError extends Error {
  readonly problem: I18nProblem;
  constructor(problem: I18nProblem) {
    super(`i18n ${problem.kind}: ${problem.key}${problem.param ? ` {${problem.param}}` : ""} (${problem.locale})`);
    this.name = "I18nError";
    this.problem = problem;
  }
}

/** Run fn with locale as the current locale; the scope ends when fn returns (or throws), async continuations keep it. */
export function withLocale<R>(locale: Locale, fn: () => R): R {
  return i18nState().als.run(localeOf(locale), fn);
}

function providerLocale(s: I18nState): Locale {
  if (!s.provider) return "en";
  try {
    return localeOf(s.provider());
  } catch {
    return "en";
  }
}

/** The locale of the current scope: forced (tests) → scope → default provider → English. */
export function currentLocale(): Locale {
  const s = i18nState();
  return s.forced ?? s.als.getStore() ?? providerLocale(s);
}

/** The instance language: forced (tests) → default provider → English. Ignores the request scope. */
export function instanceLocale(): Locale {
  const s = i18nState();
  return s.forced ?? providerLocale(s);
}

function report(s: I18nState, problems: readonly I18nProblem[]): void {
  for (const p of problems) {
    const id = `${p.kind}:${p.key}:${p.param ?? ""}`;
    if (s.warned.has(id) || s.warned.size >= WARNED_MAX) continue;
    s.warned.add(id);
    try {
      s.sink(p);
    } catch {
      // a broken sink must not break the text it reports on
    }
  }
}

function render(locale: Locale, m: Message<unknown>, args: readonly unknown[]): string {
  const s = i18nState();
  const own = args[0];
  // A caller's undefined (an optional value passed through) does not hide the installation's {product} / {org}.
  // Object.fromEntries defines own properties, so a key named __proto__ stays a plain key.
  const given = typeof own === "object" && own !== null
    ? Object.fromEntries(Object.entries(own).filter(([, v]) => v !== undefined))
    : {};
  const params = { ...s.globals, ...given };
  const problems = explain(locale, m, params);
  if (problems.length) {
    if (s.strict) throw new I18nError(problems[0]!);
    report(s, problems);
  }
  return t(locale, m, params);
}

/** Render in the current locale (request text). {product} and {org} come from setGlobalParams unless passed. */
export function tr<P>(m: Message<P>, ...params: ParamsArg<P>): string {
  return render(currentLocale(), m as Message<unknown>, params);
}

/** Render in the instance language: stored text, mail, alerts, notices, jobs. */
export function trInstance<P>(m: Message<P>, ...params: ParamsArg<P>): string {
  return render(instanceLocale(), m as Message<unknown>, params);
}

/** The process default locale (the instance language); the last call wins. A throwing or garbage provider means English. */
export function setDefaultLocaleProvider(fn: () => Locale): void {
  if (typeof fn !== "function") throw new TypeError("setDefaultLocaleProvider: a function is required");
  i18nState().provider = fn;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const clean = (name: string, v: unknown): string => {
  if (typeof v !== "string") throw new TypeError(`setGlobalParams: ${name} must be a string`);
  return Array.from(v.replace(CONTROL, " ")).slice(0, 200).join("");
};

/**
 * Values of {product} and {org}: one line each (control characters become spaces), at most 200 characters, counted in
 * code points so that a surrogate pair is never split.
 */
export function setGlobalParams(p: { product: string; org: string }): void {
  if (typeof p !== "object" || p === null) throw new TypeError("setGlobalParams: an object is required");
  i18nState().globals = { product: clean("product", p.product), org: clean("org", p.org) };
}

/** Where problems of tr/trInstance go outside strict mode (default: one JSON line on console.warn, names only). */
export function setProblemSink(fn: ProblemSink): void {
  if (typeof fn !== "function") throw new TypeError("setProblemSink: a function is required");
  i18nState().sink = fn;
}
