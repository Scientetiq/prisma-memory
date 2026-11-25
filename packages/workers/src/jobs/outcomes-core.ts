// Search outcomes — pure functions of the job outcomes_build, no database: who searched and the test mark,
// what a read is, the caller's session, the «same question» chain, the link of a read to a result,
// a re-ask, «wrote after», past notes, the marks «corrected / outdated / useful», the snapshot on
// rebuild. Time is epoch milliseconds; actor events ascend by (at, id).
import { isShowcaseLogin, isTestDomainLogin, normQuery, type OutcomesSettings } from "@memory/shared";

/** Build rules version: a change — a new snapshot on rebuild (mergeSnapshot), rows are rebuilt by --rebuild. */
export const OUTCOMES_ALGO = 1;
export const DAY_MS = 86_400_000;
/** Window of the marks «corrected / outdated / useful» after a search. */
export const FLAGS_WINDOW_MS = 7 * DAY_MS;
/** Explicit link limit (gateway SEARCH_LINK_MAX_AGE_MS): a late link rebuilds the search from a day's journal. */
export const LATE_LINK_MS = DAY_MS;
/** Query text is cleared after 90 days; a day of margin — rows older than 89 days with empty text count as «text unknown». */
export const TEXT_KNOWN_MS = 89 * DAY_MS;
/** Returned ids a row keeps (a whole search answer — up to 50). */
export const HIT_IDS_MAX = 50;

/** Event types the caller's session is counted by. */
export const SESSION_TYPES = ["search", "read", "extended_key_use", "list", "write", "confirmation", "promote", "forget", "open", "directory"] as const;

export interface Ev {
  id: string;
  at: number;
  type: string;
  keyId: string | null;
  principalType: string | null;
  principalId: string | null;
  onBehalfOf: string | null;
  recordIds: string[];
  queryText: string | null;
  filters: unknown;
  resultCount: number | null;
  details: Record<string, unknown>;
  cls: string | null;
}

export interface KeyInfo { kind: string; authMethod: string | null; clientKind: string | null }
export interface PersonInfo { login: string; attrs: Record<string, unknown> | null }
/** The service is in control; marked — a final removal mark (test_purge_marks) or a run label (tp_run_label). */
export interface ServiceInfo { marked: boolean }
/** Control snapshot at build time. */
export interface Ctl { keys: Map<string, KeyInfo>; people: Map<string, PersonInfo>; services: Map<string, ServiceInfo> }

export type KeyKind = "personal" | "extended" | "connection" | "service" | "obo" | "session" | "unknown";
export type Channel = "agent" | "workplace" | "workplace_auto";
export type TestReason = "test_login" | "demo" | "removed" | "test_service";

