// "What my agent sees": GET /api/v1/me/agent-view — counts only, for a person in the
// workspace — and PUT /api/v1/me/upload-default — the person's default for new records in the personal space. Also
// POST /api/v1/me/agent-view/open-plan — a bulk "show to agents" plan (op open) of the person's own hidden records.
//
// The numbers are exact, not locator estimates:
//  - visible and spaces[].open — the per-space count that memory_me returns to a personal key of the same person
//    (spaceRecordCounts with a personal key's caller and the open class): a session's own visibility differs (it sees records
//    held in the company space, seesHeld), so the agent's caller is built explicitly and is used only for these two reads;
//  - hidden — one aggregate in the closed database over the person's own current records;
//  - held_by_check — locators of the person's closed records with an open-check mark (control database);
//  - meetings_with_me — the predicate of "Meetings with me" (myMeetingsCount);
//  - can_open_in_bulk and bulk_open.eligible — the rule of a bulk "show to agents" plan (bulk-open.ts), the same SQL
//    the plan runs, so the button never offers a number the plan will not build.
// Counts are not content: no audit read event (as memory_me). A part that fails becomes null and is named in `incomplete`.
import type { Hono } from "hono";
import { MemoryError, log, notFound, type DataClass } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { readableSpaces, resolveSpace } from "./access.ts";
import { scopeFor } from "./auth.ts";
import { audit } from "./audit.ts";
import { isHumanSession } from "./workplace.ts";
import { isExternal } from "./channel.ts";
import { myMeetingsCount } from "./my-meetings.ts";
import { spaceRecordCounts } from "./write.ts";
import { effectiveUploadDefault, uploadDefaultPolicy, type EffectiveUploadDefault } from "./upload-default.ts";
import { uploadDefaultText } from "./upload-default.messages.ts";
import { BULK_OPEN_TYPES, bulkOpenCandidates, bulkOpenState, type BulkOpenType } from "./bulk-open.ts";
import { bulkOpenText } from "./bulk-open.messages.ts";
import { openPreview, planTool, type OpenPreview } from "./plans.ts";

export const AGENT_VIEW_PATH = "/api/v1/me/agent-view";
export const UPLOAD_DEFAULT_PATH = "/api/v1/me/upload-default";
export const OPEN_PLAN_PATH = "/api/v1/me/agent-view/open-plan";

type Part = "visible" | "hidden" | "held_by_check" | "meetings" | "bulk_open";

export interface AgentViewSpace { slug: string; name: string; kind: string; default_class: DataClass; archived: boolean; open: number | null; hidden_mine: number | null }
export interface AgentView {
  visible: number | null; hidden_mine: number | null; meetings_with_me: number | null;
  spaces: AgentViewSpace[];
  hidden_mine_by_type: Record<string, number>;
  hidden_mine_by_state: { can_open_in_bulk: number | null; held_by_check: number | null; meetings: number | null };
  upload_default: EffectiveUploadDefault;
  /** Bulk "show to agents": available now, how many records a plan would take in all, how many one plan takes. */
  bulk_open: { enabled: boolean; eligible: number | null; max_items: number };
  incomplete: Part[];
}

/** A human workspace session, otherwise 403 with an English text (requireHuman's text is not English yet). */
function human(caller: Caller): void {
  if (!isHumanSession(caller)) throw new MemoryError("forbidden", uploadDefaultText("human_only"), { hint: uploadDefaultText("human_only_hint") });
}

/**
 * The caller of the person's own agent: a personal key of tier T2 (the open class only), not a preview, not on behalf, not a
 * script. Used only to read counts with the visibility of an agent; it never reaches audit(), a write or a record answer.
 */
export function agentCallerOf(caller: Caller): Caller {
  return { ...caller, keyKind: "personal", tier: "T2", scope: scopeFor("personal", "T2"), clientKind: null, preview: false, onBehalfOf: false };
}

async function part<T>(name: Part, incomplete: Part[], fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); } catch (e) {
    incomplete.push(name);
    log.warn("agent_view_part_failed", { part: name, error: e instanceof MemoryError ? e.code : String((e as Error)?.name ?? "error") });
    return null;
  }
}

