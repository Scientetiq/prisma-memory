// "Handed to me": the keeper of a dismissed employee's personal space reads the
// employee's records themselves, in the workplace, without agents.
//
// The keeper is not in readableSpaces or the visibility core: personal P is no "space" to them but separate routes /me/custody*,
// and each starts with requireHuman. So agents, search, memory_me, the derivation gate and handover do not see personal P by
// construction, and "only you" stays true for a shown P.
//
// Access: a personal_custody row of this dismissal (not older than the freeze) with custodian_id = the caller,
// P is not working, its space is frozen, the grace period (access.dismissed_custody_after_days) passed, same instance, P not
// a demo persona; access.dismissed_custody ≠ off. Otherwise —
// not_found (not the keeper, grace not over, another keeps it); off — not_found with details.reason custody_off (the setting
// is shared and says nothing of records); P works again — 409 invalid_argument with the "works again" text, only to the one
// who was their keeper when P returned (the admin event {op: custody_end, reason: reactivated, previous: they}; before,
// it went to the whole chain of heads, and the head of an employee who never left read a false "works again"; to the rest —
// not_found, as always).
//
// What is visible: the "top rows" of personal P — no parent, or a parent the keeper will not open here: not in personal P
// (so a derived record whose root is in another space shows too), non-current, hidden or deleted (a correction
// to a record the employee later replaced with own text is a row of its own), the current version, not hidden; those deleted
// by the employee — a separate list, where a derived record hides under
// its parent only if that is deleted too (a decision deleted apart from a kept transcript is a row of its own;
// inside a live record deleted derived ones are not shown). Live meetings of P with other
// participants (transcriber roots: record_people not P or pending invites; the family by source_ref as in the job, and the rest
// of a handover already begun), and all derived from them, wherever it lies, are seen neither in the list, counts nor by id
// (the keeper reads meetings without other participants): the organizer runs them,
// and while a meeting waits for handover (grace period, match, busy, wait mode) the keeper does not read it here, as before
// (participants read it as participants — record_people). One deleted by the employee is in the deleted list.
// Closed ones ("for myself") — with
// dismissed_custody = all and the closed class in the session: in the list — a list event, the text only by POST after
// confirmation, the event read {op: custody_read, closed: true}; a GET of a closed one opens nothing and writes no events
// (link prefetch and browser history open nothing). Otherwise only the count of closed ones (closed_hidden). The read log —
// space_id = personal P: the administrator sees "who opened" by space, without the text.
//
// The text on the keeper's page. If the keeper got a file link — the first part, as with memory_read
// (readPart up to limits.read_max_tokens): the workplace draws the text in one synchronous pass in a process shared by all, and
// a document upload takes up to 20 MB of text; the whole — "Download file". Without a file link (a transcript whose text did not
// change at intake, a document whose original was not kept) — the text up to the no-file text intake limit (2,000,000 characters,
// CUSTODY_NO_FILE_MAX_TOKENS): else a long transcript's tail could never be read by the keeper — they get no continuation,
// and a transcript cannot be copied. Longer without a file — only a document with a storage failure at upload: the start and
// a line about it. Such a text is drawn in bounded time: the workplace's markdown parsing is linear — links and
// list items.
//
// "Copy to myself" is not a handover: P's record (company property) stays in place; the copy is a closed record of the caller
// in their personal space, author — them, attrs.copied_from {person, record_id, at}. Only a note or decision no longer than the
// memory_remember limit; a closed one with confirm: true. No derivation links: by the core the caller cannot read the source.
// The copy carries what the bans on showing to agents rest on: domain tags and the source's entity links
// (except P's project tag) — the "never open" rules by tag and entity kind act on it too; a copy of
// meeting material (a meeting event, a detached decision, a meeting retelling, a copy of such a copy) gets attrs.meeting_origin:
// "Make available to agents" does not show it, just as the source.
import type { Hono } from "hono";
import { archivedDenied, custodyCurrentSql, custodyPolicy, estimateTokens, handedKey, handedParts, inCustodyScope, invalid, log, meetingOriginOf, meetingOriginOfSources, meetingSharedSql, MemoryError,
         notFound, recordPath, showcaseSql, testLoginSql, type ClassScope, type CustodyBasis, type CustodyPolicy, type DataClass, type EntityKind } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { readableSpaces, resolveSpace } from "./access.ts";
import { auditRead } from "./audit.ts";
import { sameRecordKey, withKeyLock } from "./control-lock.ts";
import { signedOriginalUrl } from "./originals.ts";
import { decodeKeyset, encodeKeyset, intParam, isUuidParam, keysetAtSql, keysetCompare } from "./paging.ts";
import { readPart } from "@memory/mcp-core";
import { textsOf } from "./mcp-texts.ts";
import { createRecord, sourceHash, type ResolvedEntities } from "./records.ts";
import { SLUG_RE } from "./spaces.ts";
import { requireHuman } from "./workplace.ts";

