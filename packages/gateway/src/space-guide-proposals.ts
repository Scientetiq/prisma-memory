// Edit proposals for the "How we work" map. An agent does not change the map: it
// proposes a whole new map text — `memory_correct {kind: wrong, text}`. The proposal lands as a record_corrections row
// in the map version's class database and waits for the map writer: the owner, in "Company common knowledge" — the curator or
// the org owner. It is never published by itself — whatever the proposer's role, including the owner's own
// agent. "Apply" — only on the map page: the form opens with the proposal text laid out by sections
// (text outside known headings — apart, "not laid out" — and is not saved), the person edits and saves — this is
// `PUT …/guide` with `from_proposal` (space-guide.ts); the proposal gets `applied` and the new `result_id`. "Reject" —
// the common "Record edits" path with the map decider rule. The common "Confirm" for the map — a refusal with a link to the page.
//
// Here — pure rules (what to accept, who decides, texts) and reads of proposal rows and version history for the map page.
// The module does not import corrections.ts and space-guide.ts: corrections.ts → write.ts → space-guide.ts — an import cycle.
// An administrator does not read proposals: there are no panel routes, the log holds codes and ids, no text.
import { binder, estimateTokens, GUIDE_SECTIONS, invalid, MemoryError, parseGuideText, spaceGuideRef, tx, visibleSql,
         type DataClass, type GuideSection, type GuideSections } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { heldIds, orgSpace } from "./org-hold.ts";
import { decodeKeyset, encodeKeyset, isUuidParam, keysetAtSql, keysetCompare } from "./paging.ts";
import { guideWriterProblem, type GuideSpaceFacts } from "./space-guide-ref.ts";
import { listingSpec } from "./visibility.ts";
import { workplaceUrl } from "./workplace.ts";

// ---------------------------------------------------------------- texts (plain words)

/** Refusal for `own_note`: what the agent should do instead. */
export const GUIDE_OWN_NOTE_REFUSAL = "The space owner edits the “How we work” guide in the workspace. Propose a correction with kind wrong and the full replacement guide text. The owner will see it on the guide page";
/** Refusal for `outdated` and `extraction_error`. */
export const GUIDE_KIND_REFUSAL = "For the “How we work” guide, propose the full replacement text with kind wrong";
/** The common "Confirm" on a map proposal. */
export const GUIDE_CONFIRM_REFUSAL = "Apply guide corrections on the “How we work” page, where you can see what will change";
/** "This is wrong" and "Withdraw" for an applied map edit: a new version already exists, it is undone by a new version. */
export const GUIDE_UNDO_REFUSAL = "Applied corrections to “How we work” cannot be undone. Edit the guide on its page to create a new version";
/** A reader outside the space with access.correct_non_participant = deny. */
export const GUIDE_READER_REFUSAL = "Space members can propose corrections to the “How we work” guide";
export const GUIDE_PROPOSAL_MISSING = "The proposal was not found or belongs to another guide";
export const GUIDE_PROPOSAL_DECIDED = "The proposal has already been resolved or withdrawn";

/** Answer to the agent on an accepted proposal: the map is unchanged, the owner decides on the map page. */
export const GUIDE_PROPOSED_TEXT = (url: string | null): string =>
  `Your correction proposal for “How we work” was saved. The guide is unchanged for now. The space owner will see it on the guide page${url ? ` (${url})` : ""}: ` +
  "they will review it, edit it if needed and apply or reject it. Agents cannot see the proposal, and it stays out of the guide until the owner applies it.";

/** The map page in the workplace (a project subpage; the tab link is set elsewhere). */
export const guidePagePath = (slug: string): string => `/projects/${encodeURIComponent(slug)}/guide`;
export const guidePageUrl = (app: Pick<App, "settings">, slug: string): string | null => workplaceUrl(app as App, guidePagePath(slug));

// ---------------------------------------------------------------- pure rules

export interface GuideCorrectionInput { kind: string; text?: string; fields?: unknown; quote?: string; newer_id?: string }

