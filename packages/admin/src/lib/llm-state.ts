import { clockTime, retryWhen } from "./meeting-state";
import { llmState as m } from "../messages/llm-state";
import type { LlmGateState } from "./types";

export type LlmTone = "ok" | "info" | "warn" | "danger";
export interface LlmLine { text: string; tone: LlmTone }
export interface LlmView {
  lines: LlmLine[];
  canClearHolds: boolean;
  canProbe: boolean;
  holdDetails: string[];
}

export function llmView(v: LlmGateState, now: Date = new Date(Date.parse(v.checked_at) || Date.now())): LlmView {
  const lines: LlmLine[] = [];
  const b = v.breaker;
  if (b.open && b.reason === "config") lines.push({ text: m.config, tone: "danger" });
  else if (b.open && b.reason === "slow") lines.push({ text: m.slow(retryWhen(b.open_until!, now)), tone: "warn" });
  else if (b.open) lines.push({ text: m.busy(retryWhen(b.open_until!, now), b.busy_streak ?? 0), tone: "warn" });
  const floor = v.holds.filter((h) => h.reason === "floor"), other = v.holds.filter((h) => h.reason !== "floor");
  if (other.length) {
    const last = other[other.length - 1]!;
    lines.push({ text: m.pausedFor(clockTime(last.until), other.some((h) => h.reason === "admin") ? "admin" : "test"), tone: "info" });
  }
  if (floor.length) lines.push({ text: m.reserved(clockTime(floor[floor.length - 1]!.until)), tone: "info" });
  if (v.stub) lines.push({ text: m.stub, tone: "info" });
  else if (v.floor_required) lines.push(v.lease ? { text: m.lease(clockTime(v.lease.until)), tone: "info" } : { text: m.noLease, tone: "info" });
  if (!lines.length) lines.push({ text: m.working, tone: "ok" });
  if (v.slot.dirty_until) lines.push({ text: m.dirty(retryWhen(v.slot.dirty_until, now)), tone: "info" });
  lines.push(v.slot.in_flight > 0
    ? { text: m.requestsFor(v.slot.in_flight, v.slot.holder?.purpose ?? "", v.slot.holder?.stage ?? ""), tone: "info" }
    : { text: m.noRequests, tone: "info" });
  const w = v.waiting;
  if (w.waiting_model) lines.push({ text: m.waiting(w.waiting_model, w.now_lane, w.night_lane, w.next_retry_at ? retryWhen(w.next_retry_at, now) : ""), tone: "warn" });
  if (w.too_slow) lines.push({ text: m.tooSlow(w.too_slow), tone: "warn" });
  return {
    lines, canClearHolds: other.length > 0, canProbe: b.open,
    holdDetails: v.holds.map((h) => m.holdDetail(h.owner, h.reason, clockTime(h.until), h.note ?? "")),
  };
}

export function retryLines(out: { reset: number; waiting?: number; waiting_converter?: number; records: number; kicked: number }): string[] {
  return [m.reset(out.reset, out.waiting ?? 0), ...(out.waiting_converter ? [m.converter(out.waiting_converter)] : []), m.oneByOne,
    ...(out.kicked < out.records ? [m.queueLater] : [])];
}
