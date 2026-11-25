// The space's "How we work" map: one current record
// `note` per space (`attrs.subtype = space_guide`, `source_ref = space_guide:<space id>`), each change is
// a new version (`supersedes_id`). Only a person in the workplace writes it — the space owner, in "Company common knowledge" —
// the curator or the org owner; an agent reads the map with a plain memory_read, in data markers, and finds its path
// in the first readme line of `memory_list /spaces/<slug>` and in `memory_me.spaces[].guide_path`. Size — up to
// `access.space_guide.max_tokens` (1500); the class — as the space's, into open — only what passed the open check. In org
// the map is a kind with no return by term (exempt, `entered_via = space_guide`); written with extended access — in the "Common
// knowledge review". The `access.space_guide_enabled` switch (off by default) turns all of it off: the routes,
// the memory_list line and the memory_me path. The administrator never reads the map: no panel routes, section codes in the log.
// The map page gets "Agent proposals" and the version history (space-guide-proposals.ts), and the edit — the
// "Apply" path (`from_proposal`): a new version from an agent's proposal, the proposal — `applied` with the new `result_id`.
import type { Context, Hono } from "hono";
import type pg from "pg";
import { binder, GUIDE_SECTION_TITLES, GUIDE_SECTIONS, GUIDE_SUBTYPE, GUIDE_TITLE, guideSectionAt, guideSectionText, guideSpans, guideText, guideTokens, inProgress, invalid,
         MemoryError, neverOpenFindings, newId, notFound, openCheckReasons, parseGuideAttrs, recordPath, spaceGuideRef, visibleSql, type DataClass, type GuideLimits,
         type GuideSection, type GuideSections, type OpenCheckFinding } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { loadReadable, type SpaceAccess } from "./access.ts";
import { audit, auditShownClosed } from "./audit.ts";
import { withKeyLock } from "./control-lock.ts";
import { extendedOpenGate, proposalExtendedMark } from "./extended-open.ts";
import { jsonObjectBody, rejectUnknownFields } from "./key-kind.ts";
import { guardOpen, refuseOpen } from "./open-check.ts";
import { heldIds, orgSpace } from "./org-hold.ts";
import { closeMove } from "./owner.ts";
import { withCommittedOwnerEffects } from "./owner-effects.ts";
import { withRecordLocksWait } from "./owner-lock.ts";
import { createRecord, type Admitted, type NewRecord } from "./records.ts";
import { currentGuideRef, guideEnabled, guideLimitsOf, guideLockKey, guideWriterProblem, requireGuideEnabled, type GuideRef } from "./space-guide-ref.ts";
import { applyingGuideProposal, guideHistory, guideProposalKnown, guideProposalOf, guideProposals, guideProposalsQuery, type GuideProposalRow,
         type GuideProposalsQuery, type GuideProposalView, type GuideVersionView } from "./space-guide-proposals.ts";
import { PROJECTS, resolveWithArchive } from "./spaces.ts";
import { listingSpec } from "./visibility.ts";
import { requireHuman } from "./workplace.ts";

// ---------------------------------------------------------------- texts (plain words)
const OPEN_LEAD = "The record was not accepted into the open class";
const GUIDE_LEAD = "Guide not saved";
const WHERE = PROJECTS;

export { currentGuideRef, GUIDE_DISABLED_TEXT, GUIDE_PERSONAL_TEXT, guideEnabled, guideLimitsOf, guideLockKey, guideWriterProblem, pickGuide, requireGuideEnabled,
         type GuideRef, type GuideRow } from "./space-guide-ref.ts";

// ---------------------------------------------------------------- input
export type GuideChanges = Partial<Record<GuideSection, string | null>>;

/**
 * Section changes from the body `{sections: {section: text | null}}`: at least one section, only known ones; text or null.
 * Sections not named do not change, empty text or null clears a section. Length is cut by the map limit (in tokens); here —
 * only a rough input bound.
 */
