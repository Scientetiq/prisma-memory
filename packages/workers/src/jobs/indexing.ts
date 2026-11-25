// Stage indexed: a deterministic chunker without a model → chunks; the embedder gets a context header + the text,
// chunks.text and full text: the text only.
// Two transactions: chunks first (full text finds the record even if the embedder fails), then vectors; the stage is done
// only with vectors; when the embedder fails — failed with a retry, and the chunks stay.
// Without an active embedder (stage version "none") the stage is done with chunks only: keyword search finds the record.
// Stage claim: a large document takes longer to index than the job term — the work renews the claim after chunking and
// each vector batch, and writes chunks and vectors only under it; lost — exit, no write (a second process cannot write
// over the first). The space, visibility, type and date of the chunks are fresh, under the record row lock: a move
// of the record between reading and writing chunks would be lost; keyword search would miss it in the new space.
// Vectors come from the embeddings facade (embedderFor): the registry row gives its profile and its connection,
// batches follow the profile, 429 waits inside the call, the claim is renewed before every request. The data policy does
// not let this embedder receive the record's class → the stage is done with chunks only (keyword search finds it; no
// vectors, no processor.embedder, log `index_not_included`) — not a failure that would retry for ever; the money budget
// spent → the stage waits (no attempt spent).
// The embedders to write are read at write time, right before embedding — the active row and
// the candidate (`active OR candidate`), never the job's version: a job queued before a switch or before a candidate was
// registered still writes what is current. No active row, or one without a usable connection → the stage is done with
// chunks only (the backfill sweep adds the vectors later). The candidate is embedded after the active row; any stop or
// failure of it is one log line `index_candidate_left` and never changes the stage — the sweep fills it. The vectors of
// both go into the one vectors transaction.
import { LLM_GATE_DEFAULTS } from "@memory/shared";
import { createHash } from "node:crypto";
import { StageFault, StageWait, STORE_LOCKED_KIND } from "../stages.ts";
import { MODEL_BUDGET_TEXT } from "../retry-policy.ts";
import type pg from "pg";
import { embedderFor, embedderSql, estimateTokens, log, newId, PlatformError, tx, type DataClass, type EmbedderRow } from "@memory/shared";
import { recordsDb, type Ctx } from "../ctx.ts";
import { StageClaimLost, type StageClaim, type StageJob } from "../stages.ts";
import { chunkMarkdown, chunkParams, chunkShort, chunkTranscript, embeddingInput, parseTranscriptText, type Chunk } from "../pipeline/index.ts";
import { dateLabel, loadRecord, MOVE_WAIT_SEC, TYPE_LABEL, type Rec } from "./common.ts";
import { heldBack, SourceChanged, SourceLocked, sourceFence, SOURCE_WAIT_CODES } from "./embed-source.ts";
import { legacyModelMoved, unfollowedAfterLook } from "./embedders.ts";
import { embeddingIndexReady, ensureEmbeddingIndex, INDEX_BUSY_CODE, INDEX_BUSY_WAIT_MS } from "./embedding-index.ts";

/** The whole warm-up of one meeting's derived records ends after this long. */
export const WARM_UP_DEADLINE_MS = 30_000;
/** Vectors per INSERT statement: one statement per slice instead of one per vector, all slices in one transaction. */
export const VECTOR_INSERT_ROWS = 200;
/** The columns of a registry row the embeddings facade reads (EmbedderRow). */
const EMBEDDER_ROW_COLUMNS = "id, model, dims, query_instruction, max_tokens, profile, connection_slot, active, candidate, retire_at, closed_at, vector_generation";

/**
 * The money budget is spent (the facade's `stop: "budget"`): nothing was sent, so the stage waits like a blocked
 * model stage — StageWait: pending, the attempt returned, a term of busy_backoff_cap_sec (the scheduler re-queues it then),
 * last_error `model_budget:` — instead of failing and, after processing.retries.limit, waiting for Retry with no vectors
 * and no later stages.
 */
function waitForBudget(ctx: Ctx): never {
  const sec = Number(ctx.settings.get("processing.llm_gate", LLM_GATE_DEFAULTS).busy_backoff_cap_sec ?? LLM_GATE_DEFAULTS.busy_backoff_cap_sec);
  throw new StageWait(new Date(Date.now() + (Number.isFinite(sec) && sec > 0 ? sec : LLM_GATE_DEFAULTS.busy_backoff_cap_sec) * 1000), MODEL_BUDGET_TEXT, false);
}

/**
 * Chunks of the previous version and of its NON-CURRENT descendants at any depth: a new version
 * of a meeting retires the old one's whole subtree (createRecord), and it leaves the index with event corrections and
 * transcript grandchildren; a correction's version (memory_correct) keeps the old one's children: «wrong» and «outdated»
 * ones stay findable.
 * The chain of previous versions (supersedes_id) is walked whole: a version replaced before it was indexed does not remove its predecessor's chunks itself.
 */
export const SUPERSEDED_CHUNKS_SQL = `WITH RECURSIVE d AS (SELECT id, is_current FROM versions WHERE id = $1 OR NOT is_current
    UNION SELECT r.id, r.is_current FROM records r JOIN d ON r.parent_id = d.id),
  versions AS (SELECT id, supersedes_id, is_current FROM records WHERE id = $1
    UNION SELECT r.id, r.supersedes_id, r.is_current FROM records r JOIN versions v ON r.id = v.supersedes_id)
  DELETE FROM chunks WHERE record_id = $1 OR record_id IN (SELECT id FROM d WHERE NOT is_current)`;

type InputRecord = Pick<Rec, "title" | "type" | "occurred_at">;
type InputChunk = Pick<Chunk, "text" | "timeFromSec" | "sectionPath" | "pageFrom">;

/** One input builder for indexing, warm-up and backfill. Stored chunks are never split again. */
export function planIndex(settings: Ctx["settings"], rec: InputRecord, text: string | readonly InputChunk[]): { chunks: Chunk[]; inputs: string[] } {
  const chunks = typeof text === "string" ? splitIndex(settings, rec, text) : text.map((c, ordinal) => ({ ordinal, tokenCount: 0, pageTo: null, timeToSec: null, speakers: [], overlapTokens: 0, ...c }));
  return { chunks, inputs: chunks.map((c) => chunkInput(rec, c)) };
}

