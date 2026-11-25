import { VIEW_TEXT, MODE_TITLE, RESET_MODE_TEXT } from "../../../../messages/panel-factor";
export { VIEW_TEXT };

export type MfaMode = "off" | "optional" | "required";

export interface FactorOverview {
  installed: boolean;
  mode: MfaMode;
  setting: MfaMode;
  floor: MfaMode;
  setting_updated_at: string | null;
  required_since: string | null;
  grace_days: number;
  grace_until: string | null;
  coverage: { optin: number; enrolled: number };
  grace_connections: number;
}


export { MODE_TITLE };
export const MODE_TONE: Readonly<Record<MfaMode, "muted" | "info" | "ok">> = { off: "muted", optional: "info", required: "ok" };

export function coverageLine(c: { optin: number; enrolled: number }): string {
  if (!c.optin) return VIEW_TEXT.nobodyHasEnabledExternalAccessYet;
  const pct = Math.round((c.enrolled / c.optin) * 100);
  return VIEW_TEXT.coverage(c.optin, c.enrolled, pct);
}

export function requiredWarning(o: Pick<FactorOverview, "mode" | "grace_days" | "coverage" | "grace_connections">): string | null {
  if (o.mode === "required") return null;
  const without = Math.max(0, o.coverage.optin - o.coverage.enrolled);
  const conns = Math.max(0, o.grace_connections ?? 0);
  if (!without && !conns) return null;
  return VIEW_TEXT.requiredWarning(without, conns, o.grace_days);
}

export const RESET_REASON_MIN = 3;
export const RESET_REASON_MAX = 300;


export { RESET_MODE_TEXT };


export function resetRefusal(e: { status: number; code: string; message: string }): string {
  switch (e.code) {
    case "human_session_required": return VIEW_TEXT.notResetOnlyAnAdministratorPersonallySignedInThrough;
    case "reset_approval_invalid": return VIEW_TEXT.notResetTheRequestIsStaleOrAlreadyUsed;
    case "factor_unavailable": return VIEW_TEXT.notResetTheSignInServiceDidNotRespond;
    case "factor_self_reset": return VIEW_TEXT.notResetAnotherAdministratorMustResetYourSecondFactor;
    case "admin_plane_required": return VIEW_TEXT.notResetThisRequiresTheAdminPlaneWhichIs;
    case "not_found": return VIEW_TEXT.notResetColleagueNotFoundRefreshThePage;
    case "conflict": return VIEW_TEXT.notResetValue1(e.message);
    default: return e.status === 400 ? VIEW_TEXT.notResetValue12(e.message) : VIEW_TEXT.notResetValue13(e.message || VIEW_TEXT.gatewayError);
  }
}