export function checkGuideChanges(raw: unknown): GuideChanges {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid("sections must be an object {section: text}", { field: "sections" });
  const o = raw as Record<string, unknown>, keys = Object.keys(o);
  const unknown = keys.filter((k) => !(GUIDE_SECTIONS as readonly string[]).includes(k));
  if (unknown.length) throw invalid(`Unknown guide sections: ${unknown.join(", ")}. Allowed sections: ${GUIDE_SECTIONS.join(", ")}`, { field: "sections", unknown });
  if (!keys.length) throw invalid("sections: provide at least one section", { field: "sections" });
  const out: GuideChanges = {};
  for (const s of GUIDE_SECTIONS) {
    if (!(s in o)) continue;
    const v = o[s];
    if (v !== null && typeof v !== "string") throw invalid(`sections.${s}: text or null`, { field: `sections.${s}` });
    if (typeof v === "string" && v.length > 20_000) throw new MemoryError("too_large", `The “${GUIDE_SECTION_TITLES[s]}” section is too long`, { details: { section: s } });
    out[s] = v as string | null;
  }
  return out;
}

/** New sections: changes over the current ones; `changed` — sections whose text became different (with the cleared ones). */
export function applyGuideChanges(cur: GuideSections, changes: GuideChanges): { next: GuideSections; changed: GuideSection[] } {
  const next: GuideSections = { ...cur }, changed: GuideSection[] = [];
  for (const s of GUIDE_SECTIONS) {
    if (!(s in changes)) continue;
    const v = guideSectionText(changes[s] ?? "");
    if (v) next[s] = v; else delete next[s];
    if ((next[s] ?? "") !== (cur[s] ?? "")) changed.push(s);
  }
  return { next, changed };
}

/** The limit refusal: numbers in tokens; to the person — a hint on what to do. */
export function guideLimitError(tokens: number, max: number): MemoryError {
  return new MemoryError("too_large", `The guide exceeds the limit of ${max} tokens (it is about ${tokens}). Keep the guide to short lines and links, and save knowledge as notes`,
                         { details: { tokens, max } });
}

// ---------------------------------------------------------------- open check (the strict path, as for the profile)

/** Open check refusal in map words: the section (by the finding's place in the text) and what was found, not the value. */
export function guideRefusalText(findings: readonly OpenCheckFinding[], sections: GuideSections): { message: string; hint: string } {
  const spans = guideSpans(sections);
  const first = findings[0];
  const section = first ? guideSectionAt(spans, first.at) : null;
  const here = section ? findings.filter((f) => guideSectionAt(spans, f.at) === section) : [...findings];
  const where = section ? `In the “${GUIDE_SECTION_TITLES[section]}” section` : "In the guide";
  return { message: `${where}, content resembling ${openCheckReasons([...here])} was found. The space members’ cloud AI agents read the guide. Remove that content and save again`,
           hint: "The guide was unchanged. Remove that content from the section and save again" };
}

/** Open check refusal with the common start "Record not accepted…" in map words; its own text (with a section) is kept. */
export function guideOpenError(e: unknown): unknown {
  if (!(e instanceof MemoryError) || e.code !== "open_check" || !e.message.startsWith(OPEN_LEAD)) return e;
  const unchecked = (e.extra.details?.open_check as { unchecked?: unknown } | undefined)?.unchecked;
  return new MemoryError("open_check", GUIDE_LEAD + e.message.slice(OPEN_LEAD.length), {
    hint: unchecked ? "Try again in a minute with the same text. The guide was unchanged"
      : "A memory administrator’s rule prevents you from showing this type of record to agents. The guide was unchanged. Ask the memory administrator",
    ...(e.extra.details ? { details: e.extra.details } : {}) });
}

/**
 * The map lands open (the space class): "never open" rules without content (record kind, name,
 * space, project — the strict path does not check them itself), the gate (a workplace session writes as usual — null) and
 * the open check; a finding — a refusal, the previous version stays.
 */
async function admitOpen(app: App, caller: Caller, space: SpaceAccess, sections: GuideSections, text: string, sourceRef: string) {
  const rules = (await app.db.control.query("SELECT id, kind, pattern, reason FROM never_open_rules WHERE instance_id = $1 AND active", [app.instanceId])).rows;
  const never = neverOpenFindings(rules, { type: "note", title: GUIDE_TITLE, domains: [], entityKinds: space.kind === "project" ? ["project"] : [], spaceSlug: space.slug,
                                           sourceKind: "agent", sourceRef });
  try {
    if (never.length) await refuseOpen(app, caller, { via: "remember", spaceId: space.id, texts: [] }, { findings: [], unchecked: null, never });
    const extended = await extendedOpenGate(app, caller, { attempt: "remember", space: { id: space.id, slug: space.slug } });
    await guardOpen(app, caller, { via: "remember", spaceId: space.id, texts: [{ field: "text", value: text }], refusal: (f) => guideRefusalText(f, sections) });
    return extended;
  } catch (e) {
    throw guideOpenError(e);
  }
}

