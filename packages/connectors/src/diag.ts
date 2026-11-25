// Diagnostic events of connectors: remote text is not copied into diagnostics. A connector's log line, and every diagnostic line the core writes
// about connectors, is a projection by a CLOSED schema built here: event names and field names from the exact lists
// below, values the core chooses — a literal of a closed list, a band or a class the core computes, a counter or a
// duration the core measured — and local ids the core BINDS when it builds the connector's context (bindDiag, from its own
// rows; a kind only when the build's registry has it), never ids taken from a call's arguments. No number a connector
// supplies enters a line: the connector names an event; counts of items / events / pages are the runner's own (measure),
// a connector's `attempt` becomes a band. Nothing of the input is copied: the projection takes `unknown`, never spreads it,
// never calls a getter (an accessor is refused unread), refuses a proxy, an Error or any object that is not a plain
// object, and builds a NEW frozen object field by field in schema order from our own literals.
//
// By construction, not by convention: a projected line carries a module-private brand, and the one writer here writes
// only branded lines (anything else becomes the core's constant refusal). The package root exports only «project and
// write» functions (bindDiag, writeCoreDiag) — not the writer, not the projection, not an id minter. Per binding (one run)
// at most DIAG_ADMITTED_MAX lines and DIAG_REFUSED_MAX refusals are written; at a bound ONE constant event says which bound
// was reached and the rest are dropped silently. Refusals are constant events with the binding's ids only:
// `connector_log_refused` for a connector's call, `connector_diag_refused` for a core event its own schema refused (a
// programming error stays visible). A diagnostic object is at most 2 KiB of JSON, 20 fields, depth 1.
//
// redact.ts stays as the second layer on what the projection admitted: when it changes anything in the line, the whole
// event is refused (no cleaned fragment is written). Data sinks (item content, entities, cursor and state) are not
// diagnostics and do not pass here. What is promised is exactly «remote text is not copied into diagnostics»; the bands,
// classes and the runner's counts are a deliberate, bounded disclosure — not a promise that a malicious connector, which
// runs in the process and holds its secrets, has no channel of bits (the SDK is not a sandbox).
//
// Third-party connectors get only the fixed set CONNECTOR_LOG_EVENTS in this version; the set grows by a reviewed change
// of this file, never by names taken from a vendor's answer.
import { types } from "node:util";
import { log } from "@memory/shared";
import { RUN_ERRORS } from "./run-codes.ts";
import { ENTITY_KINDS } from "./sdk/types.ts";

/** Limits of one diagnostic object (the line's fields with its event name). */
export const DIAG_MAX_BYTES = 2048;
export const DIAG_MAX_FIELDS = 20;
/** Core counters saturate here. */
export const DIAG_COUNT_MAX = 100_000;
/** Core-clock durations: at most one day, in milliseconds. */
export const DIAG_MS_MAX = 86_400_000;
/** Per binding (one run): lines written, and refusal events written. */
export const DIAG_ADMITTED_MAX = 200;
export const DIAG_REFUSED_MAX = 20;
/** The constant events. */
export const LOG_REFUSED = "connector_log_refused";
export const DIAG_REFUSED = "connector_diag_refused";
export const DIAG_BOUNDED = "connector_log_bounded";

const HTTP_CLASSES = ["success", "redirect", "auth", "rate_limit", "client_error", "server_error", "invalid"] as const;
const RETRY_CLASSES = ["none", "short", "medium", "long"] as const;
/** Bands of a count only the connector knows (its attempt): 0, 1, 2–3, 4–9, 10 and more. */
const BANDS = ["none", "one", "few", "several", "many"] as const;
type HttpClass = (typeof HTTP_CLASSES)[number];
type RetryClass = (typeof RETRY_CLASSES)[number];

/** The class of an HTTP status; anything that is not an integer 100 … 599 is `invalid`. */
export function httpClass(status: unknown): HttpClass {
  if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) return "invalid";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server_error";
  if (status >= 400) return "client_error";
  if (status >= 300) return "redirect";
  if (status >= 200) return "success";
  return "invalid";
}

