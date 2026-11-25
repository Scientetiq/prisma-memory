// Pure ranking formulas of memory_search; the visibility check stays in search.ts.
import type { RecordRow } from "./access.ts";
import { RETRIEVAL_TUNING_DEFAULT, type RetrievalTuning } from "@memory/shared";

type FusionTuning = Pick<RetrievalTuning, "candidates" | "title_candidates" | "rrf_k" | "w_keyword" | "w_vector" | "w_title">;

/**
 * Tie-break step of the ranking without a reranker: it must stay below the smallest gap between two neighbouring
 * ranks of one list, w / ((k + n)(k + n + 1)) at the last rank n, so the boosts reorder only equal RRF values. It follows
 * retrieval.tuning (k, the longest list, the smallest weight); with the defaults it is the former 1 / (210 · 211).
 */
export function rrfTieStep(t: FusionTuning): number {
  const n = Math.max(t.candidates, t.title_candidates);
  return Math.min(t.w_keyword, t.w_vector, t.w_title) / ((t.rrf_k + n) * (t.rrf_k + n + 1));
}
export const RRF_TIE_STEP = rrfTieStep(RETRIEVAL_TUNING_DEFAULT);

/**
 * Reciprocal rank fusion of one data class (k and the weights from retrieval.tuning): the keyword and the vector
 * list add w / (k + rank) per chunk, a record is represented by its best chunk; a title hit adds w_title / (k + rank) to
 * the record itself (a record without a chunk in the two lists is represented by the title candidate). With weight 1 every
 * addend is the former 1 / (k + rank), bit for bit.
 */
export function fuseCandidates<C extends { chunk_id: string; record_id: string }>(
  lists: { keyword: readonly C[]; vector: readonly C[]; title: readonly C[] }, t: Pick<RetrievalTuning, "rrf_k" | "w_keyword" | "w_vector" | "w_title">,
): Map<string, { cand: C; rrf: number }> {
  const best = new Map<string, { cand: C; rrf: number }>();
  const byChunk = new Map<string, { cand: C; rrf: number }>();
  for (const [list, w] of [[lists.keyword, t.w_keyword], [lists.vector, t.w_vector]] as const) list.forEach((cand, i) => {
    const cur = byChunk.get(cand.chunk_id) ?? { cand, rrf: 0 };
    cur.rrf += w / (t.rrf_k + i + 1);
    byChunk.set(cand.chunk_id, cur);
  });
  for (const v of byChunk.values()) { const cur = best.get(v.cand.record_id); if (!cur || v.rrf > cur.rrf) best.set(v.cand.record_id, v); }
  // a title match is a score of the record, not of its first chunk: otherwise the head of a document pushed out the chunk
  // with the real match and the snippet showed the title instead of the answer
  lists.title.forEach((cand, i) => {
    const cur = best.get(cand.record_id);
    if (cur) cur.rrf += t.w_title / (t.rrf_k + i + 1); else best.set(cand.record_id, { cand, rrf: t.w_title / (t.rrf_k + i + 1) });
  });
  return best;
}

export interface Rankable {
  rec: Pick<RecordRow, "id" | "parent_id" | "owner_id" | "title" | "confirmed_at" | "occurred_at">;
  rrf: number;
  score: number;
  /** Only the membership of an already visible record; computed after the access gates. */
  inCurrent?: boolean;
  /**
   * The "not confirmed" factor O of a "Company shared knowledge" record (`search.org_unreviewed_factor`): for
   * an unconfirmed and a held one — the setting's value (< 1), for others — none (1).
   */
  orgFactor?: number;
  /** "Confirmed" of an org record with a check row: only confirmed and community; else confirmed_at. */
  confirmed?: boolean;
  /**
   * The retelling factor D (`search.derivation_factor`): only with `search.derivation_order_enabled` on and
   * only for a declared retelling; else no field (1) — scores and order are byte for byte as before.
   */
  derivationFactor?: number;
}
export type Boosts = Record<string, number>;
export interface RerankPool<T> { top: T[]; rest: T[] }
export interface RankingOptions<T> {
  mode: "hybrid" | "semantic" | "keyword" | "recent";
  boosts: Boosts;
  words: readonly string[];
  me: string | null;
  nowMs: number;
  /** A missing resolved current_space is passed as no boost (factor 1). */
  boost?: number;
  rerank?: RerankPool<T> & { scores: ReadonlyArray<{ index: number; score: number }> };
  /** Tie-break step without a reranker (rrfTieStep of retrieval.tuning); absent — the step of the defaults. */
  tieStep?: number;
}

