// Runs of connectors in the workers: one run of one connector — a scheduled sync, the first
// passes of a new connector (backfill), a run an administrator asked for, a webhook refetch, or a test. No pg-boss: the
// state rows are the queue (connectors.ts claims them). A run that fetches holds the connector's lease
// (connectors.lease_until / lease_by = "<worker>:<run id>"), extends it every 30 s and gives it back at the end; every
// write of the run that changes the connector row (cursor, state, outcome) is conditioned on that lease, so a run whose
// lease expired or another worker took over cannot record sightings used by the live run's deletion sweep. A test
// run takes no lease: it only calls test() and writes the result into its run row.
//
// A pull run: secrets (settings keyring), the ConnectorCtx (egress client bound to the manifest's origins and the
// installation's private networks, a signal that is the stop of the process, the run deadline and a lost lease, state
// under the lease, log lines that are the projection of a closed schema (diag.ts)), then pull(cursor). Record items → content
// hash → body into the closed bucket → connector_items (stageRecordItem, the hand-over to the delivery of the gateway);
// entity items → upsertEntityBatch in batches of 500; the cursor is saved after the items before it (after every page).
// The run stops at manifest.limits.maxItemsPerRun new or changed items, and at the connector's daily quota (the next run
// then starts with the next day in the installation's time zone).
//
// Deletion marks: a run that ends without being cut, after the connector said the listing is complete ({complete:true},
// a full scan), marks the items of earlier runs it did not name as deleted at the source (record items: status
// deleted_at_source — what happens to their records is the delivery's policy; entities: attrs.source_deleted_at). An
// aborted, capped, quota-stopped or failed run marks nothing; an item staged by a webhook after the run started is
// never marked by it.
//
// Outcome on the connector row: success → failures 0, next run after policy.schedule_sec (at least the manifest's
// minIntervalSec); failure → backoff 1, 2, 4 … 360 minutes by failures in a row, the vendor's Retry-After wins; after
// integrations.connectors_max_failures failures in a row → status error and an audit event (connector_paused);
// configuration errors (run-codes.ts: refused addresses, unreadable or missing secrets, invalid config, a vendor that
// refuses the key) → status error at once. A stop of the process or the run deadline is no failure: the cursor of the
// last finished page is kept and the next run continues.
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import {
  allowedOrigins, applyConfigDefaults, auditConnectorPaused, auditConnectorRun, ConnectorError, createEgressClient, runFailure, testAnswerCode, RUN_CODES,
  bindDiag, isConfigErrorCode, itemHashBytes, loadConnectorSecrets, markEntitiesDeleted, createRedactor, sanitiseItem,
  stageRecordItem, stateProblem, upsertEntityBatch, validateConfig, ENTITY_BATCH_MAX, ITEM_TYPES, type Connector, type ConnectorAuditEvent,
  type ConnectorCtx, type ConnectorRef, type ConnectorRegistry, type DiagBinding, type EgressClient, type EgressOptions, type EntityItem, type Item, type ItemType, type LoadedSecrets,
  type Queryable, type RecordItem,
} from "@memory/connectors";
import { addDays, instanceTz, zonedMidnight } from "@memory/shared";
import type { SettingsKeyring } from "@memory/shared/crypto";

/** Lease of a fetching run on its connector row, and how often the run extends it. */
export const RUN_LEASE_SEC = 120;
export const RUN_HEARTBEAT_MS = 30_000;
/** Longest pull run; the next run continues from the saved cursor. */
export const RUN_DEADLINE_MS = 30 * 60_000;
/** Longest test() call. */
export const TEST_DEADLINE_MS = 60_000;
/** Interval between syncs when the connector's policy names none (the manifest's minIntervalSec is the floor). */
export const DEFAULT_SCHEDULE_SEC = 900;
export const MAX_SCHEDULE_SEC = 7 * 86_400;
/** Backoff after a failed run: 1, 2, 4 … minutes by failures in a row, at most 6 hours. */
export const BACKOFF_MAX_MIN = 360;
/** A vendor's Retry-After is kept, but never shorter than the first backoff step (a 429 with "0" would spin the run). */
export const RETRY_AFTER_MIN_SEC = 60;
/** A webhook refetch cut by a stop, the deadline or a lost lease is queued again with the ids not fetched, at most this often. */
export const WEBHOOK_REQUEUE_MAX = 3;
/** How long the end of a cut pull() is awaited (its finally blocks); a pull that hangs is left behind. */
const RETURN_WAIT_MS = 5_000;
const MAX_CURSOR = 4096;
const CTL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const RECORD_TYPES: readonly string[] = ["document", "meeting", "note"];
const MIB = 1024 * 1024;
/** Codes of a refused entity call that stop the run (the others skip the items). */
const ENTITY_STOP = new Set(["connector_missing", "connector_revoked", "entity_system:missing", "entity_system:invalid", "entity_system:reserved", "entity_system:taken"]);

