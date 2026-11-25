// Full-text language of the records databases. The setting search.fts_configs is the
// wish; retrieval_config of each records database is what its stored chunks.tsv were built with. At start and after
// every settings reload the worker compares them:
// - no wish ([]), or the wish is what is applied — nothing to do;
// - neither records database has passages — the wish is applied to both at once (short transactions that hold off
//   new passages while they look again), the title index of each new configuration is made and the title index of a
//   configuration no longer applied is dropped, through the schema's helpers;
// - a database with passages — the change needs a rebuild of the stored tsv; it is not started here, the
//   outcome says so (health check fts_index), and search goes on in the applied language. The other database then
//   waits too ("held"): the two records databases change their language together, so a record never changes its
//   language by a class move and one person's search never runs in two languages. Whether a database has
//   passages is first looked at without any lock: the wish of a filled database never makes writers wait;
// - a name the database does not know — nothing changes, the outcome names it.
// The outcome of the last run is kept in maintenance_state (`fts_config_reconcile`) for health and the panel.
import { commitOrThrow } from "@memory/shared";   // a COMMIT answered with ROLLBACK is an error
import type pg from "pg";
import { canonicalProfileJson, desiredFtsConfigs, FTS_CONFIGS_SETTING, forgetFtsConfigCache, log, type DataClass } from "@memory/shared";
import { recordsDb, type DbCtx } from "../ctx.ts";

export const FTS_RECONCILE_STATE_KEY = "fts_config_reconcile";
/** Advisory lock of the reconciliation in each records database (two worker processes do not apply twice). */
export const FTS_RECONCILE_LOCK = "memory_fts_config";

export type FtsDbState = "kept" | "applied" | "needs_rebuild" | "held" | "unknown_config" | "failed";
export interface FtsDbOutcome { state: FtsDbState; applied: string[]; desired: string[]; detail?: string }
export type FtsReconcileOutcome = Partial<Record<DataClass, FtsDbOutcome>>;

const CLASSES: readonly DataClass[] = ["open", "closed"];
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const REBUILD = "the database has passages: the change of the language needs a rebuild of the full-text index";

interface ConfigRow { fts_configs: string[]; fts_pending: string[] | null }
const readRow = async (q: Pick<pg.PoolClient, "query">, lock = false): Promise<ConfigRow | undefined> =>
  (await q.query(`SELECT fts_configs, fts_pending FROM retrieval_config LIMIT 1${lock ? " FOR UPDATE" : ""}`)).rows[0] as ConfigRow | undefined;
const hasPassages = async (q: Pick<pg.PoolClient, "query">): Promise<boolean> => (await q.query("SELECT EXISTS (SELECT 1 FROM chunks) AS x")).rows[0]?.x === true;

/**
 * One records database, without any lock: what the wish means for it. "apply" — it can take the wish (no passages, no
 * rebuild in progress); every other state is final for this run.
 */
async function lookAt(db: pg.Pool, desired: readonly string[]): Promise<FtsDbOutcome | "apply"> {
  const row = await readRow(db);
  const applied = row?.fts_configs ?? [];
  if (!desired.length || (row && !row.fts_pending && same(applied, desired))) return { state: "kept", applied, desired: [...desired] };
  const unknown = (await db.query("SELECT array_agg(u.c ORDER BY u.i) AS x FROM unnest($1::text[]) WITH ORDINALITY AS u(c, i) WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_ts_config t WHERE t.cfgname = u.c AND pg_catalog.pg_ts_config_is_visible(t.oid))", [desired])).rows[0]?.x as string[] | null;
  if (unknown?.length) return { state: "unknown_config", applied, desired: [...desired], detail: `unknown text search configuration: ${unknown.join(", ")}` };
  if (row?.fts_pending || await hasPassages(db)) return { state: "needs_rebuild", applied, desired: [...desired], detail: REBUILD };
  return "apply";
}

/**
 * Apply the wish to every database of `dbs` together: each gets its transaction, its advisory lock, its row and a SHARE
 * lock on chunks (no passage may be written while it is looked at again — one written in between would keep the old
 * language); only when every database is still empty are the rows written and committed. Otherwise nothing changes.
 */
