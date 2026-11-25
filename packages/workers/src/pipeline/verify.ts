/**
 * Prisma Memory · code check of extracted events — ports the reference Python implementation
 * («the LLM classifies — code decides»).
 *
 * The model gives events with a verbatim quote. Code:
 *   1. normalizes quote and transcript alike (NFKC, casefold, Cyrillic yo→ye, no combining marks, only letters
 *      and digits, single spaces);
 *   2. looks for the quote: a verbatim occurrence (any of them, preferably on word boundaries) → `exact`; else —
 *      the best word window with similarity ≥ threshold (0.9) → `fuzzy` (speech recognition slips; certainty
 *      drops to `inferred`); not found → the event is dropped;
 *   3. takes the event time from the found place in the transcript, not the model;
 *   4. checks enums and lengths, collapses duplicates (same kind, similar title, close time), cuts at the limit.
 *
 * The result — events ready to become `event` records, and drop statistics for `record_stages` /
 * `records.attrs.extraction` (what was dropped and why — visible to the admin, not lost silently).
 */
import { pipelineText } from "@memory/shared";
// The only bridge of the other port modules to the shared text core: no dependency back on the chunker.
export { pipelineText };
export const { normalize, NormalizedTranscript, findQuote, titleSimilar } = pipelineText;
export type Match = pipelineText.Match;
export type NormalizedTranscript = pipelineText.NormalizedTranscript;
type Segment = pipelineText.Segment;
const { pyLen, pyPrefix, pyStrip, pyTruthy, withDefaults } = pipelineText.pytext;

export const KINDS = ["decision", "action", "question_risk", "fact"] as const;
export type EventKind = (typeof KINDS)[number];

export type Certainty = "extracted" | "inferred" | "ambiguous";
export const CERTAINTY: Readonly<Record<Certainty, number>> = Object.freeze({ extracted: 0.9, inferred: 0.6, ambiguous: 0.3 });
export const CERTAINTY_RANK: Readonly<Record<Certainty, number>> = Object.freeze({ extracted: 2, inferred: 1, ambiguous: 0 });

export interface VerifyParams {
  /** word similarity for a fuzzy match */
  readonly fuzzyThreshold: number;
  /** event limit per transcript */
  readonly maxEvents: number;
  readonly dedupeTitleThreshold: number;
  /** the same decision repeated within 10 minutes is a duplicate */
  readonly dedupeWindowSec: number;
  readonly maxTitleChars: number;
  readonly maxQuoteChars: number;
}

export const DEFAULT_VERIFY_PARAMS: VerifyParams = Object.freeze({
  fuzzyThreshold: 0.9, maxEvents: 40, dedupeTitleThreshold: 0.8, dedupeWindowSec: 600.0, maxTitleChars: 100, maxQuoteChars: 600,
});

export function verifyParams(overrides: Partial<VerifyParams> = {}): VerifyParams {
  return Object.freeze(withDefaults(DEFAULT_VERIFY_PARAMS, overrides));
}

/** An entity mention as in the text; code links it to the registry. */
export interface Mention {
  text: string;
  kind?: string;
  [extra: string]: unknown;
}

/** An event of the model answer (`schemas/events-v4.json`): fields checked here, so loose types. */
export interface RawEvent {
  kind?: unknown;
  title?: unknown;
  statement?: unknown;
  quote?: unknown;
  actors?: unknown;
  mentions?: unknown;
  rationale?: unknown;
  alternatives?: unknown;
  due?: unknown;
  certainty?: unknown;
  [extra: string]: unknown;
}

export interface VerifiedEvent {
  kind: EventKind;
  title: string;
  statement: string;
  quote: string;
  timeFrom: number | null;
  timeTo: number | null;
  certainty: Certainty;
  confidence: number;
  match: "exact" | "fuzzy";
  actors: string[];
  mentions: Mention[];
  rationale: string | null;
  alternatives: string[];
  due: string | null;
}

