// Curators of "Company shared knowledge": a record entering org for the check, leaving, versions, return and
// deletion by the curator, the administrator's service handles. Pure rules and the return are in @memory/shared (org-review.ts,
// org-return.ts), shared with the worker. Rows are in control, without content; terms use the base's now().
//
// Who is a curator: the owner role in org (an org_curator assignment or the org owner), an active person, not a demo one.
// Curator decisions ("Confirm", "Return", "Delete") and confirmation at entry — only a person in the workplace
// (a session): an agent, a service "on behalf", the extended key, a plan (memory_apply) and the preview give "not
// confirmed". Org owner rights give a curator's agent no power over others' org records (ownedLocator — only the author).
import type pg from "pg";
import type { Hono } from "hono";
import {
  carryOrgReview, communityTeams, digestConfigOf, invalid, log, MemoryError, notFound, orgCurators, orgDigest, orgQueueCounts, orgReviewEnabled, returnFromOrg, reviewDays,
  reviewQueueLimit, smtpConfig, unreviewedFactor, type ExemptKind, type OrgReturnResult, type OrgReviewState, type ReturnBy,
} from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { fmtDateTime } from "@memory/i18n";
import { instanceLocale } from "@memory/i18n/context";
import type { SpaceAccess } from "./access.ts";
import { locate } from "./access.ts";
import { audit } from "./audit.ts";
import { isHumanSession, workplaceUrl, workplaceWhere } from "./workplace.ts";
import { isUuidParam } from "./paging.ts";

type Q = Pick<pg.PoolClient, "query">;
const ACTIVE: readonly OrgReviewState[] = ["unreviewed", "confirmed", "community", "exempt"];

/** An org curator: the owner role in the live org, an active person, not a demo one (a demo persona never becomes a curator). */
export function isOrgCurator(caller: Pick<Caller, "person">, spaces: ReadonlyMap<string, SpaceAccess>): boolean {
  const p = caller.person;
  if (!p || !p.active || p.demo) return false;
  for (const s of spaces.values()) if (s.kind === "org" && s.role === "owner" && !s.archived_at) return true;
  return false;
}

import { invalidateHeld, orgSpace } from "./org-hold.ts";
export { orgSpace };

/** Refusal to an agent and a key: decisions on another's org record — only the curator in the workplace (knowledge review). */
export function curatorOnlyInWorkplace(app: App, what = "move, return, close or delete someone else’s “Company knowledge” record"): MemoryError {
  return new MemoryError("forbidden", `Only the curator can ${what}, under “Company knowledge review” in the workspace: ${workplaceWhere(app, "/review", "Company knowledge review")}. The curator’s AI agent cannot do this`,
    { hint: "Send the person the workspace link", details: { reason: "org_curator_workplace" } });
}

export interface EnterArgs {
  recordId: string;
  /**
   * `public_profile` — a copy of the work profile for colleagues: set only by profile.ts through createRecord;
   * `space_guide` — the "How we work" map: a kind without return by term, set by this entry path (exemptKindOf).
   */
  via: "promote" | "write" | "version" | "public_profile" | "space_guide";
  caller: Caller;
  /** The caller is an org curator (isOrgCurator). */
  curator: boolean;
  /** A person in the workplace, not a plan (memory_apply): only then the curator confirms at once and the term starts anew. */
  human: boolean;
  /** An entry marked as extended access (an agent with it wrote or moved open content by permission) — marked in the queue. */
  extended: boolean;
  fromSpaceId: string | null;
  fromAudience: "space" | "people" | null;
  /** A new version (own_note, a meeting version): the old version's row is inherited. */
  supersedesId?: string | null;
  exempt?: ExemptKind | null;
  /**
   * A derivative moved into org separately (a summary, a meeting decision): the check units of all its ancestors
   * (orgAncestorUnits), nearest first. The "Wrong" hold and "waits for a decision" come from the nearest ancestor that has
   * them; if the curator returned or deleted any ancestor, an agent does not take the part out again, only a workplace person.
   */
  ancestorUnitIds?: readonly string[];
}
export interface EnterOut { state: OrgReviewState; return_after: Date | null; cycle: number; held: boolean }

