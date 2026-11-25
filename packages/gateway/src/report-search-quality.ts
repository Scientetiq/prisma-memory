// "Search quality": weeks, slices and frequent
// queries without results — by the search outcomes the worker job outcomes_build prepares. The gateway only reads
// (the memory_audit_reader role, a read-only transaction with statement_timeout 5 s) and applies the people threshold of the
// current setting. No logins, no people ids, no record texts; a query text — only for a group of at least min_group people and
// only for the panel and the system key: an auditor with a personal key
// (also a cloud agent through OAuth) gets the same numbers, and the phrases as one number marked texts: panel_only.
// The access boundary is the admin API route guard (admin.ts), not base rights: the gateway process reads the journal.
import { commitOrThrow } from "@memory/shared";   // a COMMIT answered with ROLLBACK is an error
import type pg from "pg";
import { addDays, buildState, instanceTz, normQuerySql, outcomesLockKeySql, outcomesSettings, SLICE_DIMS, testHooksEnabled, weekStartOf,
         zonedMidnight, type BuildState, type WeekQuality } from "@memory/shared";
import type { App } from "./context.ts";

// the build state (last_build) — a common calculation from @memory/shared: the job's unit tests check it too
export { buildState, SLICE_DIMS, type BuildState, type WeekQuality };
export interface WeekRow { week_start: string; current: boolean; people: number; quality: Partial<WeekQuality> | null; rollout: any; complete: boolean; rules_changed: boolean }

export interface SearchQualityWeek {
  week_start: string; week_end: string; current: boolean; small: boolean; rules_changed: boolean; corrections_complete: boolean;
  searches?: number; zero_share?: number | null; read1_share?: number | null; read3_share?: number | null; read10_share?: number | null;
  no_read_share?: number | null; reformulated_share?: number | null; wrote_after_share?: number | null; avg_first_read_rank?: number | null;
  explicit_link_share?: number | null; corrected_share?: number | null; outdated_share?: number | null; useful_share?: number | null;
}
export interface SliceRow { value: string; searches: number; zero_share: number | null; read3_share: number | null; no_read_share: number | null }
export interface StoredSliceValue { value: string; people: number; searches: number; zero: number; read3: number; no_read: number }
export interface StoredSlices {
  min_group: number; from: string | null; to: string | null; weeks: string[];
  dims: Record<string, { rows: StoredSliceValue[]; other: Omit<StoredSliceValue, "value"> | null }> | null;
}

const share = (n: number, d: number): number | null => (d > 0 ? Number((n / d).toFixed(3)) : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number(v ?? 0) || 0);

