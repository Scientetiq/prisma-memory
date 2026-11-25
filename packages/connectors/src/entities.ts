// The only writer of synced entities. Entity items of a connector (companies, deals
// of an external system) do not pass the delivery loop: the worker run or the hooks handler that received them calls
// upsertEntityBatch, which writes the entity registry and the item state rows in batches of at most 500 rows per
// statement. Linking records to these entities is the `entities` stage's job (by name and aliases); nothing here writes
// record_entities.
//
// Rules:
// - The system code is the connector's configured one (`config.system`), never a field of the item; reserved codes are
//   refused.
// - A revoked connector writes nothing. Other statuses (draft, paused, error, needs_reconfirm) are the caller's to check:
//   the worker runs and the hooks handler only call this for a connector they may run.
// - Two instance connectors of one instance never share a system code: when another one has the same code, nothing is
//   written (the admin API refuses that at creation; this is the second line). Revoked and draft connectors do not
//   count; a person-scope connector can never write entities, so it does not count either.
// - Only rows of this system and this instance are written; a row of another system code is a different key, and a row
//   with the same key in another instance is never touched (item `skipped: entity_instance_conflict`).
// - A changed name keeps the previous one as an alias. Aliases: the item's own first, then earlier names newest first,
//   at most 20 (the oldest are dropped); on a rename the previous name always gets a place, so with 20 own aliases the
//   last own alias gives way to it.
// - Aliases the source sent last time and does not send now are removed (`attrs.source.aliases` remembers them);
//   earlier names and aliases other code wrote are kept.
// - Attributes the source sent last time and does not send now are removed (`attrs.source.fields`); attributes other
//   code wrote are kept, but an attribute name the source sends is the source's from then on. `space_id` is refused:
//   other code reads it as the space whose readers may see the entity.
// - An item with a lone surrogate in any string is refused alone (jsonb cannot hold it, and it would fail the whole
//   statement); so is an id whose stored form would not fit the entity key grammar (`entity_id_invalid`).
// - A row with the same natural key but another id (written by hand) is never touched (`entity_id_conflict`).
// - Rows are written in key order, so two calls over the same rows lock them in the same order.
// - An entity is never deleted: a deletion in the source sets `attrs.source_deleted_at`; it is cleared when the entity
//   comes back. An entity is marked only when no other live item row of the connector points to it; an external id that
//   starts to name another entity marks the earlier one on the same rule.
// - Item state rows (`connector_items`, type `entity`) keep the content hash and the entity id (in `record_id`) for change
//   and deletion detection; entity items have no staged body.
import { entityId, newId } from "@memory/shared";
import { BUILTIN_PACKS } from "./registry.ts";
import type { Queryable } from "./secrets.ts";
import { externalEntityKey, RESERVED_SYSTEMS, SYSTEM_CODE } from "./sdk/entity-key.ts";
import { itemHash, validateItem } from "./sdk/items.ts";
import type { EntityItem, Pack } from "./sdk/types.ts";

/** Rows per statement. */
export const ENTITY_BATCH_MAX = 500;
/** Aliases kept per entity. */
export const ENTITY_ALIASES_MAX = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REASON = /^[a-z][a-z0-9_]*(:[a-z0-9_]+)?$/;
/** Half of a surrogate pair without the other half: jsonb refuses it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** Attribute names the writer refuses beyond the contract's reserved ones: other code gives them a meaning. */
export const ENTITY_WRITER_RESERVED_ATTRS: readonly string[] = ["space_id"];

/** True when a string anywhere in the value (keys included) holds a lone surrogate. */
function holdsLoneSurrogate(v: unknown): boolean {
  if (typeof v === "string") return LONE_SURROGATE.test(v);
  if (Array.isArray(v)) return v.some(holdsLoneSurrogate);
  if (typeof v === "object" && v !== null && Object.getPrototypeOf(v) === Object.prototype)
    return Object.entries(v).some(([k, x]) => LONE_SURROGATE.test(k) || holdsLoneSurrogate(x));
  return false;
}

