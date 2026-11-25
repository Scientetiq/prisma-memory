// retrieval.tuning: the numbers of memory_search that used to be constants of the gateway —
// candidate counts per list, the RRF constant and channel weights, the HNSW search parameters and the statement timeout of
// the vector query. The field names are the ones the evaluation lab writes into its defaults file (`fusion`, `storage.hnsw`),
// so a measured result is applied by a setting, not by a code change. The defaults are the former constants: with them the
// search answers byte for byte as before.
import { log } from "./log.ts";

export const RETRIEVAL_TUNING_SETTING = "retrieval.tuning";

export interface RetrievalTuning {
  /** Chunks taken from the keyword list and from the vector list of each data class. */
  candidates: number;
  /** Records taken from the title list of each data class; 0 — no title list. */
  title_candidates: number;
  /** k of reciprocal rank fusion: a list item at rank r (from 1) adds w / (k + r). */
  rrf_k: number;
  /** Weight of the keyword list in the fusion. */
  w_keyword: number;
  /** Weight of the vector list in the fusion. */
  w_vector: number;
  /** Weight of the title list (it adds to the record, not to a chunk). */
  w_title: number;
  /** hnsw.ef_search with the iterative index scan (pgvector 0.8 and later). */
  ef_search: number;
  /** hnsw.ef_search when the iterative scan is unavailable (pgvector 0.7): the rights filter then runs after the index. */
  ef_search_no_iterative: number;
  /** hnsw.max_scan_tuples of the iterative scan (pgvector's own default is 20000). */
  max_scan_tuples: number;
  /** Statement timeout of the vector query, ms: past it the search answers by keyword with a note. */
  vector_timeout_ms: number;
}

/** The former constants of search.ts and ranking.ts (RRF_K, CANDIDATES, the title limit, EF_SEARCH, …). */
export const RETRIEVAL_TUNING_DEFAULT: Readonly<RetrievalTuning> = {
  candidates: 150, title_candidates: 50, rrf_k: 60, w_keyword: 1, w_vector: 1, w_title: 1,
  ef_search: 100, ef_search_no_iterative: 400, max_scan_tuples: 20000, vector_timeout_ms: 3000,
};

/** pgvector's default of hnsw.max_scan_tuples: at this value the search does not send the SET at all. */
export const PGVECTOR_MAX_SCAN_TUPLES_DEFAULT = 20000;

interface Range { min: number; max: number; integer: boolean; hint: string }
/**
 * Allowed values. Candidate counts and ef_search stay within pgvector's ceiling of hnsw.ef_search (1000); a weight is from
 * 0.001 to 10 (a channel is switched off by the search mode or, for titles, by title_candidates = 0, not by a weight of 0):
 * below that floor the fused scores lose their precision, and a denormal weight turns every RRF addend into 0.
 */
export const RETRIEVAL_TUNING_RANGES: Readonly<Record<keyof RetrievalTuning, Range>> = {
  candidates: { min: 1, max: 1000, integer: true, hint: "a whole number from 1 to 1000" },
  title_candidates: { min: 0, max: 1000, integer: true, hint: "a whole number from 0 (no title list) to 1000" },
  rrf_k: { min: 1, max: 1000, integer: false, hint: "a number from 1 to 1000" },
  w_keyword: { min: 0.001, max: 10, integer: false, hint: "a number from 0.001 to 10" },
  w_vector: { min: 0.001, max: 10, integer: false, hint: "a number from 0.001 to 10" },
  w_title: { min: 0.001, max: 10, integer: false, hint: "a number from 0.001 to 10 (no title list: title_candidates = 0)" },
  ef_search: { min: 1, max: 1000, integer: true, hint: "a whole number from 1 to 1000" },
  ef_search_no_iterative: { min: 1, max: 1000, integer: true, hint: "a whole number from 1 to 1000" },
  max_scan_tuples: { min: 1, max: 10_000_000, integer: true, hint: "a whole number from 1 to 10000000" },
  vector_timeout_ms: { min: 100, max: 60_000, integer: true, hint: "a whole number of milliseconds from 100 to 60000" },
};
const FIELDS = Object.keys(RETRIEVAL_TUNING_DEFAULT) as Array<keyof RetrievalTuning>;

function fits(r: Range, v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && (!r.integer || Number.isInteger(v))
    && v >= r.min && v <= r.max;
}

/**
 * Problems of a value of retrieval.tuning on save (settings.ts): the merged object (seed default with the value on top), as
 * the search reads it. An unknown field is refused — a typo would otherwise be kept and silently do nothing.
 */
export function retrievalTuningProblems(value: unknown): string[] {
  if (value === null) return [];
  if (typeof value !== "object" || Array.isArray(value)) return ["an object with the fields " + FIELDS.join(", ")];
  const v = value as Record<string, unknown>, out: string[] = [];
  for (const k of Object.keys(v)) if (!(FIELDS as string[]).includes(k)) out.push(`unknown field ${k} (known: ${FIELDS.join(", ")})`);
  for (const k of FIELDS) if (k in v && !fits(RETRIEVAL_TUNING_RANGES[k], v[k])) out.push(`${k}: ${RETRIEVAL_TUNING_RANGES[k].hint}`);
  return out;
}

const warned = new Set<string>();
/**
 * The tuning the search uses: every field that is missing or out of range (a value written past the panel's check) is its
 * default, with one warning per field and process; unknown fields are ignored.
 */
export function retrievalTuning(raw: unknown): RetrievalTuning {
  const v = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const out = { ...RETRIEVAL_TUNING_DEFAULT };
  for (const k of FIELDS) {
    if (!(k in v)) continue;
    if (fits(RETRIEVAL_TUNING_RANGES[k], v[k])) out[k] = v[k] as number;
    else if (!warned.has(k)) { warned.add(k); log.warn("retrieval_tuning_field_ignored", { field: k }); }
  }
  return out;
}
