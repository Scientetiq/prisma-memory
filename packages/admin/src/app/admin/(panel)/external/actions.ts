"use server";
import { refresh } from "next/cache";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { approvalPendingOf, approvalPendingState } from "@/lib/admin-form";
import { denyAuditor } from "@/lib/admin-guard";
import { gw } from "@/lib/api";
import { GatewayError } from "@/lib/gateway";
import { PANEL_EXTERNAL_MESSAGES } from "@/messages/panel-external";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const failed = (what: string, e: unknown): ActionState => {
  if (e instanceof GatewayError) {
    if (e.code === "admin_plane_required") return failState(PANEL_EXTERNAL_MESSAGES.thisActionUsesTheAdmin(what));
    if (e.status === 404) return failState(PANEL_EXTERNAL_MESSAGES.notFoundRefreshThePage(what));
    return failState(`${what}: ${e.message}`);
  }
  throw e;
};

export async function disablePersonAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const id = String(formData.get("person_id") ?? "");
  if (!UUID_RE.test(id)) return failState(PANEL_EXTERNAL_MESSAGES.noColleagueSelected);
  let data: unknown;
  try {
    data = await gw<unknown>(`/api/v1/admin/external/people/${id}/disable`, { method: "POST", body: {} });
  } catch (e) {
    return failed(PANEL_EXTERNAL_MESSAGES.notDisabled, e);
  }
  const pending = approvalPendingOf(data);
  if (pending) return approvalPendingState(pending);
  refresh();
  return (data as { disabled?: boolean } | null)?.disabled
    ? okState(PANEL_EXTERNAL_MESSAGES.externalAccessDisabled, { lines: [PANEL_EXTERNAL_MESSAGES.theColleagueSExternalConnections] })
    : okState(PANEL_EXTERNAL_MESSAGES.accessWasAlreadyDisabled);
}

export async function confirmRequestAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const id = String(formData.get("id") ?? "");
  if (!UUID_RE.test(id)) return failState(PANEL_EXTERNAL_MESSAGES.noRequestSelected);
  let data: unknown;
  try {
    data = await gw<unknown>("/api/v1/admin/external/confirmations", { method: "POST", body: { id } });
  } catch (e) {
    if (e instanceof GatewayError && e.status === 404) return failState(PANEL_EXTERNAL_MESSAGES.thisRequestHasAlreadyBeen);
    if (e instanceof GatewayError && e.code === "human_session_required") return failState(PANEL_EXTERNAL_MESSAGES.notConfirmedIdentityCanOnly);
    if (e instanceof GatewayError && e.code === "own_request") return failState(PANEL_EXTERNAL_MESSAGES.notConfirmedYouCannotConfirm);
    return failed(PANEL_EXTERNAL_MESSAGES.notConfirmed, e);
  }
  const pending = approvalPendingOf(data);
  if (pending) return approvalPendingState(pending);
  refresh();
  return okState(PANEL_EXTERNAL_MESSAGES.identityConfirmed, { lines: [PANEL_EXTERNAL_MESSAGES.theColleagueHasHoursTo] });
}

export async function pauseAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const minutes = Number(formData.get("minutes"));
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return failState(PANEL_EXTERNAL_MESSAGES.pauseMustBeBetweenAnd, { fieldErrors: { minutes: PANEL_EXTERNAL_MESSAGES.aWholeNumberOfMinutes } });
  let data: unknown;
  try {
    data = await gw<unknown>("/api/v1/admin/external/pause", { method: "POST", body: { minutes } });
  } catch (e) {
    return failed(PANEL_EXTERNAL_MESSAGES.pauseNotSet, e);
  }
  const pending = approvalPendingOf(data);
  if (pending) return approvalPendingState(pending);
  refresh();
  return okState(PANEL_EXTERNAL_MESSAGES.externalSignInPausedFor(minutes), { lines: [PANEL_EXTERNAL_MESSAGES.newExternalSignInsAre] });
}

export async function liftPauseAction(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  let data: unknown;
  try {
    data = await gw<unknown>("/api/v1/admin/external/pause", { method: "DELETE" });
  } catch (e) {
    return failed(PANEL_EXTERNAL_MESSAGES.pauseNotLifted, e);
  }
  const pending = approvalPendingOf(data);
  if (pending) return approvalPendingState(pending);
  refresh();
  return (data as { lifted?: number } | null)?.lifted
    ? okState(PANEL_EXTERNAL_MESSAGES.manualPauseLifted)
    : okState(PANEL_EXTERNAL_MESSAGES.noManualPauseIsActive, { lines: [PANEL_EXTERNAL_MESSAGES.anAutomaticPauseAfterIncorrect] });
}