/** The class of a parsed Retry-After in seconds (null — none was sent): ≤ 60 short, ≤ 3600 medium, longer long. */
export function retryClass(sec: number | null): RetryClass {
  if (sec === null) return "none";
  return sec <= 60 ? "short" : sec <= 3600 ? "medium" : "long";
}

const band = (n: number): (typeof BANDS)[number] => (n === 0 ? "none" : n === 1 ? "one" : n <= 3 ? "few" : n <= 9 ? "several" : "many");

// ---------------------------------------------------------------- schemas

/** What the runner measured itself during the run. */
export const MEASURES = ["items", "events", "pages"] as const;
export type Measure = (typeof MEASURES)[number];
/** Ids the core binds. */
const BOUND = ["connector_id", "kind", "run_id", "record_id"] as const;
type Bound = (typeof BOUND)[number];

type FieldKind =
  | { readonly t: "count" }                                   // core side: a counter the core computed
  | { readonly t: "ms" }                                      // core side: a duration by the core's clock
  | { readonly t: "measure"; readonly m: Measure }            // connector side: the runner's own count of that name
  | { readonly t: "band" }                                    // connector side: a count only it knows → a band
  | { readonly t: "http" }
  | { readonly t: "retry" }
  | { readonly t: "enum"; readonly of: readonly string[]; readonly fallback?: string }
  | { readonly t: "bound"; readonly b: Bound };               // core side: an id of the binding; never from the input
type Schema = ReadonlyMap<string, FieldKind>;

const count: FieldKind = Object.freeze({ t: "count" });
const ms: FieldKind = Object.freeze({ t: "ms" });
const measure = (m: Measure): FieldKind => Object.freeze({ t: "measure", m });
const banded: FieldKind = Object.freeze({ t: "band" });
const http: FieldKind = Object.freeze({ t: "http" });
const retry: FieldKind = Object.freeze({ t: "retry" });
const bound = (b: Bound): FieldKind => Object.freeze({ t: "bound", b });
const oneOf = (of: readonly string[], fallback?: string): FieldKind =>
  Object.freeze({ t: "enum", of: Object.freeze([...of]), ...(fallback !== undefined ? { fallback } : {}) });

/** Codes a core diagnostic may name: the run codes (they include every egress code) and a few of the core; others → internal. */
const DIAG_CODES = Object.freeze([...new Set(["ok", "internal", "pack_disabled", "storage_unavailable", ...Object.keys(RUN_ERRORS)])]);
const code = oneOf(DIAG_CODES, "internal");

/**
 * The events a connector may log through ConnectorCtx.log, with their fields. A connector names the event; `items`,
 * `events`, `pages` are written as the RUNNER counted them (a value the connector passes for them is type-checked and
 * discarded); `attempt` is written as a band; an HTTP status the connector received is written as its class, a
 * Retry-After in seconds (or null) as its class; an outcome is one of the listed words. No field takes free text.
 */
export const CONNECTOR_LOG_EVENTS = {
  "page.done": { items: measure("items"), events: measure("events"), pages: measure("pages") },
  "mock.page": { events: measure("events") },
  "auth.check": { outcome: oneOf(["ok", "refused", "failed"]) },
  "vendor.call": { status: http, attempt: banded },
  "vendor.retry": { status: http, retry_after: retry, attempt: banded },
} as const satisfies Record<string, Record<string, FieldKind>>;
export type ConnectorLogEvent = keyof typeof CONNECTOR_LOG_EVENTS;

/** What a connector passes for a field of the closed set (the type side; the runtime checks it again). */
type InputOf<K> = K extends { t: "measure" } ? number : K extends { t: "band" } ? number : K extends { t: "http" } ? number
  : K extends { t: "retry" } ? number | null : K extends { t: "enum"; of: readonly (infer S)[] } ? S : never;
export type ConnectorLogFields<E extends ConnectorLogEvent> = { [F in keyof (typeof CONNECTOR_LOG_EVENTS)[E]]?: InputOf<(typeof CONNECTOR_LOG_EVENTS)[E][F]> };

