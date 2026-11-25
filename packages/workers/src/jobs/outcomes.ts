import { commitOrThrow } from "@memory/shared";   // a COMMIT answered with ROLLBACK is an error
import pg from "pg";
import { addDays, contextMin, LockConnectionLost, log, normQuery, weekStartOf, zonedMidnight, outcomesLockKeySql, outcomesSettings, outcomesWindows, settleMin, showcaseSql, SLICE_DIMS,
         testLoginSql, nightWindowOf, watchLock, type OutcomesSettings, type SliceDim, type WeekQuality } from "@memory/shared";
import type { DbCtx } from "../ctx.ts";
import {
  actorOf, buildOutcome, buildable, channelOf, classify, contextWindow, DAY_MS, filtersKey, FLAGS_WINDOW_MS, isFlagEvent, isRead, isSessionEvent,
  LATE_LINK_MS, markFlags, mergeSnapshot, OUTCOMES_ALGO, prevOf, sessionize, SESSION_TYPES, TEXT_KNOWN_MS, textKnownOf,
  type Ctl, type Ev, type Locator, type OutcomeRow, type PrevSearch, type SessionState, type TestReason, type Who,
} from "./outcomes-core.ts";

export const OUTCOMES_PASS = Object.freeze({ batch: 1000, batches: 20, budgetMs: 60_000, unsettled: 500, statementTimeout: "30s", weeksPerPass: 60,
                                             queryTimeout: "60s", weeksBudgetMs: 60_000 });
export const LATE_REBUILD_MAX = 200;
export const DEFAULT_DEPTH_MS = 90 * DAY_MS;
export const RETENTION = "12 months";

export interface Windows {
  read_window_min: number; reformulate_window_sec: number; session_gap_min: number;
  tz?: string;
  prev?: Pick<Windows, "read_window_min" | "reformulate_window_sec"> | null;
}

export interface OutcomesState {
  cursor_at: number | null; cursor_id: string | null; since: number | null; algo: number; windows: Windows | null;
  rules_changed_at: number | null; workplace_exact_since: number | null; test_resync_at: number | null;
  slices: unknown; slices_test: unknown; slices_min_group: number | null; last_pass: unknown; poison: { id: string; n: number } | null;
  dirty_weeks: string[];
}

export interface ActorKey { keyId: string; principalId: string | null; onBehalfOf: string | null }

export interface WeekCompute { weekStart: string; includeTest: boolean; current: boolean }
export interface WeekRow { week_start: string; include_test: boolean; current: boolean; complete: boolean; people: number }

export interface SliceValue { value: string; people: number; searches: number; zero: number; read3: number; no_read: number; person_ids: string[] }
export { SLICE_DIMS, type SliceDim, type WeekQuality };

export interface OutcomesStore {
  setting(): Promise<unknown>;
  tz(): string;
  now(): Promise<number>;
  loadState(): Promise<OutcomesState | null>;
  saveState(s: OutcomesState): Promise<void>;
  tx<T>(fn: () => Promise<T>): Promise<T>;
  resetSince(since: number): Promise<void>;
  batch(after: { at: number; id: string | null }, hi: number, limit: number): Promise<Ev[]>;
  lastSessions(actors: ActorKey[], before: number): Promise<Map<string, SessionState>>;
  upsertSessions(rows: Array<{ s: SessionState; who: Who | null; channel: "agent" | "workplace" }>): Promise<void>;
  ctl(keyIds: string[], personIds: string[], serviceIds: string[]): Promise<Ctl>;
  locators(recordIds: string[]): Promise<Map<string, Locator>>;
  context(actors: ActorKey[], keyIds: string[], from: number, to: number): Promise<Ev[]>;
  searchEvents(ids: string[]): Promise<Map<string, Ev>>;
  prevSearch(actor: ActorKey, before: { at: number; id: string }, tNow: number): Promise<PrevSearch | null>;
  rows(ids: string[]): Promise<Map<string, OutcomeRow>>;
  upsertRows(rows: OutcomeRow[]): Promise<void>;
  sessionRollout(sessionIds: string[]): Promise<Map<string, { sig: string; startedAt: number }>>;
  flagTargets(recordIds: string[], from: number, to: number): Promise<OutcomeRow[]>;
  correctionRecords(correctionIds: string[], from: number, to: number): Promise<string[]>;
  flagEvents(recordIds: string[], from: number, to: number): Promise<Ev[]>;
  unsettled(maxAt: number, limit: number): Promise<OutcomeRow[]>;
  testPeople(): Promise<Map<string, TestReason>>;
  markTest(people: Map<string, TestReason>): Promise<number[]>;
  weekRows(): Promise<WeekRow[]>;
  missingWeeks(lastFinished: string): Promise<string[]>;
  computeWeek(w: WeekCompute, rulesChangedAt: number | null, complete: boolean): Promise<{ people: number }>;
  sliceValues(weeks: string[], includeTest: boolean): Promise<Record<SliceDim, SliceValue[]>>;
}

export interface PassOpts { since?: Date; rebuild?: boolean; allowTextless?: boolean; settleSec?: number; currentWeek?: boolean }

export interface PassResult {
  at: string; enabled: boolean; built: number; rebuilt_late: number; rebuilt_unsettled: number; skipped: number; unverified_dropped: number;
  lag_sec: number; caught_up: boolean; batches: number; weeks: number; test_resynced: number; error: string | null; busy?: boolean;
  settle_sec: number;
  read: { from_at: string | null; from_id: string | null; to_at: string | null; to_id: string | null; hi: string | null; events: number };
}

export function errorKind(e: unknown): "data" | "infra" {
  const code = String((e as { code?: unknown })?.code ?? "");
  if (/^[0-9A-Z]{5}$/.test(code)) return code.startsWith("22") || code.startsWith("23") ? "data" : "infra";
  if (code) return "infra";
  const msg = String((e as Error)?.message ?? "");
  if (/timeout|terminat|connection|ECONN/i.test(msg)) return "infra";
  return "data";
}

export function foldSlice(dim: SliceDim, values: SliceValue[], minGroup: number):
    { rows: Array<Omit<SliceValue, "person_ids">>; other: Omit<SliceValue, "person_ids" | "value"> | null } {
  const rows: Array<Omit<SliceValue, "person_ids">> = [], people = new Set<string>();
  const other = { people: 0, searches: 0, zero: 0, read3: 0, no_read: 0 };
  for (const v of [...values].sort((a, b) => b.searches - a.searches || a.value.localeCompare(b.value))) {
    const { person_ids, ...row } = v;
    if (v.people >= minGroup || (dim === "key_kind" && v.value === "service")) { rows.push(row); continue; }
    for (const id of person_ids) people.add(id);
    other.searches += v.searches; other.zero += v.zero; other.read3 += v.read3; other.no_read += v.no_read;
  }
  other.people = people.size;
  return { rows, other: other.searches > 0 ? other : null };
}

const toActor = (e: Ev): ActorKey => ({ keyId: e.keyId!, principalId: e.principalId, onBehalfOf: e.onBehalfOf });
const uniq = <T,>(xs: Iterable<T>): T[] => [...new Set(xs)];
const withWeeks = (list: readonly string[], ats: readonly number[], tz: string, lastFinished: string): string[] =>
  withWeekStarts(list, ats.map((a) => weekStartOf(a, tz)).filter((w) => w <= lastFinished));
const withWeekStarts = (list: readonly string[], weeks: readonly string[]): string[] => {
  const have = new Set(list);
  return [...list, ...[...new Set(weeks.filter((w) => !have.has(w)))].sort()];
};
export const sameWindows = (a: Windows | null, b: Windows) => !!a && a.read_window_min === b.read_window_min && a.reformulate_window_sec === b.reformulate_window_sec
  && a.session_gap_min === b.session_gap_min && (a.tz === undefined || b.tz === undefined || a.tz === b.tz);

