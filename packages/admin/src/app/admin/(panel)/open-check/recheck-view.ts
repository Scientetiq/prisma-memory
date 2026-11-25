import { RECHECK_REASON_TITLES, RECHECK_STATE_TITLES, RECHECK_WHY_TITLES, TEXT } from "@/messages/panel-open-check";

export const RECHECK_BATCH_RANGE = [10, 1000] as const;
export const RECHECK_PAGE = 50;

export interface RecheckCounts { checked?: number; held?: number; on_restore?: number; busy?: number; unchecked?: number; failed?: number; reopened?: number; skipped?: number }
export interface RecheckItem {
  record_id: string; state: "held" | "kept" | "on_restore" | "failed"; why: "nda" | "rules" | "unchecked" | "busy" | null;
  kinds: string[]; rules: string[]; run_reason: string; held_at: string | null; decided_at: string | null;
  space: { slug: string; name: string; kind: string } | null; author: { login: string; display_name: string | null } | null;
}
export interface RecheckView {
  enabled: boolean; batch: number; baseline_known: boolean;
  running: { id: string; reason: string; phase: string; counts: RecheckCounts; started_at: string | null } | null;
  last: (RecheckCounts & { run?: string; reason?: string; at?: string; spaces?: number; entities?: number }) | null;
  holds: { held: number; kept: number; on_restore: number; failed: number };
  report: { spaces: Array<{ slug: string; name: string; kind: string }>; entities: Array<{ id: string; kind: string }> };
  items: RecheckItem[]; next_cursor: string | null; total: number;
}

export { RECHECK_REASON_TITLES } from "@/messages/panel-open-check";
export { RECHECK_STATE_TITLES } from "@/messages/panel-open-check";
export { RECHECK_WHY_TITLES } from "@/messages/panel-open-check";

export function countsLine(c: RecheckCounts | undefined): string {
  const x = c ?? {};
  const parts = [TEXT.checked(String(x.checked ?? 0)), TEXT.hidden(String(x.held ?? 0))];
  if (x.unchecked) parts.push(TEXT.ofWhichUnchecked(String(x.unchecked)));
  if (x.on_restore) parts.push(TEXT.inTrash(String(x.on_restore)));
  if (x.reopened) parts.push(TEXT.availableToAgentsAgain(String(x.reopened)));
  if (x.failed) parts.push(TEXT.failed(String(x.failed)));
  if (x.busy) parts.push(TEXT.busy(String(x.busy)));
  return TEXT.countsSummary(parts);
}
