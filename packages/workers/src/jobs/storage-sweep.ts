// Daily final cleanup of the originals storage. Delete forever and an expired trash term remove the original's file
// by the same purge job, but only after the COMMIT of rows and the purged tombstone: a storage fault then (or a
// worker crash between COMMIT and the file delete) left the file forever — no retry, and the orphan check ran
// only on a manual delete of test data and touched only test data. This daily pass keeps the promise of delete forever:
// it deletes only a file of a finally deleted record that nothing refers to. It does not change retention rules.
//
// A file is deleted only if all hold:
//  1) key form <instance>/<year>/<month>/<hash>/<name>, and the file is over a day old (storage mtime);
//  2) no record_content of either database refers to the exact key (a move remnant in the old bucket is no orphan);
//  3) a new key with the record id (records.ts originalKey): no rows of the record in either DB, and one DB holds
//     its purged tombstone; an old key (hash and file name): no live or trashed record with that hash, no
//     move under way with it, and a purged tombstone with that hash in either DB.
// Without a tombstone the file is not touched, only counted (no_tombstone): its origin is unknown. At most 500 deletes per
// pass; one failed delete does not stop the pass (failed). Outcome: numbers, no keys (a key holds the file name), to
// maintenance_state.storage_sweep and the log. Storage silent — the pass is skipped with a warning.
import { LockConnectionLost, log, s3Remove, watchLock, type DataClass } from "@memory/shared";
import { recordsDb } from "../ctx.ts";
import type { PurgeCtx } from "./maintenance.ts";
import { CLASSES, liveHashes, movingHashes, ORPHAN_MIN_AGE_MS, purgedTombsByHash, recordIdOfKey, unreferencedObjects } from "./storage-orphans.ts";

/** Deletes per pass: the rest wait until the next day (or a manual run). */
export const STORAGE_SWEEP_MAX = 500;
/** Planned pass at most this often: the worker restarts on each deploy, and a daily interval never lived that long. */
export const STORAGE_SWEEP_EVERY_MS = 23 * 3_600_000;

export interface StorageSweepResult {
  /** Bucket files under the instance prefix. */
  listed: number;
  /** Files over a day old, no reference — checked for a tombstone. */
  checked: number;
  removed: number;
  failed: number;
  /** No references, but no purged tombstone — untouched. */
  no_tombstone: number;
  /** No references, but the record lives or moves (by id or hash) — untouched. */
  live: number;
  /** Deferred by the pass cap. */
  deferred: number;
  unavailable?: string;
}

export type StorageSweepOutcome = StorageSweepResult | { skipped: "busy" | "recent" | "no_storage" };

/**
 * Cleanup pass. force — no once-a-day check (manual run-job); minAgeMs — file age (by default
 * a day; less only for a manual test run). One pass per instance: lock storage_sweep:<instance>, no waiting.
 */
