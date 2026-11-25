// Re-embedding on a filled database: the backfill job `embed_backfill`
// and the permanent sweep. One run, under the run lock of kind `embed` (no two runs at once, a second answers `busy`):
//   1. parked chunks that no longer exist are dropped;
//   2. purge — a retained model whose retention ended: a strict audit event first (`embedder_purge`; it fails → the row
//      stays retained and nothing is deleted), the tombstone (closed_at), the vector index dropped in both records
//      databases, the vectors deleted in batches of 2000 by the primary key; closed rows with vectors left (cancelled
//      candidates, an interrupted purge) join at the index drop, without a second event;
//   3. targets — the active row and the candidate, each through the embeddings facade; the disk head-room for the vectors
//      still missing;
//   4. per target and records database: the chunks of live records WITHOUT its vector (anti-join, primary-key order after
//      a cursor of convenience) — those of a record that may not go to a model now (embed-source.ts: a class move in
//      flight, the locator elsewhere) wait: skipped, counted as `waiting`, neither processed nor work left — their exact embedding input (chunkInput, as indexing built it — never a re-chunk), the
//      facade (stage `embed_backfill`, the class of the database the text was read from, the run lock checked before
//      every request), one insert per batch labelled with the facade's embedder id, ON CONFLICT DO NOTHING;
//   5. the candidate fully covered and `auto_switch` → the switch (registry.ts switchEmbedder, which proves coverage again
//      inside its own transaction and refuses anything that would leave chunks keyword-only without a confirmation);
//   6. the progress row `rebuild:embed` (written only when it changed).
// Outcomes of the facade: the policy refuses a class → that class is "not included" for
// the target (never 0 %, never done), nothing of it is sent; the money budget → the run ends quietly (no stop, no event);
// the provider fails → stop `provider`, resume at the next sweep; an input is rejected → that chunk alone is parked (at
// most 200; one more → stop `stalled`); the setup is wrong → stop `config`, shown in health.
// What is logged, stored in the progress row or audited: ids, counts, configuration names — never chunk text and never a
// provider's answer.
import { commitOrThrow, embedConfirmedKey, embedderFor, embedderSql, embedFailure, log, narrowing, rebuildStop, readRebuildProgress, REBUILD_PARKED_MAX, switchEmbedder, tx, EMBEDDERS_LOCK,
         type Coverage, type DataClass, type EmbedConfirmation, type EmbedderRow, type RebuildDb, type RebuildPhase, type RebuildProgress, type RebuildStop, type RegistryDeps } from "@memory/shared";
import type pg from "pg";
import { auditWorker, auditWorkerStrict, recordsDb, type Ctx, type DbCtx } from "../ctx.ts";
import { ensureEmbeddingIndex } from "./embedding-index.ts";
import { StageWait } from "../stages.ts";
import { HOLD_LONG_CODE, inputHash, planIndex } from "./indexing.ts";
import { followVectorSources, legacyModelMoved, OF_SOURCE, settleOperatorWords, vectorView, type RecomputableLeft, type VectorView } from "./embedders.ts";
import { heldBack, SourceChanged, SourceLocked, sourceFence, SOURCE_WAIT_CODES } from "./embed-source.ts";
import { diskGate, RebuildLockLost, saveRebuildProgress, withRunLock } from "./rebuild.ts";

export const REEMBED_SETTING = "retrieval.reembed";
export const REEMBED_DEFAULTS = { batch: 64, max_chunks_per_run: 5000, pause_ms: 0, sweep_min: 30, auto_switch: true, retain_days: 7, recompute_stale: false, adoption_seen: false } as const;
export type ReembedSettings = { batch: number; max_chunks_per_run: number; pause_ms: number; sweep_min: number; auto_switch: boolean; retain_days: number; recompute_stale: boolean; adoption_seen: boolean };
/** A run ends after this long even with budget left (it queues itself again when work is left). */
export const RUN_MAX_MS = 240_000;
/** Vector rows per DELETE of a purge (keyset on the primary key). */
export const PURGE_BATCH = 2000;
/** Runs in a row whose batch hit a lock timeout or a deadlock before the stop `lock`. */
export const LOCK_RUNS_MAX = 5;

const CLASSES: readonly DataClass[] = ["open", "closed"];
const ROW_COLUMNS = "id, model, dims, query_instruction, max_tokens, profile, connection_slot, active, candidate, retire_at, closed_at, vector_generation";
// a hidden copy of a class move is neither filled nor counted (coverage and fill read the same predicate)
const LIVE = "chunks c JOIN records r ON r.id = c.record_id AND r.deleted_at IS NULL AND r.is_current AND r.hidden_at IS NULL";
/**
 * A chunk has a vector of the row `$id` OF ITS SOURCE NOW: a vector of another source (another address, model,
 * space or generation) counts as missing — it is not searched (search.ts) and the backfill recomputes it. `$s` NULL — the
 * row has no usable embedder now (nothing to compute): any of its vectors counts.
 */
const hasVector = (id: string, s: string, l: string): string =>
  `EXISTS (SELECT 1 FROM chunk_embeddings e WHERE e.chunk_id = c.id AND e.embedder_id = ${id} AND (${s}::text IS NULL OR ${OF_SOURCE("e", s, `${l}::boolean`)}))`;
/** A chunk has any vector of the row `$id`, of whatever source. */
const ANY_VECTOR = (id: string): string => `EXISTS (SELECT 1 FROM chunk_embeddings x WHERE x.chunk_id = c.id AND x.embedder_id = ${id})`;
/** The source view of a row now: its embedder's source and the NULL rule, or null — no usable embedder. */
async function viewOf(ctx: Ctx4, row: EmbedderRow): Promise<VectorView | null> {
  const st = embedderFor({ platform: ctx.platform, settings: ctx.settings }, row);
  return st.state === "ready" ? vectorView(ctx, row.id, st.embedder.source) : null;
}
type Ctx4 = Pick<Ctx, "db" | "settings" | "instanceId" | "platform">;

