// Locale of the current request and locale-aware dictionaries of the panel.
//
// Client-safe: no Node import, and no DOM types (the tests of other packages compile lib modules that import this layer
// without the DOM library). On the server the locale comes from a request scope (an AsyncLocalStorage that the
// preload module puts on globalThis[SCOPE_KEY]) and from the instance values (globalThis[INSTANCE_KEY], written by
// setInstance); in the browser from <html lang>, <html data-tz> and <html data-product>. Everything that matters is kept
// on globalThis, because Next evaluates a module more than once (server-component and SSR layers) and the tests
// re-evaluate modules; module-level variables below are pure caches only. Nothing here logs, fetches or starts a timer:
// on the server, reading the language or the zone only nudges the instance reader that instrumentation.ts installed.
import { DEFAULT_LOCALE, LOCALES, localeOf, type Locale, type Messages } from "./core";

/** A locale of the request scope: a supported locale, or the pseudo-locale "xx" (tests only, never in production). */
export type ScopeLocale = Locale | "xx";

/** What the request scope holds: the locale cookie (already validated) and the locale a caller forced with withLocale. */
export interface LocaleScope {
  readonly cookie: Locale | null;
  readonly forced?: ScopeLocale;
}

/** globalThis[SCOPE_KEY] is an AsyncLocalStorage<LocaleScope>; this module never creates it (the preload module does). */
export const SCOPE_KEY = "__memoryRequestLocale";
/** globalThis[INSTANCE_KEY] holds the frozen InstanceValues of this process. */
export const INSTANCE_KEY = "__memoryInstance";
/** globalThis[READER_HOOK_KEY] is the instance reader of the server process (src/i18n/instance.server.ts), if started. */
export const READER_HOOK_KEY = "__memoryInstanceReader";

/** Values of the installation: interface language, time zone and product name; epoch counts the changes. */
export interface InstanceValues {
  readonly language: Locale | null;
  readonly timezone: string | null;
  readonly productName: string | null;
  readonly epoch: number;
}

interface ScopeHost {
  getStore(): unknown;
  run<R>(store: LocaleScope, fn: () => R): R;
}

const G = globalThis as unknown as Record<string, unknown>;
const EMPTY_INSTANCE: InstanceValues = Object.freeze({ language: null, timezone: null, productName: null, epoch: 0 });
// Separate from the replaceable slot, shared by every evaluation of this module. Never restore or reset this clock.
const INSTANCE_CLOCK_KEY = "__memoryInstanceClock";
interface InstanceClock {
  slot: unknown;
  value: InstanceValues;
}
const OPEN = "\u27E6";
const CLOSE = "\u27E7";

function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (LOCALES as readonly string[]).includes(v);
}

function isObject(v: unknown): v is object {
  return typeof v === "object" && v !== null;
}

function isProduction(): boolean {
  try {
    return typeof process !== "undefined" && process.env.NODE_ENV === "production";
  } catch {
    return false;
  }
}

/** The root element as far as this module reads it; typed here so that the module compiles without the DOM library. */
interface HtmlRoot {
  readonly lang?: unknown;
  readonly dataset?: Readonly<Record<string, unknown>>;
}

function inBrowser(): boolean {
  return typeof G.document !== "undefined";
}

function scopeHost(): ScopeHost | null {
  const h = G[SCOPE_KEY] as Partial<ScopeHost> | undefined;
  return isObject(h) && typeof h.getStore === "function" && typeof h.run === "function" ? (h as ScopeHost) : null;
}

function readScope(): LocaleScope | null {
  try {
    const s = scopeHost()?.getStore();
    return isObject(s) ? (s as LocaleScope) : null;
  } catch {
    return null;
  }
}

/** Lets the server's instance reader refresh stale values in the background (it decides; this never waits or throws). */
function kickReader(): void {
  try {
    const r = G[READER_HOOK_KEY] as { maybeRefresh?: unknown } | undefined;
    if (isObject(r) && typeof r.maybeRefresh === "function") (r.maybeRefresh as () => void)();
  } catch {
    // the reader is optional
  }
}

