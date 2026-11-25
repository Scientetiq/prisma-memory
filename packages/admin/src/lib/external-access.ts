import { derivedList } from "../i18n/runtime";
import type { TabSpec } from "./admin-tabs";
import { EXTERNAL_ACCESS_MESSAGES, DISABLED_CODE_TEXT, NOT_ALLOWED_TEXT, CLOSED_REASON_TEXT } from "../messages/external-access";

export interface ExternalProgram { client_id: string; kind: string; title: string; command: string | null }

export interface ExternalState {
  enabled: boolean;
  enabled_at: string | null;
  disabled_at: string | null;
  disabled_code: string | null;
  fresh_ok: boolean;
  first_confirm: { needed: boolean; status: "not_needed" | "office" | "requested" | "confirmed" | "none" };
  login_enabled: boolean;
  programs: ExternalProgram[];
  unseen_notices: number;
}

export interface ExternalNotice { id: string; kind: string; title: string; text: string; created_at: string; seen_at: string | null }

export { EXTERNAL_FACTS } from "../messages/external-access";

export { DISABLED_CODE_TEXT } from "../messages/external-access";
export const disabledText = (code: string | null | undefined): string => (code ? DISABLED_CODE_TEXT[code] : null) ?? EXTERNAL_ACCESS_MESSAGES.itWasDisabled;

export { NOT_ALLOWED_TEXT } from "../messages/external-access";
export const notAllowedLines = (reasons: unknown): string[] =>
  [...new Set((Array.isArray(reasons) ? reasons : []).filter((r): r is string => typeof r === "string").map((r) => NOT_ALLOWED_TEXT[r] ?? EXTERNAL_ACCESS_MESSAGES.supportHasMoreInformationAbout))]
    .map((t) => EXTERNAL_ACCESS_MESSAGES.reason(t));

export { FIRST_CONFIRM_TEXT } from "../messages/external-access";

export const externalMenuShown = (s: Pick<ExternalState, "enabled" | "login_enabled" | "programs"> | null | undefined): boolean =>
  !!s && (s.enabled === true || s.login_enabled === true || (Array.isArray(s.programs) && s.programs.length > 0));

export interface EnableRefusal { message: string; lines: string[]; link?: { href: string; label: string } }

export function enableRefusal(r: { status: number; code: string; message: string; details?: unknown }): EnableRefusal {
  const d = (r.details ?? {}) as { login_path?: unknown; reasons?: unknown; reason?: unknown; request_id?: unknown };
  if (r.status === 503) return { message: EXTERNAL_ACCESS_MESSAGES.externalSignInIsCurrently, lines: [] };
  if (r.code === "fresh_login_required") {
    const href = typeof d.login_path === "string" && d.login_path.startsWith("/login?") ? d.login_path : FRESH_LOGIN_HREF;
    return { message: r.message, lines: [EXTERNAL_ACCESS_MESSAGES.thisProtectsYouIfSomeone], link: { href, label: EXTERNAL_ACCESS_MESSAGES.signInAgain } };
  }
  if (r.code === "first_confirm_required") return { message: r.message, lines: [EXTERNAL_ACCESS_MESSAGES.supportWillContactYouAnd] };
  if (r.code === "external_not_allowed") return { message: r.message, lines: notAllowedLines(d.reasons) };
  if (r.code === "factor_required") {
    return { message: r.message, lines: [EXTERNAL_ACCESS_MESSAGES.firstSetUpASecond],
             link: { href: "/external/factor", label: EXTERNAL_ACCESS_MESSAGES.setUpSecondFactor } };
  }
  return { message: r.message, lines: [] };
}

export const FRESH_LOGIN_HREF = "/login?fresh=1&next=/external";

export { ENABLE_CONFIRM } from "../messages/external-access";
export { DISABLE_CONFIRM } from "../messages/external-access";
export { REVOKE_ALL_CONFIRM } from "../messages/external-access";

export interface ExternalPerson {
  person_id: string; display_name: string; enabled: boolean; enabled_at: string | null; disabled_at: string | null; disabled_code: string | null;
  disabled_by: string | null; last_external_login_at: string | null; ad_checked_at: string | null; ad_ok: boolean; connections_active: number;
}
export interface ExternalConfirmation {
  id: string; person_id: string; display_name: string; requested_at: string; requested_network: string | null;
  confirmed_by: string | null; confirmed_at: string | null; expires_at: string | null; used_at: string | null;
}
export interface AuthcheckStatusView { reachable: boolean; status: { ok: boolean; closed_reason?: string; pause_until?: string; last_sweep_at?: string; sweep_ok: boolean; anchors_serial: number | null; version: string } | null }

