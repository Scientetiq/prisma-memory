// Buttons of people and of the curator of "Company shared knowledge": only
// a person in the workplace (a session; a key, a service "on behalf", a script key and the preview get 403). "Useful" — two marks
// from different departments give "confirmed by the community"; "Wrong / not for everyone" — a correction of kind wrong (by the
// correction rights: applied or proposed) and in org a hold: agents do not find the record till the curator decides. Decisions —
// "Confirm", "Return", "Delete"; "Return" — for the author too. The "Shared knowledge review" queue — for the curator, by pages.
//
// Routes — r.get/post/delete with the path as a string: the maintainers' contract checks compare them with OpenAPI. Limit
// buckets: org_review (marks and views, 120/min), decisions — owner_ops (org_review_decide).
import { commitOrThrow } from "@memory/shared";   // a COMMIT answered with ROLLBACK is an error
import type pg from "pg";
import type { Context, Hono } from "hono";
import { binder, communityReached, communityTeams, exemptKindOf, invalid, isSpaceGuideRow, MemoryError, notFound, ORG_QUEUE_WHERE, orgReviewEnabled, reviewQueueLimit, RETURN_TARGET_SQL, visibleSql, type DataClass, type OrgReviewState } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { byIdSpec, loadReadable, readableSpaces, type RecordRow, type SpaceAccess } from "./access.ts";
import { audit, auditRead } from "./audit.ts";
import { correctTool, CORRECTION_TEXT_MAX, kindApplicable, type CorrectResult } from "./corrections.ts";
import { invalidateHeld, orgSpace, orgUnitsOf, reviewView, type ReviewRow } from "./org-hold.ts";
import { isOrgCurator, orgDelete, orgReturn } from "./org-review.ts";
import { orgTrash } from "./owner.ts";
import { intParam, isUuidParam, offsetCursor } from "./paging.ts";
import { jsonObjectBody, rejectUnknownFields } from "./key-kind.ts";
import { requireHuman } from "./workplace.ts";

type Q = Pick<pg.PoolClient, "query">;
const REVIEWABLE: readonly OrgReviewState[] = ["unreviewed", "confirmed", "community"];
const ACTIVE: readonly OrgReviewState[] = ["unreviewed", "confirmed", "community", "exempt"];
/** The words "Not for everyone" without the person's text — the text of the correction (wrong requires words). */
export const NOT_FOR_ALL_TEXT = "Not for every employee: this information should not be in “Company knowledge”.";
const WHERE = { path: "/review", section: "Company knowledge review" };

/** The person's department at the time of the mark (org table): a member before a manager; none — null ("no department"). */
async function teamOf(app: App, personId: string): Promise<string | null> {
  return (await app.db.control.query(
    "SELECT org_unit_id FROM person_org_units WHERE person_id = $1 ORDER BY (relation = 'member') DESC, created_at, org_unit_id LIMIT 1", [personId])).rows[0]?.org_unit_id ?? null;
}

interface Ctx { rec: RecordRow; db: pg.Pool; spaces: Map<string, SpaceAccess>; inOrg: boolean; unit: ReviewRow | null; orgId: string | null }
/** The record as the person sees it (a session also sees a held one) and its check unit; a record not in org — unit null. */
async function recordCtx(app: App, caller: Caller, id: string): Promise<Ctx> {
  if (!isUuidParam(id)) throw notFound();
  const { rec, db, spaces } = await loadReadable(app, caller, id);
  const org = await orgSpace(app);
  const inOrg = !!org && rec.space_id === org.id;
  const unit = inOrg ? (await orgUnitsOf(app.db.control, db, [rec.id])).get(rec.id) ?? null : null;
  return { rec, db, spaces, inOrg, unit, orgId: org?.id ?? null };
}

/** The record was updated between reading the page and the action: the check unit moved to the new version. */
const UPDATED = () => new MemoryError("in_progress", "The record was just updated. Refresh the page and try again", { retry_after: 5 });