/** Fields the core adds to a connector's line; a connector field never takes one of these names. */
const LINE_IDS = { connector_id: bound("connector_id"), kind: bound("kind"), run_id: bound("run_id") } as const;
const LINE_EVENT = "connector_log";
const LINE_NAME = "connector_event";

/** Diagnostic events the core writes about connectors (runner, cleanup, entity linking, entity lookup, webhook hooks). */
export const CORE_DIAG_EVENTS = {
  connector_cursor_refused: { connector_id: bound("connector_id"), run_id: bound("run_id") },
  connectors_cleanup: { bodies: count, orphans: count, events: count, runs: count, interrupted: count, failed: count },
  entities_linked: { record_id: bound("record_id"), linked: count, unlinked: count, dropped: count, external_lookups: count, child_links: count },
  entity_lookup: { connector_id: bound("connector_id"), entity_kind: oneOf(ENTITY_KINDS), code, hits: count, ms },
  connector_hook_rate_limited: { scope: oneOf(["address", "connector"]) },
  connector_hook_refusals_suppressed: { connector_id: bound("connector_id"), count },
  connector_secret_unreadable: { connector_id: bound("connector_id"), which: oneOf(["push_token"]) },
  connector_hook_failed: { connector_id: bound("connector_id"), code },
} as const satisfies Record<string, Record<string, FieldKind>>;
export type CoreDiagEvent = keyof typeof CORE_DIAG_EVENTS;

/** The constant events, with their fields (ids of the binding; the bound event also names which bound). */
const CONSTANT_EVENTS = {
  [LOG_REFUSED]: LINE_IDS,
  [DIAG_REFUSED]: LINE_IDS,
  [DIAG_BOUNDED]: { ...LINE_IDS, bound: oneOf(["admitted", "refused"]) },
} as const satisfies Record<string, Record<string, FieldKind>>;

const NAME = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
const FIELD = /^[a-z][a-z0-9_]{0,39}$/;
/** Names of the shared log line (packages/shared/src/log.ts): no schema field of either side may take one. */
const SHARED = new Set(["at", "level", "component", "event"]);
/** Names a connector field may not take besides those: the ids and the event name of its line. */
const CONNECTOR_RESERVED = new Set([...Object.keys(LINE_IDS), LINE_NAME]);
const CONNECTOR_KINDS = new Set<FieldKind["t"]>(["measure", "band", "http", "retry", "enum"]);
const CORE_KINDS = new Set<FieldKind["t"]>(["count", "ms", "bound", "enum", "http", "retry"]);

/** The registered schemas as maps (own entries only), checked once when the module loads. */
function compile(set: Record<string, Record<string, FieldKind>>, connectorSide: boolean): ReadonlyMap<string, Schema> {
  const out = new Map<string, Schema>();
  for (const [event, fields] of Object.entries(set)) {
    if (event.length > 64 || !NAME.test(event)) throw new Error(`diag: event name of the dictionary is not a name (${event.length})`);
    const m = new Map<string, FieldKind>();
    for (const [f, k] of Object.entries(fields)) {
      if (!FIELD.test(f) || SHARED.has(f)) throw new Error("diag: field name of the dictionary is not a name or takes a name of the shared line");
      if (connectorSide && (CONNECTOR_RESERVED.has(f) || !CONNECTOR_KINDS.has(k.t))) throw new Error("diag: a connector field takes a core name or kind");
      if (!connectorSide && !CORE_KINDS.has(k.t)) throw new Error("diag: a core field takes a connector kind");
      if (k.t === "enum" && k.of.some((v) => v.length > 64 || !/^[a-z][a-z0-9_:]*$/.test(v))) throw new Error("diag: enum value is not a code");
      m.set(f, k);
    }
    if (m.size + (connectorSide ? Object.keys(LINE_IDS).length + 1 : 0) > DIAG_MAX_FIELDS) throw new Error("diag: schema over the field limit");
    out.set(event, m);
  }
  return out;
}
const CONNECTOR_SCHEMAS = compile(CONNECTOR_LOG_EVENTS, true);
const CORE_SCHEMAS = compile(CORE_DIAG_EVENTS, false);
const CONSTANT_SCHEMAS = compile(CONSTANT_EVENTS, false);
const CONNECTOR_EVENT_NAMES: readonly string[] = Object.freeze([...CONNECTOR_SCHEMAS.keys()]);