export async function agentView(app: App, caller: Caller): Promise<AgentView> {
  human(caller);
  const me = caller.person!.id;
  const incomplete: Part[] = [];
  const all = [...(await readableSpaces(app, caller, { archived: true })).values()];
  const active = all.filter((s) => !s.archived_at);
  const agent = agentCallerOf(caller);
  const open = await part("visible", incomplete, () => spaceRecordCounts(app, agent, active.map((s) => s.id), ["open"]));
  const hidden = await part("hidden", incomplete, async () => (await app.db.records("closed", caller.scope).query(
    `SELECT r.space_id, r.type, count(*)::int AS n, count(*) FILTER (WHERE r.type = 'transcript' OR p.type = 'transcript')::int AS m
       FROM records_live r LEFT JOIN records p ON p.id = r.parent_id WHERE r.owner_id = $1 GROUP BY 1, 2`, [me])).rows as Array<{ space_id: string; type: string; n: number; m: number }>);
  const held = await part("held_by_check", incomplete, async () => (await app.db.control.query(
    "SELECT count(*)::int AS n FROM record_locations WHERE owner_id = $1 AND class = 'closed' AND NOT deleted AND open_check IS NOT NULL", [me])).rows[0].n as number);
  const meetings = await part("meetings", incomplete, () => myMeetingsCount(app, caller));
  const bulk = bulkOpenState(app);
  const eligible = await part("bulk_open", incomplete, async () => (await bulkOpenCandidates(app, caller, new Map(all.map((s) => [s.id, s])), { limit: 1 })).total);
  const hiddenBySpace = new Map<string, number>(), byType: Record<string, number> = {};
  let hiddenTotal = 0, hiddenMeetings = 0;
  for (const r of hidden ?? []) {
    hiddenBySpace.set(r.space_id, (hiddenBySpace.get(r.space_id) ?? 0) + r.n);
    byType[r.type] = (byType[r.type] ?? 0) + r.n;
    hiddenTotal += r.n; hiddenMeetings += r.m;
  }
  const listed = all.filter((s) => !s.archived_at || (hiddenBySpace.get(s.id) ?? 0) > 0)
    .sort((a, b) => Number(!!a.archived_at) - Number(!!b.archived_at) || a.slug.localeCompare(b.slug));
  return {
    visible: open === null ? null : active.reduce((n, s) => n + (open.get(s.id)?.records ?? 0), 0),
    hidden_mine: hidden === null ? null : hiddenTotal,
    meetings_with_me: meetings,
    spaces: listed.map((s) => ({ slug: s.slug, name: s.name, kind: s.kind, default_class: s.default_class, archived: !!s.archived_at,
                                 open: s.archived_at ? 0 : open === null ? null : open.get(s.id)?.records ?? 0,
                                 hidden_mine: hidden === null ? null : hiddenBySpace.get(s.id) ?? 0 })),
    hidden_mine_by_type: byType,
    hidden_mine_by_state: { can_open_in_bulk: eligible, held_by_check: held, meetings: hidden === null ? null : hiddenMeetings },
    upload_default: await effectiveUploadDefault(app, me),
    bulk_open: { enabled: bulk.enabled, eligible, max_items: bulk.maxItems },
    incomplete,
  };
}

/** PUT body: exactly {value: "closed" | "open" | null}. */
export function parseUploadDefaultBody(raw: unknown): "closed" | "open" | null {
  const invalidValue = () => new MemoryError("invalid_argument", uploadDefaultText("value_invalid"), { details: { field: "value" } });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalidValue();
  const body = raw as Record<string, unknown>;
  // there is no person parameter: any other field is refused by name (the shared helpers still speak Russian)
  const extra = Object.keys(body).filter((k) => k !== "value");
  if (extra.length) throw new MemoryError("invalid_argument", uploadDefaultText("unknown_fields", { fields: extra.join(", ") }), { details: { unknown: extra } });
  if (!("value" in body) || !(body.value === null || body.value === "closed" || body.value === "open")) throw invalidValue();
  return body.value;
}

export async function setUploadDefault(app: App, caller: Caller, value: "closed" | "open" | null): Promise<EffectiveUploadDefault> {
  human(caller);
  if (!uploadDefaultPolicy(app).choice)
    throw new MemoryError("forbidden", uploadDefaultText("choice_disabled"), { details: { reason: "choice_disabled" } });
  const me = caller.person!.id;
  // one statement: the sub-select sees the row before the update, so the event carries the value it replaced
  const from = (await app.db.control.query(
    `UPDATE people p SET upload_default = $2 FROM (SELECT upload_default AS old FROM people WHERE id = $1 AND instance_id = $3) o
      WHERE p.id = $1 AND p.instance_id = $3 RETURNING o.old`, [me, value, app.instanceId])).rows[0]?.old ?? null;
  await audit(app, caller, { event_type: "admin", details: { op: "upload_default_set", from, to: value } });
  return effectiveUploadDefault(app, me);
}