/** A read-only transaction on the auditRead() client with a 5 s timeout: a slow journal does not hold the report. */
export async function withAuditRead<T>(app: App, fn: (q: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await app.db.auditRead().connect();
  let broken: Error | undefined;
  try {
    await c.query("BEGIN READ ONLY");
    await c.query("SET LOCAL statement_timeout = '5s'");
    const out = await fn(c);
    await commitOrThrow(c);
    return out;
  } catch (e) {
    broken = e as Error;
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally { c.release(broken); }
}

/** The week zone is memory's zone (a helper shared with search and plans). */
export const weeksTz = (app: Pick<App, "settings">): string => instanceTz(app.settings);

/** Shares and means over raw counters (of weeks or of a summed block): from 0 to 1, null — nothing to divide by. */
export function qualityShares(q: Partial<WeekQuality>) {
  const c = num(q.chains);
  return { searches: c, zero_share: share(num(q.zero), c), read1_share: share(num(q.read1), c), read3_share: share(num(q.read3), c),
           read10_share: share(num(q.read10), c), no_read_share: share(num(q.no_read), c), reformulated_share: share(num(q.reform_true), num(q.reform_known)),
           wrote_after_share: share(num(q.wrote_after), c),
           avg_first_read_rank: num(q.first_rank_n) > 0 ? Number((num(q.first_rank_sum) / num(q.first_rank_n)).toFixed(2)) : null,
           explicit_link_share: share(num(q.explicit), num(q.explicit) + num(q.heuristic)), corrected_share: share(num(q.corrected), num(q.top10)),
           outdated_share: share(num(q.outdated), num(q.top10)), useful_share: share(num(q.useful), num(q.top10)) };
}

/** A week for the answer: fewer than min_group people — small, no numbers. Shares from 0 to 1, null — nothing to divide by. */
export function weekView(r: WeekRow, minGroup: number, now: number, tz: string): SearchQualityWeek {
  const end = addDays(r.week_start, 6);
  const complete = r.complete || zonedMidnight(addDays(r.week_start, 14), tz) <= now;
  const base = { week_start: r.week_start, week_end: end, current: r.current, small: num(r.people) < minGroup, rules_changed: r.rules_changed, corrections_complete: !r.current && complete };
  if (base.small) return base;
  return { ...base, ...qualityShares(r.quality ?? {}) };
}

const sliceRow = (value: string, v: Omit<StoredSliceValue, "value">): SliceRow =>
  ({ value, searches: num(v.searches), zero_share: share(num(v.zero), num(v.searches)), read3_share: share(num(v.read3), num(v.searches)), no_read_share: share(num(v.no_read), num(v.searches)) });

/**
 * Suppressing small groups in a slice: the job's rows already passed the threshold (or it is "service"); "the rest" below
 * the threshold — the whole slice null. The threshold changed after the calculation — stale: no numbers until the next pass.
 */
export function suppress(s: StoredSlices | null, minGroup: number): { from: string; to: string; weeks_used: number; stale: boolean } & Record<typeof SLICE_DIMS[number], SliceRow[] | null> | null {
  if (!s || !s.weeks?.length || !s.from || !s.to) return null;
  const stale = s.min_group !== minGroup;
  const out = { from: s.from, to: s.to, weeks_used: s.weeks.length, stale } as ReturnType<typeof suppress> & object;
  for (const d of SLICE_DIMS) {
    const dim = s.dims?.[d];
    if (stale || !dim) { (out as any)[d] = null; continue; }
    if (dim.other && num(dim.other.searches) > 0 && num(dim.other.people) < minGroup) { (out as any)[d] = null; continue; }
    (out as any)[d] = [...dim.rows.map((r) => sliceRow(r.value, r)), ...(dim.other && num(dim.other.searches) > 0 ? [sliceRow("other", dim.other)] : [])];
  }
  return out;
}

interface Loaded { state: any | null; rows: WeekRow[]; minGroup: number; enabled: boolean; tz: string; now: number; current: string; lastFinished: string;
                  /** How far the job read the journal (cursor) and which weeks wait for a recount — for the finality of blocks. */
                  cursorAt: number | null; dirty: string[] }

async function load(app: App, q: pg.PoolClient, includeTest: boolean, fromWeek: string | null): Promise<Loaded> {
  const st = outcomesSettings(app.settings.get("observability.outcomes", {}));
  const tz = weeksTz(app), now = Date.now(), current = weekStartOf(now, tz);
  const state = (await q.query("SELECT slices, slices_test, slices_min_group, last_pass, cursor_at, dirty_weeks::text[] AS dirty_weeks FROM search_outcomes_state WHERE instance_id = $1",
                               [app.instanceId])).rows[0] ?? null;
  const rows = (await q.query(
    `SELECT week_start::text AS week_start, current, people, quality, rollout, complete, rules_changed FROM search_outcomes_weeks
      WHERE instance_id = $1 AND include_test = $2 AND ($3::date IS NULL OR week_start >= $3::date) ORDER BY week_start DESC`,
    [app.instanceId, includeTest, fromWeek])).rows as WeekRow[];
  const cursorAt = state?.cursor_at ? new Date(state.cursor_at).getTime() : null;
  return { state, rows, minGroup: st.min_group, enabled: st.enabled, tz, now, current, lastFinished: addDays(current, -7), cursorAt, dirty: state?.dirty_weeks ?? [] };
}

/** The window's weeks: finished ones, newest first; with the current hook — the current one first, if the job counted it. */
function windowWeeks(l: Loaded, weeks: number, current: boolean): WeekRow[] {
  const from = addDays(l.lastFinished, -7 * (weeks - 1));
  const done = l.rows.filter((r) => !r.current && r.week_start <= l.lastFinished && r.week_start >= from);
  const cur = current ? l.rows.find((r) => r.current && r.week_start === l.current) : undefined;
  return [...(cur ? [cur] : []), ...done];
}

/**
 * Who gets the texts of frequent empty queries: only the panel and
 * the system key. The system counts a workplace phrase as closed (search.ts, modelClass), and an auditor reads the report
 * with a personal key — also as a cloud agent — and a closed phrase would go to an external service (closed content
 * is not passed to external providers). "The auditor sees texts in the journal anyway" was wrong: it gives only has_query_text.
 */
export const emptyQueryTextsAllowed = (caller: { principalType: string; admin?: { role: string } | null }, settings?: Pick<App["settings"], "get">): boolean =>
  // a security auditor's session on the admin listener is a system principal too, but gets a number, as with a personal key
  caller.principalType === "system" && caller.admin?.role !== "security_auditor"
  && (settings ? settings.get<boolean>("admin.search_quality_query_texts", true) !== false : true);   // the texts switch

/**
 * Frequent queries without results: chain roots with a question and an empty output in the weeks `weeks`; text from the journal.
 * Without the right to texts (`texts = false`) — no phrase: all empty searches as one number hidden_searches, texts: panel_only,
 * so the agent does not explain an empty list by "fewer than min_group people asked so".
 */
async function emptyQueries(app: App, q: pg.PoolClient, weeks: string[], tz: string, includeTest: boolean, minGroup: number, texts: boolean) {
  if (!weeks.length) return null;
  const sorted = [...weeks].sort();
  const lo = zonedMidnight(sorted[0]!, tz), hi = zonedMidnight(addDays(sorted[sorted.length - 1]!, 7), tz);
  const rows = (await q.query(
    `SELECT ${normQuerySql("e.query_text")} AS text, count(*)::int AS searches, count(DISTINCT o.person_id)::int AS people
       FROM search_outcomes o LEFT JOIN audit_events e ON e.id = o.search_event_id AND e.at = o.at AND e.at >= $2 AND e.at < $3
      WHERE o.instance_id = $1 AND o.at >= $2 AND o.at < $3 AND date_trunc('week', o.at AT TIME ZONE $4)::date = ANY($5::date[])
        AND o.continuation_of IS NULL AND o.has_query AND o.zero_result AND o.channel IN ('agent','workplace') AND ($6::boolean OR NOT o.is_test)
      GROUP BY 1`, [app.instanceId, new Date(lo).toISOString(), new Date(hi).toISOString(), tz, sorted, includeTest])).rows as Array<{ text: string | null; searches: number; people: number }>;
  const period = { from: sorted[0]!, to: addDays(sorted[sorted.length - 1]!, 6) };
  const total = rows.reduce((a, r) => a + r.searches, 0);
  if (!texts) return { shown: [] as Array<{ text: string; people: number; searches: number }>, hidden_searches: total, texts: "panel_only" as const, ...period };
  const ok = rows.filter((r) => r.text !== null && r.people >= minGroup).sort((a, b) => b.people - a.people || b.searches - a.searches || a.text!.localeCompare(b.text!));
  const shown = ok.slice(0, 20);
  const hidden = total - shown.reduce((a, r) => a + r.searches, 0);
  return { shown: shown.map((r) => ({ text: r.text!, people: r.people, searches: r.searches })), hidden_searches: hidden, texts: "shown" as const, ...period };
}

/**
 * Summing small weeks: fixed blocks of POOL_BLOCK_WEEKS weeks,
 * counted from POOL_EPOCH, not a window sliding after the last week. A sliding window gave a different but
 * overlapping set of weeks each week, and the difference of two saved periods (a page, a report, a GET /admin/search-quality poll
 * with an auditor's personal key) restored the numbers of one small week — "subtracting one" was possible. Now each small
 * week enters exactly one shown set: a block is shown once, when it is final (poolBlockPlan), and after that
 * it does not change, grow or sum anew.
 */
export const POOL_BLOCK_WEEKS = 4;
/** The Monday that starts block counting: block k — weeks from POOL_EPOCH + 28·k days to +27; the same for all and forever. */
export const POOL_EPOCH = "2024-01-01";
const BLOCK_DAYS = 7 * POOL_BLOCK_WEEKS;
/** A week's correction window (as in the job: 7 days after the week's end) — after it the week's total is final. */
const SETTLE_DAYS = 14;

/** The Monday starting the block that the week (Monday) `week` belongs to. */
export function poolBlockStart(week: string): string {
  const days = Math.round((Date.parse(`${week}T00:00:00Z`) - Date.parse(`${POOL_EPOCH}T00:00:00Z`)) / 86_400_000);
  return addDays(POOL_EPOCH, Math.floor(days / BLOCK_DAYS) * BLOCK_DAYS);
}
export const poolBlockWeeks = (start: string): string[] => Array.from({ length: POOL_BLOCK_WEEKS }, (_, i) => addDays(start, 7 * i));
/** Finished blocks, newest first: the last one (if it is not final yet, the previous one is shown). */
export function finishedPoolBlocks(currentWeek: string): string[] {
  const b = poolBlockStart(currentWeek);
  return [addDays(b, -BLOCK_DAYS), addDays(b, -2 * BLOCK_DAYS)];
}
/** From which week to load totals to cover both candidate blocks. */
export const poolLoadFrom = (currentWeek: string): string => finishedPoolBlocks(currentWeek)[1]!;

export interface PoolState { now: number; tz: string; cursorAt: number | null; dirty: readonly string[] }

/**
 * The block's weeks that are summed; null — the block is not final yet, its numbers may change, it must not be shown.
 * It is final when (1) the correction window of its last week has passed and the job read the journal past that bound
 * (the cursor), (2) no week of the block waits for a recount (dirty_weeks), (3) each week of the block has a job total with
 * complete — or no total and no searches in the week at all (`searched` — the block's weeks with outcome rows; before the
 * data starts). Only small weeks are summed (fewer than min_group people; without searches too): weeks with their own numbers
 * are shown separately and do not enter the sum — else subtracting a shown week would give the sum of the small ones.
 */
export function poolBlockPlan(start: string, rows: readonly WeekRow[], minGroup: number, st: PoolState, searched: ReadonlySet<string>): string[] | null {
  const weeks = poolBlockWeeks(start);
  const settled = zonedMidnight(addDays(weeks[weeks.length - 1]!, SETTLE_DAYS), st.tz);
  if (settled > st.now || st.cursorAt === null || st.cursorAt < settled) return null;
  const out: string[] = [];
  for (const w of weeks) {
    if (st.dirty.includes(w)) return null;
    const row = rows.find((r) => !r.current && r.week_start === w);
    if (!row) { if (searched.has(w)) return null; out.push(w); continue; }
    if (!row.complete) return null;
    if (num(row.people) < minGroup) out.push(w);
  }
  return out;
}

/** The sum of week counters: chain counters add up (a chain is in its root's week), people do not. */
export function sumQuality(rows: ReadonlyArray<Pick<WeekRow, "quality">>): Partial<WeekQuality> {
  const out: Record<string, number> = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.quality ?? {})) if (k !== "people") out[k] = (out[k] ?? 0) + num(v);
  return out as Partial<WeekQuality>;
}