/** The settings of the re-embedding, each field checked (a wrong value is its default). */
export function reembedSettings(settings: { get<T>(k: string, d: T): T }): ReembedSettings {
  const v = settings.get<Record<string, unknown>>(REEMBED_SETTING, { ...REEMBED_DEFAULTS }) ?? {};
  const num = (k: keyof typeof REEMBED_DEFAULTS, min: number, max: number): number => {
    const n = Number(v[k]);
    return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : REEMBED_DEFAULTS[k] as number;
  };
  return { batch: num("batch", 1, 2048), max_chunks_per_run: num("max_chunks_per_run", 1, 10_000_000), pause_ms: num("pause_ms", 0, 600_000),
           sweep_min: num("sweep_min", 1, 1440), auto_switch: typeof v.auto_switch === "boolean" ? v.auto_switch : REEMBED_DEFAULTS.auto_switch,
           retain_days: num("retain_days", 0, 3650), recompute_stale: v.recompute_stale === true, adoption_seen: v.adoption_seen === true };
}

/** Vectors of one embedder: bytes a stored chunk vector costs in a database (halfvec, row, index), as the note estimates. */
const bytesPerVector = (dims: number): number => (2 * dims + 64) * 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pgCode = (e: unknown): string | undefined => (e as { code?: unknown } | null)?.code as string | undefined;

/** The vector index of an embedder in one records database: valid, missing (or invalid), or the helper is not there. */
async function indexValid(db: pg.Pool, id: string): Promise<boolean> {
  try {
    const r = (await db.query("SELECT valid FROM memory_embedding_index_state($1)", [id])).rows[0];
    return r?.valid === true;
  } catch (e) {
    if (pgCode(e) === "42883") return true;          // an older schema: the plain index of the schema serves
    throw e;
  }
}

/** Coverage of a row in one records database (parked: listed chunks still without its vector). */
async function coverageIn(ctx: Ctx4, row: EmbedderRow, cls: DataClass, parked: readonly string[], allowed: boolean): Promise<Coverage> {
  const db = recordsDb(ctx, cls);
  const view = await viewOf(ctx, row);
  const has = hasVector("$1", "$3", "$4");
  // a chunk whose only vector is of another source waits for the operator's word (not counted as work)
  const r = (await db.query(
    `SELECT count(*)::bigint AS chunks, count(*) FILTER (WHERE ${has})::bigint AS have,
            count(*) FILTER (WHERE c.id = ANY($2::uuid[]) AND NOT ${has})::bigint AS parked,
            count(*) FILTER (WHERE NOT $5::boolean AND NOT ${has} AND ${ANY_VECTOR("$1")})::bigint AS stale
       FROM ${LIVE}`, [row.id, parked, view?.source ?? null, view?.legacy ?? false, view?.recompute ?? true])).rows[0];
  return { class: cls, allowed, chunks: Number(r.chunks), have: Number(r.have), parked: Number(r.parked), indexValid: await indexValid(db, row.id),
           ...(Number(r.stale) ? { stale: Number(r.stale) } : {}) };
}

/** May the connection of this row see the class? An `off` row sees nothing. */
function allowsOf(ctx: Ctx4, row: EmbedderRow, cls: DataClass): boolean {
  const st = embedderFor({ platform: ctx.platform, settings: ctx.settings }, row);
  return st.state === "ready" && st.embedder.allows(cls);
}

/**
 * Live chunks of a class that `from` serves and `to` has no vector for (RegistryDeps.uncovered): `fromAllowed` — every
 * live chunk without `to`'s vector, else only those with `from`'s vector (a connection switched off or narrowed keeps
 * the classes its vectors cover). `to = null` — a model that may not embed the class now: its vectors there count for
 * nothing, every chunk `from` serves is uncovered.
 */
async function uncoveredIn(ctx: Ctx4, from: EmbedderRow, to: EmbedderRow | null, cls: DataClass, fromAllowed: boolean): Promise<number> {
  // only vectors of each row's source now cover a chunk
  const fv = await viewOf(ctx, from), tv = to ? await viewOf(ctx, to) : null;
  const r = (await recordsDb(ctx, cls).query(
    `SELECT count(*)::bigint AS n FROM ${LIVE}
      WHERE ($2::text IS NULL OR NOT ${hasVector("$2", "$6", "$7")})
        AND ($3::boolean OR ${hasVector("$1", "$4", "$5")})`, [from.id, to?.id ?? null, fromAllowed, fv?.source ?? null, fv?.legacy ?? false, tv?.source ?? null, tv?.legacy ?? false])).rows[0];
  return Number(r.n);
}

/**
 * What this backfill still recomputes of a row (settleOperatorWords: the one-shot lever turns itself off and
 * the adoption line ends over exactly this): only the active row and the candidate are filled (fill), only classes their
 * connection may see (allowsOf), only live chunks (LIVE: not deleted, current, not hidden), never a parked one
 * (`c.id <> ALL(parked)`). `stale` — such chunks with a vector of the row and none of `source` (the selection `want` of
 * fill under the word); `unlabelled` — such chunks with a vector of the row without a source.
 */
export function recomputable(ctx: Ctx4, parked: readonly string[]): RecomputableLeft {
  return async (row, source, legacy) => {
    const out = { stale: 0, unlabelled: 0 };
    if (!row.active && !row.candidate) return out;
    try {
      for (const cls of CLASSES) {
        if (!allowsOf(ctx, row, cls)) continue;
        const r = (await recordsDb(ctx, cls).query(
          `SELECT count(*) FILTER (WHERE ${ANY_VECTOR("$1")} AND NOT ${hasVector("$1", "$2", "$3")})::bigint AS stale,
                  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM chunk_embeddings u WHERE u.chunk_id = c.id AND u.embedder_id = $1 AND u.source IS NULL))::bigint AS unlabelled
             FROM ${LIVE} WHERE c.id <> ALL($4::uuid[])`, [row.id, source, legacy, parked])).rows[0];
        out.stale += Number(r?.stale ?? 0); out.unlabelled += Number(r?.unlabelled ?? 0);
      }
      return out;
    } catch (e) {
      log.warn("embed_backfill_recomputable_count_failed", { embedder: row.id, code: pgCode(e) ?? null });
      return null;
    }
  };
}

