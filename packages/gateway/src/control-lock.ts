// Advisory locks in the control lock pool (Databases.controlLocks).
// The lock holder takes a connection of its own small pool and does the work under the lock with the main pools:
// it never waits for a second connection of the pool it holds the lock in. Past the pool size a waiter waits for a connection
// (CONTROL_LOCK_POOL.connectMs) without holding main pool connections; no connection or lock in time — in_progress.
// The queue of identical writes in process memory (withKeyLock) is below: it holds no connections at all.
import type pg from "pg";
import { inProgress, log, MemoryError, tx } from "@memory/shared";
import type { App } from "./context.ts";

/** The client the lock is held on: nested locks (lockAlso) are taken on it, no writes. */
export type LockClient = Pick<pg.PoolClient, "query">;

/**
 * The lock pool gave no connection within connectionTimeoutMillis. pg-pool has two texts: pool exhausted and queue wait over —
 * "timeout exceeded when trying to connect"; a new connection was not established — "Connection terminated due to connection
 * timeout" (a red test on a real pg-pool showed that the first text is not enough).
 */
export const lockPoolTimeout = (e: unknown): boolean =>
  e instanceof Error && /timeout exceeded when trying to connect|Connection terminated due to connection timeout/.test(e.message);

/**
 * The pool is exhausted: the queue wait for a connection ran out (the same pool other requests of this process hold). Unlike
 * "Connection terminated due to connection timeout" (no new database connection was made — the database is down or not
 * answering), this is an overload of the gateway itself, not a database state (health.ts: no reason for fail_closed).
 */
export const poolExhausted = (e: unknown): boolean => e instanceof Error && /timeout exceeded when trying to connect/.test(e.message);

/** details.reason of the memory-overloaded refusal (contract: code in_progress) — tells it apart from a record move. */
export const OVERLOADED = "overloaded";

/**
 * The control pool (CONTROL_POOL.connectMs) or the lock pool gave no connection in time — an overload. To a person and an agent
 * — retry (in_progress with retry_after and details.reason overloaded: REST 409 and Retry-After; MCP — a tool error,
 * at the /mcp entry the same 409, for resources and handshake JSON-RPC -32029), no internal error; to the log pg_pool_timeout.
 * null — this is not a connection wait timeout.
 */
export function poolBusy(e: unknown): MemoryError | null {
  if (!lockPoolTimeout(e)) return null;
  log.warn("pg_pool_timeout", { error: (e as Error).message.slice(0, 120) });
  return new MemoryError("in_progress", "The memory is receiving too many requests. Try again in a few seconds", { retry_after: 5, details: { reason: OVERLOADED } });
}

/** One more transaction advisory lock on the lock client already held: a nested lock without a second connection. */
export async function lockAlso(q: LockClient, key: string): Promise<void> {
  await q.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
}

/**
 * fn under pg_advisory_xact_lock(key) on a lock pool connection: lock_timeout 5 s; no lock in time (55P03) or no lock pool
 * connection — in_progress (retry_after), fn is not called. Locks are released by the end of the transaction, after the whole fn.
 */
export async function underControlLock<T>(app: App, key: string, fn: (q: LockClient) => Promise<T>): Promise<T> {
  try {
    return await tx(app.db.controlLocks(), async (q) => {
      await q.query("SET LOCAL lock_timeout = '5s'");
      await lockAlso(q, key);
      return fn(q);
    });
  } catch (e) {
    if ((e as { code?: string }).code === "55P03" || lockPoolTimeout(e)) throw inProgress();
    throw e;
  }
}

/**
 * The lock of origin links of one chain: read the basis → raise
 * the claimed → insert the links runs wholly under it, for a repeat of memory_remember, a repeat of a hand-over and the
 * first write (its links are inserted once the record is visible by its fingerprint). The key is the version chain root of its
 * note (chainEnds; for a record without a chain and a new record — itself): a repeat that found the old version before
 * memory_correct and a repeat that found the new one wait for one lock, and the basis is counted over the whole chain.
 */
export const derivedRepeatKey = (rootId: string): string => `derived:${rootId}`;

/**
 * A queue of calls with one key in process memory (before, only the queue of meeting intakes): while a call
 * with a key runs, the next with the same key waits for its end, different keys run in parallel. The lock holds no database
 * connections: an advisory lock of the control lock pool (CONTROL_LOCK_POOL — 4 connections) on each write would make it a shared
 * queue of all writes, while the holder needs its own main pool connections. The gateway is a single process;
 * with several gateway processes — an advisory lock with its own pool. An exception of fn releases the lock; the waiter goes on.
 */
const keyLocks = new Map<string, { tail: Promise<void>; n: number }>();
export async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const slot = keyLocks.get(key) ?? { tail: Promise.resolve(), n: 0 };
  const before = slot.tail;
  let release!: () => void;
  const done = new Promise<void>((r) => { release = r; });
  slot.tail = before.then(() => done);                       // chain links are never rejected: done only resolves
  slot.n++;
  keyLocks.set(key, slot);
  await before;
  try { return await fn(); }
  finally { release(); if (--slot.n === 0 && keyLocks.get(key) === slot) keyLocks.delete(key); }
}

/**
 * How many calls hold the key or wait for it (for tests: 2 — a rival queued behind the holder). Without a key — the longest
 * queue; 0 — the map is empty (the key removed after the last call).
 */
export const keyLockQueue = (key?: string): number =>
  key !== undefined ? keyLocks.get(key)?.n ?? 0 : Math.max(0, ...[...keyLocks.values()].map((s) => s.n));

/**
 * The same-record key: owner × space × type × fingerprint. One format for memory_remember and for handing a
 * meeting decision to a project (handover.ts): their fingerprint is computed alike — sourceHash(text, {title, kind, type}) —
 * so simultaneous remember calls (kind=decision) and a hand-over of one text in one project also queue.
 */
export const sameRecordKey = (ownerId: string, spaceId: string, type: string, hash: Buffer): string => `same:${ownerId}:${spaceId}:${type}:${hash.toString("hex")}`;

/**
 * The same-file key: only the fingerprint — it already includes the file name and size. Without an owner: in a shared
 * space the same file is also another person's visible upload, and its placement must not double either.
 */
export const sameFileKey = (hash: Buffer): string => `upload:${hash.toString("hex")}`;