/** Why a whole call wrote nothing; every item gets it as its reason. */
export type EntitySourceCode =
  | "connector_missing"
  | "connector_revoked"
  | "entity_scope"
  | "entity_system:missing"
  | "entity_system:invalid"
  | "entity_system:reserved"
  | "entity_system:taken";

export interface EntityItemOutcome {
  external_id: string;
  type: "entity";
  /** `delivered` — written now; `unchanged` — the row already says the same; `skipped`/`failed` — not written. */
  status: "delivered" | "unchanged" | "skipped" | "failed";
  /** A code for `skipped` and `failed` (the reason codes of the connectors contract). */
  reason?: string;
  /** The entity id, for items that map to an entity of this instance. */
  entity_id?: string;
}

export interface EntityBatchResult {
  inserted: number;
  updated: number;
  unchanged: number;
  /** Items not written: refused by the connector rules, invalid, duplicated in the call or held by another instance. */
  refused: number;
  /** One outcome per item, in input order. */
  items: EntityItemOutcome[];
}

export interface EntityWriteOptions {
  /** The complete run that listed the items: recorded as `seen_run` for deletion detection of pull sources. */
  runId?: string;
  /** Packs of the build (tests pass their own). */
  packs?: readonly Pack[];
}

interface Source { system: string }

/** The connector's system code, or the code that refuses the whole call. One statement. */
async function entitySource(q: Queryable, instanceId: string, connectorId: string, packs: readonly Pack[]): Promise<Source | EntitySourceCode> {
  if (typeof connectorId !== "string" || !UUID.test(connectorId) || typeof instanceId !== "string" || instanceId === "") return "connector_missing";
  const { rows } = await q.query(
    "SELECT c.scope, c.status, c.pack, CASE WHEN jsonb_typeof(c.config -> 'system') = 'string' THEN c.config ->> 'system' END AS system, "
    + "EXISTS (SELECT 1 FROM connectors o WHERE o.instance_id = c.instance_id AND o.id <> c.id AND o.scope = 'instance' "
    + "AND o.status NOT IN ('revoked', 'draft') AND o.config ->> 'system' = c.config ->> 'system') AS taken "
    + "FROM connectors c WHERE c.id = $1 AND c.instance_id = $2",
    [connectorId, instanceId]);
  const row = rows[0] as { scope: string; status: string; pack: string | null; system: string | null; taken: boolean } | undefined;
  if (!row) return "connector_missing";
  if (row.status === "revoked") return "connector_revoked";
  if (row.scope !== "instance") return "entity_scope";
  const refused = entitySystemRefusal(row.system, row.pack, packs);
  if (refused) return refused;
  if (row.taken) return "entity_system:taken";
  return { system: row.system! };
}

/**
 * Why a connector with this system code (its `config.system`) may not write entities, or null; `pack` and `packs` are
 * not read. Pure: the admin API checks the same rule when a connector is created or changed; uniqueness of the code inside
 * the instance is checked against the database.
 */
export function entitySystemRefusal(system: unknown, pack: string | null, packs: readonly Pack[] = BUILTIN_PACKS):
    Exclude<EntitySourceCode, "connector_missing" | "connector_revoked" | "entity_scope" | "entity_system:taken"> | null {
  if (typeof system !== "string" || system === "") return "entity_system:missing";
  if (!SYSTEM_CODE.test(system)) return "entity_system:invalid";
  if (RESERVED_SYSTEMS.includes(system)) return "entity_system:reserved";
  return null;
}

const externalIdOf = (item: unknown): string =>
  typeof item === "object" && item !== null && typeof (item as { external_id?: unknown }).external_id === "string" ? (item as { external_id: string }).external_id : "";

const reasonOf = (code: string): string => (REASON.test(code) && code.length <= 64 ? code : "item_invalid");