/** The registry deps of the worker: coverage from both records databases, the policy through the facade. */
/** `parked` and `moved` are required — a caller without them would take a moved legacy row as usable. */
export function workerRegistryDeps(ctx: Ctx4, parked: readonly string[], moved: ReadonlyMap<string, unknown>): RegistryDeps {
  return {
    coverage: async (row) => Promise.all(CLASSES.map((cls) => coverageIn(ctx, row, cls, parked, allowsOf(ctx, row, cls)))),
    allows: (row, cls) => allowsOf(ctx, row, cls),
    // a legacy row whose model setting moved away from its vectors (legacyModelMoved) is not served
    offReason: (row) => { if (moved.has(row.id)) return "mismatch"; const st = embedderFor({ platform: ctx.platform, settings: ctx.settings }, row); return st.state === "off" ? st.reason : null; },
    uncovered: (from, to, cls, fromAllowed) => uncoveredIn(ctx, from, to, cls, fromAllowed),
  };
}

interface Run {
  ctx: Ctx4; cfg: ReembedSettings; now: () => number; started: number; alive: () => Promise<void>;
  parked: string[]; stop: RebuildStop | null; processed: number; lockHit: boolean; budget: boolean; requests: number;
  cursors: Map<string, string | null>; notIncluded: Map<string, boolean>; retiring: boolean; purged: Set<string>;
  held: Array<{ id: string; chunks: number }>;
  /** Per `<id>:<class>`, chunks skipped in this run because their record may not go to a model now. */
  waiting: Map<string, Set<string>>;
  /**
   * The embedder and the records database the stop belongs to (none — the run's own: disk, lock; no database — the
   * target as a whole: its connection is off); what this run got past: `<id>:<class>` — a batch of that target stored in
   * that database, nothing left there, or the target may not see the class; `<id>` — the same in ANY database of it. The
   * cause decides the scope: a stop with a database is cleared only past that database, a target-wide stop by the first
   * success of the target anywhere; progress of another target clears nothing.
   */
  stopTarget: string | null; stopDb: DataClass | null; passed: Set<string>;
  /** Inputs the facade had to cut to the model's limit in this run (counted, never a failure). */
  truncated: number;
}

/** A database whose vectors of a closed row are gone, keyed by the row's closed_at: a row closed again is purged again. */
const purgedKey = (id: string, cls: DataClass, closedAt: Date | string): string => `${id}:${cls}:${new Date(closedAt).getTime()}`;

/** This run got past `cls` of target `id` — and so past any target-wide cause of that target (see Run.passed). */
const pass = (run: Run, id: string, cls: DataClass) => { run.passed.add(`${id}:${cls}`); run.passed.add(id); };

/** The first stop of a run; `target` — the embedder it belongs to (none — the run's own: disk, lock); `cls` — its database. */
const setStop = (run: Run, reason: RebuildStop["reason"], detail: string, target?: string, cls?: DataClass) => {
  if (!run.stop) { run.stop = rebuildStop(reason, detail, new Date(run.now())); if (target) { run.stopTarget = target; run.stopDb = cls ?? null; } }
};
const outOfTime = (run: Run) => run.processed >= run.cfg.max_chunks_per_run || run.now() - run.started >= RUN_MAX_MS;

/** Parked ids whose chunks still exist (in either database). */
async function existingParked(ctx: DbCtx, ids: readonly string[]): Promise<string[]> {
  if (!ids.length) return [];
  const keep = new Set<string>();
  for (const cls of CLASSES)
    for (const r of (await recordsDb(ctx, cls).query("SELECT id::text AS id FROM chunks WHERE id = ANY($1::uuid[])", [ids])).rows) keep.add(r.id);
  return ids.filter((id) => keep.has(id));
}

// ---------------------------------------------------------------- purge