/**
 * Re-entry after "Return" or "Delete" — only a person in the workplace: an agent gets a refusal with a link.
 * `of` — whose row decided: the old version's (returned after this one appeared) or the part's source record.
 */
function reentryForbidden(app: App, recordId: string, state: string, of: "self" | "version" | "source" = "self"): MemoryError {
  const what = of === "source" ? "The source record (for example, the meeting behind this summary or decision) was returned" : of === "version" ? "An earlier version of the record was returned" : "The record was already returned";
  return new MemoryError("forbidden",
    `${what} from “Company knowledge”${state === "deleted" ? " (a curator deleted it)" : ""}. Only a person in the workspace can move ${of === "self" ? "it" : "this record"} there again: ${workplaceWhere(app, `/records/${recordId}`, "Record")}`,
    { hint: "Send the person the link to the record", details: { reason: "org_reentry" } });
}

/** The nearest not superseded row of the old version down the supersedes_id chain (no lock); none — null. */
async function olderVersionRow(q: Q, supersedesId: string | null): Promise<{ record_id: string; state: string } | null> {
  let id = supersedesId;
  for (let i = 0; i < 50 && id; i++) {
    const p = (await q.query("SELECT record_id, state, supersedes_id FROM org_reviews WHERE record_id = $1", [id])).rows[0] as { record_id: string; state: string; supersedes_id: string | null } | undefined;
    if (!p) return null;
    if (p.state !== "superseded") return p;
    id = p.supersedes_id;
  }
  return null;
}

/**
 * The old version, left in org on its own check, was returned or deleted after this version appeared (its row is
 * a copy that "left" memory, carryOrgReview with nextOutsideOrg): the state of the nearest not superseded row
 * down the supersedes_id chain. The version's own history (moved again, taken away by the author) does not ask the chain.
 */
async function versionReturned(q: Q, cur: { state: string; decided_via: string | null; supersedes_id: string | null }): Promise<string | null> {
  if (cur.state !== "left" || cur.decided_via !== "system" || !cur.supersedes_id) return null;
  const p = await olderVersionRow(q, cur.supersedes_id);
  return p && (p.state === "returned" || p.state === "deleted") ? p.state : null;
}

/**
 * The old version of this record is still in org on its own check (a new meeting version came to personal, the old one stayed),
 * and this version is entering org now: the old one's row goes under the lock (FOR UPDATE) and only if it is live
 * and its locator is live in org; else null. The record's own row must be final (the copy "left" and its chain).
 */
async function olderVersionInOrg(q: Q, recordId: string): Promise<Record<string, any> | null> {
  const head = (await q.query("SELECT state, supersedes_id FROM org_reviews WHERE record_id = $1", [recordId])).rows[0] as { state: OrgReviewState; supersedes_id: string | null } | undefined;
  if (!head?.supersedes_id || ACTIVE.includes(head.state)) return null;
  const older = await olderVersionRow(q, head.supersedes_id);
  if (!older || !["unreviewed", "confirmed", "community"].includes(older.state)) return null;
  return (await q.query(
    `SELECT r.* FROM org_reviews r JOIN record_locations l ON l.record_id = r.record_id AND NOT l.deleted JOIN spaces s ON s.id = l.space_id AND s.kind = 'org'
      WHERE r.record_id = $1 AND r.state IN ('unreviewed','confirmed','community') FOR UPDATE OF r`, [older.record_id])).rows[0] ?? null;
}

/**
 * A new version enters org while the old one is still there on its own check: one check unit per
 * version chain in org. The old one's row becomes superseded (its term, the queue, "Return" and "Delete" through orgUnitsOf
 * lead to the new one), "Wrong" marks move to the new one (except repeats of one person). The new one gets the current hold
 * and "waits for a decision" of the old one (not a snapshot: the curator may have decided since) and its term, only if
 * the old one is not confirmed: "confirmed" does not carry over, a confirmed one's copy gets a new term. Else returning
 * the old one by term or by the curator's button would take the new one out of org too (the author's chain), overwriting it.
 */
