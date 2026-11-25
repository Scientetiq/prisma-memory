// One-off check of scans the former converter already accepted: had it done so in production, the memory finds
// such accepted documents and shows their list. The converter's fast mode (master) reads scans with a model and
// counts unchecked lines as readable (its extraction summary): before the conversion queue such a document
// got `extraction_state = ready`, its recognized text and the file itself are already given to agents, and a closed one
// with this mark passes the open check on Open as plain text (open-check-texts.ts looks only at extraction_state).
// The sign is the converter's fast-mode mark (recognized without a second check) in the record text
// (normalizeConverterMarkdown does not cut it).
//
// READ ONLY: records are not changed here (the advised action is the one for earlier accepted documents
// with scans: extraction_state = partial, the file is no longer given to agents, the text stays until the author
// decides). Output: ids, class, space (address and kind) and signs; no text, no titles, no file names.
// Run: run-job.ts master_ocr_report (by hand, once).
import { MASTER_FAST_OCR_NOTE_PG, type DataClass } from "@memory/shared";
import { recordsDb, type DbCtx } from "../ctx.ts";

export interface MasterOcrRecord {
  id: string; class: DataClass; space_id: string; space: string | null; space_kind: string | null;
  /** Agents get the file itself: open class, or closed from the workspace (`keep_closed_on_findings`), not text only. */
  file_to_agents: boolean;
  /** Closed from the workspace: it can be opened or made available to agents — the open check will not see the scan. */
  keep_closed_on_findings: boolean;
  in_trash: boolean;
}

export async function masterOcrReport(ctx: DbCtx): Promise<{ total: number; by_class: Record<DataClass, number>; records: MasterOcrRecord[] }> {
  const found: Array<Omit<MasterOcrRecord, "space" | "space_kind">> = [];
  for (const cls of ["open", "closed"] as const) {
    const rows = (await recordsDb(ctx, cls).query(
      `SELECT r.id, r.space_id, r.deleted_at IS NOT NULL AS in_trash,
              COALESCE(r.attrs->>'keep_closed_on_findings', '') = 'true' AS keep_closed,
              COALESCE(r.attrs->>'original_closed', '') = 'true' AS original_closed
         FROM records r JOIN record_content c ON c.record_id = r.id
        WHERE r.type = 'document' AND r.attrs->'conversion'->>'status' = 'done'
          AND COALESCE(r.attrs->'conversion'->>'extraction_state', 'ready') = 'ready'
          AND c.text ~ $1
        ORDER BY r.id`, [MASTER_FAST_OCR_NOTE_PG])).rows;
    for (const r of rows)
      found.push({ id: r.id, class: cls, space_id: r.space_id, in_trash: r.in_trash === true, keep_closed_on_findings: r.keep_closed === true,
                   file_to_agents: !r.original_closed && (cls === "open" || r.keep_closed === true) });
  }
  const spaceIds = [...new Set(found.map((r) => r.space_id))];
  const spaces = new Map<string, { slug: string; kind: string }>(spaceIds.length
    ? (await ctx.db.control.query("SELECT id, slug, kind FROM spaces WHERE id = ANY($1::uuid[])", [spaceIds])).rows.map((s) => [s.id as string, { slug: s.slug as string, kind: s.kind as string }])
    : []);
  const records = found.map((r) => ({ ...r, space: spaces.get(r.space_id)?.slug ?? null, space_kind: spaces.get(r.space_id)?.kind ?? null }));
  return { total: records.length, by_class: { open: records.filter((r) => r.class === "open").length, closed: records.filter((r) => r.class === "closed").length }, records };
}