export type PassLimits = { [K in keyof typeof OUTCOMES_PASS]: (typeof OUTCOMES_PASS)[K] extends number ? number : string };
export async function outcomesPass(store: OutcomesStore, instanceId: string, opts: PassOpts = {}, limits: PassLimits = OUTCOMES_PASS): Promise<PassResult> {
  const started = Date.now();
  const st = outcomesSettings(await store.setting());
  const tNow = await store.now(), tz = store.tz();
  const normalSettleMs = settleMin(st) * 60_000;
  const settleMs = opts.settleSec !== undefined ? Math.max(0, Math.min(900, Math.floor(opts.settleSec))) * 1000 : normalSettleMs;
  const res: PassResult = { at: new Date(tNow).toISOString(), enabled: st.enabled, built: 0, rebuilt_late: 0, rebuilt_unsettled: 0, skipped: 0,
                            unverified_dropped: 0, lag_sec: 0, caught_up: false, batches: 0, weeks: 0, test_resynced: 0, error: null,
                            settle_sec: settleMs / 1000, read: { from_at: null, from_id: null, to_at: null, to_id: null, hi: null, events: 0 } };
  const loaded = await store.loadState();
  const prev = (loaded?.last_pass ?? null) as { at?: unknown; error?: unknown; ok_at?: unknown; weeks_turn?: unknown; week_failures?: unknown } | null;
  const prevOk = typeof prev?.ok_at === "string" ? prev.ok_at : typeof prev?.at === "string" && prev.error == null ? prev.at : null;
  let weeksTurn = typeof prev?.weeks_turn === "number" && Number.isInteger(prev.weeks_turn) ? ((prev.weeks_turn % 3) + 3) % 3 : 0;
  const weekFailures: Record<string, string> = {};
  if (prev?.week_failures && typeof prev.week_failures === "object") {
    for (const [w, t] of Object.entries(prev.week_failures as Record<string, unknown>)) if (typeof t === "string") weekFailures[w] = t;
  }
  const lastPass = () => ({ ...res, rules_changed_at: state.rules_changed_at ? new Date(state.rules_changed_at).toISOString() : null,
                            ok_at: res.error ? prevOk ?? res.at : res.at, weeks_turn: weeksTurn, week_failures: weekFailures });
  const state: OutcomesState = loaded ?? { cursor_at: null, cursor_id: null, since: null, algo: OUTCOMES_ALGO, windows: null, rules_changed_at: null,
    workplace_exact_since: tNow, test_resync_at: null, slices: null, slices_test: null, slices_min_group: null, last_pass: null, poison: null, dirty_weeks: [] };
  if (state.workplace_exact_since === null) state.workplace_exact_since = tNow;
  if (!Array.isArray(state.dirty_weeks)) state.dirty_weeks = [];
  const win: Windows = { ...outcomesWindows(st), tz };
  let rulesChanged = false;
  if (state.windows && !sameWindows(state.windows, win)) {
    state.rules_changed_at = tNow; rulesChanged = true;
    win.prev = { read_window_min: state.windows.read_window_min, reformulate_window_sec: state.windows.reformulate_window_sec };
    if (state.windows.tz !== undefined && state.windows.tz !== tz) {
      const finished = addDays(weekStartOf(tNow, tz), -7);
      state.dirty_weeks = withWeekStarts(state.dirty_weeks, (await store.weekRows()).map((w) => w.week_start).filter((w) => w <= finished));
      state.slices = null; state.slices_test = null;
    }
  } else if (state.windows?.prev && state.rules_changed_at !== null && tNow - state.rules_changed_at < LATE_LINK_MS) win.prev = state.windows.prev;
  state.windows = win;
  if (!st.enabled) {
    state.last_pass = lastPass();
    await store.saveState(state);
    return res;
  }

  const hi = tNow - settleMs, wMs = contextMin(st) * 60_000, gapMs = st.session_gap_min * 60_000;
  const lateMs = win.prev ? Math.min(wMs, contextMin(win.prev) * 60_000) : wMs;
  const lastFinished = addDays(weekStartOf(tNow, tz), -7);

  const commit = async <T,>(fn: (next: OutcomesState) => Promise<T>, next: OutcomesState): Promise<T> => {
    const out = await store.tx(async () => { const r = await fn(next); await store.saveState(next); return r; });
    Object.assign(state, next);
    return out;
  };

  if (opts.since) {
    const since = opts.since.getTime();
    if (!opts.allowTextless && since < tNow - DEFAULT_DEPTH_MS) throw new Error("rebuilding more than 90 days back requires --allow-textless: older request text has already been erased");
    await commit(() => store.resetSince(since), { ...state, cursor_at: since, cursor_id: null, since, poison: null });
  } else if (state.cursor_at === null) {
    state.cursor_at = tNow - DEFAULT_DEPTH_MS; state.since = state.cursor_at;
  }
  if (!loaded) await store.saveState(state);

  res.read.from_at = state.cursor_at === null ? null : pgTimeText(state.cursor_at);
  res.read.from_id = state.cursor_id;
  res.read.hi = pgTimeText(hi);
  let size: number = limits.batch;
  for (let i = 0; i < limits.batches && Date.now() - started < limits.budgetMs; i++) {
    const after = { at: state.cursor_at!, id: state.cursor_id };
    let events = await store.batch(after, hi, size);
    if (!events.length) { res.caught_up = true; break; }
    if (state.poison && state.poison.id === events[0]!.id) {
      if (state.poison.n >= 3) { skip(events[0]!); continue; }
      events = events.slice(0, 1);
    }
    const last = events[events.length - 1]!;
    try {
      const out = await commit(async (next) => {
        const out = await processBatch(store, instanceId, events, { st, tNow, hi, wMs, gapMs, normalSettleMs, workplaceExactSince: state.workplace_exact_since, lateMs });
        next.dirty_weeks = withWeeks(state.dirty_weeks, out.ats, tz, lastFinished);
        return out;
      }, { ...state, cursor_at: last.at, cursor_id: last.id, poison: null });
      res.built += out.built; res.rebuilt_late += out.late; res.unverified_dropped += out.dropped;
      res.batches += 1; res.read.events += events.length;
      if (size < limits.batch) size = Math.min(limits.batch, size * 2);
    } catch (e) {
      if (e instanceof LockConnectionLost) throw e;
      if (errorKind(e) === "infra") {
        const first = events[0]!;
        state.poison = { id: first.id, n: state.poison?.id === first.id ? state.poison.n + 1 : 1 };
        res.error = "infra";
        await store.saveState(state).catch((error: unknown) => {
          if (error instanceof LockConnectionLost) throw error;
        });
        log.warn("outcomes_failed", { kind: "infra", error: String((e as Error)?.message ?? e).slice(0, 200) });
        break;
      }
      if (events.length > 1) { size = Math.max(1, Math.ceil(events.length / 2)); i -= 1; continue; }
      skip(events[0]!);
    }
  }
  function skip(e: Ev) {
    res.skipped += 1; res.read.events += 1;
    state.cursor_at = e.at; state.cursor_id = e.id; state.poison = null;
  }
  if (res.skipped) await store.saveState(state);
  res.read.to_at = state.cursor_at === null ? null : pgTimeText(state.cursor_at);
  res.read.to_id = state.cursor_id;

  if (!res.error) {
    const stage = async (name: string, fn: () => Promise<void>) => {
      try { await fn(); } catch (e) {
        if (e instanceof LockConnectionLost) throw e;
        res.error ??= name;
        log.warn("outcomes_stage_failed", { stage: name, kind: errorKind(e), error: String((e as Error)?.message ?? e).slice(0, 200) });
      }
    };
    await stage("unsettled", async () => {
      const unsettled = await store.unsettled(tNow - normalSettleMs, limits.unsettled);
      if (!unsettled.length) return;
      await commit(async (next) => {
        const ats = await rebuildRows(store, instanceId, unsettled, { st, tNow, hi: tNow, wMs, normalSettleMs, workplaceExactSince: state.workplace_exact_since });
        next.dirty_weeks = withWeeks(state.dirty_weeks, ats, tz, lastFinished);
      }, { ...state });
      res.rebuilt_unsettled = unsettled.length;
    });
    const today = weekDay(tNow, tz);
    if (state.test_resync_at === null || weekDay(state.test_resync_at, tz) !== today) {
      await stage("test_resync", async () => {
        const people = await store.testPeople();
        res.test_resynced = await commit(async (next) => {
          const ats = people.size ? await store.markTest(people) : [];
          next.dirty_weeks = withWeeks(state.dirty_weeks, ats, tz, lastFinished);
          return ats.length;
        }, { ...state, test_resync_at: tNow });
      });
    }
    await stage("weeks", async () => {
      res.weeks = await outcomesWeeks(store, state, { tNow, tz, rulesChanged, currentWeek: !!opts.currentWeek, minGroup: st.min_group, limit: limits.weeksPerPass,
                                                      budgetMs: limits.weeksBudgetMs, turn: weeksTurn, failures: weekFailures },
                                      (p) => { res.weeks = p.weeks; weeksTurn = p.turn; });
    });
  }

  res.lag_sec = res.caught_up ? 0 : Math.max(0, Math.round((hi - (state.cursor_at ?? hi)) / 1000));
  state.last_pass = lastPass();
  await store.saveState(state);
  log.info("outcomes_built", { built: res.built, rebuilt_late: res.rebuilt_late, rebuilt_unsettled: res.rebuilt_unsettled, skipped: res.skipped,
                               unverified_dropped: res.unverified_dropped, batches: res.batches, weeks: res.weeks, lag_sec: res.lag_sec, caught_up: res.caught_up });
  return res;
}

const weekDay = (at: number, tz: string): string => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));

interface BatchEnv {
  st: OutcomesSettings; tNow: number; hi: number; wMs: number; gapMs: number; normalSettleMs: number; workplaceExactSince: number | null;
  lateMs?: number;
}

