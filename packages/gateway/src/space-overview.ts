import type pg from "pg";
import { addDays, binder, dueLanguageOf, entityRefOf, instanceTz, invalid, MemoryError, notFound, parseDateBound, recordPath, resolveDueDate, visibleSql, weekStartOf,
         type Bind, type DataClass, type VisibilitySpec } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import type { SpaceAccess } from "./access.ts";
import { auditShownClosed } from "./audit.ts";
import { listingSpec } from "./visibility.ts";
import { decodeKeyset, encodeKeyset, keysetAtSql, keysetCompare } from "./paging.ts";
import { heldIds, orgUnitsOf, seesHeld } from "./org-hold.ts";
import { entityReadable } from "./records.ts";
import { resolveWithArchive } from "./spaces.ts";

export const SPACE_OVERVIEW_ENABLED_SETTING = "onboarding.space_overview_enabled";
export const SPACE_OVERVIEW_DISABLED_TEXT = "The administrator disabled the space overview";
export const OVERVIEW_PAGE = 10;
export const RISK_DAYS = 30;
export const DUE_SCAN_DAYS = 45;
export const DUE_SCAN_MAX = 200;
export const COUNT_DAYS = 90;
export const COUNT_TOP = 8;
export const WEEK_DAYS = 7;
export const WEEK_TITLES = 5;
const ENTITY_SCAN = 500;
const UNTITLED = "Untitled";
const DAY_MS = 86_400_000;

export const OVERVIEW_BLOCKS = ["decisions", "risks", "due_this_week"] as const;
export type OverviewBlockCode = (typeof OVERVIEW_BLOCKS)[number];
export const OVERVIEW_ENTITY_KINDS = ["deal", "company", "project"] as const;

export const overviewEnabled = (app: Pick<App, "settings">): boolean => app.settings.get<boolean>(SPACE_OVERVIEW_ENABLED_SETTING, false) === true;

export function requireOverviewEnabled(app: Pick<App, "settings">): void {
  if (!overviewEnabled(app)) throw new MemoryError("forbidden", SPACE_OVERVIEW_DISABLED_TEXT, { details: { reason: "space_overview_disabled" } });
}

export interface OverviewRow { id: string; path: string; title: string; occurred_at: string; due?: string; overdue?: boolean }
export interface OverviewBlock { items: OverviewRow[]; next_cursor: string | null; omitted?: true }
export interface OverviewCount { key: string; title: string; count: number; href: string }
export interface OverviewWeekGroup { count: number; items: OverviewRow[] }
export interface SpaceOverview {
  decisions: OverviewBlock; risks: OverviewBlock; due_this_week: OverviewBlock;
  directions: OverviewCount[]; entities: OverviewCount[];
  week: { meetings: OverviewWeekGroup; documents: OverviewWeekGroup; notes: OverviewWeekGroup };
  generated_at: string;
}
export interface SpaceOverviewPage { block: OverviewBlockCode; items: OverviewRow[]; next_cursor: string | null; generated_at: string }

export interface DbRow {
  id: string; type: string; title: string | null; summary_line: string | null; occurred_at: Date | string | null; class: DataClass; at_key: string;
}
export interface Picked { row: OverviewRow; cls: DataClass }