// ---------------------------------------------------------------- workplace view
export interface SpaceGuideView {
  space: string; id: string | null; version: number | null; path: string | null; updated_at: string | null; class: DataClass | null;
  sections: GuideSections; tokens: number; max_tokens: number; can_edit: boolean;
  /**
   * Only on GET: waiting edit proposals (to the decider — all, to others — their own) by 20, further — by the
   * `proposals_next` cursor, and the version history (metadata). The PUT answer has none — the page after saving
   * rereads the map.
   */
  proposals?: GuideProposalView[]; proposals_more?: boolean; proposals_next?: string | null; history?: GuideVersionView[]; history_more?: boolean;
  /**
   * Only on GET with `?proposal=<id>`: this proposal, if it waits and is visible to the caller, wherever it stands in the
   * list — "Apply" from "Record edits" opens the form also for a proposal older than the 20 newest; otherwise null.
   */
  proposal?: GuideProposalView | null;
}

export function guideView(space: Pick<SpaceAccess, "slug" | "kind" | "role" | "archived_at">, g: { id: string; version: number; occurred_at: Date; cls: DataClass; sections: GuideSections } | null,
                          limits: GuideLimits): SpaceGuideView {
  const sections: GuideSections = {};
  for (const s of GUIDE_SECTIONS) if (g?.sections[s]) sections[s] = g.sections[s];
  return { space: space.slug, id: g?.id ?? null, version: g?.version ?? null, path: g ? recordPath(space.slug, "note", g.occurred_at, g.id) : null,
           updated_at: g ? g.occurred_at.toISOString() : null, class: g?.cls ?? null, sections, tokens: g ? guideTokens(sections) : 0, max_tokens: limits.max_tokens,
           can_edit: guideWriterProblem(space) === null };
}

/**
 * The version's sections — with the caller's pool (closed is read only by one who reads closed: a workplace session). No row
 * (hidden, deleted or moved after picking the current one) — `in_progress`, not empty sections: otherwise an edit of one section
 * would silently erase the rest.
 */
async function loadSections(app: App, caller: Caller, ref: GuideRef): Promise<GuideSections> {
  const r = (await app.db.records(ref.cls, caller.scope).query("SELECT attrs FROM records WHERE id = $1 AND deleted_at IS NULL AND hidden_at IS NULL", [ref.id])).rows[0];
  if (!r) throw inProgress(10);
  return parseGuideAttrs(r.attrs?.guide).sections;
}

/** No proposals and history (no map, or the reader cannot see it). */
const emptyLists = (asked: string | null): Pick<SpaceGuideView, "proposals" | "proposals_more" | "proposals_next" | "history" | "history_more" | "proposal"> =>
  ({ proposals: [], proposals_more: false, proposals_next: null, history: [], history_more: false, ...(asked ? { proposal: null } : {}) });

/**
 * The map for the page (GET /me/spaces/{slug}/guide): anyone who reads the space (including an archived one); the map
 * is read by record rules (loadReadable: visibility, the "Wrong" hold in org, a class move). Not visible — as if no map.
 * With it — waiting edit proposals (to the map writer — all, to others — their own) and the version history (no text).
 * Proposals — by 20, the next ones — `proposals_cursor` (from `proposals_next`); `?proposal=<id>` — also this
 * proposal apart (`proposal`: waits and visible — its view, otherwise null), so that "Apply" from "Record edits" opens
 * the form also for a proposal older than the 20 newest. A forged parameter — 400 with the field, before reading the space.
 * A closed map, or a shown proposal from the closed database: before the answer, event `list {op: space_guide_view}` (session —
 * auto) with the ids of the map and of the versions with shown proposals; the log did not accept it — no answer.
 */