/**
 * The stored hash of an embedding input: SHA-256 of the vector source the vector is computed with (the
 * embedder's `source`: connection, space, generation — embedder.ts vectorSource) and the input. A vector is reused only
 * under the same source, whatever settings copy another process had: the hash is made from the embedder that sends.
 * No hash of this form existed before it (input_hash came after the base): nothing stored
 * is invalidated by it.
 */
export function inputHash(input: string, source: string): Buffer {
  if (!source) throw new Error("vector_source_missing");
  return createHash("sha256").update(`\u0000vector-source:${source}\u0000`).update(input).digest();
}

function splitIndex(settings: Ctx["settings"], rec: InputRecord, text: string): Chunk[] {
  const cfg = settings.get<{ target: number; maximum: number; minimum: number; overlap_max: number }>("processing.chunk", { target: 380, maximum: 480, minimum: 60, overlap_max: 120 });
  // the chunk budget minus the embedder header (title · type · date): else the embedder input would pass processing.chunk.maximum
  const typeLabel = TYPE_LABEL[rec.type] ?? rec.type, date = dateLabel(rec.occurred_at);
  const reserve = estimateTokens([rec.title ?? "", typeLabel, date].filter(Boolean).join(" · ")) + 2;
  const maximum = Math.max(cfg.minimum, cfg.maximum - reserve), target = Math.min(cfg.target, maximum);
  const params = chunkParams({ target, maximum, minimum: Math.min(cfg.minimum, target), overlapMax: Math.min(cfg.overlap_max, target) });
  const body = rec.type === "note" || rec.type === "event" || rec.type === "profile" ? [rec.title, text].filter(Boolean).join("\n") : text;
  const chunks: Chunk[] = !body.trim() ? [] : rec.type === "transcript" ? chunkTranscript(parseTranscriptText(text), undefined, params)
    : rec.type === "document" || rec.type === "summary" ? chunkMarkdown(body, undefined, params) : chunkShort(body, undefined, params);
  // a transcript without timestamps is parsed as plain text
  return chunks.length || !body.trim() ? chunks : chunkShort(body, undefined, params);
}

type Reuse = Map<string, number[]>;
const reuseKey = (id: string, hash: Buffer): string => `${id}:${hash.toString("hex")}`;
/** Read only this class database, under the record lock and before its chunks are deleted. NULL hashes never match. */
export async function loadReuse(c: Pick<pg.PoolClient, "query">, rec: Pick<Rec, "id" | "supersedes_id">, targets: readonly string[]): Promise<Reuse> {
  // only the vectors of the write targets, not of retained or closed rows
  if (!targets.length) return new Map();
  const ids = [rec.id, ...(rec.supersedes_id ? [rec.supersedes_id] : [])];
  // A new record has nothing to reuse. Do not take a vector-table read lock before its keyword chunks are committed.
  if (!(await c.query("SELECT 1 FROM chunks WHERE record_id = ANY($1::uuid[]) LIMIT 1", [ids])).rows.length) return new Map();
  const rows = (await c.query(
    `SELECT e.embedder_id, e.input_hash, e.embedding::text AS embedding FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id
      WHERE c.record_id = ANY($1::uuid[]) AND e.embedder_id = ANY($2::text[]) AND e.input_hash IS NOT NULL`, [ids, targets])).rows;
  const reuse: Reuse = new Map();
  for (const r of rows) reuse.set(reuseKey(r.embedder_id, r.input_hash), JSON.parse(r.embedding));
  return reuse;
}

