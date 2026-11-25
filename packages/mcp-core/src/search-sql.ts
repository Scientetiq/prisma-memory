// memory_search full-text expressions — the same for gateway and edge (the edge ranks with its own SQL by the
// same expressions; a differential test compares results byte for byte). SQL text only: the caller builds and runs them.
//
// Full-text language: the stored chunks.tsv of a records database is built with the PostgreSQL
// text search configurations of its retrieval_config row (1 to 3, e.g. {english}, {russian}, {german,english}); the
// queries below are built from that applied list, so query and index never disagree. The names are inlined as SQL
// literals (the title expression must be a literal for the planner to use its index): only names that pass
// ftsConfigName ever reach the text.

/** At most this many configurations are applied at once (retrieval_config and search.fts_configs). */
export const FTS_CONFIGS_MAX = 3;
const FTS_NAME = /^[a-z_]{1,40}$/;

/** A PostgreSQL text search configuration name that may be inlined into SQL (lower-case letters and "_", 1–40), else null. */
export function ftsConfigName(value: unknown): string | null {
  return typeof value === "string" && FTS_NAME.test(value) ? value : null;
}

/**
 * A list of configurations that may be inlined: 1 to FTS_CONFIGS_MAX valid names, duplicates dropped (the first stays).
 * Throws on anything else — a configuration name never reaches SQL unchecked.
 */
export function ftsConfigList(configs: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const c of configs) {
    const name = ftsConfigName(c);
    if (name === null) throw new Error("full-text configuration: invalid name");
    if (!out.includes(name)) out.push(name);
  }
  if (!out.length || out.length > FTS_CONFIGS_MAX) throw new Error(`full-text configuration: 1 to ${FTS_CONFIGS_MAX} names are expected`);
  return out;
}

const lit = (name: string): string => `'${name}'`;
/** to_tsvector of `expr` over every configuration, concatenated (one configuration — exactly the earlier expression). */
const vectorOf = (configs: readonly string[], expr: string): string => configs.map((c) => `to_tsvector(${lit(c)}, ${expr})`).join(" || ");

export interface FtsSqlOptions {
  /** Name of the column of `q` with the lexemes of the configurations (default "fts"). */
  lexemes?: string;
}

/**
 * Full-text queries (CTE `q`, parameter $1 — the query string): the lexemes of the applied configurations joined by OR
 * (a natural-language question rarely matches every word at once); `raw` — exact terms of `simple` (digits, hyphens,
 * Latin words, names) without the stop words of the applied configurations: otherwise "the", "and", "for" (or the
 * Russian prepositions) matched almost every passage through the simple dictionary, and the rank grew with the text
 * length (EXPLAIN on a test install). A lexeme is a stop word when any applied configuration drops it (with
 * several configurations — in every channel); the single configuration "russian" filters by the
 * Russian stop list alone. Short words without digits and single digits stay out of `raw` (a lone
 * "3" would match everything) — the configuration channel finds them. NULL when no lexeme is left.
 */
export function ftsSql(configs: readonly string[], opts: FtsSqlOptions = {}): string {
  const cfgs = ftsConfigList(configs);
  const col = opts.lexemes ?? "fts";
  if (!/^[a-z_]{1,20}$/.test(col)) throw new Error("full-text query: invalid column name");
  // "russian" alone filters exact terms by the Russian stop words only, so Latin abbreviations that are English stop
  // words (WHO, CAN, ALL) stay findable. Any other list (also {russian,english}) filters by every applied configuration.
  const keep = cfgs.length === 1 && cfgs[0] === "russian"
    ? "ts_lexize('russian_stem', lexeme) IS DISTINCT FROM '{}'::text[]"
    : cfgs.map((c) => `to_tsvector(${lit(c)}, lexeme) <> ''::tsvector`).join(" AND ");
  const raw = `(SELECT string_agg(quote_literal(lexeme), ' | ') FROM unnest(to_tsvector('simple', $1))
                               WHERE ${keep} AND (length(lexeme) >= 3 OR (lexeme ~ '[0-9]' AND length(lexeme) >= 2)))::tsquery AS raw`;
  if (cfgs.length === 1)
    return `q AS (SELECT (SELECT string_agg(quote_literal(lexeme), ' | ') FROM unnest(${vectorOf(cfgs, "$1")}))::tsquery AS ${col},
                              ${raw})`;
  // Several configurations: a word that is a stop word of any of them is left out of all of them first — otherwise
  // German "die" would match via English, the Russian "and" via English, and the query would find almost everything.
  const keepToken = cfgs.map((c) => `to_tsvector(${lit(c)}, p.token) <> ''::tsvector`).join(" AND ");
  return `q AS (SELECT (SELECT string_agg(quote_literal(lexeme), ' | ') FROM unnest(${vectorOf(cfgs, "w.kept")}))::tsquery AS ${col},
                              ${raw}
                FROM (SELECT string_agg(p.token, ' ') AS kept FROM ts_parse('default', $1) AS p WHERE ${keepToken}) AS w)`;
}

/**
 * Match and rank of the record title against `q.<lexemes>` for the applied configurations: the same expression per
 * configuration as the title index the schema keeps for it (memory_fts_title_index_ensure), so the index is used. One
 * configuration gives exactly the earlier single expression; several — OR of matches and the best rank.
 */
export function ftsTitleSql(configs: readonly string[], alias = "r", lexemes = "fts"): { match: string; rank: string } {
  const cfgs = ftsConfigList(configs);
  if (!/^[a-z_]{1,20}$/.test(alias) || !/^[a-z_]{1,20}$/.test(lexemes)) throw new Error("full-text query: invalid alias");
  const vec = (c: string) => `to_tsvector(${lit(c)}, ${alias}.title)`;
  const matches = cfgs.map((c) => `${vec(c)} @@ q.${lexemes}`);
  const ranks = cfgs.map((c) => `COALESCE(ts_rank_cd(${vec(c)}, q.${lexemes}, ${RANK_NORM}), 0)`);
  return { match: matches.length === 1 ? matches[0]! : `(${matches.join(" OR ")})`, rank: ranks.length === 1 ? ranks[0]! : `GREATEST(${ranks.join(", ")})` };
}

/**
 * The query words that are not stop words of the applied configurations, in query order (parameter $1 — text[] of
 * words): they place the snippet window, so "the" or the Russian "for" do not pull it away from the answer.
 */
export function ftsTermsSql(configs: readonly string[]): string {
  const cfgs = ftsConfigList(configs);
  const keep = cfgs.map((c) => `to_tsvector(${lit(c)}, u.w) <> ''::tsvector`).join(" AND ");
  return `SELECT COALESCE(array_agg(u.w ORDER BY u.i), '{}') AS terms FROM unnest($1::text[]) WITH ORDINALITY AS u(w, i) WHERE ${keep}`;
}

/** ts_rank_cd normalization: 1 — divide by 1 + log(document length), 32 — scale to 0..1 (a long fragment does not win by word count). */
export const RANK_NORM = "1|32";
