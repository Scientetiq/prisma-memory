// The scheduler of connectors in the workers. No pg-boss queue: the state rows are the queue.
// A tick every 5 s claims, oldest first:
//   (a) queued rows of connector_runs — tests (no lease: they only call test()), runs an administrator asked for and
//       webhook refetches (they take the connector's lease, and wait while another run holds it); a queued fetching run
//       of a connector that is not active fails at once with connector_not_active;
//   (b) active connectors of a kind that pulls, whose next_run_at is due and whose lease is free.
// A claim is one statement with FOR UPDATE SKIP LOCKED, so two worker processes never run one connector twice; a lease
// that was not extended for 2 minutes (a worker that died) is taken over by the next tick of any worker. At most
// integrations.connectors_sync_concurrency fetching runs per process, and two tests besides. With
// integrations.connectors_enabled = false the tick does nothing; without queued runs and due connectors it makes two
// cheap indexed queries and writes nothing. The cleanup of staged bodies, events and runs runs every 10 minutes
// (connectors-cleanup.ts).
import { randomUUID } from "node:crypto";
import { builtinConnectors, failureClass, type ConnectorRegistry } from "@memory/connectors";
import { log, s3List, s3Put, s3Remove } from "@memory/shared";
import type { SettingsKeyring } from "@memory/shared/crypto";
import { auditWorker, type Ctx } from "../ctx.ts";
import type { Every } from "./admin-plane.ts";
import { connectorsCleanup } from "./connectors-cleanup.ts";
import { newWorkerId, PASS_SQL, RUN_LEASE_SEC, runPull, runSettings, runTest, type ClaimedRun, type ConnectorRunDeps, type RunConnector, type StagingStore } from "./connectors-run.ts";

export const CONNECTOR_TICK_MS = 5_000;
export const CONNECTOR_CLEANUP_MS = 600_000;
/** Tests run beside the fetching runs: an administrator gets the answer within a tick even while syncs run. */
export const TEST_PARALLEL = 2;

const COLS = "c.id, c.instance_id, c.kind, c.pack, c.scope, c.status, c.config, c.policy, c.cursor, c.state, c.failures";

export interface ConnectorScheduler {
  /** One tick (ticks never overlap: a tick while one runs returns the running one). */
  tick(): Promise<void>;
  /** Resolves when every run started so far has ended. */
  idle(): Promise<void>;
  /** Runs going on now. */
  running(): { tests: number; runs: number };
}

/** Kinds of the registry that pull by themselves (the scheduler claims only those). */
const pullKinds = (reg: ConnectorRegistry): string[] => [...reg.kinds.values()].filter((k) => k.manifest.capabilities.pull === true).map((k) => k.manifest.kind);

/** Kind of the next fetching run of a connector: `backfill` until one pass has gone through the source. */
async function syncKind(d: ConnectorRunDeps, connectorId: string): Promise<"sync" | "backfill"> {
  const { rows } = await d.db.query(`SELECT EXISTS (SELECT 1 FROM connector_runs r WHERE r.connector_id = $1 AND ${PASS_SQL}) AS done`, [connectorId]);
  return rows[0]?.done ? "sync" : "backfill";
}