async function absorbOlderVersion(q: Q, nextId: string, older: Record<string, any>): Promise<void> {
  await q.query("UPDATE org_reviews SET held_at = $2, held_by = $3, disputed_at = $4, return_after = $5 WHERE record_id = $1",
                [nextId, older.held_at, older.held_by, older.disputed_at, older.state === "unreviewed" ? older.return_after : null]);
  await q.query("UPDATE org_reviews SET state = 'superseded' WHERE record_id = $1 AND state IN ('unreviewed','confirmed','community')", [older.record_id]);
  await q.query(
    `UPDATE org_review_marks m SET record_id = $2 WHERE m.record_id = $1 AND m.kind = 'wrong'
       AND NOT EXISTS (SELECT 1 FROM org_review_marks x WHERE x.record_id = $2 AND x.person_id = m.person_id AND x.kind = 'wrong')`, [older.record_id, nextId]);
}

/**
 * A record entering org: one function for the move (promote, in the transaction of the record lock before rows are moved),
 * a direct write (createRecord, right after the locator) and a version (own_note, a meeting version). With the switch
 * off there are no rows (the old behavior); an already held record stays held (its row is not touched).
 * - a row exists and is active — no change (entry into the same place);
 * - the row is final (left, returned, deleted) — a new cycle: the term starts anew only for a person, for an agent it stays;
 *   after "Return"/"Delete" an agent gets a refusal; "Useful" marks of the old cycle are removed, "Wrong" and the hold are not;
 * - a new version inherits origin, hold, "waits for a decision", cycle and term of the old one (if not confirmed yet), the
 *   "Wrong" marks move to it, the old row becomes superseded;
 * - a "left" copy of a new meeting version (the old one stayed in org): the old one later returned or deleted — agent refused;
 *   the old one still in org on its own check — its row is superseded, marks and the current hold go to this one (one unit
 *   of check per chain in org — else the return of the old one would take this one too, overwriting its decision);
 * - a part moved separately (ancestorUnitIds): any source record returned or deleted — an agent gets a refusal;
 *   the hold and "waits for a decision" of the nearest source with them pass to the part (and its old row), "confirmed" not;
 * - else a new row: an exception by kind (code) — exempt, a human curator — confirmed (self), else — unreviewed.
 * The order of row locks — as for the tree and chain return: source records top-down, the old version, the own row.
 */
