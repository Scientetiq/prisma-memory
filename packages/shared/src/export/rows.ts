// From database rows to export records (format prisma-memory-export/1): one mapping for both entry points — the space
// export of a person (gateway, export/space-export.ts) and the whole-instance job of the server operator (workers,
// jobs/export-instance.ts). What a record carries in the archive is the format contract, so it is written once here;
// which rows may be read, and the audit before reading them, stay with each caller.
import { entityRefOf } from "@memory/mcp-core";
import type { DataClass } from "../db.ts";
import type { ExportRecord } from "./render.ts";

/** What a database handle must do here: pg.Pool, pg.PoolClient or a test double. */
export interface ExportQueryable { query(sql: string, args?: unknown[]): Promise<{ rows: any[] }> }

/** One row of `SELECT ${EXPORT_ROW_SQL} FROM records r LEFT JOIN record_content c ON c.record_id = r.id`. */
export interface ExportRow {
  id: string; type: string; class: DataClass; space_id: string; audience: string; owner_id: string; source_kind: string | null; source_ref: string | null;
  parent_id: string | null; method: string | null; origin: string | null; confirmed_at: Date | null; occurred_at: Date; ingested_at: Date | null;
  title: string | null; summary_line: string | null; event_kind: string | null; domain_tags: string[] | null; version: number;
  supersedes_id: string | null; superseded_by_id: string | null; is_current: boolean; valid_from: Date | null; valid_to: Date | null;
  attrs: Record<string, any> | null; original_key: string | null; original_mime: string | null; original_bytes: string | number | null;
  pages: number | null; duration_sec: number | null;
}

/** Columns of an export row (aliases: r — records, c — record_content). */
export const EXPORT_ROW_SQL = `r.id, r.type, r.class, r.space_id, r.audience, r.owner_id, r.source_kind, r.source_ref, r.parent_id, r.method, r.origin, r.confirmed_at,
  r.occurred_at, r.ingested_at, r.title, r.summary_line, r.event_kind, r.domain_tags, r.version, r.supersedes_id, r.superseded_by_id, r.is_current,
  r.valid_from, r.valid_to, r.attrs, c.original_key, c.original_mime, c.original_bytes, c.pages, c.duration_sec`;

/** Whether the original of a row may be handed out: an open record's file only once its conversion is done (gateway originals.ts CHECKED). */
export const exportOriginalChecked = (r: { class: DataClass; attrs: Record<string, any> | null }): boolean =>
  r.class !== "open" || !r.attrs?.conversion || r.attrs.conversion.status === "done";

/**
 * Reference of an entity in the export — the same as in memory_read and the entity filter of search (gateway
 * space-overview.ts entityKeyOf; a test there keeps the two equal).
 */
// The reference is the shared helper of memory_read and search: `ext:<system>:<kind>:<id>` for an external system.
export const exportEntityRef = (e: { kind: string; external_system: string | null; external_id: string | null }): string =>
  entityRefOf(e);

/** Relations of a batch of records: people listed on them (person ids), entities, applied corrections. */
export interface ExportRelations {
  /** Person ids by record id; the caller resolves them to logins. */
  listed: Map<string, string[]>;
  entities: Map<string, ExportRecord["entities"]>;
  corrections: Map<string, ExportRecord["corrections"]>;
}

const push = <T>(m: Map<string, T[]>, k: string, v: T): void => { (m.get(k) ?? m.set(k, []).get(k)!).push(v); };

/** The relations of the records `ids` from their class database `db` and the entities from `control`. */
export async function loadExportRelations(db: ExportQueryable, control: ExportQueryable, ids: string[]): Promise<ExportRelations> {
  const out: ExportRelations = { listed: new Map(), entities: new Map(), corrections: new Map() };
  if (!ids.length) return out;
  for (const x of (await db.query("SELECT record_id, person_id FROM record_people WHERE record_id = ANY($1::uuid[]) ORDER BY record_id, person_id", [ids])).rows)
    push(out.listed, x.record_id, x.person_id as string);
  const re = (await db.query("SELECT record_id, entity_id, role FROM record_entities WHERE record_id = ANY($1::uuid[]) ORDER BY record_id, entity_id, role", [ids])).rows;
  const eids = [...new Set(re.map((x) => x.entity_id as string))];
  const emap = new Map<string, { kind: string; external_system: string | null; external_id: string | null; display_name: string }>();
  if (eids.length) for (const e of (await control.query("SELECT id, kind, external_system, external_id, display_name FROM entities WHERE id = ANY($1::uuid[])", [eids])).rows) emap.set(e.id, e);
  for (const x of re) {
    const e = emap.get(x.entity_id);
    if (e) push(out.entities, x.record_id, { ref: exportEntityRef(e), display_name: e.display_name, role: x.role });
  }
  for (const x of (await db.query("SELECT id, target_id, kind, status, result_id, created_at FROM record_corrections WHERE target_id = ANY($1::uuid[]) AND status = 'applied' ORDER BY created_at, id", [ids])).rows)
    push(out.corrections, x.target_id, { id: x.id, kind: x.kind, status: x.status, result_id: x.result_id, created_at: x.created_at });
  return out;
}

/** The export record of a row: `slug` — its space, `derived` — ids of its derived records, `people` — logins by person id. */
export function exportRecordOf(r: ExportRow, slug: string, rel: ExportRelations, derived: string[], people: Map<string, string | null>): ExportRecord {
  return {
    id: r.id, type: r.type, event_kind: r.event_kind, title: r.title, summary_line: r.summary_line, space: slug, class: r.class,
    origin: r.origin, method: r.method, source_kind: r.source_kind, source_ref: r.source_ref, occurred_at: r.occurred_at, ingested_at: r.ingested_at,
    owner: people.get(r.owner_id) ?? null, version: r.version, supersedes_id: r.supersedes_id, superseded_by_id: r.superseded_by_id,
    is_current: r.is_current, parent_id: r.parent_id, derived, domains: r.domain_tags ?? [], entities: rel.entities.get(r.id) ?? [],
    people: (rel.listed.get(r.id) ?? []).map((p) => people.get(p)).filter((l): l is string => !!l), audience: r.audience, confirmed: r.confirmed_at !== null,
    valid_from: r.valid_from, valid_to: r.valid_to, attrs: r.attrs, corrections: rel.corrections.get(r.id) ?? [],
  };
}