/** POST body of the open plan: a JSON object with only `space` (a slug, `me`) and `types` (a non-empty subset of document, note). */
export function parseOpenPlanBody(raw: unknown): { space?: string; types?: BulkOpenType[] } {
  const bad = (id: "body_invalid" | "space_invalid" | "types_invalid", field?: string) => new MemoryError("invalid_argument", bulkOpenText(id), { details: field ? { field } : {} });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad("body_invalid");
  const body = raw as Record<string, unknown>;
  const extra = Object.keys(body).filter((k) => k !== "space" && k !== "types");
  if (extra.length) throw new MemoryError("invalid_argument", bulkOpenText("unknown_fields", { fields: extra.join(", ") }), { details: { unknown: extra } });
  const out: { space?: string; types?: BulkOpenType[] } = {};
  if ("space" in body) {
    if (typeof body.space !== "string" || !body.space.trim() || body.space.length > 200) throw bad("space_invalid", "space");
    out.space = body.space;
  }
  if ("types" in body) {
    const t = body.types;
    if (!Array.isArray(t) || !t.length || new Set(t).size !== t.length || !t.every((x) => (BULK_OPEN_TYPES as readonly unknown[]).includes(x))) throw bad("types_invalid", "types");
    out.types = t as BulkOpenType[];
  }
  return out;
}

export type OpenPlanAnswer = Record<string, unknown> & { status: string; eligible_total: number; plan_id?: string; totals?: { items: number; cascade: number; spaces: number };
                                                       open_preview?: OpenPreview };

/**
 * A bulk "show to agents" plan: a person in the workspace only, not on the external agents' address (otherwise 403
 * forbidden, reason human_session_required, before any read), only while bulk open and the open check are on (403 with the reason). The newest `max_items`
 * eligible records become the plan; `eligible_total` says how many there are in all. The plan is applied by the existing
 * apply route, in the workspace only. No eligible record — no plan and no audit event.
 */
export async function openPlan(app: App, caller: Caller, raw: unknown): Promise<OpenPlanAnswer> {
  if (!isHumanSession(caller) || isExternal(caller)) throw new MemoryError("forbidden", bulkOpenText("human_only"), { hint: uploadDefaultText("human_only_hint"), details: { reason: "human_session_required" } });
  const st = bulkOpenState(app);
  if (st.reason) throw new MemoryError("forbidden", bulkOpenText(st.reason === "bulk_open_disabled" ? "disabled" : "check_disabled"), { details: { reason: st.reason } });
  const req = parseOpenPlanBody(raw);
  const spaces = await readableSpaces(app, caller);
  const space = req.space ? await resolveSpace(app, caller, req.space, spaces) : null;
  if (req.space && !space) throw notFound();
  if (space?.kind === "org") throw new MemoryError("invalid_argument", bulkOpenText("space_org"), { details: { reason: "org_one_by_one" } });
  const { ids, total } = await bulkOpenCandidates(app, caller, spaces, { spaceId: space?.id, types: req.types, limit: st.maxItems });
  if (!ids.length) return { status: "empty", eligible_total: 0 };
  const criteria = { ...(space ? { space_id: space.id } : {}), ...(req.types ? { types: req.types } : {}) };
  const { result } = await planTool(app, caller, { op: "open", ids }, { fromAgentView: true, criteria });
  if (!("plan_id" in result)) return { ...result, eligible_total: total };
  return { ...result, eligible_total: total, open_preview: await openPreview(app, result.plan_id, spaces) };
}

export function registerAgentView(r: Hono<any>, app: App): void {
  r.get(AGENT_VIEW_PATH, async (c) => {
    const caller = c.get("caller") as Caller;
    app.limiter.check(caller, "agent_view");
    return c.json(await agentView(app, caller));
  });
  r.put(UPLOAD_DEFAULT_PATH, async (c) => {
    const caller = c.get("caller") as Caller;
    app.limiter.check(caller, "me_keys");
    human(caller);
    const value = parseUploadDefaultBody(await c.req.json().catch(() => null));
    return c.json(await setUploadDefault(app, caller, value));
  });
  r.post(OPEN_PLAN_PATH, async (c) => {
    const caller = c.get("caller") as Caller;
    app.limiter.check(caller, "memory_plan");
    const text = await c.req.text();
    let body: unknown;
    try { body = text.trim() ? JSON.parse(text) : {}; } catch { body = null; }
    return c.json(await openPlan(app, caller, body));
  });
}
