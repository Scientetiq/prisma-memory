// memory_search: for each class, three candidate lists in parallel — full text (applied configurations + simple),
// title matches, vector — → RRF (retrieval.tuning) over chunks → the best chunk represents the record → class merge →
// the reranker of the top N with the limit "at most search.max_per_parent records of one root" → boosts → the final rights
// check against live tables. Portability rules: the index is derived and may lag; all SQL with vector
// operators — only in the PgvectorIndex adapter; rights — in the gateway, the index gets only coarse filters (spaces,
// a record list, type, event kind, topics, period) and a check that the chunk's record is alive (prefilterWhere).
import { commitOrThrow } from "@memory/shared";   // a COMMIT answered with ROLLBACK is an error
import type pg from "pg";
import { nullVectorsCount, readRebuildProgress, sourceRebuilding, vectorSourceKey, type VectorSourceState } from "@memory/shared";
import { ARCHIVE_INCLUDE, binder, directQuery, embedderFor, embedderSql, gateSql, instanceTz, invalid, isUuid, newId, parseDateBound, parseEntityKey, PlatformError, prefilterOwner, prefilterSql, projectEntityId,
         recordPath, log, rerankFallbackNote, reversedRange, upperBoundOp, visibleRow, visibleSql, type ArchiveFilter, type DataClass, type DateBound, type EmbedderRef, type EmbedderRow, type PrefilterOwner } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { queryVectorCache } from "./query-vector-cache.ts";
import { rerankFence, RerankSourceHeld, RerankSourceUnchecked } from "./rerank-fence.ts";
import { archivedSpaceIds, readableSpaces, resolveSpace, type RecordRow, type SpaceAccess } from "./access.ts";
import { factsFor, listingSpec } from "./visibility.ts";
import { confidenceOf, entityReadableById, entityUuid, personIdByLogin } from "./records.ts";
import { extendedWriteView } from "./extended-open.ts";
import { ftsSql, ftsTermsSql, ftsTitleSql, originOf, RANK_NORM, snippetOf, snippetWindowOf, snippetWords } from "@memory/mcp-core";

// the hit snippet — @memory/mcp-core (shared with the edge); the old import address stays for the tests
export { snippetOf };

/** An unknown login or entity in a filter: an id that matches nothing — an empty answer without disclosure. */
const NIL = "00000000-0000-0000-0000-000000000000";
import { auditRead, auditShownClosed } from "./audit.ts";
import { signedOriginalUrl } from "./originals.ts";
import { workplaceWhere } from "./workplace.ts";
import { openByWordCaller } from "./owner.ts";
import { isExternal } from "./channel.ts";
import { applyDerivationOrder, clampBoost, finalScores, fuseCandidates, rerankPool, rrfTieStep, type RankingOptions } from "./ranking.ts";
import { emptyTrace, since, traceList, type ClassTrace, type SearchOptions, type TraceHnsw } from "./search-trace.ts";
import { confirmedOf, heldIds, orgSpace, orgUnitsOf, reviewView, seesHeld } from "./org-hold.ts";
import { declaredRetelling, derivationFactor, DERIVATION_FACTOR_DEFAULT, DERIVATION_FACTOR_SETTING, DERIVATION_ORDER_SETTING, orgReviewEnabled, unreviewedFactor,
         type OrgReviewView } from "@memory/shared";
import { PGVECTOR_MAX_SCAN_TUPLES_DEFAULT, RETRIEVAL_TUNING_DEFAULT, retrievalTuning, type RetrievalTuning } from "@memory/shared";
import { appliedFtsCached, queryFtsConfigs } from "@memory/shared";
import { derivationFor, derivationOut, DERIVATION_SOURCES_OP, echoesWithVisibleSource, type DerivationFound } from "./derivation.ts";

export interface SearchArgs {
  query?: string; mode?: "hybrid" | "keyword" | "semantic" | "recent"; limit?: number; exclude_ids?: string[]; snippet_tokens?: number; current_space?: string;
  filters?: { space?: string; types?: string[]; event_kinds?: string[]; entity?: string; person?: string; from?: string; to?: string; domains?: string[]; archived?: boolean };
}

interface Candidate { chunk_id: string; record_id: string; text: string; ordinal: number; section_path: string | null; page_from: number | null; page_to: number | null; time_from_sec: number | null; time_to_sec: number | null }
/** The coarse index filter: spaces (+ records placed in them), direct grants (the people list and the author branch — the
 * visibility builder), type, event kind, topics, period, an explicit list. The `to` bound has a strictness flag: a whole day by
 * the memory time zone — "before midnight of the next day". */
export interface Prefilter { spaceIds: string[]; placedRecordIds: string[]; directRecordIds: string[]; owner: PrefilterOwner | null; types?: string[]; eventKinds?: string[]; domains?: string[];
                             from?: Date; to?: DateBound; onlyRecordIds?: string[]; excludeIds: string[] }

// The candidate counts, the RRF constant and the channel weights are retrieval.tuning (@memory/shared).
// The mode recent has no fusion: its candidates are the freshest records, scored by the former 1 / (60 + rank).
const RECENT_CANDIDATES = 400, RECENT_RANK_K = 60;

/**
 * The prefilter condition for alias t: chunks (c, record_id) or records (r, id). All filters stand before ORDER BY … LIMIT
 * of the candidates: otherwise fresher or more similar rows that the final check drops anyway
 * would take places, and the answer "nothing found" would be untrue. A chunk carries only the record's space, area, type and
 * time, so for c a live record check by primary key is added: one deleted to the trash (chunks
 * stay until the purge — the restore needs them), an unfinished version and a class move row do not become candidates;
 * event kind and topics are checked there too. The final rights check against live tables stays as it was.
 */
export function prefilterWhere(f: Prefilter, args: unknown[], t: "c" | "r"): string {
  const p = binder(args);
  const rid = t === "c" ? "c.record_id" : "r.id";
  // direct grants (directRecordIds) — for any area: a meeting moved into a space — to its participants
  const parts = [prefilterSql({ spaceIds: f.spaceIds, placed: f.placedRecordIds, direct: f.directRecordIds, owner: f.owner }, p, t)];
  if (f.types?.length) parts.push(`${t}.type = ANY(${p(f.types)}::record_type[])`);
  if (f.from) parts.push(`${t}.occurred_at >= ${p(f.from)}`);
  if (f.to) parts.push(`${t}.occurred_at ${upperBoundOp(f.to)} ${p(f.to.at)}`);
  if (f.onlyRecordIds) parts.push(`${rid} = ANY(${p(f.onlyRecordIds)}::uuid[])`);
  if (f.excludeIds.length) parts.push(`${rid} <> ALL(${p(f.excludeIds)}::uuid[])`);
  const a = t === "c" ? "lr" : "r", rec: string[] = [];
  if (f.eventKinds?.length) rec.push(`${a}.event_kind = ANY(${p(f.eventKinds)}::event_kind[])`);
  if (f.domains?.length) rec.push(`${a}.domain_tags && ${p(f.domains)}::text[]`);
  if (t === "r") parts.push(...rec);
  else parts.push(`EXISTS (SELECT 1 FROM records_live lr WHERE lr.id = c.record_id${rec.map((x) => ` AND ${x}`).join("")})`);
  return parts.join(" AND ");
}

/** Candidates of the recent mode ("new"): the freshest live records that already passed all filter conditions. */
export function recentCandidatesSql(f: Prefilter, args: unknown[]): string {
  return `SELECT r.id FROM records_live r WHERE ${prefilterWhere(f, args, "r")} ORDER BY r.occurred_at DESC LIMIT ${RECENT_CANDIDATES}`;
}

// Full-text queries (ftsSql, ftsTitleSql) and the rank normalization RANK_NORM — in @memory/mcp-core (search-sql.ts): the edge
// ranks with the same expressions. The configurations are the applied ones of the class database (from
// retrieval_config, read through a 30 s cache), never the setting — a query always matches how the index was built.