/**
 * The `memory_correct` rule for a map record — instead of the common rules, before decideStatus: `own_note` — refusal
 * `forbidden` (`space_guide_workplace_only`) for any role and any `origin`; `outdated` and `extraction_error` — refusal
 * `kind_not_applicable` with the hint "kind wrong"; `wrong` — always a proposal, `origin` agent and human — both (this is
 * the agent's proposal), `text` is required and only it (fields, a quote and a newer record — refusal), the limit —
 * `access.space_guide.max_tokens` by estimateTokens, not the 2,000 characters of a correction.
 */
export function guideCorrectionRule(a: GuideCorrectionInput, origin: "human" | "agent", maxTokens: number): "proposed" {
  void origin;                                                 // both origins fit: the rule does not depend on it
  if (a.kind === "own_note")
    throw new MemoryError("forbidden", GUIDE_OWN_NOTE_REFUSAL, { hint: "Propose a guide correction with kind wrong and the full replacement guide text", details: { reason: "space_guide_workplace_only" } });
  if (a.kind !== "wrong") throw invalid(GUIDE_KIND_REFUSAL, { reason: "kind_not_applicable" });
  if (a.fields !== undefined || a.quote !== undefined || a.newer_id !== undefined)
    throw invalid("For a “How we work” proposal, use only text for the full replacement guide text", { reason: "kind_not_applicable" });
  const text = typeof a.text === "string" ? a.text.trim() : "";
  if (!text) throw invalid("For a “How we work” proposal, provide the full replacement guide in text, including section headings (## Where to find tasks …)", { reason: "kind_not_applicable" });
  const tokens = estimateTokens(text);
  if (tokens > maxTokens)
    throw invalid(`The proposal exceeds the guide’s limit of ${maxTokens} tokens. It is about ${tokens} tokens. Keep the guide to short lines and links, and save knowledge as notes`,
                  { reason: "text_too_long", tokens, max: maxTokens });
  return "proposed";
}

/**
 * A map proposal's status: always `proposed`. The access.correct_non_participant setting does not hinder space members
 * — it is for readers outside the space (the reader role): with `deny` they get a refusal.
 */
export function guideProposalStatus(role: string, nonParticipant: "proposed" | "deny"): "proposed" {
  if (role === "reader" && nonParticipant === "deny") throw new MemoryError("forbidden", GUIDE_READER_REFUSAL, { details: { reason: "not_participant" } });
  return "proposed";
}

/**
 * Whether the caller decides on a map proposal: the one who writes the map (guideWriterProblem — the owner, in org the curator
 * or the org owner; not personal, not an archive), not the role to the record. One's own proposal is not decided — except
 * a proposal of one's own agent (the row came over MCP, `via = mcp`): its owner applies or rejects it just like someone else's.
 */
export function guideDecides(space: GuideSpaceFacts, me: string, row: { by_person: string; via: string }): boolean {
  return guideWriterProblem(space) === null && (row.by_person !== me || row.via === "mcp");
}

/** SQL condition "the record is a map version of its own space" (record alias `a`); NULL gives nothing in any branch. */
export const GUIDE_ROW_SQL = (a = "r"): string =>
  `(${a}.type = 'note' AND ${a}.source_kind = 'agent' AND ${a}.source_ref IS NOT DISTINCT FROM ('space_guide:' || ${a}.space_id::text))`;

// ---------------------------------------------------------------- "Apply": the proposal row for PUT …/guide

export interface GuideProposalRow {
  id: string; cls: DataClass; target_id: string; by_person: string; by_role: string; via: string; origin: "human" | "agent"; created_at: Date;
  /** The key the agent sent the proposal with (a session — its key): by it the version from the proposal gets its mark. */
  key_id: string | null;
}

/**
 * A proposal applied by a map edit (`from_proposal`): `wrong` to any map version of this space (not
 * deleted), `proposed`. Searched in the caller's class databases (rows move with the record into closed only). None or another
 * map — 400 `space_guide_proposal`; already decided — 400 `not_proposed`. The caller checked the right (it writes the map).
 */