export async function indexRecord(ctx: Ctx, job: StageJob, claim?: StageClaim): Promise<"done" | "skipped"> {
  const loaded = await loadRecord(ctx, job.class, job.record_id);
  if (!loaded) return "skipped";
  const { rec, text } = loaded;
  // Select the write targets before replacing chunks: their reusable vectors must survive a failed paid request.
  const targets = await writeTargets(ctx, rec.id);
  // the record's text reaches the model only while it may (embed-source.ts), checked again at dispatch
  const fence = sourceFence(ctx, job.class, () => [rec.id]);
  const onHold = sourceHold(claim, rec.id);
  // one embedder per target for the whole job — the hashes, the reuse and the send all name the source of the
  // embedder that sends, even when the settings are reloaded in between
  const states = new Map(targets.map((r) => [r.id, embedderFor({ platform: ctx.platform, settings: ctx.settings }, r)]));
  const stateOf = (row: EmbedderRow) => states.get(row.id)!;
  const allowed = (row: EmbedderRow) => { const st = stateOf(row); return st.state === "ready" && st.embedder.allows(job.class); };
  // the first look at a target's vector source comes first — no vector is stored for a row the worker has
  // not followed (its vectors from before the upgrade would no longer be adopted); a look that failed holds the stage,
  // a wait before anything is written, not a failure. A row the SQL rule refuses stores no vector at all: its
  // stage writes the chunks and fails as before
  const storable = (row: EmbedderRow) => { try { embedderSql(row); return allowed(row); } catch { return false; } };
  const unfollowed = await unfollowedAfterLook(ctx, targets.filter(storable).map((r) => r.id));
  if (unfollowed.size) {
    log.info("index_source_not_followed", { record_id: rec.id, embedders: [...unfollowed] });
    throw new StageWait(new Date(Date.now() + INDEX_BUSY_WAIT_MS), SOURCE_NOT_FOLLOWED_CODE);
  }
  // a record that may not go to a model now waits BEFORE it is chunked and its chunks are rewritten — a wait
  // repeated for the whole move would otherwise redo all of that each time (only when some target could be sent to)
  if (targets.some(allowed)) await fence.beforeRequest().catch(onHold);
  const { chunks: final, inputs } = planIndex(ctx.settings, rec, text);
  let reuse: Reuse = new Map();
  const embedder = targets.find((r) => r.active) ?? null, candidate = targets.find((r) => r.candidate && !r.active) ?? null;
  const persisted = new Map<string, Set<number>>();
  // each target hashes under the source of its embedder (no embedder — nothing to hash, nothing is sent)
  const hashesOf = new Map(targets.flatMap((r) => { const st = stateOf(r); return st.state === "ready" ? [[r.id, inputs.map((i) => inputHash(i, st.embedder.source))] as const] : []; }));
  const hashOf = (row: EmbedderRow): Buffer[] => hashesOf.get(row.id)!;
  const sourceOf = (row: EmbedderRow): string => { const st = stateOf(row); if (st.state !== "ready") throw new Error("vector_source_missing"); return st.embedder.source; };

  // still our claim? Chunking a large document is long CPU work; without a renewal a job retry would take the stage
  const keep = async (c?: pg.PoolClient) => { if (claim && !(await claim.touch(c))) throw new StageClaimLost(); };
  await keep();

  // 1) chunks — one transaction: full text never sees a half-written state and works before and without vectors.
  // The record row is locked (the same order as a move between spaces: the record, then the chunks): the space
  // and visibility are current, not as read before chunking
  const ids = final.map(() => newId());
  // what this transaction waits for when its lock times out — named per step, as in the second transaction: the
  // record's row (and the claim's stage row), then the record's chunks and vectors
  let locked1 = RECORD_BUSY_CODE;
  const live = await tx(recordsDb(ctx, job.class), async (c) => {
    await c.query("SET LOCAL lock_timeout = '5s'");
    const cur = (await c.query("SELECT space_id, audience, type, occurred_at FROM records WHERE id = $1 AND deleted_at IS NULL AND is_current FOR UPDATE", [rec.id])).rows[0];
    if (!cur) return false;                                       // deleted or replaced by a new version during chunking
    await keep(c);
    locked1 = INDEX_BUSY_CODE;
    reuse = await loadReuse(c, rec, targets.filter(allowed).map((r) => r.id));
    const cached: { sql: ReturnType<typeof embedderSql>; indices: number[]; vectors: number[][]; hashes: Buffer[]; source: string }[] = [];
    for (const row of targets) {
      let sql: ReturnType<typeof embedderSql>;
      try { sql = embedderSql(row); } catch { continue; } // Active SQL validation below still leaves keyword chunks.
      if (!allowed(row)) continue;
      const rh = hashOf(row);
      const indices = rh.flatMap((hash, i) => reuse.has(reuseKey(row.id, hash)) ? [i] : []);
      const vectors = indices.map(i => reuse.get(reuseKey(row.id, rh[i]!))!);
      if (vectors.some(v => !validVector(v, sql.ref.dims))) {
        if (row.active) throw new Error("embedding_batch_mismatch");
        log.info("index_candidate_left", { record_id: rec.id, embedder: row.id, why: "bad_response" });
        continue;
      }
      cached.push({ sql, indices, vectors, hashes: rh, source: sourceOf(row) });
    }
    // the record's own chunk rows are locked first, so a wait for them is named for them
    locked1 = RECORD_CHUNKS_BUSY_CODE;
    await c.query("SELECT id FROM chunks WHERE record_id = $1 ORDER BY id FOR UPDATE", [rec.id]);
    locked1 = INDEX_BUSY_CODE;
    await c.query("DELETE FROM chunks WHERE record_id = $1", [rec.id]);
    for (let i = 0; i < final.length; i++) {
      const ch = final[i]!;
      await c.query(
        `INSERT INTO chunks (id, record_id, ordinal, text, token_count, section_path, page_from, page_to, time_from_sec, time_to_sec, space_id, audience, type, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [ids[i], rec.id, ch.ordinal, ch.text, ch.tokenCount, ch.sectionPath, ch.pageFrom, ch.pageTo, ch.timeFromSec === null ? null : Math.floor(ch.timeFromSec), ch.timeToSec === null ? null : Math.ceil(ch.timeToSec), cur.space_id, cur.audience, cur.type, cur.occurred_at]);
    }
    for (const part of cached) {
      await insertVectors(c, part.indices.map(i => ids[i]!), part.sql, part.vectors, part.indices.map(i => part.hashes[i]!), part.source);
      persisted.set(part.sql.ref.id, new Set(part.indices));
    }
    await c.query("UPDATE records SET token_count = COALESCE(token_count, $2) WHERE id = $1", [rec.id, final.reduce((n, x) => n + x.tokenCount, 0)]);
    return true;
  }).catch((e: unknown) => {
    if ((e as { code?: string })?.code === "55P03") throw new StageWait(new Date(Date.now() + INDEX_BUSY_WAIT_MS), locked1);
    throw e;
  });
  if (!live) return "skipped";

  // 2) vectors: an embedder failure throws → the stage fails and retries; the chunks above stay
  // the targets, read now: the active row and the candidate. No active row (a fresh install) — keyword
  // search only, the stage is done; the backfill sweep embeds the chunks once a model is configured
  // the registry row goes into SQL text (literal id, cast halfvec(N)) and is checked before any vector work. A
  // row the rule refuses (an older id with an underscore, a colon or a capital letter) stops only the
  // vector part: the chunks above are written, so keyword search finds the record, then the stage fails with that
  // error and no model call
  // the vectors this pass was paid for — the answered requests of both embedders (the facade's
  // onVectors). Every way out below that does not store them writes one line `index_vectors_lost`: `code` says how it
  // ended, `vectors_lost` how many paid vectors are dropped (the repeat asks the model for them again)
  // the lines count per embedder, and a line takes what it reports out of its count — a later line
  // does not count the same vectors again.: whether a lock wait of the second transaction keeps its attempt
  // is one fact, `paidThisPass` — the provider was paid for at least one vector in this pass; set where the payment is
  // counted and cleared by nothing (not a candidate leaving, not the policy, not a line)
  const paid = { active: 0, candidate: 0 };
  let paidThisPass = 0;
  const paidNow = () => paid.active + paid.candidate;
  const onVectors = (n: number) => { paid.active += n; paidThisPass += n; };
  const onCandidate = (n: number) => { paid.candidate += n; paidThisPass += n; };
  const lostLine = (code: string, more: Record<string, unknown> = {}, of: "both" | "active" | "candidate" = "both") => {
    const n = of === "both" ? paidNow() : paid[of];
    if (n > 0) log.warn("index_vectors_lost", { record_id: rec.id, code, ...more, vectors_lost: n });
    if (of !== "candidate") paid.active = 0;
    if (of !== "active") paid.candidate = 0;
  };
  let vsql: ReturnType<typeof embedderSql> | null = null, refInvalid: unknown = null;
  if (embedder) { try { vsql = embedderSql(embedder); } catch (e) { refInvalid = e; } }
  // the index of the embedder exists before its vectors are paid for and written: chunks are already searchable by
  // keyword, a failure here retries the stage without a model call
  if (refInvalid && inputs.length) {
    log.warn("index_embedder_invalid", { record_id: rec.id });
    throw refInvalid;
  }
  if (vsql && inputs.length) await ensureEmbeddingIndex(recordsDb(ctx, job.class), vsql.ref);
  // the record class goes to the T1 gate: a closed class is never given to an external embedder, whatever the settings.
  // The facade asks the data policy before every request, with the class of the database the text was read from
  let vectors: number[][] = [], model: string | null = null, notIncluded = false, cut: ReadonlySet<number> = new Set();
  if (embedder && vsql && inputs.length) {
    const st = stateOf(embedder);
    if (st.state === "off") {
      // no usable connection for the active row (switched off, not configured, another space in its slot): keyword search
      // only, the stage is done — the backfill sweep embeds the chunks when the connection serves the row again
      notIncluded = true;
      log.info("index_embedder_off", { record_id: rec.id, embedder: embedder.id, reason: st.reason });
    } else {
      const out = await reuseDocuments(st.embedder, inputs, hashOf(embedder), reuse, { dataClass: job.class, stage: "indexed", ...fenced(fence, keep), ref: rec.id, onVectors })
        .catch((e: unknown) => { lostLine(...lostOf(e)); return onHold(e); });
      if (!out.ok && out.stop === "budget") { lostLine("budget"); waitForBudget(ctx); }
      if (!out.ok) {
        // the policy does not let this embedder see the record's class: keyword search only, the stage is done
        lostLine(out.stop);
        notIncluded = true;
        log.info("index_not_included", { record_id: rec.id, embedder: embedder.id });
      } else {
        if (out.embedderId !== vsql.ref.id) { lostLine("embedding_batch_mismatch"); throw new Error("embedding_batch_mismatch"); }
        vectors = out.vectors;
        cut = new Set(out.cut ?? []);
        // the model the vectors were computed with: health compares it with the first name the embedder used
        model = st.embedder.profile.space.model || null;
      }
    }
  }
  // the provider must answer one vector of the embedder's length per input: anything else stores nothing (stage fails)
  if (vsql && !notIncluded && (vectors.length !== ids.length || vectors.some((v) => !validVector(v, vsql.ref.dims)))) {
    lostLine("embedding_batch_mismatch");
    throw new Error("embedding_batch_mismatch");
  }
  // the candidate: after the active row; whatever goes wrong is left to the sweep, the stage does not change
  let computedActive = 0;
  const second = candidate && inputs.length
    ? await candidateVectors(job, candidate, stateOf(candidate), inputs, hashesOf.get(candidate.id) ?? [], reuse, keep, rec.id, fence, onCandidate)
      .catch((e: unknown) => { lostLine(...lostOf(e)); throw e; })
    : null;
  // the candidate left after some of its requests were answered — those vectors are not stored
  if (candidate && inputs.length && !second) lostLine("candidate_left", { embedder: candidate.id }, "candidate");
  // computed vectors the policy no longer lets the second transaction store (closed after the last answer)
  const dropped = { active: false, candidate: false };
  // what the second transaction waits for when its lock times out — named for it (the record's rows, the vector
  // table, the chunks of the replaced version), not always the vector table
  let locked = RECORD_BUSY_CODE;
  const indexed = await tx(recordsDb(ctx, job.class), async (c) => {
    // Class moves lock records before cascading into stages. The record may have moved during embedding.
    // the same lock wait as the first transaction (a move or a trash holding the row makes the stage wait, it does
    // not hang the slot), and a version replaced meanwhile stores nothing (its chunks leave with the new version's hygiene).
    // A record put in the trash meanwhile keeps its vectors: they are paid for, the trash is not searched, and a restore
    // re-indexes nothing. A record deleted for good (hard delete, purge of the trash) has no row: nothing is stored
    await c.query("SET LOCAL lock_timeout = '5s'");
    if (!(await c.query("SELECT id FROM records WHERE id = $1 AND is_current FOR UPDATE", [rec.id])).rowCount) return false;
    // the claim is under the stage row lock until commit: a late process writes no vectors
    await keep(c);
    // the record's own chunk rows (the foreign key of every vector written below takes this lock)
    locked = RECORD_CHUNKS_BUSY_CODE;
    await c.query("SELECT id FROM chunks WHERE record_id = $1 ORDER BY id FOR KEY SHARE", [rec.id]);
    locked = INDEX_BUSY_CODE;
    // Transaction 2 only inserts computed vectors. A policy revoked while embedding also removes cached ones.
    for (const row of targets) if (persisted.has(row.id) && !allowed(row))
      await c.query("DELETE FROM chunk_embeddings WHERE chunk_id = ANY($1::uuid[]) AND embedder_id = $2", [ids, row.id]);
    // the vector of an input the facade had to cut is stored without a hash — never reused for the whole input
    const computed = async (row: EmbedderRow, sql: ReturnType<typeof embedderSql>, values: number[][], cutAt: ReadonlySet<number>) => {
      const indices = ids.flatMap((_, i) => persisted.get(sql.ref.id)?.has(i) ? [] : [i]);
      await insertVectors(c, indices.map(i => ids[i]!), sql, indices.map(i => values[i]!), indices.map(i => cutAt.has(i) ? null : hashOf(row)[i]!), sourceOf(row));
      return indices.length;
    };
    if (embedder && vsql && !notIncluded && allowed(embedder)) {
      computedActive = await computed(embedder, vsql, vectors, cut);
      // the model is named only when this run computed a vector with it
      await c.query("UPDATE records SET processor = COALESCE(processor, '{}'::jsonb) || $2::jsonb WHERE id = $1",
                    [rec.id, JSON.stringify({ embedder: embedder.id, ...(model && computedActive ? { embed_model: model } : {}) })]);
    } else if (embedder && vsql && !notIncluded) dropped.active = true;
    if (second && candidate && allowed(candidate)) await computed(candidate, second.sql, second.vectors, second.cut);
    else if (second && candidate) dropped.candidate = true;
    // version hygiene: a new version is indexed — the chunks of the previous version and its derivatives leave the index
    // (embeddings cascade); the content stays, the old version is still read by id. The worker does it: the gateway role lacks DELETE on chunks
    if (rec.supersedes_id) {
      locked = SUPERSEDED_BUSY_CODE;
      const gone = await c.query(SUPERSEDED_CHUNKS_SQL, [rec.supersedes_id]);
      if (gone.rowCount) log.info("superseded_chunks_removed", { record_id: rec.id, supersedes_id: rec.supersedes_id, chunks: gone.rowCount });
    }
    return true;
  }).catch((e: unknown) => {
    // a lock wait over 5 s here makes the stage wait, the attempt is given back (stages.ts StageWait). Known tail:
    // the vectors this attempt paid for are not stored (reuse reads only stored vectors), so the repeat asks the model again
    // for the inputs it computed. The wait is named for what was locked, counted in the reason, and bounded
    // by the attempts (storeWait: a paid wait keeps its attempt); the loss is one log line
    const pgCode = (e as { code?: unknown } | null)?.code;
    if (pgCode !== "55P03") {
      // a lost claim, a deadlock, a statement time-out, a lost connection — the paid vectors are dropped too
      if (e instanceof StageClaimLost) lostLine("claim_lost");
      else lostLine(typeof pgCode === "string" ? "db_error" : "error", { pg_code: typeof pgCode === "string" ? pgCode : null });
      throw e;
    }
    const out = storeWait(locked, claim?.lastError, { limit: ctx.settings.get<{ limit: number }>("processing.retries", { limit: 3 }).limit, attempts: claim?.attempts ?? 0, paid: paidThisPass });
    lostLine(locked, { wait: out.wait });
    throw out.error;
  });
  // the record was replaced by a new version or deleted for good while the model embedded
  if (!indexed) { lostLine("record_gone"); return "skipped"; }
  if (dropped.active) lostLine("policy", {}, "active");
  if (dropped.candidate) lostLine("policy", { embedder: candidate?.id ?? null }, "candidate");
  if (embedder && computedActive && model) await rememberEmbedderModel(ctx, embedder.id, model);
  return "done";
}

/** The second transaction waited over 5 s for the record's row (or its stage row, the claim). */
export const RECORD_BUSY_CODE = "index_wait:record_busy";
/** The second transaction waited over 5 s for the chunks of the version this record replaces. */
export const SUPERSEDED_BUSY_CODE = "index_wait:superseded_chunks_busy";
/** Either transaction waited over 5 s for the record's own chunk rows. */
export const RECORD_CHUNKS_BUSY_CODE = "index_wait:record_chunks_busy";
/** The kind of the failure that ends the waits of the second transaction (it spends an attempt); defined in
 *  stages.ts, which reads it in the claim (one definition, no import cycle). */
export { STORE_LOCKED_KIND };
const STORE_WAIT_TAIL = /^index_wait:(?:record_busy|record_chunks_busy|superseded_chunks_busy|vector_index_busy) \(wait (\d{1,6}), since (\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\)$/;
const LOCKED_WHAT: Record<string, string> = {
  [RECORD_BUSY_CODE]: "the record itself", [SUPERSEDED_BUSY_CODE]: "the chunks of the version this record replaces", [INDEX_BUSY_CODE]: "the search index or the record's vectors",
  [RECORD_CHUNKS_BUSY_CODE]: "the record's own chunks",
};

/**
 * The lock timeout of the second transaction of indexRecord: `code (wait N,
 * since T)` — the stage waits INDEX_BUSY_WAIT_MS; N counts the waits in a row for the reason only (any other outcome starts
 * it again). The bound is the stage's attempts, not N: a pass that paid for vectors (`paid` > 0) keeps its attempt
 * (StageWait `spend`), and on its last attempt (`attempts` ≥ `limit`, processing.retries.limit) it is a failure
 * `index_store_locked` instead — failed with no retry term. Any other wait gives back only its own pass, so it cannot erase
 * the count; the count ends only where the attempts are set to 0 (the code's own list: «Retry», gateway
 * admin.ts; «Process now» and the MCP tool `memory_process_now`, gateway write.ts processNow; a new version is a new
 * stage; for a stage that is running, a class move — stages.ts handoffMoved), and a `processing.retries.limit` raised above
 * the attempts lets a failed stage run again. Between two such resets the stage makes at most `limit` passes
 * whose paid vectors this transaction's locks keep from being saved — at most `limit` − 1 waits, then one failure
 * `index_store_locked` that ends its job without a queue retry and that no later job claims (stages.ts runStage); a wait
 * on a pass past the last attempt leaves the stage failed. Whether a pass paid is one fact (`paidThisPass`,
 *). A pass that paid for nothing waits with its attempt given back, as the first transaction does. `wait` is the
 * number of this wait, null for the failure.
 */
export function storeWait(code: string, prev: string | null | undefined, o: { limit: number; attempts: number; paid: number }, now = Date.now()): { error: StageWait | StageFault; wait: number | null } {
  const m = typeof prev === "string" ? STORE_WAIT_TAIL.exec(prev) : null;
  const n = m ? Number(m[1]) : 0, since = m ? m[2]! : new Date(now).toISOString();
  const what = LOCKED_WHAT[code] ?? code;
  if (o.paid > 0 && o.attempts >= o.limit)
    return { error: new StageFault(STORE_LOCKED_KIND, n > 0
      ? `vectors were computed but not saved: ${what} was locked on the last attempt (waiting since ${since}); a retry recomputes them`
      : `vectors were computed but not saved: ${what} was locked on the last attempt; a retry recomputes them`), wait: null };
  return { error: new StageWait(new Date(now + INDEX_BUSY_WAIT_MS), `${code} (wait ${n + 1}, since ${since})`, false, o.paid > 0), wait: n + 1 };
}

/**
 * The rows vectors are written for now: the active row and the candidate — without a legacy row whose model
 * setting moved away from its vectors (one log line; the backfill shows it as a stop `config`).
 */
async function writeTargets(ctx: Ctx, ref: string): Promise<EmbedderRow[]> {
  const rows = (await ctx.db.control.query(`SELECT ${EMBEDDER_ROW_COLUMNS} FROM embedders WHERE active OR candidate ORDER BY active DESC, id`)).rows as EmbedderRow[];
  const moved = await legacyModelMoved(ctx, rows);
  for (const id of moved.keys()) log.warn("index_embedder_model_moved", { record_id: ref, embedder: id });
  return rows.filter((r) => !moved.has(r.id));
}

const validVector = (v: number[], dims: number): boolean => Array.isArray(v) && v.length === dims && v.every(Number.isFinite);

/** How a paid call of an indexed job ended when it threw — the `code` (and its detail) of `index_vectors_lost`. */
function lostOf(e: unknown): [string, Record<string, unknown>] {
  if (e instanceof SourceChanged) return ["source_changed", {}];
  if (e instanceof SourceLocked) return ["source_locked", { pg_code: e.code ?? null }];
  if (e instanceof StageClaimLost) return ["claim_lost", {}];
  return ["provider_error", { kind: (e as PlatformError | null)?.kind ?? "other" }];
}

/** The request checks of an indexed job: its claim, then the source rule before every request and at dispatch. */
const fenced = (fence: ReturnType<typeof sourceFence>, keep: () => Promise<void>) =>
  ({ beforeRequest: async () => { await keep(); await fence.beforeRequest(); }, beforeDispatch: fence.beforeDispatch });
/** The first wait of a held record; each repeat doubles it up to the cap. */
export const HOLD_WAIT_CAP_SEC = 1800;
/** From this many waits in a row the stage's reason says the record has waited long (`index_held_long`). */
export const HOLD_LONG_AFTER = 6;
export const HOLD_CODE = "handoff: a class move of the record is in progress";
/** The stage waits for the first look at an embedder's vector source (unfollowedAfterLook). */
export const SOURCE_NOT_FOLLOWED_CODE = "index_wait:embedder_source_not_followed";
export const HOLD_LONG_CODE = "index_held_long: the record has waited long for a class move";
const HOLD_TAIL = /^(?:handoff|index_held_long):.*\(wait (\d{1,6}), since (\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\)$/;

/**
 * The wait of an indexed stage whose record may not go to a model now: MOVE_WAIT_SEC, doubled per repeat (the
 * count and the first moment ride in the stage's reason, `(wait N, since T)`), at most HOLD_WAIT_CAP_SEC; from
 * HOLD_LONG_AFTER waits the reason is `index_held_long:` — the record card and «Unprocessed» show it (admin
 * stage-errors.ts) — and the worker logs `index_source_held_long` once. No attempt is spent (StageWait).
 */
export function holdWait(prev: string | null | undefined, now = Date.now()): StageWait {
  const m = typeof prev === "string" ? HOLD_TAIL.exec(prev) : null;
  const n = m ? Number(m[1]) : 0, since = m ? m[2]! : new Date(now).toISOString();
  const sec = Math.min(MOVE_WAIT_SEC * 2 ** Math.min(n, 20), HOLD_WAIT_CAP_SEC);
  return new StageWait(new Date(now + sec * 1000), `${n + 1 >= HOLD_LONG_AFTER ? HOLD_LONG_CODE : HOLD_CODE} (wait ${n + 1}, since ${since})`);
}

/**
 * Nothing was sent: the record left this class, or a class move of it (or of a record above it) is in flight — the stage
 * waits for the move, backing off (holdWait); the fence could not read its rows for a lock (55P03, 40P01) or a
 * statement time-out of the walk of a long chain while a move is in flight (57014, SOURCE_WAIT_CODES) — it
 * waits like a busy chunk write. Any other database fault of the fence (a lasting fault — the control database down,
 * a permission) spends an attempt and ends as a visible failure `index_source_check_failed`, its code logged. None of
 * them counts against the model.
 */
function sourceHold(claim: StageClaim | undefined, recordId: string): (e: unknown) => never {
  return (e) => {
    if (e instanceof SourceChanged) {
      const w = holdWait(claim?.lastError);
      if (w.code.startsWith("index_held_long:") && !claim?.lastError?.startsWith("index_held_long:")) log.warn("index_source_held_long", { record_id: recordId, code: w.code });
      throw w;
    }
    if (e instanceof SourceLocked) {
      // the fence reads the record's rows `FOR SHARE` (embed-source.ts) — the wait is named for the record
      if (SOURCE_WAIT_CODES.has(e.code ?? "")) { log.info("index_source_locked", { record_id: recordId, code: e.code }); throw new StageWait(new Date(Date.now() + INDEX_BUSY_WAIT_MS), RECORD_BUSY_CODE); }
      log.warn("index_source_check_failed", { record_id: recordId, code: e.code ?? null });
      // typed — `last_error` is `index_source_check_failed: …`, the panel shows its wording
      throw new StageFault("index_source_check_failed", `the source rule of the record could not be read (${e.code ?? "no code"})`);
    }
    throw e;
  };
}

/**
 * Vectors of one embedder for the chunks `ids`, in slices of VECTOR_INSERT_ROWS; a stored vector is replaced. Each
 * carries `source` — the source of the embedder that computed it (search and the backfill read it).
 */
async function insertVectors(c: Pick<pg.PoolClient, "query">, ids: readonly string[], vsql: ReturnType<typeof embedderSql>, vectors: readonly number[][], hashes: readonly (Buffer | null)[], source: string): Promise<void> {
  if (!source) throw new Error("vector_source_missing");
  for (let i = 0; i < ids.length; i += VECTOR_INSERT_ROWS)
    await c.query(
      `INSERT INTO chunk_embeddings (chunk_id, embedder_id, embedding, input_hash, source) SELECT u.id, $2::text, u.v::${vsql.cast}, ($4::bytea[])[u.n::int], $5::text FROM unnest($1::uuid[], $3::text[]) WITH ORDINALITY AS u(id, v, n)
       ON CONFLICT (chunk_id, embedder_id) DO UPDATE SET embedding = EXCLUDED.embedding, input_hash = EXCLUDED.input_hash, source = EXCLUDED.source`,
      [ids.slice(i, i + VECTOR_INSERT_ROWS), vsql.ref.id, vectors.slice(i, i + VECTOR_INSERT_ROWS).map((v) => `[${v.join(",")}]`), hashes.slice(i, i + VECTOR_INSERT_ROWS), source]);
}

/** Only missing hashes are sent; the facade still enforces policy at every actual send. */
async function reuseDocuments(embedder: Extract<ReturnType<typeof embedderFor>, { state: "ready" }>["embedder"], inputs: string[], hashes: Buffer[], reuse: Reuse,
    opts: Parameters<typeof embedder.embedDocuments>[1] & Required<Pick<Parameters<typeof embedder.embedDocuments>[1], "beforeDispatch">>) {
  if (!embedder.allows(opts.dataClass)) return embedder.embedDocuments(inputs, opts);
  const vectors = hashes.map((hash) => reuse.get(reuseKey(embedder.embedderId, hash)));
  const missing = inputs.filter((_, i) => !vectors[i]);
  const out = missing.length ? await embedder.embedDocuments(missing, opts) : { ok: true as const, embedderId: embedder.embedderId, vectors: [], tokens: 0, tokensEstimated: false, truncated: 0 };
  if (!out.ok) return out;
  let next = 0;
  // the facade's `cut` counts the missing inputs only: map it back to the indexes of `inputs`
  const at = vectors.flatMap((v, i) => v ? [] : [i]);
  return { ...out, vectors: vectors.map((v) => v ?? out.vectors[next++]!), cut: (out.cut ?? []).map((k) => at[k]!) };
}

/**
 * Best-effort batching before children are scheduled. Stages and chunks are never changed. Before writing, lock the
 * record and its still-pending, unclaimed indexed stage and recheck the preliminary chunk: a worker that claimed or
 * replaced it while the model answered wins. These row locks exclude stage capture until the INSERT commits.
 */
export async function warmDerived(ctx: Ctx, cls: DataClass, parentId: string, o: { deadlineMs?: number } = {}): Promise<void> {
  // one deadline for the whole warm-up (it runs inside the stage dispatcher's loop): a slow or busy provider
  // ends it — a log line — and the children index themselves
  const deadline = AbortSignal.timeout(o.deadlineMs ?? WARM_UP_DEADLINE_MS);
  try {
    const db = recordsDb(ctx, cls);
    const rows = (await db.query(
      `SELECT r.id, r.title, r.type, r.occurred_at, c.id AS chunk_id, c.text AS chunk_text, rc.text
         FROM records r JOIN record_stages s ON s.record_id = r.id AND s.stage = 'indexed' AND s.status = 'pending' AND s.claim_token IS NULL
         JOIN record_content rc ON rc.record_id = r.id JOIN chunks c ON c.record_id = r.id AND c.ordinal = 0
        WHERE r.parent_id = $1 AND r.class = $2 AND r.is_current AND r.deleted_at IS NULL AND r.hidden_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM chunks x WHERE x.record_id = r.id AND x.id <> c.id) ORDER BY r.id`, [parentId, cls])).rows;
    // a move of the meeting (or of a child) in flight, or a child the locator puts elsewhere — not warmed
    const held = await heldBack(ctx, db, cls, rows.map((r) => r.id as string));
    const planned = rows.filter((r) => !held.has(r.id)).flatMap((r) => {
      const p = planIndex(ctx.settings, r, r.text);
      return p.chunks.length === 1 && p.chunks[0]!.text === r.chunk_text ? [{ ...r, input: p.inputs[0]! }] : [];
    });
    if (!planned.length) return;
    const targets = await writeTargets(ctx, parentId);
    targets: for (const row of targets) {
      const st = embedderFor({ platform: ctx.platform, settings: ctx.settings }, row);
      if (st.state === "off" || !st.embedder.allows(cls)) continue;
      // no warm vector for a row whose source has not been looked at — the children index themselves
      if ((await unfollowedAfterLook(ctx, [row.id])).size) { log.info("derived_warm_source_not_followed", { record_id: parentId, embedder: row.id }); continue; }
      const sql = embedderSql(row);
      // Candidate indexes belong to registration; a missing one with stored vectors remains a backfill stop. The active
      // row's index is not made here (outside the deadline) — without it the row is not warmed, the children
      // index themselves and indexRecord makes it
      if (row.active && !(await embeddingIndexReady(db, row.id))) {
        // made here only while the row has no vector in this database (an empty predicate: seconds, as the backfill does)
        if ((await db.query("SELECT EXISTS (SELECT 1 FROM chunk_embeddings WHERE embedder_id = $1) AS ok", [row.id])).rows[0]?.ok === true) {
          log.info("derived_warm_no_index", { record_id: parentId, embedder: row.id });
          continue;
        }
        await ensureEmbeddingIndex(db, sql.ref);
      }
      const reuse: Reuse = new Map();
      for (const r of (await db.query("SELECT embedder_id, input_hash, embedding::text AS embedding FROM chunk_embeddings WHERE chunk_id = ANY($1::uuid[]) AND embedder_id = $2 AND input_hash IS NOT NULL", [planned.map(p => p.chunk_id), row.id])).rows)
        reuse.set(reuseKey(r.embedder_id, r.input_hash), JSON.parse(r.embedding));
      const badResponse = () => log.warn("derived_warm_bad_response", { record_id: parentId, embedder: row.id });
      const warmed = new Map<string, number[]>(), warmedCut = new Set<string>();
      // the hash of each input under the source of this embedder
      const hashOf = new Map(planned.map((p) => [p.chunk_id, inputHash(p.input, st.embedder.source)]));
      const batch = Math.max(1, Math.floor(st.embedder.profile.ops.batch_size) || 1);
      for (let start = 0; start < planned.length; start += batch) {
        let part = planned.slice(start, start + batch);
        while (part.length) {
          // Unlike an indexed job, warm-up holds no stage claim. Every input's source is checked before each send, including
          // retries and rejected-input fallbacks, and again at dispatch under a shared row lock (embed-source.ts): the
          // UPDATE that hides a closing tree waits until the bytes were handed over. Only still pending, unclaimed stages.
          const fence = sourceFence(ctx, cls, () => part.map(p => p.id),
            { join: "JOIN record_stages s ON s.record_id = r.id AND s.stage = 'indexed'", extra: "s.status = 'pending' AND s.claim_token IS NULL" });
          try {
            const out = await reuseDocuments(st.embedder, part.map(p => p.input), part.map(p => hashOf.get(p.chunk_id)!), reuse,
              { dataClass: cls, stage: "indexed", ref: parentId, signal: deadline, beforeRequest: fence.beforeRequest, beforeDispatch: fence.beforeDispatch });
            if (!out.ok) continue targets;
            if (out.embedderId !== row.id || out.vectors.length !== part.length || out.vectors.some(v => !validVector(v, sql.ref.dims))) {
              badResponse();
              continue targets;
            }
            part.forEach((p, i) => warmed.set(p.chunk_id, out.vectors[i]!));
            for (const k of out.cut ?? []) warmedCut.add(part[k]!.chunk_id);
            break;
          } catch (e) {
            if ((e as PlatformError)?.kind === "bad_response") { badResponse(); continue targets; }
            if (!(e instanceof SourceChanged)) throw e;
            // Rebuild the request with only surviving inputs; never resend a moved record with the old class label.
            const live = new Set(e.live), before = part.length;
            part = part.filter(p => live.has(p.id));
            if (part.length === before) continue targets;                 // nothing dropped: never loop on the same request
          }
        }
      }
      await tx(db, async (c) => {
        await c.query("SET LOCAL lock_timeout = '1s'");
        const ids: string[] = [], hashes: (Buffer | null)[] = [], vectors: number[][] = [];
        for (let i = 0; i < planned.length; i++) {
          const p = planned[i]!;
          const vector = warmed.get(p.chunk_id);
          if (!vector) continue;
          const live = (await c.query(
            `SELECT r.id FROM records r JOIN record_stages s ON s.record_id = r.id AND s.stage = 'indexed'
              JOIN chunks ch ON ch.record_id = r.id AND ch.id = $2 JOIN record_content rc ON rc.record_id = r.id
             WHERE r.id = $1 AND r.is_current AND r.deleted_at IS NULL AND r.hidden_at IS NULL
               AND r.title IS NOT DISTINCT FROM $3 AND r.occurred_at = $4 AND r.type = $5 AND rc.text = $6 AND ch.text = $7
               AND s.status = 'pending' AND s.claim_token IS NULL FOR UPDATE OF r, s, ch, rc`,
            [p.id, p.chunk_id, p.title, p.occurred_at, p.type, p.text, p.chunk_text])).rowCount;
          if (live) { ids.push(p.chunk_id); hashes.push(warmedCut.has(p.chunk_id) ? null : hashOf.get(p.chunk_id)!); vectors.push(vector); }
        }
        await insertVectors(c, ids, sql, vectors, hashes, st.embedder.source);
      });
    }
  } catch (e) {
    log.warn("derived_warm_failed", { record_id: parentId, kind: (e as PlatformError)?.kind ?? "other" });
  }
}

/**
 * The candidate's vectors of a record (the dual write), or null: a row the SQL rule refuses, no usable connection,
 * a refusal of the policy, the budget, any failure of its provider or a broken answer — one log line
 * `index_candidate_left`, nothing stored, the stage goes on; the backfill sweep adds the missing vectors. A lost claim
 * is not the candidate's failure: it ends the stage as everywhere. Its index is never made here (it is made at
 * registration; one missing with vectors stored is a stop of the backfill, not something indexing repairs).
 */
async function candidateVectors(job: StageJob, row: EmbedderRow, st: ReturnType<typeof embedderFor>, inputs: string[], hashes: Buffer[], reuse: Reuse, keep: () => Promise<void>, recordId: string,
    fence: ReturnType<typeof sourceFence>, onVectors?: (n: number) => void):
    Promise<{ sql: ReturnType<typeof embedderSql>; vectors: number[][]; cut: ReadonlySet<number> } | null> {
  const left = (why: string) => { log.info("index_candidate_left", { record_id: recordId, embedder: row.id, why }); return null; };
  let sql: ReturnType<typeof embedderSql>;
  try { sql = embedderSql(row); } catch { return left("ref_invalid"); }
  if (st.state === "off") return left(st.reason);
  try {
    const out = await reuseDocuments(st.embedder, inputs, hashes, reuse, { dataClass: job.class, stage: "indexed", ...fenced(fence, keep), ref: recordId, onVectors });
    if (!out.ok) return left(out.stop);
    if (out.embedderId !== sql.ref.id || out.vectors.length !== inputs.length || out.vectors.some((v) => !validVector(v, sql.ref.dims)))
      return left("bad_response");
    return { sql, vectors: out.vectors, cut: new Set(out.cut ?? []) };
  } catch (e) {
    if (e instanceof StageClaimLost) throw e;
    if (e instanceof SourceChanged) return left("source_changed");
    if (e instanceof SourceLocked) { log.info("index_candidate_left", { record_id: recordId, embedder: row.id, why: "source_locked", code: e.code ?? null }); return null; }
    return left((e as PlatformError)?.kind ?? "other");
  }
}

/**
 * The text the embedder gets for one chunk: the context header — title · type · date · locator (minute:second
 * of a transcript, the section, or the page) — and the chunk's text. Indexing and the backfill job build the
 * input with this one function, from the chunk being written or from the stored chunk row, so a backfilled vector is the
 * vector indexing would have stored (never a re-chunk).
 */
export function chunkInput(rec: { title: string | null; type: string; occurred_at: Date | string }, chunk: { text: string; timeFromSec: number | null; sectionPath: string | null; pageFrom: number | null }): string {
  const c = chunk;
  const locator = c.timeFromSec !== null ? `${Math.floor(c.timeFromSec / 60)}:${String(c.timeFromSec % 60).padStart(2, "0")}` : c.sectionPath ?? (c.pageFrom !== null ? `p. ${c.pageFrom}` : null);
  return embeddingInput(rec.title ?? "", TYPE_LABEL[rec.type] ?? rec.type, dateLabel(rec.occurred_at as Date), locator, c.text);
}

/**
 * The first served name the embedder computed vectors with — maintenance_state embedder_alias:<id>. It is written once
 * and never changes: after a model change the old vectors stay, and health (the embedder_model check) shows
 * that search by meaning is degraded until the name is back or a new embedder version is rebuilt. A failed write does
 * not fail the stage: the vectors are saved, and the next indexed document repeats the write.
 */
export async function rememberEmbedderModel(ctx: Pick<Ctx, "db" | "instanceId">, embedderId: string, model: string): Promise<void> {
  await ctx.db.control.query(
    `INSERT INTO maintenance_state (instance_id, key, value, updated_at) VALUES ($1, $2, $3::jsonb, now()) ON CONFLICT (instance_id, key) DO NOTHING`,
    [ctx.instanceId, `embedder_alias:${embedderId}`, JSON.stringify({ model, at: new Date().toISOString() })])
    .catch((e) => log.warn("embedder_alias_save_failed", { embedder: embedderId, error: (e as Error).message.slice(0, 120) }));
}