const isoOf = (v: unknown): string | null => {
  if (v === null || v === undefined || v === "") return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

export function overviewRow(r: Pick<DbRow, "id" | "type" | "title" | "summary_line" | "occurred_at">, slug: string): OverviewRow | null {
  const at = isoOf(r.occurred_at);
  if (!r.id || !r.type || !at) return null;
  const title = (r.title ?? "").trim() || (r.summary_line ?? "").trim() || UNTITLED;
  return { id: r.id, path: recordPath(slug, r.type, at, r.id), title, occurred_at: at };
}

export const pickRows = (rows: readonly DbRow[], slug: string): Picked[] =>
  rows.flatMap((r) => { const row = overviewRow(r, slug); return row ? [{ row, cls: r.class }] : []; });

export const dayIn = (at: Date, tz: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

export function dueWindow(now: Date, tz: string): { from: string; to: string; today: string } {
  const monday = weekStartOf(now.getTime(), tz);
  return { from: addDays(monday, -7), to: addDays(monday, 6), today: dayIn(now, tz) };
}

export interface DueCandidate extends DbRow { due_text: string | null }

/**
 * Rows of "Due this week": the due day is resolveDueDate(due words, meeting day, role due) in the memory's time zone and
 * in the phrase set of `language`, with no fallback: unresolved (`null`) or outside dueWindow means no row. Ordered by
 * due day (overdue first), then by id.
 */
export function dueRows(cands: readonly DueCandidate[], slug: string, now: Date, tz: string, language = "en"): Picked[] {
  const w = dueWindow(now, tz), out: Picked[] = [];
  for (const c of cands) {
    const row = overviewRow(c, slug);
    if (!row) continue;
    const due = resolveDueDate(c.due_text, row.occurred_at, { role: "due", tz, language });
    if (!due || due < w.from || due > w.to) continue;
    out.push({ row: { ...row, due, overdue: due < w.today }, cls: c.class });
  }
  return out.sort((a, b) => (a.row.due! < b.row.due! ? -1 : a.row.due! > b.row.due! ? 1 : a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0));
}

export function decodeDueCursor(raw: string | null | undefined): { due: string; id: string } | null {
  const k = decodeKeyset(raw);
  if (!k) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(k.at)) throw invalid("cursor: the opaque string from the previous response (next_cursor)");
  return { due: k.at, id: k.id };
}

export function pageDue(list: readonly Picked[], cur: { due: string; id: string } | null, limit: number): { items: Picked[]; next: string | null } {
  const rest = cur ? list.filter((p) => p.row.due! > cur.due || (p.row.due === cur.due && p.row.id > cur.id)) : [...list];
  const items = rest.slice(0, limit), last = items[items.length - 1];
  return { items, next: rest.length > limit && last ? encodeKeyset(last.row.due!, last.row.id) : null };
}

export function mergeByTime<T extends { at_key: string; id: string }>(rows: readonly T[], limit: number): { page: T[]; next: string | null } {
  const all = [...rows].sort((a, b) => keysetCompare(b, a));
  const page = all.slice(0, limit), last = page[page.length - 1];
  return { page, next: all.length > limit && last ? encodeKeyset(last.at_key, last.id) : null };
}

export function topCounts(rows: readonly OverviewCount[], n: number = COUNT_TOP): OverviewCount[] {
  return rows.filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title, "ru") || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).slice(0, n);
}

export function countWindow(now: Date, tz: string): { from: string; at: string } {
  const from = addDays(dayIn(now, tz), -COUNT_DAYS);
  return { from, at: parseDateBound(from, "from", tz)!.at.toISOString() };
}
const summaryHref = (slug: string, filter: { domain: string } | { entity: string }, from: string): string =>
  `/search?${new URLSearchParams({ space: slug, ...filter, from, mode: "recent" })}`;
export const directionHref = (slug: string, tag: string, from: string): string => summaryHref(slug, { domain: tag }, from);
/** Entity key in the form calls accept (`ext:<system>:<kind>:<id>`, `project:<slug>`) — as memory_read and filters.entity. */
// one formatter for every reader
export const entityKeyOf = entityRefOf;
export const entityHref = (slug: string, key: string, from: string): string => summaryHref(slug, { entity: key }, from);

export function weekGroup(rows: readonly DbRow[], total: number, slug: string): { group: OverviewWeekGroup; picked: Picked[] } {
  const picked = pickRows(mergeByTime(rows, WEEK_TITLES).page, slug);
  return { group: { count: Math.max(total, picked.length), items: picked.map((p) => p.row) }, picked };
}

