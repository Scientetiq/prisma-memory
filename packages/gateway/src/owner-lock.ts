import { AsyncLocalStorage } from "node:async_hooks";
import type pg from "pg";
import { inProgress, tx, type ClassScope, type DataClass } from "@memory/shared";
import type { App } from "./context.ts";
import { lockPoolTimeout } from "./control-lock.ts";

const held = new AsyncLocalStorage<{ pool: pg.Pool; q: pg.PoolClient; ids: Set<string> }>();

/** All control queries inside a session lock use its connection: N plans do not exhaust the pool waiting for N new ones. */
export function withControlConnection(app: App, q: pg.PoolClient): App {
  const borrowed = new Proxy(q, { get: (target, key) => key === "release" ? () => {} : typeof Reflect.get(target, key) === "function" ? Reflect.get(target, key).bind(target) : Reflect.get(target, key) });
  const control = new Proxy(app.db.control, { get: (target, key) => key === "query" ? q.query.bind(q) : key === "connect" ? async () => borrowed : Reflect.get(target, key) });
  const db = new Proxy(app.db, { get: (target, key) => key === "control" ? control : typeof Reflect.get(target, key) === "function" ? Reflect.get(target, key).bind(target) : Reflect.get(target, key) });
  return { ...app, db };
}

/**
 * The call runs under record locks (withOwnerLocks — a plan position, a correction; withRecordLocksWait — meeting people change).
 * Under them one may not wait for a lock held by someone who waits for a row under these locks (the profile lock).
 */
export const underOwnerLocks = (): boolean => held.getStore() !== undefined;

/** A plan checks the fingerprint and calls the ordinary action under the same locks. A nested call takes no new pool slot. */
export async function withOwnerLocks<T>(app: App, ids: string[], fn: (q: pg.PoolClient) => Promise<T>): Promise<T> {
  const out = await tryRecordLocks(app, app.db.control, ids, fn);
  if (out === BUSY) throw inProgress();
  return out.value;
}

const BUSY = Symbol("record_locks_busy");

/**
 * The record:<id> locks (the same the worker's class move holds for the whole move) and the class_moves check on a connection
 * of the pool `pool`. Busy — BUSY without calling fn: the transaction commits empty, taken locks are freed. No pool connection in
 * its timeout (the control locks pool) — BUSY too: fn was not called, nothing was taken. In `held` — the main control pool as
 * the mark "the same base": a nested underRecordLock on an already taken id runs on the connection that holds the lock.
 */
