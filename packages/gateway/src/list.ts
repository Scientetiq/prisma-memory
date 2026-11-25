// memory_list: the path is computed, not stored; virtual folders /entities/<key> and /people/<login> are
// queries over links with a rights check on every record. Invariant: what the list shows can be read.
import { binder, invalid, notFound, openCheckShort, parseEntityKey, parsePath, recordPath, RECORD_TYPES, showAnywayPath, visibleSql,
         type ArchiveFilter, type Bind, type OpenCheckView } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { archivedSpaceIds, readableSpaces, resolveSpace, type RecordRow, type SpaceAccess } from "./access.ts";
import { hiddenClosedSql, listingSpec } from "./visibility.ts";
import { isExternal } from "./channel.ts";
import { entityReadableById, entityUuid as resolveEntityUuid, markViewFor } from "./records.ts";
import { auditRead } from "./audit.ts";
import { workplaceUrl } from "./workplace.ts";
import { readmeEnabled, spaceAbout } from "./space-readme.ts";
import { guideListLine } from "./space-guide.ts";
import { decodeKeyset, encodeKeyset, keysetAtSql, keysetCompare } from "./paging.ts";
import { confirmedOf, heldIds, heldUnitIds, orgSpace, orgUnitsOf, reviewView, seesHeld } from "./org-hold.ts";
import { meetingsHint, meetingsReadme, orgReviewEnabled, PERSON_MEETINGS, selectionReadme, type OrgReviewView } from "@memory/shared";
import { listText, MONTH_UTC_SQL, monthsLine, originOf, typeCountsLine, type ListEntryView, type ListView, type McpTexts } from "@memory/mcp-core";
import { textsOf } from "./mcp-texts.ts";

export interface Entry {
  path: string; kind: "folder" | "record"; type?: string | null; title: string; summary_line?: string | null; occurred_at?: string | null;
  token_count?: number | null; count?: number | null; origin?: string | null; confirmed?: boolean | null;
  /**
   * `class` — on every record: on a visible one, the class of the base it was read from ("My records" by type once
   * drew closed as open), on a hidden one always closed. The rest only on hidden records of the closed class:
   * no title, no text, no summary.
   */
  id?: string; class?: string; hidden?: boolean; created_at?: string; space?: string; owner?: string;
  /** Link to the record in the workplace (access.workplace_url): only a person can show it to agents. */
  workplace_url?: string;
  /** One's own record closed by the open check (personal open): the reason without the match — for the author only. */
  open_check?: OpenCheckView;
  /** Folder of an archived space: read-only, outside the default search. */
  archived?: true;
}

// Record visibility is one builder (visibility.ts): V(r) with the author rule from access.author_rule, the class
// gate (an extended key in closed — only one's own; a class outside the scope is not queried). The people list acts
// also on a record moved into a space.

/** A closed-class record hidden from the key, found by the locator: no title, no text — only the id, type and author. */
interface HiddenRow { id: string; type: string; space_id: string; occurred_at: Date; at_key: string; owner: string; hidden: true; open_check?: OpenCheckView | null }
/** `at_key` — the cursor mark as text with microseconds (keysetAtSql): through Date the cursor lost neighbours within a millisecond. */
type PageRow = (RecordRow & { at_key: string; org_confirmed?: boolean; org_view?: string | null }) | HiddenRow;
const isHidden = (r: PageRow): r is HiddenRow => (r as HiddenRow).hidden === true;

