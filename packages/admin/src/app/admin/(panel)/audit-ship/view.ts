import { SHIP_ERRORS } from "@/messages/panel-audit-ship";
import { shipText } from "@/messages/panel-audit-ship";

export interface AuditShipStatus {
  mode: "off" | "file" | "syslog_tls";
  lag_sec?: number | null; last_ok_at?: string | null; last_error_code?: string | null; last_error_at?: string | null;
  reconciled_day?: string | null; mismatch?: boolean | null;
}

export { MODE_TITLES } from "@/messages/panel-audit-ship";

export { SHIP_ERRORS } from "@/messages/panel-audit-ship";
export const shipErrorText = (code: string): string => SHIP_ERRORS[code] ?? shipText.code(code);

export function lagText(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return shipText.unknownCouldNotReadTheAuditLog;
  if (sec <= 0) return shipText.noneAllDueEventsSent;
  if (sec < 60) return shipText.lessThanAMinute;
  const m = Math.round(sec / 60);
  if (m < 60) return shipText.min(m);
  const h = Math.floor(m / 60), r = m % 60;
  if (h >= 48) { const d = Math.floor(h / 24), hh = h % 24; return hh ? shipText.dH(d, hh) : shipText.d(d); }
  return r ? shipText.hMin(h, r) : shipText.h(h);
}

export const SHIP_LAG_WARN_SEC = 600;

export function shipState(s: AuditShipStatus, now = Date.now()): { title: string; tone: "muted" | "danger" | "warn" | "ok" } {
  if (s.mode === "off") return { title: shipText.off, tone: "muted" };
  if (s.last_error_code) return { title: shipText.error2, tone: "danger" };
  if (!s.last_ok_at) return { title: shipText.notStartedYet, tone: "warn" };
  if (s.lag_sec !== null && s.lag_sec !== undefined && s.lag_sec >= SHIP_LAG_WARN_SEC) return { title: shipText.behind, tone: "warn" };
  if (now - Date.parse(s.last_ok_at) >= SHIP_LAG_WARN_SEC * 1000) return { title: shipText.noRecentRuns, tone: "warn" };
  if (s.lag_sec === null || s.lag_sec === undefined) return { title: shipText.unknown, tone: "warn" };
  return { title: shipText.running, tone: "ok" };
}

export { shipText as AUDIT_SHIP_TEXT } from "@/messages/panel-audit-ship";