export async function guideProposalOf(app: App, caller: Caller, spaceId: string, id: string): Promise<GuideProposalRow> {
  for (const cls of caller.scope.classes) {
    const row = (await app.db.records(cls, caller.scope).query(
      `SELECT k.id, k.target_id, k.status, k.by_person, k.by_role, k.via, k.origin, k.created_at, k.key_id FROM record_corrections k JOIN records r ON r.id = k.target_id
        WHERE k.id = $1 AND k.kind = 'wrong' AND r.space_id = $2 AND ${GUIDE_ROW_SQL("r")} AND r.source_ref = $3 AND r.deleted_at IS NULL`,
      [id, spaceId, spaceGuideRef(spaceId)])).rows[0];
    if (!row) continue;
    if (row.status !== "proposed") throw invalid(GUIDE_PROPOSAL_DECIDED, { field: "from_proposal", reason: "not_proposed" });
    return { id: row.id, cls, target_id: row.target_id, by_person: row.by_person, by_role: row.by_role, via: row.via, origin: row.origin, created_at: new Date(row.created_at),
             key_id: row.key_id ?? null };
  }
  throw invalid(GUIDE_PROPOSAL_MISSING, { field: "from_proposal", reason: "space_guide_proposal" });
}

const decided = () => invalid(GUIDE_PROPOSAL_DECIDED, { field: "from_proposal", reason: "not_proposed" });
const APPLIED = `UPDATE record_corrections SET status = 'applied', text = NULL, fields = NULL, quote = NULL, result_id = $2, decided_by = $3, decided_at = now()
                  WHERE id = $1 AND status = 'proposed'`;

/**
 * A new map version from a proposal: the proposal row — under a row lock (FOR UPDATE) in its database's transaction; while
 * the version is written (`fn`), "Reject" and "Withdraw" wait, then see it decided. Version written — the proposal is `applied`,
 * `result_id` — the new version, the person's words are erased (words live only until applied). Meanwhile the proposal
 * was decided — 400 `not_proposed`, the version is not written. A version write failure — rollback, the proposal keeps waiting.
 */
export async function applyingGuideProposal<T extends { id: string }>(app: App, caller: Caller, p: GuideProposalRow, fn: () => Promise<T>): Promise<T> {
  return tx(app.db.recordsForWrite(p.cls, caller.scope), async (c) => {
    const cur = (await c.query("SELECT status FROM record_corrections WHERE id = $1 FOR UPDATE", [p.id])).rows[0];
    if (cur?.status !== "proposed") throw decided();
    const out = await fn();
    const upd = await c.query(APPLIED, [p.id, out.id, caller.person!.id]);
    if (!upd.rowCount) throw decided();
    return out;
  });
}

/** The proposal matched the current map (same text): it is applied — `result_id` is the current version, which has this text. */
export async function guideProposalKnown(app: App, caller: Caller, p: GuideProposalRow, currentId: string): Promise<void> {
  const upd = await app.db.recordsForWrite(p.cls, caller.scope).query(APPLIED, [p.id, currentId, caller.person!.id]);
  if (!upd.rowCount) throw decided();
}

// ---------------------------------------------------------------- map page: "Agent proposals" and version history

/** How many proposals and versions the map page gives: proposals — the 20 newest, then by cursor; history — up to 50, 10 per page. */
export const GUIDE_PROPOSALS_MAX = 20;
export const GUIDE_HISTORY_MAX = 50;

export interface GuideProposalView {
  id: string; at: string; by_role: string; origin: "human" | "agent";
  /** Who proposed: name and login (seen by those who decide and by the proposer — as in "Record edits"). */
  by: { login: string; display_name: string } | null;
  /** One's own proposal (by one's own agent or in the workplace). */
  mine: boolean;
  /** Proposed to an earlier map version: the map was changed after it — it does not take that version's edits into account. */
  stale: boolean;
  /** The proposal text laid out by section headings (parseGuideText); outside sections — `unplaced`. */
  sections: GuideSections; unplaced: string | null; tokens: number;
  can: { apply: boolean; reject: boolean; withdraw: boolean };
}

export interface GuideVersionView {
  id: string; version: number; at: string; current: boolean;
  by: { login: string; display_name: string } | null;
  /** Which sections the version changed (codes); for the first — the filled ones. */
  changed: GuideSection[];
  /** A version from an edit proposal ("Apply"): who sent it — an agent or a person in their words; otherwise null. */
  proposal: "human" | "agent" | null;
}