/**
 * A run that ends the backfill: a successful sync or backfill that listed the source completely, or that reached the end
 * of the source without being cut (a source read by cursor never says "complete"). SQL over connector_runs `r`.
 */
export const PASS_SQL = `(r.kind IN ('sync', 'backfill') AND r.status = 'ok' AND (r.detail @> '{"complete": true}' OR r.detail @> '{"stop": null}'))`;

export interface SettingsLike { get<T>(path: string, fallback: T): T }

/** The closed bucket, as the runs and the cleanup use it. */
export interface StagingStore {
  put(key: string, body: Buffer): Promise<void>;
  remove(key: string): Promise<void>;
  list(prefix: string, max: number): Promise<Array<{ key: string; lastModified: Date | null }>>;
}

export interface ConnectorRunDeps {
  instanceId: string;
  /** The control database as memory_worker. */
  db: Queryable;
  settings: SettingsLike;
  keyring: SettingsKeyring;
  /** The registry of this build for the enabled packs. */
  registry: () => ConnectorRegistry;
  /** Closed bucket; null — not configured (runs that stage items fail with storage_unavailable). */
  storage: () => StagingStore | null;
  /** The workers' audit writer. */
  audit: (e: ConnectorAuditEvent<"processing">) => Promise<void>;
  /** Unique per process: the lease owner is "<workerId>:<run id>". */
  workerId: string;
  /** Stop of the process (SIGTERM). */
  abort?: AbortSignal;
  /** Tests: the egress client of a run (default createEgressClient with the options). */
  egress?: (o: EgressOptions) => EgressClient;
  /** Tests: shorter lease, heartbeat and deadlines. */
  timing?: Partial<{ leaseSec: number; heartbeatMs: number; runDeadlineMs: number; testDeadlineMs: number }>;
}

export const newWorkerId = (): string => `${hostname().slice(0, 64)}:${process.pid}:${randomUUID().slice(0, 8)}`;

/** Settings the scheduler reads — all in one place. */
export function runSettings(s: SettingsLike): { enabled: boolean; concurrency: number; maxFailures: number; dailyItems: number; dailyMb: number } {
  const int = (v: unknown, lo: number, hi: number, dflt: number): number => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : dflt);
  return {
    enabled: s.get<boolean>("integrations.connectors_enabled", true) !== false,
    concurrency: int(s.get<number>("integrations.connectors_sync_concurrency", 2), 1, 8, 2),
    maxFailures: int(s.get<number>("integrations.connectors_max_failures", 8), 1, 100, 8),
    dailyItems: int(s.get<number>("integrations.connectors_daily_items", 1000), 1, 100_000, 1000),
    dailyMb: int(s.get<number>("integrations.connectors_daily_mb", 1024), 1, 102_400, 1024),
  };
}

/** Seconds to wait after a failed run, by the failures in a row before it (0 for the first failure). */
export function backoffSec(failuresBefore: number): number {
  const n = Math.max(0, Math.floor(failuresBefore));
  return Math.min(BACKOFF_MAX_MIN, 2 ** Math.min(n, 16)) * 60;
}

/** Seconds between successful syncs: policy.schedule_sec, at least the manifest's minIntervalSec, at most 7 days. */
export function scheduleSec(minIntervalSec: number, policy: unknown): number {
  const v = (policy as { schedule_sec?: unknown } | null)?.schedule_sec;
  const want = typeof v === "number" && Number.isInteger(v) && v > 0 ? v : DEFAULT_SCHEDULE_SEC;
  return Math.min(MAX_SCHEDULE_SEC, Math.max(minIntervalSec, want));
}

/** Start of the day of `now` and of the next day in the time zone `tz` (ms). */
export function dayBounds(now: Date, tz: string): { start: number; next: number } {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return { start: zonedMidnight(day, tz), next: zonedMidnight(addDays(day, 1), tz) };
}

/** The connector's daily quota: policy.daily_items / policy.daily_mb, else the installation's defaults. */
export function dailyQuota(policy: unknown, d: { dailyItems: number; dailyMb: number }): { items: number; bytes: number } {
  const p = (policy ?? {}) as { daily_items?: unknown; daily_mb?: unknown };
  const items = typeof p.daily_items === "number" && Number.isInteger(p.daily_items) && p.daily_items >= 1 && p.daily_items <= 100_000 ? p.daily_items : d.dailyItems;
  const mb = typeof p.daily_mb === "number" && Number.isInteger(p.daily_mb) && p.daily_mb >= 1 && p.daily_mb <= 102_400 ? p.daily_mb : d.dailyMb;
  return { items, bytes: mb * MIB };
}

/** The connector row a run works with. */
export interface RunConnector {
  id: string; instance_id: string; kind: string; pack: string | null; scope: string; status: string;
  config: Record<string, unknown>; policy: Record<string, unknown>; cursor: string | null; state: unknown; failures: number;
}