export const recordEntry = (r: PageRow, slug: string, wp: string | null): Entry => isHidden(r)
  // The path is cut short on purpose: the record cannot be read by it (its class is closed to the key); the owner's actions go
  // by id: memory_delete for the agent, opening the class for a person in the workplace by the workplace_url link.
  // There is no year and month in the path — they come from occurred_at, and that lies in the closed base we do not touch.
  ? { path: `/spaces/${slug}/${r.type}/${r.id}`, kind: "record", type: r.type, title: "", summary_line: null,
      occurred_at: null, token_count: null, count: null, origin: null, confirmed: null,
      id: r.id, class: "closed", hidden: true, created_at: new Date(r.occurred_at).toISOString(), space: slug, owner: r.owner,
      // closed by the open check: the reason instead of the "open" link — the button would refuse on the same finding.
      // Outside one's own personal (kind `foreign`) — a mark without reasons and a link to the panel "Make available to agents"
      ...(r.open_check ? { open_check: r.open_check, ...(!r.open_check.kinds && wp ? { workplace_url: `${wp}${showAnywayPath(r.id)}` } : {}) }
        : wp ? { workplace_url: `${wp}/records/${r.id}` } : {}) }
  : { path: recordPath(slug, r.type, r.occurred_at, r.id), kind: "record", type: r.type, title: r.title ?? "", summary_line: r.summary_line,
      occurred_at: new Date(r.occurred_at).toISOString(), token_count: r.token_count, count: null,
      origin: originOf(r.method), confirmed: r.org_confirmed ?? r.confirmed_at !== null,
      // the class comes from the row of the base of its own class (SELECT r.*): the same as for a memory_search finding
      class: r.class,
      // "Company common knowledge" awaiting the check (contract 0.9.0)
      ...(r.org_view ? { org_review: r.org_view as OrgReviewView } : {}) };

/**
 * Closed-class records the key cannot see (a T2 personal key), by `record_locations` in the control base: the closed base
 * is not opened for this. One's own — in any space; in spaces where the caller is `owner` —
 * ALL closed records with the author's login: a head must see what was put into their department; this is metadata without
 * content — exactly what an administrator sees in a person's card. A participant (member/reader)
 * still sees only their own. Sorted by the time the record appeared in the locator, so they join the common cursor
 * on a par with visible records.
 */
async function ownHiddenRows(app: App, caller: Caller, spaceIds: string[], ownedSpaceIds: string[], type: string | undefined, limit: number, cur: { at: string; id: string } | null): Promise<HiddenRow[]> {
  // the external agents' address says nothing about closed records: no hidden rows
  if (caller.scope.classes.includes("closed") || !caller.person || !spaceIds.length || isExternal(caller)) return [];
  // held "Wrong" ones in org — and without titles, only to the author: a curator cannot list them with a key
  const held = await heldUnitIds(app, caller, "closed");
  const args: unknown[] = [spaceIds, caller.person.id, type ?? null, ownedSpaceIds, held];
  let sql = `SELECT l.record_id AS id, l.type, l.space_id, l.owner_id, l.created_at AS occurred_at, ${keysetAtSql("l.created_at")} AS at_key, l.open_check FROM record_locations l
             WHERE l.space_id = ANY($1::uuid[]) AND l.class = 'closed' AND NOT l.deleted AND ($3::text IS NULL OR l.type = $3)
               AND (l.owner_id = $2 OR (l.space_id = ANY($4::uuid[]) AND l.record_id <> ALL($5::uuid[])))`;
  if (cur) { args.push(cur.at, cur.id); sql += ` AND (l.created_at, l.record_id) < ($${args.length - 1}::timestamptz, $${args.length}::uuid)`; }
  const { rows } = await app.db.control.query(`${sql} ORDER BY l.created_at DESC, l.record_id DESC LIMIT ${limit + 1}`, args);
  const others = [...new Set(rows.map((r) => r.owner_id as string).filter((x) => x !== caller.person!.id))];
  const login = new Map<string, string>([[caller.person.id, caller.person.login]]);
  if (others.length) for (const p of (await app.db.control.query("SELECT id, login FROM people WHERE id = ANY($1)", [others])).rows) login.set(p.id, p.login);
  // the open-check mark only on one's own record: a space owner does not see the finding kinds of another's record;
  // `by_word` — by the record itself: false once it is no longer in one's own personal space (ownMarkView); outside it — the kind
  // without findings (markViewFor)
  return Promise.all(rows.map(async (r) => ({ id: r.id as string, type: r.type as string, space_id: r.space_id as string, occurred_at: r.occurred_at as Date, at_key: r.at_key as string,
                            owner: login.get(r.owner_id as string) ?? "", hidden: true as const,
                            open_check: r.owner_id === caller.person!.id ? await markViewFor(app, caller, { id: r.id as string, spaceId: r.space_id as string, ownerId: r.owner_id as string, raw: r.open_check }) : null })));
}