// ---------------------------------------------------------------- projection

/**
 * Why a call was refused — for the conformance kit only (a synthetic harness under the developer's control). The runtime
 * never writes it: its refusal event is constant.
 */
export type DiagRefusal =
  | "log_event_invalid" | "log_field_invalid" | "log_not_scalar" | "log_value_refused" | "log_too_many_fields"
  | "log_input_unreadable" | "log_too_large" | "log_redacted";

export type DiagValue = string | number;
export interface DiagLine {
  readonly level: "info" | "warn";
  readonly event: string;
  readonly fields: Readonly<Record<string, DiagValue>>;
}
export type Verdict = { ok: true; line: DiagLine } | { ok: false; reason: DiagRefusal };

/** Lines this module built; the writer writes no other object. */
const BRAND = new WeakSet<object>();
function mkLine(level: "info" | "warn", event: string, fields: Record<string, DiagValue>): DiagLine {
  const line = Object.freeze({ level, event, fields: Object.freeze(fields) });
  BRAND.add(line);
  return line;
}

class Refused { constructor(readonly reason: DiagRefusal) {} }
const refuse = (reason: DiagRefusal): never => { throw new Refused(reason); };

/** The ids a binding holds, checked once when the core binds them. */
interface Ids { connector_id?: string; kind?: string; run_id?: string; record_id?: string }
type Measures = () => Partial<Record<Measure, number>>;

const satCount = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? Math.min(v, DIAG_COUNT_MAX) : undefined;

function value(k: FieldKind, v: unknown, ids: Ids, measures: Measures | undefined): DiagValue | undefined {
  switch (k.t) {
    case "count":
      return satCount(v) ?? refuse("log_value_refused");
    case "ms":
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) return refuse("log_value_refused");
      return Math.min(v, DIAG_MS_MAX);
    case "measure": {
      // the connector's value is only type-checked; the line carries what the runner counted (absent: not measured)
      if (v !== undefined && satCount(v) === undefined) return refuse("log_value_refused");
      return measures ? satCount(measures()[k.m]) : undefined;
    }
    case "band": {
      const n = satCount(v);
      return n === undefined ? refuse("log_value_refused") : band(n);
    }
    case "http":
      if (typeof v !== "number" || !Number.isInteger(v) || v < 100 || v > 599) return refuse("log_value_refused");
      return httpClass(v);
    case "retry":
      if (v === null) return "none";
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return refuse("log_value_refused");
      return retryClass(v);
    case "enum": {
      if (typeof v !== "string") return k.fallback ?? refuse("log_not_scalar");
      // the literal of OUR list, found by comparison; the input string itself is never kept
      for (const x of k.of) if (x === v) return x;
      return k.fallback ?? refuse("log_value_refused");
    }
    case "bound":
      return ids[k.b];
  }
}

/** The own data properties of a plain object, read once each through their descriptors (no getter, no proxy trap). */
function readInput(input: unknown, schema: Schema): Map<string, unknown> {
  const got = new Map<string, unknown>();
  if (input === undefined) return got;
  if (typeof input !== "object" || input === null) return refuse("log_not_scalar");
  if (types.isProxy(input)) return refuse("log_input_unreadable");
  if (Array.isArray(input)) return refuse("log_not_scalar");
  const proto: unknown = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) return refuse("log_not_scalar");   // Error, Map, String, class instances
  const keys = Reflect.ownKeys(input);
  if (keys.length > DIAG_MAX_FIELDS) return refuse("log_too_many_fields");
  const read: Array<[string, unknown]> = [];
  for (const key of keys) {
    if (typeof key !== "string") return refuse("log_field_invalid");
    const d = Reflect.getOwnPropertyDescriptor(input, key);
    if (!d || !Object.hasOwn(d, "value")) return refuse("log_input_unreadable");   // an accessor is refused unread
    const v: unknown = d.value;
    if ((typeof v === "object" && v !== null) || typeof v === "function" || typeof v === "symbol" || typeof v === "bigint") return refuse("log_not_scalar");
    read.push([key, v]);
  }
  // only names of the schema, and never a bound id; the input's key string is never kept (the output takes the schema's)
  for (const [key, v] of read) {
    const k = schema.get(key);
    if (!k || k.t === "bound") return refuse("log_field_invalid");
    got.set(key, v);
  }
  return got;
}