/** Weeks (of `weeks`) that have at least one outcome row — a job total is required for them. */
async function searchedWeeks(q: pg.PoolClient, app: App, tz: string, weeks: string[]): Promise<Set<string>> {
  const sorted = [...weeks].sort();
  const lo = zonedMidnight(sorted[0]!, tz), hi = zonedMidnight(addDays(sorted[sorted.length - 1]!, 7), tz);
  const rows = (await q.query(
    `SELECT DISTINCT date_trunc('week', o.at AT TIME ZONE $4)::date::text AS w FROM search_outcomes o
      WHERE o.instance_id = $1 AND o.at >= $2 AND o.at < $3 AND date_trunc('week', o.at AT TIME ZONE $4)::date = ANY($5::date[])`,
    [app.instanceId, new Date(lo).toISOString(), new Date(hi).toISOString(), tz, sorted])).rows as Array<{ w: string }>;
  return new Set(rows.map((r) => r.w));
}

/**
 * Small weeks together: the last final block of the two finished ones. Distinct people of its small weeks are counted
 * anew by chain roots (the same sign as the job's: a root with a question, an agent or the workplace, test ones by
 * the flag), shares — by the sum of week counters. min_group gathered — numbers only for the block, none for inner weeks; not
 * — null. Empty query texts are not summed: they still come only from weeks with their own numbers.
 */