export interface Who {
  principalType: "person" | "service";
  personId: string | null;
  keyKind: KeyKind;
  clientKind: string | null;
  isTest: boolean;
  testReason: TestReason | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** Whether an outcome or session is built from an event: not for a system principal, a preview or no key. */
export function buildable(e: Ev): boolean {
  return e.keyId !== null && (e.principalType === "person" || e.principalType === "service") && e.details.preview !== true;
}

/** Key kind: a session — by the event; else by api_keys; unknown — unknown. */
export function keyKindOf(e: Ev, ctl: Ctl): KeyKind {
  if (e.details.session === true) return "session";
  const k = e.keyId ? ctl.keys.get(e.keyId) : undefined;
  if (!k) return "unknown";
  if (k.authMethod === "oauth") return "connection";
  if (k.kind === "extended") return "extended";
  if (k.kind === "personal") return "personal";
  if (k.kind === "service") return e.onBehalfOf ? "obo" : "service";
  return "unknown";
}

function personTest(p: PersonInfo): TestReason | null {
  if (isShowcaseLogin(p.login) || String(p.attrs?.demo ?? "") === "true") return "demo";
  if (isTestDomainLogin(p.login)) return "test_login";
  return null;            // attrs.test without a test domain is not a test
}

/**
 * Who searched and test. Order of causes: removed → demo → test_login → test_service. null — no outcome is built
 * (system principal, preview, no key).
 */
export function classify(e: Ev, ctl: Ctl): Who | null {
  if (!buildable(e)) return null;
  const principalType = e.principalType as "person" | "service";
  const personId = e.onBehalfOf ?? (principalType === "person" ? e.principalId : null);
  const keyKind = keyKindOf(e, ctl);
  const key = keyKind === "session" ? undefined : ctl.keys.get(e.keyId!);
  const reasons: TestReason[] = [];
  const principalPerson = principalType === "person" && e.principalId ? ctl.people.get(e.principalId) : undefined;
  const service = principalType === "service" && e.principalId ? ctl.services.get(e.principalId) : undefined;
  const obo = e.onBehalfOf ? ctl.people.get(e.onBehalfOf) : undefined;
  const removed = (principalType === "person" && !principalPerson) || (principalType === "service" && !service)
    || (e.onBehalfOf !== null && !obo) || (keyKind !== "session" && !key);
  if (removed) reasons.push("removed");
  for (const p of [principalPerson, obo]) { const r = p ? personTest(p) : null; if (r) reasons.push(r); }
  if (service?.marked) reasons.push("test_service");
  const order: TestReason[] = ["removed", "demo", "test_login", "test_service"];
  const testReason = order.find((r) => reasons.includes(r)) ?? null;
  return { principalType, personId, keyKind, clientKind: key?.clientKind ?? null, isTest: testReason !== null, testReason };
}

/**
 * Search channel: workplace auto-search — strictly a session, recent, no text, filters with the key space and, besides
 * it, at most types («Recent records» of «Shared knowledge» without employee cards — {space, types}). «New» of a
 * person on the «Search» page with one space (and kinds) also sends archived: false — a person's search.
 */
export function channelOf(e: Ev): Channel {
  if (e.details.session !== true) return "agent";
  const f = e.filters !== null && typeof e.filters === "object" && !Array.isArray(e.filters) ? Object.keys(e.filters as object) : [];
  const auto = mode(e) === "recent" && !str(e.queryText?.trim()) && f.includes("space") && f.every((k) => k === "space" || k === "types");
  return auto ? "workplace_auto" : "workplace";
}

export const mode = (e: Ev): string => str(e.details.mode) ?? "hybrid";

/** A read: memory_read without op (including resources/read) or an original by link. */
export function isRead(e: Ev): boolean {
  if (e.type !== "read" && e.type !== "extended_key_use") return false;
  const op = e.details.op;
  if (op === "original_link" || op === "original_download") return true;
  return e.details.tool === "memory_read" && (op === undefined || op === null);
}

/** A new note: write with type = note, without op or with the fallback path of the open check. */
export function isNoteWrite(e: Ev): boolean {
  return e.type === "write" && e.details.type === "note" && (e.details.op === undefined || e.details.op === null || e.details.op === "open_check_fallback");
}

/** Event actor; an original downloaded by signature — only the details.key_id key (originals.ts). */
export function actorOf(e: Ev): string {
  if (e.details.op === "original_download") return `k:${str(e.details.key_id) ?? "-"}`;
  return `${e.keyId ?? "-"}|${e.principalId ?? "-"}|${e.onBehalfOf ?? "-"}`;
}

/** Event R belongs to the actor of search S (original download — by key). */
export function sameActor(s: Ev, r: Ev): boolean {
  if (r.details.op === "original_download") return s.keyId !== null && str(r.details.key_id) === s.keyId;
  return actorOf(s) === actorOf(r);
}

/**
 * The event counts into the caller's session. A list with closed data that the workplace page loaded itself
 * (`details.auto`, gateway auditShownClosed; the mark is only on a workplace session) is not the caller's action:
 * it neither starts nor extends sessions, else page loads would open «Adoption» sessions that were not there
 * before. The same list from an agent or service has no mark and counts like their other calls.
 */
export function isSessionEvent(e: Ev): boolean {
  return (SESSION_TYPES as readonly string[]).includes(e.type) && buildable(e) && e.details.auto !== true;
}

// ---------------------------------------------------------------- sessions

/** first — first event of a new session; null for a session from caller_sessions (its row exists, last_at extends). */
export interface SessionState { id: string; actor: string; startedAt: number; lastAt: number; first: Ev | null }

/**
 * Sessions by events in (at, id) order: a pause over gap starts a new one; `prev` — actor's last session in
 * caller_sessions. Returns the session of each event and all touched sessions (new and extended).
 */
export function sessionize(events: readonly Ev[], prev: ReadonlyMap<string, SessionState>, gapMs: number):
    { of: Map<string, SessionState>; touched: Map<string, SessionState> } {
  const cur = new Map<string, SessionState>(), of = new Map<string, SessionState>(), touched = new Map<string, SessionState>();
  for (const [a, s] of prev) cur.set(a, { ...s });
  for (const e of events) {
    if (!isSessionEvent(e)) continue;
    const a = actorOf(e);
    let s = cur.get(a);
    if (!s || e.at - s.lastAt > gapMs || e.at < s.startedAt) {
      // event before a known session's start (repeat after --rebuild with an earlier since) — own session
      s = { id: e.id, actor: a, startedAt: e.at, lastAt: e.at, first: e };
      cur.set(a, s);
    } else if (e.at > s.lastAt) s.lastAt = e.at;
    of.set(e.id, s);
    touched.set(s.id, s);
  }
  return { of, touched };
}

/** One session: all gaps between neighbouring actor events in [from, to] are at most gap. */
function sameSessionSpan(actorEvents: readonly Ev[], from: number, to: number, gapMs: number): boolean {
  let last = from;
  for (const e of actorEvents) {
    if (e.at <= from || e.at > to || !isSessionEvent(e)) continue;
    if (e.at - last > gapMs) return false;
    last = e.at;
  }
  return to - last <= gapMs;
}

// ---------------------------------------------------------------- outcome row

export interface Locator { type: string; createdAt: number; ownerId: string | null }

/** Actor's previous non-auto search: for the «same question» chain. */
export interface PrevSearch { id: string; at: number; root: string; sessionId: string; mode: string; filtersKey: string; norm: string | null; textKnown: boolean }

export interface OutcomeRow {
  search_event_id: string; at: number; instance_id: string; key_id: string | null; principal_type: "person" | "service";
  principal_id: string | null; on_behalf_of: string | null; person_id: string | null; key_kind: KeyKind; client_kind: string | null;
  channel: Channel; mode: string; has_query: boolean; has_filters: boolean; closed_seen: boolean; rerank: boolean | null;
  result_count: number; hit_ids: string[]; zero_result: boolean; continuation_of: string | null; position_offset: number;
  session_id: string; session_started_at: number; read_ranks: number[]; first_read_rank: number | null; reads_explicit: number;
  reads_heuristic: number; reads_followup: number; reformulated: boolean | null; wrote_after: boolean; past_notes: number;
  past_notes_others: number; past_note_read: boolean; corrected_ids: string[]; outdated_ids: string[]; useful_ids: string[];
  is_test: boolean; test_reason: TestReason | null; settled: boolean; algo: number;
}

export interface BuildInput {
  instanceId: string;
  search: Ev;
  who: Who;
  session: { id: string; startedAt: number };
  /** Actor's previous non-auto search (batch or search_outcomes); null — none. */
  prev: PrevSearch | null;
  /** Rebuild of a ready row (a late link, not settled): the chain stays as it was, not anew by the previous search. */
  chain?: { continuation_of: string | null; position_offset: number };
  /** Actor events after the search (and original downloads by its key) — the context window, ascending (at, id). */
  context: readonly Ev[];
  locators: ReadonlyMap<string, Locator>;
  settings: Pick<OutcomesSettings, "read_window_min" | "reformulate_window_sec" | "session_gap_min">;
  /** Moment of the first outcomes pass: workplace searches before it — with the heuristic. */
  workplaceExactSince: number | null;
  /** Journal database clock at the pass start — for «text known». */
  tNow: number;
  /**
   * Unverified-link reads (search_link = unverified) whose search_id is the same actor's search (checked by the pass
   * by the journal PK). Other unverified ones with a foreign or missing search_id go to the heuristic.
   */
  unverifiedMine?: ReadonlySet<string>;
  /** Settling by the usual rules: a row «settled» if at build tNow ≥ at + settle. */
  settleMs: number;
}

export interface Built { row: OutcomeRow; textKnown: boolean }

/** Filter key for comparing the chain: JSON with ordered keys. */
export function filtersKey(v: unknown): string {
  const norm = (x: unknown): unknown => Array.isArray(x) ? x.map(norm)
    : x !== null && typeof x === "object" ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, norm((x as Record<string, unknown>)[k])])) : x;
  return JSON.stringify(norm(v ?? {}));
}