/** Refusal texts — the workplace shows them by details.reason. */
export const CUSTODY_READ_TEXTS = {
  off: "Nobody can currently read former colleagues’ personal records, as configured by the memory administrator. The records are kept.",
  notCopyable: "You can copy a note or decision. For a document, download the file; for a meeting, read it here.",
  tooBig: "This record is too large to copy. Download the file or save the parts you need.",
  confirm: "Confirm before copying this closed record.",
  empty: "This record has no text to copy.",
  activeAgain: (name: string) => `${name} is back with the company. These records belong to them again.`,
} as const;

/** Where a person reads (the link in the requireHuman refusal to an agent). */
const WHERE = { path: "/custody", section: "Handed over to me" };
const human = (app: App, caller: Caller) => requireHuman(app, caller, "Read former employees’ records", WHERE);

/** A refusal with a reason in details.reason and its own status (409 "works again"; 400 for copies). */
class CustodyReadRefusal extends MemoryError {
  constructor(message: string, readonly httpStatus: 400 | 409, reason: string) { super("invalid_argument", message, { details: { reason } }); }
  override get status(): number { return this.httpStatus; }
}
const offRefusal = (): MemoryError => new MemoryError("not_found", CUSTODY_READ_TEXTS.off, { details: { reason: "custody_off" } });

/** Pool for counts and metadata (no content): the system one, as for panel report counts; sessions without the closed class need it. */
const metaPool = (app: App, cls: DataClass) => app.db.records(cls, { classes: [cls], tier: "system" } as ClassScope);
const CLASSES: readonly DataClass[] = ["open", "closed"];

/** A row of personal P ($1 — the personal space id): current, not hidden. */
const IN_P = (r = "r") => `${r}.space_id = $1 AND ${r}.is_current AND ${r}.hidden_at IS NULL`;
/**
 * Among the live ones a derived record hides under its parent only if it is opened through it: the parent is in personal P,
 * current, not hidden and not deleted — the keeper opens such a one from the live list, and its "What came of it" holds it.
 * The parent non-current (replaced by the employee's own text — own_note or extraction_error; the old version's children stay
 * current), hidden or deleted — the derived record is a live row of its own, in search and counts: otherwise a "wrong" or
 * "stale" correction to the old version could not be found without an id, and it was in no count. Mirror of UNDER_DELETED_PARENT.
 */
const UNDER_PARENT = (r = "r") =>
  `(${r}.parent_id IS NULL OR NOT EXISTS (SELECT 1 FROM records pr WHERE pr.id = ${r}.parent_id AND pr.space_id = ${r}.space_id
                                          AND pr.deleted_at IS NULL AND pr.is_current AND pr.hidden_at IS NULL))`;
/**
 * Among the deleted a derived record hides under its parent only if it is opened through the deleted parent:
 * for a deleted record "What came of it" (derivedOf) also shows deleted derived ones, for a live one it does not. So a decision
 * deleted apart from the transcript the employee kept is a deleted row of its own; one deleted together with it is under it.
 * The parent is deleted, current and not hidden (only such a one opens for the keeper).
 */
const UNDER_DELETED_PARENT = (r = "r") =>
  `(${r}.parent_id IS NULL OR NOT EXISTS (SELECT 1 FROM records pr WHERE pr.id = ${r}.parent_id AND pr.space_id = ${r}.space_id
                                          AND pr.deleted_at IS NOT NULL AND pr.is_current AND pr.hidden_at IS NULL))`;
/** A live "top row" ($1 — the personal space id): no live openable parent in personal P (UNDER_PARENT); current, not hidden. */
const TOP = (r = "r") => `${IN_P(r)} AND ${UNDER_PARENT(r)}`;
/** A "top row" of the ones the employee deleted: no deleted parent in personal P (UNDER_DELETED_PARENT). */
const TOP_DELETED = (r = "r") => `${IN_P(r)} AND ${UNDER_DELETED_PARENT(r)}`;

/** Whom the caller keeps, and since which day. */
export interface Held {
  space_id: string; slug: string; since: string; basis: CustodyBasis; levels: number;
  person: { id: string; login: string; display_name: string | null };
}

/**
 * Rows where the caller is the keeper and access is in force ($1 instance, $2 keeper, $3 grace days). The row is of this
 * dismissal (custodyCurrentSql): a row of an earlier dismissal that survived a rollback is replaced by the pass.
 */
const HELD_SQL = `
  FROM personal_custody c JOIN people p ON p.id = c.person_id
  JOIN spaces s ON s.id = c.space_id AND s.kind = 'personal' AND s.owner_id = p.id AND s.instance_id = c.instance_id
 WHERE c.instance_id = $1 AND c.custodian_id = $2 AND NOT p.active AND NOT ${showcaseSql("p")}
   AND (NOT ${testLoginSql("p")} OR $4::boolean)
   AND s.archived_at IS NOT NULL AND s.archived_at <= now() - make_interval(days => $3::int) AND ${custodyCurrentSql("c", "s")}`;

const heldOf = (r: any): Held => ({
  space_id: r.space_id, slug: r.slug, since: new Date(r.archived_at).toISOString(), basis: r.basis, levels: Number(r.levels ?? 0),
  person: { id: r.person_id, login: r.login, display_name: r.display_name ?? null },
});

