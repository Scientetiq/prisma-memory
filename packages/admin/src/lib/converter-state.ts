import { retryWhen } from "./meeting-state";
import { ORPHAN_WHY, DC_TEXT, converterState as m } from "../messages/converter-state";
import type { ConverterState, ConverterWaitKind, WaitingConverterGroup } from "./types";

export type ConverterTone = "ok" | "info" | "warn" | "danger";
export interface ConverterLine { text: string; tone: ConverterTone }

export interface ConverterBlockView {
  lines: ConverterLine[];
  canHoldNew: boolean;
  canHoldAll: boolean;
  canResume: boolean;
  canProbe: boolean;
  needsConfirm: boolean;
  recent: Array<{ id: string; cls: "open" | "closed"; state: string; dc: string; dcCode: string | null; since: string; repeats: string; tone: "ok" | "warn" | "danger" | "neutral" | "info" }>;
  orphans: Array<{ at: string; record: string | null; run: string | null; document: string | null; why: string }>;
}


/** Since when, on the clock of the installation: "since 14:30", "since 17 October at 21:00". */
export function sinceWhen(iso: string, now: Date): string {
  return m.since(retryWhen(iso, now));
}

export function bytesText(n: number): string {
  return m.byteSize(n);
}




export function converterBlockView(v: ConverterState, now: Date = new Date(Date.parse(v.checked_at) || Date.now())): ConverterBlockView {
  const lines: ConverterLine[] = [];
  const tone: ConverterTone = v.health.level === "fail" ? "danger" : v.health.level === "warn" ? "warn" : v.holds ? "info" : "ok";
  lines.push({ text: v.gate.text, tone });
  if (v.health.level !== "ok" && v.health.detail && !v.gate.text.toLowerCase().includes(v.health.detail.toLowerCase().slice(0, 24)))
    lines.push({ text: m.health(v.health.detail), tone: v.health.level === "fail" ? "danger" : "warn" });
  if (v.configured) {
    lines.push(v.caps
      ? { text: m.caps(v.caps.fast_lane, v.caps.version ?? "", retryWhen(v.caps.checked_at, now)), tone: "info" }
      : { text: m.unchecked, tone: "info" });
    const w = v.window;
    lines.push({ text: m.window(w.k, w.k_eff, w.in_flight, w.suspect), tone: w.suspect ? "warn" : "info" });
  }
  const q = v.queue;
  lines.push(q.waiting
    ? { text: m.queueDetails(q.waiting, q.oldest_since ? retryWhen(q.oldest_since, now) : "", q.by_kind), tone: "info" }
    : { text: m.empty, tone: "info" });
  lines.push(v.uploads_30d
    ? { text: m.uploadsWithBytes(v.uploads_30d.count, v.uploads_30d.bytes), tone: "info" }
    : { text: m.noUploads, tone: "warn" });
  if (v.orphan_runs?.count) lines.push({ text: m.orphans(v.orphan_runs.count), tone: "warn" });
  if (v.orphan_runs === null) lines.push({ text: m.noOrphans, tone: "warn" });
  return {
    lines,
    canHoldNew: v.configured && v.holds === null,
    canHoldAll: v.configured && v.holds !== "all",
    canResume: v.holds !== null || v.gate.new_block !== null || v.window.block === "stalled",
    canProbe: v.configured,
    needsConfirm: v.gate.principal_hold,
    recent: v.recent.map((r) => {
      const state = m.recentState(r.phase, r.stage_status, r.wait, r.terminal);
      const repeats = m.repeatSummary(r.reruns, r.new_runs);
      return { id: r.id, cls: r.class, state, dc: r.dc_status ? DC_TEXT[r.dc_status] ?? m.other : "—", dcCode: r.dc_status,
               since: sinceWhen(r.since ?? r.updated_at, now), repeats,
               tone: r.stage_status === "done" ? "ok" : r.stage_status === "failed" ? "danger" : r.stage_status === "running" ? "info" : r.wait && r.wait !== "queue" && r.wait !== "at_converter" ? "warn" : "neutral" };
    }),
    orphans: (v.orphan_runs?.items ?? []).map((o) => ({ at: o.at, record: o.record_id, run: o.run_id, document: o.document_id, why: (o.why && ORPHAN_WHY[o.why]) || "—" })),
  };
}

export interface WaitingConverterRow { kind: ConverterWaitKind; title: string; count: number; href: string }

export function waitingConverterRows(g: WaitingConverterGroup | undefined): WaitingConverterRow[] {
  if (!g?.total) return [];
  return g.kinds.map((k) => {
    const q = new URLSearchParams({ status: "pending", stage: "converted" });
    if (k.codes.length === 1) q.set("error", `converter_wait:${k.codes[0]}`); else q.set("error_code", "converter_wait");
    return { kind: k.kind, title: k.title, count: k.count, href: `/admin/unprocessed?${q.toString()}#items` };
  });
}

export function probeLines(out: { text: string; missing_roles?: string[]; woken?: number }): string[] {
  return [out.text, ...(out.missing_roles?.length ? [m.missingRoles(out.missing_roles.join(", "))] : []),
          ...(out.woken ? [m.woken(out.woken)] : [])];
}
