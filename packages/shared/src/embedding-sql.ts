// Native-dimension storage: the column chunk_embeddings.embedding has no fixed dimension, so every query and
// insert names the dimension of its embedder in the cast halfvec(N), and the embedder id is written into the SQL text as
// a literal — a partial index WHERE embedder_id = '<id>' is used only when the planner sees the value itself, not a
// parameter. This module is the only place that builds those two fragments, from a registry row it checks first: the
// same rules as the schema helpers memory_embedding_index_* (06-embedder-platform.sql). Search, indexing and tests
// import it.

/** Embedder id rule: 3…63 characters a-z, 0-9, dot and hyphen, the first one a letter or digit (as in the schema helpers). */
export const EMBEDDER_ID_RE = /^[a-z0-9][a-z0-9.-]{2,62}$/;

/** Smallest and largest dimension an HNSW index of halfvec accepts here (pgvector: up to 4000 for halfvec). */
export const EMBEDDER_DIMS_MIN = 8, EMBEDDER_DIMS_MAX = 4000;

export interface EmbedderRef { id: string; dims: number }

/**
 * Checks a registry row (`embedders.id`, `embedders.dims`) and returns the checked pair, the id as an SQL literal and
 * the cast `halfvec(N)`. Anything else throws `embedder_ref_invalid` — the message never carries the value, so neither a
 * log line nor an error answer can echo it.
 */
export function embedderSql(row: { id: unknown; dims: unknown }): { ref: EmbedderRef; idLiteral: string; cast: string } {
  const { id, dims } = row;
  if (typeof id !== "string" || !EMBEDDER_ID_RE.test(id)) throw new Error("embedder_ref_invalid");
  if (typeof dims !== "number" || !Number.isInteger(dims) || dims < EMBEDDER_DIMS_MIN || dims > EMBEDDER_DIMS_MAX) throw new Error("embedder_ref_invalid");
  return { ref: { id, dims }, idLiteral: `'${id}'`, cast: `halfvec(${dims})` };
}
