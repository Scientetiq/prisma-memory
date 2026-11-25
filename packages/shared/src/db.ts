import pg from "pg";
import type { CallerKind } from "./crypto.ts";
import { readCredentialText } from "./credentials.ts";
import { log } from "./log.ts";
import { pgTls } from "./pg-tls.ts";
import { APP_DERIVE_KEY, appDeriveKeyFromFile, passwordFor, PG_APP_PASSWORD_REFUSED, SecretsConfigError, secretsMode, type SecretsMode } from "./secrets.ts";
export { pgTls, PgTlsConfigError } from "./pg-tls.ts";
export { APP_DERIVE_KEY, GATEWAY_DB_ROLES, loadServiceSecrets, parseSecretsMode, passwordFor, SECRETS_MODES, SecretsConfigError, secretsMode, WORKER_DB_ROLES, type LinkKeys, type SecretsMode, type ServiceSecrets } from "./secrets.ts";

export type DataClass = "open" | "closed";
export type DbRole = "memory_gateway" | "memory_worker" | "memory_audit_reader" | "memory_audit_maint";

export interface Env {
  instanceId: string;
  appSecret: string;
  pgAppPassword?: string | null;
  pgHost: string; pgPort: number; role: "gateway" | "worker"; llmRequireFloor?: boolean; testHooks?: boolean; llmStub?: boolean; applicationName?: string;
  pgTls?: false | { rejectUnauthorized: boolean; ca?: string };
  /**
   * Secrets mode of the process (MEMORY_SECRETS_MODE): files — own secret files only, legacy-derived — the old
   * derivation from PG_APP_PASSWORD is permitted. No field (an Env built by hand) — the mode of the process.
   */
  secretsMode?: SecretsMode;
}

/**
 * Start variables of a gateway, worker or one-off job — the one entry point of every such process.: in the default
 * mode (files) PG_APP_PASSWORD stops the start and the root of derived keys comes only from the file app-derive-key
 * (English refusals with names, no values); legacy-derived behaves exactly as before.
 */
export function readEnv(): Env {
  const mode = secretsMode();
  const pgAppPassword = process.env.PG_APP_PASSWORD || null, instanceId = process.env.MEMORY_INSTANCE_ID;
  if (pgAppPassword && mode !== "legacy-derived") throw new SecretsConfigError(PG_APP_PASSWORD_REFUSED);
  // files: the instance first, then the root key from its own file (English refusals with the file name). legacy-derived:
  // exactly the order of before
  if (mode === "files" && !instanceId) throw new Error("MEMORY_INSTANCE_ID is not set: the start variable that names this installation (deploy/.env).");
  const appSecret = mode === "files" ? appDeriveKeyFromFile() : pgAppPassword ?? readCredentialText(APP_DERIVE_KEY, { minBytes: 16 });
  if (!instanceId) throw new Error("startup variable MEMORY_INSTANCE_ID is missing (deploy/.env)");
  if (!appSecret) throw new Error(`application secret is missing: neither PG_APP_PASSWORD (deploy/.env) nor the ${APP_DERIVE_KEY} file in the service credentials directory (CREDENTIALS_DIRECTORY) is available`);
  return {
    instanceId, appSecret, pgAppPassword, secretsMode: mode,
    pgHost: process.env.PG_HOST ?? "db", pgPort: Number(process.env.PG_PORT ?? 5432),
    pgTls: pgTls(),
    role: process.env.MEMORY_ROLE === "worker" ? "worker" : "gateway",
    llmRequireFloor: process.env.MEMORY_LLM_REQUIRE_FLOOR === "1", testHooks: process.env.MEMORY_TEST_HOOKS === "1", llmStub: process.env.MEMORY_LLM_STUB === "1",
  };
}

export class ClosedAccessDenied extends Error {
  constructor() { super("a tier T2 context cannot access the closed database"); }
}

export interface ClassScope { classes: readonly DataClass[]; tier: "T0" | "T1" | "T2" | "system"; keyKind?: CallerKind }

export const AUDIT_LINK_POOL = { max: 2, connectMs: 100, statementMs: 250, queryMs: 300 } as const;

export const CONTROL_LOCK_POOL = { max: 4, connectMs: 10_000 } as const;

export const CONTROL_POOL = { max: 10, connectMs: 15_000 } as const;

export const AUDIT_READ_POOL = { max: 3, connectMs: 10_000 } as const;

type Counters = Record<string, number>;
const byTier = (): Counters => ({ T0: 0, T1: 0, T2: 0, system: 0 });
const byKind = (): Counters => ({ personal: 0, extended: 0, service: 0, system: 0, session: 0, connection: 0 });

