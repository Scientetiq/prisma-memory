// Rules of ConnectorCtx that every runtime applies the same way — the conformance kit here, the worker runner and the
// webhook handler later: state is small JSON, log lines are an event name and scalar fields.
import type { LogFields, Problem } from "./types.ts";

/**
 * Size cap of ConnectorCtx.state. The connectors table checks `octet_length(state::text) <= 16384`: the cap is
 * on the UTF-8 bytes of the jsonb TEXT form, which is longer than JSON.stringify — jsonb writes ", " and ": " between
 * members and prints numbers in full (1e300 is 301 digits). stateProblem measures that form, so a state it accepts is a
 * state the table stores.
 */
export const STATE_MAX_BYTES = 16_384;

const EVENT = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
const FIELD = /^[a-z][a-z0-9_]{0,39}$/;
const CTL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const MAX_FIELDS = 20;
const MAX_FIELD_CHARS = 200;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** A JSON number as PostgreSQL's numeric prints it: the exponent form of JavaScript written out in full. */
function numericText(n: number): string {
  const s = JSON.stringify(n);
  const e = s.search(/e/i);
  if (e < 0) return s;
  const sign = s.startsWith("-") ? "-" : "";
  const mantissa = s.slice(sign.length, e);
  const exp = Number(s.slice(e + 1));
  const dot = mantissa.indexOf(".");
  const digits = mantissa.replace(".", "");
  const point = (dot < 0 ? mantissa.length : dot) + exp;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}`;
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

const utf8 = (s: string): number => Buffer.byteLength(s, "utf8");

/** UTF-8 bytes of the jsonb text form of a parsed JSON value (`state::text` of the connectors table). */
function jsonbBytes(v: unknown): number {
  if (v === null) return 4;
  switch (typeof v) {
    case "boolean":
      return v ? 4 : 5;
    case "number":
      return numericText(v).length;
    case "string":
      return utf8(JSON.stringify(v));
    default: {
      if (Array.isArray(v)) return 2 + v.reduce((t: number, x) => t + jsonbBytes(x), 0) + Math.max(0, v.length - 1) * 2;
      const entries = Object.entries(v as Record<string, unknown>);
      return 2 + entries.reduce((t, [k, x]) => t + utf8(JSON.stringify(k)) + 2 + jsonbBytes(x), 0) + Math.max(0, entries.length - 1) * 2;
    }
  }
}

/** True when a parsed JSON value cannot be jsonb: a NUL or a lone surrogate in a string or a key. */
function jsonbRefuses(v: unknown): boolean {
  if (typeof v === "string") return v.includes("\u0000") || LONE_SURROGATE.test(v);
  if (Array.isArray(v)) return v.some(jsonbRefuses);
  if (typeof v === "object" && v !== null) return Object.entries(v).some(([k, x]) => jsonbRefuses(k) || jsonbRefuses(x));
  return false;
}

/** The JSON text of a state value, or null when it is not plain JSON. */
function stateJson(value: unknown): string | null {
  try {
    const text = JSON.stringify(value, (_k, v: unknown) => {
      if (typeof v === "function" || typeof v === "symbol" || typeof v === "bigint") throw new TypeError("not JSON");
      if (typeof v === "number" && !Number.isFinite(v)) throw new TypeError("not JSON");
      return v;
    });
    return text === undefined ? null : text;
  } catch {
    return null;
  }
}

/** UTF-8 bytes of the value as the connectors table stores it (`octet_length(state::text)`); the value must be JSON. */
export function stateTextBytes(value: unknown): number {
  const text = stateJson(value);
  if (text === null) throw new TypeError("connector state must be plain JSON");
  return jsonbBytes(JSON.parse(text));
}

/** A state value that cannot be stored: not JSON (or not jsonb), or larger than STATE_MAX_BYTES; null — it can. */
export function stateProblem(value: unknown): Problem | null {
  const text = stateJson(value);
  const notJson: Problem = { code: "state_not_json", message: "connector state must be plain JSON (objects, arrays, strings without NUL or lone surrogates, finite numbers, booleans, null)" };
  if (text === null) return notJson;
  let bytes: number;
  // the walks recurse: a value nested deeper than the call stack allows is refused as not JSON, never thrown
  try {
    const parsed: unknown = JSON.parse(text);
    if (jsonbRefuses(parsed)) return notJson;
    bytes = jsonbBytes(parsed);
  } catch {
    return notJson;
  }
  if (bytes > STATE_MAX_BYTES)
    return { code: "state_too_large", message: `connector state is ${bytes} bytes as stored; at most ${STATE_MAX_BYTES} — files go to the bucket, not to state` };
  return null;
}

/**
 * Problems of one log call by the former rule: the event is a dotted lowercase name (≤ 64), fields are ≤ 20 scalars with
 * short names. Since the runtime and the conformance kit project log calls by the closed schema of diag.ts; this
 * rule only remains behind redactFields (redact.ts) and its regressions.
 */
export function logProblems(event: unknown, fields: unknown): Problem[] {
  const out: Problem[] = [];
  if (typeof event !== "string" || event.length > 64 || !EVENT.test(event))
    out.push({ code: "log_event_invalid", message: "a log event is a dotted lowercase name of at most 64 characters, not free text" });
  if (fields === undefined) return out;
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    out.push({ code: "log_not_scalar", message: "log fields are an object of scalars" });
    return out;
  }
  const entries = Object.entries(fields as Record<string, unknown>);
  if (entries.length > MAX_FIELDS) out.push({ code: "log_too_many_fields", message: `at most ${MAX_FIELDS} log fields` });
  for (const [k, v] of entries) {
    if (!FIELD.test(k)) out.push({ code: "log_field_invalid", path: `/${k}`, message: "log field names are lowercase letters, digits and _" });
    const scalar = typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || typeof v === "string";
    if (!scalar) out.push({ code: "log_not_scalar", path: `/${k}`, message: "log fields are strings, finite numbers or booleans" });
    else if (typeof v === "string" && (v.length > MAX_FIELD_CHARS || CTL.test(v)))
      out.push({ code: "log_field_invalid", path: `/${k}`, message: `log strings are one line of at most ${MAX_FIELD_CHARS} characters` });
  }
  return out;
}

/** Copy of fields that keeps only what logProblems accepts. */
export function safeLogFields(fields: LogFields | undefined): LogFields {
  const out: LogFields = {};
  let kept = 0;
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (logProblems("x", { [k]: v }).length !== 0) continue;
    out[k] = v;
    kept += 1;
    if (kept === MAX_FIELDS) break;
  }
  return out;
}