async function pooledView(q: pg.PoolClient, app: App, l: Loaded, includeTest: boolean) {
  const st: PoolState = { now: l.now, tz: l.tz, cursorAt: l.cursorAt, dirty: l.dirty };
  for (const start of finishedPoolBlocks(l.current)) {
    const weeks = poolBlockWeeks(start);
    const missing = weeks.filter((w) => !l.rows.some((r) => !r.current && r.week_start === w));
    const plan = poolBlockPlan(start, l.rows, l.minGroup, st, missing.length ? await searchedWeeks(q, app, l.tz, missing) : new Set());
    if (plan === null) continue;                                        // not final yet — the previous block
    if (plan.length < 2) return null;                                   // one small week — below the threshold anyway
    const sorted = [...plan].sort();
    const lo = zonedMidnight(sorted[0]!, l.tz), hi = zonedMidnight(addDays(sorted[sorted.length - 1]!, 7), l.tz);
    const people = Number((await q.query(
      `SELECT count(DISTINCT o.person_id)::int AS n FROM search_outcomes o
        WHERE o.instance_id = $1 AND o.at >= $2 AND o.at < $3 AND date_trunc('week', o.at AT TIME ZONE $4)::date = ANY($5::date[])
          AND o.continuation_of IS NULL AND o.has_query AND o.channel IN ('agent','workplace') AND ($6::boolean OR NOT o.is_test)`,
      [app.instanceId, new Date(lo).toISOString(), new Date(hi).toISOString(), l.tz, sorted, includeTest])).rows[0]?.n ?? 0);
    if (people < l.minGroup) return null;
    const inside = l.rows.filter((r) => !r.current && sorted.includes(r.week_start));
    // corrections are counted up — by the block's own weeks (a final block: all complete), not by the fallback rule
    // of weekView "week start + 14 days", which is always right for the block's first week
    return { from: start, to: addDays(start, BLOCK_DAYS - 1), weeks: sorted.length, rules_changed: inside.some((r) => r.rules_changed),
             corrections_complete: inside.every((r) => r.complete), ...qualityShares(sumQuality(inside)) };
  }
  return null;
}