export class Databases {
  readonly control: pg.Pool;
  readonly audit: pg.Pool;
  private readonly open: pg.Pool;
  private readonly closed: pg.Pool;
  private auditReader?: pg.Pool;
  private auditLinker?: pg.Pool;
  private controlLocker?: pg.Pool;
  readonly closedAcquired: Counters = byTier();
  readonly closedWrites: Counters = byTier();
  readonly closedByKeyKind: { reads: Counters; writes: Counters } = { reads: byKind(), writes: byKind() };

  constructor(private readonly env: Env) {
    const user: DbRole = env.role === "worker" ? "memory_worker" : "memory_gateway";
    const make = (database: string, max: number, as: DbRole = user, extra: pg.PoolConfig = {}) => {
      const pool = new pg.Pool({ host: env.pgHost, port: env.pgPort, database, user: as, password: passwordFor(env, as), max, idleTimeoutMillis: 30_000, ...extra, ...this.appName(), ssl: env.pgTls ?? pgTls() });
      pool.on("error", (e) => log.warn("pg_pool_error", { database, error: e.message.slice(0, 200) }));
      pool.on("connect", (client) => {
        let reported = false;
        client.on("error", (e) => {
          if (reported || client.listenerCount("error") !== 1) return;
          reported = true;
          log.warn("pg_client_error", { database, application: pool.options.application_name, sqlstate: (e as { code?: string }).code ?? null });
        });
      });
      return pool;
    };
    this.control = make("memory_control", CONTROL_POOL.max, user, env.role === "gateway" ? { connectionTimeoutMillis: CONTROL_POOL.connectMs } : {});
    this.open = make("memory_open", 10);
    this.closed = make("memory_closed", 10);
    this.audit = make("memory_audit", 4);
  }

  private appName(): { application_name?: string } {
    return this.env.applicationName ? { application_name: this.env.applicationName.slice(0, 63) } : {};
  }

  records(cls: DataClass, scope: ClassScope): pg.Pool {
    if (!scope.classes.includes(cls)) throw new ClosedAccessDenied();
    if (cls === "open") return this.open;
    this.closedAcquired[scope.tier] = (this.closedAcquired[scope.tier] ?? 0) + 1;
    const kind = scope.keyKind ?? "system";
    this.closedByKeyKind.reads[kind] = (this.closedByKeyKind.reads[kind] ?? 0) + 1;
    return this.closed;
  }

  recordsForWrite(cls: DataClass, scope: ClassScope["tier"] | ClassScope): pg.Pool {
    if (cls === "open") return this.open;
    const tier = typeof scope === "string" ? scope : scope.tier, kind = typeof scope === "string" ? "system" : (scope.keyKind ?? "system");
    this.closedWrites[tier] = (this.closedWrites[tier] ?? 0) + 1;
    this.closedByKeyKind.writes[kind] = (this.closedByKeyKind.writes[kind] ?? 0) + 1;
    return this.closed;
  }

  auditRead(): pg.Pool {
    if (!this.auditReader) {
      this.auditReader = new pg.Pool({
        host: this.env.pgHost, port: this.env.pgPort, database: "memory_audit", user: "memory_audit_reader",
        password: passwordFor(this.env, "memory_audit_reader"), max: AUDIT_READ_POOL.max, connectionTimeoutMillis: AUDIT_READ_POOL.connectMs,
        idleTimeoutMillis: 30_000, ...this.appName(),
        ssl: this.env.pgTls ?? pgTls(),
      });
      this.auditReader.on("error", (e) => log.warn("pg_pool_error", { database: "memory_audit", pool: "audit_read", error: e.message.slice(0, 200) }));
      this.auditReader.on("connect", (client) => {
        let reported = false;
        client.on("error", (e) => {
          if (reported || client.listenerCount("error") !== 1) return;
          reported = true;
          log.warn("pg_client_error", { database: "memory_audit", application: this.appName().application_name, sqlstate: (e as { code?: string }).code ?? null });
        });
      });
    }
    return this.auditReader;
  }

  auditLink(): pg.Pool {
    if (!this.auditLinker) {
      const p = AUDIT_LINK_POOL;
      this.auditLinker = new pg.Pool({
        host: this.env.pgHost, port: this.env.pgPort, database: "memory_audit", user: "memory_audit_reader",
        password: passwordFor(this.env, "memory_audit_reader"), max: p.max, idleTimeoutMillis: 60_000,
        connectionTimeoutMillis: p.connectMs, statement_timeout: p.statementMs, query_timeout: p.queryMs, ...this.appName(),
        ssl: this.env.pgTls ?? pgTls(),
      });
      this.auditLinker.on("error", (e) => log.warn("pg_pool_error", { database: "memory_audit", pool: "audit_link", error: e.message.slice(0, 200) }));
    }
    return this.auditLinker;
  }