async function peopleOf(app: App, ids: string[]): Promise<Map<string, { login: string; display_name: string }>> {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return new Map();
  return new Map((await app.db.control.query("SELECT id, login, display_name FROM people WHERE id = ANY($1::uuid[])", [uniq])).rows
    .map((p) => [p.id as string, { login: p.login as string, display_name: (p.display_name as string | null) ?? p.login as string }]));
}

/** Map page parameters (GET …/guide): the proposal from the address ("Apply" from "Record edits") and the list cursor. */
export interface GuideProposalsQuery { proposal?: string | null; cursor?: string | null }

/** Parsing GET …/guide parameters: `proposal` — a uuid, `proposals_cursor` — a cursor from `proposals_next`; else 400 with the field. */
export function guideProposalsQuery(raw: { proposal?: string | null; cursor?: string | null }): { proposal: string | null; cursor: { at: string; id: string } | null } {
  const proposal = raw.proposal ? raw.proposal.trim() : "";
  if (proposal && !isUuidParam(proposal)) throw invalid("proposal must be the id of a guide correction proposal", { field: "proposal" });
  let cursor: { at: string; id: string } | null = null;
  try { cursor = decodeKeyset(raw.cursor ?? null); }
  catch { throw invalid("proposals_cursor must be the opaque string from the previous response (proposals_next)", { field: "proposals_cursor" }); }
  return { proposal: proposal ? proposal.toLowerCase() : null, cursor };
}

/**
 * Waiting proposals for the space map (the map page): to any map version visible to the caller by the same
 * builder as the selections (listingSpec/visibleSql). The one who decides (writes the map) sees all; the rest — only their own.
 * Newest first, GUIDE_PROPOSALS_MAX per page; further — by the "time + id" cursor (`next`; otherwise
 * proposals past the 20th were unreachable, and for an old version "Record edits" lacks them too). `asked` — the proposal from
 * the page address (`?proposal=`, "Apply" from "Record edits"), by the same rules, wherever it stands in the list: waiting
 * and visible to the caller — its view, else null (decided, withdrawn, foreign or none); not asked — undefined. `closed` —
 * target version ids of rows shown from the closed database: a showing of closed, so the page logs an event before answering.
 */
export async function guideProposals(app: App, caller: Caller, space: GuideSpaceFacts & { id: string }, current: string | null,
                                     q: { proposal?: string | null; cursor?: { at: string; id: string } | null } = {})
  : Promise<{ items: GuideProposalView[]; more: boolean; next: string | null; asked: GuideProposalView | null | undefined; closed: string[] }> {
  const me = caller.person!.id;
  const decider = guideWriterProblem(space) === null;
  const spec = listingSpec(app, caller, [space.id]);
  type Row = { id: string; target_id: string; by_person: string; by_role: string; via: string; origin: "human" | "agent"; text: string | null; created_at: Date;
               at_key: string; cls: DataClass };
  const rowsOf = async (extra: (b: (v: unknown) => string) => string, limit: number): Promise<Row[]> => {
    const out: Row[] = [];
    for (const cls of caller.scope.classes) {
      const args: unknown[] = [], b = binder(args);
      const vis = visibleSql(spec, cls, b);
      if (vis === null) continue;
      const found = (await app.db.records(cls, caller.scope).query(
        `SELECT k.id, k.target_id, k.by_person, k.by_role, k.via, k.origin, k.text, k.created_at, ${keysetAtSql("k.created_at")} AS at_key
           FROM record_corrections k JOIN records r ON r.id = k.target_id
          WHERE k.status = 'proposed' AND k.kind = 'wrong' AND r.space_id = ${b(space.id)}::uuid AND ${GUIDE_ROW_SQL("r")} AND r.deleted_at IS NULL AND r.hidden_at IS NULL
            AND ${vis} ${decider ? "" : `AND k.by_person = ${b(me)}::uuid`} ${extra(b)}
          ORDER BY k.created_at DESC, k.id DESC LIMIT ${b(limit)}`, args)).rows;
      for (const r of found) out.push({ ...r, created_at: new Date(r.created_at), cls });
    }
    return out;
  };
  const cur = q.cursor ?? null;
  const rows = (await rowsOf((b) => (cur ? `AND (k.created_at, k.id) < (${b(cur.at)}::timestamptz, ${b(cur.id)}::uuid)` : ""), GUIDE_PROPOSALS_MAX + 1))
    .sort((x, y) => -keysetCompare({ at_key: x.at_key, id: x.id }, { at_key: y.at_key, id: y.id }));
  const page = rows.slice(0, GUIDE_PROPOSALS_MAX);
  const more = rows.length > GUIDE_PROPOSALS_MAX;
  const last = page.at(-1);
  const asked = q.proposal ? (await rowsOf((b) => `AND k.id = ${b(q.proposal)}::uuid`, 1))[0] ?? null : undefined;
  const shown = asked ? [...page, asked] : page;
  const people = await peopleOf(app, shown.map((r) => r.by_person));
  const view = (r: Row): GuideProposalView => {
    const parsed = parseGuideText(r.text ?? "");
    const mine = r.by_person === me;
    return { id: r.id, at: r.created_at.toISOString(), by_role: r.by_role, origin: r.origin, by: people.get(r.by_person) ?? null, mine, stale: r.target_id !== current,
             sections: parsed.sections, unplaced: parsed.unplaced, tokens: estimateTokens(r.text ?? ""),
             can: { apply: decider, reject: guideDecides(space, me, r), withdraw: mine } };
  };
  return { items: page.map(view), more, next: more && last ? encodeKeyset(last.at_key, last.id) : null, asked: asked === undefined ? undefined : asked && view(asked),
           closed: [...new Set(shown.filter((r) => r.cls === "closed").map((r) => r.target_id))] };
}