/** A claimed run. `token` — the lease owner (absent for tests). */
export interface ClaimedRun {
  runId: string;
  kind: "test" | "sync" | "backfill" | "webhook";
  connector: RunConnector;
  token: string | null;
  /** Manual or test runs: who asked (audit of every outcome). */
  requested: boolean;
  /** Webhook runs: the ids to fetch. */
  refetch: string[];
  /** Webhook runs: how often this refetch was queued again after a cut run (detail.requeued). */
  requeued?: number;
  /** Database time when the run was claimed. */
  startedAt: Date;
}

export interface RunResult {
  status: "ok" | "failed";
  error: string | null;
  seen: number; staged: number; entities: number; unchanged: number; refused: number; deleted: number; bytes: number;
  complete: boolean; stop: "capped" | "quota" | "paused" | null;
  /** Lease expired or another worker owns the connector now. */
  leaseLost?: boolean;
  /** Webhook runs: ids not fetched when the run was cut. */
  remaining?: string[];
}

const ref = (c: RunConnector): ConnectorRef => ({ id: c.id, kind: c.kind, scope: c.scope });

/**
 * Errors the runner built at its own sites, with the code it chose there (the code is
 * picked by the runner's own branch; a connector cannot forge this mark — the map is private to this module).
 */
const OWN = new WeakMap<object, string>();
function coreError(code: string): ConnectorError {
  const e = new ConnectorError(code);
  OWN.set(e, e.code);
  return e;
}

/**
 * The code of a run's error and the vendor's Retry-After: the runner's own mark, else the one classification of
 * @memory/connectors (an egress or secret error the core built, a ConnectorError of the SDK with a code a connector may
 * declare), else `internal`. Nothing of the exception itself — message, name, its own `code`, cause — is read.
 */
function failureOf(e: unknown): { code: string; retryAfterSec: number | null } {
  const own = typeof e === "object" && e !== null ? OWN.get(e) : undefined;
  if (own !== undefined) return { code: RUN_CODES.has(own) ? own : "internal", retryAfterSec: null };
  return runFailure(e);
}

interface Prepared<C = Record<string, unknown>> {
  connector: Connector<C>;
  config: C;
  secrets: LoadedSecrets;
  redact: (t: string) => string;
}

/** Kind, configuration and secrets of a connector; a ConnectorError with a configuration code when one is not usable. */
async function prepare(d: ConnectorRunDeps, c: RunConnector): Promise<Prepared> {
  const connector = d.registry().kinds.get(c.kind) as Connector<Record<string, unknown>> | undefined;
  if (!connector) throw coreError("kind_unknown");
  const m = connector.manifest;
  if (validateConfig(m, c.config).length > 0) throw coreError("config_invalid");
  const config = applyConfigDefaults(m, c.config);
  if ((connector.validate?.(config) ?? []).length > 0) throw coreError("config_invalid");
  const secrets = await loadConnectorSecrets(d.db, d.keyring, c.id);
  const own = new Set(m.secrets.map((s) => s.name));
  if (secrets.unreadable().some((n) => own.has(n))) throw coreError("secret_unreadable");
  const names = new Set(secrets.names());
  if (m.secrets.some((s) => s.required && !names.has(s.name))) throw coreError("secret_missing");
  const values = [...own].filter((n) => names.has(n)).map((n) => secrets.get(n));
  // The redactor is built before the context and before test/pull/fetch; partial redaction is never used. A secret
  // it cannot cover in its budget gives the closed redactor (every text changes) — the run goes on, every diagnostic line
  // of it is the constant refusal (diag.ts), so the value reaches no log line; the run's codes are the core's (failure.ts)
  const redact = createRedactor(values);
  return { connector, config, secrets, redact };
}

/**
 * The diagnostic writers of one run: the ids are bound here from the claimed row and run, the kind only when
 * the registry of this build has it; the run's redactor is the second layer; the counts are what the runner measured.
 */
function runDiag(d: ConnectorRunDeps, run: ClaimedRun, p: Prepared, measures?: () => { items: number; events: number; pages: number }): DiagBinding {
  return bindDiag({ connectorId: run.connector.id, runId: run.runId, kind: run.connector.kind, registry: d.registry(), redact: p.redact, ...(measures ? { measures } : {}) });
}

/** The ConnectorCtx of a run. `state.set` writes under the lease (tests get a read-only state). */
function makeCtx(d: ConnectorRunDeps, run: ClaimedRun, p: Prepared, signal: AbortSignal, onLeaseLost: () => void, diag: DiagBinding): ConnectorCtx<Record<string, unknown>> {
  const m = p.connector.manifest;
  const own = new Set(m.secrets.map((s) => s.name));
  const egressOpts: EgressOptions = {
    origins: allowedOrigins(m, p.config),
    privateNetworks: () => d.settings.get<string[]>("integrations.connectors_private_networks", []),   // read on every request
    maxResponseBytes: Math.min(64 * MIB, Math.max(MIB, m.limits.maxBytesPerItem)),
    signal,
  };
  let state: unknown = run.connector.state ?? {};
  return {
    config: p.config,
    secret: (name) => (own.has(name) ? p.secrets.get(name) : null),
    http: (d.egress ?? createEgressClient)(egressOpts),
    state: {
      get: async () => structuredClone(state),
      set: async (v) => {
        if (!run.token) throw coreError("state_readonly");
        const problem = stateProblem(v);
        if (problem) throw coreError(problem.code);
        const r = await d.db.query("UPDATE connectors SET state = $3::jsonb, updated_at = now() WHERE id = $1 AND lease_by = $2 AND lease_until > clock_timestamp()", [run.connector.id, run.token, JSON.stringify(v)]);
        if (!r.rowCount) { onLeaseLost(); throw coreError("lease_lost"); }
        state = structuredClone(v);
      },
    },
    // the projection of the closed schema (diag.ts) or the one constant refusal; redact.ts only as the second layer
    log: (event: unknown, fields?: unknown) => { diag.connector(event, fields); },
    signal,
    now: () => new Date(),
  };
}