export const textKnownOf = (e: Ev, tNow: number): boolean => e.queryText !== null || e.at > tNow - TEXT_KNOWN_MS;

/** Previous search for the actor's next search. */
export function prevOf(e: Ev, row: Pick<OutcomeRow, "continuation_of" | "session_id">, tNow: number): PrevSearch {
  return { id: e.id, at: e.at, root: row.continuation_of ?? e.id, sessionId: row.session_id, mode: mode(e), filtersKey: filtersKey(e.filters),
           norm: normQuery(e.queryText), textKnown: textKnownOf(e, tNow) };
}

const hasQuery = (e: Ev): boolean => normQuery(e.queryText) !== null;
const rankOf = (v: unknown): number | null | undefined => (v === null ? null : typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : undefined);

/** A read linked to a result explicitly (search_id with rank, including rank = null) — not left to the heuristic. */
function explicitTarget(r: Ev): string | null {
  const sid = str(r.details.search_id);
  if (!sid) return null;
  if ("rank" in r.details) return sid;
  return null;
}

/**
 * Outcome row by the search and the actor's context. Marks — separately, markFlags: their window is 7 days.
 */
export function buildOutcome(inp: BuildInput): Built {
  const s = inp.search, w = inp.who, rwMs = inp.settings.read_window_min * 60_000, rfMs = inp.settings.reformulate_window_sec * 1000;
  const gapMs = inp.settings.session_gap_min * 60_000;
  const hits = s.recordIds.slice(0, HIT_IDS_MAX);
  const channel = channelOf(s), m = mode(s), textKnown = textKnownOf(s, inp.tNow), norm = normQuery(s.queryText), fk = filtersKey(s.filters);
  const ctx = inp.context.filter((e) => e.id !== s.id && e.at >= s.at && (e.at > s.at || e.id > s.id || e.details.op === "original_download"));

  // the «same question» chain: same actor and session, mode, filters and text
  const p = inp.prev;
  const continuation = channel !== "workplace_auto" && p !== null && p.sessionId === inp.session.id && p.mode === m && p.filtersKey === fk
    && textKnown && p.textKnown && p.norm === norm;
  const excluded = typeof s.details.excluded === "number" && s.details.excluded > 0 ? Math.floor(s.details.excluded) : 0;
  const offset = inp.chain ? inp.chain.position_offset : continuation ? excluded : 0;

  // read links: exact → unverified check → heuristic; one read — at most one result
  // The context holds only actor events: an unverified read of another actor with this search_id stays out, it
  // is dropped and counted (unverified_dropped) by the read-event pass.
  const explicit = new Map<string, number>(), followup = new Set<string>(), heuristic = new Map<string, number>();
  const put = (m: Map<string, number>, rec: string, pos: number) => { if (!m.has(rec) || m.get(rec)! > pos) m.set(rec, pos); };
  const heuristicAllowed = channel === "agent" || (channel === "workplace" && inp.workplaceExactSince !== null && s.at < inp.workplaceExactSince);
  const actorSearches = ctx.filter((e) => e.type === "search" && sameActor(s, e) && buildable(e));
  for (const r of ctx) {
    if (!isRead(r) || !sameActor(s, r)) continue;
    const rec = r.recordIds[0];
    if (!rec) continue;
    const sid = str(r.details.search_id);
    if (sid === s.id && "rank" in r.details) {                                    // 1. exact (gateway-checked)
      const rank = rankOf(r.details.rank);
      if (rank === null) followup.add(rec);
      else if (rank !== undefined) put(explicit, rec, offset + rank);
      continue;
    }
    if (sid === s.id && r.details.search_link === "unverified") {                 // 2. offline: same actor
      const pos = hits.indexOf(rec);
      if (pos >= 0) put(explicit, rec, offset + pos + 1); else followup.add(rec);
      continue;
    }
    if (explicitTarget(r) !== null) continue;                                     // exact link to another result
    if (r.details.search_link === "unverified" && sid !== null && inp.unverifiedMine?.has(r.id)) continue;   // linked to another own result
    if (!heuristicAllowed || r.at - s.at > rwMs) continue;                        // 3. heuristic
    const pos = hits.indexOf(rec);
    if (pos < 0) continue;
    // candidate — actor's last non-auto search before the read with the record in its results
    const later = actorSearches.some((x) => x.at <= r.at && (x.at > s.at || (x.at === s.at && x.id > s.id)) && channelOf(x) !== "workplace_auto"
      && x.recordIds.slice(0, HIT_IDS_MAX).includes(rec));
    if (later) continue;
    put(heuristic, rec, offset + pos + 1);
  }
  for (const rec of explicit.keys()) { heuristic.delete(rec); followup.delete(rec); }
  for (const rec of heuristic.keys()) followup.delete(rec);
  const ranks = [...new Set([...explicit.values(), ...heuristic.values()])].sort((a, b) => a - b);

  // re-ask: the next search with text of the same channel, not a continuation, with no read between
  let reformulated: boolean | null = null;
  if (textKnown) {
    const next = actorSearches.find((x) => channelOf(x) === channel && hasQuery(x));
    if (!next) reformulated = false;
    else if (!textKnownOf(next, inp.tNow)) reformulated = null;
    else {
      const sameQuestion = mode(next) === m && filtersKey(next.filters) === fk && normQuery(next.queryText) === norm
        && sameSessionSpan(inp.context.filter((e) => sameActor(s, e)), s.at, next.at, gapMs);
      const readBetween = ctx.some((r) => isRead(r) && sameActor(s, r) && r.at < next.at);
      reformulated = next.at - s.at <= rfMs && !sameQuestion && !readBetween;
    }
  }

  // «wrote after»: an actor note in (S.at, S.at + window], and S is the actor's last search before it
  const wroteAfter = ctx.some((n) => isNoteWrite(n) && sameActor(s, n) && n.at > s.at && n.at - s.at <= rwMs
    && !actorSearches.some((x) => x.at < n.at && (x.at > s.at || (x.at === s.at && x.id > s.id))));

  // past notes: locator note, created before the session start
  const past = hits.filter((id) => { const l = inp.locators.get(id); return l?.type === "note" && l.createdAt < inp.session.startedAt; });
  const pastOthers = past.filter((id) => inp.locators.get(id)!.ownerId !== w.personId);
  const readRecs = new Set([...explicit.keys(), ...heuristic.keys(), ...followup]);

  const row: OutcomeRow = {
    search_event_id: s.id, at: s.at, instance_id: inp.instanceId, key_id: s.keyId, principal_type: w.principalType, principal_id: s.principalId,
    on_behalf_of: s.onBehalfOf, person_id: w.personId, key_kind: w.keyKind, client_kind: w.clientKind, channel, mode: m,
    has_query: norm !== null, has_filters: fk !== "{}", closed_seen: s.cls === "closed",
    rerank: typeof s.details.rerank === "boolean" ? s.details.rerank : null, result_count: s.resultCount ?? hits.length, hit_ids: hits,
    zero_result: (s.resultCount ?? hits.length) === 0,
    continuation_of: inp.chain ? inp.chain.continuation_of : continuation ? p!.root : null, position_offset: offset,
    session_id: inp.session.id, session_started_at: inp.session.startedAt, read_ranks: ranks, first_read_rank: ranks[0] ?? null,
    reads_explicit: explicit.size, reads_heuristic: heuristic.size, reads_followup: followup.size, reformulated, wrote_after: wroteAfter,
    past_notes: past.length, past_notes_others: pastOthers.length, past_note_read: past.some((id) => readRecs.has(id)),
    corrected_ids: [], outdated_ids: [], useful_ids: [], is_test: w.isTest, test_reason: w.testReason,
    settled: inp.tNow >= s.at + inp.settleMs, algo: OUTCOMES_ALGO,
  };
  return { row, textKnown };
}

