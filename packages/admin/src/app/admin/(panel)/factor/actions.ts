"use server";
import { ACTIONS_TEXT } from "../../../../messages/panel-factor";
import { refresh } from "next/cache";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { approvalPendingOf, approvalPendingState } from "@/lib/admin-form";
import { denyAuditor } from "@/lib/admin-guard";
import { gw } from "@/lib/api";
import { GatewayError } from "@/lib/gateway";
import { RESET_REASON_MAX, RESET_REASON_MIN, resetRefusal } from "./view";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resetFactorAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const id = String(formData.get("person_id") ?? "");
  if (!UUID_RE.test(id)) return failState(ACTIONS_TEXT.noColleagueSelected);
  const reason = String(formData.get("reason") ?? "").trim();
  if (reason.length < RESET_REASON_MIN || reason.length > RESET_REASON_MAX)
    return failState(ACTIONS_TEXT.enterAReason, { fieldErrors: { reason: ACTIONS_TEXT.value1ToValue2Characters(RESET_REASON_MIN, RESET_REASON_MAX) } });
  if (formData.get("identity_confirmed") !== "on" || formData.get("manager_confirmed") !== "on")
    return failState(ACTIONS_TEXT.confirmBothChecks, { lines: [ACTIONS_TEXT.resettingTheFactorRequiresAnIdentityCheckNotBy] });
  let data: unknown;
  try {
    data = await gw<unknown>(`/api/v1/admin/people/${id.toLowerCase()}/factor/reset`,
      { method: "POST", body: { reason, identity_confirmed: true, manager_confirmed: true } });
  } catch (e) {
    if (e instanceof GatewayError) return failState(resetRefusal(e));
    throw e;
  }
  const pending = approvalPendingOf(data);
  if (pending) return approvalPendingState(pending);
  const d = (data ?? {}) as { sessions_revoked?: unknown; mailed?: unknown; confirmed_late?: unknown };
  const revoked = Number(d.sessions_revoked ?? 0) || 0;
  const late = d.confirmed_late === true;
  refresh();
  return okState(ACTIONS_TEXT.secondFactorReset, {
    lines: [late ? ACTIONS_TEXT.theSignInServiceRespondedLateTheResetSucceeded
        : revoked ? ACTIONS_TEXT.externalSignInSessionsClosedValue1(revoked) : ACTIONS_TEXT.thereWereNoActiveExternalSignInSessions,
      d.mailed === true ? ACTIONS_TEXT.anEmailWasSentToTheColleague
        : d.mailed === false ? ACTIONS_TEXT.theEmailWasNotSentTellTheColleagueAbout
        : ACTIONS_TEXT.emailDeliveryIsUnknownTellTheColleagueAboutThe,
      ACTIONS_TEXT.theyCanSetUpANewFactorInThe],
  });
}