export async function processBatch(store: OutcomesStore, instanceId: string, events: Ev[], env: BatchEnv):
    Promise<{ built: number; late: number; dropped: number; ats: number[] }> {
  const ats: number[] = [];
  const sessEvents = events.filter(isSessionEvent);
  const actorMap = new Map<string, ActorKey>();
  for (const e of sessEvents) actorMap.set(actorOf(e), toActor(e));
  const prevSessions = actorMap.size ? await store.lastSessions([...actorMap.values()], events[events.length - 1]!.at) : new Map<string, SessionState>();
  const { of: sessionOf, touched } = sessionize(sessEvents, prevSessions, env.gapMs);

  const searches = events.filter((e) => e.type === "search" && buildable(e));
  const firsts = [...touched.values()].map((s) => s.first).filter((e): e is Ev => e !== null);
  const who0 = [...searches, ...firsts];
  const ctl = await store.ctl(uniq(who0.map((e) => e.keyId!).filter(Boolean)),
    uniq(who0.flatMap((e) => [e.principalType === "person" ? e.principalId : null, e.onBehalfOf]).filter((x): x is string => !!x)),
    uniq(who0.filter((e) => e.principalType === "service" && e.principalId).map((e) => e.principalId!)));
  await store.upsertSessions([...touched.values()].map((s) => ({ s, who: s.first ? classify(s.first, ctl) : null,
                                                                 channel: s.first?.details.session === true ? "workplace" as const : "agent" as const })));
  ats.push(...events.map((e) => e.at), ...[...touched.values()].filter((s) => s.first !== null).map((s) => s.startedAt));

  let built = 0;
  const builtIds = new Set<string>();
  const searchesWho = searches.map((s) => ({ s, who: classify(s, ctl) })).filter((x): x is { s: Ev; who: Who } => x.who !== null);
  if (searchesWho.length) {
    const cw = contextWindow(searchesWho.map((x) => x.s.at), env.wMs)!;
    const actors = new Map<string, ActorKey>(searchesWho.map((x) => [actorOf(x.s), toActor(x.s)]));
    const ctxAll = await store.context([...actors.values()], uniq(searchesWho.map((x) => x.s.keyId!)), cw.from, cw.to);
    const mine = await unverifiedMine(store, ctxAll);
    const locators = await store.locators(uniq(searchesWho.flatMap((x) => x.s.recordIds.slice(0, 50))));
    const old = await store.rows(searchesWho.map((x) => x.s.id));
    const prev = new Map<string, PrevSearch | null>();
    const out: OutcomeRow[] = [];
    for (const { s, who } of searchesWho) {
      const a = actorOf(s), sess = sessionOf.get(s.id);
      if (!sess) continue;
      if (!prev.has(a)) prev.set(a, await store.prevSearch(toActor(s), { at: s.at, id: s.id }, env.tNow));
      const context = ctxAll.filter((e) => e.details.op === "original_download" ? e.details.key_id === s.keyId : actorOf(e) === a);
      const was = old.get(s.id);
      const chain = was && was.algo === OUTCOMES_ALGO && !textKnownOf(s, env.tNow) ? { continuation_of: was.continuation_of, position_offset: was.position_offset } : undefined;
      const b = buildOutcome({ instanceId, search: s, who, session: { id: sess.id, startedAt: sess.startedAt }, prev: prev.get(a)!, ...(chain ? { chain } : {}), context, locators,
                               settings: env.st, workplaceExactSince: env.workplaceExactSince, tNow: env.tNow, settleMs: env.normalSettleMs, unverifiedMine: mine });
      const row = mergeSnapshot(was ?? null, b.row, b.textKnown);
      if (channelOf(s) !== "workplace_auto") prev.set(a, prevOf(s, row, env.tNow));
      out.push(row); builtIds.add(s.id);
    }
    built = out.length;
    await applyFlags(store, out, env.hi);
    ats.push(...await writeRows(store, out, [...old.values()]));
  }

  let dropped = 0;
  const linked = events.filter((r) => isRead(r) && typeof r.details.search_id === "string" && ("rank" in r.details || r.details.search_link === "unverified"));
  const late = new Set<string>();
  if (linked.length) {
    const sevents = await store.searchEvents(uniq(linked.map((r) => String(r.details.search_id))));
    for (const r of linked) {
      const s = sevents.get(String(r.details.search_id));
      if (r.details.search_link === "unverified" && (!s || actorOf(s) !== actorOf(r))) { dropped += 1; continue; }
      if (s && r.at >= s.at + (env.lateMs ?? env.wMs)) late.add(s.id);
    }
  }
  if (late.size) {
    const rows = [...(await store.rows([...late])).values()];
    const now = rows.slice(0, LATE_REBUILD_MAX), later = rows.slice(LATE_REBUILD_MAX).map((r) => ({ ...r, settled: false }));
    ats.push(...await rebuildRows(store, instanceId, now, { ...env, hi: events[events.length - 1]!.at + 1 }, true));
    if (later.length) await store.upsertRows(later);
  }

  const flagEvs = events.filter(isFlagEvent);
  if (flagEvs.length) {
    const lo = Math.min(...flagEvs.map((e) => e.at)), top = Math.max(...flagEvs.map((e) => e.at));
    const cids = uniq(flagEvs.filter((e) => !e.recordIds.length && typeof e.details.correction_id === "string").map((e) => String(e.details.correction_id)));
    const recs = uniq([...flagEvs.flatMap((e) => e.recordIds), ...(cids.length ? await store.correctionRecords(cids, lo - FLAGS_WINDOW_MS, top) : [])]);
    if (recs.length) {
      const targets = (await store.flagTargets(recs, lo - 2 * FLAGS_WINDOW_MS, top)).filter((r) => !builtIds.has(r.search_event_id) && !late.has(r.search_event_id));
      if (targets.length) {
        await applyFlags(store, targets, env.hi);
        await store.upsertRows(targets);
        ats.push(...targets.map((r) => r.at));
      }
    }
  }
  return { built, late: Math.min(late.size, LATE_REBUILD_MAX), dropped, ats };
}

async function writeRows(store: OutcomesStore, rows: OutcomeRow[], oldRows: Iterable<OutcomeRow> = []): Promise<number[]> {
  if (!rows.length) return [];
  const olds = [...oldRows];
  const sids = uniq([...rows.map((r) => r.session_id), ...olds.map((r) => r.session_id)]);
  const was = await store.sessionRollout(sids);
  await store.upsertRows(rows);
  const now = await store.sessionRollout(sids);
  const starts = sids.flatMap((id) => {
    const a = was.get(id), b = now.get(id);
    return a?.sig === b?.sig ? [] : [(b ?? a)!.startedAt];
  });
  const written = new Set(rows.map((r) => r.search_event_id));
  const roots = uniq([...rows, ...olds].map((r) => r.continuation_of).filter((x): x is string => x !== null && !written.has(x)));
  const rootAts = roots.length ? [...(await store.rows(roots)).values()].map((r) => r.at) : [];
  return [...rows.map((r) => r.at), ...starts, ...rootAts];
}

async function unverifiedMine(store: OutcomesStore, ctx: Ev[]): Promise<Set<string>> {
  const un = ctx.filter((r) => isRead(r) && r.details.search_link === "unverified" && typeof r.details.search_id === "string");
  if (!un.length) return new Set();
  const ev = await store.searchEvents(uniq(un.map((r) => String(r.details.search_id))));
  return new Set(un.filter((r) => { const s = ev.get(String(r.details.search_id)); return !!s && actorOf(s) === actorOf(r); }).map((r) => r.id));
}

async function applyFlags(store: OutcomesStore, rows: OutcomeRow[], hi: number): Promise<void> {
  const withHits = rows.filter((r) => r.hit_ids.length);
  for (const r of rows) if (!r.hit_ids.length) Object.assign(r, { corrected_ids: [], outdated_ids: [], useful_ids: [] });
  if (!withHits.length) return;
  const from = Math.min(...withHits.map((r) => r.at)), to = Math.min(Math.max(...withHits.map((r) => r.at)) + FLAGS_WINDOW_MS, hi);
  const evs = to > from ? await store.flagEvents(uniq(withHits.flatMap((r) => r.hit_ids.slice(0, 10))), from, to) : [];
  for (const r of withHits) Object.assign(r, markFlags(r.hit_ids, r.at, evs, hi));
}

export function contextClusters<T extends { s: Ev; to: number }>(items: T[]): T[][] {
  const byActor = new Map<string, T[]>();
  for (const x of items) {
    const a = actorOf(x.s), list = byActor.get(a);
    if (list) list.push(x); else byActor.set(a, [x]);
  }
  const out: T[][] = [];
  for (const list of byActor.values()) {
    list.sort((a, b) => a.s.at - b.s.at);
    let cur: T[] = [], end = -Infinity;
    for (const x of list) {
      if (cur.length && x.s.at > end) { out.push(cur); cur = []; end = -Infinity; }
      cur.push(x); end = Math.max(end, x.to);
    }
    if (cur.length) out.push(cur);
  }
  return out;
}