/** Locator of an `event` record — keys as in `records.locator`. */
export function eventLocator(ev: Pick<VerifiedEvent, "timeFrom" | "timeTo">): { time_from?: number; time_to?: number } {
  const loc: { time_from?: number; time_to?: number } = {};
  if (ev.timeFrom !== null) loc.time_from = ev.timeFrom;
  if (ev.timeTo !== null) loc.time_to = ev.timeTo;
  return loc;
}

export type DropReason = "bad_kind" | "bad_fields" | "quote_not_found" | "duplicate" | "over_limit";

export interface DroppedEvent {
  reason: DropReason;
  title: string;
}

/** Drop statistics — keys as in `records.attrs.extraction`. */
export interface VerifyStats {
  input: number;
  exact: number;
  fuzzy: number;
  quote_not_found: number;
  bad_kind: number;
  bad_fields: number;
  duplicate: number;
  over_limit: number;
  kept: number;
  /**
   * How many quotes were not fuzzy-checked as the check term ran out: they are in quote_not_found too. The key exists
   * only when the term fired: the reference lacks it, and a usual check matches it word for word.
   */
  quote_check_timeout?: number;
}

export interface VerifyReport {
  kept: VerifiedEvent[];
  dropped: DroppedEvent[];
  stats: VerifyStats;
}

/** `(ev.get(name) or "").strip()`; a non-empty non-string is an error (the reference: AttributeError). */
function textField(ev: RawEvent, name: string): string {
  const v = ev[name];
  if (!pyTruthy(v)) return "";
  if (typeof v !== "string") throw new TypeError(`event: field ${name} must be a string`);
  return pyStrip(v);
}

/** `ev.get(name) or []`; a non-empty non-array is an error. */
function listField(ev: RawEvent, name: string): unknown[] {
  const v = ev[name];
  if (!pyTruthy(v)) return [];
  if (!Array.isArray(v)) throw new TypeError(`event: field ${name} must be an array`);
  return v;
}

function isCertainty(v: unknown): v is Certainty {
  return typeof v === "string" && Object.hasOwn(CERTAINTY, v);
}

function isMention(x: unknown): x is Mention {
  return typeof x === "object" && x !== null && !Array.isArray(x) && pyTruthy((x as Record<string, unknown>)["text"]);
}

const NO_TIME = 1e12;
const timeKey = (e: VerifiedEvent): number => (e.timeFrom !== null ? e.timeFrom : NO_TIME);
const cmpNumber = (x: number, y: number): number => (x < y ? -1 : x > y ? 1 : 0);

/**
 * Default term of the fuzzy quote check of one transcript for the events stage: a usual transcript fits
 * in under a second, a pathological one (repeated words) took tens of minutes in the shared worker process.
 */
export const QUOTE_CHECK_BUDGET_MS = 20_000;