/** Context window of a search batch: [minS, maxS + W) — each search's window lies wholly inside. */
export function contextWindow(searchAts: readonly number[], wMs: number): { from: number; to: number } | null {
  if (!searchAts.length) return null;
  return { from: Math.min(...searchAts), to: Math.max(...searchAts) + wMs };
}

// ---------------------------------------------------------------- marks

export const FLAG_OPS = ["correct", "correct_withdraw", "correct_reject", "org_wrong", "org_useful"] as const;
const WRONG_KINDS = new Set(["wrong", "extraction_error"]);

export interface Flags { corrected_ids: string[]; outdated_ids: string[]; useful_ids: string[] }

/**
 * Marks over the first 10 returned in [S.at, min(S.at + 7 d, hi)) wholly by events (idempotent): people's corrections
 * «wrong», «extraction error» and «Wrong» to a curator → corrected; «outdated» → outdated; «Useful» → useful.
 * A withdrawn or rejected correction (same correction_id in the window) does not count; own_note, agent origin — never.
 */
export function markFlags(hitIds: readonly string[], at: number, events: readonly Ev[], hi: number): Flags {
  const top = new Set(hitIds.slice(0, 10)), end = Math.min(at + FLAGS_WINDOW_MS, hi);
  const inWin = events.filter((e) => e.at >= at && e.at < end);
  const cancelled = new Set(inWin.filter((e) => e.details.op === "correct_withdraw" || e.details.op === "correct_reject")
    .map((e) => str(e.details.correction_id)).filter((x): x is string => x !== null));
  const corrected = new Set<string>(), outdated = new Set<string>(), useful = new Set<string>();
  for (const e of inWin) {
    const rec = e.recordIds[0];
    if (!rec || !top.has(rec)) continue;
    const op = e.details.op;
    if (e.type === "write" && op === "correct" && e.details.origin === "human") {
      const cid = str(e.details.correction_id);
      if (cid && cancelled.has(cid)) continue;
      if (WRONG_KINDS.has(String(e.details.kind))) corrected.add(rec);
      else if (e.details.kind === "outdated") outdated.add(rec);
    } else if (e.type === "confirmation" && op === "org_wrong") corrected.add(rec);
    else if (e.type === "confirmation" && op === "org_useful") useful.add(rec);
  }
  const sorted = (x: Set<string>) => [...x].sort();
  return { corrected_ids: sorted(corrected), outdated_ids: sorted(outdated), useful_ids: sorted(useful) };
}