export function confirmationState(c: Pick<ExternalConfirmation, "confirmed_at" | "expires_at" | "used_at" | "requested_at">, now = Date.now()):
  { title: string; tone: "warn" | "ok" | "muted"; canConfirm: boolean } {
  if (c.used_at) return { title: EXTERNAL_ACCESS_MESSAGES.used, tone: "muted", canConfirm: false };
  if (c.confirmed_at) return c.expires_at && Date.parse(c.expires_at) > now
    ? { title: EXTERNAL_ACCESS_MESSAGES.confirmed, tone: "ok", canConfirm: false } : { title: EXTERNAL_ACCESS_MESSAGES.confirmationExpired, tone: "muted", canConfirm: false };
  return now - Date.parse(c.requested_at) < 7 * 86_400_000 ? { title: EXTERNAL_ACCESS_MESSAGES.awaitingSupport, tone: "warn", canConfirm: true } : { title: EXTERNAL_ACCESS_MESSAGES.expired, tone: "muted", canConfirm: false };
}

export function disabledByText(by: string | null | undefined): string {
  if (!by) return "—";
  if (by === "self") return EXTERNAL_ACCESS_MESSAGES.theColleagueThemselves;
  if (by === "auto") return EXTERNAL_ACCESS_MESSAGES.automatically;
  const m = /^(admin|support):(.+)$/.exec(by);
  return m ? EXTERNAL_ACCESS_MESSAGES.disabledByText5(m[1] === "admin" ? EXTERNAL_ACCESS_MESSAGES.administrator : EXTERNAL_ACCESS_MESSAGES.support, m[2]) : by;
}

export { CLOSED_REASON_TEXT } from "../messages/external-access";
export const PAUSE_FOREVER_FROM_MS = Date.UTC(9999, 0, 1);
export const isForeverPause = (iso: string | null | undefined): boolean => !!iso && Date.parse(iso) >= PAUSE_FOREVER_FROM_MS;

export function externalPause(iso: string | null | undefined, now = Date.now()): { forever: true; text: string } | { forever: false; until: string } | null {
  if (!iso || !(Date.parse(iso) > now)) return null;
  return isForeverPause(iso) ? { forever: true, text: EXTERNAL_ACCESS_MESSAGES.foreverPauseText } : { forever: false, until: iso };
}

export function authcheckStateText(v: AuthcheckStatusView): { title: string; tone: "ok" | "warn" | "danger"; lines: string[] } {
  if (!v.reachable || !v.status) return { title: EXTERNAL_ACCESS_MESSAGES.notResponding, tone: "danger", lines: [EXTERNAL_ACCESS_MESSAGES.theInternalSignInCheck] };
  const s = v.status;
  const forever = isForeverPause(s.pause_until) ? [EXTERNAL_ACCESS_MESSAGES.foreverPauseText] : [];
  if (!s.ok) {
    const why = (s.closed_reason ? CLOSED_REASON_TEXT[s.closed_reason] : null) ?? EXTERNAL_ACCESS_MESSAGES.reasonUnknown;
    return { title: EXTERNAL_ACCESS_MESSAGES.closed, tone: "danger", lines: [EXTERNAL_ACCESS_MESSAGES.externalPasswordsAreNotChecked(why), ...forever] };
  }
  const lines: string[] = [...forever];
  if (!s.sweep_ok) lines.push(EXTERNAL_ACCESS_MESSAGES.theLastDirectoryCheckFailed);
  return { title: EXTERNAL_ACCESS_MESSAGES.running, tone: s.sweep_ok && !forever.length ? "ok" : "warn", lines };
}

export type ExternalTab = "people" | "confirmations" | "login";
export const EXTERNAL_TABS: ReadonlyArray<TabSpec<ExternalTab>> = derivedList(() => [
  { id: "people", title: EXTERNAL_ACCESS_MESSAGES.colleagues, anchors: ["people"] },
  { id: "confirmations", title: EXTERNAL_ACCESS_MESSAGES.confirmations, anchors: ["confirmations"] },
  { id: "login", title: EXTERNAL_ACCESS_MESSAGES.externalSignIn, anchors: ["service", "pause"] },
]);

export { PAUSE_CONFIRM } from "../messages/external-access";
export { LIFT_CONFIRM } from "../messages/external-access";
export const PERSON_OFF_CONFIRM = (name: string) => ({
  question: EXTERNAL_ACCESS_MESSAGES.disableExternalAccessFor(name),
  change: EXTERNAL_ACCESS_MESSAGES.allTheirExternalConnectionsWill,
  verb: EXTERNAL_ACCESS_MESSAGES.disable,
  danger: true,
});
export const CONFIRM_CONFIRM = (name: string) => ({
  question: EXTERNAL_ACCESS_MESSAGES.confirmThatTheRequestWas(name),
  change: EXTERNAL_ACCESS_MESSAGES.confirmOnlyAfterVerifyingIdentity,
  verb: EXTERNAL_ACCESS_MESSAGES.confirm,
});

export { EXTERNAL_ACCESS_MESSAGES } from "../messages/external-access";