export async function readGuide(app: App, caller: Caller, slug: string, query: GuideProposalsQuery = {}): Promise<SpaceGuideView> {
  requireGuideEnabled(app);
  await requireHuman(app, caller, "View the “How we work” guide", WHERE);
  const q = guideProposalsQuery(query);
  const s = await resolveWithArchive(app, caller, slug);
  if (!s) throw notFound();
  const ref = await currentGuideRef(app, s.id);
  if (!ref) return { ...guideView(s, null, guideLimitsOf(app)), ...emptyLists(q.proposal) };
  let rec;
  try { rec = (await loadReadable(app, caller, ref.id)).rec; }
  catch (e) { if (e instanceof MemoryError && e.code === "not_found") return { ...guideView(s, null, guideLimitsOf(app)), ...emptyLists(q.proposal) }; throw e; }
  const sections = parseGuideAttrs(rec.attrs?.guide).sections;
  const proposals = await guideProposals(app, caller, s, ref.id, q);
  const history = await guideHistory(app, caller, s);
  const shownClosed = [...(ref.cls === "closed" ? [ref.id] : []), ...proposals.closed];
  if (shownClosed.length) await auditShownClosed(app, caller, shownClosed, "space_guide_view");
  return { ...guideView(s, { id: ref.id, version: ref.version, occurred_at: ref.occurred_at, cls: ref.cls, sections }, guideLimitsOf(app)),
           proposals: proposals.items, proposals_more: proposals.more, proposals_next: proposals.next, history: history.items, history_more: history.more,
           ...(proposals.asked !== undefined ? { proposal: proposals.asked } : {}) };
}

// ---------------------------------------------------------------- write
export interface GuideWritten { already_known: boolean; changed: GuideSection[]; guide: SpaceGuideView }

/** The answer to an edit while the map leaves agents following a "people only" space. */
export const GUIDE_CLOSING_TEXT = "The space is now “people only”, so the “How we work” guide is also being hidden from AI agents. The move will take a few seconds. Save again in a minute. The guide was unchanged";

/**
 * The map is visible to agents (open), and the space was switched to "people only" (`default_class = closed`; already saved
 * records do not change then): the new version must land closed (the class follows the space), but the version refers
 * to the previous one in the same database (`supersedes_id`) — so first the whole map chain goes into closed by the same move as
 * "Hide from agents" (closeMove: from the chain head, rows are hidden at once, the event `class_move {op: close}` on behalf of
 * the person), and the edit answers "being moved" — a repeat after the move writes a closed version. No way back: a closed map
 * in an open space is opened only by a person ("Make available to agents").
 */
async function followSpaceClosed(app: App, caller: Caller, s: SpaceAccess, ref: GuideRef): Promise<MemoryError> {
  const me = caller.person!;
  const started = await closeMove(app, { recordId: ref.id, requestedBy: me.id, scope: caller.scope });
  if ("moveId" in started) {
    const author = (await app.db.control.query("SELECT owner_id FROM record_locations WHERE record_id = $1", [started.recordId])).rows[0]?.owner_id as string | undefined;
    await audit(app, caller, { event_type: "class_move", class: "open", record_ids: [started.recordId], space_id: s.id,
                               details: { op: "close", move_id: started.moveId, affected: started.affected, by: author && author !== me.id ? "space_owner" : "author",
                                          ...(author && author !== me.id ? { author } : {}), on_guide_save: true } });
  }
  if ("moveId" in started || "running" in started) return new MemoryError("in_progress", GUIDE_CLOSING_TEXT, { retry_after: 10, details: { reason: "space_guide_closing" } });
  return inProgress(10);                                 // busy with another action or already closed — a repeat rereads the map
}

/**
 * Under the record:<current version> lock (the same that "Hide from agents" and a class move take; busy and a move in progress
 * were sifted out by withRecordLocksWait) — the version is the same: the locator in the same database and not deleted, the row
 * current, not hidden, not deleted. Else `in_progress`: a repeat rereads the map. control — only via the lock-holding client.
 */
