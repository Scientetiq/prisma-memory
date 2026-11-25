// May this record's text be given to an embeddings model now? The chat
// stages ask loadRecordForModel (common.ts); every sender of record text to an embeddings model asks this module:
//   - indexRecord (indexing.ts), the active row and the candidate — the stage job names one record, there is no selection:
//     the fence alone decides; a record that may not go now makes the stage wait (StageWait, handoff) — nothing sent;
//   - warmDerived (indexing.ts) — held records are left out when the children are selected, then the fence per request;
//   - embedBackfill (embed-backfill.ts) — `hidden_at` in the selection, held records skipped (they wait), then the fence.
// No other code sends record text: search sends the user's query, the reconcile probe a constant text, Platform.embed has
// no product caller (searched: embedDocuments, embedQuery, probeConnection, embeddingTransport, Platform.embed and the
// embeddings API path in packages/*/src and tools).
// The rule: the record is live and current, not a hidden copy of a class move (`hidden_at`), of this class in its records
// database and by the locator, and no class move is in flight for the record or for a record above it — its
// parents and, for an agent's note, its version chain (the tree a close hides, version-chain.ts CHAIN_TREE).
//
// The fence (`sourceFence`) runs before every request and once more at dispatch, after the transport's budget refresh and
// host check: the rows are read `FOR SHARE`, so the UPDATE that hides them (gateway or class move) waits until the bytes
// were handed to fetch. A record that fails is never sent: SourceChanged. A database failure of the fence itself (a lock
// wait over 1 s, a deadlock, a lost connection) is SourceLocked — also nothing sent, never a failure of the model.
// Not covered (accepted): a close request committed in the control database after the fence read
// it and before fetch — the UPDATE hiding the rows is then ordered after the send.
import type pg from "pg";
import { log, PlatformError, type DataClass } from "@memory/shared";
import { recordsDb, type DbCtx } from "../ctx.ts";

// The rule itself (EMBEDDABLE_SQL, heldBack and its walk upwards) lives in @memory/shared (model-source.ts),
// moved there unchanged so the search's reranker asks the same function; re-exported here for the workers' callers.
export { EMBEDDABLE_SQL, heldBack } from "@memory/shared";
import { EMBEDDABLE_SQL, heldBack } from "@memory/shared";

type Q = Pick<pg.PoolClient, "query">;

/**
 * The database codes of a read of the source rule that mean «not now», not a lasting fault: a lock wait (55P03), a
 * deadlock (40P01) and — — a statement time-out (57014): the walk upwards (HELD_UP_SQL) runs only while a
 * class move is in flight, so on a very long chain it can time out only then, and it ends when the move settles. The
 * indexed stage waits (no attempt spent), the backfill counts a lock hit and reads the batch again in a later run.
 */
export const SOURCE_WAIT_CODES: ReadonlySet<string> = new Set(["55P03", "40P01", "57014"]);

/**
 * The record set of a request changed between the plan and the send: nothing of it was sent. A PlatformError (kind
 * `aborted`), so the transport and the facade pass it to the caller unchanged instead of calling it a network failure.
 */
export class SourceChanged extends PlatformError {
  constructor(readonly live: readonly string[]) { super("aborted", "the source records changed before the send"); this.name = "SourceChanged"; }
}

/**
 * The fence could not read its rows: a lock wait over its 1 s, a deadlock, a lost connection. Nothing was sent
 * and the model did nothing: a PlatformError of kind `aborted`, so the transport neither calls it a network failure nor
 * counts a failed model call; `code` — the database's error code when there is one (55P03, 40P01). Callers treat it as a
 * lock: the backfill reads the batch again in a later run, an indexed stage waits.
 */
export class SourceLocked extends PlatformError {
  constructor(readonly code: string | undefined, cause: unknown) {
    super("aborted", `the source records could not be checked before the send${code ? ` (${code})` : ""}`);
    this.name = "SourceLocked";
    (this as { cause?: unknown }).cause = cause;
  }
}

const fenceError = (e: unknown): unknown => e instanceof PlatformError ? e : new SourceLocked((e as { code?: unknown } | null)?.code as string | undefined, e);

/**
 * The checks before each request of `ids()` (the records the next request carries): `beforeRequest` — an unlocked read;
 * `beforeDispatch` — the same read `FOR SHARE OF r` on its own connection, held until the transport has handed the
 * request to fetch (then released). Either throws SourceChanged with the ids still allowed when any record fails.
 * `extra` — more conditions of the caller on `r` (and its own joins in `join`), e.g. the warm-up's unclaimed stage.
 */
export function sourceFence(ctx: Pick<DbCtx, "db" | "instanceId" | "settings">, cls: DataClass, ids: () => readonly string[], o: { join?: string; extra?: string } = {}) {
  const db = recordsDb(ctx as DbCtx, cls);
  const read = async (q: Q, lock: boolean): Promise<void> => {
    const want = ids();
    const found = (await q.query(
      `SELECT r.id::text AS id FROM records r ${o.join ?? ""}
        WHERE r.id = ANY($1::uuid[]) AND r.class = $2 AND ${EMBEDDABLE_SQL}${o.extra ? ` AND ${o.extra}` : ""} ORDER BY r.id${lock ? " FOR SHARE OF r" : ""}`,
      [want, cls])).rows.map((r) => r.id as string);
    const wanted = new Set(want);
    const held = await heldBack(ctx, q, cls, found);
    const live = new Set(found.filter((id) => wanted.has(id) && !held.has(id)));
    if (live.size !== wanted.size) throw new SourceChanged([...live]);
  };
  return {
    beforeRequest: () => read(db, false).catch((e: unknown) => { throw fenceError(e); }),
    beforeDispatch: async (): Promise<() => Promise<void>> => {
      let c: pg.PoolClient;
      try { c = await db.connect(); } catch (e) { throw fenceError(e); }
      let released = false;
      // the release runs after the request was handed to fetch — it never throws (a failed ROLLBACK would turn
      // into a network failure of a request that was sent): the connection is dropped instead and the failure logged
      const release = async () => {
        if (released) return;
        released = true;
        let clean = false;
        try { await c.query("ROLLBACK"); clean = true; }
        catch (e) { log.warn("embed_fence_release_failed", { code: (e as { code?: unknown } | null)?.code ?? null }); }
        finally { c.release(!clean); }
      };
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL lock_timeout = '1s'");
        await read(c, true);
        return release;
      } catch (e) { await release().catch(() => undefined); throw fenceError(e); }
    },
  };
}
