// "Make available to agents" in the administrator panel: the morning report lines
// `class_moves.by_word.despite` and the rollback of showings in teams and projects — "Shown in teams and projects" (GET
// /admin/despite/shown) and "Hide the shown" (POST /admin/despite/hide). Only ids, the space, the author's login and
// the accepted rules — without content and without consent fingerprints.
import type { Hono } from "hono";
import { despiteSettings, invalid, OPEN_CHECK_UNCHECKED } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { audit } from "./audit.ts";
import { jsonObjectBody, rejectUnknownFields } from "./key-kind.ts";
import { chainHeads, LAST_LIVE_MOVES, liveSharedHeads, SHOWING_SHARED_SQL, SHOWN_SHARED_SQL } from "./despite-shown.ts";
import { closeMove } from "./owner.ts";
import { intParam, offsetCursor } from "./paging.ts";

type AdminAudit = (c: any, op: string, details?: Record<string, unknown>) => Promise<void>;
const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);

/** Showing despite a finding — opening by a person in the workplace with accepted rules or "as text only" (without rules). */
export const DESPITE_MOVE_SQL = "(m.confirmation = 'human_workplace' AND (m.accepted_rules IS NOT NULL OR m.text_only))";
/** The worker's refusal of such a move (a recheck, the gate, "never open") — not a move failure. */
export const DESPITE_REFUSED_SQL = "(m.error LIKE 'open_check%' OR m.error LIKE 'never_open:%')";

export type DespiteRefusal = "changed" | "audience" | "no_write" | "disabled" | "found" | "never_open" | "other";
/** The worker's "not checked" texts (`open_check:<text>` with no findings: check server busy, out of time, failure, no text). */
const UNCHECKED_ERRORS: readonly string[] = Object.values(OPEN_CHECK_UNCHECKED).map((t) => `open_check:${t}`);

/**
 * Reason by the start of `error` (the worker writes the gate code first: `open_check:gate=<code>: …`): consent gates by code,
 * other gates (`rules`, `consent_needed`) — other; the recheck found something (`open_check:looks like …`) — found. "Not
 * checked" (the check server busy even after all tries, out of time, failure, `open_check_busy:` — a retry mark) — other, not
 * found: the check found nothing, it was not done in time.
 */
export function despiteRefusal(error: string | null | undefined): DespiteRefusal {
  const e = String(error ?? "");
  if (e.startsWith("never_open:")) return "never_open";
  const gate = /^open_check:gate=([a-z_]+):/.exec(e)?.[1];
  if (gate) return (["changed", "audience", "no_write", "disabled"] as const).find((g) => g === gate) ?? "other";
  if (e.startsWith("open_check_busy") || UNCHECKED_ERRORS.some((u) => e.startsWith(u))) return "other";
  return e.startsWith("open_check:") ? "found" : "other";
}

export interface DespiteReport {
  solo: number; personal_shared: number; team: number; project: number; text_only: number;
  refused: Record<DespiteRefusal, number>;
  recent: Array<{ record_id: string; space_slug: string | null; space_kind: string | null; author_login: string | null; at: string | null; rules: string[]; text_only: boolean; scope: string | null }>;
}

/**
 * Showings in the report window: finished moves, the space kind — by `accepted_space_id` (where the author gave consent).
 * Rows from before the space fields (no scope, no space) count only in `human_workplace` of the common part. Refusals: failed
 * such moves, by reason; the last 20 showings — without record text.
 */