export async function enterOrg(q: Q, app: App, a: EnterArgs): Promise<EnterOut | null> {
  // the switch: no new check, but the old version's row (the hold, "returned") travels with the chain; the old one
  // left in org on its own check yields to this one (its hold goes with it): one unit per chain
  if (!orgReviewEnabled(app.settings)) {
    if (a.supersedesId) await carryOrgReview(q, a.supersedesId, a.recordId);
    else {
      const older = await olderVersionInOrg(q, a.recordId);
      if (older) await absorbOlderVersion(q, a.recordId, older);
    }
    return null;
  }
  const days = reviewDays(app.settings), me = a.caller.person?.id ?? null;
  const state: OrgReviewState = a.exempt ? "exempt" : a.curator && a.human ? "confirmed" : "unreviewed";
  const out = (r: any): EnterOut | null => (r ? { state: r.state, return_after: r.return_after ?? null, cycle: r.cycle, held: r.held_at !== null && r.held_at !== undefined } : null);
  // a part moved separately: if the curator returned or deleted any source record — the agent is refused; the hold goes with
  // the part. Source rows are locked top-down and before the own one: the tree return order (the source, then its parts)
  const ancIds = [...new Set(a.ancestorUnitIds ?? [])].filter((id) => id !== a.recordId);
  const locked = new Map<string, any>();
  for (const id of [...ancIds].reverse()) {
    const row = (await q.query("SELECT * FROM org_reviews WHERE record_id = $1 FOR UPDATE", [id])).rows[0];
    if (row) locked.set(id, row);
  }
  const ancs = ancIds.map((id) => locked.get(id)).filter(Boolean);           // nearest first
  const anc = ancs[0];
  const older = await olderVersionInOrg(q, a.recordId);
  const cur = (await q.query("SELECT * FROM org_reviews WHERE record_id = $1 FOR UPDATE", [a.recordId])).rows[0];
  const gone = ancs.find((r) => r.state === "returned" || r.state === "deleted");
  if (gone && !a.human) throw reentryForbidden(app, a.recordId, gone.state, "source");
  const heldBy = ancs.find((r) => r.held_at);
  const held = heldBy ? { at: heldBy.held_at, by: heldBy.held_by } : null;
  const disputed = ancs.find((r) => r.disputed_at)?.disputed_at ?? null;
  const returns = ancs.length ? Math.max(...ancs.map((r) => Number(r.returns) || 0)) : null;
  if (cur) {
    if (ACTIVE.includes(cur.state)) return out(cur);
    if ((cur.state === "returned" || cur.state === "deleted") && !a.human) throw reentryForbidden(app, a.recordId, cur.state);
    // a copy that "left" of a new meeting version: the old one, left in org, was later returned or deleted by the curator
    const was = a.human ? null : await versionReturned(q, cur);
    if (was) throw reentryForbidden(app, a.recordId, was, "version");
    // the old one is still in org on its own check: its row yields to this one — hold, "waits for a decision", term: current
    if (older) await absorbOlderVersion(q, a.recordId, older);
    const r = (await q.query(
      `UPDATE org_reviews SET state = $2, cycle = cycle + 1, entered_at = now(), entered_via = $3, entered_by = $4, entered_human = $5, extended = $6,
              from_space_id = COALESCE($7, from_space_id), from_audience = COALESCE($8, from_audience), exempt_kind = $9,
              return_after = CASE WHEN $2 <> 'unreviewed' THEN return_after
                                  WHEN $5 THEN now() + make_interval(days => $10::int)
                                  ELSE COALESCE(return_after, now() + make_interval(days => $10::int)) END,
              decided_at = CASE WHEN $2 = 'confirmed' THEN now() END, decided_by = CASE WHEN $2 = 'confirmed' THEN $4::uuid END,
              decided_via = CASE WHEN $2 = 'confirmed' THEN 'self' END, returned_to = NULL,
              held_by = CASE WHEN held_at IS NULL THEN $12::uuid ELSE held_by END, held_at = COALESCE(held_at, $11::timestamptz),
              disputed_at = COALESCE(disputed_at, $13::timestamptz)
        WHERE record_id = $1 RETURNING state, return_after, cycle, held_at`,
      [a.recordId, state, a.via, me, a.human, a.extended, a.fromSpaceId, a.fromAudience, a.exempt ?? null, days,
       held?.at ?? null, held?.by ?? null, disputed])).rows[0];
    await q.query("DELETE FROM org_review_marks WHERE record_id = $1 AND kind = 'useful'", [a.recordId]);
    return out(r);
  }
  const prev = a.supersedesId ? (await q.query("SELECT * FROM org_reviews WHERE record_id = $1 FOR UPDATE", [a.supersedesId])).rows[0] : undefined;
  const inheritDue = prev?.state === "unreviewed" ? prev.return_after : null;
  // the hold and "waits for a decision": of the old version, else of the part's sources (held_at/held_by from one row);
  // the cycle — of the nearest source, the number of returns — the largest among the sources
  const hold = prev?.held_at ? { at: prev.held_at, by: prev.held_by } : held;
  const r = (await q.query(
    `INSERT INTO org_reviews (record_id, instance_id, state, cycle, entered_via, entered_by, entered_human, extended, from_space_id, from_audience, exempt_kind,
                              return_after, held_at, held_by, disputed_at, decided_at, decided_by, decided_via, supersedes_id, returns)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             CASE WHEN $3 = 'unreviewed' THEN COALESCE($12::timestamptz, now() + make_interval(days => $13::int)) END,
             $14, $15, $16, CASE WHEN $3 = 'confirmed' THEN now() END, CASE WHEN $3 = 'confirmed' THEN $6::uuid END,
             CASE WHEN $3 = 'confirmed' THEN 'self' END, $17, $18)
     RETURNING state, return_after, cycle, held_at`,
    [a.recordId, app.instanceId, state, prev?.cycle ?? anc?.cycle ?? 1, a.via, me, a.human, a.extended, prev?.from_space_id ?? a.fromSpaceId, prev?.from_audience ?? a.fromAudience,
     a.exempt ?? null, inheritDue, days, hold?.at ?? null, hold?.by ?? null, prev?.disputed_at ?? disputed, prev ? a.supersedesId : null,
     prev?.returns ?? returns ?? 0])).rows[0];
  if (prev) {
    await q.query("UPDATE org_reviews SET state = 'superseded' WHERE record_id = $1 AND state = ANY($2::text[])", [a.supersedesId, ACTIVE]);
    await q.query("UPDATE org_review_marks SET record_id = $2 WHERE record_id = $1 AND kind = 'wrong'", [a.supersedesId, a.recordId]);
  }
  return out(r);
}

