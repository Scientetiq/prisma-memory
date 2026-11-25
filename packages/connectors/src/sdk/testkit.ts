// Conformance kit: runConformance(connector, fixtures) checks a connector against the rules of the SDK without a
// database or a network — the manifest and the config, test(), pull() (shape of every event, every item against the
// contract, keys unique in a run, the same answer twice, nothing old after the cursor), fetch() against the pull,
// parseWebhook(), lookup(), the state cap, the log rules and that no secret appears in logs, items, deletions, cursors,
// refetch ids, lookup hits, test results or errors. The secret check reads the raw strings (not their JSON text) in
// their own and in NFC form. Every failure and warning is a fixed text of the kit (a code and a local position, never
// a string of the connector or the remote side); items, deletions and the cursor are harness data — publishable() is the
// form for CI or publishing. The connector gets its config with the
// manifest's defaults filled in, as the runtime gives it. Our own tests use the kit, and so do authors of connectors.
import { applyConfigDefaults, connectorShapeProblems, validateConfig, validateManifest } from "./manifest.ts";
import { STATE_MAX_BYTES, stateProblem } from "./ctx.ts";
import { connectorRefusal, connectorVerdict, type DiagLine, type DiagRefusal } from "../diag.ts";
import { types as utilTypes } from "node:util";
import { itemHash, sanitiseItem, validateItem } from "./items.ts";
import {
  ITEM_TYPES,
  type Connector,
  type ConnectorCtx,
  type ConnectorManifest,
  type EgressClient,
  type EgressRequest,
  type EgressResponse,
  type EntityKind,
  type FolderAccess,
  type Item,
  type ItemType,
  type LogFields,
  type Problem,
} from "./types.ts";

export { STATE_MAX_BYTES };

export interface LoggedEvent { event: string; fields: LogFields }

/** A ConnectorCtx for tests, with what the connector did to it. */
export type TestCtx<C> = ConnectorCtx<C> & {
  /** Every log call, as given (the synthetic harness only: own data fields, no getter called; never published). */
  logs: LoggedEvent[];
  /** The line the runtime writes for each log call: the projection of the closed schema or the refusal (diag.ts). */
  diagnostics: DiagLine[];
  /** Problems of log and state calls (the calls that break a rule also throw, as the real runtime does for state). */
  problems: Problem[];
  stateWrites: number;
};

export interface TestCtxOptions<C> {
  config: C;
  /** When given, the connector sees `config` with this manifest's defaults filled in (as the runtime gives it). */
  manifest?: ConnectorManifest;
  secrets?: Record<string, string>;
  http?: EgressClient;
  files?: FolderAccess;
  /** The clock; default 2026-01-01T00:00:00Z. */
  now?: Date;
  state?: unknown;
  signal?: AbortSignal;
}

export class ConnectorStateError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

/** An egress client that refuses every request: a connector under test reaches the network only through a fixture. */
export function refusingHttp(): EgressClient {
  return {
    request: async () => {
      throw new Error("egress_not_configured: the test gives this connector no network");
    },
  };
}

/** What a test transport answers: a status, a JSON body (serialised as the server would send it) and headers. */
export interface TestAnswer { status: number; json?: unknown; headers?: Record<string, string> }

/**
 * An egress client for tests that answers every request through the handler, with no network and no policy: the
 * stand-in of the real client where a test drives a connector or the lookup of the workers (it replaces stubs of the
 * global fetch). Header names of the answer are lowercased; json() of a body that is not JSON throws
 * "egress_bad_json", as the real client does. Production code never imports the testkit.
 */