export async function despiteReport(app: App, hours: number): Promise<DespiteReport> {
  const ctl = app.db.control;
  const FROM = `FROM class_moves m JOIN people p ON p.id = m.requested_by AND p.instance_id = $1 LEFT JOIN spaces s ON s.id = m.accepted_space_id`;
  const WINDOW = "m.finished_at > now() - make_interval(hours => $2)";
  const [counts, refusals, recent] = await Promise.all([
    ctl.query(`SELECT count(*) FILTER (WHERE m.accepted_scope = 'solo')::int AS solo,
                      count(*) FILTER (WHERE m.accepted_scope = 'shared' AND s.kind = 'personal')::int AS personal_shared,
                      count(*) FILTER (WHERE s.kind = 'team')::int AS team,
                      count(*) FILTER (WHERE s.kind = 'project')::int AS project,
                      count(*) FILTER (WHERE m.text_only)::int AS text_only
               ${FROM} WHERE m.status = 'done' AND ${DESPITE_MOVE_SQL} AND ${WINDOW}`, [app.instanceId, hours]).then((r) => r.rows[0] ?? {}),
    ctl.query(`SELECT m.error ${FROM} WHERE m.status = 'failed' AND ${DESPITE_MOVE_SQL} AND ${DESPITE_REFUSED_SQL} AND ${WINDOW}`, [app.instanceId, hours]).then((r) => r.rows),
    ctl.query(`SELECT m.record_id, m.finished_at, m.accepted_rules, m.text_only, m.accepted_scope, s.slug, s.kind, p.login
               ${FROM} WHERE m.status = 'done' AND ${DESPITE_MOVE_SQL} AND ${WINDOW} ORDER BY m.finished_at DESC, m.id LIMIT 20`, [app.instanceId, hours]).then((r) => r.rows),
  ]);
  const refused: Record<DespiteRefusal, number> = { changed: 0, audience: 0, no_write: 0, disabled: 0, found: 0, never_open: 0, other: 0 };
  for (const r of refusals) refused[despiteRefusal(r.error as string)]++;
  return {
    solo: Number(counts.solo ?? 0), personal_shared: Number(counts.personal_shared ?? 0), team: Number(counts.team ?? 0),
    project: Number(counts.project ?? 0), text_only: Number(counts.text_only ?? 0), refused,
    recent: recent.map((m) => ({ record_id: m.record_id as string, space_slug: (m.slug as string | null) ?? null, space_kind: (m.kind as string | null) ?? null,
                                 author_login: (m.login as string | null) ?? null, at: iso(m.finished_at), rules: (m.accepted_rules as string[] | null) ?? [],
                                 text_only: m.text_only === true, scope: (m.accepted_scope as string | null) ?? null })),
  };
}

/** At most this many records per call of "Hide the shown"; the rest — `left`, the button is pressed again. */
export const DESPITE_HIDE_BATCH = 500;
/** How many running showings the rollback names busy per call (a repeated press picks them up). */
const DESPITE_BUSY_MAX = 500;

/**
 * Records shown now despite a finding so that not only the authors see them: the record is open and not deleted, its last
 * NOT FAILED move is a finished showing by a workplace person with the shared scope (despite-shown.ts). One closed after the
 * showing (by the author, the space owner, the rollback) is not listed: its last move is a closing. A failed move did not
 * change the record: a failed "Hide from agents" of the author or space owner is rolled back by the worker (close_failed),
 * the record stays open and visible to agents — without this filter the "Hide the shown" rollback would silently skip it.
 * A failed closing by the rollback itself (via despite_rollback) does not return it to agents — it is hidden, the reconciler
 * repeats the closing; it stays in the list, and a repeated press is the same repeat by hand.
 * The version chain of one's own note is one row: the old version keeps its old showing, the head — its
 * new one; both locators are open. Rows whose head was already met above (the list is newest first) are excluded by the query
 * (`$4`), so both the pages and `total` count the chain once; in the answer the record is the head (the rollback closes it).
 * The live showing of a chain is the last not failed move of ALL its versions: the head was closed, returned to
 * personal and shown "only to you" — the old version's "not only to you" showing does not pull it into the rollback (same `$4`).
 */
const SHOWN_FROM = `FROM ${LAST_LIVE_MOVES}
  JOIN record_locations l ON l.record_id = m.record_id AND l.class = 'open' AND NOT l.deleted`;