// HNSW parameters and the statement timeout of the vector query — retrieval.tuning: ef_search 100 with the
// iterative scan; without it (pgvector 0.7) the rights filter applies AFTER the index, which returns at most ef_search
// chunks — at 100 with LIMIT 150 the answer thinned out before the filter, so 400 (pgvector's ceiling is 1000). The
// timeout (3000 ms): while an index is being built, or when the table is busy, the vector part must not hold the
// answer — the search goes on by keyword with a note.
/** Notes of a vector query that failed or timed out: hybrid keeps the keyword and title candidates. */
/**
 * The note of a reranker the data policy refused (T1 gate) and of a pool holding a record that may not
 * go to a model now (a class move in flight) is ONE text with no cause, so a caller cannot tell a class move of a record
 * from the gate (the record or the one above it may be one he cannot read). The operator tells them apart by the trace and
 * the audit value (`rerankFailureOf`).
 */
export const RERANK_SKIPPED_NOTE = "Reranker not called: order by RRF";
/** The fence could not read its rows (a database error) — the reranker itself was never asked. */
export const RERANK_UNCHECKED_NOTE = "Reranker not called: an internal check before the call failed — order by RRF; search again later for the reranked order";
/** The trace and audit value of a refusal because a record of the pool is held; not `policy_denied`. */
export const RERANK_RECORD_HELD = "record_held";
/** What `trace.rerank_failed` and the audit's `details.rerank_failed` say of a failed rerank call. */
export function rerankFailureOf(e: unknown): string {
  return e instanceof RerankSourceHeld ? RERANK_RECORD_HELD : (e as PlatformError | null)?.kind ?? "error";
}

export const VECTOR_FAILED_NOTE_HYBRID = "Vector part not fully used: the vector query failed or timed out — some results are keyword-only";
export const VECTOR_FAILED_NOTE_SEMANTIC = "Semantic search is unavailable right now: the vector query failed or timed out — use mode = keyword or hybrid";
/** Whether pgvector supports the iterative scan; false is remembered per process after the first refusal (see tuneHnsw). */
export const hnswSupport = { iterativeScan: true };

/**
 * HNSW tuning for the vector search transaction. `hnsw.iterative_scan` exists only in pgvector ≥ 0.8;
 * in 0.7, after the library loads, the `hnsw` prefix is reserved, a SET of an unknown parameter fails and breaks
 * the transaction. The old `.catch(() => undefined)` swallowed the error, the next SELECT got "current transaction is aborted" —
 * memory_search answered Internal error on every call except the first on a connection. So SET runs inside a save
 * point: a refusal rolls back to it and the transaction lives on. It is remembered per process (the extension version does not
 * change without a restart), so as not to pour errors into the Postgres log on every search; ef_search is raised instead.
 * Part of the PgvectorIndex adapter; a separate function — for the unit test.
 */
export async function tuneHnsw(c: Pick<pg.PoolClient, "query">, support = hnswSupport,
                               t: Pick<RetrievalTuning, "ef_search" | "ef_search_no_iterative" | "max_scan_tuples"> = RETRIEVAL_TUNING_DEFAULT): Promise<TraceHnsw> {
  // the values are checked numbers of retrieval.tuning (retrievalTuning); Math.floor keeps the SQL text an integer anyway
  const ef = Math.floor(t.ef_search), efNoIterative = Math.floor(t.ef_search_no_iterative);
  if (support.iterativeScan) {
    await c.query("SAVEPOINT hnsw_tune");
    try {
      await c.query("SET LOCAL hnsw.iterative_scan = relaxed_order");      // pgvector ≥ 0.8: the filter does not thin the answer
      await c.query("RELEASE SAVEPOINT hnsw_tune");
      await c.query(`SET LOCAL hnsw.ef_search = ${ef}`);
      // pgvector's own default is not sent: a default install sends exactly the statements it sent before
      const scan = Math.floor(t.max_scan_tuples) === PGVECTOR_MAX_SCAN_TUPLES_DEFAULT ? null : Math.floor(t.max_scan_tuples);
      if (scan !== null) await c.query(`SET LOCAL hnsw.max_scan_tuples = ${scan}`);
      return { iterative_scan: true, ef_search: ef, max_scan_tuples: scan };
    } catch (e) {
      await c.query("ROLLBACK TO SAVEPOINT hnsw_tune");                     // rollback failed — broken connection: the error goes up, the refusal is not kept
      support.iterativeScan = false;
      log.warn("pgvector_no_iterative_scan", { error: (e as Error).message.slice(0, 200), ef_search: efNoIterative });
    }
  }
  await c.query(`SET LOCAL hnsw.ef_search = ${efNoIterative}`);
  return { iterative_scan: false, ef_search: efNoIterative, max_scan_tuples: null };
}

/** The index adapter: the only place where full-text and vector SQL lives. Exported for the Postgres test. */
export class PgvectorIndex {
  /** HNSW parameters of the last vector query of this adapter (the search trace). */
  lastHnsw: TraceHnsw | null = null;
  /** `tuning` — retrieval.tuning of the search (defaults when absent); `vectorTimeoutMs` overrides its timeout (tests). */
  constructor(private readonly db: pg.Pool, private readonly opts: { vectorTimeoutMs?: number; tuning?: RetrievalTuning } = {}) {}

  private static readonly COLS = "c.id AS chunk_id, c.record_id, c.text, c.ordinal, c.section_path, c.page_from, c.page_to, c.time_from_sec, c.time_to_sec";

  /** The text search configurations the queries of this database are built with. */
  async ftsConfigs(): Promise<string[]> {
    return queryFtsConfigs(await appliedFtsCached(this.db));
  }

  async keyword(query: string, f: Prefilter, k: number): Promise<Candidate[]> {
    const args: unknown[] = [query];
    const where = prefilterWhere(f, args, "c");
    const { rows } = await this.db.query(
      `WITH ${ftsSql(await this.ftsConfigs())}
       SELECT ${PgvectorIndex.COLS}
       FROM chunks c, q
       WHERE ((q.fts IS NOT NULL AND c.tsv @@ q.fts) OR (q.raw IS NOT NULL AND c.raw_terms @@ q.raw)) AND ${where}
       ORDER BY COALESCE(ts_rank_cd(c.tsv, q.fts, ${RANK_NORM}), 0) + COALESCE(ts_rank_cd(c.raw_terms, q.raw, ${RANK_NORM}), 0) DESC, c.occurred_at DESC LIMIT ${k}`, args);
    return rows;
  }

  /**
   * The query words that are not stop words of the applied configurations: the snippet window is placed by them.
   * `words` — the query split as snippetOf splits it.
   */
  async snippetTerms(words: readonly string[]): Promise<string[]> {
    if (!words.length) return [];
    const { rows } = await this.db.query(ftsTermsSql(await this.ftsConfigs()), [words]);
    return (rows[0]?.terms ?? []) as string[];
  }

  /**
   * Record title matches. The reference chunker drops the converter header, so the title does not get into the chunks' full text
   * — without this list a document would not be found by a word of its own title (the title takes part
   * in ranking). Searched by GIN indexes on to_tsvector(title) expressions (06-embedder-platform.sql). The candidate is the first
   * chunk of the record; a record without chunks (not indexed yet, the embedder refused) represents itself: chunk_id = id,
   * text — the description line or the title, no locator.
   */
  async title(query: string, f: Prefilter, k: number): Promise<Candidate[]> {
    const args: unknown[] = [query];
    const where = prefilterWhere(f, args, "r");
    const cfgs = await this.ftsConfigs(), t = ftsTitleSql(cfgs);
    const { rows } = await this.db.query(
      `WITH ${ftsSql(cfgs)}
       SELECT COALESCE(c.id, r.id) AS chunk_id, r.id AS record_id, COALESCE(c.text, r.summary_line, r.title, '') AS text, COALESCE(c.ordinal, 0) AS ordinal,
              c.section_path, c.page_from, c.page_to, c.time_from_sec, c.time_to_sec
       FROM records_live r LEFT JOIN chunks c ON c.record_id = r.id AND c.ordinal = 0, q
       WHERE r.title IS NOT NULL AND ((q.fts IS NOT NULL AND ${t.match}) OR (q.raw IS NOT NULL AND to_tsvector('simple', r.title) @@ q.raw)) AND ${where}
       ORDER BY ${t.rank} + COALESCE(ts_rank_cd(to_tsvector('simple', r.title), q.raw, ${RANK_NORM}), 0) DESC, r.occurred_at DESC LIMIT ${k}`, args);
    return rows;
  }