/** Fields of the schema in schema order; keys are the schema's own strings. */
function build(schema: Schema, got: Map<string, unknown>, ids: Ids, measures: Measures | undefined, out: Record<string, DiagValue>): void {
  for (const [name, k] of schema) {
    if (k.t !== "bound" && k.t !== "measure" && !got.has(name)) continue;
    const v = value(k, got.get(name), ids, measures);
    if (v !== undefined) out[name] = v;
  }
}

/** Size, field count and the second layer over the finished object. */
function seal(event: string, out: Record<string, DiagValue>, redact: ((t: string) => string) | undefined): void {
  if (Object.keys(out).length > DIAG_MAX_FIELDS) refuse("log_too_many_fields");
  const text = JSON.stringify({ event, ...out });
  if (Buffer.byteLength(text, "utf8") > DIAG_MAX_BYTES) refuse("log_too_large");
  if (redact) {
    let same = false;
    try { same = redact(text) === text; } catch { same = false; }
    if (!same) refuse("log_redacted");
  }
}

/** A constant event with the ids it may carry. */
function constantLine(event: keyof typeof CONSTANT_EVENTS, ids: Ids, extra?: Record<string, unknown>): DiagLine {
  const out: Record<string, DiagValue> = {};
  try {
    build(CONSTANT_SCHEMAS.get(event)!, new Map(Object.entries(extra ?? {})), ids, undefined, out);
  } catch { /* the constant events are built from our own values only */ }
  return mkLine("warn", event, out);
}

/**
 * The verdict on one connector log call (module-internal; the kit uses it): the line `connector_log` (ids,
 * `connector_event`, the projected fields) or the reason of the refusal. Never throws, whatever the input is.
 */
export function connectorVerdict(ids: Ids, event: unknown, fields: unknown, redact?: (t: string) => string, measures?: Measures): Verdict {
  try {
    if (typeof event !== "string") return { ok: false, reason: "log_event_invalid" };
    let name: string | undefined;
    for (const n of CONNECTOR_EVENT_NAMES) if (n === event) name = n;
    if (name === undefined) return { ok: false, reason: "log_event_invalid" };
    const schema = CONNECTOR_SCHEMAS.get(name)!;
    const got = readInput(fields, schema);
    const out: Record<string, DiagValue> = {};
    build(CONSTANT_SCHEMAS.get(LOG_REFUSED)!, new Map(), ids, undefined, out);   // the ids, in their order
    out[LINE_NAME] = name;
    build(schema, got, ids, measures, out);
    seal(LINE_EVENT, out, redact);
    return { ok: true, line: mkLine("info", LINE_EVENT, out) };
  } catch (e) {
    return { ok: false, reason: e instanceof Refused ? e.reason : "log_input_unreadable" };
  }
}

/** A core event projected by its schema, or its own constant refusal. Module-internal. Never throws. */
export function coreLine(ids: Ids, event: CoreDiagEvent, fields: unknown, level: "info" | "warn" = "info", redact?: (t: string) => string): DiagLine {
  try {
    const schema = CORE_SCHEMAS.get(event as string);
    if (!schema) return constantLine(DIAG_REFUSED, ids);
    const out: Record<string, DiagValue> = {};
    build(schema, readInput(fields, schema), ids, undefined, out);
    seal(event, out, redact);
    return mkLine(level, event, out);
  } catch {
    return constantLine(DIAG_REFUSED, ids);
  }
}