function htmlAttr(name: "lang" | "tz" | "product"): string | null {
  try {
    const el = (G.document as { documentElement?: HtmlRoot } | undefined)?.documentElement;
    const v = name === "lang" ? el?.lang : el?.dataset?.[name];
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------------- the locale

/**
 * The locale of a request: the first candidate that is exactly a supported locale, in the order test override,
 * cookie, profile preference, instance setting; otherwise the default (English). Other case, region tags and
 * non-strings are skipped, not mapped.
 */
export function resolveLocale(s: { override?: unknown; cookie?: unknown; profile?: unknown; instance?: unknown }): Locale {
  const src = isObject(s) ? s : {};
  for (const v of [src.override, src.cookie, src.profile, src.instance]) if (isLocale(v)) return v;
  return DEFAULT_LOCALE;
}

/** The locale to render in now: always "en" or "ru". Never throws. */
export function currentLocale(): Locale {
  if (inBrowser()) return localeOf(htmlAttr("lang"));
  kickReader();
  const scope = readScope();
  const forced = scope?.forced;
  return resolveLocale({ override: forced === "xx" ? "en" : forced, cookie: scope?.cookie, instance: getInstance().language });
}

/** True while a test renders under the pseudo-locale (server side only; never in production). */
export function isPseudo(): boolean {
  return !inBrowser() && readScope()?.forced === "xx" && !isProduction();
}

/**
 * Runs fn with the locale forced to the given one (the cookie of the current scope is kept). "xx" renders English with
 * every string bracketed, for tests only. Needs the request scope of the preload module.
 */
export function withLocale<R>(locale: ScopeLocale, fn: () => R): R {
  const raw: unknown = locale;
  if (raw !== "en" && raw !== "ru" && raw !== "xx") throw new TypeError(`withLocale: unsupported locale ${typeof raw === "string" ? JSON.stringify(raw.slice(0, 20)) : typeof raw}`);
  if (locale === "xx" && isProduction()) throw new TypeError("withLocale: the pseudo-locale is for tests only");
  const host = scopeHost();
  if (!host) throw new Error("withLocale: no request locale scope on globalThis (the preload module is not loaded)");
  const current = readScope();
  return host.run(Object.freeze({ cookie: isLocale(current?.cookie) ? current.cookie : null, forced: locale }), fn);
}

// ---------------------------------------------------------------------------------------------- the instance values

const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;
/**
 * Format characters (zero-width, bidi controls, the byte order mark): invisible, dropped — except the joiners U+200C and
 * U+200D, which carry meaning between visible characters (Persian words, emoji sequences); a run of them keeps its first.
 */
const FORMAT = /\p{Cf}/gu;
const isJoiner = (c: string): boolean => c === "‌" || c === "‍";
const JOINERS = /[‌‍]+/gu;
const BLANK = /[\s\p{Cc}]/u;
const NAME_MAX = 80;

/** Joiners only between two visible characters (not at an edge, not next to a space or a control); linear in the length. */
function keepJoiners(s: string): string {
  return s.replace(JOINERS, (run: string, at: number) => {
    const before = s[at - 1];
    const after = s[at + run.length];
    // a code unit is enough: a surrogate half is no space and no control, so an emoji counts as visible
    return before !== undefined && after !== undefined && !BLANK.test(before) && !BLANK.test(after) ? run[0]! : "";
  });
}

function cleanName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = keepJoiners(v.replace(FORMAT, (c) => (isJoiner(c) ? c : "")).replace(CONTROL, " ")).trim();
  let out = "";
  let n = 0;
  for (const ch of s) {
    if (n++ === NAME_MAX) break;
    out += ch;
  }
  out = keepJoiners(out).trimEnd();
  return out === "" ? null : out;
}

/** An IANA time zone that Intl of this runtime knows: the rule of the panel's isTimeZone. */
export function isZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz === "" || tz.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function read(v: object, key: string): unknown {
  try {
    return (v as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** Validated instance values; the epoch counts observed slot changes, including deletion and restoration. */
export function getInstance(): InstanceValues {
  const clock = (G[INSTANCE_CLOCK_KEY] ??= { slot: undefined, value: EMPTY_INSTANCE }) as InstanceClock;
  const v = G[INSTANCE_KEY];
  if (v !== clock.slot) {
    const x = isObject(v) ? v as Partial<InstanceValues> : null;
    const valid = x && Object.isFrozen(x) && (x.language === null || isLocale(x.language)) && (x.timezone === null || typeof x.timezone === "string")
      && (x.productName === null || typeof x.productName === "string") && typeof x.epoch === "number";
    const values = valid ? x as InstanceValues : EMPTY_INSTANCE;
    clock.value = Object.freeze({ language: values.language, timezone: values.timezone, productName: values.productName, epoch: clock.value.epoch + 1 });
    clock.slot = v;
  }
  return clock.value;
}

/**
 * Stores changed instance values in a frozen object. A language is kept only if it is exactly a supported locale, a zone
 * only if Intl knows it, a product name loses its format characters and control characters, is trimmed and cut to 80
 * characters (a name left empty is null); anything else is stored as null. null clears all three. Equal values keep
 * the slot; a changed, deleted, restored or foreign slot advances a separate monotonic epoch on its next read.
 * Never throws.
 */
export function setInstance(v: { language?: unknown; timezone?: unknown; productName?: unknown } | null): void {
  try {
    const prev = getInstance();
    const src = isObject(v) ? v : null;
    const lang = src ? read(src, "language") : null;
    const tz = src ? read(src, "timezone") : null;
    const language = isLocale(lang) ? lang : null;
    const timezone = isZone(tz) ? tz : null;
    const productName = src ? cleanName(read(src, "productName")) : null;
    const changed = language !== prev.language || timezone !== prev.timezone || productName !== prev.productName;
    if (changed) {
      G[INSTANCE_KEY] = Object.freeze({ language, timezone, productName, epoch: prev.epoch + 1 });
      getInstance();
    }
  } catch {
    // a hostile value or a sealed global: keep what was there
  }
}

let tzMemo: { raw: string | null; value: string } | null = null;

/** Time zone of the installation: in the browser from <html data-tz>, on the server from the instance values; else UTC. */
export function instanceTz(): string {
  if (inBrowser()) {
    const raw = htmlAttr("tz");
    if (tzMemo === null || tzMemo.raw !== raw) tzMemo = { raw, value: isZone(raw) ? raw : "UTC" };
    return tzMemo.value;
  }
  kickReader();
  return getInstance().timezone ?? "UTC";
}

/** Product name the installation set (browser: <html data-product>), or null for the catalog default. */
export function instanceProductName(): string | null {
  return inBrowser() ? cleanName(htmlAttr("product")) : getInstance().productName;
}

// -------------------------------------------------------------------------------------------------------- the views

const PSEUDO_FNS = new WeakMap<Function, Function>();

function pseudoString(s: string): string {
  return s === "" ? s : `${OPEN}${s}${CLOSE}`;
}

function pseudoFn(fn: Function): Function {
  let w = PSEUDO_FNS.get(fn);
  if (!w) {
    w = function (this: unknown, ...args: unknown[]): unknown {
      const r: unknown = Reflect.apply(fn, this, args);
      return typeof r === "string" ? pseudoString(r) : r;
    };
    PSEUDO_FNS.set(fn, w);
  }
  return w;
}

/**
 * A read-only view of the object or array that pick() returns at the moment of each access. Own object-valued keys
 * answer with a child view (cached, so X.a === X.a); under the pseudo-locale (wrap) strings and the string results of
 * functions are bracketed. Inherited and symbol keys answer as on the plain value. Never mutated.
 */
function view(pick: () => object, isArray: boolean, wrap: boolean): object {
  const children = new Map<string, { isArray: boolean; proxy: object }>();
  const valueOf = (key: string, value: object): unknown => {
    const v: unknown = (value as Record<string, unknown>)[key];
    if (isObject(v)) {
      const arr = Array.isArray(v);
      const cached = children.get(key);
      if (cached) {
        if (cached.isArray !== arr) throw new TypeError(`localized: the entry ${JSON.stringify(key)} is an array in one locale and an object in another`);
        return cached.proxy;
      }
      const childPick = (): object => {
        const c: unknown = (pick() as Record<string, unknown>)[key];
        if (!isObject(c) || Array.isArray(c) !== arr) throw new TypeError(`localized: the entry ${JSON.stringify(key)} changed its kind between locales`);
        return c;
      };
      const proxy = view(childPick, arr, wrap);
      children.set(key, { isArray: arr, proxy });
      return proxy;
    }
    if (wrap && isPseudo()) {
      if (typeof v === "string") return pseudoString(v);
      if (typeof v === "function") return pseudoFn(v);
    }
    return v;
  };
  const handler: ProxyHandler<object> = {
    get(_t, key) {
      const value = pick();
      if (typeof key === "symbol" || !Object.hasOwn(value, key)) return Reflect.get(value, key);
      return valueOf(key, value);
    },
    has(_t, key) {
      return Reflect.has(pick(), key);
    },
    ownKeys() {
      return Reflect.ownKeys(pick());
    },
    getOwnPropertyDescriptor(_t, key) {
      const value = pick();
      const d = Reflect.getOwnPropertyDescriptor(value, key);
      if (!d) return undefined;
      if (isArray && key === "length") return { value: (value as unknown[]).length, writable: true, enumerable: false, configurable: false };
      const v = typeof key === "symbol" ? Reflect.get(value, key) : valueOf(key, value);
      return { value: v, writable: false, enumerable: d.enumerable === true, configurable: true };
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
    setPrototypeOf: () => false,
    preventExtensions: () => false,
  };
  return new Proxy(isArray ? [] : {}, handler);
}

/**
 * A dictionary that answers in the locale of the current request: en is the source of the shape, ru is typed
 * Messages<typeof en>. Consumers read it as the plain object it replaces (keys, nesting, functions, arrays).
 */
export function localized<E extends object>(variants: { readonly en: E; readonly ru: Messages<E> }): Messages<E> {
  const en: unknown = isObject(variants) ? variants.en : undefined;
  const ru: unknown = isObject(variants) ? variants.ru : undefined;
  if (!isObject(en) || !isObject(ru) || Array.isArray(en) !== Array.isArray(ru)) throw new TypeError("localized: en and ru must be objects of one kind");
  return view(() => (currentLocale() === "ru" ? ru : en), Array.isArray(en), true) as Messages<E>;
}

/** How many times a derived read starts again when the instance values change under it before it answers uncached. */
const DERIVED_RETRIES = 4;

function derivedView(compute: () => unknown, isArray: boolean): object {
  if (typeof compute !== "function") throw new TypeError("derived: compute must be a function");
  const memo = new Map<ScopeLocale, object>();
  let epoch = -1;
  return view(() => {
    // The instance reader may change the values synchronously while the locale is resolved or while compute runs, and
    // compute may read this same view again (re-entrance). The epoch is therefore read after the locale, and a result is
    // memoised only if the epoch did not move during compute (the epoch is monotonic, so "unchanged" means "same values").
    for (let attempt = 0; ; attempt++) {
      const last = attempt === DERIVED_RETRIES;
      const before = getInstance().epoch;
      const key: ScopeLocale = isPseudo() ? "xx" : currentLocale();
      const start = getInstance().epoch;
      if (start !== before && !last) continue;
      if (start !== epoch) {
        memo.clear();
        epoch = start;
      }
      const hit = memo.get(key);
      if (hit !== undefined) return hit;
      const r = compute();
      if (!isObject(r) || Array.isArray(r) !== isArray) throw new TypeError(isArray ? "derivedList: compute must return an array" : "derived: compute must return an object");
      if (getInstance().epoch === start) {
        // a re-entrant read of the same epoch may have memoised first: keep that object
        const nested = memo.get(key);
        if (nested !== undefined) return nested;
        memo.set(key, r);
        return r;
      }
      if (last) return r;
    }
  }, isArray, false);
}

/**
 * An object computed from dictionaries, recomputed once per locale (and after the instance values change), lazily.
 * compute reads dictionaries and constants only, never request data: the memo is shared by all requests.
 */
export function derived<T extends object>(compute: () => T): T {
  return derivedView(compute, false) as T;
}

/** derived for an array. */
export function derivedList<T>(compute: () => readonly T[]): readonly T[] {
  return derivedView(compute, true) as readonly T[];
}

const SNAPSHOT_DEPTH = 16;

function copy(v: unknown, path: string, depth: number): unknown {
  if (typeof v === "function") throw new TypeError(`snapshot: a function at ${path || "(root)"} cannot be copied`);
  if (!isObject(v)) return v;
  if (depth > SNAPSHOT_DEPTH) throw new TypeError(`snapshot: deeper than ${SNAPSHOT_DEPTH} levels at ${path}`);
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (let i = 0; i < v.length; i++) out.push(copy(v[i], `${path}[${i}]`, depth + 1));
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) {
    Object.defineProperty(out, k, { value: copy((v as Record<string, unknown>)[k], path ? `${path}.${k}` : k, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** A deep plain copy of a dictionary in the current locale (for a prop of a client component). Functions are refused. */
export function snapshot<T extends object>(value: T): T {
  return copy(value, "", 0) as T;
}
