// The summary of a meeting and its list of decisions come from the same cards. An events prompt with
// `summary_actions: events` in its header makes code build the summary's actions section from the current action cards
// (with people's corrections): after the events stage the section of the current summary is replaced; a repeated summary
// stage builds it at once. The other sections of the summary stay as the model wrote them.
import type { DataClass } from "@memory/shared";
import { recordsDb, type Ctx, type DbCtx } from "../ctx.ts";
import { loadPromptVersion, replaceActionsSection, summaryActionLines } from "../pipeline/index.ts";
import { replaceDerived, type Rec } from "./common.ts";

export function summaryFromCards(version: unknown): boolean {
  if (typeof version !== "string" || !version) return false;
  try { return loadPromptVersion(version).meta.summary_actions === "events"; } catch { return false; }
}

export const extractedWith = (rec: Pick<Rec, "attrs">): unknown => rec.attrs?.extraction?.prompt;

const num = (v: unknown): number | null => (v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

export async function cardActionLines(ctx: DbCtx, cls: DataClass, meetingId: string): Promise<string[]> {
  const rows = (await recordsDb(ctx, cls).query(
    `SELECT title, attrs->'actors' AS actors, attrs->>'due' AS due, locator->>'time_from' AS time_from FROM records
      WHERE parent_id = $1 AND type = 'event' AND event_kind = 'action' AND is_current AND deleted_at IS NULL AND hidden_at IS NULL
      ORDER BY created_at, id`, [meetingId])).rows;
  return summaryActionLines(rows.map((r) => ({ title: r.title, actors: Array.isArray(r.actors) ? r.actors : [], due: r.due, time_from: num(r.time_from) })));
}

export async function withCardActions(ctx: DbCtx, cls: DataClass, rec: Pick<Rec, "id" | "attrs">, md: string): Promise<string> {
  if (!summaryFromCards(extractedWith(rec))) return md;
  return replaceActionsSection(md, await cardActionLines(ctx, cls, rec.id));
}

export async function rebuildSummaryActions(ctx: Ctx, cls: DataClass, rec: Rec): Promise<boolean> {
  const cur = (await recordsDb(ctx, cls).query(
    `SELECT r.title, r.summary_line, r.processor, r.attrs, c.text FROM records r JOIN record_content c ON c.record_id = r.id
      WHERE r.parent_id = $1 AND r.type = 'summary' AND r.source_kind = 'pipeline' AND r.is_current AND r.deleted_at IS NULL AND r.hidden_at IS NULL
      ORDER BY r.created_at DESC, r.id LIMIT 1`, [rec.id])).rows[0];
  if (!cur || typeof cur.text !== "string") return false;
  const text = replaceActionsSection(cur.text, await cardActionLines(ctx, cls, rec.id));
  if (text === cur.text) return false;
  const res = await replaceDerived(ctx, rec, "summary", [{
    type: "summary", title: cur.title ?? "Summary", text, summaryLine: cur.summary_line ?? null,
    processor: { ...(cur.processor ?? {}), actions_from: "events" }, attrs: cur.attrs ?? {},
  }], { keepWhenRefused: true });
  return res.ids.length > 0;
}