export async function storageSweep(ctx: PurgeCtx, o: { force?: boolean; minAgeMs?: number; max?: number; now?: Date } = {}): Promise<StorageSweepOutcome> {
  if (!CLASSES.some((c) => ctx.s3(c))) return { skipped: "no_storage" };
  const client = await ctx.db.control.connect();
  let broken: Error | undefined;
  try {
    let ok: boolean;
    try { ok = (await client.query("SELECT pg_try_advisory_lock(hashtext('storage_sweep:' || $1)) AS ok", [ctx.instanceId])).rows[0]?.ok === true; }
    catch (e) { broken = e as Error; throw e; }
    if (!ok) return { skipped: "busy" };
    const watch = watchLock(client);
    try {
      if (!o.force) {
        const at = (await ctx.db.control.query("SELECT value->>'at' AS at FROM maintenance_state WHERE instance_id = $1 AND key = 'storage_sweep'", [ctx.instanceId])).rows[0]?.at;
        if (at && Date.now() - Date.parse(at) < STORAGE_SWEEP_EVERY_MS) return { skipped: "recent" };
      }
      const out = await sweep(ctx, o, watch.alive);
      if (watch.lost()) throw new LockConnectionLost();
      await ctx.db.control.query(
        `INSERT INTO maintenance_state (instance_id, key, value, updated_at) VALUES ($1, 'storage_sweep', $2, now())
         ON CONFLICT (instance_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [ctx.instanceId, JSON.stringify({ ...out, at: new Date().toISOString() })]);
      if (out.unavailable) log.warn("storage_sweep_unavailable", { error: out.unavailable });
      (out.removed || out.failed ? log.warn : log.info)("storage_sweep", { ...out });
      return out;
    } catch (e) {
      if (e instanceof LockConnectionLost) broken = e;
      throw e;
    } finally {
      try {
        if (!watch.lost()) {
          try { await client.query("SELECT pg_advisory_unlock(hashtext('storage_sweep:' || $1))", [ctx.instanceId]); }
          catch (e) { broken = e as Error; }
        }
        if (watch.lost()) {
          if (!(broken instanceof LockConnectionLost)) broken = new LockConnectionLost();
          log.warn("lock_connection_lost", { job: "storage_sweep" });
        }
      } finally { watch.done(); }
    }
  } finally { client.release(broken); }
}

async function sweep(ctx: PurgeCtx, o: { minAgeMs?: number; max?: number; now?: Date }, alive: () => Promise<void>): Promise<StorageSweepResult> {
  const dbs = { control: ctx.db.control, records: (cls: DataClass) => recordsDb(ctx, cls) };
  const max = o.max ?? STORAGE_SWEEP_MAX;
  const found = await unreferencedObjects(ctx.instanceId, dbs, ctx.s3, { now: o.now ?? new Date(), refs: "both", minAgeMs: o.minAgeMs ?? ORPHAN_MIN_AGE_MS });
  const out: StorageSweepResult = { listed: found.listed, checked: 0, removed: 0, failed: 0, no_tombstone: 0, live: 0, deferred: 0, ...(found.unavailable ? { unavailable: found.unavailable } : {}) };
  const all = CLASSES.flatMap((cls) => found.byClass[cls].map((f) => ({ ...f, cls, recordId: recordIdOfKey(f.key) })));
  out.checked = all.length;
  if (!all.length) return out;

  // new keys by record id: rows, a running move, the purged tombstone
  const ids = [...new Set(all.map((f) => f.recordId).filter((x): x is string => Boolean(x)))];
  const rowIds = new Set<string>(), purgedIds = new Set<string>();
  if (ids.length) for (const cls of CLASSES) {
    for (const r of (await dbs.records(cls).query("SELECT id FROM records WHERE id = ANY($1::uuid[])", [ids])).rows) rowIds.add(r.id as string);
    for (const r of (await dbs.records(cls).query("SELECT id FROM record_tombstones WHERE reason = 'purged' AND id = ANY($1::uuid[])", [ids])).rows) purgedIds.add(r.id as string);
  }
  const movingIds = new Set<string>(ids.length ? (await ctx.db.control.query(
    "SELECT record_id FROM class_moves WHERE status IN ('pending','copying','verifying') AND record_id = ANY($1::uuid[])", [ids])).rows.map((r) => r.record_id as string) : []);

  // old keys — by hash
  const hexes = [...new Set(all.filter((f) => !f.recordId).map((f) => f.hash))];
  const liveHash = await liveHashes(dbs, hexes);
  const movingHash = hexes.length ? await movingHashes(dbs) : new Set<string>();
  const purgedHash = new Set<string>();
  for (const cls of CLASSES) for (const t of await purgedTombsByHash(dbs, cls, hexes)) purgedHash.add(t.h);

  for (const f of all) {
    const live = f.recordId ? rowIds.has(f.recordId) || movingIds.has(f.recordId) : liveHash.has(f.hash) || movingHash.has(f.hash);
    if (live) { out.live++; continue; }
    if (!(f.recordId ? purgedIds.has(f.recordId) : purgedHash.has(f.hash))) { out.no_tombstone++; continue; }
    if (out.removed + out.failed >= max) { out.deferred++; continue; }
    await alive();
    try { await s3Remove(ctx.s3(f.cls)!, f.key); out.removed++; }
    catch (e) { out.failed++; log.warn("storage_sweep_remove_failed", { class: f.cls, error: String((e as Error)?.message ?? e).slice(0, 120) }); }
  }
  return out;
}