/**
 * The author takes their record out of org (memory_promote to a team, project or personal): row left, by "author". The hold
 * and the "Wrong" marks stay: the record returns to org held. An org table card (exempt) does not leave.
 */
export async function leaveOrg(q: Q, recordId: string, by: string | null): Promise<void> {
  await q.query(
    `UPDATE org_reviews SET state = 'left', decided_at = now(), decided_by = $2, decided_via = 'author'
      WHERE record_id = $1 AND state IN ('unreviewed','confirmed','community')`, [recordId, by]);
}

/** The record's check row (for the promote answer and the record view); null — the record is not under check. */
export async function reviewRow(app: Pick<App, "db">, recordId: string): Promise<Record<string, any> | null> {
  return (await app.db.control.query("SELECT * FROM org_reviews WHERE record_id = $1", [recordId])).rows[0] ?? null;
}

/** The UTC day in the installation's language: en YYYY-MM-DD, ru DD.MM.YYYY. */
const dueDay = (d: Date | string): string => fmtDateTime(instanceLocale(), "UTC", d, "date");

/**
 * The tail of the memory_promote answer into org: the agent passes it to the person. Only the author sees the slug (they
 * move it). A curator in the workplace — "confirmed"; a curator as an agent — "not confirmed", confirm in the queue.
 */
export function promoteOrgText(app: App, e: EnterOut | null, o: { recordId: string; fromSlug: string; curator: boolean }): string {
  if (!e) return "";
  if (e.state === "confirmed") return " You are a “Company knowledge” curator, so the record was confirmed immediately.";
  const due = e.return_after ? ` If it is not confirmed by ${dueDay(e.return_after)}, it will return to ${o.fromSlug}.` : "";
  const held = e.held ? " People marked it “Wrong, not for everyone”. Agents cannot find it until a curator decides." : "";
  return ` In “Company knowledge”, all employees can see the record immediately with the “Unconfirmed” label, and it ranks lower in search. Curators review records weekly.${due}${held}` +
    `${o.curator ? " You are a curator, but an AI agent moved the record. Confirm it yourself in “Company knowledge review”." : ""}` +
    ` People mark records “Useful” or “Wrong” in the workspace: ${workplaceWhere(app, `/records/${o.recordId}`, "Record")}`;
}

// ---------------------------------------------------------------- decisions: return and delete
export interface DecisionOut { id: string; state: OrgReviewState; space: string | null; deleted?: boolean; author_dismissed?: boolean }

/** Answers of the return core — as gateway errors. */
function decisionError(r: Exclude<OrgReturnResult, { status: "done" } | { status: "no_target" }>): MemoryError {
  switch (r.status) {
    case "busy": return new MemoryError("in_progress", "The record is being moved or another decision is in progress. Try again in a few seconds", { retry_after: 10 });
    case "card": return invalid("The employee profile comes from the org table and cannot be returned or deleted. Select “Confirm” if the “Wrong” mark is incorrect, or correct the data in the org table", { reason: "org_card" });
    case "state": return notFound();
    default: return notFound();
  }
}

/** The return event: promote with op org_return; for the author — into "My actions" (details.author); no titles or text. */
async function auditReturn(app: App, caller: Caller | null, r: Extract<OrgReturnResult, { status: "done" }>, id: string, by: ReturnBy, op: "org_return" | "org_delete",
                           extra: Record<string, unknown> = {}) {
  await audit(app, caller, { event_type: "promote", class: r.cls, record_ids: [id, ...r.ids.filter((x) => x !== id)], space_id: r.toSpaceId,
                              details: { tool: "org_review", op, by, from_space: r.orgSpaceId, to_space: r.toSlug, author: r.authorId, derived: r.derived, ...extra } });
}

/** How many times to retry returning a busy record (a move, a curator decision) on narrowed readers, and the pause between. */
const NARROW_TRIES = 3, NARROW_PAUSE_MS = 500;

