import { EDGE_STATE_TEXT, EDGE_REASON_TEXT, EDGE_SHOW, KILL_REASON_TEXT, UNKILL_REASON_TEXT, CANARY_HOLD_RELEASE_CONFIRM, CANARY_HOLDS_RELEASE_ALL_CONFIRM, SERVICE_TITLES, CANARY_TEXT, TEXT } from "../messages/edge-status";

export interface RecordEdgeStatus {
  export_seen: boolean;
  export_enabled: boolean;
  state: "shown" | "held" | "close_confirmed" | "close_failed" | "not_shown" | "revoked";
  reasons: string[];
  releasable: string[];
  can_release: boolean;
}

export interface EdgeExportStatus {
  export_enabled: boolean; queues_enabled: boolean;
  revoke_pending: number; revoke_age_ms: number | null; publish_pending: number;
  watermark_sent_at: string | null; last_full_sync_at: string | null; last_light_at: string | null; last_full_at: string | null;
  canary_state: "ok" | "tripped" | "unknown"; killed_at: string | null; killed_reason: string | null;
  last_result?: Record<string, unknown> | null; reconcile_result?: Record<string, unknown> | null;
  canary_checked_at?: string | null; canary_tripped_at?: string | null; canaries?: number; updated_at?: string | null;
  services?: Array<{ service: "exporter" | "intake" | "reconciler"; at: string; run_mode: string; fresh: boolean }>;
}

export { EDGE_STATE_TEXT } from "../messages/edge-status";

export { EDGE_REASON_TEXT } from "../messages/edge-status";


export { EDGE_SHOW } from "../messages/edge-status";

export function edgeRecordView(v: RecordEdgeStatus | null | undefined): { title: string; tone: "ok" | "warn" | "neutral"; lines: string[]; button: boolean } | null {
  if (!v || !v.export_seen) return null;
  const lines: string[] = [];
  const why = [...new Set(v.reasons.map((r) => EDGE_REASON_TEXT[r] ?? TEXT.thereIsAReasonAnAdministratorMustResolve))];
  if (v.state !== "shown" && why.length) lines.push(TEXT.reason(TEXT.reasonList(why)));
  if (v.state === "close_failed") lines.push(TEXT.theRecordRemainsOpenInternallyItWillStay);
  if (v.state !== "shown" && !v.export_enabled) lines.push(TEXT.sendingRecordsOutsideIsCurrentlyOff);
  if (v.can_release) lines.push(EDGE_SHOW.hint);
  const tone = v.state === "shown" ? "ok" : v.state === "close_failed" ? "warn" : "neutral";
  return { title: EDGE_STATE_TEXT[v.state] ?? EDGE_STATE_TEXT.not_shown, tone, lines, button: v.can_release };
}

export function ageWords(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 90) return TEXT.s(String(s));
  const m = Math.round(s / 60);
  if (m < 90) return TEXT.min(String(m));
  const h = Math.round(m / 60);
  return h < 48 ? TEXT.h(String(h)) : TEXT.d(String(Math.round(h / 24)));
}

const since = (iso: string | null | undefined, now: number): number | null => (iso ? now - Date.parse(iso) : null);

export { KILL_REASON_TEXT } from "../messages/edge-status";

export { UNKILL_REASON_TEXT } from "../messages/edge-status";
export const unkillReasonLines = (reasons: unknown): string[] =>
  [...new Set((Array.isArray(reasons) ? reasons : []).filter((r): r is string => typeof r === "string").map((r) => UNKILL_REASON_TEXT[r] ?? TEXT.thereIsAReasonRecordedInTheLog))]
    .map((t) => TEXT.reason(String(t)));


export interface CanaryHold { record_id: string; created_at: string }
export { CANARY_HOLD_RELEASE_CONFIRM } from "../messages/edge-status";
export { CANARY_HOLDS_RELEASE_ALL_CONFIRM } from "../messages/edge-status";

export { SERVICE_TITLES } from "../messages/edge-status";

export { CANARY_TEXT } from "../messages/edge-status";

export function edgeExportView(s: EdgeExportStatus, now = Date.now()) {
  const killed = s.killed_at ? { at: s.killed_at, why: (s.killed_reason && KILL_REASON_TEXT[s.killed_reason]) ?? TEXT.automaticProtectionWasTriggered } : null;
  const mark = ageWords(since(s.watermark_sent_at, now));
  const reconcile = s.last_light_at || s.last_full_at ? (Date.parse(s.last_full_at ?? "") > Date.parse(s.last_light_at ?? "") ? s.last_full_at : s.last_light_at) : null;
  const rr = (s.reconcile_result ?? {}) as { extra?: unknown; missing?: unknown };
  return {
    state: killed ? TEXT.shutDownAutomatically : s.export_enabled ? TEXT.on : TEXT.off,
    tone: killed ? "danger" : s.export_enabled ? "ok" : "muted",
    killed,
    freshness: mark ? TEXT.lastFreshnessMarkerSentToTheEdgeAgo(String(mark))
      : s.export_enabled && !killed && (s.last_result as { sweep?: unknown } | null | undefined)?.sweep === "waiting"
        ? TEXT.noFreshnessMarkerHasBeenSentYetWaiting
        : TEXT.noFreshnessMarkerHasBeenSentToThe,
    queues: TEXT.awaitingRevocationAwaitingPublication(String(s.revoke_pending), String(s.revoke_pending && s.revoke_age_ms !== null ? TEXT.oldest(String(ageWords(s.revoke_age_ms))) : ""), String(s.publish_pending)),
    reconcile: reconcile ? { at: reconcile, extra: Number(rr.extra ?? 0) || 0, missing: Number(rr.missing ?? 0) || 0 } : null,
    canary: CANARY_TEXT[s.canary_state] ?? CANARY_TEXT.unknown,
    canaryTone: s.canary_state === "tripped" ? "danger" : s.canary_state === "ok" ? "ok" : "muted",
    canaries: s.canaries ?? 0,
    services: (s.services ?? []).map((x) => ({ title: SERVICE_TITLES[x.service] ?? x.service, at: x.at, fresh: x.fresh })),
  } as const;
}


export { TEXT as EDGE_STATUS_TEXT } from "../messages/edge-status";