  controlLocks(): pg.Pool {
    if (!this.controlLocker) {
      const as: DbRole = this.env.role === "worker" ? "memory_worker" : "memory_gateway";
      this.controlLocker = new pg.Pool({
        host: this.env.pgHost, port: this.env.pgPort, database: "memory_control", user: as, password: passwordFor(this.env, as),
        max: CONTROL_LOCK_POOL.max, connectionTimeoutMillis: CONTROL_LOCK_POOL.connectMs, idleTimeoutMillis: 30_000, ...this.appName(),
        ssl: this.env.pgTls ?? pgTls(),
      });
      this.controlLocker.on("error", (e) => log.warn("pg_pool_error", { database: "memory_control", pool: "control_locks", error: e.message.slice(0, 200) }));
      this.controlLocker.on("connect", (client) => {
        let reported = false;
        client.on("error", (e) => {
          if (reported || client.listenerCount("error") !== 1) return;
          reported = true;
          log.warn("pg_client_error", { database: "memory_control", application: this.appName().application_name, sqlstate: (e as { code?: string }).code ?? null });
        });
      });
    }
    return this.controlLocker;
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.control.end(), this.open.end(), this.closed.end(), this.audit.end(), this.auditReader?.end(), this.auditLinker?.end(), this.controlLocker?.end()]);
  }
}

export const SCOPE_T2: ClassScope = { classes: ["open"], tier: "T2" };
export const SCOPE_T0: ClassScope = { classes: ["open", "closed"], tier: "T0" };
export const SCOPE_SYSTEM: ClassScope = { classes: ["open", "closed"], tier: "system" };

/**
 * The server ended the transaction with ROLLBACK although COMMIT was asked: a statement inside it failed and its
 * error was swallowed, so PostgreSQL answers COMMIT with the ROLLBACK tag, raises nothing and discards every write. The
 * caller must never treat that as success — whatever it was about to grant after the commit is not backed by the database.
 */
export class TransactionRolledBack extends Error {
  readonly code = "transaction_rolled_back";
  constructor() {
    super("The transaction was rolled back by the server: a statement inside it failed");
    this.name = "TransactionRolledBack";
  }
}

/**
 * COMMIT that fails loudly: the ROLLBACK answer of an aborted transaction becomes TransactionRolledBack. Only that tag is a
 * failure — an emulated nested transaction answers RELEASE (owner-lock.ts), a bare test double answers nothing.
 */
export async function commitOrThrow(c: { query: (sql: string) => Promise<unknown> }): Promise<void> {
  const r = await c.query("COMMIT") as { command?: string } | undefined;
  if (r?.command === "ROLLBACK") throw new TransactionRolledBack();
}

/** tx() on a connection the caller already holds (it stays checked out: the caller releases it). */
export async function txOn<T>(c: pg.PoolClient, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await commitOrThrow(c);
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);   // ends the transaction block; the original error is what matters
    throw e;
  }
}

/** BEGIN … COMMIT on a pool connection; a transaction the server rolled back is thrown (TransactionRolledBack), never returned. */
export async function tx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    return await txOn(c, fn);
  } finally {
    c.release();
  }
}

type Queryable = Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">;

export async function syncDeletionMarks(control: Queryable, records: Queryable, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const { rows } = await records.query("SELECT id, deleted_at, deleted_by, purge_after, deleted_batch FROM records WHERE id = ANY($1::uuid[])", [ids]);
  if (!rows.length) return 0;
  const res = await control.query(
    `UPDATE record_locations l SET deleted = m.deleted_at IS NOT NULL, deleted_at = m.deleted_at, deleted_by = m.deleted_by,
            purge_after = m.purge_after, deleted_batch = m.deleted_batch, updated_at = now()
     FROM unnest($1::uuid[], $2::timestamptz[], $3::uuid[], $4::timestamptz[], $5::uuid[]) AS m(id, deleted_at, deleted_by, purge_after, deleted_batch)
     WHERE l.record_id = m.id`,
    [rows.map((r) => r.id), rows.map((r) => r.deleted_at), rows.map((r) => r.deleted_by), rows.map((r) => r.purge_after), rows.map((r) => r.deleted_batch)]);
  return res.rowCount ?? 0;
}