/**
 * The readers of a meeting were narrowed (organizer in the workplace, a repeated intake with others, `/ingest/access`), while it
 * or its part lies in "Company shared knowledge": it goes back where it came from, the same path as the author's "Return back"
 * (narrowing is a "not for everyone" signal). `tree` — the records of class `cls` that
 * have just been given the "people" scope (roots before derivatives); the check units among them with a live locator in
 * org and a live row are returned. The "Wrong" hold and check history go with the record (an agent does not take it out — only a
 * person), the author gets an event in "My actions". Organizer in the workplace: `author`; service, repeated intake: `system`.
 * A busy record — up to three tries, then a warning in the log; the next pass of the org_review job picks it up (the pick
 * "readers narrowed") along the same path, as memory's decision. Records without a check row (entered with the check off)
 * are not touched: by the rules there is nowhere to return them.
 *
 * Does not throw: it is called AFTER the new people list is saved (the participants' transaction is closed). A return
 * error (a deadlock, a serialization failure, ensureProjectEntity…) — a warning in the log and the next unit:
 * else the organizer or service would get 500 with the list saved, mail to the new participants would not go, and a repeat of the
 * same list (`same`) no longer does anything. The same job pass ("readers narrowed") picks up a record that did not return.
 */
export async function leaveOrgNarrowed(app: App, caller: Caller, cls: "open" | "closed", tree: readonly string[], by: "author" | "system"): Promise<string[]> {
  if (!tree.length) return [];
  const retry = "org_review job, “narrowed audience” selection";
  let units: Set<string>;
  try {
    units = new Set((await app.db.control.query(
      `SELECT r.record_id FROM org_reviews r JOIN record_locations l ON l.record_id = r.record_id AND NOT l.deleted JOIN spaces s ON s.id = l.space_id AND s.kind = 'org'
        WHERE r.instance_id = $2 AND r.record_id = ANY($1::uuid[]) AND r.state IN ('unreviewed','confirmed','community') AND l.class = $3`,
      [[...new Set(tree)], app.instanceId, cls])).rows.map((x) => x.record_id as string));
  } catch (e) {
    log.warn("org_narrow_return_failed", { class: cls, records: tree.length, error: (e as Error).message.slice(0, 160), retry });
    return [];
  }
  if (!units.size) return [];
  const returned: string[] = [];
  for (const id of [...new Set(tree)].filter((x) => units.has(x))) {
    if (returned.includes(id)) continue;
    let r: OrgReturnResult = { status: "busy" };
    try {
      for (let i = 0; i < NARROW_TRIES && r.status === "busy"; i++) {
        if (i) await new Promise((ok) => setTimeout(ok, NARROW_PAUSE_MS * i));
        r = await returnFromOrg(app.db.control, (c) => app.db.recordsForWrite(c, caller.scope),
                                { recordId: id, instanceId: app.instanceId, actorId: by === "author" ? caller.person?.id ?? null : null, by, final: "returned" });
      }
    } catch (e) {
      log.warn("org_narrow_return_failed", { record_id: id, error: (e as Error).message.slice(0, 160), retry });
      continue;
    }
    if (r.status === "done") {
      returned.push(...r.ids);
      await auditReturn(app, caller, r, id, by, "org_return", { reason: "narrowed" });
    } else if (r.status !== "gone" && r.status !== "state")      // gone — left with the tree before; state — decided meanwhile
      log.warn("org_narrow_return_skipped", { record_id: id, status: r.status, retry });
  }
  if (returned.length) invalidateHeld(app);
  return returned;
}

/** The curator's "Return" or the author's "Return back" — into the source space (or the author's personal one). */
export async function orgReturn(app: App, caller: Caller, id: string, by: "curator" | "author"): Promise<DecisionOut> {
  const r = await returnFromOrg(app.db.control, (cls) => app.db.recordsForWrite(cls, caller.scope),
                                { recordId: id, instanceId: app.instanceId, actorId: caller.person!.id, by, final: "returned" });
  if (r.status === "no_target")
    throw invalid(r.authorActive ? "There is nowhere to return the record. The original space is missing or archived, and the author’s personal space is unavailable" :
      "The author no longer works here and the original space is missing or archived. There is nowhere to return the record. Confirm or delete it", { reason: "no_target", author_dismissed: !r.authorActive });
  if (r.status !== "done") throw decisionError(r);
  await auditReturn(app, caller, r, id, by, "org_return");
  return { id, state: "returned", space: r.toSlug };
}