async function purge(run: Run): Promise<void> {
  const { ctx } = run;
  const due = (await ctx.db.control.query(
    `SELECT ${ROW_COLUMNS} FROM embedders WHERE retire_at <= now() AND NOT active AND NOT candidate AND closed_at IS NULL ORDER BY id`)).rows as EmbedderRow[];
  const active = due.length ? ((await ctx.db.control.query(`SELECT ${ROW_COLUMNS} FROM embedders WHERE active`)).rows[0] as EmbedderRow | undefined) ?? null : null;
  const deps = workerRegistryDeps(ctx, [], await legacyModelMoved(ctx, active ? [active, ...due] : due));
  for (const row of due) {
    // never purge vectors the search model lacks unless a switch confirmed leaving them keyword-only — whatever
    // retain_days says (the confirmation is the row the confirmed switch wrote; none, or for another model → held). What
    // the search model lacks is judged by what it may embed NOW: its vectors in a class it may no longer embed count for
    // nothing
    let lacking = 0;
    for (const cls of CLASSES) lacking += active ? await deps.uncovered(row, deps.allows(active, cls) ? active : null, cls, false) : 1;
    if (lacking > 0) {
      const conf = (await ctx.db.control.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = $2", [ctx.instanceId, embedConfirmedKey(row.id)])).rows[0]?.value as EmbedConfirmation | undefined;
      if (!active || conf?.to !== active.id) {
        run.held.push({ id: row.id, chunks: active ? lacking : 0 });
        log.info("embedder_purge_held", { embedder: row.id, active: active?.id ?? null, chunks: active ? lacking : null });
        continue;
      }
    }
    // the strict event comes first: without it nothing irreversible happens (the row stays retained)
    try { await auditWorkerStrict(ctx, { event_type: "admin", details: { op: "embedder_purge", id: row.id } }); }
    catch (e) { log.warn("embedder_purge_audit_failed", { embedder: row.id, error: (e as Error).message.slice(0, 160) }); continue; }
    await tx(ctx.db.control, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [EMBEDDERS_LOCK]);
      await c.query("UPDATE embedders SET closed_at = now() WHERE id = $1 AND closed_at IS NULL AND NOT active AND NOT candidate AND retire_at <= now()", [row.id]);
      // the confirmation is used up with the tombstone (the worker may not delete rows of maintenance_state: emptied)
      await c.query("UPDATE maintenance_state SET value = '{}'::jsonb, updated_at = now() WHERE instance_id = $1 AND key = $2", [ctx.instanceId, embedConfirmedKey(row.id)]);
    });
    log.info("embedder_purge_started", { embedder: row.id });
  }
  const closed = (await ctx.db.control.query(`SELECT id, closed_at FROM embedders WHERE closed_at IS NOT NULL AND NOT active AND NOT candidate ORDER BY id`)).rows as Array<{ id: string; closed_at: Date }>;
  const valid = new Set<string>();
  for (const { id, closed_at } of closed) {
    for (const cls of CLASSES) {
      const key = purgedKey(id, cls, closed_at);
      valid.add(key);
      if (run.purged.has(key) || outOfTime(run)) continue;
      const db = recordsDb(ctx, cls);
      const empty = !(await db.query("SELECT EXISTS (SELECT 1 FROM chunk_embeddings WHERE embedder_id = $1) AS ok", [id])).rows[0]?.ok;
      if (!empty) run.retiring = true;
      // the index goes first, also for a row that never got a vector (a cancelled fresh candidate keeps none)
      try { await db.query("SELECT memory_embedding_index_drop($1)", [id]); }
      catch (e) {
        if (pgCode(e) === "55P03" || pgCode(e) === "40P01") { run.lockHit = true; continue; }
        if (pgCode(e) !== "42883") throw e;
      }
      if (empty) { run.purged.add(key); continue; }
      let cursor: string | null = null, deleted = 0;
      for (;;) {
        await run.alive();
        if (outOfTime(run)) break;
        // a row started again (explicit start) is no longer purged
        if (!(await ctx.db.control.query("SELECT 1 FROM embedders WHERE id = $1 AND closed_at IS NOT NULL", [id])).rowCount) break;
        let n = 0, last: string | null = null;
        try {
          ({ n, last } = await tx(db, async (c) => {
            await c.query("SET LOCAL lock_timeout = '5s'");
            await c.query("SET LOCAL statement_timeout = '30s'");
            const r = await c.query(
              `WITH b AS (SELECT chunk_id, embedder_id FROM chunk_embeddings WHERE embedder_id = $1 AND ($2::uuid IS NULL OR chunk_id > $2) ORDER BY chunk_id LIMIT $3),
                    d AS (DELETE FROM chunk_embeddings e USING b WHERE e.chunk_id = b.chunk_id AND e.embedder_id = b.embedder_id RETURNING e.chunk_id)
               SELECT count(*)::int AS n, (SELECT chunk_id::text FROM b ORDER BY chunk_id DESC LIMIT 1) AS last FROM d`, [id, cursor, PURGE_BATCH]);
            return { n: Number(r.rows[0].n), last: r.rows[0].last as string | null };
          }));
        } catch (e) {
          if (pgCode(e) === "55P03" || pgCode(e) === "40P01") { run.lockHit = true; break; }
          throw e;
        }
        deleted += n;
        if (n < PURGE_BATCH) {
          run.purged.add(key);
          log.info("embedder_purged", { embedder: id, class: cls });
          // every deletion of paid vectors is audited — also a cancelled candidate's, which had no purge event
          await auditWorker(ctx, { event_type: "admin", details: { op: "embedder_vectors_deleted", id, class: cls, rows: deleted } });
          break;
        }
        cursor = last;
      }
    }
  }
  // entries of rows that are no longer closed, or were closed again since, are dropped
  for (const k of [...run.purged]) if (!valid.has(k)) run.purged.delete(k);
}

// ---------------------------------------------------------------- fill

type Batch = { id: string; record_id: string; text: string; time_from_sec: number | null; section_path: string | null; page_from: number | null; title: string | null; type: string; occurred_at: Date }[];
type Sent = { kind: "ok"; vectors: number[][]; hashes: (Buffer | null)[]; embedderId: string; source: string } | { kind: "policy" } | { kind: "budget" } | { kind: "error"; error: unknown };

/** One facade call for these rows (a new Embedder per batch — never cached). */
async function send(run: Run, row: EmbedderRow, cls: DataClass, rows: Batch): Promise<Sent> {
  const st = embedderFor({ platform: run.ctx.platform, settings: run.ctx.settings }, row);
  if (st.state === "off") return { kind: "error", error: Object.assign(new Error(st.detail), { offReason: st.reason }) };
  const plans = rows.map((r) => planIndex(run.ctx.settings, r, [{ text: r.text, timeFromSec: r.time_from_sec, sectionPath: r.section_path, pageFrom: r.page_from }]));
  // the hash under the source of the embedder that sends
  const source = st.embedder.source;
  const inputs = plans.map(p => p.inputs[0]!), hashes = inputs.map((i) => inputHash(i, source));
  try {
    run.requests++;
    // every record of the call may still be given to a model, before each request and at dispatch
    const fence = sourceFence(run.ctx, cls, () => [...new Set(rows.map((r) => r.record_id))]);
    const out = await st.embedder.embedDocuments(inputs, { dataClass: cls, stage: "embed_backfill", ref: rows[0]!.id,
      beforeRequest: async () => { await run.alive(); await fence.beforeRequest(); }, beforeDispatch: fence.beforeDispatch });
    if (!out.ok) return { kind: out.stop };
    run.truncated += out.truncated;                                 // inputs over the model's limit, cut by the facade
    // a vector of a cut input is stored without a hash (never reused for the whole input)
    const cut = new Set(out.cut ?? []);
    return { kind: "ok", vectors: out.vectors, hashes: hashes.map((h, i) => cut.has(i) ? null : h), embedderId: out.embedderId, source };
  } catch (e) {
    return { kind: "error", error: e };
  }
}