async function guideHeadUnchanged(app: App, q: Pick<pg.PoolClient, "query">, ref: GuideRef): Promise<void> {
  const loc = (await q.query("SELECT class, deleted FROM record_locations WHERE record_id = $1", [ref.id])).rows[0] as { class: DataClass; deleted: boolean } | undefined;
  if (!loc || loc.deleted || loc.class !== ref.cls) throw inProgress(10);
  const row = (await app.db.recordsForWrite(ref.cls, "system").query(
    "SELECT 1 FROM records WHERE id = $1 AND is_current AND deleted_at IS NULL AND hidden_at IS NULL", [ref.id])).rowCount;
  if (!row) throw inProgress(10);
}

/** `from_proposal` of the PUT body: the id of a map edit proposal — a uuid, or no field. */
export function checkFromProposal(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw))
    throw invalid("from_proposal must be the id of a guide correction proposal", { field: "from_proposal" });
  return raw.toLowerCase();
}

/**
 * Write the map sections (PUT /me/spaces/{slug}/guide): switch → only a person in the workplace → input →
 * space and right (owner; in org — curator; not personal, not an archive) → under the space lock: the current map (both classes);
 * it is hidden by a class move (running or failed) or a move is in progress — `in_progress` → new sections → the same text —
 * `already_known` (no version and no event) → empty — refusal → the token limit → an open map in a "people only" space —
 * the chain goes into closed, `in_progress` (followSpaceClosed) → (open class) "never open" rules, the
 * gate, the open check → a new version with `supersedes_id` under the record:<previous version> lock (a concurrent
 * "Hide from agents" of the old version waits and closes the new one, or the edit answers `in_progress`; the new one does not
 * stay open by a hidden one). The class — the stricter of the old version and the space: a map hidden from agents continues
 * the chain closed; the first one — the space class. In org — the `space_guide` entry (exempt, no return by term). The log —
 * `write {op: "space_guide", version, sections}`, `record_ids` — the new version, no text. This is the only path by which
 * the map text changes.
 *
 * "Apply" a proposal: `from_proposal` — a `wrong` proposal to any map version of this space,
 * not yet decided (else 400 `space_guide_proposal` / `not_proposed`); checked by the one who writes the map. Sections — those
 * the person saved in the form (they could edit the proposal text; "not laid out" is not saved). The new version and the
 * proposal turning `applied` with the new version's `result_id` — under the proposal row lock (applyingGuideProposal); the log —
 * `write {op: space_guide, version, sections, from_proposal}`. The same text as now — the proposal is `applied` too
 * (`result_id` — the current version: it already has this text), the event `confirmation {op: correct_confirm, space_guide}`.
 * A proposal of an agent with extended access (an `extended` key) — an open version marked `extended_write`, an event with
 * `extended_open` (as "Confirm"); in org such a version goes to the curator's "Under review".
 */
