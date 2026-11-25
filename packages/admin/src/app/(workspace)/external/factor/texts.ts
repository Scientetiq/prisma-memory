export interface FactorState {
  mode: "off" | "optional" | "required";
  enrolled: boolean;
  label: string | null;
  activated_at: string | null;
  recovery_left: number;
  recovery_low: boolean;
  locked_until: string | null;
}

export const FACTOR_FRESH_LOGIN_HREF = "/login?fresh=1&next=/external/factor";
export const FACTOR_PATH = "/external/factor";

export { MODE_TEXT } from "@/messages/ws-external";

export function factorRefusal(r: { status: number; code: string; message: string; details?: unknown }): { message: string; lines: string[]; link?: { href: string; label: string } } {
  switch (r.code) {
    case "factor_fresh_login_required": {
      const d = (r.details ?? {}) as { login_path?: unknown };
      const href = typeof d.login_path === "string" && d.login_path.startsWith("/login?") ? d.login_path : FACTOR_FRESH_LOGIN_HREF;
      return { message: WS_EXTERNAL_MESSAGES.signInAgainFirst, lines: [WS_EXTERNAL_MESSAGES.freshLoginText], link: { href, label: WS_EXTERNAL_MESSAGES.signInAgain } };
    }
    case "factor_first_confirm_required": return { message: WS_EXTERNAL_MESSAGES.officeNetworkOrSupportConfirmation, lines: [WS_EXTERNAL_MESSAGES.firstConfirmText] };
    case "already_enrolled": return { message: WS_EXTERNAL_MESSAGES.secondFactorAlreadySetUp, lines: [WS_EXTERNAL_MESSAGES.toChangeYourPhoneSelect] };
    case "proof_required": return { message: WS_EXTERNAL_MESSAGES.codeNotAccepted, lines: [WS_EXTERNAL_MESSAGES.proofHint] };
    case "bad_code": return { message: WS_EXTERNAL_MESSAGES.codeNotAccepted2, lines: [WS_EXTERNAL_MESSAGES.checkThatTheTimeOn] };
    case "code_expired": return { message: WS_EXTERNAL_MESSAGES.setupTimeExpired, lines: [WS_EXTERNAL_MESSAGES.startSetupAgain2] };
    case "factor_locked": return { message: WS_EXTERNAL_MESSAGES.tooManyIncorrectCodes, lines: [WS_EXTERNAL_MESSAGES.tryAgainLaterIfYour] };
    case "factor_unavailable": return { message: WS_EXTERNAL_MESSAGES.secondFactorCurrentlyUnavailable, lines: [WS_EXTERNAL_MESSAGES.tryAgainLater] };
    default: return { message: r.message || WS_EXTERNAL_MESSAGES.couldNotCompleteTheAction, lines: [] };
  }
}

export function codesFileText(codes: readonly string[], when: Date = new Date()): string {
  return [WS_EXTERNAL_MESSAGES.companyMemorySecondFactorRecovery, WS_EXTERNAL_MESSAGES.issued(when.toISOString().slice(0, 10)),
    WS_EXTERNAL_MESSAGES.eachCodeCanBeUsed, "", ...codes, ""].join("\n");
}

export const qrImageSrc = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

import { WS_EXTERNAL_MESSAGES } from "@/messages/ws-external";

export { WS_EXTERNAL_MESSAGES } from "@/messages/ws-external";
