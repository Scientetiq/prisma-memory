// Version chains (one rule for agent notes and documents). A newer version of a record sits next to the older one
// (supersedes_id / superseded_by_id). Owner operations (close, open, move, delete, purge), the worker's class move and the
// open check walk the tree AND the chain: otherwise an older text would stay open after "close" or live on after "delete".
// What counts as a chain is defined here once: both rows are roots (no parent) and their source kinds are in one group of
// CHAIN_KIND_GROUPS — agent notes (`agent`: own notes, work profile, space guide) or documents (`upload`, `folder`).
// A note and a document never form a chain; derived records (meeting events, corrections) have no chain of their own.

const ALIAS = /^[a-z_]+$/;
const alias = (a: string): string => {
  if (!ALIAS.test(a)) throw new Error(`version-chain: bad SQL alias ${JSON.stringify(a)}`);
  return a;
};
const kindList = (kinds: readonly string[]): string => kinds.map((k) => `'${k}'`).join(",");

/** Source kinds of documents whose root rows form a version chain (uploads now, folder connectors later). */
export const DOC_CHAIN_KINDS = ["upload", "folder"] as const;

/** Source kinds whose root rows may form a version chain; a chain never mixes two groups. */
export const CHAIN_KIND_GROUPS: readonly (readonly string[])[] = [["agent"], DOC_CHAIN_KINDS];

/**
 * SQL condition "rows `a` and `b` are linked as versions of one chain" (the caller joins them by supersedes_id /
 * superseded_by_id): both are roots and both source kinds are in one group. `a`, `b` are alias literals written in code.
 */
export const chainLinkSql = (a: string, b: string): string => {
  const x = alias(a), y = alias(b);
  const groups = CHAIN_KIND_GROUPS.map((g) => `(${x}.source_kind IN (${kindList(g)}) AND ${y}.source_kind IN (${kindList(g)}))`);
  return `(${x}.parent_id IS NULL AND ${y}.parent_id IS NULL AND (${groups.join(" OR ")}))`;
};

/** SQL condition "row `a` is a root of a kind that can be in a version chain" (sites that look at older members alone). */
export const chainMemberSql = (a: string): string => {
  const x = alias(a);
  return `(${x}.parent_id IS NULL AND ${x}.source_kind IN (${kindList(CHAIN_KIND_GROUPS.flat())}))`;
};

/** Record types that can have a version chain — a shortcut that saves a query; the SQL predicate is the rule. */
export const chainTypes: readonly string[] = ["note", "event", "document"];
export const isChainType = (type: string): boolean => chainTypes.includes(type);

/**
 * CTEs `chain` (the version chain of record `param` by the chain rule, chainLinkSql: agent notes or documents) and `tree`
 * (the chain and all its derived rows, deleted and hidden rows included — callers filter). It replaces the former
 * `WITH RECURSIVE tree AS (SELECT id FROM records WHERE id = $1 UNION ALL …)`: the query then reads `tree`.
 */
export const chainTreeSql = (param = "$1"): string => `WITH RECURSIVE chain AS (
    SELECT id, parent_id, supersedes_id, superseded_by_id, source_kind FROM records WHERE id = ${param}
    UNION SELECT r.id, r.parent_id, r.supersedes_id, r.superseded_by_id, r.source_kind FROM records r JOIN chain c
      ON r.id IN (c.supersedes_id, c.superseded_by_id) AND ${chainLinkSql("c", "r")}
  ), tree AS (SELECT id FROM chain UNION SELECT r.id FROM records r JOIN tree t ON r.parent_id = t.id)`;

/** The tree with the version chain of record `$1` (chain rule of chainLinkSql) — the former TREE plus the versions. */
export const CHAIN_TREE = chainTreeSql("$1");

export const CHAIN_HEAD = `WITH RECURSIVE up AS (
    SELECT id, parent_id, superseded_by_id, source_kind, 0 AS depth FROM records WHERE id = $1
    UNION SELECT r.id, r.parent_id, r.superseded_by_id, r.source_kind, u.depth + 1 FROM records r JOIN up u
      ON r.id = u.superseded_by_id AND ${chainLinkSql("u", "r")}
      AND u.depth < 1000
  ) SELECT id FROM up ORDER BY depth DESC LIMIT 1`;

export const CHAIN_HEAD_CUT = `SELECT EXISTS (SELECT 1 FROM records h JOIN records r ON r.id = h.superseded_by_id
    WHERE h.id = $1 AND ${chainLinkSql("h", "r")}) AS cut`;

export const CHAIN_HEADS = `WITH RECURSIVE up AS (
    SELECT id AS start, id, parent_id, superseded_by_id, source_kind, 0 AS depth FROM records WHERE id = ANY($1::uuid[])
    UNION SELECT u.start, r.id, r.parent_id, r.superseded_by_id, r.source_kind, u.depth + 1 FROM records r JOIN up u
      ON r.id = u.superseded_by_id AND ${chainLinkSql("u", "r")}
      AND u.depth < 1000
  ) SELECT DISTINCT ON (start) start AS id, id AS head FROM up ORDER BY start, depth DESC`;

export const CHAIN_MEMBERS = `WITH RECURSIVE down AS (
    SELECT id AS head, id, parent_id, supersedes_id, source_kind, 0 AS depth FROM records WHERE id = ANY($1::uuid[])
    UNION SELECT d.head, r.id, r.parent_id, r.supersedes_id, r.source_kind, d.depth + 1 FROM records r JOIN down d
      ON r.id = d.supersedes_id AND ${chainLinkSql("d", "r")}
      AND d.depth < 1000
  ) SELECT DISTINCT head, id FROM down`;

export const CHAIN_TREES = `WITH RECURSIVE chain AS (
    SELECT id AS start, id, parent_id, supersedes_id, superseded_by_id, source_kind FROM records WHERE id = ANY($1::uuid[])
    UNION SELECT c.start, r.id, r.parent_id, r.supersedes_id, r.superseded_by_id, r.source_kind FROM records r JOIN chain c
      ON r.id IN (c.supersedes_id, c.superseded_by_id) AND ${chainLinkSql("c", "r")}
  ), tree AS (SELECT start, id FROM chain UNION SELECT t.start, r.id FROM records r JOIN tree t ON r.parent_id = t.id)`;