/**
 * How many closed-class records in these spaces the key cannot see. Counted by the locators of the control base.
 * For the external agents' address — null, as for virtual folders: closed records are not spoken of there.
 */
async function hiddenClosedCount(app: App, caller: Caller, spaceIds: string[], type?: string): Promise<number | null> {
  if (isExternal(caller)) return null;
  const cond = hiddenClosedSql(caller);
  if (!cond || !caller.person || !spaceIds.length) return 0;
  const args: unknown[] = [spaceIds, type ?? null];
  if (cond.includes("$me")) args.push(caller.person.id);
  const { rows } = await app.db.control.query(
    `SELECT count(*)::int AS n FROM record_locations l
     WHERE l.space_id = ANY($1::uuid[]) AND l.class = 'closed' AND NOT l.deleted AND ($2::text IS NULL OR l.type = $2)
       AND ${cond.replace("$me", "$3")}`, args);
  return rows[0]?.n ?? 0;
}

/** Types of the space's own hidden records with counts: without them the type folder would not show at all. */
async function ownHiddenByType(app: App, caller: Caller, spaceId: string, owner: boolean): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (caller.scope.classes.includes("closed") || !caller.person || isExternal(caller)) return out;
  const { rows } = await app.db.control.query(
    `SELECT l.type, count(*)::int AS n FROM record_locations l
     WHERE l.space_id = $1 AND ($3::boolean OR l.owner_id = $2) AND l.class = 'closed' AND NOT l.deleted GROUP BY l.type`, [spaceId, caller.person.id, owner]);
  for (const r of rows) out.set(r.type, r.n);
  return out;
}

/**
 * `extra` — a condition over `r`: values only through `bind` (parameter numbering does not depend on the place). `archive` —
 * the archive mode of the answer: exclude with A for virtual folders by default; for a space path — without it.
 */
async function pageOfRecords(app: App, caller: Caller, spaces: Map<string, SpaceAccess>, extra: (bind: Bind) => string, limit: number, cursor?: string,
                             hidden?: { spaceIds: string[]; ownedSpaceIds: string[]; type?: string }, archive: ArchiveFilter | null = null) {
  const cur = decodeKeyset(cursor), rows: PageRow[] = [], spec = listingSpec(app, caller, spaces, null, archive);
  const org = await orgSpace(app);
  const orgShown = !!org && spaces.has(org.id), reviewOn = orgReviewEnabled(app.settings);
  for (const cls of caller.scope.classes) {
    const args: unknown[] = [], bind = binder(args);
    const vis = visibleSql(spec, cls, bind);
    if (vis === null) continue;                                 // gate none: the class is not queried
    const cond = [vis, extra(bind)];
    // held "Wrong / not for everyone" ones in org — as an SQL condition: the cursor does not break
    const held = orgShown ? await heldIds(app, caller, cls) : [];
    if (held.length) cond.push(`r.id <> ALL(${bind(held)}::uuid[])`);
    if (cur) cond.push(`(r.occurred_at, r.id) < (${bind(cur.at)}::timestamptz, ${bind(cur.id)}::uuid)`);
    const sql = `SELECT r.*, ${keysetAtSql("r.occurred_at")} AS at_key FROM records_live r WHERE ${cond.join(" AND ")}`;
    const db = app.db.records(cls, caller.scope);
    const got = (await db.query(`${sql} ORDER BY r.occurred_at DESC, r.id DESC LIMIT ${limit + 1}`, args)).rows as Array<RecordRow & { at_key: string; org_confirmed?: boolean; org_view?: string | null }>;
    // org records: the final hold check per unit and "confirmed" by the review row
    const inOrg = org ? got.filter((r) => r.space_id === org.id) : [];
    const units = inOrg.length ? await orgUnitsOf(app.db.control, db, inOrg.map((r) => r.id)) : new Map();
    for (const r of got) {
      const u = units.get(r.id);
      if (u?.held_at && !seesHeld(caller)) continue;
      if (u && (reviewOn || u.held_at)) { r.org_view = reviewView(u); r.org_confirmed = confirmedOf(u, r.confirmed_at); }
      rows.push(r);
    }
  }
  if (hidden) rows.push(...(await ownHiddenRows(app, caller, hidden.spaceIds, hidden.ownedSpaceIds, hidden.type, limit, cur)));
  rows.sort((a, b) => keysetCompare(b, a));                     // descending; merging the bases by the microsecond mark
  const page = rows.slice(0, limit), last = page[page.length - 1];
  return { page, next: rows.length > limit && last ? encodeKeyset(last.at_key, last.id) : null };
}