export function testTransport(handler: (req: EgressRequest) => Promise<TestAnswer>): EgressClient {
  return {
    async request(req: EgressRequest): Promise<EgressResponse> {
      const a = await handler(req);
      const body = a.json === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(a.json));
      const headers = Object.fromEntries(Object.entries(a.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      const text = (): string => new TextDecoder().decode(body);
      return {
        status: a.status, headers, body, text,
        json: () => {
          try { return JSON.parse(text()) as unknown; } catch { throw new Error("egress_bad_json"); }
        },
      };
    },
  };
}

export function createTestCtx<C>(opts: TestCtxOptions<C>): TestCtx<C> {
  let state: unknown = opts.state === undefined ? {} : structuredClone(opts.state);
  const now = opts.now ?? new Date("2026-01-01T00:00:00Z");
  const config =
    opts.manifest && typeof opts.config === "object" && opts.config !== null && !Array.isArray(opts.config)
      ? (applyConfigDefaults(opts.manifest, opts.config as Record<string, unknown>) as C)
      : opts.config;
  const ctx: TestCtx<C> = {
    config,
    secret: (name) => (opts.secrets && Object.hasOwn(opts.secrets, name) ? opts.secrets[name]! : null),
    http: opts.http ?? refusingHttp(),
    ...(opts.files ? { files: opts.files } : {}),
    state: {
      get: async () => structuredClone(state),
      set: async (v) => {
        const p = stateProblem(v);
        if (p) {
          ctx.problems.push(p);
          throw new ConnectorStateError(p.code, p.message);
        }
        ctx.stateWrites += 1;
        state = structuredClone(v);
      },
    },
    log: (event: unknown, fields?: unknown) => {
      const v = connectorVerdict({}, event, fields);
      if (!v.ok) ctx.problems.push({ code: v.reason, message: LOG_REFUSALS[v.reason] });
      ctx.diagnostics.push(v.ok ? v.line : connectorRefusal());
      ctx.logs.push({ event: typeof event === "string" ? event : "(not a string)", fields: harnessCopy(fields) });
    },
    signal: opts.signal ?? new AbortController().signal,
    now: () => new Date(now.getTime()),
    logs: [],
    diagnostics: [],
    problems: [],
    stateWrites: 0,
  };
  return ctx;
}

/** What the kit tells an author about a refused log call (the runtime itself writes only the constant refusal). */
const LOG_REFUSALS: Readonly<Record<DiagRefusal, string>> = {
  log_event_invalid: "a log event is a name of the closed set CONNECTOR_LOG_EVENTS, not free text",
  log_field_invalid: "a log field is a field of its event's schema in CONNECTOR_LOG_EVENTS",
  log_not_scalar: "log fields are an object of numbers, null and listed words",
  log_value_refused: "a log value is a counter (integer 0 or more), an HTTP status, a Retry-After in seconds or a listed word",
  log_too_many_fields: "at most 20 log fields",
  log_input_unreadable: "log fields are a plain object of data properties (no getter, proxy or Error)",
  log_too_large: "a log line is at most 2 KiB",
  log_redacted: "the log line carries a secret of the connector",
};

/** The harness copy of a log call's fields: own data properties with scalar values, read through descriptors. */
function harnessCopy(fields: unknown): LogFields {
  const out: LogFields = {};
  try {
    if (typeof fields !== "object" || fields === null || utilTypes.isProxy(fields)) return out;
    for (const k of Object.keys(fields)) {
      const d = Object.getOwnPropertyDescriptor(fields, k);
      const v: unknown = d && Object.hasOwn(d, "value") ? d.value : undefined;
      if (typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) out[k] = v;
    }
  } catch { /* an unreadable input: nothing */ }
  return out;
}

export interface ConformanceFixtures<C> {
  config: C;
  secrets?: Record<string, string>;
  http?: EgressClient;
  files?: FolderAccess;
  now?: Date;
  /** The code test() must answer; default "ok". */
  expectTest?: string;
  /** A pull from the last cursor gives nothing already seen unchanged; default true. */
  incremental?: boolean;
  /** Two full pulls give the same items; default true. */
  deterministic?: boolean;
  webhooks?: Array<{ body: Uint8Array | string; headers?: Record<string, string> }>;
  lookups?: Array<{ kind: EntityKind; name: string; limit?: number }>;
  /** Events read from one pull at most; default 10 000. */
  maxEvents?: number;
  /** Pulled items checked through fetch(); default 20. */
  fetchSample?: number;
}

export interface ConformanceReport {
  ok: boolean;
  failures: Problem[];
  warnings: Problem[];
  /** The checks that ran. */
  checks: string[];
  /**
   * HARNESS DATA — items of the first full pull (sanitised). They may contain remote text: not for publishing or CI
   * output; publishable() gives the form for that (counts only).
   */
  items: Item[];
  /** HARNESS DATA — deletions of the first full pull (may contain remote ids; not for publishing). */
  deletions: Array<{ of: ItemType; external_id: string }>;
  /** HARNESS DATA — the last cursor of the first full pull (may contain remote text or a token; not for publishing). */
  cursor: string | null;
  /** The diagnostic lines of the log calls as the runtime writes them (diag.ts): the projection or the refusal. */
  logs: LoggedEvent[];
}

const CODE = /^[a-z][a-z0-9_]*(:[a-z0-9_]+)?$/;

/** The report in the form meant for CI output or publishing: the kit's own results, the projected log lines, counts. */
export interface PublishableReport {
  ok: boolean;
  failures: Problem[];
  warnings: Problem[];
  checks: string[];
  logs: LoggedEvent[];
  counts: { items: number; deletions: number; cursor: boolean };
}

/** The publishable form of a report: no item, deletion or cursor — only what the kit counted. */
export function publishable(r: ConformanceReport): PublishableReport {
  return {
    ok: r.ok, failures: r.failures.map((p) => ({ ...p })), warnings: r.warnings.map((p) => ({ ...p })), checks: [...r.checks],
    logs: r.logs.map((l) => ({ event: l.event, fields: { ...l.fields } })),
    counts: { items: r.items.length, deletions: r.deletions.length, cursor: r.cursor !== null },
  };
}

/**
 * The fixed text of every failure and warning of the kit: a code and, where the kit knows it, a local
 * position («pull event 3», «webhook 1 item 2») — never a string of the connector or the remote side, and never a
 * fragment cleaned by a redactor.
 */
const KIT_TEXT: Readonly<Record<string, string>> = {
  secret_in_log: "a log call carries a secret value",
  secret_in_output: "an item, a deletion, a cursor, a refetch id, a lookup hit, a test result or an error carries a secret value",
  item_invalid: "an item does not pass the contract",
  item_not_clean: "the sanitiser changed an item",
  item_type_not_produced: "an item or a deletion has a type the manifest does not produce",
  duplicate_item: "the same item key came twice in one run",
  test_invalid: "test() must answer {ok: boolean, code: stable code}",
  test_not_ok: "test() did not answer the expected code",
  test_wrote_state: "test() must not write state",
  pull_capped: "the kit stopped reading one pull at its event limit",
  event_invalid: "an event is exactly one of {item}, {cursor}, {deleted}, {complete: true}",
  cursor_invalid: "a cursor is one line of 1–4096 characters",
  no_cursor: "the pull gave items and no cursor: a run that stops cannot resume",
  pull_not_deterministic: "two full pulls from no cursor gave different items",
  cursor_ignored: "a pull from the last cursor gave items the first pull already gave unchanged",
  fetch_mismatch: "fetch() did not give the item the pull gave",
  fetch_unknown_not_null: "fetch() of an id the source does not have must answer null",
  webhook_missing: "webhook fixtures were given but the connector has no parseWebhook()",
  webhook_invalid: "parseWebhook() answers {items} or {refetch} with valid ids",
  lookup_invalid: "lookup() must answer at most the limit of hits of the declared kinds with an id and a one-line name",
  connector_validate_refused: "the connector's validate() refused the configuration",
  state_not_json: "connector state must be plain JSON",
  state_too_large: "connector state is larger than 16 KiB as stored",
};
function kitText(code: string): string {
  if (Object.hasOwn(KIT_TEXT, code)) return KIT_TEXT[code]!;
  if (code.startsWith("threw:")) return "the method threw an exception; its text is not copied into the report";
  if (code.startsWith("log_")) return "a log call is refused by the closed set of diagnostic events";
  if (code.startsWith("manifest") || code.startsWith("config")) return "the manifest or the configuration does not pass the contract";
  return "the check failed";
}
/** Sub-codes of the kit's own validators, for an item failure (codes only, no path). */
const codesOf = (ps: readonly Problem[]): string => [...new Set(ps.map((p) => p.code).filter((c) => CODE.test(c)))].sort().join(", ");
const CTL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const MAX_CURSOR = 4096;
const MAX_REFETCH = 1000;

/** An id the contract refuses: it counts characters (code points), not UTF-16 units. */
const idProblem = (v: unknown): boolean => typeof v !== "string" || v.length === 0 || [...v].length > 200 || CTL.test(v);

/** Every string inside a value (keys too), bytes left out. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (typeof v === "object" && v !== null && !ArrayBuffer.isView(v)) {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      strings(x, out);
    }
  }
  return out;
}
const itemKey = (i: Item): string => (i.type === "delete" ? `delete:${i.of}:${i.external_id}` : `${i.type}:${i.external_id}`);

interface PullPass {
  hashes: Map<string, string>;
  items: Item[];
  deletions: Array<{ of: ItemType; external_id: string }>;
  cursor: string | null;
  ok: boolean;
}

export async function runConformance<C>(connector: Connector<C>, fx: ConformanceFixtures<C>): Promise<ConformanceReport> {
  const failures: Problem[] = [];
  const warnings: Problem[] = [];
  const checks: string[] = [];
  /** Raw strings the connector gave out: item fields, deletion ids, cursors, refetch ids, hits, test results, errors. */
  const outputs: string[] = [];
  const emit = (v: unknown): void => void strings(v, outputs);
  const secrets = Object.values(fx.secrets ?? {}).filter((s) => typeof s === "string" && s.length >= 4);
  /** Each secret in the forms a connector may give it back in (as given, NFC, NFD), longest first. */
  const forms = [...new Set(secrets.flatMap((s) => [s, s.normalize("NFC"), s.normalize("NFD")]))].sort((a, b) => b.length - a.length);
  const carries = (v: string): boolean => {
    const n = v.normalize("NFC");
    return forms.some((f) => v.includes(f) || n.includes(f));
  };
  // fixed texts only: `at` is a position the kit built from its own counters, or the kit's own sub-codes
  const text = (code: string, at?: string): string => (at ? `${kitText(code)} (${at})` : kitText(code));
  const fail = (code: string, at?: string): void => { failures.push({ code, message: text(code, at) }); };
  const warn = (code: string, at?: string): void => { warnings.push({ code, message: text(code, at) }); };
  const threw = (method: string, e: unknown): void => {
    const msg = e instanceof Error ? e.message : String(e);
    outputs.push(msg);
    // the exception's text stays in the harness (the secret check reads it); the report does not copy it
    fail(`threw:${method}`);
  };
  const report = (items: Item[], deletions: PullPass["deletions"], cursor: string | null, ctxs: TestCtx<C>[]): ConformanceReport => {
    for (const c of ctxs) for (const p of c.problems) fail(p.code);
    const logs = ctxs.flatMap((c) => c.logs);
    if (forms.length > 0) {
      if (logs.some((l) => carries(l.event) || strings(l.fields).some(carries)))
        fail("secret_in_log");
      if (outputs.some(carries))
        fail("secret_in_output");
    }
    if (secrets.length > 0) checks.push("secrets");
    const seen = new Set<string>();
    const unique = failures.filter((p) => {
      const k = `${p.code}\u0000${p.path ?? ""}\u0000${p.message}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return {
      ok: unique.length === 0,
      failures: unique,
      warnings,
      checks,
      items,
      deletions,
      cursor,
      // the projection the runtime writes, never the calls as given; a line that would carry a secret is the refusal
      logs: ctxs.flatMap((c) => c.diagnostics).map((l) => (forms.length > 0 && carries(JSON.stringify(l)) ? connectorRefusal() : l))
        .map((l) => ({ event: l.event, fields: { ...l.fields } })),
    };
  };
  // the config the connector sees: the fixture's with the manifest's defaults (set once the manifest is accepted)
  let config: C = fx.config;
  const newCtx = (): TestCtx<C> =>
    createTestCtx({ config, secrets: fx.secrets, http: fx.http, files: fx.files, now: fx.now });

  // manifest and config
  const mps = [...validateManifest(connector.manifest), ...(connector.manifest ? connectorShapeProblems(connector as Connector) : [])];
  for (const p of mps) fail(p.code);
  if (mps.length > 0) return report([], [], null, []);
  checks.push("manifest");
  const m = connector.manifest;
  const configProblems = validateConfig(m, fx.config);
  for (const p of configProblems) fail(p.code);
  if (configProblems.length === 0) config = applyConfigDefaults(m, fx.config as Record<string, unknown>) as C;
  try {
    // the connector's own problem codes and texts are its strings: the report names only that it refused
    if ((connector.validate?.(config) ?? []).length > 0) fail("connector_validate_refused");
  } catch (e) {
    threw("validate", e);
  }
  checks.push("config");

  /** Checks of one item; answers the sanitised item, or null when it is refused. */
  const checkItem = (raw: unknown, where: string, keys: Set<string>): Item | null => {
    const s = sanitiseItem(raw as Item);
    if (!s.ok) {
      fail("item_invalid", `${where}: ${codesOf(s.problems)}`);
      return null;
    }
    if (s.changes.length > 0) warn("item_not_clean", where);
    const vs = validateItem(s.item, { maxBytes: m.limits.maxBytesPerItem });
    if (vs.length > 0) {
      fail("item_invalid", `${where}: ${codesOf(vs)}`);
      return null;
    }
    const it = s.item;
    const t = it.type === "delete" ? it.of : it.type;
    if (!m.produces.includes(t)) fail("item_type_not_produced", where);
    const k = itemKey(it);
    if (keys.has(k)) fail("duplicate_item", where);
    keys.add(k);
    emit(it);
    return it;
  };

  // test()
  const testCtx = newCtx();
  try {
    const r = await connector.test(testCtx);
    const shaped = typeof r === "object" && r !== null && typeof r.ok === "boolean" && typeof r.code === "string" && CODE.test(r.code);
    if (!shaped) fail("test_invalid");
    else {
      emit([r.code, r.message ?? ""]);
      const expected = fx.expectTest ?? "ok";
      if (r.code !== expected || r.ok !== (expected === "ok")) fail("test_not_ok");
    }
  } catch (e) {
    threw("test", e);
  }
  if (testCtx.stateWrites > 0) fail("test_wrote_state");
  checks.push("test");
  const ctxs = [testCtx];

  // pull()
  const maxEvents = fx.maxEvents ?? 10_000;
  const runCtx = newCtx();
  ctxs.push(runCtx);
  const pull = async (cursor: string | null, validate: boolean): Promise<PullPass> => {
    const pass: PullPass = { hashes: new Map(), items: [], deletions: [], cursor: null, ok: true };
    const keys = new Set<string>();
    let n = 0;
    try {
      for await (const ev of connector.pull!(runCtx, cursor)) {
        n += 1;
        if (n > maxEvents) {
          if (validate) warn("pull_capped");
          break;
        }
        const where = `pull event ${n}`;
        const e = ev as unknown as Record<string, unknown>;
        const present = typeof e === "object" && e !== null ? ["item", "cursor", "deleted", "complete"].filter((k) => e[k] !== undefined) : [];
        if (present.length !== 1 || Object.keys(e).length !== 1) {
          if (validate) fail("event_invalid", where);
          continue;
        }
        if (present[0] === "complete") {
          if (e.complete !== true && validate) fail("event_invalid", where);
          continue;
        }
        if (present[0] === "cursor") {
          const c = e.cursor;
          if (typeof c !== "string" || c.length === 0 || c.length > MAX_CURSOR || CTL.test(c)) {
            if (validate) fail("cursor_invalid", where);
            continue;
          }
          outputs.push(c);
          pass.cursor = c;
        } else if (present[0] === "deleted") {
          const d = e.deleted as Record<string, unknown>;
          if (typeof d !== "object" || d === null || !(ITEM_TYPES as readonly string[]).includes(d.of as string) || idProblem(d.external_id)) {
            if (validate) fail("event_invalid", where);
            continue;
          }
          if (validate && !m.produces.includes(d.of as ItemType)) fail("item_type_not_produced", where);
          outputs.push(d.external_id as string);
          pass.deletions.push({ of: d.of as ItemType, external_id: d.external_id as string });
        } else {
          const it = validate ? checkItem(e.item, where, keys) : (sanitiseItem(e.item as Item) as { item?: Item }).item ?? null;
          if (!it) continue;
          pass.items.push(it);
          pass.hashes.set(itemKey(it), itemHash(it));
        }
      }
    } catch (e) {
      pass.ok = false;
      if (validate) threw("pull", e);
      else if (!(e instanceof ConnectorStateError)) threw("pull", e);
    }
    if (validate && pass.items.length > 0 && pass.cursor === null)
      warn("no_cursor");
    return pass;
  };

  let first: PullPass | null = null;
  if (connector.pull) {
    first = await pull(null, true);
    checks.push("pull");
    if (first.ok && fx.deterministic !== false) {
      const again = await pull(null, false);
      const same = again.hashes.size === first.hashes.size && [...first.hashes].every(([k, h]) => again.hashes.get(k) === h);
      if (again.ok && !same) fail("pull_not_deterministic");
      checks.push("deterministic");
    }
    if (first.ok && first.cursor !== null && fx.incremental !== false) {
      const next = await pull(first.cursor, false);
      const old = [...next.hashes].filter(([k, h]) => first!.hashes.get(k) === h);
      if (old.length > 0) fail("cursor_ignored");
      checks.push("incremental");
    }
  }

  // fetch()
  if (connector.fetch) {
    const sample = (first?.items ?? []).filter((i) => i.type !== "delete").slice(0, fx.fetchSample ?? 20);
    for (const it of sample) {
      try {
        const got = await connector.fetch(runCtx, it.external_id);
        const s = got ? sanitiseItem(got) : null;
        const fetched = s && s.ok ? s.item : null;
        if (fetched) emit(fetched);
        if (!fetched || fetched.type !== it.type || fetched.external_id !== it.external_id || itemHash(fetched) !== itemHash(it))
          fail("fetch_mismatch");
      } catch (e) {
        threw("fetch", e);
      }
    }
    try {
      const missing = await connector.fetch(runCtx, `conformance-missing-${Date.now().toString(36)}`);
      if (missing !== null) {
        fail("fetch_unknown_not_null");
        const s = sanitiseItem(missing);
        if (s.ok) emit(s.item);
      }
    } catch (e) {
      threw("fetch", e);
    }
    checks.push("fetch");
  }

  // parseWebhook()
  if (fx.webhooks?.length) {
    if (!connector.parseWebhook) fail("webhook_missing");
    else {
      for (const [i, w] of fx.webhooks.entries()) {
        const body = typeof w.body === "string" ? new TextEncoder().encode(w.body) : w.body;
        try {
          const r = (await connector.parseWebhook(runCtx, body, w.headers ?? {})) as unknown as Record<string, unknown>;
          const where = `webhook ${i + 1}`;
          if (Array.isArray(r?.refetch) && r.items === undefined) {
            emit(r.refetch);
            if (r.refetch.length > MAX_REFETCH || r.refetch.some(idProblem)) fail("webhook_invalid", where);
          } else if (Array.isArray(r?.items) && r.refetch === undefined) {
            const keys = new Set<string>();
            r.items.forEach((x: unknown, j: number) => checkItem(x, `${where} item ${j + 1}`, keys));
          } else fail("webhook_invalid", where);
        } catch (e) {
          threw("parseWebhook", e);
        }
      }
      checks.push("webhook");
    }
  }

  // lookup()
  if (connector.lookup && fx.lookups?.length) {
    const kinds = m.capabilities.entity_lookup ?? [];
    for (const q of fx.lookups) {
      const limit = q.limit ?? 5;
      try {
        const hits = await connector.lookup(runCtx, q.kind, q.name, limit);
        const bad = !Array.isArray(hits) || hits.length > limit || hits.some((h) =>
          !kinds.includes(h?.kind) || idProblem(h?.id) || typeof h?.name !== "string" || h.name.length === 0 || h.name.length > 300 || CTL.test(h.name));
        if (bad) fail("lookup_invalid");
        emit(hits);
      } catch (e) {
        threw("lookup", e);
      }
    }
    checks.push("lookup");
  }

  return report(first?.items ?? [], first?.deletions ?? [], first?.cursor ?? null, ctxs);
}
