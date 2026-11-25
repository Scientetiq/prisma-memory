import { auditText, AUDIT_TIER_TITLES, DETAIL_LABELS, OP_REASON_TITLES } from "../messages/audit-view";
import { AUDIT_ACTION_TITLES } from "./labels";
import type { AuditEvent } from "./types";

export { AUDIT_TIER_TITLES } from "../messages/audit-view";

/** The client label of a workspace session (gateway user-sessions.ts SESSION_CLIENT_LABEL), independent of the interface language. */
export const isWorkplaceSession = (label: string | null | undefined): boolean => label === "workspace";

export function tierPlain(tier: string | null | undefined, clientLabel: string | null | undefined): string | null {
  if (isWorkplaceSession(clientLabel)) return auditText.workspace;
  if (clientLabel?.startsWith("admin:")) return auditText.adminPanel;
  return tier ? AUDIT_TIER_TITLES[tier] ?? tier : null;
}

export { DETAIL_LABELS } from "../messages/audit-view";

const DETAIL_SKIP = new Set(["op", "preview", "client"]);

export function detailRows(details: Record<string, unknown> | null | undefined): Array<{ key: string; label: string; value: string }> {
  return Object.entries(details ?? {}).filter(([k]) => !DETAIL_SKIP.has(k)).map(([k, v]) => ({ key: k, label: DETAIL_LABELS[k] ?? k, value: compact(v) }));
}

function compact(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? auditText.yes : auditText.no;
  if (typeof v === "string") return v.length > 80 ? `${v.slice(0, 79)}…` : v;
  const s = JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
}

export const opTitle = (op: string): string => AUDIT_ACTION_TITLES[op] ?? op;

function recheckCode(base: string, details: Record<string, unknown> | null | undefined): string {
  const w = details?.why;
  const why = w === "nda" || w === "rules" || w === "unchecked" ? w : details?.unchecked === true ? "unchecked" : details?.reason === "nfd" ? "rules" : "nda";
  return why === "nda" ? base : `${base}_${why}`;
}

export function opTitleOf(op: string, details: Record<string, unknown> | null | undefined): string {
  if (op === "close" && details?.via === "organizer_transfer") return opTitle("close_organizer_transfer");
  if (op === "close" && details?.via === "nda_recheck") return opTitle(recheckCode("close_nda_recheck", details));
  if (op === "open_recheck_held" || op === "open_recheck_on_restore") return opTitle(recheckCode(op, details));
  if (op === "open" && details?.via === "nda_recheck") return opTitle("open_nda_recheck");
  if (op === "organizer_return" && details?.trashed === true) return opTitle("organizer_return_trashed");
  if (op === "custody_read" && details?.closed === true) return opTitle("custody_read_closed");
  const why = typeof details?.reason === "string" ? OP_REASON_TITLES[op]?.[details.reason] : undefined;
  const title = why ? `${opTitle(op)}: ${why}` : opTitle(op);
  return details?.by_operator === true ? auditText.theMemoryAdministratorBecameTheCustodian(title) : title;
}

export interface AuditRow { event: AuditEvent; count: number; firstAt: string }

const runKey = (e: AuditEvent): string | null => e.event_type !== "rate_limited" || !e.actor || e.actor === "—" ? null
  : [e.actor, e.on_behalf_of ?? "", String(e.details?.tool ?? e.details?.reason ?? e.details?.method ?? ""), String(e.details?.login ?? "")].join("|");

export function collapseRuns(items: readonly AuditEvent[]): AuditRow[] {
  const out: AuditRow[] = [];
  for (const e of items) {
    const k = runKey(e), last = out[out.length - 1];
    if (k && last && runKey(last.event) === k) { last.count++; last.firstAt = e.at; continue; }
    out.push({ event: e, count: 1, firstAt: e.at });
  }
  return out;
}

export function spanText(fromIso: string, toIso: string): string {
  const sec = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000));
  if (sec < 60) return auditText.overS(Math.max(1, sec));
  if (sec < 3600) return auditText.overMin(Math.round(sec / 60));
  return auditText.overH(Math.round(sec / 3600));
}
