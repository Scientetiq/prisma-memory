import { VIEW_TEXT, MODE_TEXT, PENDING_BADGES, SM_ERROR_TEXTS } from "../../../../messages/panel-security-mode";
export { VIEW_TEXT };

export type SecurityMode = "basic" | "advanced";
export type PendingState = "waiting_signature" | "waiting_delay" | "ready" | "executed" | "cancelled";
export interface PendingView {
  id: string; requested_by: string | null; requested_at: string | null; reason: string; not_before: string | null;
  approved_by: string | null; approved_at: string | null; state: PendingState;
  approved_anchors_serial?: number | null;
}
export interface ModeChange { at: string | null; from: SecurityMode | null; to: SecurityMode; by: string | null; reason: string | null; keys_revoked: number; sessions_revoked: number }
export interface ModeState {
  mode: SecurityMode; setting: SecurityMode; floor: SecurityMode | null; downgrade_delay_hours: number;
  pending: PendingView | null; changes: ModeChange[];
  retire_possible?: boolean;
}

export const DOWNGRADE_REASON_MIN = 20;

export { MODE_TEXT };

export { PENDING_BADGES };

/**
 * advanced is closed in this release: the button, the anchors draft with a floor advanced and the database
 * refuse it with reason roles_not_split until the role split is ported. The panel's text for that refusal.
 */


export { SM_ERROR_TEXTS };

export type DowngradeButton = "approve" | "approve_retire" | "cancel" | "execute";

export function downgradeButtons(p: Pick<PendingView, "state" | "requested_by" | "approved_by">, me: { login: string | null; role: string | null },
                                 o: { retirePossible?: boolean } = {}): DowngradeButton[] {
  if (me.role !== "memory_admin" || p.state === "executed" || p.state === "cancelled") return [];
  const out: DowngradeButton[] = [];
  const mine = Boolean(me.login && p.requested_by === me.login);
  if (p.state === "waiting_signature" && !mine) out.push("approve");
  if (p.state === "waiting_signature" && mine && o.retirePossible === true) out.push("approve_retire");
  if (p.state === "ready" && (mine || (me.login !== null && p.approved_by === me.login))) out.push("execute");
  out.push("cancel");
  return out;
}

export function modeBannerText(s: Pick<ModeState, "mode" | "pending">): { tone: "info" | "ok" | "warn"; text: string } {
  const base = s.mode === "advanced" ? VIEW_TEXT.securityModeAdvancedSecondSignaturesAndSecurityKeySign : VIEW_TEXT.securityModeBasicActionsRunImmediatelyWithoutASecond;
  if (!s.pending || s.pending.state === "executed" || s.pending.state === "cancelled") return { tone: s.mode === "advanced" ? "ok" : "info", text: base };
  return { tone: "warn", text: VIEW_TEXT.value1AReturnToBasicIsRequestedValue2Cancel(base, PENDING_BADGES[s.pending.state].title) };
}
