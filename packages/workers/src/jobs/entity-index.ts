// The registry index of the worker process: the entities of an
// instance (every kind except `person`) by normalised name and alias, held in memory instead of one query per mention.
// A cheap stamp — per kind the row count and the latest updated_at, one GROUP BY query — is checked at most once per
// 60 s; a changed stamp reloads the rows. A connector that writes 100 000 companies does not slow the stage down.
//
// The index holds rows only: no access decision (whether a project is readable is asked per record, for the record's
// owner) and no open-check result. Its names may be up to 60 s old, so the stage reads the name of a linked entity again
// by id before the open-class check of an open record.
//
// The cache is keyed by the pool object (a WeakMap), then by instance: two pools never share an index, a pool that is
// gone takes its index with it, and tests on separate databases do not see each other's rows.
import { normName } from "./named.ts";

/** Anything that runs a parameterised query (a pg pool, a client, a test double). */
export interface Queryable { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }

export interface IndexedEntity { id: string; kind: string; display_name: string; attrs: Record<string, unknown> }

export interface RegistryIndex {
  /** All rows, or the rows of one kind. */
  rows(kind?: string): readonly IndexedEntity[];
  /** Rows of a kind whose display name or one of whose aliases normalises to `norm` (normName). */
  byName(kind: string, norm: string): readonly IndexedEntity[];
}

/** The rows of the index; test doubles answer by this text. */
export const REGISTRY_SQL = "SELECT id, kind, display_name, attrs FROM entities WHERE instance_id = $1 AND kind <> 'person'";
/** The stamp of the rows; test doubles answer by this text. */
export const REGISTRY_STAMP_SQL =
  "SELECT kind, count(*)::bigint::text AS n, max(updated_at)::text AS at FROM entities WHERE instance_id = $1 AND kind <> 'person' GROUP BY kind ORDER BY kind";
/** How long a checked stamp is trusted. */
export const REGISTRY_CHECK_MS = 60_000;

interface Entry { stamp: string; checkedAt: number; index: RegistryIndex }
const cache = new WeakMap<object, Map<string, Entry>>();

const aliasesOf = (attrs: Record<string, unknown> | null | undefined): string[] => {
  const a = attrs?.aliases;
  return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
};

function build(rows: IndexedEntity[]): RegistryIndex {
  const byKind = new Map<string, IndexedEntity[]>();
  const names = new Map<string, Map<string, IndexedEntity[]>>();
  for (const raw of rows) {
    const e: IndexedEntity = { id: raw.id, kind: raw.kind, display_name: raw.display_name, attrs: raw.attrs ?? {} };
    byKind.set(e.kind, [...(byKind.get(e.kind) ?? []), e]);
    let m = names.get(e.kind);
    if (!m) names.set(e.kind, (m = new Map()));
    for (const n of new Set([normName(e.display_name ?? ""), ...aliasesOf(e.attrs).map(normName)])) {
      if (!n) continue;
      const list = m.get(n);
      if (!list) m.set(n, [e]);
      else if (!list.includes(e)) list.push(e);
    }
  }
  const all = rows.length ? [...byKind.values()].flat() : [];
  return {
    rows: (kind) => (kind === undefined ? all : byKind.get(kind) ?? []),
    byName: (kind, norm) => names.get(kind)?.get(norm) ?? [],
  };
}

const stampOf = (rows: Array<{ kind: string; n: string; at: string | null }>): string => JSON.stringify(rows.map((r) => [r.kind, String(r.n), r.at === null ? null : String(r.at)]));

/**
 * The registry index of an instance: from the cache while its stamp was checked less than 60 s ago, otherwise after one
 * stamp query (and one load when the stamp changed). At most two queries per call.
 */
export async function registryIndex(q: Queryable, instanceId: string, now: number = Date.now()): Promise<RegistryIndex> {
  let perPool = cache.get(q);
  if (!perPool) cache.set(q, (perPool = new Map()));
  const entry = perPool.get(instanceId);
  if (entry && now - entry.checkedAt < REGISTRY_CHECK_MS && now >= entry.checkedAt) return entry.index;
  const stamp = stampOf((await q.query(REGISTRY_STAMP_SQL, [instanceId])).rows);
  if (entry && entry.stamp === stamp) {
    entry.checkedAt = now;
    return entry.index;
  }
  const index = build((await q.query(REGISTRY_SQL, [instanceId])).rows as IndexedEntity[]);
  perPool.set(instanceId, { stamp, checkedAt: now, index });
  return index;
}

/** Drops the cached index of a pool (tests that rewrite the registry between cases on one pool). */
export function forgetRegistryIndex(q: object): void {
  cache.delete(q);
}
