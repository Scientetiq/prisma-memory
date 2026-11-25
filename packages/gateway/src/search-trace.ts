// Stage timings and the trace of one memory_search call. The trace is an in-process object for
// tests and the debug log: ids, ranks, scores, counts and timings — never a text, a title or the query.
// No endpoint returns it; the stage timings reach the answer when adds the optional field to the contract.
import type { DataClass, RetrievalTuning } from "@memory/shared";

/** Milliseconds per stage. keyword and vector are the wall time of the slowest data class (classes run in parallel). */
export interface SearchTimings { embed: number; keyword: number; vector: number; rerank: number; total: number }

/** One candidate of a list: rank from 1, in the order the index returned it. */
export interface TraceItem { chunk_id: string; record_id: string; rank: number }

/** HNSW parameters the vector query of a class ran with (null: no vector query). */
export interface TraceHnsw { iterative_scan: boolean; ef_search: number; max_scan_tuples: number | null }

export interface ClassTrace {
  class: DataClass;
  keyword: TraceItem[];
  title: TraceItem[];
  vector: TraceItem[];
  vector_failed: boolean;
  hnsw: TraceHnsw | null;
  /** Records after the fusion with their best chunk (null — a record represented by itself) and RRF, best first. */
  fused: Array<{ record_id: string; chunk_id: string | null; rrf: number }>;
  /** Records that passed the final rights check. */
  visible: number;
  timings_ms: { keyword: number; title: number; vector: number };
}

export interface SearchTrace {
  mode: string;
  tuning: RetrievalTuning;
  embedder: { id: string; dims: number } | null;
  classes: ClassTrace[];
  /** The reranker pool: record ids of the passages sent, and how many candidates stayed outside. */
  pool: { top: string[]; rest: number } | null;
  /**
   * Scores of the reranker per record of the pool. `calibrated` equals `raw` until per-reranker calibration exists.
   * Tokens are not reported by the reranker: `input_chars` and `tokens_estimate` (chars / 4) measure what was sent.
   */
  rerank: { texts: number; input_chars: number; tokens_estimate: number; calibration: "identity";
            scores: Array<{ record_id: string; raw: number; calibrated: number }> } | null;
  rerank_failed: string | null;
  /** The answer page: record, its chunk, class and final score, in the order returned. */
  chosen: Array<{ record_id: string; chunk_id: string | null; class: DataClass; score: number }>;
  timings_ms: SearchTimings;
}

/** Internal options of search(): `trace` receives the trace of the call (tests; nothing outside the process). */
export interface SearchOptions { trace?: (trace: SearchTrace) => void }

/** Milliseconds since `t0` (performance.now()), to 0.1 ms. */
export function since(t0: number): number {
  return Math.round((performance.now() - t0) * 10) / 10;
}

/** A list of candidates as trace items: ids and ranks only. */
export function traceList(list: ReadonlyArray<{ chunk_id: string; record_id: string }>): TraceItem[] {
  return list.map((c, i) => ({ chunk_id: c.chunk_id, record_id: c.record_id, rank: i + 1 }));
}

export function emptyTrace(mode: string, tuning: RetrievalTuning): SearchTrace {
  return { mode, tuning: { ...tuning }, embedder: null, classes: [], pool: null, rerank: null, rerank_failed: null, chosen: [],
           timings_ms: { embed: 0, keyword: 0, vector: 0, rerank: 0, total: 0 } };
}
