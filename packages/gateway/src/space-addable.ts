// "Can be added": on the "Overview" of a project or
// team a person sees their meetings for 90 days where more than half the participants are members of this space, marks
// the needed ones and moves them with a plan ("show → apply", memory_plan op promote → the plan page → memory_apply).
// Here — only the candidate picking; the move, its rights and fingerprints — plans.ts and owner.ts, as for any plan.
//  - Only own meetings: the meeting root (a parentless transcript, current version), owned by the caller, home — their personal
//    space (ones already moved to a space drop out by themselves: their home is the space), within 90 days by the meeting
//    time, with no placement in this space.
//  - Participants: the meeting people (root record_people in its class database) and the organizer; "in the space" — its readers
//    (current members, spaceReaders, `space_members_effective`). The threshold is addableShare: at least two people
//    (a dictation "with oneself" is not offered) and strictly more than half are members of the space.
//  - A meeting whose reader circle was set by the meetings service (PUT /ingest/access) is not offered (default
//    "do not show"). Marks: `attrs.access.narrowed_by_source` — set on the whole tree, wherever it lies
//    (in the organizer's personal space, in a space, only placed in another), a new meeting version inherits it;
//    `attrs.access.restricted_by_source` — the old one, outside personal only. Without this filter an author's move would open
//    a meeting narrowed in personal to all space members: owner.ts audienceAfterMove does not widen only restricted_by_source.
//    Narrowing in personal before this change left no mark — such meetings cannot be told from ordinary ones.
//  - Visibility — by the single builder (listingSpec/visibleSql) per scope class: a personal key without the closed one
//    sees no closed meetings, a class closed by the gate — its database is not queried. people/in_space count own meetings.
//  - An auto list, not a search: its own REST route, no search events. Names of closed meetings in the answer —
//    `list {op: space_addable}` (a workplace session — `auto`; an extended key — extended_key_use) before the answer; the log
//    did not accept it — no answer (auditShownClosed).
// The `onboarding.addable_enabled` switch (off by default) — 403 `addable_disabled` before parsing and the database. No model,
// the schema does not change.
import type pg from "pg";
import { binder, MemoryError, notFound, recordPath, visibleSql, type Bind, type DataClass } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { canWrite, readableSpaces, resolveSpace, spaceReaders, type SpaceAccess } from "./access.ts";
import { auditShownClosed } from "./audit.ts";
import { listingSpec } from "./visibility.ts";
import { decodeKeyset, keysetAtSql } from "./paging.ts";
import { mergeByTime } from "./space-overview.ts";

// ---------------------------------------------------------------- switch, limits, texts
export const SPACE_ADDABLE_ENABLED_SETTING = "onboarding.addable_enabled";
export const SPACE_ADDABLE_DISABLED_TEXT = "“Can be added” is turned off by the administrator";
/** Meetings — for this many days by the meeting time. */
export const ADDABLE_DAYS = 90;
/** Meetings per list page. */
export const ADDABLE_PAGE = 20;
/** Fewer than two people (the organizer alone) — the meeting is not offered. */
export const ADDABLE_MIN_PEOPLE = 2;
const UNTITLED = "Untitled";
const DAY_MS = 86_400_000;

export const addableEnabled = (app: Pick<App, "settings">): boolean => app.settings.get<boolean>(SPACE_ADDABLE_ENABLED_SETTING, false) === true;

export function requireAddableEnabled(app: Pick<App, "settings">): void {
  if (!addableEnabled(app)) throw new MemoryError("forbidden", SPACE_ADDABLE_DISABLED_TEXT, { details: { reason: "addable_disabled" } });
}

// ---------------------------------------------------------------- answer (contract: SpaceAddable)
/** A candidate meeting: record link and date are required; people — participants with the organizer, in_space — those in the space. */
export interface AddableItem { id: string; path: string; title: string; occurred_at: string; class: DataClass; people: number; in_space: number }
export interface SpaceAddable { items: AddableItem[]; next_cursor: string | null; days: number }

// ---------------------------------------------------------------- pure functions (unit tests)
/**
 * The threshold: at least ADDABLE_MIN_PEOPLE people and strictly more than half are space members (2 of 4 — no,
 * 3 of 5 — yes, 2 of 3 — yes). The same threshold in SQL — addableShareSql; a Postgres test checks they match on a grid.
 */
export const addableShare = (people: number, inSpace: number): boolean =>
  Number.isInteger(people) && Number.isInteger(inSpace) && people >= ADDABLE_MIN_PEOPLE && inSpace >= 0 && inSpace <= people && inSpace * 2 > people;

/** The addableShare threshold as an SQL condition over the expressions of the people count and of those of them in the space. */
export const addableShareSql = (people: string, inSpace: string): string => `(${people} >= ${ADDABLE_MIN_PEOPLE} AND ${inSpace} * 2 > ${people})`;

/** The window start: ADDABLE_DAYS days before "now" (by the meeting time). */
export const addableSince = (now: Date): string => new Date(now.getTime() - ADDABLE_DAYS * DAY_MS).toISOString();

/**
 * SQL condition "the meetings service did not set the meeting's reader circle" over row `r`: neither `narrowed_by_source` (set by
 * PUT /ingest/access on the whole tree, wherever it lies) nor the old `restricted_by_source` (only outside personal).
 */
export const NOT_NARROWED_BY_SOURCE_SQL = "COALESCE(r.attrs #>> '{access,narrowed_by_source}', '') <> 'true' AND COALESCE(r.attrs #>> '{access,restricted_by_source}', '') <> 'true'";