  /**
   * The vector query: the column has no fixed dimension, so the order is by the expression of the embedder's
   * index, (embedding::halfvec(N)), and the id is a literal — the planner proves the partial index predicate only from
   * the value itself. On a column that still has a fixed dimension of the same N the cast folds to the plain column and
   * the earlier plain index is used. The rights prefilter stays before ORDER BY … LIMIT. $1 is the query vector.
   */
  static semanticSql(e: EmbedderRef, where: string, k: number): string {
    const { idLiteral, cast } = embedderSql(e);
    return `SELECT ${PgvectorIndex.COLS} FROM chunk_embeddings e JOIN chunks c ON c.id = e.chunk_id
         WHERE e.embedder_id = ${idLiteral} AND ${where} ORDER BY (e.embedding::${cast}) <=> $1::${cast} LIMIT ${Math.floor(k)}`;
  }

  /**
   * `src` — the source of the query's embedder: only vectors computed with it are searched; one of another
   * source (stored before an address, model, space or generation change, until the backfill recomputes it) is left out,
   * and its chunk is found by keyword meanwhile. A vector without a source (stored before sources existed) counts while `legacy`.
   */
  async semantic(vector: number[], embedder: EmbedderRef, f: Prefilter, k: number, src: VectorSourceView): Promise<Candidate[]> {
    if (!src?.source) throw new Error("vector_source_missing");
    const args: unknown[] = [`[${vector.join(",")}]`];
    const pre = prefilterWhere(f, args, "c");
    args.push(src.source, src.legacy === true);
    const where = `${pre} AND (e.source = $${args.length - 1}::text OR (e.source IS NULL AND $${args.length}::boolean))`;
    const sql = PgvectorIndex.semanticSql(embedder, where, k);           // refuses a bad registry row before any SQL
    const tuning = this.opts.tuning ?? RETRIEVAL_TUNING_DEFAULT;
    const timeoutMs = Math.max(1, Math.floor(this.opts.vectorTimeoutMs ?? tuning.vector_timeout_ms));
    const c = await this.db.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
      this.lastHnsw = await tuneHnsw(c, hnswSupport, tuning);
      const { rows } = await c.query(sql, args);
      await commitOrThrow(c);
      return rows;
    } catch (e) { await c.query("ROLLBACK").catch(() => undefined); throw e; } finally { c.release(); }
  }
}

function locatorOf(rec: RecordRow, c: Candidate | null): Record<string, unknown> | null {
  if (rec.locator && Object.keys(rec.locator).length) return rec.locator;
  if (!c) return null;
  if (c.time_from_sec !== null) return { time_from: c.time_from_sec, ...(c.time_to_sec !== null ? { time_to: c.time_to_sec } : {}) };
  const loc: Record<string, unknown> = {};
  if (c.page_from !== null) { loc.page = c.page_from; if (c.page_to !== null && c.page_to !== c.page_from) loc.page_to = c.page_to; }
  if (c.section_path) loc.section = c.section_path;
  return Object.keys(loc).length ? loc : null;
}

interface Scored { rec: RecordRow; cand: Candidate | null; cls: DataClass; rrf: number; score: number; inCurrent?: boolean; orgFactor?: number; confirmed?: boolean; org?: string | null;
                  derivationFactor?: number }

/**
 * `details` of the `search` event: `limit` — how many hits were asked; `excluded` — how many records were
 * excluded by `exclude_ids` (a number, without the ids: the workplace pages, and a hit's position in the whole answer is
 * `excluded + rank`); `rerank` — the order came from the reranker (`false` — not called or failed, including with one hit
 * and in keyword/recent modes); `rerank_failed` — only on a reranker refusal: the platform error kind; `record_held` — a pool record
 * held by the record rule, otherwise `error`.
 */
export function searchAuditDetails(o: { mode: string; limit: number; excludeIds?: readonly string[]; reranked: boolean; rerankError?: unknown; currentSpace?: string | null; currentSpaceHits?: number;
                                         archive?: "exclude" | "include"; held?: number }): Record<string, unknown> {
  return {
    tool: "memory_search", mode: o.mode, limit: o.limit, excluded: new Set(o.excludeIds ?? []).size, rerank: o.reranked,
    // hidden by the "Wrong / not for everyone" hold: apart from excluded — these are not rights and not exclude_ids
    ...(o.held ? { held: o.held } : {}),
    // the archive mode of the answer: exclude — by default, include — filters.archived or filters.space on an archived one
    ...(o.archive ? { archive: o.archive } : {}),
    ...(o.currentSpace === undefined ? {} : o.currentSpace === null ? { current_space_ignored: true }
      : { current_space: o.currentSpace, current_space_hits: o.currentSpaceHits ?? 0 }),
    ...(o.rerankError === undefined ? {} : { rerank_failed: rerankFailureOf(o.rerankError) }),
  };
}

/**
 * The reranker call class (the alias gate): it gets both chunks and the query — the strictest of the query class (as for
 * the embedder: closed if the caller reads closed) and the pool chunk classes. Before, only the pool counted, and a closed
 * query with an open answer went to a model outside T0.
 */
export function rerankClassOf(queryClass: DataClass, pool: ReadonlyArray<{ cls: DataClass }>): DataClass {
  return queryClass === "closed" || pool.some((s) => s.cls === "closed") ? "closed" : "open";
}

/** Employee cards of $1 (their profile records) — for the per-person filter links; is_current and deletion now, rights later. */
const PROFILE_OF = "SELECT id FROM records WHERE type = 'profile' AND owner_id = $1 AND is_current AND deleted_at IS NULL";

/** The source of the query's embedder and whether vectors without a source count (workers embedders.ts vectorView). */
export type VectorSourceView = { source: string; legacy: boolean };
/**
 * The note of an answer while the semantic part is being rebuilt — the active row's vector source changed and
 * its vectors of the old source are not all recomputed: those chunks are found by keyword only (hybrid) or not at all
 * (semantic). MCP's memory_search and the panel's search page show the answer's notes.
 */
export const rebuildingNote = (mode: string, stale: number | null | undefined): string => {
  const n = typeof stale === "number" ? `${stale} chunks` : "some chunks";
  return mode === "semantic"
    ? `The semantic part is being rebuilt (the embeddings connection changed): ${n} whose vectors are not recomputed yet are not found by meaning — use mode = hybrid to find them by keyword`
    : `The semantic part is being rebuilt (the embeddings connection changed): ${n} are found by keyword only until their vectors are recomputed`;
};
/**
 * The NULL rule of a row's vectors: a vector stored before sources existed has no source; it counts as the
 * source the worker adopted for it — once, at its first sight, only for a row with no labelled vector and generation 0
 * (maintenance_state embedder_source:<id>, `adopted`; shared nullVectorsCount). No state, no adoption, or the
 * operator's word to recompute them (`recompute_for`) — it is stale: not searched (found by keyword).
 * No state yet (the worker has not looked at the row) — the answer says the semantic part is being rebuilt,
 * without a number; a word to recompute adopted vectors writes `changed_at` (worker withWord), so it says so too.
 */
