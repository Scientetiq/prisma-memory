// Process-wide state of the locale scope, kept on globalThis under a registered symbol and created once. Why global: test
// files re-evaluate module graphs (vi.resetModules, vi.mock); state held in a module would lose the locale forced by the
// legacy test profile in the re-imported copy. Not exported from the package: context.ts and testing/ use it.
import { AsyncLocalStorage } from "node:async_hooks";
import type { I18nProblem, Locale } from "./core.ts";

export type ProblemSink = (problem: I18nProblem) => void;

export interface I18nState {
  /** The request scope; the store is the locale string itself (immutable). */
  readonly als: AsyncLocalStorage<Locale>;
  /** Set only by the test entry: wins over the scope and the provider. */
  forced: Locale | null;
  /** The process default: the instance language. */
  provider: (() => unknown) | null;
  /** Values of the reserved parameters {product} and {org}. */
  globals: { product: string; org: string };
  /** Under vitest a problem in tr/trInstance throws; in production it is reported once and the text is kept. */
  strict: boolean;
  sink: ProblemSink;
  /** kind:key:param already reported (bounded). */
  readonly warned: Set<string>;
}

export const WARNED_MAX = 500;
export const DEFAULT_PRODUCT = "Prisma Memory";

export const defaultSink: ProblemSink = (p) => {
  console.warn(JSON.stringify({ level: "warn", event: "i18n_problem", kind: p.kind, key: p.key, param: p.param ?? null, locale: p.locale }));
};

export const strictDefault = (): boolean => Boolean(process.env.VITEST);

const KEY = Symbol.for("@memory/i18n/state/1");

export function i18nState(): I18nState {
  const g = globalThis as unknown as Record<symbol, I18nState | undefined>;
  const found = g[KEY];
  if (found) return found;
  const created: I18nState = {
    als: new AsyncLocalStorage<Locale>(),
    forced: null,
    provider: null,
    globals: { product: DEFAULT_PRODUCT, org: "" },
    strict: strictDefault(),
    sink: defaultSink,
    warned: new Set<string>(),
  };
  Object.defineProperty(globalThis, KEY, { value: created, enumerable: false, writable: false, configurable: false });
  return created;
}
