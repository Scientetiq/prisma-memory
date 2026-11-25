// Full-text language of a records database. Each records database has one row
// retrieval_config: fts_configs — the PostgreSQL text search configurations its stored chunks.tsv were built with (a
// trigger fills tsv on insert), fts_pending — the configurations of a rebuild in progress. The gateway builds its
// full-text queries only from these applied values (never from the setting), so a query and the index cannot disagree.
// The setting search.fts_configs is the wish: the worker applies it (jobs/fts-config.ts); an empty list keeps what is
// applied (english on a new install, the earlier configuration on an upgraded one).
import type pg from "pg";
import { FTS_CONFIGS_MAX, ftsConfigName } from "@memory/mcp-core";

export const FTS_CONFIGS_SETTING = "search.fts_configs";

/** Why a value of search.fts_configs cannot be saved (null — it can): a list of 0 to 3 distinct configuration names. */
export function ftsConfigsSettingProblem(value: unknown): string | null {
  if (value === null) return null;
  if (!Array.isArray(value)) return `${FTS_CONFIGS_SETTING}: a list of text search configuration names is expected, such as ["english"] or ["english","russian"]`;
  if (value.length > FTS_CONFIGS_MAX) return `${FTS_CONFIGS_SETTING}: at most ${FTS_CONFIGS_MAX} configurations`;
  const seen = new Set<string>();
  for (const v of value) {
    const name = ftsConfigName(v);
    if (name === null) return `${FTS_CONFIGS_SETTING}: "${String(v).slice(0, 40)}" is not a configuration name (lower-case letters and "_", such as "english", "german", "simple")`;
    if (seen.has(name)) return `${FTS_CONFIGS_SETTING}: "${name}" is listed twice`;
    seen.add(name);
  }
  return null;
}

/** The wish of search.fts_configs as a clean list; [] — keep what is applied (also for a value that cannot be read). */
export function desiredFtsConfigs(value: unknown): string[] {
  return ftsConfigsSettingProblem(value) === null && Array.isArray(value) ? (value as string[]) : [];
}

export interface AppliedFts {
  /** What the stored tsv values were built with (names known to this database only). */
  configs: string[];
  /** The configurations of a rebuild in progress, or null. */
  pending: string[] | null;
}

type Q = Pick<pg.Pool | pg.PoolClient, "query">;

const READ_SQL = `SELECT ARRAY(SELECT u.c FROM unnest(rc.fts_configs) WITH ORDINALITY AS u(c, i) WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_ts_config t WHERE t.cfgname = u.c AND pg_catalog.pg_ts_config_is_visible(t.oid)) ORDER BY u.i) AS configs,
        CASE WHEN rc.fts_pending IS NULL THEN NULL
             ELSE ARRAY(SELECT u.c FROM unnest(rc.fts_pending) WITH ORDINALITY AS u(c, i) WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_ts_config t WHERE t.cfgname = u.c AND pg_catalog.pg_ts_config_is_visible(t.oid)) ORDER BY u.i) END AS pending
   FROM retrieval_config rc LIMIT 1`;
/** Schema of an earlier version (no retrieval_config yet): the configuration of the generated column chunks.tsv. */
const LEGACY_SQL = `SELECT substring(pg_get_expr(d.adbin, d.adrelid) FROM 'to_tsvector\\(''([a-z_]+)''::regconfig') AS c
   FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = to_regclass('chunks') AND a.attname = 'tsv' AND a.attgenerated = 's'`;

const clean = (xs: unknown): string[] => (Array.isArray(xs) ? xs : []).map(ftsConfigName).filter((x): x is string => x !== null).slice(0, FTS_CONFIGS_MAX);

/** The applied configurations of one records database; names the database does not know are left out. */
export async function readAppliedFts(q: Q): Promise<AppliedFts> {
  try {
    const row = (await q.query(READ_SQL)).rows[0] as { configs: unknown; pending: unknown } | undefined;
    if (!row) return { configs: [], pending: null };
    return { configs: clean(row.configs), pending: row.pending === null ? null : clean(row.pending) };
  } catch (e) {
    if ((e as { code?: string }).code !== "42P01") throw e;        // no retrieval_config: an older schema
    const c = ftsConfigName((await q.query(LEGACY_SQL)).rows[0]?.c);
    return { configs: c ? [c] : [], pending: null };
  }
}

/**
 * The configurations a query must cover: the applied ones and, during a rebuild, the new ones too (a chunk is in either
 * state). Empty (no row — a defect the health check reports) — "simple", which still matches words as written.
 */
export function queryFtsConfigs(a: AppliedFts): string[] {
  const out = [...a.configs];
  for (const c of a.pending ?? []) if (!out.includes(c)) out.push(c);
  return out.length ? out : ["simple"];
}

/** How long the gateway keeps the applied configurations of a database (at most 30 s). */
export const FTS_CONFIG_CACHE_MS = 30_000;
const cache = new WeakMap<object, { at: number; gen: number; value: Promise<AppliedFts> }>();
let generation = 0;

/** readAppliedFts with a short per-pool cache: one cheap read per database every 30 s, not per search. */
export function appliedFtsCached(pool: Q, now = Date.now()): Promise<AppliedFts> {
  const hit = cache.get(pool);
  if (hit && hit.gen === generation && now - hit.at < FTS_CONFIG_CACHE_MS) return hit.value;
  const value = readAppliedFts(pool);
  cache.set(pool, { at: now, gen: generation, value });
  value.catch(() => { if (cache.get(pool)?.value === value) cache.delete(pool); });
  return value;
}
/** Forget every cached value (tests; a process that has just applied a change itself). */
export function forgetFtsConfigCache(): void {
  generation++;
}
