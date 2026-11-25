import { OTP_TEXT } from "../../../messages/panel-login";
// Second factor of admin@local at sign-in (the panel's half): the state of the sign-in form and its
// words. The gateway decides everything (POST /api/v1/admin-login with `otp`): it asks for the code only after a correct
// password (`401 reason: otp_required`), refuses a wrong or reused code (`401 reason: bad_code` with `server_time`), locks
// the factor after five wrong codes (`429 reason: factor_locked`). The panel turns the answers into the code step of the
// form; the password is never part of the state. A plain module: the sign-in action and the form both read it.
import type { ActionResult } from "@/lib/action-state";

/** The sign-in form's state: today's result plus the code step. */
export interface LocalLoginState extends ActionResult {
  /** The account has a second factor: the form shows the code field — first asked (`required`) or asked again (`retry`). */
  otp?: "required" | "retry";
  /** The login as typed (never the password): a page re-rendered without JavaScript fills it in again. */
  login?: string;
}

/** Longest code the gateway accepts (raw, before whitespace is dropped) — `otp` of POST /api/v1/admin-login. */
export const OTP_INPUT_MAX = 64;

// The words below are English, as every new text (LANE-RULES); the catalog of takes them over later.
export { OTP_TEXT } from "../../../messages/panel-login";

/** `server_time` of a refusal as "2026-11-13 09:00:00 UTC" — only when it is a real ISO date; anything else is not shown. */
export function serverTimeText(v: unknown): string | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(v)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? `${new Date(t).toISOString().slice(0, 19).replace("T", " ")} UTC` : null;
}

/** Minutes of a lock from `retry_after` (seconds; body or header), at least one; unknown — the gateway's 15. */
export function lockMinutes(...seconds: unknown[]): number {
  const s = seconds.find((x): x is number => typeof x === "number" && Number.isFinite(x) && x > 0);
  return s === undefined ? 15 : Math.max(1, Math.ceil(s / 60));
}
