// OAuth authorization-server module of the gateway: request parameters. Same behaviour as the edge's module; a parity test pins it
//
// Strict parsing of a query string or a form body (RFC 6749 §3.1): a parameter sent twice is invalid_request; a parameter
// without a value counts as absent; control characters in a name or value are invalid_request; a string longer than the
// limit is refused as a whole. Parsing never throws.

/** Value limits: state up to 512, login_hint up to 254, scope up to 512; the whole string up to 4 KiB (form body 8 KiB). */
export const PARAM_LIMITS = { text: 4096, form: 8192, state: 512, login_hint: 254, scope: 512 } as const;

export type ParamsProblem = "too_long" | "control" | "duplicate";

export interface Params {
  /** null: the string is clean; otherwise the first problem found */
  problem: ParamsProblem | null;
  /** value of a parameter; repeated, empty or missing: undefined */
  get(name: string): string | undefined;
  /** the parameter occurred more than once */
  duplicated(name: string): boolean;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

const empty = (problem: ParamsProblem): Params => ({ problem, get: () => undefined, duplicated: () => false });

/** Parse application/x-www-form-urlencoded (a query string without "?" or a form body). */
export function parseParams(text: string, limit: number = PARAM_LIMITS.text): Params {
  if (typeof text !== "string" || text.length > limit) return empty("too_long");
  const values = new Map<string, string>();
  const dup = new Set<string>();
  let problem: ParamsProblem | null = null;
  for (const [k, v] of new URLSearchParams(text)) {
    if (CONTROL.test(k) || CONTROL.test(v)) {
      problem ??= "control";
      dup.add(k);
      continue;
    }
    // RFC 6749 §3.1: a parameter without a value is treated as omitted (and is not a repeat)
    if (v === "") continue;
    if (values.has(k) || dup.has(k)) {
      dup.add(k);
      values.delete(k);
      problem ??= "duplicate";
      continue;
    }
    values.set(k, v);
  }
  return { problem, get: (name) => (dup.has(name) ? undefined : values.get(name)), duplicated: (name) => dup.has(name) };
}

/** Requested scopes: unknown ones are silently dropped, mcp:memory is always granted. */
export const GRANTED_SCOPE = "mcp:memory";