async function tryRecordLocks<T>(app: App, pool: pg.Pool, ids: string[], fn: (q: pg.PoolClient) => Promise<T>): Promise<typeof BUSY | { value: T }> {
  let entered = false;
  try {
    return await tx(pool, async (q): Promise<typeof BUSY | { value: T }> => {
      entered = true;
      for (const id of [...new Set(ids)].sort()) {
        if (!(await q.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok", [`record:${id}`])).rows[0]?.ok) return BUSY;
      }
      if ((await q.query("SELECT 1 FROM class_moves WHERE record_id = ANY($1::uuid[]) AND status IN ('pending','copying','verifying')", [ids])).rowCount) return BUSY;
      return { value: await held.run({ pool: app.db.control, q, ids: new Set(ids) }, () => fn(q)) };
    });
  } catch (e) {
    if (!entered && lockPoolTimeout(e)) return BUSY;
    throw e;
  }
}

/**
 * Record locks with waiting: the people and readers of a meeting change under the same
 * record:<id> locks as the move between open and closed. Busy (a move runs, or another action holds the record) — a pause
 * without holding a connection, then a new try; not waited out in waitSec — in_progress with retry_after: an honest "retry", not
 * "done" that the move would overwrite. An ordinary meeting move fits in this time, and 409 almost never goes out.
 *
 * The locks are held in the control locks pool (Databases.controlLocks):
 * the action under them goes to the main control pool itself (locators, people, createRecord, journal), and a holder that took
 * a main pool connection would wait for a second connection of the same pool — ten simultaneous people changes of meetings
 * would exhaust the pool for good, and the whole gateway with it. The locks pool holder asks none of its connections; one beyond
 * its size waits for a connection at most CONTROL_LOCK_POOL.connectMs, holding no main pool connections, and tries again.
 */
export async function withRecordLocksWait<T>(app: App, ids: string[], fn: (q: pg.PoolClient) => Promise<T>, o: { waitSec?: number; pauseMs?: number } = {}): Promise<T> {
  const waitMs = (o.waitSec ?? 20) * 1000, pause = o.pauseMs ?? 1000, until = Date.now() + waitMs;
  for (;;) {
    const out = await tryRecordLocks(app, app.db.controlLocks(), ids, fn);
    if (out !== BUSY) return out.value;
    if (Date.now() + pause > until) throw inProgress(10);
    await new Promise((r) => setTimeout(r, pause));
  }
}

/**
 * fn under a record lock on a control connection (a transaction). The lock is busy — `busy()` AFTER the transaction ends:
 * "busy" of "Open" and "Close" reads the last move through the control pool, and N simultaneous "busy" ones, each holding a
 * connection and asking for another, exhausted the pool for good. Under the lock fn goes to control only through its `q`.
 */
export async function underRecordLock<T>(app: App, id: string, busy: () => T | Promise<T>, fn: (q: pg.PoolClient) => Promise<T>): Promise<T> {
  const context = held.getStore();
  if (context?.pool === app.db.control && context.ids.has(id)) return fn(context.q);
  const out = await tx(app.db.control, async q => {
    const { rows } = await q.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok", [`record:${id}`]);
    return rows[0]?.ok ? { done: await fn(q) } : null;
  });
  return out ? out.done : busy();
}


/**
 * A borrowed pool of one active records transaction. Each nested tx gets its own SAVEPOINT:
 * its COMMIT does not release the outer snapshot's locks, and an error rolls back only that nested step.
 * Parallel nested transactions on one client are forbidden: pg tx and owner operations are sequential.
 */
function recordsTransactionPool(pool: pg.Pool, q: pg.PoolClient): pg.Pool {
  let sequence = 0;
  const active: string[] = [];
  const connect = async (): Promise<pg.PoolClient> => {
    let savepoint: string | null = null;
    const query = async (input: unknown, ...args: unknown[]) => {
      const sql = typeof input === "string" ? input.trim().replace(/;$/, "").toUpperCase() : null;
      if (sql === "BEGIN") {
        if (savepoint) throw new Error("record snapshot transaction already started");
        const name = `plan_records_${++sequence}`;
        const result = await q.query(`SAVEPOINT ${name}`);
        savepoint = name; active.push(name);
        return result;
      }
      if (sql === "COMMIT" || sql === "ROLLBACK") {
        if (!savepoint) {
          // tx() calls ROLLBACK after a BEGIN error: the outer transaction must not be rolled back.
          if (sql === "ROLLBACK") return { command: "ROLLBACK", rowCount: 0, oid: 0, rows: [], fields: [] };
          throw new Error("record snapshot transaction is not started");
        }
        if (active.at(-1) !== savepoint) throw new Error("record snapshot transactions must finish in stack order");
        if (sql === "ROLLBACK") await q.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        const result = await q.query(`RELEASE SAVEPOINT ${savepoint}`);
        active.pop(); savepoint = null;
        return result;
      }
      return Reflect.apply(q.query, q, [input, ...args]);
    };
    return new Proxy(q, { get: (target, key) => key === "query" ? query : key === "release" ? () => {}
      : typeof Reflect.get(target, key) === "function" ? Reflect.get(target, key).bind(target) : Reflect.get(target, key) });
  };
  return new Proxy(pool, { get: (target, key) => key === "query" ? q.query.bind(q) : key === "connect" ? connect
    : typeof Reflect.get(target, key) === "function" ? Reflect.get(target, key).bind(target) : Reflect.get(target, key) });
}

/**
 * The snapshot and the action are in one transaction of the class base. The caller first takes the control advisory locks,
 * checks the fresh locator class against the shown one, then here rereads the fingerprint and calls the action.
 * FOR UPDATE blocks changes of rows, participants (their routes first lock/change the parent) and new
 * FK links to the record: a child or a placement cannot appear between the fingerprint and the action. NOWAIT excludes
 * waiting for a records lock while control locks are held (the crossed order of other operations).
 * ids — the ancestors and the whole source subtree; after the capture recheck the set: a new child may have come BEFORE the lock.
 */
export async function withRecordSnapshot<T>(app: App, o: { class: DataClass; scope: ClassScope; ids: string[] }, fn: (recordApp: App) => Promise<T>): Promise<T> {
  const pool = app.db.records(o.class, o.scope); // the original method checks the class scope before getting a connection
  try {
    return await tx(pool, async q => {
      await q.query("SELECT id FROM records WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE NOWAIT", [[...new Set(o.ids)].sort()]);
      const records = recordsTransactionPool(pool, q);
      const db = new Proxy(app.db, { get: (target, key) => {
        if (key === "records" || key === "recordsForWrite") return (...args: unknown[]) => {
          // Keep the original rights check and the class access counters; replace only the chosen pool.
          const selected = Reflect.apply(Reflect.get(target, key), target, args);
          return selected === pool ? records : selected;
        };
        const value = Reflect.get(target, key);
        if (value === pool) return records;
        return typeof value === "function" ? value.bind(target) : value;
      } });
      const out = await fn({ ...app, db });
      // Single operations sometimes catch an SQL error (for example, close_hide_deferred). In a shared transaction
      // it must not silently turn COMMIT into ROLLBACK while control records the action as successful.
      await q.query("SELECT 1 AS snapshot_complete");
      return out;
    });
  } catch (e) {
    if (typeof e === "object" && e !== null && "code" in e && e.code === "55P03") throw inProgress();
    throw e;
  }
}