export function createConnectorScheduler(d: ConnectorRunDeps): ConnectorScheduler {
  const runs = new Set<Promise<unknown>>();
  let tests = 0, pulls = 0;
  let current: Promise<void> | null = null;
  const leaseSec = d.timing?.leaseSec ?? RUN_LEASE_SEC;

  const spawn = (p: Promise<unknown>, kind: "test" | "pull"): void => {
    // a class of the failure, never the exception
    const done = p.catch((e) => log.warn("connector_run_failed", { error: failureClass(e) })).finally(() => {
      if (kind === "test") tests--; else pulls--;
      runs.delete(done);
    });
    runs.add(done);
  };

  const claimTest = async (): Promise<ClaimedRun | null> => {
    const { rows } = await d.db.query(
      `WITH pick AS (SELECT r.id FROM connector_runs r JOIN connectors c ON c.id = r.connector_id
                      WHERE r.status = 'queued' AND r.kind = 'test' AND c.instance_id = $1
                      ORDER BY r.created_at, r.id LIMIT 1 FOR UPDATE OF r SKIP LOCKED)
       UPDATE connector_runs r SET status = 'running', started_at = now() FROM pick WHERE r.id = pick.id
       RETURNING r.id, r.connector_id, r.requested_by, now() AS db_now`, [d.instanceId]);
    const run = rows[0] as { id: string; connector_id: string; db_now: Date } | undefined;
    if (!run) return null;
    const c = (await d.db.query(`SELECT ${COLS} FROM connectors c WHERE c.id = $1`, [run.connector_id])).rows[0] as RunConnector;
    return { runId: run.id, kind: "test", connector: c, token: null, requested: true, refetch: [], startedAt: run.db_now };
  };

  const claimQueued = async (): Promise<ClaimedRun | null> => {
    // the lease owner names the claimed run: "<worker>:<run id>"
    const { rows } = await d.db.query(
      `WITH pick AS (SELECT r.id AS run_id, c.id AS cid FROM connector_runs r JOIN connectors c ON c.id = r.connector_id
                      WHERE r.status = 'queued' AND r.kind <> 'test' AND c.instance_id = $1 AND c.status = 'active'
                        AND (c.lease_until IS NULL OR c.lease_until < now())
                      ORDER BY r.created_at, r.id LIMIT 1 FOR UPDATE OF r, c SKIP LOCKED),
            lease AS (UPDATE connectors c SET lease_until = now() + make_interval(secs => $2), lease_by = $3 || ':' || pick.run_id::text
                        FROM pick WHERE c.id = pick.cid RETURNING ${COLS}, c.lease_by)
       UPDATE connector_runs r SET status = 'running', started_at = now() FROM pick, lease WHERE r.id = pick.run_id
       RETURNING r.id AS run_id, r.kind AS run_kind, r.detail AS run_detail, r.requested_by, now() AS db_now, lease.*`,
      [d.instanceId, leaseSec, d.workerId]);
    const x = rows[0] as (RunConnector & { run_id: string; run_kind: string; run_detail: unknown; requested_by: string | null; db_now: Date; lease_by: string }) | undefined;
    if (!x) return null;
    const { run_id, run_kind, run_detail, requested_by, db_now, lease_by, ...c } = x;
    const refetch = run_kind === "webhook" ? refetchIds(run_detail) : [];
    const n = (run_detail as { requeued?: unknown } | null)?.requeued;
    const requeued = typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : 0;
    let kind = run_kind as ClaimedRun["kind"];
    if (kind === "sync" || kind === "backfill") {
      kind = await syncKind(d, c.id);
      if (kind !== run_kind) await d.db.query("UPDATE connector_runs SET kind = $2 WHERE id = $1", [run_id, kind]);
    }
    return { runId: run_id, kind, connector: c as RunConnector, token: lease_by, requested: requested_by !== null, refetch, requeued, startedAt: db_now };
  };

  const claimDue = async (kinds: string[]): Promise<ClaimedRun | null> => {
    if (kinds.length === 0) return null;
    const runId = randomUUID();
    const token = `${d.workerId}:${runId}`;
    const { rows } = await d.db.query(
      `WITH pick AS (SELECT id FROM connectors
                      WHERE instance_id = $1 AND status = 'active' AND kind = ANY($2::text[])
                        AND (next_run_at IS NULL OR next_run_at <= now()) AND (lease_until IS NULL OR lease_until < now())
                      ORDER BY next_run_at NULLS FIRST, id LIMIT 1 FOR UPDATE SKIP LOCKED)
       UPDATE connectors c SET lease_until = now() + make_interval(secs => $3), lease_by = $4 FROM pick WHERE c.id = pick.id
       RETURNING ${COLS}, now() AS db_now`, [d.instanceId, kinds, leaseSec, token]);
    const x = rows[0] as (RunConnector & { db_now: Date }) | undefined;
    if (!x) return null;
    const { db_now, ...c } = x;
    const kind = await syncKind(d, c.id);
    await d.db.query("INSERT INTO connector_runs (id, connector_id, kind, status, started_at) VALUES ($1, $2, $3, 'running', now())", [runId, c.id, kind]);
    return { runId, kind, connector: c as RunConnector, token, requested: false, refetch: [], startedAt: db_now };
  };

  const tickOnce = async (): Promise<void> => {
    const s = runSettings(d.settings);
    if (!s.enabled) return;
    // (a) queued runs: one cheap indexed query decides whether there are any
    const queued = (await d.db.query(
      "SELECT EXISTS (SELECT 1 FROM connector_runs r JOIN connectors c ON c.id = r.connector_id WHERE r.status = 'queued' AND c.instance_id = $1) AS any",
      [d.instanceId])).rows[0]?.any === true;
    if (queued) {
      await d.db.query(
        `UPDATE connector_runs r SET status = 'failed', started_at = now(), finished_at = now(),
                error = CASE WHEN c.status = 'revoked' THEN 'connector_revoked' ELSE 'connector_not_active' END
           FROM connectors c WHERE c.id = r.connector_id AND c.instance_id = $1 AND r.status = 'queued' AND r.kind <> 'test' AND c.status <> 'active'`,
        [d.instanceId]);
      while (tests < TEST_PARALLEL) {
        const t = await claimTest();
        if (!t) break;
        tests++;
        spawn(runTest(d, t), "test");
      }
      while (pulls < s.concurrency) {
        const r = await claimQueued();
        if (!r) break;
        pulls++;
        spawn(runPull(d, r), "pull");
      }
    }
    // (b) due connectors
    const kinds = pullKinds(d.registry());
    while (pulls < s.concurrency) {
      const r = await claimDue(kinds);
      if (!r) break;
      pulls++;
      spawn(runPull(d, r), "pull");
    }
  };

  return {
    tick() {
      current ??= tickOnce().finally(() => { current = null; });
      return current;
    },
    async idle() {
      while (runs.size > 0) await Promise.all([...runs]);
    },
    running: () => ({ tests, runs: pulls }),
  };
}