async function rebuildRows(store: OutcomesStore, instanceId: string, rows: OutcomeRow[],
                           env: Omit<BatchEnv, "gapMs"> & { gapMs?: number }, late = false): Promise<number[]> {
  if (!rows.length) return [];
  const evs = await store.searchEvents(rows.map((r) => r.search_event_id));
  const items = rows.map((r) => ({ r, s: evs.get(r.search_event_id) })).filter((x): x is { r: OutcomeRow; s: Ev } => !!x.s);
  if (!items.length) return [];
  const ctl = await store.ctl(uniq(items.map((x) => x.s.keyId!).filter(Boolean)),
    uniq(items.flatMap((x) => [x.s.principalType === "person" ? x.s.principalId : null, x.s.onBehalfOf]).filter((x): x is string => !!x)),
    uniq(items.filter((x) => x.s.principalType === "service" && x.s.principalId).map((x) => x.s.principalId!)));
  const locators = await store.locators(uniq(items.flatMap((x) => x.r.hit_ids)));
  const out: OutcomeRow[] = [];
  for (const cluster of contextClusters(items.map((x) => ({ ...x, to: Math.max(Math.min(x.s.at + LATE_LINK_MS, env.hi), x.s.at + 1) })))) {
    const head = cluster[0]!.s;
    const all = await store.context([toActor(head)], [head.keyId!], head.at, Math.max(...cluster.map((x) => x.to)));
    const mine = await unverifiedMine(store, all);
    for (const { r, s, to } of cluster) {
      const who = classify(s, ctl);
      if (!who) continue;
      const context = all.filter((e) => e.at >= s.at && e.at < to);
      const b = buildOutcome({ instanceId, search: s, who, session: { id: r.session_id, startedAt: r.session_started_at }, prev: null,
                               chain: { continuation_of: r.continuation_of, position_offset: r.position_offset },
                               context: context.filter((e) => e.details.op === "original_download" ? e.details.key_id === s.keyId : actorOf(e) === actorOf(s)),
                               locators, settings: env.st, workplaceExactSince: env.workplaceExactSince, tNow: env.tNow, settleMs: env.normalSettleMs, unverifiedMine: mine });
      const row = mergeSnapshot(r, b.row, b.textKnown);
      if (late) row.settled = r.settled || row.settled;
      out.push(row);
    }
  }
  await applyFlags(store, out, env.hi);
  return writeRows(store, out, rows);
}

export async function outcomesWeeks(store: OutcomesStore, state: OutcomesState,
                                    o: { tNow: number; tz: string; rulesChanged: boolean; currentWeek: boolean; minGroup: number; limit: number; budgetMs: number;
                                         turn?: number; failures?: Record<string, string> },
                                    progress: (p: { weeks: number; turn: number }) => void = () => undefined): Promise<number> {
  const started = Date.now();
  const current = weekStartOf(o.tNow, o.tz), lastFinished = addDays(current, -7);
  const existing = await store.weekRows();
  const dirty = state.dirty_weeks.filter((w) => w <= lastFinished);
  const queued = new Set(dirty);
  const once = new Set(await store.missingWeeks(lastFinished));
  if (o.rulesChanged && state.rules_changed_at) { const w = weekStartOf(state.rules_changed_at, o.tz); if (w <= lastFinished) once.add(w); }
  const again = existing.filter((w) => w.week_start <= lastFinished && (!w.complete || w.current)).map((w) => w.week_start);
  const desc = (xs: Iterable<string>) => [...new Set(xs)].sort().reverse().filter((w) => !queued.has(w));
  const classes = [dirty, desc(once), desc(again)];
  const pos = [0, 0, 0], tried = new Set<string>();
  let turn = ((o.turn ?? 0) % 3 + 3) % 3, n = 0, firstError: unknown = null;
  const next = (): string | null => {
    for (let j = 0; j < 3; j++) {
      const c = (turn + j) % 3, list = classes[c]!;
      while (pos[c]! < list.length && tried.has(list[pos[c]!]!)) pos[c] = pos[c]! + 1;
      if (pos[c]! < list.length) { turn = (c + 1) % 3; return list[pos[c]!]!; }
    }
    return null;
  };
  const failed = (week: string, e: unknown) => {
    firstError ??= e;
    log.warn("outcomes_week_failed", { week, kind: errorKind(e), error: String((e as Error)?.message ?? e).slice(0, 200) });
  };
  while (tried.size < o.limit && (tried.size === 0 || Date.now() - started <= o.budgetMs)) {
    const w = next();
    if (w === null) break;
    tried.add(w);
    const complete = zonedMidnight(addDays(w, 7), o.tz) + FLAGS_WINDOW_MS <= o.tNow;
    try {
      for (const inc of [false, true]) await store.computeWeek({ weekStart: w, includeTest: inc, current: false }, state.rules_changed_at, complete);
      state.dirty_weeks = state.dirty_weeks.filter((x) => x !== w);
      if (o.failures) delete o.failures[w];
      n += 1;
    } catch (e) {
      failed(w, e);
      state.dirty_weeks = [...state.dirty_weeks.filter((x) => x !== w), w];
      if (o.failures) o.failures[w] ??= new Date(o.tNow).toISOString();
    }
    progress({ weeks: n, turn });
  }
  progress({ weeks: n, turn });
  if (o.currentWeek) {
    try { for (const inc of [false, true]) await store.computeWeek({ weekStart: current, includeTest: inc, current: true }, state.rules_changed_at, false); }
    catch (e) { failed(current, e); }
  }
  if (n || o.currentWeek || state.slices_min_group !== o.minGroup || state.slices === null || state.slices_test === null) {
    const rows = await store.weekRows();
    for (const inc of [false, true]) {
      const last4 = uniq(rows.filter((r) => !r.current && r.week_start <= lastFinished).map((r) => r.week_start)).sort().reverse().slice(0, 4);
      const people = new Map(rows.filter((r) => r.include_test === inc && !r.current).map((r) => [r.week_start, r.people]));
      const used = last4.filter((w) => (people.get(w) ?? 0) >= o.minGroup);
      const values = used.length ? await store.sliceValues(used, inc) : null;
      const dims = values ? Object.fromEntries(SLICE_DIMS.map((d) => [d, foldSlice(d, values[d], o.minGroup)])) : null;
      const slices = { min_group: o.minGroup, from: last4.length ? last4[last4.length - 1] : null, to: last4.length ? addDays(last4[0]!, 6) : null,
                       weeks: used, dims };
      if (inc) state.slices_test = slices; else state.slices = slices;
    }
    state.slices_min_group = o.minGroup;
  }
  if (firstError) throw firstError;
  return n;
}

// ---------------------------------------------------------------- Postgres

const EV_COLS = "id, at, event_type, key_id, principal_type, principal_id, on_behalf_of, record_ids, query_text, filters, result_count, details, class";

const TS_RE = /^(\d{4,})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?(?:([+-])(\d\d)(?::?(\d\d))?(?::?(\d\d))?|Z)?$/;
export function pgTime(v: unknown): number {
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  const s = String(v), m = TS_RE.exec(s);
  if (!m) return Date.parse(s);
  const [, y, mo, d, h, mi, se, frac = "", sign, oh = "0", om = "0", os = "0"] = m;
  const off = sign ? (sign === "-" ? -1 : 1) * ((Number(oh) * 60 + Number(om)) * 60 + Number(os)) * 1000 : 0;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se)) - off + Number(frac.padEnd(6, "0")) / 1000;
}
export function pgTimeText(t: number): string {
  let whole = Math.floor(t), us = Math.round((t - whole) * 1000);
  if (us >= 1000) { whole += 1; us -= 1000; }
  return new Date(whole).toISOString().replace(/Z$/, `${String(us).padStart(3, "0")}Z`);
}
const EXACT_TYPES = { getTypeParser: (oid: number, format?: "text" | "binary") => (oid === 1184 ? (v: string) => v : (pg.types.getTypeParser as any)(oid, format)) };
const ms = pgTime;
const evOf = (r: Record<string, any>): Ev => ({ id: r.id, at: ms(r.at), type: r.event_type, keyId: r.key_id, principalType: r.principal_type, principalId: r.principal_id,
  onBehalfOf: r.on_behalf_of, recordIds: r.record_ids ?? [], queryText: r.query_text, filters: r.filters, resultCount: r.result_count, details: r.details ?? {}, cls: r.class });