export async function writeGuide(app: App, caller: Caller, slug: string, body: unknown): Promise<GuideWritten> {
  requireGuideEnabled(app);
  await requireHuman(app, caller, "Edit the “How we work” guide", WHERE);
  const b = jsonObjectBody(body, "{sections}");
  rejectUnknownFields(b, ["sections", "from_proposal"]);
  const changes = checkGuideChanges(b.sections);
  const fromProposal = checkFromProposal(b.from_proposal);
  const s = await resolveWithArchive(app, caller, slug);
  if (!s) throw notFound();
  const problem = guideWriterProblem(s);
  if (problem) throw problem;
  const me = caller.person!;
  const limits = guideLimitsOf(app);
  return withKeyLock(guideLockKey(s.id), async () => {
    const ref = await currentGuideRef(app, s.id);
    // a map hidden by a move (running or failed) is not an edit base nor a reason to start a second chain
    if (ref?.busy) throw inProgress(10);
    if (ref && (await app.db.control.query("SELECT 1 FROM class_moves WHERE record_id = $1 AND status IN ('pending','copying','verifying')", [ref.id])).rowCount) throw inProgress();
    // the proposal being applied — before reading sections: a decided or foreign one leads to no version and no "already so"
    const proposal: GuideProposalRow | null = fromProposal ? await guideProposalOf(app, caller, s.id, fromProposal) : null;
    const cur = ref ? await loadSections(app, caller, ref) : {};
    const { next, changed } = applyGuideChanges(cur, changes);
    if (ref && !changed.length) {
      if (proposal) {
        await guideProposalKnown(app, caller, proposal, ref.id);
        await audit(app, caller, { event_type: "confirmation", class: ref.cls, record_ids: [ref.id], space_id: s.id,
                                   details: { op: "correct_confirm", correction_id: proposal.id, kind: "wrong", by_role: proposal.by_role, space_guide: true, already_known: true } });
      }
      // the answer carries the current sections: for a closed map that is a showing of closed — with an event, as for GET
      if (ref.cls === "closed") await auditShownClosed(app, caller, [ref.id], "space_guide_view");
      return { already_known: true, changed: [], guide: guideView(s, { ...ref, sections: cur }, limits) };
    }
    if (!GUIDE_SECTIONS.some((x) => next[x]))
      throw invalid(ref ? "You cannot clear every section. Delete the guide’s record if you no longer need it" : "The guide is empty. Fill in at least one section",
                    { field: "sections", reason: "space_guide_empty" });
    const text = guideText(next), tokens = guideTokens(next);
    if (tokens > limits.max_tokens) throw guideLimitError(tokens, limits.max_tokens);
    // the space was switched to "people only", but the map is open — the new version will not land open
    if (ref && ref.cls === "open" && s.default_class === "closed") throw await followSpaceClosed(app, caller, s, ref);
    const cls: DataClass = ref?.cls ?? s.default_class;
    const sourceRef = spaceGuideRef(s.id);
    // a version from a proposal of an agent with extended access is marked as if the agent had corrected it itself — as for
    // "Confirm" (corrections.ts proposalMark); in org with the mark — to the curator's "Under review"
    const extended = cls === "open"
      ? (await admitOpen(app, caller, s, next, text, sourceRef)) ?? (proposal ? await proposalExtendedMark(app, { cls, keyId: proposal.key_id, link: false }) : null)
      : null;
    const version = (ref?.version ?? 0) + 1, at = new Date();
    const n: NewRecord = {
      id: newId(), type: "note", space: s, classOverride: cls, title: GUIDE_TITLE, text, method: "stated_by_human", origin: "human", confirmed: true,
      sourceKind: "agent", sourceRef, occurredAt: at, entities: { known: [], unresolved: [] }, ownerId: me.id,
      // a version from a proposal remembers it (version history: "from an agent's proposal") — the id and who proposed, no text
      attrs: { subtype: GUIDE_SUBTYPE, guide: { sections: next, changed, ...(proposal ? { proposal: { id: proposal.id, origin: proposal.origin } } : {}) } },
      version, supersedesId: ref?.id ?? null, orgVia: "space_guide",
      auditDetails: { op: "space_guide", version, sections: changed, ...(proposal ? { from_proposal: proposal.id } : {}) },
    };
    const adm: Admitted = { cls, openCheck: null, fallback: null, extended, derived: null };
    // the new version — under the record:<previous> lock (like fixing one's own note): locator, org review row and record — with
    // the lock transaction; the log and the worker — after its COMMIT (withCommittedOwnerEffects; the lock pool is control)
    // from a proposal — under its row lock: the version and `applied` together, "Reject" waits meanwhile
    const create = (a: App, o: Parameters<typeof createRecord>[4] = {}) =>
      proposal ? applyingGuideProposal(a, caller, proposal, () => createRecord(a, caller, n, adm, o)) : createRecord(a, caller, n, adm, o);
    const created = ref
      ? await withCommittedOwnerEffects(app, (effApp) => withRecordLocksWait(effApp, [ref.id], async (q) => {
          await guideHeadUnchanged(effApp, q, ref);
          return create(effApp, { control: q });
        }, { waitSec: 5 }))
      : await create(app);
    return { already_known: false, changed, guide: guideView(s, { id: created.id, version, occurred_at: at, cls: created.class, sections: next }, limits) };
  });
}

// ---------------------------------------------------------------- for the agent: the memory_list line and the path in memory_me

export interface VisibleGuide { id: string; cls: DataClass; version: number; occurred_at: Date; path: string }

/**
 * The current space maps visible to the caller: by the same selection builder as `memory_list` and the counters of
 * `memory_me` (listingSpec/visibleSql per scope class; held "Wrong" ones in org — out), one query per class by
 * `source_ref = ANY(...)`. The highest version per space. Only the path — no map text here.
 */
