// Rebuild on a filled database: the worker's side of every rebuild — the run lock, the progress row
// and the disk gate. The loops themselves live with their tasks (embed-backfill.ts, the full-text rebuild of
// search); this module never calls a model.
//
// No two runs: a run holds the session lock pg_try_advisory_lock(hashtext('memory_rebuild'), hashtext(<kind>)) on one
// dedicated control connection for its whole length. Not obtained → `busy` at once, without waiting. A dead process
// frees it with its connection. `alive()` checks that connection before every batch: lost → the run stops, no further
// send or write.
import { headroom, log, readDiskReport, rebuildDiskMode, rebuildStateKey, type RebuildKind, type RebuildProgress } from "@memory/shared";
import type { DbCtx } from "../ctx.ts";

/** The first key of the run lock (hashtext of this text); the second is hashtext(<kind>). */
export const REBUILD_RUN_LOCK = "memory_rebuild";

/** The run lock was lost (its connection died): nothing more may be sent or written by this run. */
export class RebuildLockLost extends Error {
  constructor() { super("the rebuild run lock was lost"); this.name = "RebuildLockLost"; }
}

/**
 * Runs `run` while holding the run lock of `kind`; `busy` when another run holds it. `alive` throws RebuildLockLost
 * when the lock's connection no longer answers.
 */
export async function withRunLock<T>(ctx: DbCtx, kind: RebuildKind, run: (alive: () => Promise<void>) => Promise<T>): Promise<T | "busy"> {
  const client = await ctx.db.control.connect();
  let broken: Error | undefined;
  const onError = (e: Error) => { broken = e; };
  client.on("error", onError);
  try {
    const got = (await client.query("SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS ok", [REBUILD_RUN_LOCK, kind])).rows[0]?.ok === true;
    if (!got) return "busy";
    const alive = async (): Promise<void> => {
      if (broken) throw new RebuildLockLost();
      try { await client.query("SELECT 1"); }
      catch (e) { broken = e as Error; throw new RebuildLockLost(); }
    };
    try {
      return await run(alive);
    } finally {
      if (!broken) await client.query("SELECT pg_advisory_unlock(hashtext($1), hashtext($2))", [REBUILD_RUN_LOCK, kind]).catch((e: Error) => { broken = e; });
    }
  } catch (e) {
    broken ??= e instanceof RebuildLockLost ? e : undefined;
    throw e;
  } finally {
    client.off("error", onError);
    // a connection that failed is destroyed, not returned to the pool (its lock, if any, goes with it)
    client.release(broken ?? undefined);
  }
}

/** JSON with object keys sorted and undefined members left out: equal values give equal text (no embeddings module). */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonicalJson(x))).join(",")}]`;
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

const withoutAt = (p: RebuildProgress): string => canonicalJson({ ...p, at: undefined });

/** Writes the progress row of its kind — only when the JSON without `at` changed (a run without news writes nothing). */
export async function saveRebuildProgress(ctx: DbCtx, p: RebuildProgress): Promise<void> {
  const key = rebuildStateKey(p.kind);
  const stored = (await ctx.db.control.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = $2", [ctx.instanceId, key])).rows[0]?.value as RebuildProgress | undefined;
  if (stored && withoutAt(stored) === withoutAt(p)) return;
  await ctx.db.control.query(
    `INSERT INTO maintenance_state (instance_id, key, value, updated_at) VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (instance_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [ctx.instanceId, key, JSON.stringify(p)]);
}

/**
 * The disk head-room of a rebuild that will grow the databases by `needBytes`, by the gateway's report of the database
 * volume (maintenance_state `disk_free`) and processing.rebuild_disk. Checked before `filling` and at every run start.
 */
export async function diskGate(ctx: DbCtx, needBytes: number): Promise<{ ok: boolean; detail: string }> {
  const mode = rebuildDiskMode(ctx.settings);
  const report = mode === "skip" ? null : await readDiskReport(ctx.db.control, ctx.instanceId);
  const out = headroom({ needBytes, report, mode, now: Date.now() });
  if (!out.ok) log.warn("rebuild_disk_gate", { need_bytes: needBytes, detail: out.detail });
  return out;
}