/** The record lock (the same key as for the move and the return). Busy — in_progress. */
async function lockRecord(q: Q, id: string): Promise<void> {
  const ok = (await q.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok", [`record:${id}`])).rows[0]?.ok;
  if (!ok) throw new MemoryError("in_progress", "The record is being moved or a decision is in progress. Try again in a few seconds", { retry_after: 10 });
}

/**
 * The record lock and the check row FOR UPDATE; busy — in_progress. The row is spent (a new version was saved after
 * reading the page, carryOrgReview/enterOrg moved the row to it) — also in_progress: the mark, the hold and the decision do not
 * fall on the old version that neither heldIds nor the curator queue counts; a retry finds the new version's row.
 */
async function lockedUnit(q: Q, id: string): Promise<ReviewRow> {
  await lockRecord(q, id);
  const row = (await q.query("SELECT * FROM org_reviews WHERE record_id = $1 FOR UPDATE", [id])).rows[0];
  if (!row) throw notFound();
  if (row.state === "superseded") throw UPDATED();
  return row;
}

async function inTx<T>(app: App, fn: (q: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await app.db.control.connect();
  try { await c.query("BEGIN"); const out = await fn(c); await commitOrThrow(c); return out; }
  catch (e) { await c.query("ROLLBACK").catch(() => undefined); throw e; }
  finally { c.release(); }
}

// ---------------------------------------------------------------- record view (the record page in the workplace)
export interface RecordReviewView {
  record_id: string; in_org: boolean; on_review: boolean; unit_id: string | null;
  state: OrgReviewState | null; view: string | null; held: boolean; disputed: boolean;
  entered_at: string | null; return_after: string | null; cycle: number | null; returns: number;
  exempt: string | null; extended: boolean; author: boolean; curator: boolean;
  /** Where it will return: slug — only for the author; for others null — "it will return to the author". */
  returns_to: string | null;
  marks: { useful: number; useful_teams: number; wrong: number; mine: { useful: boolean; wrong: "wrong" | "not_for_all" | null } };
  /** Who marked "Wrong" — only for the curator (the one who marked was told that curators will see the name). */
  wrong_marks?: Array<{ login: string; name: string; reason: string; at: string }>;
  can: { useful: boolean; wrong: boolean; confirm: boolean; return: boolean; delete: boolean };
}

async function viewOf(app: App, caller: Caller, x: Ctx): Promise<RecordReviewView> {
  const me = caller.person!.id, author = x.rec.owner_id === me, curator = isOrgCurator(caller, x.spaces), on = orgReviewEnabled(app.settings);
  const u = x.unit;
  const base: RecordReviewView = {
    record_id: x.rec.id, in_org: x.inOrg, on_review: !!u && ACTIVE.includes(u.state), unit_id: u?.record_id ?? null,
    state: u?.state ?? null, view: reviewView(u), held: !!u?.held_at, disputed: !!u?.disputed_at,
    entered_at: u ? new Date(u.entered_at).toISOString() : null, return_after: u?.return_after ? new Date(u.return_after).toISOString() : null,
    cycle: u?.cycle ?? null, returns: u?.returns ?? 0, exempt: u?.exempt_kind ?? null, extended: !!u?.extended, author, curator, returns_to: null,
    marks: { useful: 0, useful_teams: 0, wrong: 0, mine: { useful: false, wrong: null } },
    // a record in org without a check row (an employee card, a record from before the check) — "Wrong" starts a legacy row, only
    // on the live version: an older version gets no mark, else the hold would fall on outdated text
    can: { useful: false, wrong: !x.inOrg || (on && x.rec.is_current !== false), confirm: false, return: false, delete: false },
  };
  if (!x.inOrg) return base;
  if (u) {
    const marks = (await app.db.control.query(
      `SELECT m.person_id, m.kind, m.reason, m.team_id, m.created_at, p.login, p.display_name FROM org_review_marks m LEFT JOIN people p ON p.id = m.person_id
        WHERE m.record_id = $1 ORDER BY m.created_at`, [u.record_id])).rows;
    const useful = marks.filter((m) => m.kind === "useful"), wrong = marks.filter((m) => m.kind === "wrong");
    base.marks = { useful: useful.length, useful_teams: communityReached(marks, x.rec.owner_id, 1).teams, wrong: wrong.length,
                   mine: { useful: useful.some((m) => m.person_id === me), wrong: wrong.find((m) => m.person_id === me)?.reason ?? null } };
    if (curator) base.wrong_marks = wrong.map((m) => ({ login: m.login ?? "", name: m.display_name ?? m.login ?? "", reason: m.reason, at: new Date(m.created_at).toISOString() }));
    if (author && u.from_space_id) base.returns_to = (await app.db.control.query("SELECT slug FROM spaces WHERE id = $1", [u.from_space_id])).rows[0]?.slug ?? null;
    const card = u.exempt_kind === "org_card", active = ACTIVE.includes(u.state);
    base.can = {
      useful: on && !author && REVIEWABLE.includes(u.state) && !caller.person!.demo,
      wrong: on,
      // a kind without return (the profile copy for colleagues; the "How we work" map), written with
      // extended access, — in the queue until the curator decides: "Confirm" takes it out, the state stays exempt
      confirm: curator && active && (u.state === "unreviewed" || u.state === "community" || !!u.held_at || !!u.disputed_at
                                     || (u.state === "exempt" && (u.exempt_kind === "public_profile" || u.exempt_kind === "space_guide")
                                         && u.extended === true && !u.decided_at)),
      return: (curator || author) && active && !card && u.state !== "exempt",
      delete: curator && active && !card && u.state !== "exempt" && !author,
    };
  }
  return base;
}

export async function recordReview(app: App, caller: Caller, id: string): Promise<RecordReviewView> {
  await requireHuman(app, caller, "View the review for a “Company knowledge” record", WHERE);
  return viewOf(app, caller, await recordCtx(app, caller, id));
}

// ---------------------------------------------------------------- "Useful"
export async function markUseful(app: App, caller: Caller, id: string): Promise<RecordReviewView> {
  await requireHuman(app, caller, "Mark “Useful”", WHERE);
  const x = await recordCtx(app, caller, id), me = caller.person!;
  if (!x.inOrg) throw invalid("You can only mark “Company knowledge” records as “Useful”", { reason: "not_org" });
  if (!orgReviewEnabled(app.settings)) throw invalid("The administrator disabled “Company knowledge” record review", { reason: "org_review_disabled" });
  if (me.demo) throw new MemoryError("forbidden", "Demo personas cannot give feedback");
  if (!x.unit || !REVIEWABLE.includes(x.unit.state)) throw invalid("This record is outside the review. You can mark only records awaiting or through curator review as “Useful”", { reason: "not_on_review" });
  if (x.rec.owner_id === me.id) throw invalid("Authors cannot mark their own records as “Useful”", { reason: "author" });
  const team = await teamOf(app, me.id), threshold = communityTeams(app.settings.get<unknown>("access.org_review_community_teams", 2));
  const community = await inTx(app, async (q) => {
    const u = await lockedUnit(q, x.unit!.record_id);
    if (!REVIEWABLE.includes(u.state)) throw notFound();
    await q.query(
      `INSERT INTO org_review_marks (record_id, person_id, kind, reason, team_id, cycle) VALUES ($1, $2, 'useful', NULL, $3, $4)
       ON CONFLICT (record_id, person_id, kind) DO NOTHING`, [u.record_id, me.id, team, u.cycle]);
    if (u.state !== "unreviewed") return false;
    const marks = (await q.query("SELECT person_id, kind, team_id FROM org_review_marks WHERE record_id = $1 AND kind = 'useful'", [u.record_id])).rows;
    if (!communityReached(marks, x.rec.owner_id, threshold).reached) return false;
    // "confirmed by the community": the term no longer applies (the job takes only unreviewed), the row is not final
    await q.query("UPDATE org_reviews SET state = 'community', decided_at = now(), decided_by = NULL, decided_via = 'community' WHERE record_id = $1", [u.record_id]);
    return true;
  });
  await audit(app, caller, { event_type: "confirmation", class: x.rec.class, record_ids: [x.unit.record_id], space_id: x.rec.space_id,
                              details: { tool: "org_review", op: "org_useful", ...(community ? { community: true } : {}), author: x.rec.owner_id } });
  return viewOf(app, caller, await recordCtx(app, caller, id));
}

export async function unmarkUseful(app: App, caller: Caller, id: string): Promise<RecordReviewView> {
  await requireHuman(app, caller, "Remove the “Useful” mark", WHERE);
  const x = await recordCtx(app, caller, id);
  if (!x.unit) throw notFound();
  // "confirmed by the community" is not rolled back: only one's own mark is removed
  const del = await app.db.control.query("DELETE FROM org_review_marks WHERE record_id = $1 AND person_id = $2 AND kind = 'useful'", [x.unit.record_id, caller.person!.id]);
  if (del.rowCount) await audit(app, caller, { event_type: "confirmation", class: x.rec.class, record_ids: [x.unit.record_id], space_id: x.rec.space_id, details: { tool: "org_review", op: "org_unuseful" } });
  return viewOf(app, caller, await recordCtx(app, caller, id));
}

// ---------------------------------------------------------------- "Wrong / not for everyone"
export interface WrongBody { reason: "wrong" | "not_for_all"; text?: string }
export function parseWrongBody(raw: unknown): WrongBody {
  const b = jsonObjectBody(raw, "{reason, text?}");
  rejectUnknownFields(b, ["reason", "text"]);
  if (b.reason !== "wrong" && b.reason !== "not_for_all") throw invalid("reason: wrong (an error; write what is correct) or not_for_all (not for every employee)");
  if (b.text !== undefined && typeof b.text !== "string") throw invalid("text must be a string");
  const text = typeof b.text === "string" && b.text.trim() ? b.text.trim() : undefined;
  if (text && [...text].length > CORRECTION_TEXT_MAX) throw invalid(`text must be up to ${CORRECTION_TEXT_MAX} characters`, { reason: "text_too_long" });
  if (b.reason === "wrong" && !text) throw invalid("“Wrong”: write what is correct (text)", { reason: "text_required" });
  return { reason: b.reason, ...(text ? { text } : {}) };
}

/** The root of the record's tree in org — the unit of a new legacy row (the hold is on the root and hides the whole tree). */
async function rootInOrg(app: App, db: pg.Pool, rec: RecordRow, orgId: string): Promise<{ id: string; audience: string; type: string; source_kind: string; source_ref: string | null }> {
  const r = (await db.query(
    `WITH RECURSIVE up AS (SELECT id, parent_id, 0 AS depth FROM records WHERE id = $1
       UNION ALL SELECT r.id, r.parent_id, u.depth + 1 FROM records r JOIN up u ON r.id = u.parent_id WHERE u.depth < 8)
     SELECT x.id, x.audience::text, x.type::text, x.source_kind::text, x.source_ref, x.space_id FROM up JOIN records x ON x.id = up.id ORDER BY up.depth DESC LIMIT 1`, [rec.id])).rows[0];
  if (r && r.space_id === orgId) return r;
  return { id: rec.id, audience: rec.audience, type: rec.type, source_kind: rec.source_kind, source_ref: rec.source_ref ?? null };
}

export async function markWrong(app: App, caller: Caller, id: string, body: WrongBody): Promise<RecordReviewView & { correction: CorrectResult | null; correction_note: string | null }> {
  await requireHuman(app, caller, "Mark “Wrong, not for everyone”", WHERE);
  const x = await recordCtx(app, caller, id), me = caller.person!;
  const text = body.text ?? (body.reason === "not_for_all" ? NOT_FOR_ALL_TEXT : undefined);
  const holds = x.inOrg && orgReviewEnabled(app.settings);
  // a correction of kind wrong: by the correction rights — applied (the author, the space owner, a meeting participant)
  // or proposed; for a kind where wrong does not apply (a transcript, an employee card), in org — only the hold
  let correction: CorrectResult | null = null, note: string | null = null;
  // the "How we work" map is not changed by a correction (its owner changes it on the map page): in org — only the hold
  const applicable = kindApplicable("wrong", { type: x.rec.type, source_kind: x.rec.source_kind, parent_type: null }) && !isSpaceGuideRow(x.rec);
  if (applicable || !holds) {
    try { correction = (await correctTool(app, caller, { id, kind: "wrong", text, origin: "human" })).result; }
    catch (e) {
      const reason = e instanceof MemoryError ? (e.extra.details as Record<string, unknown> | undefined)?.reason ?? e.extra.reason : null;
      if (!holds || !(e instanceof MemoryError) || !["not_participant", "kind_not_applicable", "not_current"].includes(String(reason))) throw e;
      // the page showed the current version, and it was replaced before the correction — not a soft note but a retry: else
      // the hold would fall on the spent row of the old version (the old version's page — as before, as a note)
      if (reason === "not_current" && x.rec.is_current) throw UPDATED();
      note = e.message;
    }
  } else note = "No correction will be applied to this record. The mark only hides it from AI agents until the curator decides";
  if (!holds) return { ...(await viewOf(app, caller, await recordCtx(app, caller, id))), correction, correction_note: note };
  if (me.demo) throw new MemoryError("forbidden", "Demo personas cannot give feedback");
  const team = await teamOf(app, me.id);
  const unitId = await inTx(app, async (q) => {
    let uid = x.unit?.record_id;
    if (!uid) {
      // a record in org from before the check (or entered with the check off): a legacy row on the root — "confirmed" before, now
      // waits for the curator's decision; an employee card — outside the return
      const root = await rootInOrg(app, x.db, x.rec, x.orgId!);
      // under the root lock (a version of one's own note is written under it). The root itself is marked, but it was replaced
      // by a new version — that has its own row (enterOrg "version"), and a hold on the spent root would not hold it: the page
      // showed the current one — a retry; the old page — "mark the current one". A marked derivative (correction, summary) —
      // the row is on the root, even a replaced one: the derivative stays current under it, its tree holds it, and the hold
      // of the root hides it (heldIds, heldFromReader); a refusal would leave it unheld, though the correction is written above
      await lockRecord(q, root.id);
      if (x.rec.id === root.id) {
        const cur = (await x.db.query("SELECT is_current, superseded_by_id FROM records WHERE id = $1", [root.id])).rows[0];
        if (!cur?.is_current || cur.superseded_by_id) {
          if (x.rec.is_current) throw UPDATED();
          throw invalid("This is an earlier version of the record. Mark the current version", { reason: "not_current" });
        }
      }
      // a kind without return — by the root's source, set by code: an employee card and the "How we work" map that entered
      // with the check off: else a "confirmed" row would give "Return" and "Delete" to the org map
      const kind = exemptKindOf({ via: "legacy", type: root.type, sourceKind: root.source_kind, sourceRef: root.source_ref });
      await q.query(
        `INSERT INTO org_reviews (record_id, instance_id, state, entered_via, entered_human, from_audience, exempt_kind)
         VALUES ($1, $2, $3, 'legacy', false, $4, $5) ON CONFLICT (record_id) DO NOTHING`,
        [root.id, app.instanceId, kind ? "exempt" : "confirmed", root.audience === "people" ? "people" : "space", kind]);
      uid = root.id;
    }
    const u = await lockedUnit(q, uid);
    await q.query(
      `INSERT INTO org_review_marks (record_id, person_id, kind, reason, team_id, correction_id, cycle) VALUES ($1, $2, 'wrong', $3, $4, $5, $6)
       ON CONFLICT (record_id, person_id, kind) DO UPDATE SET reason = EXCLUDED.reason, correction_id = COALESCE(EXCLUDED.correction_id, org_review_marks.correction_id)`,
      [u.record_id, me.id, body.reason, team, correction?.correction_id ?? null, u.cycle]);
    await q.query(
      `UPDATE org_reviews SET held_by = CASE WHEN held_at IS NULL THEN $2::uuid ELSE held_by END, held_at = COALESCE(held_at, now()),
              disputed_at = COALESCE(disputed_at, now()) WHERE record_id = $1`, [u.record_id, me.id]);
    return u.record_id;
  });
  invalidateHeld(app);
  await audit(app, caller, { event_type: "confirmation", class: x.rec.class, record_ids: [unitId], space_id: x.rec.space_id,
                              details: { tool: "org_review", op: "org_wrong", reason: body.reason, held: true, ...(correction ? { correction_id: correction.correction_id } : {}), author: x.rec.owner_id } });
  return { ...(await viewOf(app, caller, await recordCtx(app, caller, id))), correction, correction_note: note };
}

/**
 * Remove one's own "Wrong": no marks left — the hold is removed (agents find it again), "waits for the curator's
 * decision" stays; some left — the earliest of those who marked holds it. The correction stays (withdrawn in "Record edits").
 */
export async function unmarkWrong(app: App, caller: Caller, id: string): Promise<RecordReviewView> {
  await requireHuman(app, caller, "Remove the “Wrong, not for everyone” mark", WHERE);
  const x = await recordCtx(app, caller, id);
  if (!x.unit) throw notFound();
  const removed = await inTx(app, async (q) => {
    const u = await lockedUnit(q, x.unit!.record_id);
    const del = await q.query("DELETE FROM org_review_marks WHERE record_id = $1 AND person_id = $2 AND kind = 'wrong'", [u.record_id, caller.person!.id]);
    if (!del.rowCount) return false;
    const first = (await q.query("SELECT person_id FROM org_review_marks WHERE record_id = $1 AND kind = 'wrong' ORDER BY created_at, person_id LIMIT 1", [u.record_id])).rows[0];
    if (!first) await q.query("UPDATE org_reviews SET held_at = NULL, held_by = NULL WHERE record_id = $1", [u.record_id]);
    else if (u.held_at) await q.query("UPDATE org_reviews SET held_by = $2 WHERE record_id = $1", [u.record_id, first.person_id]);
    return true;
  });
  if (removed) {
    invalidateHeld(app);
    await audit(app, caller, { event_type: "confirmation", class: x.rec.class, record_ids: [x.unit.record_id], space_id: x.rec.space_id, details: { tool: "org_review", op: "org_unwrong" } });
  }
  return viewOf(app, caller, await recordCtx(app, caller, id));
}

// ---------------------------------------------------------------- curator decisions
export interface DecisionAnswer { id: string; state: OrgReviewState; message: string; space?: string | null; deleted?: boolean; author_dismissed?: boolean }

/** A record in the queue (id — a unit or its derivative): live, in org, with a check row; else not_found. */
async function decisionCtx(app: App, caller: Caller, id: string): Promise<Ctx & { unit: ReviewRow }> {
  const x = await recordCtx(app, caller, id);
  if (!x.inOrg || !x.unit) throw notFound();
  return x as Ctx & { unit: ReviewRow };
}

export async function confirmReview(app: App, caller: Caller, id: string): Promise<DecisionAnswer> {
  await requireHuman(app, caller, "Confirm a “Company knowledge” record", WHERE);
  const x = await decisionCtx(app, caller, id);
  if (!isOrgCurator(caller, x.spaces)) throw new MemoryError("forbidden", "Only a “Company knowledge” curator can confirm it", { details: { reason: "not_curator" } });
  const was = await inTx(app, async (q) => {
    const u = await lockedUnit(q, x.unit.record_id);
    if (!ACTIVE.includes(u.state)) throw notFound();
    // the curator's decision removes the hold and "waits for a decision"; the "Wrong" marks are resolved (corrections stay)
    await q.query(
      `UPDATE org_reviews SET state = CASE WHEN state = 'exempt' THEN 'exempt' ELSE 'confirmed' END,
              return_after = CASE WHEN state = 'exempt' THEN return_after END, held_at = NULL, held_by = NULL, disputed_at = NULL,
              decided_at = now(), decided_by = $2, decided_via = 'curator' WHERE record_id = $1`, [u.record_id, caller.person!.id]);
    await q.query("DELETE FROM org_review_marks WHERE record_id = $1 AND kind = 'wrong'", [u.record_id]);
    return u;
  });
  invalidateHeld(app);
  await audit(app, caller, { event_type: "confirmation", class: x.rec.class, record_ids: [x.unit.record_id], space_id: x.rec.space_id,
                              details: { tool: "org_review", op: "org_confirm", was: was.state, ...(was.held_at ? { held: true } : {}), author: x.rec.owner_id } });
  return { id: x.unit.record_id, state: was.state === "exempt" ? "exempt" : "confirmed",
           message: was.held_at ? "Confirmed: the “Wrong” mark was removed, and AI agents can find the record again." : "Confirmed: the “Unconfirmed” label was removed." };
}

export async function returnReview(app: App, caller: Caller, id: string): Promise<DecisionAnswer> {
  await requireHuman(app, caller, "Return a record from “Company knowledge”", WHERE);
  const x = await decisionCtx(app, caller, id);
  const curator = isOrgCurator(caller, x.spaces), author = x.rec.owner_id === caller.person!.id;
  if (!curator && !author) throw new MemoryError("forbidden", "A “Company knowledge” curator or the author can return the record", { details: { reason: "not_curator" } });
  const r = await orgReturn(app, caller, x.unit.record_id, curator && !author ? "curator" : "author");
  invalidateHeld(app);
  // where to — only for the author: others get "returned to the author"
  const named = author && r.space ? r.space : null;
  return { id: r.id, state: "returned", space: named, message: named ? `The record was returned to “${named}”.` : "The record was returned to the author at its original location." };
}

export async function deleteReview(app: App, caller: Caller, id: string): Promise<DecisionAnswer> {
  await requireHuman(app, caller, "Delete a “Company knowledge” record", WHERE);
  const x = await decisionCtx(app, caller, id);
  if (!isOrgCurator(caller, x.spaces)) throw new MemoryError("forbidden", "A “Company knowledge” curator can delete records from “Company knowledge review”", { details: { reason: "not_curator" } });
  const d = await orgDelete(app, caller, x.unit.record_id, orgTrash(app, caller, x.unit.record_id));
  invalidateHeld(app);
  // where to — only for the author; a curator who authored their own record is rare, but they may get the place name
  const named = x.rec.owner_id === caller.person!.id && d.space ? d.space : null;
  const message = d.author_dismissed ? "The author no longer works here, and the record has nowhere to return to. It was moved to Trash directly from “Company knowledge”."
    : d.deleted ? `The record was returned ${named ? `to “${named}”` : "to the author at its original location,"} and moved to Trash there. The author can restore it there, outside “Company knowledge”.`
    : `The record was returned ${named ? `to “${named}”` : "to the author at its original location"}, but could not be deleted there. The author or the owner of that space can delete it.`;
  return { id: d.id, state: "deleted", space: named, deleted: d.deleted ?? false, ...(d.author_dismissed ? { author_dismissed: true } : {}), message };
}

// ---------------------------------------------------------------- the "Shared knowledge review" queue
export interface QueueItem {
  id: string; type: string; class: DataClass; title: string | null; author: { login: string; name: string; active: boolean };
  /** The event kind (decision, task, risk, fact) — only for a record with a title (the same gate); else null. */
  event_kind: string | null;
  state: OrgReviewState; view: string | null; held: boolean; disputed: boolean; entered_at: string; return_after: string | null; overdue: boolean;
  useful: number; wrong: number; wrong_marks: Array<{ login: string; name: string; reason: string; at: string }>;
  extended: boolean; returns: number; cycle: number;
  /**
   * Where from: slug and title — only for the record's author; for a curator of another's record —
   * only the kind (`hidden`: "from a project", "from a team", "from the author's personal space"), even if they read that space.
   */
  from: { slug: string; name: string; kind: string } | { hidden: true; kind: string } | null;
  /** The author left and there is nowhere to return to: no auto-return, the curator decides. */
  no_target: boolean;
  /**
   * The record's readers were narrowed so this curator does not read it (for example, a meeting in org — only for participants):
   * no title (title null); a curator among the readers can open it and decide. Otherwise the field is absent.
   */
  restricted?: true;
}

/**
 * What waits for the curator: unconfirmed ones, those held as "Wrong" (first), "waits for a decision" after all marks are removed
 * and those written with extended access that the curator has not decided yet, though auto-return does not apply to them
 * ("confirmed by the community"). Only records lying in org. By pages of access.org_review_queue_limit (≤ 20).
 */
const QUEUE_WHERE = ORG_QUEUE_WHERE;                  // shared with the mail and the report (@memory/shared org-digest.ts)

export async function reviewQueue(app: App, caller: Caller, o: { limit?: number; cursor?: string }): Promise<{ items: QueueItem[]; total: number; held: number; oldest_entered_at: string | null; limit: number; next_cursor: string | null }> {
  await requireHuman(app, caller, "View “Company knowledge review”", WHERE);
  // the map — as in the read by id (loadReadable, with the archive): a title only for a record the curator would open
  const spaces = await readableSpaces(app, caller, { archived: true });
  if (!isOrgCurator(caller, spaces)) throw notFound();
  const org = await orgSpace(app);
  const max = reviewQueueLimit(app.settings.get<unknown>("access.org_review_queue_limit", 20));
  const limit = Math.min(max, Math.max(1, o.limit ?? max)), offset = offsetCursor(o.cursor);
  if (!org) return { items: [], total: 0, held: 0, oldest_entered_at: null, limit, next_cursor: null };
  const from = `FROM org_reviews r JOIN record_locations l ON l.record_id = r.record_id AND NOT l.deleted AND l.space_id = $2 JOIN people p ON p.id = l.owner_id`;
  const sum = (await app.db.control.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE r.held_at IS NOT NULL)::int AS held, min(r.entered_at) AS oldest ${from} WHERE ${QUEUE_WHERE}`, [app.instanceId, org.id])).rows[0];
  const rows = (await app.db.control.query(
    `SELECT r.*, l.class, l.type, l.owner_id, p.login, p.display_name, p.active AS author_active, (r.return_after IS NOT NULL AND r.return_after <= now()) AS overdue,
            (SELECT count(*)::int FROM org_review_marks m WHERE m.record_id = r.record_id AND m.kind = 'useful') AS useful
       ${from} WHERE ${QUEUE_WHERE}
      ORDER BY (r.held_at IS NOT NULL) DESC, r.held_at NULLS LAST, r.entered_at, r.record_id LIMIT $3 OFFSET $4`, [app.instanceId, org.id, limit + 1, offset])).rows;
  const page = rows.slice(0, limit), ids = page.map((r) => r.record_id as string);
  const wrong = ids.length ? (await app.db.control.query(
    `SELECT m.record_id, m.reason, m.created_at, p.login, p.display_name FROM org_review_marks m LEFT JOIN people p ON p.id = m.person_id
      WHERE m.record_id = ANY($1::uuid[]) AND m.kind = 'wrong' ORDER BY m.created_at`, [ids])).rows : [];
  const targets = new Map(ids.length ? (await app.db.control.query(RETURN_TARGET_SQL, [ids, app.instanceId])).rows.map((t) => [t.record_id as string, t]) : []);
  const fromIds = [...new Set(page.map((r) => r.from_space_id).filter(Boolean))];
  const fromRows = new Map(fromIds.length ? (await app.db.control.query("SELECT id, slug, name, kind FROM spaces WHERE id = ANY($1::uuid[])", [fromIds])).rows.map((s) => [s.id as string, s]) : []);
  // titles: open ones — always; closed ones — only if the session reads closed (T0) — their ids go to the journal (auditRead).
  // And only those the curator reads by id: the readers of an org record are narrowed (a meeting — participants), and the curator
  // is not among them — no title; the row stays in the queue and in the counters, marked restricted
  const titles = new Map<string, string | null>(), restricted = new Set<string>(), shownClosed: string[] = [];
  // the event kind (decision, task…) — together with the title and through the same gate
  const kinds = new Map<string, string | null>();
  for (const cls of ["open", "closed"] as const) {
    const of = page.filter((r) => r.class === cls).map((r) => r.record_id as string);
    if (!of.length || !caller.scope.classes.includes(cls)) continue;
    const args: unknown[] = [], bind = binder(args);
    const visible = visibleSql(byIdSpec(caller, spaces), cls, bind);
    if (visible === null) continue;
    for (const t of (await app.db.records(cls, caller.scope).query(`SELECT r.id, r.title, r.event_kind, ${visible} AS visible FROM records r WHERE r.id = ANY(${bind(of)}::uuid[])`, args)).rows) {
      if (t.visible !== true) { restricted.add(t.id); continue; }
      titles.set(t.id, t.title ?? null);
      kinds.set(t.id, t.event_kind ?? null);
      if (cls === "closed") shownClosed.push(t.id);
    }
  }
  if (shownClosed.length) await auditRead(app, caller, { event_type: "list", class: "closed", result_count: page.length, record_ids: shownClosed, details: { tool: "org_review", op: "queue" } });
  const items: QueueItem[] = page.map((r) => {
    const fs = r.from_space_id ? fromRows.get(r.from_space_id) : undefined;
    const t = targets.get(r.record_id);
    return {
      id: r.record_id, type: r.type, class: r.class, title: titles.has(r.record_id) ? titles.get(r.record_id)! : null,
      event_kind: kinds.get(r.record_id) ?? null,
      author: { login: r.login, name: r.display_name ?? r.login, active: r.author_active === true },
      state: r.state, view: reviewView(r), held: !!r.held_at, disputed: !!r.disputed_at,
      entered_at: new Date(r.entered_at).toISOString(), return_after: r.return_after ? new Date(r.return_after).toISOString() : null, overdue: r.overdue === true,
      useful: r.useful ?? 0, wrong: wrong.filter((m) => m.record_id === r.record_id).length,
      wrong_marks: wrong.filter((m) => m.record_id === r.record_id).map((m) => ({ login: m.login ?? "", name: m.display_name ?? m.login ?? "", reason: m.reason, at: new Date(m.created_at).toISOString() })),
      extended: r.extended === true, returns: r.returns ?? 0, cycle: r.cycle,
      from: fs ? (r.owner_id === caller.person!.id ? { slug: fs.slug, name: fs.name, kind: fs.kind } : { hidden: true as const, kind: fs.kind }) : null,
      no_target: !t?.target && r.exempt_kind !== "org_card",
      ...(restricted.has(r.record_id) ? { restricted: true as const } : {}),
    };
  });
  return { items, total: sum?.total ?? 0, held: sum?.held ?? 0, oldest_entered_at: sum?.oldest ? new Date(sum.oldest).toISOString() : null, limit,
           next_cursor: rows.length > limit ? String(offset + limit) : null };
}

/** The menu counter: for the curator — how many wait and how many are held; others — {curator: false} (no menu item). */
export async function reviewSummary(app: App, caller: Caller): Promise<{ curator: boolean; waiting?: number; held?: number }> {
  await requireHuman(app, caller, "View “Company knowledge review”", WHERE);
  const spaces = await readableSpaces(app, caller);
  if (!isOrgCurator(caller, spaces)) return { curator: false };
  const org = await orgSpace(app);
  if (!org) return { curator: true, waiting: 0, held: 0 };
  const r = (await app.db.control.query(
    `SELECT count(*)::int AS waiting, count(*) FILTER (WHERE r.held_at IS NOT NULL)::int AS held
       FROM org_reviews r JOIN record_locations l ON l.record_id = r.record_id AND NOT l.deleted AND l.space_id = $2 WHERE ${QUEUE_WHERE}`, [app.instanceId, org.id])).rows[0];
  return { curator: true, waiting: r?.waiting ?? 0, held: r?.held ?? 0 };
}

// ---------------------------------------------------------------- routes
export function registerOrgReviewPeople(r: Hono<any>, app: App): void {
  const who = (c: Context, bucket: "org_review" | "org_review_decide"): Caller => { const caller = c.get("caller") as Caller; app.limiter.check(caller, bucket); return caller; };
  const noBody = async (c: Context): Promise<void> => {
    const raw = await c.req.json().catch(() => ({}));
    rejectUnknownFields(jsonObjectBody(raw ?? {}, "{}"), []);
  };
  r.get("/api/v1/records/:id/org-review", async (c) => c.json(await recordReview(app, who(c, "org_review"), c.req.param("id")!)));
  r.post("/api/v1/records/:id/org-review/useful", async (c) => { const caller = who(c, "org_review"); await noBody(c); return c.json(await markUseful(app, caller, c.req.param("id")!)); });
  r.delete("/api/v1/records/:id/org-review/useful", async (c) => c.json(await unmarkUseful(app, who(c, "org_review"), c.req.param("id")!)));
  r.post("/api/v1/records/:id/org-review/wrong", async (c) => {
    const caller = who(c, "org_review");
    const body = parseWrongBody(await c.req.json().catch(() => null));
    return c.json(await markWrong(app, caller, c.req.param("id")!, body));
  });
  r.delete("/api/v1/records/:id/org-review/wrong", async (c) => c.json(await unmarkWrong(app, who(c, "org_review"), c.req.param("id")!)));
  // the counter — before the /:id/… routes (as in "Record edits")
  r.get("/api/v1/me/org-review/summary", async (c) => c.json(await reviewSummary(app, who(c, "org_review"))));
  r.get("/api/v1/me/org-review", async (c) => {
    const caller = who(c, "org_review");
    const raw = c.req.query("limit");
    return c.json(await reviewQueue(app, caller, { limit: raw === undefined ? undefined : intParam(raw, 20, 1, 50, "limit"), cursor: c.req.query("cursor") }));
  });
  r.post("/api/v1/me/org-review/:id/confirm", async (c) => { const caller = who(c, "org_review_decide"); await noBody(c); return c.json(await confirmReview(app, caller, c.req.param("id")!)); });
  r.post("/api/v1/me/org-review/:id/return", async (c) => { const caller = who(c, "org_review_decide"); await noBody(c); return c.json(await returnReview(app, caller, c.req.param("id")!)); });
  r.post("/api/v1/me/org-review/:id/delete", async (c) => { const caller = who(c, "org_review_decide"); await noBody(c); return c.json(await deleteReview(app, caller, c.req.param("id")!)); });
}
