// Meeting decisions for the meeting page of the workspace: the list of decisions and agreements
// is grouped by kind, a task has a due date, the cards of the new processing (events-v3) have people labelled as doers /
// deciders. derived of memory_read lacks these fields, and its output is strict (additionalProperties: false): a new field
// there would break agents with a cached tools/list. Hence a separate route only for a person in the workspace
// (requireHuman first, like the who-sees view and origin): keys, preview, acting on behalf get 403; the meeting by the read
// right (loadReadable: foreign and missing give the same not_found as memory_read); events by the same visibility
// builder as derived (derivedEventsVisible: current ones, no unfinished class move). Showing closed cards
// is logged with the list event, like the correction rows (corrections.ts auditShownClosed). The MCP tools do not change.
import { notFound } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { loadReadable } from "./access.ts";
import { auditRead } from "./audit.ts";
import { dropHeldDerived } from "./org-hold.ts";
import { isUuidParam } from "./paging.ts";
import { derivedEventsVisible } from "./visibility.ts";
import { requireHuman } from "./workplace.ts";

export interface MeetingDecision {
  id: string; event_kind: string | null; title: string | null; due: string | null; actors: string[];
  /** assignee: the doer or the decider (events-v3, attrs.actors_role); speaker: those who spoke (the earlier processing). */
  actors_role: "assignee" | "speaker"; time_from: number | null;
}
export interface MeetingDecisionsView { items: MeetingDecision[] }

/** Cards returned: a meeting has at most 40 (processing.events.max_per_transcript) plus correction versions. */
export const DECISIONS_MAX = 200;

const num = (v: unknown): number | null => (v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

export async function meetingDecisions(app: App, caller: Caller, id: string): Promise<MeetingDecisionsView> {
  await requireHuman(app, caller, "Meeting decisions", { path: `/records/${id}`, section: "Meeting" });
  if (!isUuidParam(id)) throw notFound();
  const { rec, db, spaces } = await loadReadable(app, caller, id);
  if (rec.type !== "transcript") return { items: [] };
  // titles only of those readable by id and not held as wrong in org (for an agent other than the author), like derived
  const rows = (await dropHeldDerived(app, caller, rec, await derivedEventsVisible(db, caller, rec, spaces))).slice(0, DECISIONS_MAX);
  const items: MeetingDecision[] = rows.map((r) => ({
    id: r.id, event_kind: r.event_kind, title: r.title, due: typeof r.due === "string" && r.due.trim() ? r.due.trim().slice(0, 120) : null,
    actors: Array.isArray(r.actors) ? r.actors.map((a: unknown) => String(a).slice(0, 120)).filter(Boolean).slice(0, 20) : [],
    actors_role: r.actors_role === "assignee" ? "assignee" : "speaker", time_from: num(r.time_from),
  }));
  // closed cards (title, due date, people) were shown to a person: a log event, like for the correction rows (no content)
  if (rec.class === "closed" && items.length)
    await auditRead(app, caller, { event_type: "list", class: "closed", record_ids: items.map((d) => d.id), space_id: rec.space_id, details: { op: "decisions_view", meeting_id: rec.id } });
  return { items };
}