/**
 * One batch's vectors, in their own transaction with short lock and statement limits; a chunk deleted meanwhile is skipped.
 * A stored vector of another source is replaced (the recomputation); one of the same source is kept.
 * `sources[i]` — the source of the send that computed `vectors[i]` (the fallback sends chunk by chunk, and
 * the connection may change between two of its sends).
 */
async function store(db: pg.Pool, sql: ReturnType<typeof embedderSql>, ids: readonly string[], vectors: readonly number[][], hashes: readonly (Buffer | null)[], sources: readonly string[]): Promise<"ok" | "lock"> {
  for (let attempt = 0; ; attempt++) {
    try {
      await tx(db, async (c) => {
        await c.query("SET LOCAL lock_timeout = '5s'");
        await c.query("SET LOCAL statement_timeout = '30s'");
        await c.query(
          `INSERT INTO chunk_embeddings (chunk_id, embedder_id, embedding, input_hash, source)
           SELECT u.id, $2::text, u.v::${sql.cast}, ($4::bytea[])[u.n::int], ($5::text[])[u.n::int] FROM unnest($1::uuid[], $3::text[]) WITH ORDINALITY AS u(id, v, n) JOIN chunks c ON c.id = u.id
           ON CONFLICT (chunk_id, embedder_id) DO UPDATE SET embedding = EXCLUDED.embedding, input_hash = EXCLUDED.input_hash, source = EXCLUDED.source
             WHERE chunk_embeddings.source IS DISTINCT FROM EXCLUDED.source`, [ids, sql.ref.id, vectors.map((v) => `[${v.join(",")}]`), hashes, sources]);
      });
      return "ok";
    } catch (e) {
      const code = pgCode(e);
      if (code === "23503" && attempt === 0) continue;          // a chunk deleted between the read and the insert: once more
      if (code === "55P03" || code === "40P01") return "lock";
      throw e;
    }
  }
}

/**
 * A thrown error of the facade (or an `off` row) as the stop of this target; RebuildLockLost and a lost run go up. A row
 * that went `off` because it is no longer a target (its slot changed, the reconcile cancelled it) ends quietly.
 */
async function stopFor(run: Run, row: EmbedderRow, cls: DataClass, e: unknown): Promise<void> {
  if (e instanceof RebuildLockLost) throw e;
  const off = (e as { offReason?: string } | null)?.offReason;
  if (off) {
    const still = (await run.ctx.db.control.query("SELECT 1 FROM embedders WHERE id = $1 AND (active OR candidate)", [row.id])).rowCount;
    if (!still) { log.info("embed_backfill_target_left", { embedder: row.id }); return; }
    setStop(run, "config", (e as Error).message, row.id, cls);
    return;
  }
  const kind = embedFailure(e), pe = e as { kind?: string; status?: number };
  const what = `${row.id}: ${pe.kind ?? "error"}${pe.status ? ` ${pe.status}` : ""}`;
  if (kind === "provider") setStop(run, "provider", `the embeddings model of ${what} failed; the next sweep tries again`, row.id, cls);
  else if (kind === "aborted") setStop(run, "provider", `the request of ${what} was aborted`, row.id, cls);
  else if (kind === "config" || kind === "input") setStop(run, "config", `the embeddings connection of ${what} is not usable: check its address, key and model`, row.id, cls);
  else setStop(run, "config", `${what}: ${(e as Error)?.message?.slice(0, 120) ?? "unknown failure"}`, row.id, cls);
  log.warn("embed_backfill_stop", { embedder: row.id, kind, error_kind: pe.kind ?? null, status: pe.status ?? null });
}

/** A read of the source rule that hit a lock, a deadlock or a statement time-out — a lock hit, not a stop. */
const LOCK_CODES = SOURCE_WAIT_CODES;

/**
 * Records of `cls` whose indexed stage has waited long for a class move (`index_held_long`, holdWait) — health
 * shows the count (the gateway reads only the progress row). By the index of pending stages; a failure is a log line and
 * no count (the progress is still written).
 */
async function heldLongIn(ctx: DbCtx, cls: DataClass): Promise<number> {
  try {
    return (await recordsDb(ctx, cls).query(
      "SELECT count(*)::int AS n FROM record_stages WHERE stage = 'indexed' AND status = 'pending' AND starts_with(last_error, $1)", [HOLD_LONG_CODE])).rows[0]?.n ?? 0;
  } catch (e) {
    log.warn("embed_backfill_held_long_count_failed", { class: cls, error: String((e as Error)?.message ?? e).slice(0, 120) });
    return 0;
  }
}

/**
 * The fence could not read its rows for another reason than a lock (the control database down, a permission, a
 * lost connection): nothing was sent and the model is not to blame — stop `config` of this target in this database with the
 * database's code (health shows it; the first good pass of the same target there clears it), logged with the code.
 */
function sourceFault(run: Run, row: EmbedderRow, cls: DataClass, e: SourceLocked): true {
  log.warn("embed_backfill_source_check_failed", { embedder: row.id, class: cls, code: e.code ?? null });
  setStop(run, "config", `the source check of ${row.id} in ${cls} failed (${e.code ?? "no code"}): check the records and control databases`, row.id, cls);
  return true;
}

/**
 * Fills one target in one records database. Returns false when the run must end (budget, time, a stop that ends the
 * run); true when the next target or database may go on.
 */