interface Row {
  item_id: string;
  ext_id: string;
  ext_version: string | null;
  hash: string;
  id: string;
  kind: string;
  eid: string;
  name: string;
  aliases: string[];
  attrs: Record<string, string | number | boolean>;
  url: string | null;
  /** Position in the statement (key order). */
  ord: number;
}

// One statement per batch: read the current rows, merge names, aliases and attributes, write the entities, then the item
// state rows with the outcome of each entity. $1 rows (in key order), $2 instance, $3 system, $4 connector, $5 run.
const UPSERT = `
WITH input AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(item_id uuid, ext_id text, ext_version text, hash text, id uuid, kind text,
                                                  eid text, name text, aliases jsonb, attrs jsonb, url text, ord integer)
),
cur AS (
  SELECT i.*, e.id AS e_id, e.instance_id AS e_inst, e.display_name AS e_name, e.attrs AS e_attrs, ci.record_id AS old_record
  FROM input i
  LEFT JOIN entities e ON e.kind = i.kind AND e.external_system = $3 AND e.external_id = i.eid
  LEFT JOIN connector_items ci ON ci.connector_id = $4::uuid AND ci.item_type = 'entity' AND ci.external_id = i.ext_id
),
judged AS (
  SELECT c.*, CASE WHEN c.e_inst IS NOT NULL AND c.e_inst <> $2 THEN 'entity_instance_conflict'
                   WHEN c.e_id IS NOT NULL AND c.e_id <> c.id THEN 'entity_id_conflict' END AS conflict
  FROM cur c
),
merged AS (
  SELECT c.*, (c.conflict IS NOT NULL) AS foreign_row,
    ((COALESCE(c.e_attrs, '{}'::jsonb)
        - ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(c.e_attrs #> '{source,fields}') = 'array'
                                                     THEN c.e_attrs #> '{source,fields}' ELSE '[]'::jsonb END))
        - 'aliases' - 'source' - 'source_deleted_at')
      || c.attrs
      || jsonb_build_object(
           'aliases', (SELECT COALESCE(jsonb_agg(k.a ORDER BY k.grp, k.pos), '[]'::jsonb) FROM (
               SELECT d.a, d.grp, d.pos FROM (
                 SELECT DISTINCT ON (u.a) u.a, u.grp, u.pos FROM (
                   SELECT t.value AS a, 0 AS grp, t.ordinality AS pos FROM jsonb_array_elements_text(c.aliases) WITH ORDINALITY AS t
                   UNION ALL
                   SELECT c.e_name, 1, 0 WHERE c.e_name IS NOT NULL AND c.e_name <> c.name
                   UNION ALL
                   -- earlier aliases, without those the source sent last time (it sends its current ones again above)
                   SELECT t.value, 2, t.ordinality FROM jsonb_array_elements_text(
                       CASE WHEN jsonb_typeof(c.e_attrs -> 'aliases') = 'array' THEN c.e_attrs -> 'aliases' ELSE '[]'::jsonb END) WITH ORDINALITY AS t
                    WHERE NOT (CASE WHEN jsonb_typeof(c.e_attrs #> '{source,aliases}') = 'array'
                                    THEN c.e_attrs #> '{source,aliases}' ELSE '[]'::jsonb END) ? t.value
                 ) u WHERE u.a <> c.name AND btrim(u.a) <> ''
                 ORDER BY u.a, u.grp, u.pos
               ) d
               ORDER BY (d.grp = 1 OR (
                          d.grp = 2 AND d.pos = ${ENTITY_ALIASES_MAX}
                          AND c.e_name = c.name AND c.aliases = (c.e_attrs #> '{source,aliases}')
                          AND jsonb_array_length(c.aliases) = ${ENTITY_ALIASES_MAX}
                        )) DESC NULLS LAST,
                        d.grp, d.pos LIMIT ${ENTITY_ALIASES_MAX}   -- the previous name always gets a place
             ) k),
           'source', jsonb_strip_nulls(jsonb_build_object(
               'connector_id', $4::text,
               'url', c.url,
               'fields', (SELECT COALESCE(jsonb_agg(f ORDER BY f), '[]'::jsonb) FROM jsonb_object_keys(c.attrs) AS f),
               'aliases', CASE WHEN jsonb_array_length(c.aliases) > 0 THEN c.aliases END)))
    ) AS new_attrs
  FROM judged c
),
ent AS (
  INSERT INTO entities (id, kind, external_system, external_id, display_name, attrs, instance_id)
  SELECT m.id, m.kind, $3, m.eid, m.name, m.new_attrs, $2 FROM merged m WHERE NOT m.foreign_row ORDER BY m.ord
  ON CONFLICT (kind, external_system, external_id) DO UPDATE
     SET display_name = EXCLUDED.display_name, attrs = EXCLUDED.attrs
   WHERE entities.instance_id = EXCLUDED.instance_id AND entities.id = EXCLUDED.id
     AND (entities.display_name, entities.attrs) IS DISTINCT FROM (EXCLUDED.display_name, EXCLUDED.attrs)
  RETURNING entities.id, (entities.xmax = 0) AS inserted
),
itm AS (
  INSERT INTO connector_items (id, connector_id, item_type, external_id, external_version, content_hash, status, reason, record_id,
                               seen_run, delivered_at)
  SELECT m.item_id, $4::uuid, 'entity', m.ext_id, m.ext_version, decode(m.hash, 'hex'),
         CASE WHEN m.foreign_row THEN 'skipped' WHEN e.id IS NOT NULL THEN 'delivered' ELSE 'unchanged' END,
         m.conflict,
         CASE WHEN m.foreign_row THEN NULL ELSE m.id END,
         $5::uuid,
         CASE WHEN e.id IS NOT NULL THEN now() END
  FROM merged m LEFT JOIN ent e ON e.id = m.id ORDER BY m.ord
  ON CONFLICT (connector_id, item_type, external_id) DO UPDATE
     SET external_version = EXCLUDED.external_version, content_hash = EXCLUDED.content_hash, status = EXCLUDED.status,
         reason = EXCLUDED.reason, record_id = EXCLUDED.record_id, seen_run = COALESCE(EXCLUDED.seen_run, connector_items.seen_run),
         delivered_at = COALESCE(EXCLUDED.delivered_at, connector_items.delivered_at), received_at = now()
  RETURNING connector_items.external_id
)
SELECT m.ext_id, m.conflict, e.inserted, (e.id IS NOT NULL) AS written, (SELECT count(*) FROM itm) AS items,
       CASE WHEN NOT m.foreign_row AND m.old_record IS NOT NULL AND m.old_record <> m.id THEN m.old_record END AS moved_from
FROM merged m LEFT JOIN ent e ON e.id = m.id`;