const SHOWN_IDS_SQL = `SELECT m.record_id ${SHOWN_FROM} WHERE ${SHOWN_SHARED_SQL} ORDER BY m.finished_at DESC, m.record_id LIMIT ${50_000}`;
const SHOWN_SQL = `
  SELECT m.record_id, m.finished_at, m.accepted_rules, m.text_only, l.owner_id, l.space_id, s.slug, s.kind, p.login, count(*) OVER ()::int AS total
  ${SHOWN_FROM}
  LEFT JOIN spaces s ON s.id = l.space_id LEFT JOIN people p ON p.id = l.owner_id
  WHERE ${SHOWN_SHARED_SQL} AND NOT (m.record_id = ANY($4::uuid[]))
  ORDER BY m.finished_at DESC, m.record_id LIMIT $2 OFFSET $3`;
/**
 * Shown "not only to you" content lying in the trash: the rollback does not close deleted content — a deleted record
 * cannot be closed — but a restore with showing off brings it back closed (owner.ts restoreFromTrash).
 * Counted by trash batches: a version chain is deleted in one batch. The showing is the last not failed move of the whole batch,
 * the same rule as for the restore (lastMoveShownShared).
 */
const SHOWN_IN_TRASH_SQL = `SELECT count(*)::int AS n FROM (
    SELECT DISTINCT ON (COALESCE(l.deleted_batch, l.record_id)) m0.* FROM class_moves m0 JOIN people p0 ON p0.id = m0.requested_by AND p0.instance_id = $1
      JOIN record_locations l ON l.record_id = m0.record_id AND l.class = 'open' AND l.deleted AND (l.purge_after IS NULL OR l.purge_after > now())
     WHERE m0.status <> 'failed'
     ORDER BY COALESCE(l.deleted_batch, l.record_id), m0.requested_at DESC, m0.id DESC) m
  WHERE ${SHOWN_SHARED_SQL}`;
/**
 * "Not only to you" showings that are still moving: they are not in the "Hide the shown" list yet. With
 * showing off the worker rejects them (the gate on the copy, a switch check before deleting the source, on
 * resuming — before and after the open check), and one that passed the check before the switch-off it completes —
 * the rollback names them busy, and a repeated press closes what opened after all.
 */
const SHOWING_SQL = `SELECT m.record_id FROM ${LAST_LIVE_MOVES} WHERE ${SHOWING_SHARED_SQL} ORDER BY m.record_id LIMIT ${DESPITE_BUSY_MAX}`;
/**
 * How many "not only to you" showings are still moving: they are not in `total`, and after "Hide from agents"
 * the list may empty while such a showing completes — the panel keeps the rollback, writes "still moving", not "nothing shown".
 */
const SHOWING_COUNT_SQL = `SELECT count(*)::int AS n FROM ${LAST_LIVE_MOVES} WHERE ${SHOWING_SHARED_SQL}`;

/**
 * The page of the shown: rows without chain repeats and without chains whose last move is no longer a "not only to you" showing,
 * and the head of each row. `liveTotal` — how many such rows (live heads) in all, regardless of the offset:
 * `count(*) OVER ()` exists only for page rows, and past the list end — after a rollback, while the administrator stays on a
 * far page — there are no rows, and before, `total` was `null`, which the panel showed as zero though shown content remained.
 */
async function shownPage(app: App, limit: number, offset: number) {
  const ctl = app.db.control, open = app.db.recordsForWrite("open", "system");
  const all = (await ctl.query(SHOWN_IDS_SQL, [app.instanceId])).rows.map((r) => r.record_id as string);
  const heads = await chainHeads(open, all);
  const live = await liveSharedHeads(open, ctl, [...new Set(all.map((id) => heads.get(id) ?? id))]);
  const seen = new Set<string>(), dupes: string[] = [];
  for (const id of all) { const h = heads.get(id) ?? id; if (seen.has(h) || !live.has(h)) dupes.push(id); else seen.add(h); }
  const { rows } = await ctl.query(SHOWN_SQL, [app.instanceId, limit, offset, dupes]);
  return { rows: rows.map((m) => ({ ...m, head: heads.get(m.record_id as string) ?? (m.record_id as string) })), liveTotal: seen.size };
}