/**
 * The "Search quality" page (GET /admin/search-quality). `texts` — whether to give the texts of frequent empty queries
 * (emptyQueryTextsAllowed: only the panel and the system key). Required: the decision "who sees phrases" is the caller's.
 */
export async function searchQuality(app: App, o: { weeks: number; includeTest: boolean; current: boolean; texts: boolean }) {
  const current = o.current && testHooksEnabled();
  return withAuditRead(app, async (q) => {
    const cw = weekStartOf(Date.now(), weeksTz(app)), from = addDays(cw, -7 * (o.weeks + 1)), pool = poolLoadFrom(cw);
    const l = await load(app, q, o.includeTest, from < pool ? from : pool);
    const weeks = windowWeeks(l, o.weeks, current).map((r) => weekView(r, l.minGroup, l.now, l.tz));
    const stored = (o.includeTest ? l.state?.slices_test : l.state?.slices) as StoredSlices | null | undefined;
    const slices = suppress(stored ?? null, l.minGroup);
    // empty queries — by the same weeks as the slices; with the current hook — the current one too, if it passed the threshold
    const curRow = current ? l.rows.find((r) => r.current && r.week_start === l.current && num(r.people) >= l.minGroup) : undefined;
    const used = [...(slices && !slices.stale ? stored!.weeks : []), ...(curRow ? [curRow.week_start] : [])];
    // small weeks together: the last final fixed block; the load covers both candidate blocks
    const pooled = await pooledView(q, app, l, o.includeTest);
    return { enabled: l.enabled, min_group: l.minGroup, tz: l.tz, last_build: buildState(l.state?.last_pass, l.now), weeks, slices,
             empty_queries: await emptyQueries(app, q, used, l.tz, o.includeTest, l.minGroup, o.texts), pooled };
  });
}

/** Report section "Search quality of the week": the last finished week (with the current hook — the current) and the prior. */
export async function searchQualitySummary(app: App, includeTest: boolean, current: boolean) {
  const cur = current && testHooksEnabled();
  return withAuditRead(app, async (q) => {
    const l = await load(app, q, includeTest, poolLoadFrom(weekStartOf(Date.now(), weeksTz(app))));
    const curRow = cur ? l.rows.find((r) => r.current && r.week_start === l.current) : undefined;
    const weekStart = curRow ? l.current : l.lastFinished;
    const find = (w: string) => l.rows.find((r) => r.week_start === w && (w === l.current ? r.current : !r.current));
    const week = find(weekStart), prev = find(addDays(weekStart, -7));
    // the report week is small — small weeks together (a fixed block), as on the page; with the current hook — no summing
    const pooled = !curRow && (!week || num(week.people) < l.minGroup) ? await pooledView(q, app, l, includeTest) : null;
    return { enabled: l.enabled, min_group: l.minGroup, last_build: buildState(l.state?.last_pass, l.now), week: week ? weekView(week, l.minGroup, l.now, l.tz) : null,
             previous: prev ? weekView(prev, l.minGroup, l.now, l.tz) : null, pooled };
  });
}