/** The constant refusal of a connector call with these ids (module-internal; the kit records it). */
export const connectorRefusal = (ids: Ids = {}): DiagLine => constantLine(LOG_REFUSED, ids);

/** The one writer: a branded line through the shared log; any other object becomes the core's constant refusal. */
export function writeLine(input: unknown): void {
  const line = typeof input === "object" && input !== null && BRAND.has(input) ? (input as DiagLine) : constantLine(DIAG_REFUSED, {});
  const fields: Record<string, DiagValue> = {};
  for (const [k, v] of Object.entries(line.fields)) fields[k] = v;
  if (line.level === "warn") log.warn(line.event, fields);
  else log.info(line.event, fields);
}

// ---------------------------------------------------------------- what the package root exports: project AND write

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KIND = /^[a-z][a-z0-9_]{0,31}$/;

/** What the core knows when it builds a connector's context: its own row, its run, the build's registry. */
export interface DiagOrigin {
  /** The connector row's id (a local UUID). */
  connectorId?: string;
  /** The claimed run's id (a local UUID). */
  runId?: string;
  /** A record's id (a local UUID). */
  recordId?: string;
  /** The row's kind: written only when the registry of this build has it. */
  kind?: string;
  registry?: { kinds: { has(kind: string): boolean } };
  /** The run's redactor: the second layer over every line. */
  redact?: (text: string) => string;
  /** What the runner counted so far in this run (items, events, pages). */
  measures?: () => Partial<Record<Measure, number>>;
}

export interface DiagBinding {
  /** One call of ConnectorCtx.log: projected by the closed set and written, or the constant refusal. Never throws. */
  connector(event: unknown, fields?: unknown): void;
  /** A core event with the binding's ids. Never throws. */
  core(event: CoreDiagEvent, fields?: unknown, level?: "info" | "warn"): void;
}

/** Binds the ids of one connector context (one run) and returns its writers, with the per-run bounds. */
export function bindDiag(o: DiagOrigin): DiagBinding {
  const ids: Ids = {};
  if (typeof o.connectorId === "string" && UUID.test(o.connectorId)) ids.connector_id = o.connectorId;
  if (typeof o.runId === "string" && UUID.test(o.runId)) ids.run_id = o.runId;
  if (typeof o.recordId === "string" && UUID.test(o.recordId)) ids.record_id = o.recordId;
  try {
    if (typeof o.kind === "string" && KIND.test(o.kind) && o.registry?.kinds.has(o.kind) === true) ids.kind = o.kind;
  } catch { /* a registry that throws: no kind */ }
  Object.freeze(ids);
  let admitted = 0, refused = 0;
  const put = (line: DiagLine, isRefusal: boolean): void => {
    if (isRefusal) {
      refused++;
      if (refused <= DIAG_REFUSED_MAX) writeLine(line);
      else if (refused === DIAG_REFUSED_MAX + 1) writeLine(constantLine(DIAG_BOUNDED, ids, { bound: "refused" }));
    } else {
      admitted++;
      if (admitted <= DIAG_ADMITTED_MAX) writeLine(line);
      else if (admitted === DIAG_ADMITTED_MAX + 1) writeLine(constantLine(DIAG_BOUNDED, ids, { bound: "admitted" }));
    }
  };
  return Object.freeze({
    connector(event: unknown, fields?: unknown): void {
      const v = connectorVerdict(ids, event, fields, o.redact, o.measures);
      put(v.ok ? v.line : constantLine(LOG_REFUSED, ids), !v.ok);
    },
    core(event: CoreDiagEvent, fields?: unknown, level: "info" | "warn" = "info"): void {
      const line = coreLine(ids, event, fields, level, o.redact);
      put(line, line.event === DIAG_REFUSED);
    },
  });
}

/** A core event without ids (for example the cleanup of all connectors), projected and written. Never throws. */
export function writeCoreDiag(event: CoreDiagEvent, fields?: unknown, level: "info" | "warn" = "info"): void {
  writeLine(coreLine({}, event, fields, level));
}