/** The old generic boosts, with the time passed explicitly for reproducibility. */
export function generic(s: Rankable, b: Boosts, words: readonly string[], me: string | null, nowMs: number): number {
  let m = 1;
  if (s.confirmed ?? !!s.rec.confirmed_at) m *= b.confirmed ?? 1;     // the "confirmed" boost does not apply to an unconfirmed org one
  if (s.rec.owner_id === me) m *= b.own_space ?? 1;
  const title = (s.rec.title ?? "").toLowerCase();
  if (words.some((w) => title.includes(w))) m *= b.title_match ?? 1;
  const ageDays = (nowMs - new Date(s.rec.occurred_at).getTime()) / 86_400_000;
  m *= 1 + (b.recency_weight ?? 0) * Math.pow(0.5, Math.max(0, ageDays) / (b.recency_half_life_days ?? 180));
  return m;
}

export function maxGeneric(b: Boosts): number {
  return (b.confirmed ?? 1) * (b.own_space ?? 1) * (b.title_match ?? 1) * (1 + (b.recency_weight ?? 0));
}

/** The search.current_space_boost setting: 1 turns it off, a wrong value gives the seed 1.2. */
export function clampBoost(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) ? Math.max(1, Math.min(3, raw)) : 1.2;
}

export function spaceBoost(s: Rankable, boost = 1): number {
  return s.inCurrent ? clampBoost(boost) : 1;
}

/** Factor O: only 0.1–1; none — 1. */
export const orgFactorOf = (s: Rankable): number => (typeof s.orgFactor === "number" && s.orgFactor >= 0.1 && s.orgFactor <= 1 ? s.orgFactor : 1);
/** Factor D: only 0.1–1; none — 1. */
export const derivationFactorOf = (s: Rankable): number =>
  (typeof s.derivationFactor === "number" && s.derivationFactor >= 0.1 && s.derivationFactor <= 1 ? s.derivationFactor : 1);

/** RRF×B×O picks the reranker pool (else an unconfirmed one takes top places equally); the old limit of derivatives of one root stays. */
export function rerankPool<T extends Rankable>(scored: readonly T[], options: { limit: number; maxPerParent: number; boost?: number }): RerankPool<T> {
  const top: T[] = [], rest: T[] = [], perRoot = new Map<string, number>();
  const boost = clampBoost(options.boost ?? 1);
  const ordered = [...scored].sort((x, y) => y.rrf - x.rrf);
  ordered.sort((x, y) => y.rrf * spaceBoost(y, boost) * orgFactorOf(y) - x.rrf * spaceBoost(x, boost) * orgFactorOf(x));
  for (const s of ordered) {
    const root = s.rec.parent_id ?? s.rec.id, n = perRoot.get(root) ?? 0;
    if (top.length < options.limit && n < Math.max(1, options.maxPerParent)) {
      top.push(s); perRoot.set(root, n + 1);
    } else rest.push(s);
  }
  if (top.length < options.limit && rest.length > 0) {
    const openSlots = Math.ceil(options.limit - top.length);
    for (const s of rest.splice(0, openSlots)) top.push(s);
  }
  return { top, rest };
}

/** Returns new candidate wrappers; rec/cand and other fields of T are kept. */
export function finalScores<T extends Rankable>(scored: readonly T[], options: RankingOptions<T>): T[] {
  const copies = new Map(scored.map((s) => [s, { ...s }]));
  const out = scored.map((s) => copies.get(s)!).sort((x, y) => y.rrf - x.rrf);
  if (options.mode === "recent") {
    return out.sort((x, y) => new Date(y.rec.occurred_at).getTime() - new Date(x.rec.occurred_at).getTime());
  }
  const boost = clampBoost(options.boost ?? 1);
  // D (< 1) of a retelling — in the same product as O; without D (the switch off) — ×1, the scores as before
  const factor = (s: T) => generic(s, options.boosts, options.words, options.me, options.nowMs) * spaceBoost(s, boost) * orgFactorOf(s) * derivationFactorOf(s);
  if (options.rerank) {
    const { top, rest, scores } = options.rerank;
    const got = new Set<number>();
    for (const r of scores) if (top[r.index]) {
      copies.get(top[r.index]!)!.score = r.score * factor(top[r.index]!); got.add(r.index);
    }
    const floor = Math.min(...[...got].map((i) => copies.get(top[i]!)!.score));
    top.forEach((s, i) => { if (!got.has(i)) copies.get(s)!.score = floor * 0.999; });
    const weight = (s: T) => s.rrf * spaceBoost(s, boost) * orgFactorOf(s) * derivationFactorOf(s);
    const maxRest = rest.length ? Math.max(...rest.map(weight)) : 1;
    for (const s of rest) copies.get(s)!.score = floor * 0.999 * (weight(s) / maxRest);
  } else {
    // Without a reranker B goes only into the old bounded correction,
    // and does not multiply RRF. The common generic+current correction stays below the old RRF_TIE_STEP.
    // O (< 1) only breaks ties: the normalization (f − fmin)/(fmax − fmin), fmin — the smallest O of the output; without O
    // fmin = 1 and the formula is as before (different RRF values keep their order). D the same: fmin = min(1, min(O × D)).
    const maxFactor = maxGeneric(options.boosts) * boost;
    const fmin = Math.min(1, ...out.map((s) => orgFactorOf(s) * derivationFactorOf(s)));
    const step = options.tieStep ?? RRF_TIE_STEP;
    for (const s of out) s.score = s.rrf + step * 0.999 * Math.max(0, Math.min(1, (factor(s) - fmin) / Math.max(1e-9, maxFactor - fmin)));
  }
  return out.sort((x, y) => y.score - x.score);
}