/** Marks entities as deleted in the source unless a live item row of the connector (outside `$5`) still points to them. */
const MARK = `
UPDATE entities e SET attrs = e.attrs || jsonb_build_object('source_deleted_at', to_jsonb(now()))
 WHERE e.id = ANY($1::uuid[]) AND e.instance_id = $2 AND e.external_system = $3 AND NOT (e.attrs ? 'source_deleted_at')
   AND NOT EXISTS (SELECT 1 FROM connector_items o
                    WHERE o.connector_id = $4::uuid AND o.item_type = 'entity' AND o.record_id = e.id
                      AND o.status <> 'deleted_at_source' AND NOT (o.external_id = ANY($5::text[])))
RETURNING e.id`;

/**
 * Writes entity items of one connector into the entity registry. `connectorId` is a connector of `instanceId` with scope
 * `instance` and a system code in its config. Any number of items: they are de-duplicated (the last item of an
 * external id, and of an entity, wins) and written in statements of at most 500 rows, after one statement that reads
 * the connector. Each statement is atomic; a failure of one batch leaves the batches before it written.
 */
export async function upsertEntityBatch(q: Queryable, instanceId: string, connectorId: string, items: readonly EntityItem[],
                                        opts: EntityWriteOptions = {}): Promise<EntityBatchResult> {
  const outcomes: EntityItemOutcome[] = items.map((it) => ({ external_id: externalIdOf(it), type: "entity", status: "failed" }));
  const result: EntityBatchResult = { inserted: 0, updated: 0, unchanged: 0, refused: 0, items: outcomes };
  const finish = (): EntityBatchResult => {
    result.refused = outcomes.filter((o) => o.status === "skipped" || o.status === "failed").length;
    return result;
  };
  if (items.length === 0) return result;
  if (opts.runId !== undefined && (typeof opts.runId !== "string" || !UUID.test(opts.runId))) throw new TypeError("runId must be a UUID");

  const source = await entitySource(q, instanceId, connectorId, opts.packs ?? BUILTIN_PACKS);
  if (typeof source === "string") {
    for (const o of outcomes) { o.status = "skipped"; o.reason = source; }
    return finish();
  }

  // valid items with their keys; the last item of one external id, and of one entity, wins
  const byExternal = new Map<string, number>();
  const byEntity = new Map<string, number>();
  const rows = new Map<number, Row>();
  items.forEach((item, i) => {
    const o = outcomes[i]!;
    const problems = item?.type === "entity" ? validateItem(item) : [{ code: "item_invalid:type" }];
    if (problems.length > 0) { o.reason = reasonOf(problems[0]!.code); return; }
    if (holdsLoneSurrogate(item)) { o.reason = "item_invalid:surrogate"; return; }
    if (Object.keys(item.attrs ?? {}).some((a) => ENTITY_WRITER_RESERVED_ATTRS.includes(a))) { o.reason = "item_invalid:reserved_attr"; return; }
    const name = item.name.trim();
    if (name === "") { o.reason = "item_invalid:name"; return; }
    const k = externalEntityKey(source.system, item.kind, item.id);
    if (!k.ok) { o.reason = k.code; return; }
    const id = entityId(k.key);
    o.entity_id = id;
    for (const [map, at] of [[byExternal, item.external_id], [byEntity, id]] as const) {
      const prev = map.get(at);
      if (prev !== undefined && rows.has(prev)) {
        rows.delete(prev);
        outcomes[prev]!.status = "skipped";
        outcomes[prev]!.reason = "entity_duplicate";
      }
      map.set(at, i);
    }
    const aliases = [...new Set((item.aliases ?? []).map((a) => a.trim()).filter((a) => a !== "" && a !== name))];
    rows.set(i, {
      item_id: newId(), ext_id: item.external_id, ext_version: item.external_version ?? null, hash: itemHash(item), id,
      kind: k.key.kind, eid: k.key.externalId, name, aliases, attrs: { ...(item.attrs ?? {}) }, url: item.url ?? null, ord: 0,
    });
  });

  // key order: two calls over the same rows lock them in the same order (no deadlock)
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const order = [...rows.keys()].sort((a, b) => {
    const x = rows.get(a)!, y = rows.get(b)!;
    return cmp(x.kind, y.kind) || cmp(x.eid, y.eid) || a - b;
  });
  const moved = new Set<string>();
  const written = new Set<string>();
  for (let start = 0; start < order.length; start += ENTITY_BATCH_MAX) {
    const batch = order.slice(start, start + ENTITY_BATCH_MAX).map((i, n) => { const r = rows.get(i)!; r.ord = n; return i; });
    const at = new Map(batch.map((i) => [rows.get(i)!.ext_id, i]));
    const { rows: out } = await q.query(UPSERT, [JSON.stringify(batch.map((i) => rows.get(i)!)), instanceId, source.system, connectorId, opts.runId ?? null]);
    for (const r of out as Array<{ ext_id: string; conflict: string | null; inserted: boolean | null; written: boolean; moved_from: string | null }>) {
      const o = outcomes[at.get(r.ext_id)!]!;
      written.add(r.ext_id);
      if (r.moved_from) moved.add(r.moved_from);
      if (r.conflict) {
        o.status = "skipped";
        o.reason = r.conflict;
        delete o.entity_id;
      } else if (r.written) {
        o.status = "delivered";
        if (r.inserted) result.inserted++; else result.updated++;
      } else {
        o.status = "unchanged";
        result.unchanged++;
      }
    }
  }
  // an entity listed under two external ids: the losing item was listed by this run too, so its row stays seen
  const listed = opts.runId === undefined ? [] : [...new Set(outcomes
    .filter((o) => o.reason === "entity_duplicate" && !written.has(o.external_id)).map((o) => o.external_id))];
  if (listed.length > 0) {
    await q.query("UPDATE connector_items SET seen_run = $3::uuid WHERE connector_id = $1::uuid AND item_type = 'entity' AND external_id = ANY($2::text[])",
      [connectorId, listed, opts.runId]);
  }
  // an external id that names another entity now: the earlier one is gone from the source unless another item lists it
  if (moved.size > 0) await q.query(MARK, [[...moved], instanceId, source.system, connectorId, []]);
  return finish();
}