/**
 * The curator's "Delete": first the return to where it came from, then the trash there — the author can restore it
 * only there, not into org. The author left, nowhere to return — the trash right in org: restoring in org refuses all but
 * the deleting author (owner.ts restoreFromTrash). A trash failure after the return: the answer says "returned, delete it there".
 */
export async function orgDelete(app: App, caller: Caller, id: string,
                                trash: (loc: NonNullable<Awaited<ReturnType<typeof locate>>>) => Promise<{ ids: string[]; deleted_at: Date; purge_after: Date }>): Promise<DecisionOut & { trash?: { ids: string[]; deleted_at: Date; purge_after: Date } }> {
  const me = caller.person!.id;
  const r = await returnFromOrg(app.db.control, (cls) => app.db.recordsForWrite(cls, caller.scope),
                                { recordId: id, instanceId: app.instanceId, actorId: me, by: "curator", final: "deleted" });
  if (r.status === "no_target") {
    if (r.authorActive) throw invalid("The record cannot be deleted by returning it. The original space is missing and the author’s personal space is unavailable", { reason: "no_target" });
    const loc = await locate(app, id);
    if (!loc || loc.deleted) throw notFound();
    const t = await trash(loc);
    await app.db.control.query(
      "UPDATE org_reviews SET state = 'deleted', decided_at = now(), decided_by = $2, decided_via = 'curator' WHERE record_id = $1 AND state IN ('unreviewed','confirmed','community')", [id, me]);
    await audit(app, caller, { event_type: "forget", class: loc.class, record_ids: t.ids, space_id: loc.space_id,
                                details: { tool: "org_review", op: "org_delete", by: "curator", author: loc.owner_id, author_dismissed: true, affected: t.ids.length } });
    return { id, state: "deleted", space: null, deleted: true, author_dismissed: true, trash: t };
  }
  if (r.status !== "done") throw decisionError(r);
  await auditReturn(app, caller, r, id, "curator", "org_delete");
  const loc = await locate(app, id);
  try {
    if (!loc || loc.deleted) throw notFound();
    const t = await trash(loc);
    await audit(app, caller, { event_type: "forget", class: loc.class, record_ids: t.ids, space_id: loc.space_id,
                                details: { tool: "org_review", op: "org_delete", by: "curator", author: loc.owner_id, affected: t.ids.length } });
    return { id, state: "deleted", space: r.toSlug, deleted: true, trash: t };
  } catch (e) {
    if (e instanceof MemoryError && e.code !== "in_progress" && e.code !== "not_found") throw e;
    return { id, state: "deleted", space: r.toSlug, deleted: false };
  }
}

// ---------------------------------------------------------------- administrator: summary, mail, job, the term test hook
type AdminAudit = (c: any, op: string, details?: Record<string, unknown>) => Promise<void>;

/**
 * GET /admin/org-review — the summary for the panel (the "Curators" block in "Roles"): queue, curators, settings, the last pass.
 * POST /admin/org-review/digest — mail to curators now (the panel button): only the mail queue, dedupe for an hour;
 * 409 `conflict` — mail off or nothing to check; no curators with mail — 409 too (the administrator gets no mail —
 * a question for the owner). POST /admin/maintenance/org-review {part: return|digest|all} — wake the worker job (the
 * test run wakes only the return, the mail is a separate step). POST /admin/org-review/{id}/expire — the term test hook:
 * the term of one unconfirmed record of a test person (attrs.test) is set to now; the term setting does not change.
 */