/** A batch event changes someone's outcome marks. */
export function isFlagEvent(e: Ev): boolean {
  return (e.type === "write" || e.type === "confirmation") && (FLAG_OPS as readonly string[]).includes(String(e.details.op ?? ""));
}

// ---------------------------------------------------------------- snapshot

/**
 * Rebuild never worsens the snapshot: test is sticky, past notes — the max, key kind and program are kept, with
 * unknown text, chain and re-ask fields stay as they were. New algo — new snapshot.
 */
export function mergeSnapshot(old: OutcomeRow | null, fresh: OutcomeRow, freshTextKnown: boolean): OutcomeRow {
  if (!old || old.algo !== fresh.algo) return fresh;
  const out: OutcomeRow = { ...fresh };
  out.is_test = old.is_test || fresh.is_test;
  out.test_reason = out.is_test ? (old.is_test ? old.test_reason : fresh.test_reason) : null;
  out.past_notes = Math.max(old.past_notes, fresh.past_notes);
  out.past_notes_others = Math.max(old.past_notes_others, fresh.past_notes_others);
  out.past_note_read = old.past_note_read || fresh.past_note_read;
  if (fresh.key_kind === "unknown" && old.key_kind !== "unknown") out.key_kind = old.key_kind;
  if (fresh.client_kind === null) out.client_kind = old.client_kind;
  if (!freshTextKnown) {
    out.continuation_of = old.continuation_of;
    out.position_offset = old.position_offset;
    out.reformulated = old.reformulated;
    out.has_query = old.has_query;
    out.channel = old.channel;
  }
  return out;
}

/** Row journal fields (compared byte for byte after --rebuild). */
export const JOURNAL_FIELDS = ["read_ranks", "first_read_rank", "reads_explicit", "reads_heuristic", "reads_followup", "wrote_after",
  "corrected_ids", "outdated_ids", "useful_ids", "hit_ids", "zero_result", "result_count", "session_id", "session_started_at"] as const;