/** A database row: meeting fields, people counts, the database class and the order mark (keysetAtSql). */
export interface AddableDbRow {
  id: string; title: string | null; summary_line: string | null; occurred_at: Date | string | null; class: DataClass; at_key: string;
  people: number; in_space: number;
}

const isoOf = (v: unknown): string | null => {
  if (v === null || v === undefined || v === "") return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/**
 * An answer row from a database row. No id or date — null (no row lacks a source, as in the overview); under the threshold — null
 * (defense in depth: the threshold is already in SQL). The name — the meeting title, else its summary, else "Untitled".
 */
export function addableItem(r: AddableDbRow, personalSlug: string): AddableItem | null {
  const at = isoOf(r.occurred_at), people = Number(r.people), inSpace = Number(r.in_space);
  if (!r.id || !at || !addableShare(people, inSpace)) return null;
  const title = (r.title ?? "").trim() || (r.summary_line ?? "").trim() || UNTITLED;
  return { id: r.id, path: recordPath(personalSlug, "transcript", at, r.id), title, occurred_at: at, class: r.class, people, in_space: inSpace };
}

// ---------------------------------------------------------------- selection
/**
 * The "Can be added" space: a project or team the caller writes to (a member or owner, not an archive); otherwise — like
 * someone else's and a missing one, 404. Personal — the caller's personal one from the same map (none — an empty list).
 */
async function placesOf(app: App, caller: Caller, ref: string): Promise<{ target: SpaceAccess; personal: SpaceAccess | null }> {
  const spaces = await readableSpaces(app, caller);
  const target = caller.person ? await resolveSpace(app, caller, ref, spaces) : null;
  if (!target || !["team", "project"].includes(target.kind) || !canWrite(target)) throw notFound();
  const personal = [...spaces.values()].find((s) => s.kind === "personal" && s.owner_id === caller.person!.id) ?? null;
  return { target, personal };
}

/**
 * One class's candidates after the cursor: own meeting roots in personal for the window, no source restriction, no placement in
 * the space, with the threshold on the meeting's people. Visibility — the builder over `r` (the same as for the space folder).
 */
async function candidates(db: pg.Pool, vis: (bind: Bind) => string | null, a: {
  me: string; personal: string; target: string; readers: string[]; since: string; cursor: { at: string; id: string } | null;
}): Promise<AddableDbRow[]> {
  const args: unknown[] = [], bind = binder(args);
  const v = vis(bind);
  if (v === null) return [];
  const where = [
    v,
    `r.space_id = ${bind(a.personal)}`,
    `r.owner_id = ${bind(a.me)}`,
    "r.type = 'transcript' AND r.parent_id IS NULL",
    `r.occurred_at >= ${bind(a.since)}::timestamptz`,
    NOT_NARROWED_BY_SOURCE_SQL,
    `NOT EXISTS (SELECT 1 FROM record_placements pl WHERE pl.record_id = r.id AND pl.space_id = ${bind(a.target)}::uuid)`,
    addableShareSql("x.people", "x.in_space"),
  ];
  if (a.cursor) where.push(`(r.occurred_at, r.id) < (${bind(a.cursor.at)}::timestamptz, ${bind(a.cursor.id)}::uuid)`);
  // the meeting's people and the organizer (UNION — no repeats); "in the space" — of those reading the space
  const readers = bind(a.readers);
  return (await db.query(
    `SELECT r.id, r.title, r.summary_line, r.occurred_at, r.class, ${keysetAtSql("r.occurred_at")} AS at_key, x.people, x.in_space
       FROM records_live r
       CROSS JOIN LATERAL (
         SELECT count(*)::int AS people, (count(*) FILTER (WHERE p.person_id = ANY(${readers}::uuid[])))::int AS in_space
           FROM (SELECT rp.person_id FROM record_people rp WHERE rp.record_id = r.id UNION SELECT r.owner_id) p(person_id)) x
      WHERE ${where.join(" AND ")}
      ORDER BY r.occurred_at DESC, r.id DESC LIMIT ${ADDABLE_PAGE + 1}`, args)).rows as AddableDbRow[];
}

// ---------------------------------------------------------------- route
/**
 * GET /api/v1/me/spaces/{slug}/addable?cursor=: own candidate meetings, newest first, by ADDABLE_PAGE. Order: switch →
 * cursor → space (does not write, or not a project or team — 404) → selection by class → an event about the shown closed ones
 * (before the answer).
 */
export async function spaceAddable(app: App, caller: Caller, ref: string, q: { cursor?: string | null } = {}, now: Date = new Date()): Promise<SpaceAddable> {
  requireAddableEnabled(app);
  const cursor = decodeKeyset(q.cursor);
  const { target, personal } = await placesOf(app, caller, ref);
  if (!personal) return { items: [], next_cursor: null, days: ADDABLE_DAYS };
  const who = await spaceReaders(app, target);
  const readers = who.kind === "list" ? who.ids : [];
  const spec = listingSpec(app, caller, [personal.id]);
  const rows: AddableDbRow[] = [];
  for (const cls of caller.scope.classes) {
    rows.push(...(await candidates(app.db.records(cls, caller.scope), (bind) => visibleSql(spec, cls, bind), {
      me: caller.person!.id, personal: personal.id, target: target.id, readers, since: addableSince(now), cursor })));
  }
  const { page, next } = mergeByTime(rows, ADDABLE_PAGE);
  const items = page.flatMap((r) => { const it = addableItem(r, personal.slug); return it ? [it] : []; });
  await auditShownClosed(app, caller, items.filter((i) => i.class === "closed").map((i) => i.id), "space_addable");
  return { items, next_cursor: next, days: ADDABLE_DAYS };
}
