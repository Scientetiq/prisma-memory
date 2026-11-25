// manifest.json and index.jsonl of the memory export (contracts/export/manifest.schema.json). The manifest is the last
// entry of a complete archive; an archive that ends without it is incomplete (EXPORT-INCOMPLETE.txt says why).
import { EXPORT_FORMAT } from "./layout.ts";

/** Version of the archive format contract (memory-export). */
export const EXPORT_FORMAT_VERSION = "1.4.0";

export interface ExportScope {
  /** space — one space exported by a person in the workplace; instance — the whole instance, by the server job. */
  kind: "space" | "instance";
  spaces: string[];
  classes: Array<"open" | "closed">;
  originals: boolean;
}

export interface ExportCounts { spaces: number; records: number; originals: number; original_bytes: number }

/** Why records or files are not in the archive: no_access, gone (deleted while exporting), original_missing, … */
export type ExportSkipped = Record<string, number>;

export interface ExportManifest {
  format: typeof EXPORT_FORMAT;
  version: string;
  instance: string;
  created_at: string;
  finished_at: string;
  by: string | null;
  scope: ExportScope;
  counts: ExportCounts;
  skipped: ExportSkipped;
  complete: true;
}

export interface ExportIndexLine { id: string; path: string; md_sha256: string; original_sha256: string | null; bytes: number | null }

export function buildManifest(o: { instance: string; createdAt: Date; finishedAt: Date; by: string | null; scope: ExportScope; counts: ExportCounts; skipped: ExportSkipped }): ExportManifest {
  const skipped: ExportSkipped = {};
  for (const [k, v] of Object.entries(o.skipped)) if (Number.isInteger(v) && v >= 0) skipped[k] = v;
  return {
    format: EXPORT_FORMAT, version: EXPORT_FORMAT_VERSION, instance: o.instance, created_at: o.createdAt.toISOString(),
    finished_at: o.finishedAt.toISOString(), by: o.by, scope: { ...o.scope, spaces: [...o.scope.spaces], classes: [...o.scope.classes] },
    counts: { ...o.counts }, skipped, complete: true,
  };
}

export const indexLine = (l: ExportIndexLine): string =>
  `${JSON.stringify({ id: l.id, path: l.path, md_sha256: l.md_sha256, original_sha256: l.original_sha256, bytes: l.bytes })}\n`;