/** Menu summary: for how many who left the caller is a keeper with access in force (0 when off). */
export async function custodyHeldCount(app: App, caller: Caller): Promise<number> {
  const policy = custodyPolicy(app.settings);
  if (policy.read === "off" || !caller.person) return 0;
  const r = (await app.db.control.query(`SELECT count(*)::int AS n ${HELD_SQL}`, [app.instanceId, caller.person.id, policy.afterDays, policy.testToo])).rows[0];
  return Number(r?.n ?? 0);
}

/** The read mode; off — refusal at once (before looking up the person: the answer does not depend on whether records exist). */
function readMode(app: App): CustodyPolicy {
  const policy = custodyPolicy(app.settings);
  if (policy.read === "off") throw offRefusal();
  return policy;
}

/**
 * Was the caller its keeper when the employee came back: the admin event {op: custody_end, reason: reactivated,
 * previous: the caller} for this space (the gateway writes it at load, the job too; partial index audit_events_custody_idx).
 * Log unavailable — no (the answer is not_found, as to an outsider).
 */
async function heldBeforeReturn(app: App, spaceId: string, me: string): Promise<boolean> {
  try {
    return !!(await app.db.auditRead().query(
      `SELECT 1 FROM audit_events WHERE instance_id = $1 AND event_type = 'admin' AND space_id = $2 AND details->>'op' = 'custody_end'
          AND details->>'reason' = 'reactivated' AND details->>'previous' = $3 LIMIT 1`, [app.instanceId, spaceId, me])).rowCount;
  } catch (e) {
    log.warn("custody_return_check_failed", { error: ((e as Error)?.message ?? "").slice(0, 200) });
    return false;
  }
}

/**
 * Personal P by address (the personal space slug, u-…) — only to a keeper with access in force. P works again — 409 to the one
 * who was their keeper when P returned (heldBeforeReturn); to the rest — not_found. The org-table world (custodyWorld) is not
 * here: the personal address can be guessed, and each such request must not read all people and departments. The keeper's
 * row is only of this dismissal (custodyCurrentSql): an earlier keeper by a row that survived
 * a rollback (brought back, moved to another head and dismissed again under the old code) — not_found until the pass replaces it.
 */
export async function custodyOf(app: App, caller: Caller, slug: string, policy: CustodyPolicy): Promise<Held> {
  const me = caller.person!.id;
  if (!SLUG_RE.test(slug)) throw notFound();
  const r = (await app.db.control.query(
    `SELECT s.id AS space_id, s.slug, s.archived_at, p.id AS person_id, p.login, p.display_name, p.active, ${showcaseSql("p")} AS demo,
            c.custodian_id, c.basis, c.levels, COALESCE(s.archived_at <= now() - make_interval(days => $3::int), false) AS due
       FROM spaces s JOIN people p ON p.id = s.owner_id
       LEFT JOIN personal_custody c ON c.space_id = s.id AND c.instance_id = s.instance_id AND ${custodyCurrentSql("c", "s")}
      WHERE s.slug = $1 AND s.instance_id = $2 AND s.kind = 'personal'`, [slug, app.instanceId, policy.afterDays])).rows[0];
  if (!r || r.person_id === me || r.demo || !inCustodyScope(policy, r.login)) throw notFound();
  if (r.active) {
    if (await heldBeforeReturn(app, r.space_id, me)) throw new CustodyReadRefusal(CUSTODY_READ_TEXTS.activeAgain(r.display_name || r.login), 409, "custody_active");
    throw notFound();
  }
  if (r.custodian_id !== me || !r.due) throw notFound();
  return heldOf(r);
}

/**
 * P's live meetings with other participants — the roots of both bases, selected as by the handover
 * job (meetingFamilies, the worker's custody job): only transcriber roots (a meeting decision detached at handover
 * — parent_id = NULL, with the meeting's people on it — is an ordinary top row of personal P, not a "meeting with
 * participants"), with participants themselves (meetingSharedSql) or of one family by source_ref (a family goes whole if even
 * one root has a participant), or families partly handed over already by the same origin (the job brings the rest
 * to the same organizer; until then the keeper does not read it, participants read as participants). System pool, ids only.
 */
async function sharedRoots(app: App, held: Held): Promise<Record<DataClass, string[]>> {
  const P = held.person.id;
  const roots: Array<{ id: string; cls: DataClass; ref: string | null; origin: string; shared: boolean }> = [];
  for (const cls of CLASSES)
    for (const x of (await metaPool(app, cls).query(
      `SELECT r.id, r.source_ref, r.attrs->'organizer_transfer' AS ot, ${meetingSharedSql()} AS shared FROM records r
        WHERE r.owner_id = $1 AND r.parent_id IS NULL AND r.deleted_at IS NULL AND r.hidden_at IS NULL AND r.source_kind = 'transcriber'`, [P])).rows)
      roots.push({ id: x.id, cls, ref: x.source_ref ?? null, origin: meetingOriginOf(x.ot, P), shared: x.shared === true });
  const refs = new Set(roots.filter((x) => x.shared && x.ref).map((x) => x.ref!));
  const lone = roots.filter((x) => !x.shared && x.ref && !refs.has(x.ref));
  const handed = lone.length ? await handedParts(CLASSES.map((cls) => metaPool(app, cls)), lone.map((x) => x.ref!), P) : new Set<string>();
  const out: Record<DataClass, string[]> = { open: [], closed: [] };
  for (const x of roots) if (x.shared || (x.ref && (refs.has(x.ref) || handed.has(handedKey(x.ref, x.origin))))) out[x.cls].push(x.id);
  return out;
}