async function sourceViewOf(app: Pick<App, "db" | "instanceId" | "settings">, id: string, source: string): Promise<VectorSourceView & { rebuilding: number | null | false }> {
  const v = (await app.db.control.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = $2", [app.instanceId, vectorSourceKey(id)])).rows[0]?.value as Partial<VectorSourceState> | undefined;
  // The source of the query is not the one the worker followed (the connection changed a moment ago): none of
  // the stored vectors is of it yet — the count is unknown; otherwise the progress row is read only while a change of
  // source is on record and its vectors are not all recomputed (a search pays one more read then)
  const rebuilding = typeof v?.print !== "string" || v.print !== source ? null
    : typeof v?.changed_at === "string" && v.stale !== 0
      && sourceRebuilding(id, v, await readRebuildProgress(app.db.control, app.instanceId, "embed")) ? (typeof v.stale === "number" ? v.stale : null) : false;
  return { source, legacy: nullVectorsCount(v, source, app.settings), rebuilding };
}

/** The model the worker remembered for a legacy embedder's vectors (maintenance_state embedder_alias:<id>), or null. */
async function legacyModelOf(app: Pick<App, "db" | "instanceId">, id: string): Promise<string | null> {
  const v = (await app.db.control.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = $2", [app.instanceId, `embedder_alias:${id}`])).rows[0]?.value as { model?: unknown } | undefined;
  return typeof v?.model === "string" && v.model ? v.model : null;
}

export async function search(app: App, caller: Caller, a: SearchArgs, opts: SearchOptions = {}) {
  const t0 = performance.now();
  const mode = a.mode ?? "hybrid", limit = Math.min(50, Math.max(1, a.limit ?? 10)), snippetTokens = Math.min(400, Math.max(40, a.snippet_tokens ?? 120));
  // the numbers of the search: a partial object keeps the other defaults (merge), a field out of range is its default
  const tuning = retrievalTuning(app.settings.get<unknown>("retrieval.tuning", RETRIEVAL_TUNING_DEFAULT));
  const trace = emptyTrace(mode, tuning);
  // the query — in NFC: texts and titles are stored in NFC, and a query copied from a file name
  // on a Mac comes in NFD and would otherwise split, like "café" into "cafe" + an accent
  const query = a.query?.trim().normalize("NFC");
  if (mode !== "recent" && !query) throw invalid("This mode needs a query; without a query use mode = recent");
  const f = a.filters ?? {};
  // a day — the whole day by the memory time zone, a date-time without a zone — in it too: not by the server's UTC
  const tz = instanceTz(app.settings);
  const fromB = f.from ? parseDateBound(f.from, "from", tz) : undefined, to = f.to ? parseDateBound(f.to, "to", tz) : undefined;
  if (fromB === null || to === null) throw invalid("Invalid date in the filter");
  if (fromB && to && reversedRange(fromB, to)) throw invalid("The date «to» is earlier than «from»");
  const from = fromB?.at;
  const notes: string[] = [];

  // Archive: S_all — readable with archived, S_act — current, A — archived with live records of the instance.
  // By default — exclude mode (S = S_act): a record seen only through an archive is not in the answer; filters.archived or
  // filters.space on an archived one — include (S = S_all). The core refuses if S ∩ A ≠ ∅ in exclude.
  const all = await readableSpaces(app, caller, { archived: true });
  const active = new Map([...all].filter(([, s]) => !s.archived_at));
  const A = new Set(await archivedSpaceIds(app));
  // The context is resolved by the full access map, not by filters.space; the candidate set is not widened.
  // An archived current_space — no boost and `current_space: null` (read only; to search it — filters.space). The hint
  // "in archive" — only to an archived one with live records (A: hints — by A ∩ S_all); an empty archive — as before
  // archives: "not found", the same answer as about a missing and an unreadable one
  const resolved = a.current_space === undefined ? undefined : await resolveSpace(app, caller, a.current_space, all);
  const archivedCurrent = resolved?.archived_at && A.has(resolved.id) ? resolved : null;
  const current = resolved?.archived_at ? null : resolved;
  const boost = current && mode !== "recent" ? clampBoost(app.settings.get("search.current_space_boost", 1.2)) : 1;
  const contextNotes: string[] = [];
  if (archivedCurrent) contextNotes.push(`Space ${archivedCurrent.slug} is archived — read only; to search it: filters.space: ${archivedCurrent.slug}`);
  else if (current === null) contextNotes.push(`current_space: space ${a.current_space} is not among the spaces you can read — ordered without it`);
  if (current && mode === "recent") contextNotes.push("current_space does not affect mode recent: for what is new in a project use filters.space");
  else if (current && boost === 1) contextNotes.push("current_space: the space priority is switched off by the setting search.current_space_boost = 1");
  // Old collisions of standalone project entities give no right to assign their links to a space.
  const currentEntity: string | undefined = current?.kind === "project" ? (await app.db.control.query(
    `SELECT id FROM entities WHERE id = $1 AND kind = 'project' AND external_system = 'memory'
       AND external_id = $2 AND attrs->>'space_id' = $3 AND instance_id = $4`,
    [projectEntityId(current.slug), current.slug, current.id, app.instanceId])).rows[0]?.id : undefined;
  let include = f.archived === true, scoped: SpaceAccess | null = null;
  if (f.space) {
    scoped = await resolveSpace(app, caller, f.space, all);     // someone else's space in a filter — just empty, without disclosure
    if (scoped?.archived_at) include = true;                    // an explicit archived choice — its records are searched
  }
  const spaces = include ? all : active;
  const archive: ArchiveFilter = include ? ARCHIVE_INCLUDE : { mode: "exclude", spaceIds: [...A] };
  const scopeSpaces = f.space ? (scoped ? [scoped] : []) : [...spaces.values()];
  const me = caller.person?.id;
  let entity: string | undefined, person: string | undefined;
  // a person — by the people table, not the uuid5 of the login: after a login change the id is the old one
  if (f.entity) {
    if (isUuid(f.entity)) entity = f.entity;
    else { const k = parseEntityKey(f.entity); if (!k) throw invalid(`Entity key not recognized: ${f.entity}`); entity = (await entityUuid(app, k)) ?? NIL; }
    if (entity !== NIL && !await entityReadableById(app, caller, entity)) entity = NIL;
    // an entity of an archived project the caller reads: by default its records are absent — say how to find them
    if (entity !== NIL && !include) {
      const sid = (await app.db.control.query("SELECT attrs->>'space_id' AS sid FROM entities WHERE id = $1 AND kind = 'project'", [entity])).rows[0]?.sid as string | undefined;
      const s = sid ? all.get(sid) : undefined;
      if (s?.archived_at && A.has(s.id)) contextNotes.push(`Project ${s.slug} is archived: its records come with filters.archived: true or filters.space: ${s.slug}`);
    }
  }
  if (f.person) person = (await personIdByLogin(app, f.person)) ?? NIL;

  // the query embedding — once for both classes; 5 s, no retries on 429: a busy embedder does not hold the agent's answer,
  // unavailability does not bring the search down — full text remains
  let vector: number[] | null = null, embedder: EmbedderRef | null = null, vectorSrc: VectorSourceView | null = null;
  let vectorFailed = false;                                     // a vector query of some class failed or timed out
  const modelClass: DataClass = caller.scope.classes.includes("closed") ? "closed" : "open";
  if (query && (mode === "hybrid" || mode === "semantic")) {
    // the columns of the registry row the embeddings facade reads (EmbedderRow)
    const { rows } = await app.db.control.query("SELECT id, model, dims, query_instruction, max_tokens, profile, connection_slot, active, candidate, retire_at, closed_at, vector_generation FROM embedders WHERE active LIMIT 1");
    // the registry row is checked before the model is called: its id and dimension go into the SQL text
    let ref: EmbedderRef | null = null;
    if (rows[0]) {
      try { ref = embedderSql(rows[0]).ref; }
      catch {
        log.warn("search_embedder_invalid");
        notes.push(mode === "semantic" ? VECTOR_FAILED_NOTE_SEMANTIC : VECTOR_FAILED_NOTE_HYBRID);
      }
    }
    if (rows[0] && ref) {
      trace.embedder = { id: ref.id, dims: ref.dims };
      const tEmbed = performance.now();
      // the model call class — the strictest the caller reads: the query searches the closed class too, so the query itself
      // counts as closed (the alias gate). The facade: the row's profile and connection, the data
      // policy before the request, stage search_query, 5 s and no wait on 429. Any stop and any failure — keyword only, a note.
      const unavailable = mode === "semantic" ? "The embedder is unavailable: semantic search is not possible now — use mode = keyword or hybrid" : "The embedder is unavailable: full-text results only";
      try {
        const st = embedderFor({ platform: app.platform, settings: app.settings }, rows[0] as EmbedderRow);
        // a legacy row (no profile) is served with retrieval.embeddings_model, whatever
        // model computed its vectors. Once the worker remembered that model (embedder_alias:<id>) and the setting names
        // another one, the query vector would be of another model than the stored ones under the same id: no request
        const moved = st.state === "ready" && !(rows[0] as EmbedderRow).profile ? await legacyModelOf(app, ref.id) : null;
        if (st.state === "off") {
          notes.push(unavailable);
          log.warn("search_embed_failed", { kind: st.reason });
        } else if (moved && moved !== st.embedder.profile.space.model) {
          notes.push(unavailable);
          log.warn("search_embed_failed", { kind: "legacy_model_moved" });
        } else {
          const cfg = app.settings.get("retrieval.query_cache", { size: 2000, ttl_sec: 600 });
          const cache = queryVectorCache(app.settings);
          // the cache is keyed by the vector source (address, model, space, generation), not by the model alone —
          // a query vector of the old address is never served after a move. The live class permission is checked even
          // for a hit. A refusal still takes the facade's audited path.
          const source = st.embedder.source;
          const hit = st.embedder.allows(modelClass) ? cache.get(ref.id, source, query, cfg) : null;
          const cached = hit?.length === ref.dims ? hit : null;
          const out = cached ? { ok: true as const, embedderId: ref.id, vectors: [Array.from(cached)] }
            : await st.embedder.embedQuery(query, { dataClass: modelClass, timeoutMs: 5_000 });
          if (!out.ok) {
            notes.push(out.stop === "policy"
              ? "The embedder was not called: the model alias is outside level T0 (gate T1) — full-text results only"
              // the money budget is spent (models.budget.search = "allow" lets search pay on)
              : mode === "semantic" ? "Model budget exhausted: semantic search is not possible now — use mode = keyword or hybrid" : "Model budget exhausted: results by full-text search only");
            log.warn("search_embed_failed", { kind: out.stop === "policy" ? "policy_denied" : "budget_exhausted" });
          } else {
            const v = out.vectors[0];
            if (Array.isArray(v) && v.length === ref.dims && out.embedderId === ref.id) {
              const view = await sourceViewOf(app, ref.id, source);
              vector = v; embedder = ref; vectorSrc = { source: view.source, legacy: view.legacy };
              if (view.rebuilding !== false) notes.push(rebuildingNote(mode, view.rebuilding));
              if (!cached) cache.set(ref.id, source, query, v, cfg);
            }
            else {
              log.warn("search_vector_length_mismatch", { dims: ref.dims });
              notes.push(mode === "semantic" ? VECTOR_FAILED_NOTE_SEMANTIC : VECTOR_FAILED_NOTE_HYBRID);
            }
          }
        }
      }
      catch (e) {
        // the model gateway is down, no local substitute: hybrid honestly degrades to full text, and a purely semantic
        // search returns empty with an explanation — more useful to the agent than a protocol error
        notes.push(unavailable);
        log.warn("search_embed_failed", { kind: (e as PlatformError)?.kind ?? "other" });
      }
      trace.timings_ms.embed = since(tEmbed);
    } else if (!rows[0]) {
      // no active embedder is the default of a fresh install, not a failure: say why the vector part is missing
      notes.push(mode === "semantic"
        ? "No embedding model is configured: semantic search is unavailable — use mode = keyword or hybrid"
        : "No embedding model is configured: results are keyword-only");
    }
  }

  const spaceIds = scopeSpaces.map((s) => s.id);
  // visibility — the single builder: the author rule from access.author_rule, the "in the space" filter — F
  const spec = listingSpec(app, caller, spaces, f.space ? spaceIds : null, archive);
  // "Company common knowledge": held "Wrong / not for everyone" ones are not found by agents (outside the builder core)
  // — the set is counted only when org is among the search spaces; O and "confirmed" — by the review row
  const org = await orgSpace(app);
  const orgInScope = !!org && spaceIds.includes(org.id);
  const reviewOn = orgReviewEnabled(app.settings), factorO = unreviewedFactor(app.settings.get<unknown>("search.org_unreviewed_factor", 0.8));
  let heldHidden = 0;
  /**
   * org records: the unit of the check of each hit — the final hold check (the set cache affects only
   * candidates), the view for a session, the O factor of an unconfirmed one and "confirmed" by the row state.
   * Returns hits without held ones; `count` — count the hidden ones in the `held` event (a mixed-in source is not counted).
   */
  const orgReviewed = async (db: pg.Pool, out: Scored[], count: boolean): Promise<Scored[]> => {
    const inOrg = org ? out.filter((s) => s.rec.space_id === org.id) : [];
    if (inOrg.length) {
      const units = await orgUnitsOf(app.db.control, db, inOrg.map((s) => s.rec.id));
      for (const s of inOrg) {
        const u = units.get(s.rec.id);
        if (!u) continue;
        if (u.held_at && !seesHeld(caller)) { s.score = Number.NaN; if (count) heldHidden++; continue; }
        if (!reviewOn && !u.held_at) continue;
        s.org = reviewView(u);
        s.confirmed = confirmedOf(u, s.rec.confirmed_at);
        if (reviewOn && (s.org === "unreviewed" || s.org === "disputed")) s.orgFactor = factorO;
      }
    }
    return out.filter((s) => !Number.isNaN(s.score));
  };
  /** A link to the current_space project entity — "in the current" too: only visible ids, only its class pool; any link role. */
  const tagCurrentEntity = async (db: pg.Pool, out: Scored[]): Promise<void> => {
    if (!currentEntity || !out.length) return;
    const tagged = new Set((await db.query(
      "SELECT DISTINCT record_id FROM record_entities WHERE entity_id = $1 AND record_id = ANY($2::uuid[])",
      [currentEntity, out.map((s) => s.rec.id)])).rows.map((r) => r.record_id as string));
    for (const s of out) if (tagged.has(s.rec.id)) s.inCurrent = true;
  };
  /** The prefilter of each class of this answer (a mixed-in source passes it whole); a class without a filter is not here. */
  const prefilters = new Map<DataClass, Prefilter>();
  // The snippet window is placed by the query words without the stop words of the class database's full-text
  // configurations, in the density window. Not for a caller of the external channel: its answers are compared with the edge byte
  // for byte, and the edge cuts snippets by the plain query words until its mirror moves
  // to the configurations too.
  // "first" is the window of the earlier rule byte for byte, so it keeps the plain words too.
  const snippetTermsOn = !!query && !isExternal(caller) && snippetWindowOf(app.settings.get<unknown>("search.snippet_window", "density")) === "density";
  const queryWords = snippetTermsOn ? snippetWords(query) : [];
  const termsByClass = new Map<DataClass, string[]>();
  /** Candidates of one class that already passed the final rights check. Classes go in parallel — each has its own pool. */
  const searchClass = async (cls: DataClass): Promise<Scored[]> => {
    if (!me) return [];                                         // a service without a person sees no data
    if (spec.scope && !spec.scope.length) return [];            // someone else's or a missing space in a filter — empty
    const dArgs: unknown[] = [];
    const direct = directQuery(spec, cls, binder(dArgs));
    if (direct === null) return [];                             // the none gate: the class is not queried
    const db = app.db.records(cls, caller.scope);
    // direct grants: the people list and (legacy) the author branch of the "people" area (with a space filter — only with home
    // space from F);
    // placements (the same file in another space) count on a par with the home space
    const [ppl, placed] = await Promise.all([
      db.query(direct, dArgs),
      db.query("SELECT DISTINCT pl.record_id FROM record_placements pl WHERE pl.space_id = ANY($1::uuid[])", [spaceIds]),
    ]);
    let only: string[] | undefined;
    if (entity || person) {
      const ids = new Set<string>();
      // an employee card is their profile record (owner_id = the person), it has no record_people/record_entities links: as in
      // memory_list /people/<login> (list.ts), the per-person filter or the person:<login> entity filter finds it too.
      // For a non-person entity owner_id does not match its id — empty. Rights — by the final check below, as always
      if (entity) for (const r of (await db.query(`SELECT record_id FROM record_entities WHERE entity_id = $1 UNION ${PROFILE_OF}`, [entity])).rows) ids.add(r.record_id);
      if (person) {
        const mine = new Set<string>();
        for (const r of (await db.query(`SELECT record_id FROM record_people WHERE person_id = $1 UNION SELECT record_id FROM record_entities WHERE entity_id = $1 UNION ${PROFILE_OF}`, [person])).rows) mine.add(r.record_id);
        if (entity) for (const id of [...ids]) { if (!mine.has(id)) ids.delete(id); } else for (const id of mine) ids.add(id);
      }
      only = [...ids];
      if (!only.length) return [];
    }
    // the author branch always — by a condition inside the index queries, not by an id list; in legacy — null
    const held = orgInScope ? await heldIds(app, caller, cls) : [];
    heldHidden += held.length;
    const pre: Prefilter = { spaceIds, placedRecordIds: placed.rows.map((r) => r.record_id), directRecordIds: ppl.rows.map((r) => r.id), owner: prefilterOwner(spec, cls),
                             types: f.types, eventKinds: f.event_kinds, domains: f.domains, from, to, onlyRecordIds: only, excludeIds: [...(a.exclude_ids ?? []), ...held] };
    prefilters.set(cls, pre);

    const ct: ClassTrace = { class: cls, keyword: [], title: [], vector: [], vector_failed: false, hnsw: null, fused: [], visible: 0,
                             timings_ms: { keyword: 0, title: 0, vector: 0 } };
    trace.classes.push(ct);
    let best = new Map<string, { cand: Candidate | null; rrf: number }>();
    // a failure only costs the filter: the snippet then uses the plain query words
    const terms = snippetTermsOn ? new PgvectorIndex(db).snippetTerms(queryWords).then((t) => { termsByClass.set(cls, t); },
      (e: unknown) => { log.warn("search_snippet_terms_failed", { class: cls, code: (e as { code?: unknown } | null)?.code ?? null }); }) : Promise.resolve();
    if (mode === "recent") {
      const args: unknown[] = [];
      const { rows } = await db.query(recentCandidatesSql(pre, args), args);
      rows.forEach((r, i) => best.set(r.id, { cand: null, rrf: 1 / (RECENT_RANK_K + i + 1) }));
    } else {
      const index = new PgvectorIndex(db, { tuning });
      /** Wall time of one candidate list of this class, into the trace. */
      const timed = async <T>(p: Promise<T>, stage: "keyword" | "title" | "vector"): Promise<T> => {
        const t = performance.now();
        try { return await p; } finally { ct.timings_ms[stage] = since(t); }
      };
      // a failed or timed-out vector query degrades this class to keyword with a note; keyword and title errors
      // still fail the search. title_candidates = 0 — no title list.
      const [keyword, title, semantic] = await Promise.all([
        mode !== "semantic" ? timed(index.keyword(query!, pre, tuning.candidates), "keyword") : [],
        mode !== "semantic" && tuning.title_candidates > 0 ? timed(index.title(query!, pre, tuning.title_candidates), "title") : [],
        vector && embedder && vectorSrc ? timed(index.semantic(vector, embedder, pre, tuning.candidates, vectorSrc).catch((e: unknown) => {
          vectorFailed = true;
          ct.vector_failed = true;
          log.warn("search_vector_failed", { class: cls, code: (e as { code?: unknown } | null)?.code ?? null });
          return [] as Candidate[];
        }), "vector") : [],
      ]);
      ct.keyword = traceList(keyword); ct.title = traceList(title); ct.vector = traceList(semantic); ct.hnsw = index.lastHnsw;
      // RRF over content list chunks; a record is represented by its best chunk; the title is the record score (ranking.ts)
      best = fuseCandidates({ keyword, vector: semantic, title }, tuning);
    }
    ct.fused = [...best].map(([record_id, b]) => ({ record_id, chunk_id: b.cand?.chunk_id ?? null, rrf: b.rrf })).sort((x, y) => y.rrf - x.rrf);
    await terms;
    if (!best.size) return [];

    // the final check — against live tables: not deleted, the current version, area and space from records, not from
    // the chunk. Visibility — the builder's SQL as a column plus an independent JS check of the same rows by facts in a batch
    // (defense in depth: the original_url signature rests only on this check). A mismatch —
    // a warning without content and names, the record is excluded.
    const ids = [...best.keys()];
    const args: unknown[] = [], bind = binder(args);
    const cond = [`r.id = ANY(${bind(ids)}::uuid[])`];
    if (held.length) cond.push(`r.id <> ALL(${bind(held)}::uuid[])`);
    if (f.types?.length) cond.push(`r.type = ANY(${bind(f.types)}::record_type[])`);
    if (f.event_kinds?.length) cond.push(`r.event_kind = ANY(${bind(f.event_kinds)}::event_kind[])`);
    if (f.domains?.length) cond.push(`r.domain_tags && ${bind(f.domains)}::text[]`);
    if (from) cond.push(`r.occurred_at >= ${bind(from)}`);
    if (to) cond.push(`r.occurred_at ${upperBoundOp(to)} ${bind(to.at)}`);
    // the own gate (an extended key, closed — only one's own) — in the selection itself too: foreign rows are not selected at all
    const own = gateSql(spec, cls, bind) ?? "";
    const visible = visibleSql(spec, cls, bind)!;
    const [live, facts] = await Promise.all([
      db.query(`SELECT r.*, ${visible} AS visible_sql FROM records_live r WHERE ${cond.join(" AND ")}${own}`, args),
      factsFor(db, ids, me),
    ]);
    const out: Scored[] = [];
    for (const { visible_sql: bySql, ...row } of live.rows as Array<RecordRow & { visible_sql: boolean | null }>) {
      const rec = row as RecordRow;
      const fx = facts.get(rec.id) ?? { listed: [], placed: [] };
      const byJs = visibleRow(spec, { id: rec.id, owner_id: rec.owner_id, audience: rec.audience, space_id: rec.space_id, class: cls, ...fx });
      if (bySql !== byJs) { log.warn("visibility_mismatch", { record_id: rec.id, class: cls, sql: bySql, js: byJs, rule: spec.owner }); continue; }
      if (!byJs) continue;
      const b = best.get(rec.id)!;
      out.push({ rec, cand: b.cand, cls, rrf: b.rrf, score: b.rrf,
        inCurrent: !!current && (rec.space_id === current.id || fx.placed.includes(current.id)) });
    }
    // org records: hold, view, O and "confirmed" — orgReviewed
    const kept = await orgReviewed(db, out, true);
    out.length = 0; out.push(...kept);
    await tagCurrentEntity(db, out);
    ct.visible = out.length;
    return out;
  };
  /**
   * The "source → retelling" reordering and mixing in on a cut page.
   * A visible source of a retelling is mixed in when none of its sources is on the page — the first by priority
   * (derived_from newest first, then echo_of) that passed the WHOLE prefilter of this answer for its class (spaces,
   * placements, direct grants, the author branch, types, event_kinds, domains, from/to, the person/entity filter, exclude_ids and
   * held ones) and its visibility rule with archive mode; a class with no prefilter (empty person/entity filter, none gate) mixes
   * in nothing. One query per class over all candidates. One held in org (not for a session) is not mixed in.
   * A mixed-in hit is like an ordinary one, no chunk (snippet — the description line or title), score — the retelling's before
   * the move; further on the array is ordered by place, not by score.
   */
  const derivationPage = async (pageIn: Scored[], found: ReadonlyMap<string, DerivationFound>): Promise<{ page: Scored[]; injected: Scored[] }> => {
    const onPage = new Set(pageIn.map((s) => s.rec.id));
    const sourcesOf = new Map<string, readonly string[]>();
    for (const s of pageIn) { const f = found.get(s.rec.id); if (f?.order.length) sourcesOf.set(s.rec.id, f.order); }
    if (!sourcesOf.size) return { page: pageIn, injected: [] };
    const want = [...sourcesOf].filter(([, srcs]) => !srcs.some((x) => onPage.has(x)));
    const passed = new Map<string, Scored>();
    for (const cls of ["open", "closed"] as const) {
      const pre = prefilters.get(cls);
      const ids = [...new Set(want.flatMap(([r, srcs]) => srcs.filter((x) => found.get(r)!.classes.get(x) === cls)))];
      if (!pre || !ids.length) continue;
      const args: unknown[] = [];
      const where = prefilterWhere(pre, args, "r");
      const bind = binder(args);
      const visible = visibleSql(spec, cls, bind);
      if (visible === null) continue;
      const db = app.db.records(cls, caller.scope);
      const rows = (await db.query(`SELECT r.* FROM records_live r WHERE r.id = ANY(${bind(ids)}::uuid[]) AND ${where} AND ${visible}`, args)).rows as RecordRow[];
      // like an ordinary hit: a JS visibility check by facts (defense in depth, as in searchClass) and
      // "in the current space" — home, placement or a link with the project entity: the current_space_hits counter — per page
      const facts = await factsFor(db, rows.map((r) => r.id), me!);
      const built: Scored[] = [];
      for (const rec of rows) {
        const fx = facts.get(rec.id) ?? { listed: [], placed: [] };
        if (!visibleRow(spec, { id: rec.id, owner_id: rec.owner_id, audience: rec.audience, space_id: rec.space_id, class: cls, ...fx })) {
          log.warn("visibility_mismatch", { record_id: rec.id, class: cls, sql: true, js: false, rule: spec.owner }); continue;
        }
        built.push({ rec, cand: null, cls, rrf: 0, score: 0, inCurrent: !!current && (rec.space_id === current.id || fx.placed.includes(current.id)) });
      }
      const kept = await orgReviewed(db, built, false);
      await tagCurrentEntity(db, kept);
      for (const s of kept) passed.set(s.rec.id, s);
    }
    const inject = new Map<string, string>();
    for (const [r, srcs] of want) { const x = srcs.find((id) => passed.has(id)); if (x) inject.set(r, x); }
    const { order, injected } = applyDerivationOrder(pageIn.map((s) => s.rec.id), sourcesOf, inject, limit);
    const byId = new Map(pageIn.map((s) => [s.rec.id, s]));
    const added: Scored[] = [];
    const next = order.map((id) => {
      const have = byId.get(id);
      if (have) return have;
      const r = byId.get(injected.get(id)!)!;
      const s: Scored = { ...passed.get(id)!, rrf: r.rrf, score: r.score };
      added.push(s);
      return s;
    });
    return { page: next, injected: added };
  };

  let scored: Scored[] = (await Promise.all(caller.scope.classes.map(searchClass))).flat();
  const total = scored.length;

  // The "source → retelling" reordering, the D factor and mixing in a source — only with the switch on and not in
  // recent (it builds the workplace auto lists); off — not a single derivationFactor field: scores and order as before
  const derivationOn = mode !== "recent" && app.settings.get<unknown>(DERIVATION_ORDER_SETTING, false) === true;
  // D — for hits with derivation: a declared retelling (attrs) and an echo with a visible source (by the same rule as
  // the mark: an echo of a hidden record is not lowered) — before ranking, over all candidates; echo links are written apart, so
  // search.ts need not change for it
  if (derivationOn) {
    const D = derivationFactor(app.settings.get<unknown>(DERIVATION_FACTOR_SETTING, DERIVATION_FACTOR_DEFAULT));
    if (D < 1) {
      const echoes = await echoesWithVisibleSource(app, caller, scored.filter((s) => !declaredRetelling(s.rec.attrs)).map((s) => s.rec.id), all);
      for (const s of scored) if (declaredRetelling(s.rec.attrs) || echoes.has(s.rec.id)) s.derivationFactor = D;
    }
  }

  const b = app.settings.get<Record<string, number>>("search.boosts", { confirmed: 1.1, own_space: 1.05, title_match: 1.15, recency_weight: 0.1, recency_half_life_days: 180 });
  const words = (query ?? "").toLowerCase().split(/[^\p{L}\p{N}-]+/u).filter((w) => w.length >= 4);
  const ranking: RankingOptions<Scored> = { mode, boosts: b, words, me: me ?? null, nowMs: Date.now(), boost, tieStep: rrfTieStep(tuning) };
  // RRF×B picks the pool, then the reranker score × generic × B. On a refusal — the old tie correction.
  const useRerank = query && (mode === "hybrid" || mode === "semantic") && app.platform.roleState("rerank").state === "ready";
  let reranked = false, rerankError: unknown;
  if (useRerank && scored.length > 1) {
    const pool = rerankPool(scored, { limit: app.settings.get("retrieval.rerank_top", 16),
      maxPerParent: app.settings.get("search.max_per_parent", 3), boost });
    const { top } = pool;
    trace.pool = { top: top.map((s) => s.rec.id), rest: pool.rest.length };
    const tRerank = performance.now();
    try {
      const rerankClass = rerankClassOf(modelClass, top);
      const res = await app.platform.rerank(query!, top.map((s) => [s.rec.title, s.cand?.text ?? s.rec.summary_line ?? ""].filter(Boolean).join("\n").slice(0, 2000)), { dataClass: rerankClass, stage: "search_rerank" },
        // the pool's records are judged at the send by the record rule of the chat stages (the query is not a record)
        { beforeDispatch: rerankFence(app, caller.scope, top) });
      trace.timings_ms.rerank = since(tRerank);
      ranking.rerank = { ...pool, scores: res };
      reranked = true;
      // what was sent, as sizes only (the same passage rule as the call above; a test compares it with the reranker's input)
      const chars = top.reduce((n, s) => n + [s.rec.title, s.cand?.text ?? s.rec.summary_line ?? ""].filter(Boolean).join("\n").slice(0, 2000).length, 0);
      trace.rerank = { texts: top.length, input_chars: chars, tokens_estimate: Math.ceil(chars / 4), calibration: "identity",
                       scores: res.filter((r) => top[r.index]).map((r) => ({ record_id: top[r.index]!.rec.id, raw: r.score, calibrated: r.score })) };
    } catch (e) {
      trace.timings_ms.rerank = since(tRerank);
      rerankError = e ?? null;
      const kind = (e as PlatformError | null)?.kind;
      trace.rerank_failed = rerankFailureOf(e);
      // a held record (RerankSourceHeld) is kind policy_denied too: the same cause-free note as the T1 gate
      notes.push(rerankFallbackNote(e) ?? (e instanceof RerankSourceUnchecked ? RERANK_UNCHECKED_NOTE
        : kind === "busy" ? "The reranker is busy: order by RRF"
        : kind === "policy_denied" ? RERANK_SKIPPED_NOTE
        : kind === "budget_exhausted" ? "Model budget exhausted: the reranker was not called — order by RRF"
        : "The reranker is unavailable: order by RRF"));
    }
  }
  scored = finalScores(scored, ranking);

  let page = scored.slice(0, limit);
  // "Based on": the retelling mark — always, in any mode (it does not change order and contents); reordering and
  // mixing in — only with the switch on
  const marks = await derivationFor(app, caller, page.map((s) => ({ id: s.rec.id, cls: s.cls, attrs: s.rec.attrs })), { spaces: all });
  if (derivationOn && marks.size) {
    const moved = await derivationPage(page, marks);
    page = moved.page;
    // a mixed-in source may itself be a retelling (a chain A ← B ← C) — its mark by the same rule
    if (moved.injected.length)
      for (const [id, m] of await derivationFor(app, caller, moved.injected.map((s) => ({ id: s.rec.id, cls: s.cls, attrs: s.rec.attrs })), { spaces: all })) marks.set(id, m);
  }
  // where the snippet window stands: "density" by default, "first" — the earlier rule; the words are the query
  // words without the stop words of the hit's class database (absent — the plain query words, as the edge)
  const snippetWindow = snippetWindowOf(app.settings.get<unknown>("search.snippet_window", "density"));
  const hits = await Promise.all(page.map(async (s) => {
    const space = all.get(s.rec.space_id);
    const slug = space?.slug ?? (await slugOf(app, s.rec.space_id));
    const mark = marks.get(s.rec.id);
    return {
      id: s.rec.id, path: recordPath(slug, s.rec.type, s.rec.occurred_at, s.rec.id), type: s.rec.type, event_kind: s.rec.event_kind,
      title: s.rec.title ?? "", snippet: snippetOf(s.cand?.text ?? s.rec.summary_line ?? s.rec.title ?? "", query, snippetTokens, { window: snippetWindow, terms: termsByClass.get(s.cls) }),
      locator: locatorOf(s.rec, s.cand), occurred_at: new Date(s.rec.occurred_at).toISOString(), ingested_at: new Date(s.rec.ingested_at).toISOString(),
      space: slug, class: s.cls, origin: originOf(s.rec.method), confirmed: s.confirmed ?? s.rec.confirmed_at !== null, confidence: confidenceOf(s.rec),
      score: Number(s.score.toFixed(6)), token_count: s.rec.token_count ?? 0,
      original_url: s.rec.type === "document" ? await signedOriginalUrl(app, caller, s.rec.id, s.cls) : null,
      // home in an archive — in any mode: also what was found through a placement in a current one
      ...(A.has(s.rec.space_id) ? { space_archived: true as const } : {}),
      // written by an agent with extended access by the administrator's permission; details — memory_read
      ...(extendedWriteView(s.rec.attrs) ? { extended_write: true as const } : {}),
      // "Company common knowledge" under review: the kind of the review row; disputed — only for a session
      ...(s.org ? { org_review: s.org as OrgReviewView } : {}),
      // an agent's retelling: the kind, visible sources, the mark; no field — the record is not a retelling
      ...(mark ? { derivation: derivationOut(mark.mark) } : {}),
    };
  }));
  if (vectorFailed) notes.push(mode === "semantic" ? VECTOR_FAILED_NOTE_SEMANTIC : VECTOR_FAILED_NOTE_HYBRID);
  if (vector === null && mode === "hybrid" && !notes.length) notes.push("The vector part was not used");
  notes.push(...contextNotes);
  // zero hits, and the caller reads archived ones with records: by default not searched — say so (only to them — their count)
  if (!include && !hits.length) {
    const n = [...all.values()].filter((s) => s.archived_at && A.has(s.id)).length;
    if (n) notes.push(`Archived spaces (${n}) were not searched: filters.archived: true`);
  }
  // a key without the closed class does not search one's own closed records: the agent must know they exist and who
  // can open them for agents — a person in the workplace. Counted by locators, the closed database is not read.
  // To the external agents' address — not a line: closed is not spoken of there
  if (caller.person && !caller.scope.classes.includes("closed") && !isExternal(caller)) {
    // closed by the open check (personal open) — a line apart: they have their own advice — the reason in memory_read,
    // open on the person's explicit answer (memory_open) or remove what was found; the old line — about the other closed ones
    const rows = (await app.db.control.query(
      "SELECT space_id, count(*) FILTER (WHERE open_check IS NULL)::int AS n, count(*) FILTER (WHERE open_check IS NOT NULL)::int AS m FROM record_locations WHERE owner_id = $1 AND class = 'closed' AND NOT deleted GROUP BY space_id",
      [caller.person.id])).rows as Array<{ space_id: string; n: number; m: number }>;
    const own = rows.reduce((t, r) => t + r.n, 0), marked = rows.reduce((t, r) => t + r.m, 0);
    // where they are — by space, one's own (the agent used to take the total count for the current project, and
    // hidden_closed in memory_me also counts others' closed ones). A space is named by slug (the [a-z0-9-] pattern, not people's
    // text — the note stands outside the data markers), only one the caller reads; the rest — one number without a name
    const bySpace = rows.filter((r) => r.n > 0).map((r) => ({ slug: all.get(r.space_id)?.slug, n: r.n }));
    const named = bySpace.filter((r): r is { slug: string; n: number } => Boolean(r.slug))
      .sort((a, b) => b.n - a.n || a.slug.localeCompare(b.slug)).map((r) => `${r.slug} — ${r.n}`);
    const elsewhere = bySpace.filter((r) => !r.slug).reduce((t, r) => t + r.n, 0);
    if (elsewhere) named.push(`spaces you do not read — ${elsewhere}`);
    if (own) notes.push(`Your closed-class records (${own}) are not searched with this key; where they are (space slug — count): ${named.join(", ")}; only a person in the workplace can show a record to agents: ${workplaceWhere(app, "/materials", "My records")}`);
    // the reason for one's own record — only in one's own personal; a team or project record can be shown to agents
    // only by the author in the workplace
    if (marked) notes.push(`Your records closed by the open-record check (${marked}) are not searched with this key: agents do not see them. The reason for your own record in the personal space — memory_read by id; `
      + "only the author, in the workplace, can show a team or project record to agents; "
      + (openByWordCaller(caller) ? "in the personal space, if agents need it and open_check.by_word is on, ask the person whether to show the record to agents and call memory_open only on their explicit answer; otherwise remove what was found and write it again"
                                  : "if agents need it, remove what was found and write it again"));
  }
  // names of closed retelling sources — a showing of closed: an event before the answer; log refused — no answer
  await auditShownClosed(app, caller, page.flatMap((s) => marks.get(s.rec.id)?.closed ?? []), DERIVATION_SOURCES_OP);
  // the id of the search event is known before the write and goes to the agent as search_id: reading a hit refers to this answer.
  // Generated before the write — the time in UUIDv7 is close to the event's `at` (the check window on read — ±5 min)
  const searchId = newId();
  // an answer with closed is marked by the class: "who saw closed" — by a log filter, without sorting ids by database
  await auditRead(app, caller, { event_type: "search", class: hits.some((h) => h.class === "closed") ? "closed" : null, query_text: query ?? null, filters: a.filters ?? {},
                                 result_count: hits.length, record_ids: hits.map((h) => h.id), id: searchId,
                                 details: searchAuditDetails({ mode, limit, excludeIds: a.exclude_ids, reranked, rerankError,
                                   currentSpace: current === undefined ? undefined : current?.id ?? null,
                                   currentSpaceHits: page.filter((s) => s.inCurrent).length, archive: include ? "include" : "exclude", held: heldHidden }) });
  trace.chosen = page.map((s) => ({ record_id: s.rec.id, chunk_id: s.cand?.chunk_id ?? null, class: s.cls, score: Number(s.score.toFixed(6)) }));
  trace.classes.sort((x, y) => x.class.localeCompare(y.class));
  trace.timings_ms.keyword = Math.max(0, ...trace.classes.map((c) => Math.max(c.timings_ms.keyword, c.timings_ms.title)));
  trace.timings_ms.vector = Math.max(0, ...trace.classes.map((c) => c.timings_ms.vector));
  trace.timings_ms.total = since(t0);
  // ids, ranks, scores and timings only — no text, title or query; written when the log level is debug
  log.debug("search_trace", { trace });
  opts.trace?.(trace);
  return { search_id: searchId, hits, total_estimate: total, applied_filters: a.filters ?? {}, mode, ...(current === undefined ? {} : { current_space: current?.slug ?? null }), ...(notes.length ? { notes } : {}) };
}

async function slugOf(app: App, spaceId: string): Promise<string> {
  return (await app.db.control.query("SELECT slug FROM spaces WHERE id = $1", [spaceId])).rows[0]?.slug ?? "unknown";
}

export type { SpaceAccess };