export function parseOverviewQuery(q: { block?: string | null; cursor?: string | null; omit?: string | null }):
    { block: null; omit?: OverviewBlockCode } | { block: "decisions" | "risks"; cursor: { at: string; id: string } | null } | { block: "due_this_week"; cursor: { due: string; id: string } | null } {
  const block = q.block ?? "", cursor = q.cursor ?? "", omit = q.omit ?? "";
  if (!block) {
    if (cursor) throw invalid("cursor requires block: decisions, risks or due_this_week");
    if (!omit) return { block: null };
    if (!(OVERVIEW_BLOCKS as readonly string[]).includes(omit)) throw invalid("omit: decisions, risks or due_this_week", { field: "omit" });
    return { block: null, omit: omit as OverviewBlockCode };
  }
  if (omit) throw invalid("Use omit without block to get the full overview except for one block", { field: "omit" });
  if (!(OVERVIEW_BLOCKS as readonly string[]).includes(block)) throw invalid("block: decisions, risks or due_this_week", { field: "block" });
  if (block === "due_this_week") return { block, cursor: decodeDueCursor(cursor) };
  return { block: block as "decisions" | "risks", cursor: decodeKeyset(cursor) };
}

interface Ctx {
  app: App; caller: Caller; space: SpaceAccess; spec: VisibilitySpec; held: Map<DataClass, string[]>; now: Date; tz: string;
  /** Language of due phrases (dueLanguageOf). */
  language: string;
  counts: { from: string; at: string };
  holdCheck: boolean;
}

const ROW_COLS = (at: string) => `r.id, r.type, r.title, r.summary_line, r.occurred_at, r.class, ${keysetAtSql(at)} AS at_key`;
const since = (ctx: Ctx, days: number): string => new Date(ctx.now.getTime() - days * DAY_MS).toISOString();

async function contextOf(app: App, caller: Caller, s: SpaceAccess, now: Date): Promise<Ctx> {
  const held = new Map<DataClass, string[]>();
  if (s.kind === "org") for (const cls of caller.scope.classes) held.set(cls, await heldIds(app, caller, cls));
  const tz = instanceTz(app.settings);
  return { app, caller, space: s, spec: listingSpec(app, caller, [s.id]), held, now, tz, language: dueLanguageOf(app.settings), counts: countWindow(now, tz), holdCheck: s.kind === "org" && !seesHeld(caller) };
}