export interface EntityDeleteResult {
  /** Item state rows marked `deleted_at_source`. */
  items: number;
  /** Entities that got `attrs.source_deleted_at` now (an entity marked before is not counted again). */
  marked: number;
  /** Set when the connector rules refused the call; nothing was marked. */
  refused?: EntitySourceCode;
}

/**
 * Marks entity items of one connector as deleted in the source: the item rows become `deleted_at_source` and their
 * entities get `attrs.source_deleted_at` (database time) — unless another item row of the connector that is not being
 * marked still points to the same entity (one entity listed under two external ids). Rows are never deleted. Unknown
 * external ids are ignored. One statement after the connector check (any number of ids).
 */
export async function markEntitiesDeleted(q: Queryable, instanceId: string, connectorId: string, externalIds: readonly string[],
                                          opts: Pick<EntityWriteOptions, "packs"> = {}): Promise<EntityDeleteResult> {
  const ids = [...new Set(externalIds.filter((x) => typeof x === "string" && x !== ""))];
  if (ids.length === 0) return { items: 0, marked: 0 };
  const source = await entitySource(q, instanceId, connectorId, opts.packs ?? BUILTIN_PACKS);
  if (typeof source === "string") return { items: 0, marked: 0, refused: source };
  const { rows } = await q.query(
    `WITH it AS (
       UPDATE connector_items SET status = 'deleted_at_source', reason = NULL, received_at = now()
        WHERE connector_id = $1 AND item_type = 'entity' AND external_id = ANY($2::text[])
       RETURNING record_id
     ), ent AS (
       UPDATE entities e SET attrs = e.attrs || jsonb_build_object('source_deleted_at', to_jsonb(now()))
         FROM (SELECT DISTINCT record_id FROM it WHERE record_id IS NOT NULL) d
        WHERE e.id = d.record_id AND e.instance_id = $3 AND e.external_system = $4 AND NOT (e.attrs ? 'source_deleted_at')
          AND NOT EXISTS (SELECT 1 FROM connector_items o
                           WHERE o.connector_id = $1 AND o.item_type = 'entity' AND o.record_id = e.id
                             AND o.status <> 'deleted_at_source' AND NOT (o.external_id = ANY($2::text[])))
       RETURNING e.id
     )
     SELECT (SELECT count(*) FROM it)::int AS items, (SELECT count(*) FROM ent)::int AS marked`,
    [connectorId, ids, instanceId, source.system]);
  return { items: rows[0].items, marked: rows[0].marked };
}