/**
 * How many records under the `extra` condition the caller sees — the same rights, archive and org hold as pageOfRecords:
 * the count at the "Meetings with participation" folder matches what it will show.
 */
async function countRecords(app: App, caller: Caller, spaces: Map<string, SpaceAccess>, extra: (bind: Bind) => string, archive: ArchiveFilter | null): Promise<number> {
  const spec = listingSpec(app, caller, spaces, null, archive);
  const org = await orgSpace(app);
  const orgShown = !!org && spaces.has(org.id);
  let n = 0;
  for (const cls of caller.scope.classes) {
    const args: unknown[] = [], bind = binder(args);
    const vis = visibleSql(spec, cls, bind);
    if (vis === null) continue;
    const cond = [vis, extra(bind)];
    const held = orgShown ? await heldIds(app, caller, cls) : [];
    if (held.length) cond.push(`r.id <> ALL(${bind(held)}::uuid[])`);
    n += (await app.db.records(cls, caller.scope).query(`SELECT count(*)::int AS n FROM records_live r WHERE ${cond.join(" AND ")}`, args)).rows[0]?.n ?? 0;
  }
  return n;
}

/**
 * The make-up of a selection ("named" — responsible, author, mentioned in the text). A person or
 * an entity is named in a record: a record_entities link of any role but meeting participation (mention, responsible, explicit
 * entity, a project tag); for a person also their own records (author: the owner of the root record, including
 * the employee card), not meetings. Derived meeting records (summary, decisions) do not count by author — their owner is always
 * the organizer; by authorship others' tasks would return. Meeting participation: the participant role on the transcript, for
 * the organizer — owning the meeting (they may be missing from attrs.participants): such meetings form a separate folder
 * /people/<login>/meetings, unless the person is named in the meeting's records. The meeting access list (record_people) is
 * rights, not the make-up. The participant role on a non-meeting record (an explicit person entity from a note's access list,
 * records.ts) — "named" too. For an entity that is not a person, the owner condition finds nothing.
 */
export const namedSql = (e: string): string =>
  `(EXISTS (SELECT 1 FROM record_entities re WHERE re.record_id = r.id AND re.entity_id = ${e} AND (re.role <> 'participant' OR r.type <> 'transcript'))
                   OR (r.owner_id = ${e} AND r.parent_id IS NULL AND r.type <> 'transcript'))`;
export const meetingsOnlySql = (e: string): string =>
  `(r.type = 'transcript' AND (r.owner_id = ${e} OR EXISTS (SELECT 1 FROM record_entities re WHERE re.record_id = r.id AND re.entity_id = ${e} AND re.role = 'participant'))
                   AND NOT EXISTS (SELECT 1 FROM record_entities re WHERE re.record_id = r.id AND re.entity_id = ${e} AND re.role <> 'participant'))`;

/**
 * Visible in the entity folder or its meetings folder (namedSql ∪ meetingsOnlySql) — the condition entityHasVisibleRecord.
 * Earlier the folder condition was here too (a link of any role, the record_people access list, the profile); the folder is now
 * built by namedSql/meetingsOnlySql, and "at least one record visible" is counted the same way as it.
 */
const entityLinked = (entityUuid: string) => (bind: Bind): string => {
  const e = bind(entityUuid);
  return `(${namedSql(e)} OR ${meetingsOnlySql(e)})`;
};

/**
 * Whether the caller sees at least one record linked to the entity: the same query as the entity folder (/entities/<key>) —
 * classes, spaces (with the archive) and the caller's holds. A CRM entity with no visible record is "no" both in the folder
 * and when linking by key (records.ts resolveEntities):
 * otherwise linking to one's own note revealed the title of another's deal from colleagues' closed meetings.
 */