export function registerOrgReviewAdmin(r: Hono<any>, app: App, adminAudit: AdminAudit): void {
  r.get("/org-review", async (c) => {
    const [org, counts, curators, last] = await Promise.all([
      orgSpace(app), orgQueueCounts(app.db.control, app.instanceId), orgCurators(app.db.control, app.instanceId, true),
      app.db.control.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = 'org_review'", [app.instanceId]).then((x) => x.rows[0]?.value ?? null),
    ]);
    const s = app.settings;
    return c.json({
      enabled: orgReviewEnabled(s), org: org?.slug ?? null, mail_enabled: smtpConfig(s).enabled,
      waiting: counts.waiting, new_week: counts.new_week, held: counts.held, due_week: counts.due_week, oldest_entered_at: counts.oldest ? new Date(counts.oldest).toISOString() : null,
      curators: curators.map((p) => ({ login: p.login, display_name: p.display_name, test: p.test })),
      settings: { days: reviewDays(s), queue_limit: reviewQueueLimit(s.get<unknown>("access.org_review_queue_limit", 20)),
                  community_teams: communityTeams(s.get<unknown>("access.org_review_community_teams", 2)),
                  unreviewed_factor: unreviewedFactor(s.get<unknown>("search.org_unreviewed_factor", 0.8)), digest: digestConfigOf(s) },
      last_run: last,
    });
  });
  r.post("/org-review/digest", async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    if (raw && typeof raw === "object" && Object.keys(raw).length) throw invalid("No request body is needed. The e-mail is built from the “Company knowledge review” queue");
    if (!orgReviewEnabled(app.settings)) throw new MemoryError("conflict", "Curator review is disabled (access.org_review_enabled = false). There is no e-mail", { details: { reason: "org_review_disabled" } });
    const caller = c.get("caller") as Caller | undefined;
    const by = caller?.clientLabel?.startsWith("admin:") ? caller.clientLabel.slice(6) : caller?.person?.login ?? "admin";
    const d = await orgDigest(app.db.control, app.instanceId, app.settings, { manual: true, createdBy: by, workplaceUrl: workplaceUrl(app) });
    if (d.skipped === "smtp_disabled") throw new MemoryError("conflict", "E-mail is disabled (smtp.enabled = false). The e-mail to curators was not queued", { details: { reason: "smtp_disabled" } });
    if (d.skipped === "nothing_to_review") throw new MemoryError("conflict", "There is nothing to review in “Company knowledge review”, so no e-mail is needed", { details: { reason: "nothing_to_review" } });
    if (d.skipped === "no_curators") throw new MemoryError("conflict", "No curators have e-mail addresses. Assign the “Company knowledge curator” role under “Roles”", { details: { reason: "no_curators", no_address: d.no_address } });
    if (d.queued) await app.queue.wake("mail").catch(() => false);
    await adminAudit(c, "org_digest", { tool: "org_review", week: d.week, recipients: d.recipients, queued: d.queued, waiting: d.waiting, held: d.held, manual: true });
    return c.json({ queued: d.queued, recipients: d.recipients, no_address: d.no_address, waiting: d.waiting, held: d.held, repeat: d.queued === 0 });
  });
  r.post("/maintenance/org-review", async (c) => {
    const b = await c.req.json().catch(() => ({}));
    if (b && typeof b === "object" && Object.keys(b).some((k) => k !== "part")) throw invalid("Only the part field is allowed: return, digest or all");
    const part = b?.part ?? "all";
    if (!["return", "digest", "all"].includes(part)) throw invalid("part: return, digest or all");
    const queued = await app.queue.wake("org_review", { part });
    await adminAudit(c, "org_review_now", { part, queued });
    return c.json({ queued, part }, 202);
  });
  r.post("/org-review/:id/expire", async (c) => {
    const id = c.req.param("id");
    if (!isUuidParam(id)) throw notFound();
    const row = (await app.db.control.query(
      `SELECT r.state, p.attrs FROM org_reviews r JOIN record_locations l ON l.record_id = r.record_id JOIN people p ON p.id = l.owner_id
        WHERE r.record_id = $1 AND r.instance_id = $2`, [id, app.instanceId])).rows[0];
    if (!row) throw notFound();
    if (row.attrs?.test !== true) throw new MemoryError("forbidden", "Only records from test accounts (attrs.test) can have their deadline moved. This is an acceptance test hook. It cannot return a record");
    if (row.state !== "unreviewed") throw invalid(`Only unconfirmed records have a deadline. This record’s status is ${row.state}`);
    const due = (await app.db.control.query("UPDATE org_reviews SET return_after = now() WHERE record_id = $1 RETURNING return_after", [id])).rows[0].return_after;
    await adminAudit(c, "org_review_expire", { record_id: id });
    return c.json({ id, return_after: new Date(due).toISOString() });
  });
}

/** A person in the workplace — for intermediate calls (re-export: owner.ts, records.ts, corrections.ts). */
export { isHumanSession };