/**
 * The map version history (the map page) — only metadata: number, date, who wrote it, which sections changed.
 * Versions visible to the caller (the same builder; held "Wrong" ones in org — out), newest first, at most
 * GUIDE_HISTORY_MAX (`more`). No version text here — it is opened by the record page (read by id, with its log).
 */
export async function guideHistory(app: App, caller: Caller, space: { id: string }): Promise<{ items: GuideVersionView[]; more: boolean }> {
  const spec = listingSpec(app, caller, [space.id]);
  const org = await orgSpace(app);
  type Row = { id: string; version: number; occurred_at: Date; owner_id: string; is_current: boolean; changed: unknown; proposal: string | null; cls: DataClass };
  const rows: Row[] = [];
  for (const cls of caller.scope.classes) {
    const args: unknown[] = [], b = binder(args);
    const vis = visibleSql(spec, cls, b);
    if (vis === null) continue;
    const held = org && org.id === space.id ? await heldIds(app, caller, cls) : [];
    const found = (await app.db.records(cls, caller.scope).query(
      `SELECT r.id, r.version, r.occurred_at, r.owner_id, r.is_current, r.attrs->'guide'->'changed' AS changed, r.attrs->'guide'->'proposal'->>'origin' AS proposal FROM records r
        WHERE r.space_id = ${b(space.id)}::uuid AND ${GUIDE_ROW_SQL("r")} AND r.deleted_at IS NULL AND r.hidden_at IS NULL AND ${vis}
          ${held.length ? `AND r.id <> ALL(${b(held)}::uuid[])` : ""}
        ORDER BY r.version DESC, r.occurred_at DESC LIMIT ${b(GUIDE_HISTORY_MAX + 1)}`, args)).rows;
    for (const r of found) rows.push({ ...r, version: Number(r.version), occurred_at: new Date(r.occurred_at), cls });
  }
  const seen = new Set<string>();
  const uniq = rows.sort((x, y) => y.version - x.version || y.occurred_at.getTime() - x.occurred_at.getTime()).filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  const page = uniq.slice(0, GUIDE_HISTORY_MAX);
  const people = await peopleOf(app, page.map((r) => r.owner_id));
  return {
    items: page.map((r) => ({ id: r.id, version: r.version, at: r.occurred_at.toISOString(), current: r.is_current === true, by: people.get(r.owner_id) ?? null,
                              changed: Array.isArray(r.changed) ? GUIDE_SECTIONS.filter((s) => (r.changed as unknown[]).includes(s)) : [],
                              proposal: r.proposal === "agent" || r.proposal === "human" ? r.proposal : null })),
    more: uniq.length > GUIDE_HISTORY_MAX,
  };
}