export async function entityHasVisibleRecord(app: App, caller: Caller, entityUuid: string): Promise<boolean> {
  if (!caller.person) return false;
  const all = await readableSpaces(app, caller, { archived: true });
  return (await pageOfRecords(app, caller, all, entityLinked(entityUuid), 1)).page.length > 0;
}

async function slugs(app: App, ids: string[], known: Map<string, SpaceAccess>): Promise<Map<string, string>> {
  const out = new Map<string, string>([...known.values()].map((s) => [s.id, s.slug]));
  const missing = [...new Set(ids)].filter((id) => !out.has(id));
  if (missing.length) for (const r of (await app.db.control.query("SELECT id, slug FROM spaces WHERE id = ANY($1)", [missing])).rows) out.set(r.id, r.slug);
  return out;
}

/**
 * The memory_list root: readme, if the administrator set none (`instances.root_readme`), and folders. The agent reads them and
 * repeats them to people: org for people is "Company common knowledge"; the path /org stays.
 */
export const ROOT_README = "Company memory. /me is my personal space. /org is “Company knowledge” (policies and reference guides; use this name when speaking to people). /spaces contains my teams and projects. /entities/<key> contains records the memory tagged with a deal, company, project or person. /people/<login> contains an employee’s profile, their records and records that mention them. /people/<login>/meetings contains meetings they attended or organized (the links are incomplete, so also use memory_search by title). Use memory_search first, then use memory_read to read the full record and cite its path and locator.";
export const rootEntries = (spaceCount: number): Entry[] => [
  { path: "/me", kind: "folder", title: "Your space" }, { path: "/org", kind: "folder", title: "Company knowledge" },
  { path: "/spaces", kind: "folder", title: "Spaces", count: spaceCount }, { path: "/entities", kind: "folder", title: "Entities: deals, companies, projects, people" },
  { path: "/people", kind: "folder", title: "People" },
];

/** The first readme line of an archived space: the agent repeats it to people and does not write here. */
export const archivedReadme = (s: Pick<SpaceAccess, "slug" | "archived_at">): string =>
  `Space archived on ${new Date(s.archived_at!).toISOString().slice(0, 10)}. Read-only. Search skips it by default. To search it, use filters.space: ${s.slug}.`;

/**
 * A space readme line with the default class and the per-type record counts. The counts —
 * a function shared with the edge (@memory/mcp-core typeCountsLine) in arrival order (GROUP BY rows: byte for byte as before);
 * the edge has no class phrase — the differential test cuts it out with its strip pattern
 * and compares the type list without order (rule unordered), the rest byte for byte.
 */
export const spaceStatsLine = (defaultClass: string, counts: Iterable<readonly [string, number]>, texts: McpTexts): string =>
  `Default class: ${defaultClass}. ${typeCountsLine(counts, texts)}`;