const ROW_COLS: Array<[keyof OutcomeRow, string]> = [
  ["search_event_id", "uuid"], ["at", "timestamptz"], ["instance_id", "text"], ["key_id", "uuid"], ["principal_type", "text"], ["principal_id", "uuid"],
  ["on_behalf_of", "uuid"], ["person_id", "uuid"], ["key_kind", "text"], ["client_kind", "text"], ["channel", "text"], ["mode", "text"], ["has_query", "boolean"],
  ["has_filters", "boolean"], ["closed_seen", "boolean"], ["rerank", "boolean"], ["result_count", "int"], ["hit_ids", "uuid[]"], ["zero_result", "boolean"],
  ["continuation_of", "uuid"], ["position_offset", "int"], ["session_id", "uuid"], ["session_started_at", "timestamptz"], ["read_ranks", "int[]"],
  ["first_read_rank", "int"], ["reads_explicit", "int"], ["reads_heuristic", "int"], ["reads_followup", "int"], ["reformulated", "boolean"],
  ["wrote_after", "boolean"], ["past_notes", "smallint"], ["past_notes_others", "smallint"], ["past_note_read", "boolean"], ["corrected_ids", "uuid[]"],
  ["outdated_ids", "uuid[]"], ["useful_ids", "uuid[]"], ["is_test", "boolean"], ["test_reason", "text"], ["settled", "boolean"], ["algo", "smallint"],
];
const rowOf = (r: Record<string, any>): OutcomeRow => {
  const o = Object.fromEntries(ROW_COLS.map(([k]) => [k, r[k]])) as unknown as OutcomeRow;
  o.at = ms(r.at); o.session_started_at = ms(r.session_started_at);
  return o;
};

export const ALIGN_ROWS_SQL = `UPDATE search_outcomes o SET at = e.at FROM audit_events e
  WHERE o.instance_id = $1 AND o.at >= $2 AND o.at = date_trunc('milliseconds', o.at)
    AND e.instance_id = o.instance_id AND e.id = o.search_event_id AND e.at >= $2 AND e.at > o.at AND e.at < o.at + interval '1 millisecond'`;
export const ALIGN_SESSIONS_FROM_SQL = `SELECT min(started_at) AS lo FROM caller_sessions
  WHERE instance_id = $1 AND started_at < $2 AND last_at >= $2 AND started_at = date_trunc('milliseconds', started_at)`;
export const ALIGN_SESSIONS_SQL = `UPDATE caller_sessions c SET started_at = e.at FROM audit_events e
  WHERE c.instance_id = $1 AND c.started_at < $2 AND c.last_at >= $2 AND c.started_at = date_trunc('milliseconds', c.started_at)
    AND e.instance_id = c.instance_id AND e.id = c.session_id AND e.at >= $3 AND e.at < $2
    AND e.at > c.started_at AND e.at < c.started_at + interval '1 millisecond'`;

export const TRIM_SESSIONS_SQL = `UPDATE caller_sessions c SET built_at = now(), last_at = COALESCE((
    SELECT max(e.at) FROM audit_events e
     WHERE e.instance_id = c.instance_id AND (e.principal_id = c.principal_id OR (c.principal_id IS NULL AND e.principal_id IS NULL)) AND e.key_id = c.key_id
       AND e.on_behalf_of IS NOT DISTINCT FROM c.on_behalf_of AND e.at >= c.started_at AND e.at < $2
       AND e.event_type = ANY($3::text[]) AND e.principal_type IN ('person', 'service')
       AND NOT COALESCE(e.details->'preview' = 'true'::jsonb, false) AND NOT COALESCE(e.details->'auto' = 'true'::jsonb, false)
       AND COALESCE(e.details->>'op', '') <> 'original_download'), c.started_at)
  WHERE c.instance_id = $1 AND c.started_at < $2 AND c.last_at >= $2`;

export function uuidV7Ms(id: string): number | null {
  const hex = id.replace(/-/g, "");
  if (hex.length !== 32 || hex[12] !== "7") return null;
  return parseInt(hex.slice(0, 12), 16);
}
const SKEW_MS = 5 * 60_000;

