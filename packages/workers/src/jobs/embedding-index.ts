// Native-dimension storage: the vector index of an embedder in a records database. The worker role has no DDL
// right on the record tables; the schema (06-embedder-platform.sql, records target) gives it one helper that checks the id
// and the dimension and builds the partial HNSW index over (embedding::halfvec(N)) — a no-op when the index is there.
import type pg from "pg";
import { log, type EmbedderRef } from "@memory/shared";
import { StageWait } from "../stages.ts";

/** undefined_function: the schema of this database is an old one (fixed dimension, plain index made by the schema). */
const HELPER_MISSING = "42883";
/** object_not_in_prerequisite_state: among others, the column still has a fixed dimension (a deploy cut after step 0). */
const NOT_PREREQUISITE = "55000";
/** lock_not_available: the helper's 5 s lock timeout — another session builds this embedder's index or holds the table. */
const LOCK_TIMEOUT = "55P03";
/** Pause of the stage before it tries again while an index is being built; the attempt is not spent (StageWait). */
export const INDEX_BUSY_WAIT_MS = 60_000;
/** last_error of a stage that waits for a vector index being built elsewhere. */
export const INDEX_BUSY_CODE = "index_wait:vector_index_busy";

let helperMissingSaid = false, columnTypedSaid = false;

/** The vector column of this database still has a fixed dimension: the earlier schema's plain index serves its vectors. */
async function columnTyped(db: Pick<pg.Pool, "query">): Promise<boolean> {
  const r = await db.query(
    `SELECT a.atttypmod <> -1 AS typed FROM pg_attribute a
      WHERE a.attrelid = 'public.chunk_embeddings'::regclass AND a.attname = 'embedding' AND NOT a.attisdropped`);
  return r.rows[0]?.typed === true;
}

/**
 * Makes sure the embedder has its vector index in this records database — before its first vector is written, so that
 * vectors go into a live index and no model is paid for when the index cannot be made. One autocommit statement on the
 * pool, never inside a transaction of the caller: the helper takes a short SHARE lock and has its own lock timeout (5 s).
 * The schema step of the deploy has not run here yet (no helper), or ran only in part (helper there, the column still
 * with its fixed dimension): a warning once per process — the earlier schema already has its plain index, and the vectors
 * go there as before. The helper's lock timeout (another session builds this index, or a deploy rebuilds indexes): the
 * stage waits a minute without spending an attempt (StageWait) — the earlier code waited for the lock as well. Any other
 * error is thrown (the stage fails and is retried).
 */
export async function ensureEmbeddingIndex(db: Pick<pg.Pool, "query">, ref: EmbedderRef): Promise<void> {
  try {
    await db.query("SELECT memory_embedding_index_ensure($1, $2)", [ref.id, ref.dims]);
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    if (code === HELPER_MISSING) {
      if (!helperMissingSaid) { helperMissingSaid = true; log.warn("embedding_index_helper_missing"); }
      return;
    }
    if (code === NOT_PREREQUISITE && await columnTyped(db)) {
      if (!columnTypedSaid) { columnTypedSaid = true; log.warn("embedding_index_column_typed"); }
      return;
    }
    if (code === LOCK_TIMEOUT) {
      log.info("embedding_index_busy", { embedder: ref.id, wait_ms: INDEX_BUSY_WAIT_MS });
      throw new StageWait(new Date(Date.now() + INDEX_BUSY_WAIT_MS), INDEX_BUSY_CODE);
    }
    throw e;
  }
}

/**
 * Is the embedder's vector index there and valid in this records database (a catalog read, no DDL)? The warm-up asks this
 * instead of making the index (making an index over stored vectors can take minutes, outside the warm-up's
 * deadline); an older schema (no helper) — the plain index of the schema serves.
 */
export async function embeddingIndexReady(db: Pick<pg.Pool, "query">, id: string): Promise<boolean> {
  try {
    return (await db.query("SELECT valid FROM memory_embedding_index_state($1)", [id])).rows[0]?.valid === true;
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code === HELPER_MISSING) return true;
    throw e;
  }
}