async function fill(run: Run, row: EmbedderRow, cls: DataClass): Promise<boolean> {
  const { ctx } = run;
  const db = recordsDb(ctx, cls);
  const key = `${row.id}:${cls}`;
  // a class the target may not see: nothing of it to fill, so nothing of it stops (the stop's cause is gone with it)
  if (!allowsOf(ctx, row, cls)) { run.notIncluded.set(key, true); pass(run, row.id, cls); return true; }
  let sql: ReturnType<typeof embedderSql>;
  try { sql = embedderSql(row); } catch { setStop(run, "config", `embedder id ${row.id} does not match the rule of vector indexes`, row.id, cls); return true; }
  // index before data: made here only while the embedder has no vector in this database (an empty predicate: seconds)
  if (!(await indexValid(db, row.id))) {
    const any = (await db.query("SELECT EXISTS (SELECT 1 FROM chunk_embeddings WHERE embedder_id = $1) AS ok", [row.id])).rows[0]?.ok === true;
    if (any) { setStop(run, "config", `vector index of ${row.id} missing in ${cls}: apply the schema`, row.id, cls); return true; }
    // a lock wait is a lock hit; any other failure of the index is permanent until the schema or the row changes
    try { await ensureEmbeddingIndex(db, sql.ref); }
    catch (e) {
      if (e instanceof StageWait || pgCode(e) === "55P03" || pgCode(e) === "40P01") { run.lockHit = true; return true; }
      setStop(run, "config", `the vector index of ${row.id} cannot be made in ${cls}${pgCode(e) ? ` (${pgCode(e)})` : ""}: apply the schema or check the embedder`, row.id, cls);
      return true;
    }
  }
  let cursor = run.cursors.get(key) ?? null, wrapped = cursor === null, changedRuns = 0;
  // a chunk whose vector is of another source than the row's now is filled again (recomputed) — only
  // when the operator allowed it; otherwise only chunks with no vector of the row at all are filled. A row whose source the
  // worker has not followed yet is not filled: whether its vectors without a source are adopted is not decided
  const view = await viewOf(ctx, row);
  if (view && !view.followed) { log.info("embed_backfill_source_not_followed", { embedder: row.id, class: cls }); return true; }
  const want = view && !view.recompute ? `NOT ${ANY_VECTOR("$1")}` : `NOT ${hasVector("$1", "$5", "$6")}`;
  for (;;) {
    if (outOfTime(run)) return false;
    await run.alive();
    const rows = (await db.query(
      `SELECT c.id::text AS id, c.record_id::text AS record_id, c.text, c.time_from_sec, c.section_path, c.page_from, r.title, r.type, r.occurred_at FROM ${LIVE}
        WHERE ($2::uuid IS NULL OR c.id > $2) AND ${want} AND c.id <> ALL($3::uuid[]) AND $5::text IS NOT DISTINCT FROM $5 AND $6::boolean IS NOT DISTINCT FROM $6 ORDER BY c.id LIMIT $4`,
      [row.id, cursor, run.parked, Math.min(run.cfg.batch, run.cfg.max_chunks_per_run - run.processed), view?.source ?? null, view?.legacy ?? false])).rows as Batch;
    if (!rows.length) {
      if (wrapped) { run.cursors.set(key, null); pass(run, row.id, cls); return true; }   // nothing left here: past any cause
      cursor = null; wrapped = true;                              // chunks may have come in before the cursor: once from the start
      continue;
    }
    // chunks of a record under a class move (or one the locator puts elsewhere) wait for a later sweep
    // the rule could not be read (the control database down, a permission) — the same stop `config` as a fault of
    // the fence with the code; a lock wait or a deadlock — a lock hit (before: the run threw and left no stop for health)
    let held: Set<string>;
    try { held = await heldBack(ctx, db, cls, [...new Set(rows.map((r) => r.record_id))]); }
    catch (e) {
      if (LOCK_CODES.has(pgCode(e) ?? "")) { run.lockHit = true; return true; }
      return sourceFault(run, row, cls, new SourceLocked(pgCode(e), e));
    }
    const batch = rows.filter((r) => !held.has(r.record_id));
    // a waiting chunk is no work done and no work left for this run (`more`), only a count for health
    const waiting = run.waiting.get(key) ?? new Set<string>();
    for (const r of rows) if (held.has(r.record_id)) waiting.add(r.id); else waiting.delete(r.id);
    run.waiting.set(key, waiting);
    const sent = batch.length ? await send(run, row, cls, batch) : null;
    // the fence could not read its rows (SourceLocked: a lock wait, a deadlock, a lost connection) — nothing was
    // sent and the model did nothing: a lock hit of this run (stop `lock` after LOCK_RUNS_MAX runs), never `provider`
    if (sent?.kind === "error" && sent.error instanceof SourceLocked && !LOCK_CODES.has(sent.error.code ?? "")) return sourceFault(run, row, cls, sent.error);
    if (sent?.kind === "error" && (sent.error instanceof SourceLocked || pgCode(sent.error) === "55P03" || pgCode(sent.error) === "40P01")) { run.lockHit = true; return true; }
    if (sent?.kind === "error" && sent.error instanceof SourceChanged) {
      // a record changed between the read and the send (nothing was sent): read the batch again, at most twice in a row
      if (++changedRuns > 2) { run.lockHit = true; return true; }
      continue;
    }
    changedRuns = 0;
    if (!sent) {
      cursor = rows[rows.length - 1]!.id;
      run.cursors.set(key, cursor);
      continue;
    }
    if (sent.kind === "budget") { run.budget = true; return false; }
    if (sent.kind === "policy") { run.notIncluded.set(key, true); pass(run, row.id, cls); return true; }
    let ids = batch.map((r) => r.id), vectors: number[][] = [], hashes: (Buffer | null)[] = [], sources: string[] = [];
    if (sent.kind === "error") {
      if (embedFailure(sent.error) !== "input") { await stopFor(run, row, cls, sent.error); return true; }
      // a rejected input: each chunk alone, the one that fails alone is parked
      ids = [];
      for (const r of batch) {
        await run.alive();
        const one = await send(run, row, cls, [r]);
        if (one.kind === "error" && one.error instanceof SourceChanged) continue;     // its record left meanwhile: not sent
        if (one.kind === "error" && one.error instanceof SourceLocked) { if (!LOCK_CODES.has(one.error.code ?? "")) return sourceFault(run, row, cls, one.error); run.lockHit = true; return true; }
        if (one.kind === "budget") { run.budget = true; return false; }
        if (one.kind === "policy") { run.notIncluded.set(key, true); pass(run, row.id, cls); return true; }
        if (one.kind === "error") {
          if (embedFailure(one.error) !== "input") { await stopFor(run, row, cls, one.error); return true; }
          if (run.parked.length >= REBUILD_PARKED_MAX) { setStop(run, "stalled", `more than ${REBUILD_PARKED_MAX} chunks are rejected by the embeddings model of ${row.id}`, row.id, cls); return false; }
          run.parked.push(r.id);
          log.warn("embed_backfill_parked", { embedder: row.id, chunk_id: r.id, class: cls });
          continue;
        }
        if (one.embedderId !== row.id) { setStop(run, "config", `the facade answered for another embedder than ${row.id}`, row.id, cls); return true; }
        // each vector under the source of its own send (its hash is of that source too)
        ids.push(r.id); vectors.push(one.vectors[0]!); hashes.push(one.hashes[0]!); sources.push(one.source);
      }
    } else {
      if (sent.embedderId !== row.id) { setStop(run, "config", `the facade answered for another embedder than ${row.id}`, row.id, cls); return true; }
      vectors = sent.vectors;
      hashes = sent.hashes;
      sources = ids.map(() => sent.source);
    }
    if (ids.length) {
      await run.alive();                                            // the lock lost while the model answered: nothing is written
      const stored = await store(db, sql, ids, vectors, hashes, sources);
      if (stored === "lock") { run.lockHit = true; return true; }
    }
    run.processed += batch.length;
    if (ids.length) pass(run, row.id, cls);                         // a batch of this target went through in THIS database: past its cause here
    cursor = rows[rows.length - 1]!.id;
    run.cursors.set(key, cursor);
    if (run.cfg.pause_ms) await sleep(run.cfg.pause_ms);
  }
}