/**
 * What the keeper does not read: the sharedRoots roots and everything derived from them — descendants by parent_id in any
 * space, with deleted and hidden ones (the parent is always in the same class base — a foreign key). One set for the list,
 * counts, "k more closed" and id reads: such a meeting's derived record the author moved back to personal (the root in a project
 * or team) is a "top row" of personal P; without this its title would go to the list and search, yet it could not be opened.
 * A meeting the employee deleted whole (the root in the trash) is not included — it is among the deleted.
 */
async function sharedTrees(app: App, held: Held): Promise<string[]> {
  const roots = await sharedRoots(app, held);
  const ids: string[] = [];
  for (const cls of CLASSES)
    if (roots[cls].length)
      ids.push(...(await metaPool(app, cls).query(
        `WITH RECURSIVE t AS (SELECT id FROM records WHERE id = ANY($1::uuid[]) UNION SELECT r.id FROM records r JOIN t ON r.parent_id = t.id) SELECT id FROM t`,
        [roots[cls]])).rows.map((x) => x.id as string));
  return ids;
}

/** Counts by the top rows of personal P: live open and closed, deleted by the employee — no meetings with others or their derived. */
async function counts(app: App, held: Held): Promise<{ open: number; closed: number; deleted: number }> {
  const out = { open: 0, closed: 0, deleted: 0 };
  const shared = await sharedTrees(app, held);
  for (const cls of CLASSES) {
    // live and deleted — each by its own "top row" (TOP, TOP_DELETED): the same counts as the lists
    const r = (await metaPool(app, cls).query(
      `SELECT count(*) FILTER (WHERE r.deleted_at IS NULL AND ${UNDER_PARENT()})::int AS live,
              count(*) FILTER (WHERE r.deleted_at IS NOT NULL AND ${UNDER_DELETED_PARENT()})::int AS deleted
         FROM records r WHERE ${IN_P()} AND r.id <> ALL($2::uuid[])`, [held.space_id, shared])).rows[0];
    out[cls] += Number(r?.live ?? 0);
    out.deleted += Number(r?.deleted ?? 0);
  }
  return out;
}

/** GET /me/custody — whom the caller keeps (up to 200 people, recently left first). */
export async function custodyList(app: App, caller: Caller) {
  await human(app, caller);
  const policy = readMode(app);
  const rows = (await app.db.control.query(
    `SELECT s.id AS space_id, s.slug, s.archived_at, c.basis, c.levels, p.id AS person_id, p.login, p.display_name ${HELD_SQL}
      ORDER BY s.archived_at DESC, p.login LIMIT 200`, [app.instanceId, caller.person!.id, policy.afterDays, policy.testToo])).rows;
  const items = [];
  for (const r of rows) {
    const h = heldOf(r);
    items.push({ slug: h.slug, person: { login: h.person.login, display_name: h.person.display_name }, since: h.since, basis: h.basis, levels: h.levels,
                 records: await counts(app, h) });
  }
  return { items, read: policy.read };
}

/**
 * Can a copy be made: a note or decision whose text is within the memory_remember limit (a record without a token count — yes,
 * checked at copying). Empty (0 tokens) — no: nothing to copy.
 */
const copyable = (app: App, r: { type: string; token_count: number | null }): boolean =>
  (r.type === "note" || r.type === "event")
  && (r.token_count == null || (Number(r.token_count) > 0 && Number(r.token_count) <= app.settings.get("limits.remember_max_tokens", 8000)));

/** Closed ones in the answer: all and the closed class in the session. */
const closedShown = (policy: CustodyPolicy, caller: Caller): boolean => policy.read === "all" && caller.scope.classes.includes("closed");

