"use server";
import { TEXT } from "@/messages/panel-edge-export";
import { refresh } from "next/cache";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { denyAuditor } from "@/lib/admin-guard";
import { approvalPendingOf, approvalPendingState } from "@/lib/admin-form";
import { gw } from "@/lib/api";
import { unkillReasonLines } from "@/lib/edge-status";
import { GatewayError } from "@/lib/gateway";

const failed = (what: string, e: unknown): ActionState => {
  if (e instanceof GatewayError) return failState(TEXT.failure(what, e.message));
  throw e;
};

export async function exportOffAction(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  try {
    await gw("/api/v1/admin/settings", { method: "PUT", body: { items: [{ category: "edge", key: "export_enabled", value: false }] } });
  } catch (e) {
    return failed(TEXT.exportWasNotTurnedOff, e);
  }
  refresh();
  return okState(TEXT.edgeExportIsOff, { lines: [TEXT.theEdgeWillReceiveOneFinalFreshnessMarker, TEXT.theChangeWasRecordedInTheAuditLog] });
}

export async function recreateCanariesAction(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  try {
    await gw<{ requested_at: string }>("/api/v1/admin/edge-export/canaries", { method: "POST" });
  } catch (e) {
    return failed(TEXT.requestWasNotAccepted, e);
  }
  refresh();
  return okState(TEXT.requestAcceptedExistingCanariesWillBeRemovedAnd);
}

export async function unkillAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) return failState(TEXT.explainWhyYouAreClearingTheAutomaticShutdown, { fieldErrors: { reason: TEXT.whatYouInvestigatedAndWhySendingCanSafely } });
  if (reason.length > 500) return failState(TEXT.tooLong, { fieldErrors: { reason: TEXT.upTo500Characters } });
  const killedAt = String(formData.get("killed_at") ?? "");
  if (!killedAt || killedAt.length > 40 || !Number.isFinite(Date.parse(killedAt))) return failState(TEXT.refreshThePageTheAutomaticShutdownYouAre);
  let data: unknown;
  try {
    data = await gw<unknown>("/api/v1/admin/edge/unkill", { method: "POST", body: { reason, killed_at: killedAt } });
  } catch (e) {
    if (e instanceof GatewayError && e.code === "unkill_not_ready")
      return failState(TEXT.theAutomaticShutdownCannotBeClearedYet, { lines: unkillReasonLines((e.details as { reasons?: unknown } | undefined)?.reasons) });
    if (e instanceof GatewayError && e.code === "human_session_required")
      return failState(TEXT.onlyAnAdministratorInAPersonalSessionCan, { lines: [e.message] });
    if (e instanceof GatewayError && e.code === "admin_plane_required")
      return failState(TEXT.theAutomaticShutdownCannotBeClearedHere, { lines: [TEXT.thisRequiresTheAdminPlaneWhichIsNot] });
    return failed(TEXT.theAutomaticShutdownWasNotCleared, e);
  }
  const pending = approvalPendingOf(data);
  if (pending) return approvalPendingState(pending);
  refresh();
  return okState(TEXT.automaticShutdownClearedExportWillResumeIfEnabled, { lines: [TEXT.theActionAndReasonWereRecordedInThe] });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const holdRefusal = (what: string, e: unknown): ActionState => {
  if (e instanceof GatewayError && e.code === "human_session_required")
    return failState(TEXT.onlyAnAdministratorInAPersonalSessionCan2(String(what)), { lines: [e.message] });
  if (e instanceof GatewayError && e.code === "admin_plane_required")
    return failState(TEXT.thisRequiresTheAdminPlaneWhichIsNot2(String(what)));
  return failed(what, e);
};

export async function releaseCanaryHoldAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const id = String(formData.get("record_id") ?? "");
  if (!UUID_RE.test(id)) return failState(TEXT.recordIDIsMissing);
  let data: unknown;
  try {
    data = await gw<unknown>(`/api/v1/admin/edge-export/canary-holds/${id}/release`, { method: "POST", body: {} });
  } catch (e) {
    return holdRefusal(TEXT.theFindingWasNotReleased, e);
  }
  const pending = approvalPendingOf(data);
  if (pending) return approvalPendingState(pending);
  refresh();
  return okState((data as { released?: number } | null)?.released ? TEXT.findingReleasedTheRecordIsBeingCheckedAgain : TEXT.nothingToReleaseTheFindingHasAlreadyBeen);
}

export async function releaseAllCanaryHoldsAction(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  let data: unknown;
  try {
    data = await gw<unknown>("/api/v1/admin/edge-export/canary-holds/release", { method: "POST", body: {} });
  } catch (e) {
    return holdRefusal(TEXT.theFindingsWereNotReleased, e);
  }
  const pending = approvalPendingOf(data);
  if (pending) return approvalPendingState(pending);
  refresh();
  const n = Number((data as { released?: number } | null)?.released ?? 0);
  return okState(n ? TEXT.findingsReleased(String(n)) : TEXT.nothingToReleaseThereAreNoFindings, { lines: n ? [TEXT.theRecordsAreBeingCheckedAgainBeforeSending] : [] });
}