/**
 * Reordering "source → retelling" and mixing a source into the output page —
 * only with the switch on and not in the recent mode (search.ts decides that). A pure function over ids:
 * - `ids` — the page by places (already after finalScores and the cut);
 * - `sources` — the visible sources of each retelling hit by priority;
 * - `inject` — for a retelling without a source on the page: which source to mix in (one that passed the whole prefilter of this
 *   output and its visibility rule) — or no record.
 * Top-down over the original page, each retelling R: the source is on the page (above or below) — R with the retellings attached
 * to it goes right after the source and those already attached to it; no source — the mixed-in source takes
 * R's place, R goes after it. Each retelling is moved at most once, each source is mixed in at most
 * once; a source inside R's own block (a loop in data) is not counted. The result is cut to `limit`: mixed-in sources
 * take places, the last ones leave; a mixed-in source whose retelling went past `limit` is removed from the page (the retelling
 * comes back from the tail). `injected` — the mixed-in sources left on the page (source → retelling).
 */
export function applyDerivationOrder(ids: readonly string[], sources: ReadonlyMap<string, readonly string[]>, inject: ReadonlyMap<string, string>, limit: number)
  : { order: string[]; injected: Map<string, string> } {
  const out = [...ids], injected = new Map<string, string>(), moved = new Set<string>();
  const children = new Map<string, string[]>();
  const block = (id: string): string[] => [id, ...(children.get(id) ?? []).flatMap(block)];
  for (const r of ids) {
    const srcs = (sources.get(r) ?? []).filter((x) => x !== r);
    if (!srcs.length || moved.has(r)) continue;
    const mine = new Set(block(r));
    const onPage = srcs.filter((x) => out.includes(x) && !mine.has(x));
    let anchor: string;
    if (onPage.length) anchor = onPage.reduce((a, b) => (out.indexOf(a) <= out.indexOf(b) ? a : b));
    else {
      if (srcs.some((x) => out.includes(x))) continue;            // the source only inside its own block — a loop: leave it
      const x = inject.get(r);
      if (!x || x === r || out.includes(x)) continue;
      out.splice(out.indexOf(r), 0, x);
      injected.set(x, r);
      anchor = x;
    }
    const mv = block(r);
    for (const id of mv) out.splice(out.indexOf(id), 1);
    const tail = block(anchor);
    out.splice(out.indexOf(tail[tail.length - 1]!) + 1, 0, ...mv);
    children.set(anchor, [...(children.get(anchor) ?? []), r]);
    moved.add(r);
  }
  let order = out.slice(0, Math.max(0, limit));
  // A mixed-in source is needed only with its retelling: the retelling went past limit (it stands right after the source,
  // so the source is the last on the page) — the source is removed, the page is refilled from the cut tail, and the retelling
  // returns to its place. Else the page would end with a record that does not answer the query, without a mark and with the score
  // of the retelling, and the retelling itself would go to the next page without a source.
  for (;;) {
    const kept = new Set(order);
    const orphan = [...injected].find(([x, r]) => kept.has(x) && !kept.has(r));
    if (!orphan) break;
    out.splice(out.indexOf(orphan[0]), 1);
    injected.delete(orphan[0]);
    order = out.slice(0, Math.max(0, limit));
  }
  const kept = new Set(order);
  for (const x of [...injected.keys()]) if (!kept.has(x)) injected.delete(x);
  return { order, injected };
}