const iso = (d: unknown): string | null => (d ? new Date(d as string).toISOString() : null);
const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** GET /me/custody/{slug}/records — the top rows page by page: live or deleted by the employee, search by title. */
export async function custodyRecords(app: App, caller: Caller, slug: string, o: { cursor?: string; q?: string; deleted?: boolean; limit: number }) {
  await human(app, caller);
  const policy = readMode(app);
  const held = await custodyOf(app, caller, slug, policy);
  const cur = decodeKeyset(o.cursor);
  const q = (o.q ?? "").trim().slice(0, 200);
  const showClosed = closedShown(policy, caller);
  const shared = await sharedTrees(app, held);
  // without meetings with other participants and everything derived from them (the organizer runs them) — both among the live and
  // among the deleted by the employee; a meeting they deleted whole is among the deleted
  const state = (args: unknown[]): string => {
    args.push(shared);
    return `r.deleted_at IS ${o.deleted ? "NOT " : ""}NULL AND r.id <> ALL($${args.length}::uuid[])`;
  };
  // top rows: live — TOP; deleted — TOP_DELETED (a derived record deleted apart from a live record is
  // a row of its own); search and "k more closed" — by the same selection
  const top = (): string => (o.deleted ? TOP_DELETED() : TOP());
  const titleLike = (args: unknown[]): string | null => {
    if (!q) return null;
    args.push(`%${likeEscape(q)}%`);
    return `r.title ILIKE $${args.length} ESCAPE '\\'`;
  };
  type Row = { id: string; title: string | null; type: string; event_kind: string | null; class: DataClass; occurred_at: Date; ingested_at: Date;
               deleted_at: Date | null; token_count: number | null; at_key: string };
  const rows: Row[] = [];
  for (const cls of showClosed ? CLASSES : (["open"] as const)) {
    const args: unknown[] = [held.space_id];
    const where = [top(), state(args)];
    const like = titleLike(args);
    if (like) where.push(like);
    if (cur) { args.push(cur.at, cur.id); where.push(`(r.occurred_at, r.id) < ($${args.length - 1}::timestamptz, $${args.length}::uuid)`); }
    args.push(o.limit + 1);
    rows.push(...(await app.db.records(cls, caller.scope).query(
      `SELECT r.id, r.title, r.type, r.event_kind, r.class, r.occurred_at, r.ingested_at, r.deleted_at, r.token_count, ${keysetAtSql("r.occurred_at")} AS at_key
         FROM records r WHERE ${where.join(" AND ")} ORDER BY r.occurred_at DESC, r.id DESC LIMIT $${args.length}`, args)).rows as Row[]);
  }
  rows.sort((x, y) => -keysetCompare({ at_key: x.at_key, id: x.id }, { at_key: y.at_key, id: y.id }));
  const page = rows.slice(0, o.limit);
  const last = page[page.length - 1];
  // closed ones in the answer — a list event before the answer: if the log did not take it — no closed titles (503)
  const closedIds = page.filter((r) => r.class === "closed").map((r) => r.id);
  if (closedIds.length)
    await auditRead(app, caller, { event_type: "list", class: "closed", record_ids: closedIds, result_count: closedIds.length, space_id: held.space_id,
                                   details: { op: "custody", person: held.person.id, ...(caller.keyKind === "session" ? { auto: true } : {}) } });
  // "k more closed" — live or deleted, as in the answer, but without search: a count by the titles of inaccessible
  // closed ones would answer "are there such words in the title", and trying words would read a title without the log, against
  // the setting "only the count of closed ones"
  let closedHidden = 0;
  if (!showClosed) {
    const args: unknown[] = [held.space_id];
    const where = [top(), state(args)];
    closedHidden = Number((await metaPool(app, "closed").query(`SELECT count(*)::int AS n FROM records r WHERE ${where.join(" AND ")}`, args)).rows[0]?.n ?? 0);
  }
  return {
    person: { login: held.person.login, display_name: held.person.display_name }, since: held.since, basis: held.basis, read: policy.read,
    items: page.map((r) => ({ id: r.id, title: r.title ?? null, type: r.type, event_kind: r.event_kind ?? null, class: r.class, occurred_at: iso(r.occurred_at)!,
                              ingested_at: iso(r.ingested_at)!, deleted_at: iso(r.deleted_at), copyable: copyable(app, r) })),
    closed_hidden: closedHidden,
    next_cursor: rows.length > o.limit && last ? encodeKeyset(last.at_key, last.id) : null,
  };
}

interface CustodyRow {
  id: string; title: string | null; type: string; event_kind: string | null; class: DataClass; occurred_at: Date; deleted_at: Date | null; token_count: number | null;
  /** Domain tags — only for the copy (the "never open" rules); they do not go into answers (head is an explicit field list). */
  domain_tags: string[] | null;
  parent_id: string | null;
}

/**
 * A record of personal P: a row of that space (top or derived — a meeting summary opens from "What came of it"), current, not
 * hidden. Closed — only with all and the closed class in the session; else not_found, as for others' records. A live meeting with
 * other participants and all derived from it — not_found by the same set as the list (sharedTrees):
 * what does not open by id is not in the list either.
 */
async function custodyRecord(app: App, caller: Caller, held: Held, id: string, policy: CustodyPolicy): Promise<{ rec: CustodyRow; pool: ReturnType<App["db"]["records"]> }> {
  if (!isUuidParam(id)) throw notFound();
  const loc = (await app.db.control.query("SELECT class, space_id FROM record_locations WHERE record_id = $1", [id])).rows[0] as { class: DataClass; space_id: string } | undefined;
  if (!loc || loc.space_id !== held.space_id) throw notFound();
  if (loc.class === "closed" && !closedShown(policy, caller)) throw notFound();
  const pool = app.db.records(loc.class, caller.scope);
  const rec = (await pool.query(
    `SELECT id, title, type, event_kind, class, occurred_at, deleted_at, token_count, domain_tags, parent_id FROM records WHERE id = $1 AND space_id = $2 AND is_current AND hidden_at IS NULL`,
    [id, held.space_id])).rows[0] as CustodyRow | undefined;
  if (!rec) throw notFound();
  if ((await sharedTrees(app, held)).includes(rec.id)) throw notFound();
  return { rec, pool };
}