/** Bytes an item brings (its file or its text): the daily quota counts them. */
function itemBytes(item: RecordItem): number {
  if (item.type === "document" && item.content instanceof Uint8Array) return item.content.byteLength;
  if (item.type === "document" && typeof item.content_base64 === "string") return Math.floor((item.content_base64.length * 3) / 4);
  return Buffer.byteLength(JSON.stringify(item), "utf8");
}


/** A test run: test() under its deadline; the result (ok or a code, latency) goes into the run row. */
export async function runTest(d: ConnectorRunDeps, run: ClaimedRun): Promise<RunResult & { code: string; latencyMs: number }> {
  const t0 = Date.now();
  const base: RunResult = { status: "failed", error: null, seen: 0, staged: 0, entities: 0, unchanged: 0, refused: 0, deleted: 0, bytes: 0, complete: false, stop: null };
  const ac = new AbortController();
  const deadline = setTimeout(() => ac.abort(), d.timing?.testDeadlineMs ?? TEST_DEADLINE_MS);
  deadline.unref?.();
  const signal = d.abort ? AbortSignal.any([ac.signal, d.abort]) : ac.signal;
  let code: string;
  try {
    if (run.connector.status === "revoked") throw coreError("connector_revoked");
    const p = await prepare(d, run.connector);
    signal.throwIfAborted();
    const ctx = makeCtx(d, run, p, signal, () => undefined, runDiag(d, run, p));
    const res = await Promise.race([
      p.connector.test(ctx),
      new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(coreError(d.abort?.aborted ? "aborted" : "deadline")), { once: true })),
    ]);
    // `ok`, or a code a connector may declare, read as own data (no getter, no proxy); anything else internal
    code = testAnswerCode(res);
  } catch (e) {
    code = signal.aborted ? (d.abort?.aborted ? "aborted" : "deadline") : failureOf(e).code;
  } finally {
    clearTimeout(deadline);
  }
  const latencyMs = Date.now() - t0;
  const ok = code === "ok";
  await d.db.query("UPDATE connector_runs SET status = $2, error = $3, finished_at = now(), detail = $4::jsonb WHERE id = $1",
    [run.runId, ok ? "ok" : "failed", ok ? null : code, JSON.stringify({ code, latency_ms: latencyMs })]);
  await d.audit(auditConnectorRun(ref(run.connector), { run_id: run.runId, kind: "test", status: ok ? "ok" : "failed", seen: 0, staged: 0, ...(ok ? {} : { error: code }) }))
    .catch(() => undefined);
  return { ...base, status: ok ? "ok" : "failed", error: ok ? null : code, code, latencyMs };
}