// ---------------------------------------------------------------- the run

const rowsNow = async (ctx: DbCtx): Promise<EmbedderRow[]> => (await ctx.db.control.query(`SELECT ${ROW_COLUMNS} FROM embedders WHERE active OR candidate OR retire_at IS NOT NULL ORDER BY active DESC, id`)).rows as EmbedderRow[];

function phaseOf(rows: readonly EmbedderRow[], cov: readonly Coverage[], retiring: boolean): RebuildPhase {
  if (rows.some((r) => r.candidate)) {
    const allowed = cov.filter((c) => c.allowed);
    if (allowed.length && allowed.every((c) => c.have + c.parked >= c.chunks && c.indexValid)) return "ready";
    return allowed.some((c) => c.have > 0) ? "filling" : "prepared";
  }
  if (retiring) return "retiring";
  return rows.some((r) => !r.active && !r.candidate && r.closed_at === null && r.retire_at !== null) ? "switched" : "idle";
}

/**
 * One run of the backfill (see the head of this file). `busy` — another run holds the lock. The progress it returns
 * carries `more`: work is left, no stop is set and the run was not stopped by the money budget — the queue then runs it
 * again at once instead of waiting for the sweep timer.
 */
export async function embedBackfill(ctx: Ctx4, deps: { now?: () => number } = {}): Promise<(RebuildProgress & { more: boolean }) | "busy"> {
  const now = deps.now ?? Date.now;
  return withRunLock(ctx, "embed", async (alive) => {
    const prev = await readRebuildProgress(ctx.db.control, ctx.instanceId, "embed");
    const run: Run = { ctx, cfg: reembedSettings(ctx.settings), now, started: now(), alive, parked: [], stop: null, processed: 0, lockHit: false, budget: false, requests: 0,
                       cursors: new Map(), notIncluded: new Map(), retiring: false, purged: new Set(prev?.purged ?? []), held: [],
                       stopTarget: null, stopDb: null, passed: new Set(), truncated: 0, waiting: new Map() };
    // the vector sources are followed before anything is filled (the adoption is decided first)
    await followVectorSources(ctx).catch((e: unknown) => log.warn("embed_backfill_follow_failed", { error: (e as Error).message.slice(0, 200) }));
    // (1) parked chunks that still exist, for the same target only (a change of the target retries them)
    let rows = await rowsNow(ctx);
    const cand0 = rows.find((r) => r.candidate) ?? null, active0 = rows.find((r) => r.active) ?? null;
    const to0 = (cand0 ?? active0)?.id ?? null;
    run.parked = prev && prev.to === to0 ? await existingParked(ctx, prev.parked_ids) : [];
    if (prev && prev.to === to0) for (const [cls, d] of Object.entries(prev.databases)) if (d?.cursor) run.cursors.set(`${to0}:${cls}`, d.cursor);
    // (2) purge
    await purge(run);
    // (3) targets and the disk head-room for what is still missing
    rows = await rowsNow(ctx);
    const active = rows.find((r) => r.active) ?? null, candidate = rows.find((r) => r.candidate) ?? null;
    const targets = [active, candidate].filter((r): r is EmbedderRow => r !== null);
    let need = 0;
    const usable: EmbedderRow[] = [];
    const moved = await legacyModelMoved(ctx, rows);
    for (const t of targets) {
      const st = embedderFor({ platform: ctx.platform, settings: ctx.settings }, t);
      if (st.state === "off") { setStop(run, "config", st.detail, t.id); continue; }
      const m = moved.get(t.id);
      if (m) { setStop(run, "config", `${t.id} keeps vectors of ${m.was}, but its connection now names ${m.now}: put ${m.was} back into retrieval.embeddings_model`, t.id); continue; }
      usable.push(t);
      for (const cls of CLASSES) {
        if (!st.embedder.allows(cls)) continue;
        const c = await coverageIn(ctx, t, cls, run.parked, true);
        need += Math.max(0, c.chunks - c.have - c.parked - (c.stale ?? 0)) * bytesPerVector(t.dims);
      }
    }
    let gated = false;
    if (need > 0) {
      const gate = await diskGate(ctx, need);
      if (!gate.ok) { setStop(run, "disk", gate.detail); gated = true; }
    }
    // (4) fill: the active row first (search), then the candidate
    if (!gated) {
      outer: for (const t of usable) {
        for (const cls of CLASSES) if (!(await fill(run, t, cls))) break outer;
      }
    }
    // (5) the switch, when the candidate is covered and the switch is automatic
    const to = candidate ?? active;
    const parkedDeps = workerRegistryDeps(ctx, run.parked, moved);
    let cov = to ? await parkedDeps.coverage(to) : [];
    if (candidate && run.cfg.auto_switch && !run.budget && phaseOf(rows, cov, false) === "ready") {
      const client = await ctx.db.control.connect();
      let moved: Awaited<ReturnType<typeof switchEmbedder>> | null = null;
      try {
        await client.query("BEGIN");
        moved = await switchEmbedder(client, parkedDeps, { retainDays: run.cfg.retain_days, instanceId: ctx.instanceId });
        // a COMMIT the server turned into a rollback is an error — no audit event for a switch that is not stored
        if (moved.ok) await commitOrThrow(client); else await client.query("ROLLBACK");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
      if (moved.ok) {
        log.info("embedder_switched", { from: moved.from, to: moved.to, auto: true });
        await auditWorker(ctx, { event_type: "admin", details: { op: "embedder_switch", from: moved.from, to: moved.to, auto: true, not_included: moved.not_included ?? 0, parked: moved.parked ?? 0 } });
        rows = await rowsNow(ctx);
        cov = await parkedDeps.coverage(rows.find((r) => r.active)!);
      } else log.info("embedder_switch_waits", { to: candidate.id, why: moved.why });
    }
    // (6) progress
    const lockRuns = run.lockHit ? (prev?.stop?.reason === "lock" ? LOCK_RUNS_MAX : (Number((prev as { lock_runs?: unknown } | null)?.lock_runs) || 0) + 1) : 0;
    if (lockRuns >= LOCK_RUNS_MAX) setStop(run, "lock", `a batch waited longer than 5 s for a lock in ${lockRuns} runs in a row`);
    // a stop of a target is cleared only by a run that got past ITS cause: with `stop_db` (an index, a model answer
    // in that database) — the same target in the same records database; without it (the connection off: target-wide) —
    // the first success of the same target in any database. Progress of another target, or of the same target in another
    // database for a database cause, or a run that ended before it (budget, time, the disk gate, the active row first)
    // keeps it while the row is still a target; the same stop keeps its first `since`
    const prevTarget = (prev as { stop_target?: unknown } | null)?.stop_target;
    const prevDbRaw = (prev as { stop_db?: unknown } | null)?.stop_db;
    const prevDb = (CLASSES as readonly unknown[]).includes(prevDbRaw) ? prevDbRaw as DataClass : null;
    if (!run.stop && prev?.stop && typeof prevTarget === "string" && !run.passed.has(prevDb ? `${prevTarget}:${prevDb}` : prevTarget)
        && usable.concat(targets).some((t) => t.id === prevTarget)) {
      run.stop = prev.stop; run.stopTarget = prevTarget; run.stopDb = prevDb;
    }
    if (run.stop && prev?.stop && run.stop.reason === prev.stop.reason && run.stop.detail === prev.stop.detail) run.stop = { ...run.stop, since: prev.stop.since };
    const cand = rows.find((r) => r.candidate) ?? null, act = rows.find((r) => r.active) ?? null;
    const target = cand ?? act;
    const retained = rows.find((r) => !r.active && !r.candidate && r.closed_at === null && r.retire_at !== null) ?? null;
    const databases: Partial<Record<DataClass, RebuildDb>> = {};
    for (const c of cov) {
      const k = `${target?.id}:${c.class}`;
      const allowed = c.allowed && !run.notIncluded.get(k);
      const waiting = run.waiting.get(k)?.size ?? 0;
      const heldLong = await heldLongIn(ctx, c.class);
      databases[c.class] = { chunks: c.chunks, done: c.have, not_included: allowed ? 0 : c.chunks, parked: c.parked, cursor: run.cursors.get(k) ?? null, index_valid: c.indexValid,
                             ...(allowed && waiting ? { waiting } : {}), ...(heldLong ? { held_long: heldLong } : {}), ...(allowed && c.stale ? { stale: c.stale } : {}) };
    }
    const phase = phaseOf(rows, cov.map((c) => ({ ...c, allowed: c.allowed && !run.notIncluded.get(`${target?.id}:${c.class}`) })), run.retiring);
    const truncated = (prev && prev.to === target?.id ? Number(prev.truncated) || 0 : 0) + run.truncated;
    const p: RebuildProgress & { lock_runs?: number; stop_target?: string; stop_db?: DataClass } = {
      kind: "embed", phase, from: cand ? act?.id ?? null : retained?.id ?? null, to: target?.id ?? null, at: new Date(now()).toISOString(),
      need_bytes: need, databases, parked_ids: run.parked, stop: run.stop, purged: [...run.purged].sort(), ...(run.held.length ? { purge_held: run.held } : {}),
      ...(lockRuns ? { lock_runs: lockRuns } : {}), ...(run.stop && run.stopTarget ? { stop_target: run.stopTarget, ...(run.stopDb ? { stop_db: run.stopDb } : {}) } : {}), ...(truncated ? { truncated } : {}),
    };
    await saveRebuildProgress(ctx, p);
    // work left: chunks this run could fill — not those waiting for a class move (else a run that only skipped them
    // would queue itself again at once, back to back, while the move lasts)
    const left = Object.values(databases).some((d) => d && d.not_included === 0 && d.done + d.parked + (d.waiting ?? 0) + (d.stale ?? 0) < d.chunks);
    const more = run.stop === null && !run.budget && !gated && run.processed > 0 && (left || outOfTime(run));
    // a run that left nothing to do ends an adoption whose vectors are gone and turns the one-shot
    // lever off when its word is done
    if (!more && run.stop === null) await settleOperatorWords(ctx, recomputable(ctx, run.parked)).catch((e: unknown) => log.warn("embed_backfill_settle_failed", { error: String((e as Error)?.message ?? e).slice(0, 200) }));
    return { ...p, more };
  });
}