/**
 * The transcript a summary or decision came from: their timestamps lead to its place at the keeper
 * (`/custody/<personal>/<transcript>#t-<sec>`), and a closed one opens in the same window with confirmation and the log. Only if
 * the keeper will open it — as in custodyRecord: a transcript in the same personal space, current, not hidden; a closed one —
 * with "read all" and the closed class in the session. Not a meeting with other participants: the keeper never opens its derived
 * ones (sharedTrees). Otherwise null — the workplace shows the time as text. The pools are system ones, metadata only.
 */
async function transcriptOf(app: App, caller: Caller, held: Held, rec: CustodyRow, policy: CustodyPolicy): Promise<string | null> {
  if (!rec.parent_id || (rec.type !== "summary" && rec.type !== "event")) return null;
  const loc = (await app.db.control.query("SELECT class, space_id FROM record_locations WHERE record_id = $1", [rec.parent_id])).rows[0] as { class: DataClass; space_id: string } | undefined;
  if (!loc || loc.space_id !== held.space_id || (loc.class === "closed" && !closedShown(policy, caller))) return null;
  const ok = (await metaPool(app, loc.class).query(
    "SELECT 1 FROM records WHERE id = $1 AND space_id = $2 AND type = 'transcript' AND is_current AND hidden_at IS NULL", [rec.parent_id, held.space_id])).rowCount;
  return ok ? rec.parent_id : null;
}

/** Derived records in personal P (meeting summaries and decisions): for a deleted one — also the deleted together with it. */
async function derivedOf(pool: ReturnType<App["db"]["records"]>, held: Held, rec: CustodyRow) {
  const { rows } = await pool.query(
    `SELECT id, title, type FROM records WHERE parent_id = $1 AND space_id = $2 AND is_current AND hidden_at IS NULL AND ($3::boolean OR deleted_at IS NULL)
      ORDER BY occurred_at, id LIMIT 50`, [rec.id, held.space_id, rec.deleted_at !== null]);
  return rows.map((d) => ({ id: d.id as string, title: (d.title ?? null) as string | null, type: d.type as string }));
}

async function textOf(pool: ReturnType<App["db"]["records"]>, id: string): Promise<{ text: string; original: boolean }> {
  const c = (await pool.query("SELECT text, original_key FROM record_content WHERE record_id = $1", [id])).rows[0];
  return { text: (c?.text ?? "") as string, original: !!c?.original_key };
}
/**
 * The keeper's text limit when there is no file link — the intake limit of meeting text without a file: 2 000 000
 * characters (meetings.ts, the contract), 500 000 tokens by estimateTokens (chars / 4). No meeting without a file is longer.
 */
export const CUSTODY_NO_FILE_MAX_TOKENS = 500_000;
/**
 * How many text tokens to give the keeper: the first part (limits.read_max_tokens, as with memory_read) — only
 * when they got a file link and the whole record can be downloaded; without it — up to CUSTODY_NO_FILE_MAX_TOKENS.
 */
export const custodyShownTokens = (readMax: number, downloadable: boolean): number =>
  downloadable ? readMax : Math.max(readMax, CUSTODY_NO_FILE_MAX_TOKENS);
/**
 * What goes to the keeper's page: the same readPart as the first part of memory_read, with the limit
 * custodyShownTokens; truncated — the text is longer. downloadable — the keeper got a file link (original_url not null).
 * "Can it be copied" is counted over the whole text (copyable); the copy (custodyCopy) takes it whole within memory_remember.
 */
const shownPart = (app: App, text: string, type: string, downloadable: boolean): { text: string; truncated: boolean } => {
  const part = readPart(text, type, undefined, custodyShownTokens(app.settings.get("limits.read_max_tokens", 64000), downloadable), textsOf(app));
  return { text: part.content, truncated: part.truncated };
};
/** Whether there is a file — without the text (a closed one before confirmation). */
async function hasOriginal(pool: ReturnType<App["db"]["records"]>, id: string): Promise<boolean> {
  return (await pool.query("SELECT original_key IS NOT NULL AS original FROM record_content WHERE record_id = $1", [id])).rows[0]?.original === true;
}

/**
 * The keeper's read event: space_id — personal P, a closed one strictly (log refused — no text, 503). also — ids of records
 * whose titles go out in the same answer (the derived ones of a closed one: closed titles are not given without an event).
 */
const readEvent = (app: App, caller: Caller, held: Held, rec: CustodyRow, extra: Record<string, unknown> = {}, also: readonly string[] = []) =>
  auditRead(app, caller, { event_type: "read", class: rec.class, record_ids: [rec.id, ...also.filter((x) => x !== rec.id)], space_id: held.space_id,
                           details: { op: "custody_read", person: held.person.id, closed: rec.class === "closed", ...extra } });

/**
 * The link to the original. One deleted by the employee — by the same rules: a link with the `dl` mark, by which
 * the file of a deleted record goes to a person only; a download is a link event with `deleted: true`. No restoring the record.
 */
const originalUrl = async (app: App, caller: Caller, rec: CustodyRow): Promise<string | null> =>
  signedOriginalUrl(app, caller, rec.id, rec.class, { deleted: rec.deleted_at !== null });

