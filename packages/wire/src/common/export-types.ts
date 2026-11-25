// Edge reconciliation hashes (bridge POST /v1/inventory): the twin of the edge database functions edge_inventory and
// edge_projection_commit. The reconciler computes the same SHA-256 of
// what the exporter would send and compares it with the bridge answer line by line, without pulling content back.
//
// The database hashes jsonb text (jsonb_build_array(...)::text). pgJsonText repeats it: separators ", " and ": ",
// object keys by length in bytes, then byte by byte; strings as JSON.stringify; time as edge_ts (UTC, milliseconds).
// Known limit: jsonb keeps a number with a fraction and zeros (1.0, 2.50) at its source precision, while in JS it is
// the same as 1 and 2.5; such values do not occur in the allow-list (integers, strings, booleans).
import { createHash } from "node:crypto";
import type { EdgeEntity, EdgeLink, EdgePerson, EdgeSpace, ProjectionRow, Tree } from "./bridge-api.gen.ts";

/** Reconciliation kinds (body of POST /v1/inventory). meta: edge settings, the key and pgJsonText hash of the value. */
export const INVENTORY_KINDS = ["records", "links", "people", "spaces", "entities", "projection", "originals", "tombstones", "meta"] as const;
export type InventoryKind = (typeof INVENTORY_KINDS)[number];

export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const byteLen = (s: string): number => Buffer.byteLength(s, "utf8");
/** Order of jsonb keys: shorter in bytes first; equal length byte by byte. */
export function jsonbKeyOrder(a: string, b: string): number {
  const la = byteLen(a), lb = byteLen(b);
  if (la !== lb) return la - lb;
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** The value text as PostgreSQL prints it for jsonb. undefined is skipped in an object and is null in an array. */
export function pgJsonText(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("pgJsonText: the number is not finite");
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => pgJsonText(v)).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => jsonbKeyOrder(a, b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${pgJsonText(v)}`).join(", ")}}`;
  }
  throw new Error(`pgJsonText: type ${typeof value}`);
}

/** Time as edge_ts prints it: UTC, milliseconds (extra digits are dropped). */
export function edgeTs(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error("edgeTs: not a time");
  return d.toISOString();
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (xs: readonly string[]): string[] => [...xs].sort(byText);

/** SHA-256 of a whole record (edge_inventory 'records'): record fields, content, fragments, placements, people. */
export function treeInventorySha(tree: Pick<Tree, "record" | "content" | "chunks" | "placements" | "people" | "entities">): string {
  const r = tree.record;
  const content = tree.content === null ? null : [sha256Hex(tree.content.markdown), tree.content.pages, tree.content.duration_sec, tree.content.language];
  const chunks = [...tree.chunks].sort((a, b) => a.ordinal - b.ordinal || byText(a.id, b.id)).map((k) => [k.id, k.ordinal, sha256Hex(k.text)]);
  return sha256Hex(pgJsonText([
    r.id, r.type, r.event_kind, r.space_id, r.title, r.summary_line, edgeTs(r.occurred_at), edgeTs(r.ingested_at),
    edgeTs(r.updated_at), r.owner_id, r.origin, r.method, r.confirmed, r.parent_id, r.locator, r.version, r.is_current,
    r.domain_tags, r.path, r.org_review_state, r.attrs, r.agent_file,
    content, chunks, sorted(tree.placements), sorted(tree.people), sorted(tree.entities),
  ]));
}

export const linkInventorySha = (k: Omit<EdgeLink, "generation">): string =>
  sha256Hex(pgJsonText([k.id, k.src_id, k.dst_id, k.relation, k.status, k.src_quote, k.dst_quote, k.rationale]));

export const personInventorySha = (x: Omit<EdgePerson, "generation">): string =>
  sha256Hex(pgJsonText([x.person_id, x.display_name, x.active, x.external_access, x.login_lc, x.email]));

export const spaceInventorySha = (x: Omit<EdgeSpace, "generation">): string =>
  sha256Hex(pgJsonText([x.space_id, x.slug, x.title, x.kind, x.description, x.readme]));

export const entityInventorySha = (x: Omit<EdgeEntity, "generation">): string =>
  sha256Hex(pgJsonText([x.entity_id, x.kind, x.name, x.slug]));

export const tombstoneInventorySha = (kind: string, id: string, tombGen: number | bigint): string => sha256Hex(`${kind}:${id}:${tombGen}`);

const flag = (b: boolean): string => (b ? "1" : "0");
/** Expiry of a projection line in the hash line: edge_ts, or empty (no expiry). */
const untilText = (u: string | Date | null | undefined): string => (u === null || u === undefined ? "" : edgeTs(u));

/** A projection line for the hash: up to until (end of membership) inclusive; no until means no expiry. */
export type ProjectionLineRow = Pick<ProjectionRow, "person_id" | "space_id" | "can_read"> & { can_write_open: boolean; until?: string | Date | null };

/** A projection line (edge_projection_line): person:space:read:write:expiry. */
export const projectionLine = (r: ProjectionLineRow): string =>
  `${r.person_id}:${r.space_id}:${flag(r.can_read)}:${flag(r.can_write_open)}:${untilText(r.until)}`;

/** Projection check of one person (edge_inventory 'projection'): lines space:read:write:expiry in byte order. */
export function personProjectionSha(rows: ReadonlyArray<{ space_id: string; can_read: boolean; can_write_open: boolean; until?: string | Date | null }>): string {
  return sha256Hex(rows.map((r) => `${r.space_id}:${flag(r.can_read)}:${flag(r.can_write_open)}:${untilText(r.until)}`).sort(byText).join("\n"));
}

/** Sum of the whole projection for a replacement commit (ProjectionCommit.sha256): lines in byte order, by newline. */
export function projectionSha256(rows: ReadonlyArray<ProjectionLineRow>): { rows_total: number; sha256: string } {
  return { rows_total: rows.length, sha256: sha256Hex(rows.map(projectionLine).sort(byText).join("\n")) };
}