// `texts` — the words of this answer, read once, as in readRecord
export async function list(app: App, caller: Caller, a: { path?: string; limit?: number; cursor?: string; filters?: { archived?: boolean } },
                           texts: McpTexts = textsOf(app)) {
  const limit = Math.min(500, Math.max(1, a.limit ?? 100));
  let path = (a.path ?? "/").trim() || "/";
  if (!caller.person) throw notFound();
  // Archive: the root's folders and counts are the active ones; `filters.archived` adds the archived ones (`archived: true`) and
  // their records in /entities and /people; an explicit path /spaces/<archived> opens without the flag too (include mode)
  const all = await readableSpaces(app, caller, { archived: true });
  const include = a.filters?.archived === true;
  const spaces = new Map([...all].filter(([, s]) => !s.archived_at));
  const A = new Set(await archivedSpaceIds(app));
  const archivedShown = [...all.values()].filter((s) => s.archived_at && A.has(s.id));
  let archiveMode: "exclude" | "include" = include ? "include" : "exclude";
  for (const alias of ["me", "org"]) if (path === `/${alias}` || path.startsWith(`/${alias}/`)) {
    const s = await resolveSpace(app, caller, alias, spaces);
    if (!s) throw notFound();
    path = `/spaces/${s.slug}${path.slice(alias.length + 1)}`;
  }
  const p = parsePath(path);
  if (!p) throw notFound();
  let entries: Entry[] = [], readme: string | null = null, next: string | null = null;
  // hidden_closed: how many closed-class records on this path the key cannot see; null — it cannot be counted
  // (virtual folders: entity links lie in the record base, not in the locator)
  let hiddenClosed: number | null = null;
  const shownClosed: string[] = [];
  const noteClosed = (page: PageRow[]): void => { for (const r of page) if (!isHidden(r) && r.class === "closed") shownClosed.push(r.id); };

  if (p.kind === "root") {
    readme = (await app.db.control.query("SELECT root_readme FROM instances WHERE id = $1", [app.instanceId])).rows[0]?.root_readme
      ?? ROOT_README;
    entries = rootEntries(spaces.size);
    hiddenClosed = await hiddenClosedCount(app, caller, [...spaces.keys()]);
  } else if (p.kind === "spaces") {
    const shown = [...spaces.values(), ...(include ? archivedShown : [])];
    entries = shown.sort((x, y) => x.slug.localeCompare(y.slug))
      .map((s) => ({ path: `/spaces/${s.slug}`, kind: "folder" as const, title: s.name, summary_line: s.description, ...(s.archived_at ? { archived: true as const } : {}) }));
    hiddenClosed = await hiddenClosedCount(app, caller, shown.map((s) => s.id));
    if (!include && archivedShown.length) readme = `There are also ${archivedShown.length} archived ${archivedShown.length === 1 ? "space" : "spaces"} (read-only). Use memory_list /spaces with filters.archived: true.`;
  } else if (p.kind === "folder") {
    readme = p.name === "entities" ? "Provide a key: /entities/ext:<system>:<kind>:<id>, /entities/project:<slug>, /entities/person:<login>" : "Provide a login: /people/<login>";
  } else if (p.kind === "space") {
    const s = [...all.values()].find((x) => x.slug === p.slug);
    if (!s) throw notFound();                                   // another's space is indistinguishable from a missing one
    if (s.archived_at) archiveMode = "include";                 // an explicit path of an archived one — its records
    hiddenClosed = await hiddenClosedCount(app, caller, [s.id], p.type);
    if (!p.type) {
      const counts = new Map<string, number>(); let months: Array<{ ym: string; n: number }> = [];
      const spec = listingSpec(app, caller, [s.id]);
      for (const cls of caller.scope.classes) {
        const args: unknown[] = [], bind = binder(args);
        const vis = visibleSql(spec, cls, bind);
        if (vis === null) continue;
        // held ones in org are not counted: what is not in the list is not in the counts either
        const held = s.kind === "org" ? await heldIds(app, caller, cls) : [];
        const where = `${vis} AND r.space_id = ${bind(s.id)}${held.length ? ` AND r.id <> ALL(${bind(held)}::uuid[])` : ""}`;
        const db = app.db.records(cls, caller.scope);
        for (const r of (await db.query(`SELECT r.type, count(*)::int AS n FROM records_live r WHERE ${where} GROUP BY r.type`, args)).rows) counts.set(r.type, (counts.get(r.type) ?? 0) + r.n);
        // the month in UTC, as the /<year>/<month> folders below and the record path (MONTH_UTC_SQL is shared with the edge):
        // the base session's time zone does not affect the count; it is UTC in the shipped compose files anyway — the same output
        months = months.concat((await db.query(`SELECT ${MONTH_UTC_SQL} AS ym, count(*)::int AS n FROM records_live r WHERE ${where} GROUP BY 1 ORDER BY 1 DESC LIMIT 6`, args)).rows);
      }
      // one's own closed-class records the key does not see are counted in the same type folders: otherwise they
      // could not be reached (the type folder would not show), and actions by id (delete, open in the workplace) would be out of reach
      const ownHidden = await ownHiddenByType(app, caller, s.id, s.role === "owner");
      for (const [t, n] of ownHidden) counts.set(t, (counts.get(t) ?? 0) + n);
      entries = RECORD_TYPES.filter((t) => counts.has(t)).map((t) => ({ path: `/spaces/${s.slug}/${t}`, kind: "folder", type: t, title: t, count: counts.get(t)! }));
      // the space readme is written by the head; the gateway adds the counts when answering. With description templates
      // on — "What to write here" and "More about the space" both; off — the former rule byte for byte
      // the "How we work" map — the first line, only the path of a map visible to the caller; off — no line.
      // In an archived space the first is the archive line (the agent repeats it to people), the map second
      readme = [s.archived_at ? archivedReadme(s) : "", await guideListLine(app, caller, s) ?? "", spaceAbout(s, readmeEnabled(app.settings)), spaceStatsLine(s.default_class, counts, texts),
                monthsLine(months, texts),
                hiddenClosed ? `Hidden by the closed class: ${hiddenClosed}${ownHidden.size ? " (your records are listed without titles; delete them with memory_delete by id; only a person in the workspace can show them to agents)" : ""}.` : ""].filter(Boolean).join("\n");
    } else {
      const extra = (bind: Bind): string => `r.space_id = ${bind(s.id)} AND r.type = ${bind(p.type)}::record_type`
        + (p.year ? ` AND extract(year from r.occurred_at AT TIME ZONE 'UTC') = ${bind(p.year)}` : "")
        + (p.month ? ` AND extract(month from r.occurred_at AT TIME ZONE 'UTC') = ${bind(p.month)}` : "");
      // the owner's hidden records are not split by year and month: the event time is in the closed base, the locator has only
      // the time the record appeared. On paths with a year and month they are not shown (the space readme keeps the count)
      const hidden = p.year || p.month ? undefined : { spaceIds: [s.id], ownedSpaceIds: s.role === "owner" ? [s.id] : [], type: p.type };
      const res = await pageOfRecords(app, caller, new Map([[s.id, s]]), extra, limit, a.cursor, hidden);
      entries = res.page.map((r) => recordEntry(r, s.slug, workplaceUrl(app))); next = res.next; noteClosed(res.page);
    }
  } else if (p.kind === "record") {
    throw invalid("This is a record path. Use memory_read");
  } else {
    // virtual folders: the links lie in the record bases, rights are checked on every record
    let entityUuid: string, title: string, project: SpaceAccess | undefined;
    // the selection's person login (/people/<login>, /entities/person:<login>) for their meetings folder; not a person — null
    let personLogin: string | null = null;
    const meetingsOnly = p.kind === "person" && p.part === PERSON_MEETINGS;
    if (p.kind === "person") {
      // the showcase is isolated: demo personas are not visible to real people, real ones not to demo personas
      const person = (await app.db.control.query(
        "SELECT id, login, display_name, (COALESCE(attrs->>'demo','') = 'true') AS demo FROM people WHERE login = $1 AND instance_id = $2", [p.login, app.instanceId])).rows[0];
      if (!person || person.demo !== (caller.person.demo === true)) throw notFound();
      entityUuid = person.id; title = person.display_name; personLogin = person.login;
    } else {
      const key = parseEntityKey(((): string => { try { return decodeURIComponent(p.key); } catch { return ""; } })());   // malformed %-encoding → not_found
      if (!key) throw notFound();
      // a person — by the people table (after a login change the id stays); an unknown login — "no"
      const resolved = await resolveEntityUuid(app, key);
      if (!resolved || !await entityReadableById(app, caller, resolved)) throw notFound();
      entityUuid = resolved;
      const e = (await app.db.control.query(
        "SELECT display_name, CASE WHEN kind = 'project' THEN attrs->>'space_id' END AS sid FROM entities WHERE id = $1 UNION ALL SELECT display_name, NULL FROM people WHERE id = $1 LIMIT 1", [entityUuid])).rows[0];
      title = e?.display_name ?? key.key;
      project = e?.sid ? all.get(e.sid as string) : undefined;   // the entity of a project the caller reads (with the archive)
      if (key.kind === "person") personLogin = (await app.db.control.query("SELECT login FROM people WHERE id = $1", [entityUuid])).rows[0]?.login ?? null;
    }
    const extra = (bind: Bind): string => (meetingsOnly ? meetingsOnlySql : namedSql)(bind(entityUuid));
    // exclude by default: records visible only through the archive are not shown here; filters.archived — all
    const scope = include ? all : spaces, archive: ArchiveFilter | null = include ? null : { mode: "exclude", spaceIds: [...A] };
    const res = await pageOfRecords(app, caller, scope, extra, limit, a.cursor, undefined, archive);
    const slugMap = await slugs(app, res.page.map((r) => r.space_id), all);
    entries = res.page.map((r) => recordEntry(r, slugMap.get(r.space_id) ?? "unknown", workplaceUrl(app))); next = res.next; noteClosed(res.page);
    // honestly: memory sets links, and not all; meetings where the person only takes part — their own folder as the first line
    // of the first page, with the count it will show
    if (meetingsOnly) readme = meetingsReadme(title, personLogin!);
    else {
      readme = selectionReadme(title);
      const meetings = personLogin && !a.cursor ? await countRecords(app, caller, scope, (bind) => meetingsOnlySql(bind(entityUuid)), archive) : 0;
      if (meetings) {
        entries.unshift({ path: `/people/${personLogin}/${PERSON_MEETINGS}`, kind: "folder", type: "transcript", title: "Meetings attended", count: meetings });
        readme += meetingsHint(personLogin!);
      }
    }
    // an entity without a single visible record is "no": otherwise iterating CRM keys would read a register of client and deal names.
    // The exception is an archived project the caller reads: an empty list with a hint
    if (p.kind === "entity" && !entries.length) {
      if (!include && project?.archived_at && A.has(project.id)) readme = `Project ${project.slug} is archived. Find its records with filters.archived: true (or memory_list /spaces/${project.slug}).`;
      else throw notFound();
    }
  }

  for (const e of entries) { e.type ??= null; e.summary_line ??= null; e.occurred_at ??= null; e.token_count ??= null; e.count ??= null; e.origin ??= null; e.confirmed ??= null; }
  // titles and summaries of closed records are already a read of the closed: their id and class go into the event;
  // hidden locators (a key without the closed class) carry no content and are not included here
  await auditRead(app, caller, { event_type: "list", class: shownClosed.length ? "closed" : null, result_count: entries.length, record_ids: shownClosed,
                                 details: { tool: "memory_list", path_kind: p.kind, archive: archiveMode } });
  const result = { path, readme, hidden_closed: hiddenClosed, entries, next_cursor: next };
  return { result, text: listResultText(path, readme, entries, next, hiddenClosed, texts) };
}