const head = (rec: CustodyRow) => ({ id: rec.id, type: rec.type, event_kind: rec.event_kind ?? null, class: rec.class, occurred_at: iso(rec.occurred_at)!, deleted_at: iso(rec.deleted_at) });

/**
 * GET …/records/{id}: open — text (shownPart: with a file link, the start) and the read event; closed — without title,
 * text and events, confirm_required.
 */
export async function custodyRead(app: App, caller: Caller, slug: string, id: string) {
  await human(app, caller);
  const policy = readMode(app);
  const held = await custodyOf(app, caller, slug, policy);
  const { rec, pool } = await custodyRecord(app, caller, held, id, policy);
  const person = { login: held.person.login, display_name: held.person.display_name };
  if (rec.class === "closed")
    return { ...head(rec), title: null, text: null, truncated: false, confirm_required: true, original: await hasOriginal(pool, rec.id), original_url: null, derived: [],
             copyable: copyable(app, rec), person, transcript_id: null };
  const [{ text, original }, derived] = await Promise.all([textOf(pool, rec.id), derivedOf(pool, held, rec)]);
  await readEvent(app, caller, held, rec);
  // the first part only with a file link given: no link (no signing key, the file failed
  // the check) — the text as without a file
  const url = original ? await originalUrl(app, caller, rec) : null;
  return { ...head(rec), title: rec.title ?? null, ...shownPart(app, text, rec.type, url !== null), confirm_required: false, original,
           original_url: url, derived,
           copyable: copyable(app, rec) && text.trim() !== "", person, transcript_id: await transcriptOf(app, caller, held, rec, policy) };
}

/**
 * POST …/records/{id}/read — confirmation: the read {closed} event before the text, then title, text (shownPart: with a file
 * link — the start), the file link, the derived ones.
 * Derived ones come from the same class base (closed for a closed record): their ids in the same event, or titles leave unlogged.
 */
export async function custodyConfirmRead(app: App, caller: Caller, slug: string, id: string) {
  await human(app, caller);
  const policy = readMode(app);
  const held = await custodyOf(app, caller, slug, policy);
  const { rec, pool } = await custodyRecord(app, caller, held, id, policy);
  const derived = await derivedOf(pool, held, rec);
  await readEvent(app, caller, held, rec, { confirmed: true }, derived.map((d) => d.id));
  const { text, original } = await textOf(pool, rec.id);
  const url = original ? await originalUrl(app, caller, rec) : null;
  return { id: rec.id, title: rec.title ?? null, ...shownPart(app, text, rec.type, url !== null), original_url: url, derived,
           transcript_id: await transcriptOf(app, caller, held, rec, policy) };
}

/** POST …/records/{id}/copy {confirm?: true} — a closed copy in the caller's personal space; a repeat — the earlier copy. */
export async function custodyCopy(app: App, caller: Caller, slug: string, id: string, body: unknown) {
  await human(app, caller);
  const b = body ?? {};
  if (typeof b !== "object" || Array.isArray(b) || Object.keys(b as object).some((k) => k !== "confirm")
      || ((b as { confirm?: unknown }).confirm !== undefined && typeof (b as { confirm?: unknown }).confirm !== "boolean"))
    throw invalid("Use {\"confirm\": true} as the request body for a closed record, or leave the body empty");
  const confirm = (b as { confirm?: boolean }).confirm === true;
  const policy = readMode(app);
  const held = await custodyOf(app, caller, slug, policy);
  const { rec, pool } = await custodyRecord(app, caller, held, id, policy);
  if (rec.type !== "note" && rec.type !== "event") throw new CustodyReadRefusal(CUSTODY_READ_TEXTS.notCopyable, 400, "custody_not_copyable");
  if (rec.class === "closed" && !confirm) throw new CustodyReadRefusal(CUSTODY_READ_TEXTS.confirm, 400, "custody_confirm");
  const { text } = await textOf(pool, rec.id);
  if (!text.trim()) throw new CustodyReadRefusal(CUSTODY_READ_TEXTS.empty, 400, "custody_empty");
  if (estimateTokens(text) > app.settings.get("limits.remember_max_tokens", 8000)) throw new CustodyReadRefusal(CUSTODY_READ_TEXTS.tooBig, 400, "custody_too_big");
  // the text goes into the caller's record, which is a read: the event before the copy (closed — strictly). via: copy — the panel
  // does not count it as "opening" (custodyClosedOpened): the workplace copies a closed one only after "Open"; 1 read = 1 opening
  await readEvent(app, caller, held, rec, { via: "copy" });
  // the bans on showing travel with the copy: the source's entity links — for the "never open" rules by entity
  // kind (P's project tag — no: the copy is in no project); meeting material or not — by the record itself, its versions,
  // ancestors by parent_id and derived_from links in both bases
  const entities = await sourceEntities(app, pool, rec.id);
  const meeting = await meetingOriginOfSources({ control: app.db.control, records: (k) => metaPool(app, k) }, [rec.id]);
  const me = caller.person!.id;
  const mine = await resolveSpace(app, caller, "me", await readableSpaces(app, caller, { archived: true }));
  if (!mine) throw notFound();
  if (mine.archived_at) throw archivedDenied(mine.slug, mine.archived_at);
  const title = rec.title ?? null;
  const kind = rec.type === "note" ? "note" : rec.event_kind ?? "event";
  const hash = sourceHash(Buffer.from(text, "utf8"), { title: title ?? "", kind, type: rec.type, copied_from: rec.id });
  // a repeat (double click, retry after a network error) returns the same copy: the record key as in memory_remember
  return withKeyLock(sameRecordKey(me, mine.id, rec.type, hash), async () => {
    const known = (await app.db.control.query(
      "SELECT record_id, class FROM record_locations WHERE owner_id = $1 AND source_hash = $2 AND space_id = $3 AND type = $4 AND NOT deleted ORDER BY created_at LIMIT 1",
      [me, hash, mine.id, rec.type])).rows[0];
    if (known) {
      // one's own copy (if shown to agents, it is in the open base): only the date for the path, as on a memory_remember repeat
      const prev = (await app.db.recordsForWrite(known.class as DataClass, caller.scope).query("SELECT occurred_at FROM records WHERE id = $1 AND deleted_at IS NULL", [known.record_id])).rows[0];
      if (prev) return { id: known.record_id as string, path: recordPath(mine.slug, rec.type, prev.occurred_at, known.record_id), title, already_known: true };
    }
    const created = await createRecord(app, caller, {
      type: rec.type as "note" | "event", eventKind: rec.type === "note" ? null : rec.event_kind ?? null, space: mine, classOverride: "closed", title, text,
      method: "stated_by_human", origin: "human", confirmed: true, sourceKind: "agent", sourceHash: hash, occurredAt: new Date(rec.occurred_at),
      // tags — as the source's, without a check against the dictionary: the rule compares the exact value
      domains: rec.domain_tags ?? [], entities, ownerId: me, meetingOrigin: meeting,
      attrs: { copied_from: { person: held.person.id, record_id: rec.id, at: new Date().toISOString() } },
      auditDetails: { op: "custody_copy", from_person: held.person.id, source_id: rec.id },
    });
    log.info("custody_copy", { record_id: created.id });
    return { id: created.id, path: created.path, title, already_known: false };
  });
}