/** A fetching run (sync, backfill, webhook refetch) under the connector's lease. */
export async function runPull(d: ConnectorRunDeps, run: ClaimedRun): Promise<RunResult> {
  const c = run.connector;
  const token = run.token!;
  const leaseSec = d.timing?.leaseSec ?? RUN_LEASE_SEC;
  const r: RunResult = { status: "ok", error: null, seen: 0, staged: 0, entities: 0, unchanged: 0, refused: 0, deleted: 0, bytes: 0, complete: false, stop: null };
  const ac = new AbortController();
  let why: "lease_lost" | "deadline" | null = null;
  const lost = () => { if (!why) why = "lease_lost"; ac.abort(); };
  const deadline = setTimeout(() => { if (!why) why = "deadline"; ac.abort(); }, d.timing?.runDeadlineMs ?? RUN_DEADLINE_MS);
  deadline.unref?.();
  // the lease counts as lost when it was not extended for leaseSec (heartbeats that fail, a database that hangs): another
  // worker may own the connector by then
  let extendedAt = performance.now();
  const expired = (): boolean => performance.now() - extendedAt >= leaseSec * 1000;
  const checkLease = (): void => {
    if (expired() || why === "lease_lost") { lost(); throw coreError("lease_lost"); }
  };
  const heartbeat = setInterval(() => {
    if (expired()) { lost(); return; }
    const sentAt = performance.now();
    void d.db.query("UPDATE connectors SET lease_until = now() + make_interval(secs => $3) WHERE id = $1 AND lease_by = $2 AND lease_until > clock_timestamp()", [c.id, token, leaseSec])
      .then((x) => { if (!x.rowCount) lost(); else extendedAt = Math.max(extendedAt, sentAt); }, () => { if (expired()) lost(); });
  }, d.timing?.heartbeatMs ?? RUN_HEARTBEAT_MS);
  heartbeat.unref?.();
  const signal = d.abort ? AbortSignal.any([ac.signal, d.abort]) : ac.signal;
  const stopCode = (): string => (d.abort?.aborted ? "aborted" : why ?? "aborted");
  // calls into the connector race the signal: a pull() or fetch() that ignores it cannot hold the run, its slot and the
  // lease past the deadline or a stop of the process
  const stopped = new Promise<never>((_, reject) => {
    const fire = (): void => reject(coreError(stopCode()));
    if (signal.aborted) fire(); else signal.addEventListener("abort", fire, { once: true });
  });
  stopped.catch(() => undefined);
  const guard = <T>(p: Promise<T>): Promise<T> => Promise.race([p, stopped]);
  /** Extends the lease now and only while it is still ours and alive; false — lost. */
  const holdLease = async (): Promise<boolean> => {
    checkLease();
    const sentAt = performance.now();
    const x = await d.db.query(
      "UPDATE connectors SET lease_until = now() + make_interval(secs => $3) WHERE id = $1 AND lease_by = $2 AND lease_until > clock_timestamp() RETURNING 1", [c.id, token, leaseSec]);
    if (!x.rowCount) { lost(); return false; }
    extendedAt = Math.max(extendedAt, sentAt);
    return true;
  };
  const LEASED = "EXISTS (SELECT 1 FROM connectors l WHERE l.id = $1 AND l.lease_by = $LEASE AND l.lease_until > clock_timestamp())";

  let failure: { code: string; retryAfterSec: number | null } | null = null;
  let p: Prepared | null = null;
  /** What the runner itself counted for the diagnostic lines (no number a connector supplies enters a line). */
  const counted = { events: 0, pages: 0 };
  let diag: DiagBinding | null = null;
  let maxItems = 0, minInterval = 60;
  try {
    p = await prepare(d, c);
    const m = p.connector.manifest;
    maxItems = m.limits.maxItemsPerRun;
    minInterval = m.limits.minIntervalSec;
    if (run.kind === "webhook" ? !p.connector.fetch : !p.connector.pull) throw coreError("pull_unsupported");
    diag = runDiag(d, run, p, () => ({ items: r.seen, events: counted.events, pages: counted.pages }));
    const ctx = makeCtx(d, run, p, signal, lost, diag);
    const store = d.storage();
    const put = async (key: string, body: Buffer): Promise<void> => {
      if (!store) throw coreError("storage_unavailable");
      try { await store.put(key, body); } catch { throw coreError("storage_unavailable"); }
    };
    const s = runSettings(d.settings);
    const quota = dailyQuota(c.policy, s);
    const day = dayBounds(run.startedAt, instanceTz(d.settings));
    const used = (await d.db.query(
      "SELECT COALESCE(sum(staged), 0)::bigint AS items, COALESCE(sum(CASE WHEN jsonb_typeof(detail -> 'bytes') = 'number' THEN (detail ->> 'bytes')::numeric END), 0)::bigint AS bytes "
      + "FROM connector_runs WHERE connector_id = $1 AND id <> $2 AND kind <> 'test' AND started_at >= $3",
      [c.id, run.runId, new Date(day.start)])).rows[0] as { items: string; bytes: string };
    const usedItems = Number(used.items), usedBytes = Number(used.bytes);
    const quotaLeft = (): boolean => usedItems + r.staged < quota.items && usedBytes + r.bytes < quota.bytes;

    let entityBuf: EntityItem[] = [];
    const markSeen = async (type: string, ids: string[]): Promise<void> => {
      if (!(ITEM_TYPES as readonly string[]).includes(type) || ids.length === 0) return;
      checkLease();
      // The shared writers receive no runId: every sighting, including their unchanged and duplicate paths, is
      // recorded here. Lock the live connector row in the same statement, so a take-over cannot race the sighting.
      const x = await d.db.query(
        `WITH live AS MATERIALIZED (SELECT id FROM connectors WHERE id = $1 AND lease_by = $5 AND lease_until > clock_timestamp() FOR UPDATE),
              marked AS (UPDATE connector_items i SET seen_run = $4 FROM live
                          WHERE i.connector_id = live.id AND i.item_type = $2 AND i.external_id = ANY($3::text[]) RETURNING 1)
         SELECT EXISTS (SELECT 1 FROM live) AS leased, (SELECT count(*) FROM marked) AS marked`,
        [c.id, type, ids, run.runId, token]);
      if (!x.rows[0]?.leased) { lost(); throw coreError("lease_lost"); }
    };
    const flushEntities = async (): Promise<void> => {
      if (entityBuf.length === 0) return;
      if (!(await holdLease())) throw coreError("lease_lost");
      const batch = entityBuf;
      const res = await upsertEntityBatch(d.db, d.instanceId, c.id, batch);
      const first = res.items[0]?.reason;
      if (first && ENTITY_STOP.has(first) && res.items.every((o) => o.reason === first))
        throw coreError(first === "connector_missing" ? "connector_revoked" : first);
      r.entities += res.inserted + res.updated;
      r.unchanged += res.unchanged;
      r.refused += res.refused;
      await markSeen("entity", res.items.map((o) => o.external_id));
      entityBuf = [];
    };
    const deleted = async (of: unknown, externalId: unknown): Promise<void> => {
      if (typeof externalId !== "string" || !(ITEM_TYPES as readonly string[]).includes(of as string)) { r.refused++; return; }
      if (!(await holdLease())) throw coreError("lease_lost");
      if (of === "entity") {
        await flushEntities();
        const x = await markEntitiesDeleted(d.db, d.instanceId, c.id, [externalId]);
        r.deleted += x.items;
        return;
      }
      const x = await d.db.query(
        "UPDATE connector_items SET status = 'deleted_at_source', reason = NULL, lease_until = NULL, next_attempt_at = now(), received_at = now() "
        + `WHERE connector_id = $1 AND item_type = $2 AND external_id = $3 AND status <> 'deleted_at_source' AND ${LEASED.replace("$LEASE", "$4")}`,
        [c.id, of, externalId, token]);
      r.deleted += x.rowCount ?? 0;
    };
    const capped = (): boolean => maxItems > 0 && r.staged + r.entities >= maxItems;
    // A listing names again an item that delivery held, refused or skipped, with the same content: nothing new from the
    // source, so the item keeps its state and attempts and is only marked seen (staging it again would re-upload the
    // body, restart a delivery that gives the same answer, and spend the cap and the daily quota on every pass). A
    // webhook refetch keeps the meaning "the source sent it again": it stages the item anew (stageRecordItem).
    const relisted = run.kind === "webhook" ? null : async (item: RecordItem): Promise<boolean> => {
      let hash: Buffer;
      try { hash = itemHashBytes(item); } catch { return false; }
      const x = await d.db.query(
        "SELECT 1 FROM connector_items WHERE connector_id = $1 AND item_type = $2 AND external_id = $3 AND content_hash = $4 AND status IN ('held', 'failed', 'skipped')",
        [c.id, item.type, item.external_id, hash]);
      return (x.rowCount ?? 0) > 0;
    };

    /** One item of the source; false — the run stops here (cap or quota). */
    const take = async (raw: Item): Promise<boolean> => {
      checkLease();
      if (signal.aborted) throw coreError(stopCode());
      r.seen++;
      const s0 = sanitiseItem(raw);
      if (!s0.ok) {
        r.refused++;
        const x = raw as { type?: unknown; external_id?: unknown } | null;
        if (x && typeof x.type === "string" && typeof x.external_id === "string") await markSeen(x.type, [x.external_id]);
        return true;
      }
      const item = s0.item;
      if (item.type === "delete") { await deleted(item.of, item.external_id); return true; }
      if (!m.produces.includes(item.type as ItemType)) { r.refused++; await markSeen(item.type, [item.external_id]); return true; }
      if (item.type === "entity") {
        entityBuf.push(item);
        if (entityBuf.length >= ENTITY_BATCH_MAX) await flushEntities();
        if (capped()) { r.stop = "capped"; return false; }
        return true;
      }
      if (relisted && await relisted(item as RecordItem)) { await markSeen(item.type, [item.external_id]); r.unchanged++; return true; }
      if (!quotaLeft()) { r.stop = "quota"; r.seen--; return false; }
      const res = await stageRecordItem(d.db, put, c.id, item as RecordItem, { maxBytes: m.limits.maxBytesPerItem });
      if (!res.ok) { r.refused++; await markSeen(item.type, [item.external_id]); return true; }
      await markSeen(item.type, [item.external_id]);
      if (res.changed) { r.staged++; r.bytes += itemBytes(item as RecordItem); } else if (res.status === "unchanged") r.unchanged++;
      if (capped()) { r.stop = "capped"; return false; }
      return true;
    };

    if (run.kind === "webhook") {
      let i = 0;
      let bufferedFrom: number | null = null;
      try {
        for (; i < run.refetch.length; i++) {
          if (signal.aborted) break;
          const item = await guard(Promise.resolve(p.connector.fetch!(ctx, run.refetch[i]!)));
          if (item?.type === "entity" && bufferedFrom === null) bufferedFrom = i;
          if (item && !(await take(item))) { i++; break; }
          if (entityBuf.length === 0) bufferedFrom = null;
        }
      } finally {
        if (signal.aborted) r.remaining = run.refetch.slice(i);
        // A rejected fetch must not skip the already fetched entities. With a lost lease they cannot be flushed:
        // retry their fetch ids too, rather than losing them or writing sightings for a dead run.
        try { await flushEntities(); }
        catch (e) {
          if (signal.aborted) r.remaining = run.refetch.slice(bufferedFrom ?? i);
          throw e;
        }
      }
    } else {
      let listedComplete = false;
      const it = p.connector.pull!(ctx, c.cursor)[Symbol.asyncIterator]();
      try {
        for (;;) {
          if (signal.aborted) break;
          const next = await guard(it.next());
          if (next.done) { r.complete = listedComplete; break; }
          const ev = next.value as Record<string, unknown>;
          counted.events++;
          if (signal.aborted) break;
          if (ev && typeof ev === "object" && "item" in ev) {
            if (!(await take(ev.item as Item))) break;
          } else if (ev && "cursor" in ev) {
            await flushEntities();
            const cur = ev.cursor;
            if (typeof cur !== "string" || cur.length === 0 || cur.length > MAX_CURSOR || CTL.test(cur)) { diag?.core("connector_cursor_refused", {}, "warn"); continue; }
            checkLease();
            const sentAt = performance.now();
            const x = await d.db.query(
              "UPDATE connectors SET cursor = $3, lease_until = now() + make_interval(secs => $4), updated_at = now() WHERE id = $1 AND lease_by = $2 AND lease_until > clock_timestamp() RETURNING status",
              [c.id, token, cur, leaseSec]);
            if (!x.rowCount) { lost(); break; }
            extendedAt = Math.max(extendedAt, sentAt);
            counted.pages++;
            if (x.rows[0].status !== "active") { r.stop = "paused"; break; }
          } else if (ev && "deleted" in ev) {
            const del = ev.deleted as { of?: unknown; external_id?: unknown } | null;
            await deleted(del?.of, del?.external_id);
          } else if (ev && "complete" in ev && ev.complete === true) {
            listedComplete = true;
          }
        }
      } finally {
        // a pull cut while it waits inside next() cannot finish its return() before that wait ends: never await it unbounded
        if (!r.complete && it.return) {
          const ended = Promise.resolve().then(() => it.return!(undefined)).catch(() => undefined);
          let t: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([ended, new Promise((res) => { t = setTimeout(res, signal.aborted ? 0 : RETURN_WAIT_MS); t.unref?.(); })]);
          clearTimeout(t);
        }
      }
      await flushEntities();
    }
    if (signal.aborted) throw coreError(stopCode());

    // deletion marks: only after a complete listing that was not cut
    // and under a lease that is still ours: a run that lost it (another worker may have listed since) marks nothing. The
    // lease is extended first (it then holds for leaseSec), and every statement checks it again.
    if (r.complete && !r.stop && run.kind !== "webhook") {
      if (!(await holdLease())) throw coreError("lease_lost");
      const gone = await d.db.query(
        "UPDATE connector_items SET status = 'deleted_at_source', reason = NULL, lease_until = NULL, next_attempt_at = now(), received_at = now() "
        + "WHERE connector_id = $1 AND item_type = ANY($3::text[]) AND seen_run IS DISTINCT FROM $2 AND status <> 'deleted_at_source' AND received_at < $4 "
        + `AND ${LEASED.replace("$LEASE", "$5")}`,
        [c.id, run.runId, RECORD_TYPES, run.startedAt, token]);
      r.deleted += gone.rowCount ?? 0;
      const ents = await d.db.query(
        "SELECT external_id FROM connector_items WHERE connector_id = $1 AND item_type = 'entity' AND seen_run IS DISTINCT FROM $2 AND status <> 'deleted_at_source' AND received_at < $3 "
        + `AND ${LEASED.replace("$LEASE", "$4")}`,
        [c.id, run.runId, run.startedAt, token]);
      if (ents.rows.length > 0) {
        const x = await markEntitiesDeleted(d.db, d.instanceId, c.id, ents.rows.map((e: { external_id: string }) => e.external_id));
        r.deleted += x.items;
      }
    }
  } catch (e) {
    failure = signal.aborted ? { code: stopCode(), retryAfterSec: null } : failureOf(e);
  } finally {
    clearTimeout(deadline);
    clearInterval(heartbeat);
  }
  if (r.stop === "capped" || r.stop === "quota" || r.stop === "paused") r.complete = false;
  if (failure) { r.status = "failed"; r.error = failure.code; }
  if (why === "lease_lost" || failure?.code === "lease_lost") {
    r.leaseLost = true;
    r.status = "failed";
    r.error = "lease_lost";
  }
  await finishPull(d, run, r, failure, { minInterval });
  return r;
}