/** Ids a webhook run fetches: `detail.refetch` written by the hooks handler (strings of 1–200 characters, at most 100). */
export function refetchIds(detail: unknown): string[] {
  const list = (detail as { refetch?: unknown } | null)?.refetch;
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 200))].slice(0, 100);
}

/** The closed bucket of the workers as the runs and the cleanup use it; null while the closed class has no storage. */
export function closedStaging(ctx: Pick<Ctx, "s3">): StagingStore | null {
  const t = ctx.s3("closed");
  if (!t) return null;
  return {
    put: async (key, body) => { await s3Put(t, key, body, "application/octet-stream"); },
    remove: (key) => s3Remove(t, key),
    list: async (prefix, max) => (await s3List(t, prefix, max)).map((o) => ({ key: o.key, lastModified: o.lastModified })),
  };
}

/** The registry of this build for the packs listed in integrations.connectors_packs (rebuilt when the list changes). */
function packRegistry(settings: ConnectorRunDeps["settings"]): () => ConnectorRegistry {
  let key = "", reg: ConnectorRegistry | null = null;
  return () => {
    const packs = settings.get<string[]>("integrations.connectors_packs", []);
    const k = JSON.stringify(Array.isArray(packs) ? packs : []);
    if (!reg || k !== key) { reg = builtinConnectors(Array.isArray(packs) ? packs.filter((p) => typeof p === "string") : []); key = k; }
    return reg;
  };
}

/**
 * The jobs of connectors in the workers: the scheduler tick every 5 s and the cleanup every 10 minutes. One call in
 * index.ts; the queue list of pg-boss does not change.
 */
export function registerConnectorJobs(o: { ctx: Ctx; every: Every; keyring: SettingsKeyring }): ConnectorScheduler {
  const { ctx } = o;
  const deps: ConnectorRunDeps = {
    instanceId: ctx.instanceId,
    db: ctx.db.control,
    settings: ctx.settings,
    keyring: o.keyring,
    registry: packRegistry(ctx.settings),
    storage: () => closedStaging(ctx),
    audit: (e) => auditWorker(ctx, { event_type: e.event_type, details: e.details, ...(e.record_ids ? { record_ids: e.record_ids } : {}), ...(e.class ? { class: e.class } : {}) }),
    workerId: newWorkerId(),
    ...(ctx.abort ? { abort: ctx.abort } : {}),
  };
  const sched = createConnectorScheduler(deps);
  o.every(CONNECTOR_TICK_MS, "connectors_tick", () => sched.tick());
  o.every(CONNECTOR_CLEANUP_MS, "connectors_cleanup", () => (runSettings(ctx.settings).enabled ? connectorsCleanup(deps) : Promise.resolve()));
  return sched;
}