/**
 * The source's entity links for the copy: all except the project tag (`role = 'space'` — P's project; the copy
 * lies in the caller's personal space). In the copy — as a "mentioned" link (createRecord), the entity kind as the source's.
 */
async function sourceEntities(app: App, pool: ReturnType<App["db"]["records"]>, id: string): Promise<ResolvedEntities> {
  const ids = (await pool.query("SELECT DISTINCT entity_id FROM record_entities WHERE record_id = $1 AND role <> 'space'", [id])).rows.map((r) => r.entity_id as string);
  if (!ids.length) return { known: [], unresolved: [] };
  const rows = (await app.db.control.query("SELECT id, kind, external_system, external_id FROM entities WHERE id = ANY($1::uuid[]) AND instance_id = $2 ORDER BY id",
                                           [ids, app.instanceId])).rows as Array<{ id: string; kind: EntityKind; external_system: string | null; external_id: string | null }>;
  return { known: rows.map((e) => ({ id: e.id, kind: e.kind, key: `${e.kind}:${e.external_system ?? ""}:${e.external_id ?? ""}`, externalSystem: e.external_system ?? "", externalId: e.external_id ?? "" })),
           unresolved: [] };
}

/** The "Handed to me" routes — next to "Meetings with me" (rest.ts). The read bucket is custody, copies — memory_remember. */
export function registerCustody(r: Hono<any>, app: App): void {
  const caller = (c: any) => c.get("caller") as Caller;
  const check = (c: any, bucket: string) => app.limiter.check(caller(c), bucket);
  r.get("/api/v1/me/custody", async (c) => { check(c, "custody"); return c.json(await custodyList(app, caller(c))); });
  r.get("/api/v1/me/custody/:slug/records", async (c) => {
    check(c, "custody");
    const deleted = c.req.query("deleted");
    if (deleted !== undefined && deleted !== "0" && deleted !== "1") throw invalid("deleted: 0 for live records, 1 for records deleted by the employee");
    return c.json(await custodyRecords(app, caller(c), c.req.param("slug") ?? "", {
      cursor: c.req.query("cursor"), q: c.req.query("q"), deleted: deleted === "1", limit: intParam(c.req.query("limit"), 50, 1, 100) }));
  });
  r.get("/api/v1/me/custody/:slug/records/:id", async (c) => { check(c, "custody"); return c.json(await custodyRead(app, caller(c), c.req.param("slug") ?? "", c.req.param("id") ?? "")); });
  r.post("/api/v1/me/custody/:slug/records/:id/read", async (c) => {
    check(c, "custody");
    return c.json(await custodyConfirmRead(app, caller(c), c.req.param("slug") ?? "", c.req.param("id") ?? ""));
  });
  r.post("/api/v1/me/custody/:slug/records/:id/copy", async (c) => {
    check(c, "memory_remember");
    const text = await c.req.text();
    let body: unknown = {};
    if (text.trim()) { try { body = JSON.parse(text); } catch { throw invalid("The request body is not JSON"); } }
    return c.json(await custodyCopy(app, caller(c), c.req.param("slug") ?? "", c.req.param("id") ?? "", body));
  });
}