async function eachClass<T>(ctx: Ctx, q: (db: pg.Pool, where: string, bind: Bind, args: unknown[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (const cls of ctx.caller.scope.classes) {
    const args: unknown[] = [], bind = binder(args);
    const vis = visibleSql(ctx.spec, cls, bind);
    if (vis === null) continue;
    const held = ctx.held.get(cls) ?? [];
    const where = `${vis} AND r.space_id = ${bind(ctx.space.id)}${held.length ? ` AND r.id <> ALL(${bind(held)}::uuid[])` : ""}`;
    out.push(...(await q(ctx.app.db.records(cls, ctx.caller.scope), where, bind, args)));
  }
  return out;
}

async function dropHeld<T extends { id: string }>(ctx: Ctx, db: pg.Pool, rows: T[]): Promise<T[]> {
  if (!ctx.holdCheck || !rows.length) return rows;
  const units = await orgUnitsOf(ctx.app.db.control, db, rows.map((r) => r.id));
  return rows.filter((r) => !units.get(r.id)?.held_at);
}

async function timeBlock(ctx: Ctx, cond: (bind: Bind) => string, cursor: { at: string; id: string } | null): Promise<{ picked: Picked[]; next: string | null }> {
  const rows = await eachClass(ctx, async (db, where, bind, args) => {
    const c = [where, cond(bind)];
    if (cursor) c.push(`(r.occurred_at, r.id) < (${bind(cursor.at)}::timestamptz, ${bind(cursor.id)}::uuid)`);
    const got = (await db.query(`SELECT ${ROW_COLS("r.occurred_at")} FROM records_live r WHERE ${c.join(" AND ")} ORDER BY r.occurred_at DESC, r.id DESC LIMIT ${OVERVIEW_PAGE + 1}`, args)).rows as DbRow[];
    return dropHeld(ctx, db, got);
  });
  const { page, next } = mergeByTime(rows, OVERVIEW_PAGE);
  return { picked: pickRows(page, ctx.space.slug), next };
}

const decisionsCond = (_ctx: Ctx) => (): string => "r.type = 'event' AND r.event_kind = 'decision'";
const risksCond = (ctx: Ctx) => (bind: Bind): string => `r.type = 'event' AND r.event_kind = 'question_risk' AND r.occurred_at >= ${bind(since(ctx, RISK_DAYS))}::timestamptz`;

async function dueList(ctx: Ctx): Promise<Picked[]> {
  const rows = await eachClass(ctx, async (db, where, bind, args) => dropHeld(ctx, db, (await db.query(
    `SELECT ${ROW_COLS("r.occurred_at")}, r.attrs->>'due' AS due_text FROM records_live r
      WHERE ${where} AND r.type = 'event' AND r.event_kind = 'action' AND r.attrs->>'due' IS NOT NULL AND r.occurred_at >= ${bind(since(ctx, DUE_SCAN_DAYS))}::timestamptz
      ORDER BY r.occurred_at DESC, r.id DESC LIMIT ${DUE_SCAN_MAX}`, args)).rows as DueCandidate[]));
  return dueRows(mergeByTime(rows, DUE_SCAN_MAX).page, ctx.space.slug, ctx.now, ctx.tz, ctx.language);
}

async function directions(ctx: Ctx): Promise<OverviewCount[]> {
  const n = new Map<string, number>();
  await eachClass(ctx, async (db, where, bind, args) => {
    for (const r of (await db.query(
      `SELECT t.tag, count(DISTINCT r.id)::int AS n FROM records_live r CROSS JOIN LATERAL unnest(r.domain_tags) AS t(tag)
        WHERE ${where} AND r.occurred_at >= ${bind(ctx.counts.at)}::timestamptz GROUP BY t.tag`, args)).rows) n.set(r.tag, (n.get(r.tag) ?? 0) + r.n);
    return [];
  });
  return topCounts([...n].map(([tag, count]) => ({ key: tag, title: tag, count, href: directionHref(ctx.space.slug, tag, ctx.counts.from) })));
}

async function entities(ctx: Ctx): Promise<OverviewCount[]> {
  const n = new Map<string, number>();
  await eachClass(ctx, async (db, where, bind, args) => {
    for (const r of (await db.query(
      `SELECT re.entity_id, count(DISTINCT r.id)::int AS n FROM records_live r JOIN record_entities re ON re.record_id = r.id
        WHERE ${where} AND r.occurred_at >= ${bind(ctx.counts.at)}::timestamptz AND re.role <> 'space'
        GROUP BY re.entity_id ORDER BY n DESC, re.entity_id LIMIT ${ENTITY_SCAN}`, args)).rows) n.set(r.entity_id, (n.get(r.entity_id) ?? 0) + r.n);
    return [];
  });
  if (!n.size) return [];
  const known = (await ctx.app.db.control.query(
    `SELECT id, kind, external_system, external_id, display_name, attrs FROM entities WHERE id = ANY($1::uuid[]) AND instance_id = $2 AND kind = ANY($3::text[])`,
    [[...n.keys()], ctx.app.instanceId, [...OVERVIEW_ENTITY_KINDS]])).rows as Array<{ id: string; kind: string; external_system: string | null; external_id: string | null; display_name: string; attrs: Record<string, unknown> | null }>;
  const ranked = known.map((e) => ({ e, count: n.get(e.id) ?? 0 })).sort((a, b) => b.count - a.count || a.e.display_name.localeCompare(b.e.display_name, "ru"));
  const out: OverviewCount[] = [];
  for (const { e, count } of ranked) {
    if (out.length >= COUNT_TOP) break;
    if (e.kind === "project" && e.attrs?.space_id === ctx.space.id) continue;
    if (!(await entityReadable(ctx.app, ctx.caller, { kind: e.kind, attrs: e.attrs ?? {} }, { archived: "read" }))) continue;
    const key = entityKeyOf(e);
    out.push({ key, title: e.display_name, count, href: entityHref(ctx.space.slug, key, ctx.counts.from) });
  }
  return topCounts(out);
}

type WeekKey = "meetings" | "documents" | "notes";
const WEEK_OF: Record<string, WeekKey> = { transcript: "meetings", document: "documents", note: "notes" };

async function week(ctx: Ctx): Promise<{ week: SpaceOverview["week"]; picked: Picked[] }> {
  const rows = await eachClass(ctx, async (db, where, bind, args) => dropHeld(ctx, db, (await db.query(
    `SELECT x.* FROM (SELECT ${ROW_COLS("r.ingested_at")}, row_number() OVER (PARTITION BY r.type ORDER BY r.ingested_at DESC, r.id DESC) AS n,
                             count(*) OVER (PARTITION BY r.type)::int AS total
                        FROM records_live r
                       WHERE ${where} AND r.ingested_at >= ${bind(since(ctx, WEEK_DAYS))}::timestamptz
                         AND r.type IN ('transcript', 'document', 'note') AND (r.parent_id IS NULL OR r.type = 'note')) x
      WHERE x.n <= ${WEEK_TITLES}`, args)).rows as Array<DbRow & { total: number; n: number }>));
  const out = {} as SpaceOverview["week"], picked: Picked[] = [];
  for (const [type, key] of Object.entries(WEEK_OF)) {
    const mine = rows.filter((r) => r.type === type);
    const total = [...new Map(mine.map((r) => [r.class, r.total])).values()].reduce((s, x) => s + x, 0);
    const g = weekGroup(mine, total, ctx.space.slug);
    out[key] = g.group; picked.push(...g.picked);
  }
  return { week: out, picked };
}

export async function spaceOverview(app: App, caller: Caller, ref: string, q: { block?: string | null; cursor?: string | null; omit?: string | null } = {},
                                    now: Date = new Date()): Promise<SpaceOverview | SpaceOverviewPage> {
  requireOverviewEnabled(app);
  const query = parseOverviewQuery(q);
  const s = await resolveWithArchive(app, caller, ref);
  if (!s) throw notFound();
  const ctx = await contextOf(app, caller, s, now);
  const generated_at = now.toISOString();
  const closedOf = (ps: readonly Picked[]): string[] => ps.filter((p) => p.cls === "closed").map((p) => p.row.id);

  if (query.block) {
    let page: { picked: Picked[]; next: string | null };
    if (query.block === "due_this_week") {
      const p = pageDue(await dueList(ctx), query.cursor, OVERVIEW_PAGE);
      page = { picked: p.items, next: p.next };
    } else page = await timeBlock(ctx, (query.block === "decisions" ? decisionsCond : risksCond)(ctx), query.cursor);
    await auditShownClosed(app, caller, closedOf(page.picked), "space_overview");
    return { block: query.block, items: page.picked.map((p) => p.row), next_cursor: page.next, generated_at };
  }

  const skip = query.omit ?? null;
  const none = { picked: [] as Picked[], next: null as string | null };
  const decisions = skip === "decisions" ? none : await timeBlock(ctx, decisionsCond(ctx), null);
  const risks = skip === "risks" ? none : await timeBlock(ctx, risksCond(ctx), null);
  const due = skip === "due_this_week" ? { items: [] as Picked[], next: null } : pageDue(await dueList(ctx), null, OVERVIEW_PAGE);
  const dirs = await directions(ctx);
  const ents = await entities(ctx);
  const w = await week(ctx);
  await auditShownClosed(app, caller, [...closedOf(decisions.picked), ...closedOf(risks.picked), ...closedOf(due.items), ...closedOf(w.picked)], "space_overview");
  const out = (code: OverviewBlockCode, picked: readonly Picked[], next: string | null): OverviewBlock =>
    ({ items: picked.map((p) => p.row), next_cursor: next, ...(skip === code ? { omitted: true as const } : {}) });
  return {
    decisions: out("decisions", decisions.picked, decisions.next),
    risks: out("risks", risks.picked, risks.next),
    due_this_week: out("due_this_week", due.items, due.next),
    directions: dirs, entities: ents, week: w.week, generated_at,
  };
}