async function applyTogether(dbs: Array<[DataClass, pg.Pool]>, desired: readonly string[], out: FtsReconcileOutcome): Promise<void> {
  const open: Array<{ cls: DataClass; c: pg.PoolClient; row: ConfigRow | undefined; done: boolean }> = [];
  try {
    for (const [cls, db] of dbs) {
      const c = await db.connect();
      open.push({ cls, c, row: undefined, done: false });
      await c.query("BEGIN");
      await c.query("SET LOCAL lock_timeout = '5s'");
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [FTS_RECONCILE_LOCK]);
      const row = await readRow(c, true);
      open[open.length - 1]!.row = row;
      await c.query("LOCK TABLE chunks IN SHARE MODE");
      if (row?.fts_pending || await hasPassages(c)) {
        out[cls] = { state: "needs_rebuild", applied: row?.fts_configs ?? [], desired: [...desired], detail: REBUILD };
        break;
      }
    }
    const blocked = open.find((o) => out[o.cls]?.state === "needs_rebuild");
    if (blocked) {
      for (const o of open) { await o.c.query("ROLLBACK"); o.done = true; }
      for (const o of open) if (o !== blocked) out[o.cls] = held(o.row?.fts_configs ?? [], desired, [blocked.cls]);
      for (const [cls, db] of dbs) if (!out[cls]) out[cls] = held((await readRow(db))?.fts_configs ?? [], desired, [blocked.cls]);
      return;
    }
    for (const o of open)
      if (o.row) await o.c.query("UPDATE retrieval_config SET fts_configs = $1, fts_pending = NULL, fts_cursor = NULL, updated_at = now()", [desired]);
      else await o.c.query("INSERT INTO retrieval_config (fts_configs) VALUES ($1)", [desired]);
    for (const o of open) { await commitOrThrow(o.c); o.done = true; out[o.cls] = { state: "applied", applied: [...desired], desired: [...desired] }; }
  } catch (e) {
    for (const o of open) if (!o.done) await o.c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    for (const o of open) o.c.release();
  }
}

const held = (applied: string[], desired: readonly string[], by: readonly DataClass[]): FtsDbOutcome => ({
  state: "held", applied, desired: [...desired],
  detail: `not applied: the ${by.join(" and ")} records database cannot take it yet; both records databases change their language together`,
});

/** The title indexes of one database after a run: each applied configuration has one; one no longer applied is dropped. */
async function titleIndexes(db: pg.Pool, o: FtsDbOutcome): Promise<void> {
  if (o.state !== "applied" && o.state !== "kept") return;
  // through the helpers (the worker has no DDL right on records)
  for (const cfg of o.applied) await db.query("SELECT memory_fts_title_index_ensure($1)", [cfg]);
  if (o.state === "applied") await db.query("SELECT memory_fts_title_index_prune()");
}

/** Both records databases; the outcome is stored for health (a database that failed says why). */
export async function reconcileFtsConfig(ctx: DbCtx): Promise<FtsReconcileOutcome> {
  const desired = desiredFtsConfigs(ctx.settings.get<unknown>(FTS_CONFIGS_SETTING, []));
  const out: FtsReconcileOutcome = {};
  const toApply: Array<[DataClass, pg.Pool]> = [];
  for (const cls of CLASSES) {
    try {
      const r = await lookAt(recordsDb(ctx, cls), desired);
      if (r === "apply") toApply.push([cls, recordsDb(ctx, cls)]); else out[cls] = r;
    } catch (e) { out[cls] = { state: "failed", applied: [], desired, detail: (e as Error).message.slice(0, 200) }; }
  }
  if (toApply.length) {
    // a database that cannot take the wish (passages, unknown name, failure) holds the other one: one language for both
    const blockers = CLASSES.filter((cls) => out[cls] && out[cls]!.state !== "kept");
    if (blockers.length) {
      for (const [cls, db] of toApply) {
        try { out[cls] = held((await readRow(db))?.fts_configs ?? [], desired, blockers); }
        catch (e) { out[cls] = { state: "failed", applied: [], desired, detail: (e as Error).message.slice(0, 200) }; }
      }
    } else {
      try { await applyTogether(toApply, desired, out); }
      catch (e) { for (const [cls] of toApply) if (!out[cls]) out[cls] = { state: "failed", applied: [], desired, detail: (e as Error).message.slice(0, 200) }; }
    }
  }
  for (const cls of CLASSES) {
    const o = out[cls];
    if (!o) continue;
    try { await titleIndexes(recordsDb(ctx, cls), o); }
    catch (e) { log.warn("fts_title_index_failed", { class: cls, error: (e as Error).message.slice(0, 200) }); }
    if (o.state === "applied") log.info("fts_config_applied", { class: cls, configs: o.applied });
    else if (o.state !== "kept") log.warn("fts_config_not_applied", { class: cls, state: o.state, desired, applied: o.applied });
  }
  if (Object.values(out).some((o) => o?.state === "applied")) forgetFtsConfigCache();
  // a reload without news writes nothing (the settings are reloaded every minute)
  const value = { desired, databases: out };
  const stored = (await ctx.db.control.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = $2", [ctx.instanceId, FTS_RECONCILE_STATE_KEY])).rows[0]?.value as
    { desired?: unknown; databases?: unknown } | undefined;
  if (canonicalProfileJson({ desired: stored?.desired ?? null, databases: stored?.databases ?? null }) !== canonicalProfileJson(value))
    await ctx.db.control.query(
      `INSERT INTO maintenance_state (instance_id, key, value, updated_at) VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (instance_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [ctx.instanceId, FTS_RECONCILE_STATE_KEY, JSON.stringify({ at: new Date().toISOString(), ...value })]);
  return out;
}

let chain: Promise<unknown> = Promise.resolve();
/** Runs of this process never overlap; a failure is a log line. */
export function scheduleFtsReconcile(ctx: DbCtx): Promise<unknown> {
  chain = chain.catch(() => undefined).then(() => reconcileFtsConfig(ctx))
    .catch((e) => log.warn("fts_config_reconcile_failed", { error: (e as Error).message.slice(0, 200) }));
  return chain;
}
