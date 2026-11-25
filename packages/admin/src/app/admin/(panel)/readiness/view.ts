import { STATUS, FLAG_TITLES, VIEW_TEXT } from "../../../../messages/panel-readiness";
import type { SecurityMode } from "../security-mode/view";

export type CheckStatus = "ok" | "warn" | "fail";
export interface Check { id: string; status: CheckStatus; title: string; detail?: string; advanced_only?: boolean }
export interface ProfileKey {
  key: string; digest: string;
  secret?: boolean; value?: unknown; seed?: unknown; set?: boolean;
  changed_at?: string | null; changed_by?: string | null; changed_by_human?: boolean | null;
  risk?: string;
}
export interface GateWarning { id: string; title: string; detail?: string }
export interface GateRow { flag: string; open: boolean; failed: Array<{ reason: string; title: string }>; warnings?: GateWarning[]; profile?: ProfileKey[] }
export interface DryRun {
  flags: Array<{ key: string; before: unknown; after: unknown }>;
  system_keys: Array<{ id: string; prefix: string | null; last_used_at: string | null; last_ip: string | null }>;
  /** null — the gateway could not read the audit log: "no data", not 0. */
  would_require_30d: number | null;
  profile: Array<{ key: string; value: unknown; seed: unknown; digest?: string; changed_at?: string | null; changed_by?: string | null; changed_by_human?: boolean | null }>;
  scripts: Array<{ ip: string | null; client: string | null; calls: number; last_at: string | null }>;
  sessions: Array<{ login: string; auth_method: string; sessions: number }>;
}
export interface ReadinessView { checks: Check[]; mode: SecurityMode; gate: GateRow[]; target?: "advanced"; before?: Check[]; completion?: Check[]; dry_run?: DryRun }

export { STATUS };

export { FLAG_TITLES };

export function checkBadge(c: Pick<Check, "status" | "advanced_only">, mode: SecurityMode): { title: string; tone: "ok" | "warn" | "danger" | "muted" } {
  if (mode === "basic" && c.advanced_only && c.status !== "ok") return { title: VIEW_TEXT.requiredForAdvanced, tone: "muted" };
  return STATUS[c.status];
}

export function canEnableAdvanced(v: Pick<ReadinessView, "mode" | "before">): boolean {
  return v.mode === "basic" && Array.isArray(v.before) && v.before.length > 0 && v.before.every((c) => c.status === "ok");
}

export function valueText(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (v === true) return VIEW_TEXT.yes;
  if (v === false) return VIEW_TEXT.no;
  if (typeof v === "string") return v || VIEW_TEXT.empty;
  const s = JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

export const PROFILE_SHOWN_MAX = 1500;

export function shownValue(v: unknown): { text: string; cut: boolean } {
  const s = v === null || v === undefined ? VIEW_TEXT.notSet : v === true ? VIEW_TEXT.yes2 : v === false ? VIEW_TEXT.no2 : typeof v === "string" ? (v || VIEW_TEXT.empty2) : JSON.stringify(v);
  return s.length > PROFILE_SHOWN_MAX ? { text: `${s.slice(0, PROFILE_SHOWN_MAX)}…`, cut: true } : { text: s, cut: false };
}

export function profileView(k: ProfileKey): { now: string; cut: boolean; seed: string | null; who: string; machine: boolean } {
  const now = k.secret ? { text: k.set ? VIEW_TEXT.setValueHidden : VIEW_TEXT.notSet2, cut: false } : shownValue(k.value);
  const seed = k.secret ? null : shownValue(k.seed).text;
  const who = k.changed_by ?? VIEW_TEXT.lastEditorNotRecordedInTheAuditLog;
  return { now: now.text, cut: now.cut, seed, who, machine: k.changed_by_human !== true };
}

const short = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

export function profileConfirmText(k: ProfileKey): { question: string; change: string; undo: string } {
  const v = profileView(k);
  const change = k.secret
    ? VIEW_TEXT.secretConfirmation(k.set === true, k.changed_by ?? null)
    : VIEW_TEXT.valueConfirmation(short(v.now, 300), short(v.seed ?? "—", 120), k.changed_by ?? null);
  return { question: VIEW_TEXT.confirmValue1(k.key), change: k.risk ? `${change} ${k.risk}` : change, undo: VIEW_TEXT.confirmationRemainsInTheHistoryRestoreTheDefaultIn };
}

/**
 * Dry-run line about admin actions that would need a second signature: a number, or — when the gateway
 * could not read the audit log (null or a missing field) — "no data" with a warning, never a silent 0.
 */
export function wouldRequireLine(n: number | null | undefined): { count: number | null; unreadable: boolean } {
  return typeof n === "number" && Number.isFinite(n) ? { count: n, unreadable: false } : { count: null, unreadable: true };
}

export function warningLines(g: Pick<GateRow, "warnings">): string[] {
  return (g.warnings ?? []).map((w) => (w.detail ? `${w.title}; ${w.detail}` : w.title));
}