/**
 * The gateway's view and lines for the memory_list text (@memory/mcp-core listText). A hidden closed-class record goes without
 * a title: instead, the gateway's words on why the title is not given (the mcp-core views have no such fields); the count
 * of hidden ones — a gateway line after the cursor.
 */
export function listTextArgs(path: string, readme: string | null, entries: readonly Entry[], next: string | null, hiddenClosed: number | null): [ListView, string[]] {
  // outside one's own personal space (kind `foreign`) — without reasons: only the author can show it in the workplace
  const hiddenLine = (o: OpenCheckView): string => !o.kinds ? "hidden from agents: title and text are withheld; only the author can show it to agents in the workspace"
    : `closed by the open check (${openCheckShort({ findings: o.findings ?? [], unchecked: o.unchecked })}): title and text are withheld`;
  const view = (e: Entry): ListEntryView => ({
    path: e.path, kind: e.kind, title: e.hidden ? (e.open_check ? hiddenLine(e.open_check) : "closed class: title and text are withheld") : e.title,
    count: e.count ?? null, summary_line: e.summary_line ?? null,
  });
  return [{ path, readme, entries: entries.map(view), next_cursor: next }, [hiddenClosed ? `Hidden by the closed class: ${hiddenClosed}` : ""]];
}

/** The memory_list answer text (pinned by golden files): path, readme, record lines in the data block; cursor and hidden count after. */
export function listResultText(path: string, readme: string | null, entries: readonly Entry[], next: string | null, hiddenClosed: number | null, texts: McpTexts): string {
  return listText(...listTextArgs(path, readme, entries, next, hiddenClosed), texts);
}
