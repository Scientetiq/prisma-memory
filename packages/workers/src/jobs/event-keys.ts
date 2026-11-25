// The key is the stable event name, not a model field; the job's own algorithm, not a reference port.
import { pipelineText } from "@memory/shared";

export interface KeyCandidate {
  id: string; event_key: string; kind: string; title: string | null; quote: string | null;
  time_from: number | null; time_to: number | null; created_at: Date;
}
export interface KeyTarget {
  kind: string; title: string; quote: string | null; time_from: number | null; time_to: number | null;
}
export interface EventKeyParams { quoteThreshold: number; titleThreshold: number; windowSec: number }
export const EVENT_KEY_WINDOW_SEC = 30;

const interval = (v: Pick<KeyTarget, "time_from" | "time_to">): [number, number] | null => {
  const a = v.time_from ?? v.time_to, b = v.time_to ?? v.time_from;
  return typeof a === "number" && Number.isFinite(a) && typeof b === "number" && Number.isFinite(b) ? [Math.min(a, b), Math.max(a, b)] : null;
};

/** Any group member may match: the original and the fix describe the same stable key. */
function score(prev: KeyCandidate, next: KeyTarget, p: EventKeyParams): number | null {
  if (prev.kind !== next.kind) return null;
  if (prev.quote && next.quote) {
    // findQuote both ways: the model may shorten or lengthen the same quote.
    const a = pipelineText.quoteInText(prev.quote, next.quote, p.quoteThreshold);
    const b = pipelineText.quoteInText(next.quote, prev.quote, p.quoteThreshold);
    if (a || b) return 1 + Math.max(a?.ratio ?? 0, b?.ratio ?? 0);
  }
  const a = interval(prev), b = interval(next);
  if (!a || !b || a[0] > b[1] + p.windowSec || b[0] > a[1] + p.windowSec || !prev.title ||
      !pipelineText.titleSimilar(prev.title, next.title, p.titleThreshold)) return null;
  return new pipelineText.SequenceMatcher(pipelineText.codePoints(pipelineText.normalize(prev.title)),
    pipelineText.codePoints(pipelineText.normalize(next.title)), { autojunk: false }).ratio();
}

/** Greedy matching by best pair; each key and each new event takes part at most once. */
export function inheritEventKeys(prev: readonly KeyCandidate[], next: readonly KeyTarget[], p: EventKeyParams): Array<string | null> {
  const groups = new Map<string, KeyCandidate[]>();
  for (const row of prev) {
    if (!row.event_key) continue;
    const group = groups.get(row.event_key) ?? []; group.push(row); groups.set(row.event_key, group);
  }
  const pairs: Array<{ key: string; target: number; score: number; created: number }> = [];
  for (const [key, group] of groups) for (let target = 0; target < next.length; target++) {
    let best: { score: number; created: number } | null = null;
    for (const row of group) {
      const n = score(row, next[target]!, p); if (n === null) continue;
      const created = new Date(row.created_at).getTime() || 0;
      if (!best || n > best.score || (n === best.score && created > best.created)) best = { score: n, created };
    }
    if (best) pairs.push({ key, target, ...best });
  }
  pairs.sort((a, b) => b.score - a.score || b.created - a.created || a.key.localeCompare(b.key) || a.target - b.target);
  const assigned = next.map((): string | null => null), used = new Set<string>();
  for (const pair of pairs) if (!used.has(pair.key) && assigned[pair.target] === null) {
    assigned[pair.target] = pair.key; used.add(pair.key);
  }
  return assigned;
}