export function registerDespiteAdmin(r: Hono<any>, app: App, adminAudit: AdminAudit): void {
  const ctl = app.db.control;
  r.get("/despite/shown", async (c) => {
    const limit = intParam(c.req.query("limit"), 100, 1, 500), offset = offsetCursor(c.req.query("cursor"));
    const [{ rows, liveTotal }, trash, showing] = await Promise.all([shownPage(app, limit + 1, offset), ctl.query(SHOWN_IN_TRASH_SQL, [app.instanceId]),
                                                               ctl.query(SHOWING_COUNT_SQL, [app.instanceId])]);
    return c.json({
      items: rows.slice(0, limit).map((m) => ({ record_id: m.head, space_slug: (m.slug as string | null) ?? null, space_kind: (m.kind as string | null) ?? null,
                                               author_login: (m.login as string | null) ?? null, shown_at: iso(m.finished_at), rules: (m.accepted_rules as string[] | null) ?? [],
                                               text_only: m.text_only === true })),
      // total — not by the offset: past the list end (an empty page) — the number of live heads of the same selection, not null
      next_cursor: rows.length > limit ? String(offset + limit) : null, total: Number(rows[0]?.total ?? liveTotal),
      in_trash: Number(trash.rows[0]?.n ?? 0), showing: Number(showing.rows[0]?.n ?? 0),
    });
  });

  /**
   * The rollback: close everything shown in teams and projects. Only after
   * the `open_check.despite_projects` switch — else authors show it again at once. It closes on behalf of the record's author
   * (`requested_by` — the author, `via: despite_rollback`): the worker moves it as an ordinary closing, the author sees it in "My
   * actions" (`close_rollback`). A closing does not recall what agents read. A version chain of one's own note — one request per
   * head. Showings that are still moving — in `busy`: a repeated press closes what opened after all.
   * Deleted content in the trash is not closed — the restore with showing off closes it.
   */
  r.post("/despite/hide", async (c) => {
    const body = jsonObjectBody(await c.req.json().catch(() => null), "{confirm: true}");
    rejectUnknownFields(body, ["confirm"]);
    if (body.confirm !== true) throw invalid("Set confirm to true to confirm");
    await app.settings.load(true).catch(() => undefined);
    if (despiteSettings(app.settings).projects)
      throw invalid("Turn off showing in teams and projects first", { reason: "despite_projects_on" });
    const { rows } = await shownPage(app, DESPITE_HIDE_BATCH, 0);
    const caller = c.get("caller") as Caller;
    let queued = 0;
    const busy: string[] = [];
    for (const m of rows) {
      const out = await closeMove(app, { recordId: m.head, requestedBy: m.owner_id, via: "despite_rollback" }).catch((e) => {
        if ((e as { code?: string }).code === "not_found") return { already: "" } as const;   // deleted after the selection
        throw e;
      });
      if ("busy" in out) { busy.push(m.head); continue; }
      if (!("moveId" in out)) continue;   // the closing already runs or the record is already closed
      queued++;
      await audit(app, caller, { event_type: "class_move", class: "open", record_ids: [out.recordId], space_id: m.space_id,
                                 details: { op: "close", move_id: out.moveId, by: "admin_rollback", author: m.owner_id } });
    }
    for (const r0 of (await ctl.query(SHOWING_SQL, [app.instanceId])).rows)
      if (!busy.includes(r0.record_id as string)) busy.push(r0.record_id as string);
    const total = Number(rows[0]?.total ?? 0);
    await adminAudit(c, "despite_hide", { queued, busy });
    return c.json({ queued, busy, left: Math.max(0, total - rows.length) + busy.length });
  });
}