/** The "Rollout" week for the report: the week row (the job's rollout) and its bounds; null — the week is not counted yet. */
export async function rolloutWeek(app: App, includeTest: boolean, current: boolean): Promise<{ weekStart: string; tz: string; minGroup: number; row: WeekRow | null }> {
  const cur = current && testHooksEnabled();
  return withAuditRead(app, async (q) => {
    const l = await load(app, q, includeTest, addDays(weekStartOf(Date.now(), weeksTz(app)), -14));
    const curRow = cur ? l.rows.find((r) => r.current && r.week_start === l.current) : undefined;
    const weekStart = curRow ? l.current : l.lastFinished;
    return { weekStart, tz: l.tz, minGroup: l.minGroup, row: curRow ?? l.rows.find((r) => r.week_start === weekStart && !r.current) ?? null };
  });
}

/**
 * The outcomes_build job runs right now — the instance lock (pg_try_advisory_lock(outcomesLockKeySql) in control, the key
 * shared with the worker) is taken: by the worker or run-job. Only pg_locks is read — the gateway takes no lock, not to break
 * the scheduled pass. The "Recount now" button tells the person by it "counting is already running" instead of staying silent.
 */
export async function outcomesRunning(app: Pick<App, "db" | "instanceId">): Promise<boolean> {
  const r = await app.db.control.query(
    `SELECT EXISTS (SELECT 1 FROM pg_locks l WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
                       AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
                       AND ((l.classid::bigint << 32) | l.objid::bigint) = (${outcomesLockKeySql("$1")})::bigint) AS busy`, [app.instanceId]);
  return r.rows[0]?.busy === true;
}

/** People with an agent outcome over 12 months (funnel steps 3–4): something found and the found opened. */
export async function agentOutcomePeople(app: App): Promise<{ found: Set<string>; read: Set<string>; firstRead: Map<string, number> }> {
  return withAuditRead(app, async (q) => {
    const rows = (await q.query(
      `SELECT person_id, bool_or(result_count > 0) AS found, bool_or(cardinality(read_ranks) > 0 OR reads_followup > 0) AS read,
              min(at) FILTER (WHERE cardinality(read_ranks) > 0 OR reads_followup > 0) AS first_read
         FROM search_outcomes WHERE instance_id = $1 AND channel = 'agent' AND person_id IS NOT NULL AND at > now() - interval '12 months'
        GROUP BY person_id`, [app.instanceId])).rows;
    return { found: new Set(rows.filter((r) => r.found).map((r) => r.person_id)), read: new Set(rows.filter((r) => r.read).map((r) => r.person_id)),
             firstRead: new Map(rows.filter((r) => r.first_read).map((r) => [r.person_id as string, new Date(r.first_read).getTime()])) };
  });
}

const ROW_FIELDS = ["search_event_id", "at", "key_id", "principal_type", "key_kind", "client_kind", "channel", "mode", "has_query", "has_filters", "closed_seen", "rerank",
  "result_count", "hit_ids", "zero_result", "continuation_of", "position_offset", "session_id", "session_started_at", "read_ranks", "first_read_rank", "reads_explicit",
  "reads_heuristic", "reads_followup", "reformulated", "wrote_after", "past_notes", "past_notes_others", "past_note_read", "corrected_ids", "outdated_ids", "useful_ids",
  "is_test", "test_reason", "settled", "algo", "built_at"] as const;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : new Date(String(v)).toISOString());

/** The white-box test view: an outcome row without person_id, principal_id, on_behalf_of; null — not built. */
export async function outcomeRow(app: App, id: string): Promise<Record<string, unknown> | null> {
  return withAuditRead(app, async (q) => {
    const r = (await q.query(`SELECT ${ROW_FIELDS.join(", ")} FROM search_outcomes WHERE search_event_id = $1 AND instance_id = $2`, [id, app.instanceId])).rows[0];
    if (!r) return null;
    const s = (await q.query("SELECT session_id, started_at, last_at, channel FROM caller_sessions WHERE session_id = $1", [r.session_id])).rows[0];
    const out: Record<string, unknown> = Object.fromEntries(ROW_FIELDS.map((k) => [k, r[k]]));
    for (const k of ["at", "session_started_at", "built_at"] as const) out[k] = iso(r[k]);
    out.session = s ? { session_id: s.session_id, started_at: iso(s.started_at), last_at: iso(s.last_at), channel: s.channel } : null;
    return out;
  });
}