interface Q { query(sql: string | { text: string; values?: unknown[]; types?: unknown }, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> }

export function pgStore(ctx: DbCtx, client: Q, alive?: () => Promise<void>): OutcomesStore {
  const I = ctx.instanceId, control = ctx.db.control as unknown as Q;
  const audit = { query: (sql: string, params?: unknown[]) => client.query({ text: sql, values: params ?? [], types: EXACT_TYPES }) };
  const ts = pgTimeText;
  const tz = nightWindowOf(ctx.settings).tz;
  const actorsSql = (actors: ActorKey[], off: number) => {
    const p: unknown[] = [actors.map((a) => a.keyId), actors.map((a) => a.principalId), actors.map((a) => a.onBehalfOf)];
    return { p, sql: `key_id = ANY($${off}::uuid[]) AND EXISTS (SELECT 1 FROM unnest($${off}::uuid[], $${off + 1}::uuid[], $${off + 2}::uuid[]) AS a(k, p, o)
                       WHERE key_id = a.k AND principal_id IS NOT DISTINCT FROM a.p AND on_behalf_of IS NOT DISTINCT FROM a.o)` };
  };
  return {
    setting: async () => ctx.settings.get("observability.outcomes", {}),
    tz: () => tz,
    now: async () => ms((await audit.query("SELECT now() AS t")).rows[0].t),
    async loadState() {
      const r = (await audit.query("SELECT *, dirty_weeks::text[] AS dirty FROM search_outcomes_state WHERE instance_id = $1", [I])).rows[0];
      if (!r) return null;
      const t = (v: unknown) => (v === null || v === undefined ? null : ms(v));
      return { cursor_at: t(r.cursor_at), cursor_id: r.cursor_id, since: t(r.since), algo: r.algo, windows: r.windows, rules_changed_at: t(r.rules_changed_at),
               workplace_exact_since: t(r.workplace_exact_since), test_resync_at: t(r.test_resync_at), slices: r.slices, slices_test: r.slices_test,
               slices_min_group: r.slices_min_group, last_pass: r.last_pass, poison: r.poison, dirty_weeks: r.dirty ?? [] };
    },
    async saveState(s) {
      const d = (v: number | null) => (v === null ? null : ts(v));
      if (alive) await alive();
      await audit.query(
        `INSERT INTO search_outcomes_state (instance_id, cursor_at, cursor_id, since, algo, windows, rules_changed_at, workplace_exact_since, test_resync_at,
                                            slices, slices_test, slices_min_group, last_pass, poison, dirty_weeks, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::date[], now())
         ON CONFLICT (instance_id) DO UPDATE SET cursor_at = EXCLUDED.cursor_at, cursor_id = EXCLUDED.cursor_id, since = EXCLUDED.since, algo = EXCLUDED.algo,
           windows = EXCLUDED.windows, rules_changed_at = EXCLUDED.rules_changed_at, workplace_exact_since = EXCLUDED.workplace_exact_since,
           test_resync_at = EXCLUDED.test_resync_at, slices = EXCLUDED.slices, slices_test = EXCLUDED.slices_test, slices_min_group = EXCLUDED.slices_min_group,
           last_pass = EXCLUDED.last_pass, poison = EXCLUDED.poison, dirty_weeks = EXCLUDED.dirty_weeks, updated_at = now()`,
        [I, d(s.cursor_at), s.cursor_id, d(s.since), s.algo, JSON.stringify(s.windows), d(s.rules_changed_at), d(s.workplace_exact_since), d(s.test_resync_at),
         JSON.stringify(s.slices), JSON.stringify(s.slices_test), s.slices_min_group, JSON.stringify(s.last_pass), JSON.stringify(s.poison), s.dirty_weeks ?? []]);
    },
    async tx(fn) {
      await audit.query("BEGIN");
      try {
        await audit.query(`SET LOCAL statement_timeout = '${OUTCOMES_PASS.statementTimeout}'`);
        const out = await fn();
        await commitOrThrow(audit);
        return out;
      } catch (e) { await audit.query("ROLLBACK").catch(() => undefined); throw e; }
    },
    async resetSince(since) {
      const s = ts(since);
      await audit.query(ALIGN_ROWS_SQL, [I, s]);
      const lo = (await audit.query(ALIGN_SESSIONS_FROM_SQL, [I, s])).rows[0]?.lo;
      if (lo) await audit.query(ALIGN_SESSIONS_SQL, [I, s, lo]);
      await audit.query("DELETE FROM caller_sessions WHERE instance_id = $1 AND started_at >= $2", [I, s]);
      await audit.query(TRIM_SESSIONS_SQL, [I, s, [...SESSION_TYPES]]);
    },
    async batch(after, hi, limit) {
      const r = await audit.query(
        `SELECT ${EV_COLS} FROM audit_events
          WHERE instance_id = $1 AND event_type = ANY($2::text[]) AND at >= $3 AND at < $4 AND (at > $3 OR $5::uuid IS NULL OR id > $5::uuid)
          ORDER BY at, id LIMIT $6`,
        [I, [...SESSION_TYPES], ts(after.at), ts(hi), after.id, limit]);
      return r.rows.map(evOf);
    },
    async lastSessions(actors, before) {
      const a = actorsSql(actors, 2);
      const r = await audit.query(
        `SELECT DISTINCT ON (key_id, principal_id, on_behalf_of) session_id, key_id, principal_id, on_behalf_of, started_at, last_at
           FROM caller_sessions WHERE instance_id = $1 AND ${a.sql} AND started_at <= $5
          ORDER BY key_id, principal_id, on_behalf_of, last_at DESC`, [I, ...a.p, ts(before)]);
      return new Map(r.rows.map((x) => {
        const actor = `${x.key_id ?? "-"}|${x.principal_id ?? "-"}|${x.on_behalf_of ?? "-"}`;
        return [actor, { id: x.session_id, actor, startedAt: ms(x.started_at), lastAt: ms(x.last_at), first: null } satisfies SessionState];
      }));
    },
    async upsertSessions(rows) {
      for (const { s, who, channel } of rows) {
        if (s.first && who) {
          await audit.query(
            `INSERT INTO caller_sessions (session_id, instance_id, key_id, principal_type, principal_id, on_behalf_of, person_id, channel, key_kind, client_kind,
                                          started_at, last_at, is_test, test_reason, algo)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
             ON CONFLICT (session_id) DO UPDATE SET last_at = GREATEST(caller_sessions.last_at, EXCLUDED.last_at),
               is_test = caller_sessions.is_test OR EXCLUDED.is_test,
               test_reason = CASE WHEN caller_sessions.is_test THEN caller_sessions.test_reason ELSE EXCLUDED.test_reason END, built_at = now()`,
            [s.id, I, s.first.keyId, who.principalType, s.first.principalId, s.first.onBehalfOf, who.personId, channel, who.keyKind, who.clientKind,
             ts(s.startedAt), ts(s.lastAt), who.isTest, who.testReason, OUTCOMES_ALGO]);
        } else {
          await audit.query("UPDATE caller_sessions SET last_at = GREATEST(last_at, $2), built_at = now() WHERE session_id = $1", [s.id, ts(s.lastAt)]);
        }
      }
    },
    async ctl(keyIds, personIds, serviceIds) {
      const [k, p, s] = await Promise.all([
        keyIds.length ? control.query("SELECT id, kind, auth_method, client_kind FROM api_keys WHERE id = ANY($1::uuid[])", [keyIds]) : { rows: [] },
        personIds.length ? control.query("SELECT id, login, attrs FROM people WHERE id = ANY($1::uuid[])", [personIds]) : { rows: [] },
        serviceIds.length ? control.query(
          `SELECT s.id, (EXISTS (SELECT 1 FROM test_purge_marks m WHERE m.kind = 'service' AND m.target_id = s.id) OR tp_run_label(s.instance_id, s.name)) AS marked
             FROM services s WHERE s.id = ANY($1::uuid[])`, [serviceIds]) : { rows: [] },
      ]);
      return { keys: new Map(k.rows.map((x: any) => [x.id, { kind: x.kind, authMethod: x.auth_method ?? null, clientKind: x.client_kind ?? null }])),
               people: new Map(p.rows.map((x: any) => [x.id, { login: x.login, attrs: x.attrs ?? {} }])),
               services: new Map(s.rows.map((x: any) => [x.id, { marked: x.marked === true }])) };
    },
    async locators(ids) {
      if (!ids.length) return new Map();
      const r = await control.query("SELECT record_id, type, created_at, owner_id FROM record_locations WHERE record_id = ANY($1::uuid[])", [ids]);
      return new Map(r.rows.map((x: any) => [x.record_id, { type: x.type, createdAt: ms(x.created_at), ownerId: x.owner_id ?? null }]));
    },
    async context(actors, keyIds, from, to) {
      const principals = uniq(actors.map((a) => a.principalId).filter((x): x is string => !!x));
      const r = await audit.query(
        `SELECT ${EV_COLS} FROM audit_events WHERE instance_id = $1 AND principal_id = ANY($2::uuid[]) AND at >= $3 AND at < $4
            AND key_id = ANY($6::uuid[])
         UNION ALL
         SELECT ${EV_COLS} FROM audit_events WHERE instance_id = $1 AND event_type = 'read' AND at >= $3 AND at < $4
            AND details->>'op' = 'original_download' AND details->>'key_id' = ANY($5::text[])
         ORDER BY at, id`, [I, principals, ts(from), ts(to), keyIds, uniq(actors.map((a) => a.keyId).filter(Boolean))]);
      const want = new Set(actors.map((a) => `${a.keyId}|${a.principalId ?? "-"}|${a.onBehalfOf ?? "-"}`));
      return r.rows.map(evOf).filter((e) => e.details.op === "original_download" || want.has(actorOf(e)));
    },
    async searchEvents(ids) {
      const out = new Map<string, Ev>();
      for (const id of uniq(ids)) {
        if (!/^[0-9a-f-]{36}$/i.test(id)) continue;
        const t = uuidV7Ms(id);
        let r = t === null ? null : (await audit.query(
          `SELECT ${EV_COLS} FROM audit_events WHERE id = $1 AND instance_id = $2 AND event_type = 'search' AND at >= $3 AND at < $4 LIMIT 1`,
          [id, I, ts(t - SKEW_MS), ts(t + SKEW_MS)])).rows[0];
        if (!r) r = (await audit.query(`SELECT ${EV_COLS} FROM audit_events WHERE id = $1 AND instance_id = $2 AND event_type = 'search' LIMIT 1`, [id, I])).rows[0];
        if (r) out.set(id, evOf(r));
      }
      return out;
    },
    async prevSearch(actor, before, tNow) {
      const r = (await audit.query(
        `SELECT o.search_event_id, o.at, o.continuation_of, o.session_id, o.mode, e.query_text, e.filters
           FROM search_outcomes o LEFT JOIN audit_events e ON e.id = o.search_event_id AND e.at = o.at
          WHERE o.instance_id = $1 AND o.key_id = $2 AND o.principal_id IS NOT DISTINCT FROM $3 AND o.on_behalf_of IS NOT DISTINCT FROM $4
            AND o.channel <> 'workplace_auto' AND (o.at, o.search_event_id) < ($5::timestamptz, $6::uuid) AND o.search_event_id <> $6::uuid
          ORDER BY o.at DESC, o.search_event_id DESC LIMIT 1`,
        [I, actor.keyId, actor.principalId, actor.onBehalfOf, ts(before.at), before.id])).rows[0];
      if (!r) return null;
      const at = ms(r.at);
      return { id: r.search_event_id, at, root: r.continuation_of ?? r.search_event_id, sessionId: r.session_id, mode: r.mode, filtersKey: filtersKey(r.filters),
               norm: normQuery(r.query_text), textKnown: r.query_text !== null || at > tNow - TEXT_KNOWN_MS };
    },
    async rows(ids) {
      if (!ids.length) return new Map();
      const r = await audit.query("SELECT * FROM search_outcomes WHERE search_event_id = ANY($1::uuid[])", [ids]);
      return new Map(r.rows.map((x: any) => [x.search_event_id, rowOf(x)]));
    },
    async upsertRows(rows) {
      if (!rows.length) return;
      const cols = ROW_COLS.map(([k]) => k);
      const json = rows.map((r) => ({ ...r, at: ts(r.at), session_started_at: ts(r.session_started_at) }));
      await audit.query(
        `INSERT INTO search_outcomes (${cols.join(", ")}, built_at)
         SELECT ${cols.join(", ")}, now() FROM jsonb_to_recordset($1::jsonb) AS x(${ROW_COLS.map(([k, t]) => `${k} ${t}`).join(", ")})
         ON CONFLICT (search_event_id) DO UPDATE SET ${cols.filter((c) => c !== "search_event_id").map((c) => `${c} = EXCLUDED.${c}`).join(", ")}, built_at = now()`,
        [JSON.stringify(json)]);
    },
    async sessionRollout(ids) {
      if (!ids.length) return new Map();
      const r = await audit.query(
        `SELECT o.session_id, min(o.session_started_at) AS started_at, ${ROLLOUT_SESSION_FLAGS}
           FROM search_outcomes o WHERE o.instance_id = $1 AND o.session_id = ANY($2::uuid[]) GROUP BY o.session_id`, [I, ids]);
      return new Map(r.rows.map((x: any) => [x.session_id, { sig: [x.q, x.fp, x.rp, x.fc, x.ov].join(","), startedAt: ms(x.started_at) }]));
    },
    async flagTargets(recs, from, to) {
      const r = await audit.query(
        `SELECT * FROM search_outcomes WHERE instance_id = $1 AND at >= $2 AND at <= $3 AND hit_ids[1:10] && $4::uuid[]`,
        [I, ts(from), ts(to), recs]);
      return r.rows.map(rowOf);
    },
    async correctionRecords(cids, from, to) {
      const r = await audit.query(
        `SELECT DISTINCT unnest(record_ids) AS id FROM audit_events WHERE instance_id = $1 AND event_type = 'write' AND at >= $2 AND at <= $3
            AND details->>'op' = 'correct' AND details->>'correction_id' = ANY($4::text[])`,
        [I, ts(from), ts(to), cids]);
      return r.rows.map((x: any) => x.id);
    },
    async flagEvents(recs, from, to) {
      const r = await audit.query(
        `SELECT ${EV_COLS} FROM audit_events WHERE instance_id = $1 AND event_type IN ('write','confirmation') AND at >= $2 AND at < $3
            AND details->>'op' = ANY($4::text[]) AND (record_ids && $5::uuid[] OR details->>'op' IN ('correct_withdraw','correct_reject'))
          ORDER BY at, id`,
        [I, ts(from), ts(to), ["correct", "correct_withdraw", "correct_reject", "org_wrong", "org_useful"], recs]);
      return r.rows.map(evOf);
    },
    async unsettled(maxAt, limit) {
      const r = await audit.query("SELECT * FROM search_outcomes WHERE instance_id = $1 AND NOT settled AND at <= $2 ORDER BY at LIMIT $3",
        [I, ts(maxAt), limit]);
      return r.rows.map(rowOf);
    },
    async testPeople() {
      const r = await control.query(
        `SELECT p.id, CASE WHEN ${showcaseSql("p")} THEN 'demo' ELSE 'test_login' END AS reason FROM people p
          WHERE p.instance_id = $1 AND (${testLoginSql("p")} OR ${showcaseSql("p")})`, [I]);
      return new Map(r.rows.map((x: any) => [x.id, x.reason as TestReason]));
    },
    async markTest(people) {
      const ids = [...people.keys()], reasons = ids.map((id) => people.get(id)!);
      const r = await audit.query(
        `WITH o AS (UPDATE search_outcomes o SET is_test = true, test_reason = x.reason, built_at = now()
                      FROM unnest($2::uuid[], $3::text[]) AS x(id, reason)
                     WHERE o.instance_id = $1 AND NOT o.is_test AND o.person_id = x.id RETURNING o.at),
              c AS (UPDATE caller_sessions c SET is_test = true, test_reason = x.reason, built_at = now()
                      FROM unnest($2::uuid[], $3::text[]) AS x(id, reason)
                     WHERE c.instance_id = $1 AND NOT c.is_test AND c.person_id = x.id RETURNING c.started_at AS at)
         SELECT at FROM o UNION ALL SELECT at FROM c`, [I, ids, reasons]);
      return r.rows.map((x: any) => ms(x.at));
    },
    async weekRows() {
      const r = await audit.query("SELECT week_start::text AS week_start, include_test, current, complete, people FROM search_outcomes_weeks WHERE instance_id = $1", [I]);
      return r.rows;
    },
    async missingWeeks(lastFinished) {
      const r = await audit.query(
        `WITH b AS (SELECT LEAST((SELECT min(at) FROM search_outcomes WHERE instance_id = $1),
                                 (SELECT min(started_at) FROM caller_sessions WHERE instance_id = $1)) AS lo)
         SELECT g::date::text AS w FROM b, generate_series(date_trunc('week', (b.lo AT TIME ZONE $2)), $3::date::timestamp, interval '7 days') g
          WHERE b.lo IS NOT NULL AND NOT EXISTS (SELECT 1 FROM search_outcomes_weeks k WHERE k.instance_id = $1 AND k.week_start = g::date AND NOT k.include_test)`,
        [I, tz, lastFinished]);
      return r.rows.map((x: any) => x.w);
    },
    async computeWeek(w, rulesChangedAt, complete) {
      const q = (await audit.query(WEEK_QUALITY_SQL, [I, w.weekStart, tz, w.includeTest])).rows[0];
      const ro = (await audit.query(WEEK_ROLLOUT_SQL, [I, w.weekStart, tz, w.includeTest])).rows[0];
      const quality: WeekQuality = Object.fromEntries(Object.entries(q).map(([k, v]) => [k, Number(v ?? 0)])) as unknown as WeekQuality;
      const rollout = { sessions: { total: Number(ro.total), people: Number(ro.people), with_query: Number(ro.with_query), found_past_by_query: Number(ro.found_past_by_query),
                                    read_past: Number(ro.read_past), found_colleague_notes: Number(ro.found_colleague_notes), overview_found_past: Number(ro.overview_found_past) },
                        open_check: { agent_notes: Number(ro.agent_notes), agent_refused: Number(ro.agent_refused), agent_saved_closed: Number(ro.agent_saved_closed),
                                      other_by_via: ro.other_by_via ?? {} } };
      const from = zonedMidnight(w.weekStart, tz), to = zonedMidnight(addDays(w.weekStart, 7), tz);
      const rules = rulesChangedAt !== null && rulesChangedAt >= from && rulesChangedAt < to;
      await audit.query(
        `INSERT INTO search_outcomes_weeks (instance_id, week_start, include_test, current, people, quality, rollout, complete, rules_changed, algo, computed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
         ON CONFLICT (instance_id, week_start, include_test) DO UPDATE SET current = EXCLUDED.current, people = EXCLUDED.people, quality = EXCLUDED.quality,
           rollout = EXCLUDED.rollout, complete = EXCLUDED.complete, rules_changed = search_outcomes_weeks.rules_changed OR EXCLUDED.rules_changed,
           algo = EXCLUDED.algo, computed_at = now()`,
        [I, w.weekStart, w.includeTest, w.current, quality.people, JSON.stringify(quality), JSON.stringify(rollout), complete, rules, OUTCOMES_ALGO]);
      return { people: quality.people };
    },
    async sliceValues(weeks, includeTest) {
      const out = {} as Record<SliceDim, SliceValue[]>;
      for (const d of SLICE_DIMS) {
        const r = await audit.query(sliceSql(d), [I, weeks, tz, includeTest]);
        out[d] = r.rows.map((x: any) => ({ value: String(x.value), people: Number(x.people), searches: Number(x.searches), zero: Number(x.zero), read3: Number(x.read3),
                                           no_read: Number(x.no_read), person_ids: x.person_ids ?? [] }));
      }
      return out;
    },
  };
}

const CHAINS_SQL = (weekCond: string) => `
  r AS (SELECT COALESCE(o.continuation_of, o.search_event_id) AS root_id,
               o.continuation_of IS NULL AND ${weekCond} AND o.has_query AND o.channel IN ('agent','workplace') AND ($4::boolean OR NOT o.is_test) AS is_root,
               o.person_id, o.zero_result, o.result_count, o.corrected_ids, o.outdated_ids, o.useful_ids, o.channel, o.mode, o.key_kind, o.client_kind,
               o.closed_seen, o.first_read_rank, o.reads_followup, o.reformulated, o.wrote_after, o.reads_explicit, o.reads_heuristic
          FROM search_outcomes o, b WHERE o.instance_id = $1 AND o.at >= b.f AND o.at < b.t + interval '1 day'),
  ch AS (
    SELECT root_id AS search_event_id, (array_agg(person_id) FILTER (WHERE is_root))[1] AS person_id, bool_or(zero_result) FILTER (WHERE is_root) AS zero_result,
           max(LEAST(result_count, 10)) FILTER (WHERE is_root) AS top10, max(cardinality(corrected_ids)) FILTER (WHERE is_root) AS c,
           max(cardinality(outdated_ids)) FILTER (WHERE is_root) AS o, max(cardinality(useful_ids)) FILTER (WHERE is_root) AS u,
           max(channel) FILTER (WHERE is_root) AS channel, max(mode) FILTER (WHERE is_root) AS mode, max(key_kind) FILTER (WHERE is_root) AS key_kind,
           max(client_kind) FILTER (WHERE is_root) AS client_kind, bool_or(closed_seen) FILTER (WHERE is_root) AS closed_seen,
           min(first_read_rank) AS first_rank, bool_or(reads_followup > 0) AS followup, bool_or(reformulated) AS reform, bool_or(wrote_after) AS wrote,
           sum(reads_explicit) AS expl, sum(reads_heuristic) AS heur
      FROM r GROUP BY root_id HAVING bool_or(is_root))`;

export const WEEK_QUALITY_SQL = `
  WITH b AS (SELECT ($2::date::timestamp AT TIME ZONE $3) AS f, (($2::date + 7)::timestamp AT TIME ZONE $3) AS t),
  ${CHAINS_SQL("o.at >= b.f AND o.at < b.t")}
  SELECT count(*) AS chains, count(DISTINCT person_id) AS people, count(*) FILTER (WHERE zero_result) AS zero,
         count(*) FILTER (WHERE first_rank <= 1) AS read1, count(*) FILTER (WHERE first_rank <= 3) AS read3, count(*) FILTER (WHERE first_rank <= 10) AS read10,
         count(*) FILTER (WHERE first_rank IS NULL AND NOT COALESCE(followup, false)) AS no_read,
         count(*) FILTER (WHERE reform) AS reform_true, count(*) FILTER (WHERE reform IS NOT NULL) AS reform_known, count(*) FILTER (WHERE wrote) AS wrote_after,
         COALESCE(sum(first_rank), 0) AS first_rank_sum, count(first_rank) AS first_rank_n, COALESCE(sum(expl), 0) AS explicit, COALESCE(sum(heur), 0) AS heuristic,
         COALESCE(sum(c), 0) AS corrected, COALESCE(sum(o), 0) AS outdated, COALESCE(sum(u), 0) AS useful, COALESCE(sum(top10), 0) AS top10
    FROM ch`;

export function sliceSql(dim: SliceDim): string {
  const value = dim === "client_kind" ? "COALESCE(client_kind, 'none')" : dim === "closed_seen" ? "CASE WHEN closed_seen THEN 'closed' ELSE 'open' END" : dim;
  return `
  WITH b AS (SELECT (min(w)::timestamp AT TIME ZONE $3) AS f, ((max(w) + 7)::timestamp AT TIME ZONE $3) AS t FROM unnest($2::date[]) w),
  ${CHAINS_SQL("date_trunc('week', o.at AT TIME ZONE $3)::date = ANY($2::date[])")}
  SELECT ${value} AS value, count(*) AS searches, count(DISTINCT person_id) AS people, count(*) FILTER (WHERE zero_result) AS zero,
         count(*) FILTER (WHERE first_rank <= 3) AS read3, count(*) FILTER (WHERE first_rank IS NULL AND NOT COALESCE(followup, false)) AS no_read,
         COALESCE(array_agg(DISTINCT person_id) FILTER (WHERE person_id IS NOT NULL), '{}') AS person_ids
    FROM ch GROUP BY 1`;
}

export const ROLLOUT_SESSION_FLAGS = `bool_or(o.has_query) AS q, bool_or(o.has_query AND o.past_notes > 0) AS fp, bool_or(o.has_query AND o.past_note_read) AS rp,
                bool_or(o.has_query AND o.past_notes_others > 0) AS fc, bool_or(NOT o.has_query AND o.past_notes > 0) AS ov`;

export const WEEK_ROLLOUT_SQL = `
  WITH b AS (SELECT ($2::date::timestamp AT TIME ZONE $3) AS f, (($2::date + 7)::timestamp AT TIME ZONE $3) AS t),
  s AS (SELECT c.session_id, c.person_id FROM caller_sessions c, b
         WHERE c.instance_id = $1 AND c.channel = 'agent' AND c.started_at >= b.f AND c.started_at < b.t AND ($4::boolean OR NOT c.is_test)),
  sx AS (SELECT s.session_id, s.person_id,
                ${ROLLOUT_SESSION_FLAGS}
           FROM s LEFT JOIN search_outcomes o ON o.session_id = s.session_id GROUP BY s.session_id, s.person_id),
  ev AS (SELECT e.event_type, e.details, COALESCE(e.details->>'session', '') = 'true' OR e.principal_type = 'system' AS not_agent,
                COALESCE((SELECT cs.is_test FROM caller_sessions cs
                           WHERE cs.instance_id = e.instance_id AND cs.key_id = e.key_id AND cs.principal_id IS NOT DISTINCT FROM e.principal_id
                             AND cs.on_behalf_of IS NOT DISTINCT FROM e.on_behalf_of AND cs.started_at <= e.at AND cs.last_at >= e.at
                           ORDER BY cs.last_at LIMIT 1), false) AS test
           FROM audit_events e, b
          WHERE e.instance_id = $1 AND e.event_type IN ('write','processing') AND e.at >= b.f AND e.at < b.t
            AND (e.details->>'type' = 'note' OR e.details->>'op' IN ('open_check_refused','open_check_fallback'))),
  evx AS (SELECT * FROM ev WHERE $4::boolean OR NOT test),
  vias AS (SELECT COALESCE(details->>'check_via', details->>'via', '?') AS via, count(*)::int AS n FROM evx
            WHERE details->>'op' IN ('open_check_refused','open_check_fallback')
              AND NOT (NOT not_agent AND event_type = 'write' AND COALESCE(details->>'check_via', details->>'via') = 'remember')
            GROUP BY 1)
  SELECT (SELECT count(*) FROM sx) AS total, (SELECT count(DISTINCT person_id) FROM sx) AS people,
         (SELECT count(*) FILTER (WHERE q) FROM sx) AS with_query, (SELECT count(*) FILTER (WHERE fp) FROM sx) AS found_past_by_query,
         (SELECT count(*) FILTER (WHERE rp) FROM sx) AS read_past, (SELECT count(*) FILTER (WHERE fc) FROM sx) AS found_colleague_notes,
         (SELECT count(*) FILTER (WHERE ov) FROM sx) AS overview_found_past,
         (SELECT count(*) FROM evx WHERE event_type = 'write' AND NOT not_agent AND details->>'type' = 'note'
                                    AND (details->>'op' IS NULL OR details->>'op' = 'open_check_fallback')) AS agent_notes,
         (SELECT count(*) FROM evx WHERE event_type = 'write' AND NOT not_agent AND details->>'op' = 'open_check_refused' AND details->>'via' = 'remember') AS agent_refused,
         (SELECT count(*) FROM evx WHERE event_type = 'write' AND NOT not_agent AND details->>'op' = 'open_check_fallback' AND details->>'check_via' = 'remember') AS agent_saved_closed,
         (SELECT COALESCE(jsonb_object_agg(via, n), '{}'::jsonb) FROM vias) AS other_by_via`;

export async function outcomesBuild(ctx: DbCtx, maint: pg.Pool, opts: PassOpts = {}): Promise<PassResult | { busy: true }> {
  const lock = await ctx.db.control.connect();
  let clean = false;
  try {
    const ok = (await lock.query(`SELECT pg_try_advisory_lock(${outcomesLockKeySql("$1")}) AS ok`, [ctx.instanceId])).rows[0]?.ok === true;
    if (!ok) { clean = true; log.info("outcomes_busy", { instance: ctx.instanceId }); return { busy: true }; }
    const watch = watchLock(lock);
    try {
      const client = await maint.connect();
      let broken: Error | undefined;
      try {
        await client.query(`SET statement_timeout = '${OUTCOMES_PASS.queryTimeout}'`);
        return await outcomesPass(pgStore(ctx, client, watch.alive), ctx.instanceId, opts);
      } catch (e) { broken = errorKind(e) === "infra" ? e as Error : undefined; throw e; }
      finally {
        if (!broken) await client.query("RESET statement_timeout").catch((e) => { broken = e as Error; });
        client.release(broken);
      }
    } finally {
      try {
        if (!watch.lost())
          await lock.query(`SELECT pg_advisory_unlock(${outcomesLockKeySql("$1")})`, [ctx.instanceId]).then(() => { clean = true; }, () => undefined);
        if (watch.lost()) {
          clean = false;
          log.warn("lock_connection_lost", { job: "outcomes_build" });
        }
      } finally { watch.done(); }
    }
  } finally { lock.release(!clean); }
}

export function parseOutcomesArgs(args: string[]): PassOpts {
  const o: PassOpts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--rebuild") o.rebuild = true;
    else if (a === "--allow-textless") o.allowTextless = true;
    else if (a === "--since") {
      const v = args[++i];
      const d = v ? new Date(v) : null;
      if (!d || Number.isNaN(d.getTime())) throw new Error("--since: expected an ISO 8601 date");
      o.since = d;
    } else throw new Error(`outcomes_build: unknown argument “${a}”`);
  }
  if (o.rebuild && !o.since) throw new Error("--rebuild requires --since");
  return o;
}

export async function outcomesRetention(maint: Pick<pg.Pool, "query">): Promise<Record<string, number>> {
  const parts: Array<[string, string]> = [
    ["search_outcomes", `at < now() - interval '${RETENTION}'`],
    ["caller_sessions", `last_at < now() - interval '${RETENTION}'`],
    ["search_outcomes_weeks", `week_start < (now() - interval '${RETENTION}')::date`],
    ["search_outcomes_state", `updated_at < now() - interval '${RETENTION}'`],
  ];
  const out: Record<string, number> = {};
  for (const [t, cond] of parts) {
    let n = 0;
    for (;;) {
      const r = await maint.query(`DELETE FROM ${t} WHERE ctid IN (SELECT ctid FROM ${t} WHERE ${cond} LIMIT 10000)`);
      n += r.rowCount ?? 0;
      if ((r.rowCount ?? 0) < 10000) break;
    }
    out[t] = n;
  }
  return out;
}