/** The outcome of a fetching run on its run row and (under the lease) on its connector row; audit events. */
async function finishPull(d: ConnectorRunDeps, run: ClaimedRun, r: RunResult, failure: { code: string; retryAfterSec: number | null } | null,
                          o: { minInterval: number }): Promise<void> {
  const c = run.connector;
  const webhook = run.kind === "webhook";
  const cut = failure !== null && (failure.code === "aborted" || failure.code === "deadline" || failure.code === "lease_lost");
  // a webhook refetch cut before its end is queued again with the ids not fetched yet (before the run row is closed:
  // if the process dies in between, the cleanup closes the row and the refetch is at most done twice, which is harmless)
  const requeued = run.requeued ?? 0;
  if (webhook && cut && (r.remaining?.length ?? 0) > 0 && requeued < WEBHOOK_REQUEUE_MAX)
    await d.db.query("INSERT INTO connector_runs (id, connector_id, kind, status, detail) VALUES ($1, $2, 'webhook', 'queued', $3::jsonb)",
      [randomUUID(), c.id, JSON.stringify({ refetch: r.remaining, requeued: requeued + 1 })]).catch(() => undefined);
  const detail = { complete: r.complete, stop: r.stop, entities: r.entities, unchanged: r.unchanged, refused: r.refused, deleted: r.deleted, bytes: r.bytes,
                   ...(webhook ? { refetched: run.refetch.length, ...(r.remaining?.length ? { not_fetched: r.remaining.length } : {}) } : {}) };
  await d.db.query("UPDATE connector_runs SET status = $2, error = $3, seen = $4, staged = $5, detail = $6::jsonb, finished_at = now() WHERE id = $1",
    [run.runId, r.status, r.error, r.seen, r.staged, JSON.stringify(detail)]);
  let paused = false;
  // A self-declared loss still owns its token: count the failure and back off atomically under that token, even
  // though its lease expired. If a replacement claimed it, every UPDATE below matches no row and leaves it alone.
  if (!r.leaseLost || failure?.code === "lease_lost") {
    const keep = "lease_until = NULL, lease_by = NULL, last_run_at = now(), updated_at = now()";
    const configError = failure !== null && isConfigErrorCode(failure.code);
    if (webhook && !configError) {
      // A webhook refetch is not a pass of the pulls: its outcome lives in its run row. It neither moves their schedule
      // nor counts or clears their failures (a burst of failing refetches would pause the connector within a minute;
      // a good refetch would hide a failing pull).
      await d.db.query("UPDATE connectors SET lease_until = NULL, lease_by = NULL, updated_at = now() WHERE id = $1 AND lease_by = $2", [c.id, run.token]);
    } else if (!failure) {
      const until = r.stop === "quota" ? new Date(dayBounds(run.startedAt, instanceTz(d.settings)).next) : null;
      await d.db.query(
        `UPDATE connectors SET ${keep}, last_ok_at = now(), failures = 0,
                last_error = CASE WHEN last_error = 'upload_daily' THEN last_error END,
                next_run_at = CASE WHEN $3::timestamptz IS NOT NULL THEN $3::timestamptz ELSE now() + make_interval(secs => $4) END
          WHERE id = $1 AND lease_by = $2`,
        [c.id, run.token, until, scheduleSec(o.minInterval, c.policy)]);
    } else if (failure.code === "aborted" || failure.code === "deadline") {
      // no failure of the source: the next run continues from the saved cursor
      await d.db.query(`UPDATE connectors SET ${keep}, next_run_at = CASE WHEN $3 THEN now() ELSE now() + make_interval(secs => $4) END WHERE id = $1 AND lease_by = $2`,
        [c.id, run.token, failure.code === "aborted", o.minInterval]);
    } else if (failure.code === "pull_unsupported" || failure.code === "connector_revoked") {
      await d.db.query(`UPDATE connectors SET ${keep} WHERE id = $1 AND lease_by = $2`, [c.id, run.token]);
    } else {
      // a configuration error stops the connector whatever the run (a webhook refetch too); other failures back off
      const s = runSettings(d.settings);
      const stop = configError || c.failures + 1 >= s.maxFailures;
      const wait = failure.retryAfterSec !== null ? Math.max(RETRY_AFTER_MIN_SEC, failure.retryAfterSec) : backoffSec(c.failures);
      const x = await d.db.query(
        `UPDATE connectors SET ${webhook ? "lease_until = NULL, lease_by = NULL, updated_at = now()" : keep}, failures = failures + 1, last_error = $3,
                status = CASE WHEN status = 'active' AND $4 THEN 'error' ELSE status END,
                next_run_at = CASE WHEN $6 THEN next_run_at ELSE now() + make_interval(secs => $5) END
          WHERE id = $1 AND lease_by = $2 RETURNING status`,
        [c.id, run.token, failure.code, stop, wait, webhook]);
      paused = stop && x.rows[0]?.status === "error";
    }
  }
  const worth = r.staged > 0 || r.entities > 0 || r.deleted > 0 || r.status === "failed" || run.requested;
  if (worth)
    await d.audit(auditConnectorRun(ref(c), { run_id: run.runId, kind: run.kind, status: r.status, seen: r.seen, staged: r.staged, entities: r.entities,
                                             deleted: r.deleted, ...(r.error ? { error: r.error } : {}) })).catch(() => undefined);
  if (paused) await d.audit(auditConnectorPaused(ref(c), failure!.code)).catch(() => undefined);
}