export function verifyEvents(
  rawEvents: readonly RawEvent[], segments: readonly Segment[], params: VerifyParams = DEFAULT_VERIFY_PARAMS,
  o: { budgetMs?: number; now?: () => number } = {},
): VerifyReport {
  const nt = new NormalizedTranscript(segments);
  // one term for the whole check: no budgetMs — unbounded, as the reference (golden, prompt-lab)
  const clock = o.now ?? Date.now;
  const budget: pipelineText.QuoteBudget | undefined = o.budgetMs === undefined ? undefined : { deadline: clock() + o.budgetMs, now: clock, abandoned: 0 };
  const kept: VerifiedEvent[] = [];
  const dropped: DroppedEvent[] = [];
  const stats: VerifyStats = {
    input: rawEvents.length, exact: 0, fuzzy: 0, quote_not_found: 0, bad_kind: 0, bad_fields: 0, duplicate: 0, over_limit: 0, kept: 0,
  };

  for (const ev of rawEvents) {
    const title = textField(ev, "title");
    const kind = ev.kind;
    const quote = textField(ev, "quote");
    const statement = textField(ev, "statement");
    if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) {
      stats.bad_kind++;
      dropped.push({ reason: "bad_kind", title });
      continue;
    }
    if (!title || !statement || !quote || pyLen(quote) > params.maxQuoteChars) {
      stats.bad_fields++;
      dropped.push({ reason: "bad_fields", title });
      continue;
    }
    const abandonedBefore = budget?.abandoned ?? 0;
    const m = findQuote(quote, nt, budget ? { fuzzyThreshold: params.fuzzyThreshold, budget } : params);
    if (m === null) {
      if (budget && budget.abandoned > abandonedBefore) stats.quote_check_timeout = (stats.quote_check_timeout ?? 0) + 1;
      stats.quote_not_found++;
      dropped.push({ reason: "quote_not_found", title });
      continue;
    }
    let certainty: Certainty = isCertainty(ev.certainty) ? ev.certainty : "inferred";
    if (m.kind === "fuzzy" && CERTAINTY_RANK[certainty] > CERTAINTY_RANK.inferred) {
      certainty = "inferred"; // a fuzzy quote is not «extracted»
    }
    stats[m.kind]++;
    const [timeFrom, timeTo] = nt.timeRange(m.wordFrom, m.wordTo);
    kept.push({
      kind: kind as EventKind, title: pyPrefix(title, params.maxTitleChars), statement, quote,
      timeFrom, timeTo, certainty, confidence: CERTAINTY[certainty], match: m.kind,
      actors: listField(ev, "actors").filter((a): a is string => typeof a === "string"),
      mentions: listField(ev, "mentions").filter(isMention),
      rationale: pyTruthy(ev.rationale) ? (ev.rationale as string) : null,
      alternatives: listField(ev, "alternatives").filter(pyTruthy) as string[],
      due: pyTruthy(ev.due) ? (ev.due as string) : null,
    });
  }

  // duplicates: same kind, similar title, close time → the more certain one stays, mentions are merged
  let deduped: VerifiedEvent[] = [];
  for (const ev of kept) {
    const dupAt = deduped.findIndex((d) =>
      d.kind === ev.kind && titleSimilar(d.title, ev.title, params.dedupeTitleThreshold) &&
      (ev.timeFrom === null || d.timeFrom === null || Math.abs(ev.timeFrom - d.timeFrom) <= params.dedupeWindowSec));
    if (dupAt < 0) {
      deduped.push(ev);
      continue;
    }
    const dup = deduped[dupAt] as VerifiedEvent;
    const [winner, loser] = CERTAINTY_RANK[ev.certainty] > CERTAINTY_RANK[dup.certainty] ? [ev, dup] : [dup, ev];
    stats.duplicate++;
    dropped.push({ reason: "duplicate", title: loser.title }); // the dropped one
    for (const mnt of loser.mentions) {
      if (!winner.mentions.some((x) => normalize(mnt.text) === normalize(x.text))) winner.mentions.push(mnt);
    }
    for (const a of loser.actors) if (!winner.actors.includes(a)) winner.actors.push(a);
    if (winner === ev) deduped[dupAt] = ev;
  }

  // limit: by falling certainty, then by time; output in time order
  if (deduped.length > params.maxEvents) {
    const ranked = [...deduped].sort((x, y) =>
      cmpNumber(-CERTAINTY_RANK[x.certainty], -CERTAINTY_RANK[y.certainty]) || cmpNumber(timeKey(x), timeKey(y)));
    const cut = ranked.slice(params.maxEvents);
    for (const e of cut) {
      stats.over_limit++;
      dropped.push({ reason: "over_limit", title: e.title });
    }
    deduped = deduped.filter((e) => !cut.includes(e)); // by identity: equal by value are different events
  }
  deduped.sort((x, y) => cmpNumber(timeKey(x), timeKey(y)));
  stats.kept = deduped.length;
  return { kept: deduped, dropped, stats };
}