export async function visibleGuides(app: App, caller: Caller, spaces: ReadonlyArray<Pick<SpaceAccess, "id" | "slug">>): Promise<Map<string, VisibleGuide>> {
  const out = new Map<string, VisibleGuide>();
  if (!spaces.length || !caller.person) return out;
  const ids = spaces.map((x) => x.id), slugs = new Map(spaces.map((x) => [x.id, x.slug]));
  const spec = listingSpec(app, caller, ids);
  const org = await orgSpace(app);
  for (const cls of caller.scope.classes) {
    const args: unknown[] = [], bind = binder(args);
    const vis = visibleSql(spec, cls, bind);
    if (vis === null) continue;
    const held = org && ids.includes(org.id) ? await heldIds(app, caller, cls) : [];
    const rows = (await app.db.records(cls, caller.scope).query(
      `SELECT r.id, r.space_id, r.source_ref, r.version, r.occurred_at FROM records_live r
        WHERE ${vis} AND r.space_id = ANY(${bind(ids)}::uuid[]) AND r.type = 'note' AND r.source_kind = 'agent' AND r.source_ref = ANY(${bind(ids.map(spaceGuideRef))}::text[])
          ${held.length ? `AND r.id <> ALL(${bind(held)}::uuid[])` : ""}`, args)).rows;
    for (const r of rows) {
      // a map only of its own space: the "record home — source" pair (ANY over both lists would let a foreign one through)
      if (r.source_ref !== spaceGuideRef(r.space_id)) continue;
      const v = Number(r.version), at = new Date(r.occurred_at), was = out.get(r.space_id);
      if (was && (was.version > v || (was.version === v && was.occurred_at >= at))) continue;
      out.set(r.space_id, { id: r.id, cls, version: v, occurred_at: at, path: recordPath(slugs.get(r.space_id)!, "note", at, r.id) });
    }
  }
  return out;
}

/**
 * The first readme line of `memory_list /spaces/<slug>`: the path of a map visible to the caller — a "How we work: <path>"
 * line with a memory_read hint. Only the path, not the map text. Off or no map — null (the old readme).
 */
export async function guideListLine(app: App, caller: Caller, space: Pick<SpaceAccess, "id" | "slug">): Promise<string | null> {
  if (!guideEnabled(app)) return null;
  const g = (await visibleGuides(app, caller, [space])).get(space.id);
  return g ? `How we work: ${g.path} (read with memory_read)` : null;
}

/**
 * Map paths for `memory_me.spaces[].guide_path`: off, or a workplace session (the frame asks /me on
 * every page, and the person opens the map on its page) — null, no field. Otherwise — the maps visible to the caller.
 */
export async function meGuidePaths(app: App, caller: Caller, spaces: ReadonlyArray<Pick<SpaceAccess, "id" | "slug">>): Promise<Map<string, VisibleGuide> | null> {
  if (!guideEnabled(app) || caller.keyKind === "session") return null;
  return visibleGuides(app, caller, spaces);
}

// ---------------------------------------------------------------- workplace routes

/**
 * The map REST: only a person in the workplace (a session), buckets — `spaces_view` for reading and `me_keys` for writing.
 * Switch off — `403` with the "map turned off by the administrator" text on both routes.
 */
export function registerSpaceGuideRoutes(r: Hono<any>, app: App): void {
  const who = async (c: Context, bucket: "spaces_view" | "me_keys", what: string): Promise<Caller> => {
    const caller = c.get("caller") as Caller;
    app.limiter.check(caller, bucket);
    requireGuideEnabled(app);
    await requireHuman(app, caller, what, WHERE);
    return caller;
  };
  r.get("/api/v1/me/spaces/:slug/guide", async (c) =>
    c.json(await readGuide(app, await who(c, "spaces_view", "View the “How we work” guide"), c.req.param("slug") ?? "",
                           { proposal: c.req.query("proposal") ?? null, cursor: c.req.query("proposals_cursor") ?? null })));
  r.put("/api/v1/me/spaces/:slug/guide", async (c) => {
    const caller = await who(c, "me_keys", "Edit the “How we work” guide");
    return c.json(await writeGuide(app, caller, c.req.param("slug") ?? "", await c.req.json().catch(() => null)));
  });
}
