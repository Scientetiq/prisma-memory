"use server";
import { unprocessedActions as m } from "@/messages/panel-unprocessed";
import { refresh } from "next/cache";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { denyAuditor } from "@/lib/admin-guard";
import { approvalPendingOf, approvalPendingState } from "@/lib/admin-form";
import { gw } from "@/lib/api";
import { GatewayError } from "@/lib/gateway";
import { formTz, wallToIso } from "@/lib/local-datetime";
import { probeLines } from "@/lib/converter-state";
import { retryLines } from "@/lib/llm-state";
import type { ConverterCheckNowResponse, ConverterProbeResponse, RetryResponse } from "@/lib/types";

const text = (fd: FormData, name: string): string => String(fd.get(name) ?? "").trim();
const RETRY_STAGES = ["converted", "indexed", "summary", "events", "entities", "described"];

export async function retryRecordAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const id = text(formData, "id");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return failState(m.recordIdIsMissing);
  try {
    const out = await gw<RetryResponse>("/api/v1/admin/stages/retry", { method: "POST", body: { record_ids: [id], include_waiting: true, now: true } });
    refresh();
    return out.reset || out.waiting || out.waiting_converter ? okState(m.stagesQueuedForRetry, { lines: retryLines(out) }) : okState(m.theRecordHasNoFailedOrWaitingStages);
  } catch (e) {
    if (e instanceof GatewayError) return failState(m.retryNotStarted(e.message));
    throw e;
  }
}

export async function retryFailedAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const stage = text(formData, "stage"), cls = text(formData, "class"), error = text(formData, "error_contains"), since = text(formData, "failed_since");
  const body: Record<string, unknown> = {};
  const withWaiting = formData.get("include_waiting") === "on";
  if (withWaiting) body.include_waiting = true;
  const withTerminal = formData.get("include_terminal") === "on";
  if (!withTerminal) body.skip_terminal = true;
  if (stage) { if (!RETRY_STAGES.includes(stage)) return failState(m.unknownStage); body.stage = stage; }
  if (cls) { if (cls !== "open" && cls !== "closed") return failState(m.classOpenOrClosed); body.class = cls; }
  if (error) { if (error.length > 200) return failState(m.errorSubstringAtMostCharacters); body.error_contains = error; }
  if (since) {
    // "by your clock", as the hint of the field promises: the browser zone (client_tz of ActionForm or the hidden tz field),
    // without it the zone of the installation
    const iso = wallToIso(since, formTz(formData));
    if (!iso) return failState(m.failedAfterEnterADateAndTime);
    body.failed_since = iso;
  }
  try {
    const out = await gw<RetryResponse>("/api/v1/admin/stages/retry", { method: "POST", body, timeoutMs: 120_000 });
    refresh();
    const started = !!(out.reset || out.waiting);
    const message = m.retryResult(stage, cls, error, since, withTerminal, withWaiting, started);
    return started ? okState(message, { lines: retryLines(out) }) : okState(message);
  } catch (e) {
    if (e instanceof GatewayError) return failState(m.retryNotStarted(e.message));
    throw e;
  }
}

export async function retryMoveAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const id = text(formData, "id");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return failState(m.moveIdIsMissing);
  try {
    const out = await gw(`/api/v1/admin/class-moves/${encodeURIComponent(id)}/retry`, { method: "POST" });
    refresh();
    const pending = approvalPendingOf(out);
    if (pending) return approvalPendingState(pending);
    return okState(m.moveRestarted, { lines: [m.theWorkerWillPickItUpImmediatelyIf] });
  } catch (e) {
    if (e instanceof GatewayError) return failState(m.retryNotStarted(e.message));
    throw e;
  }
}

export async function reconcileAction(): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  try {
    const out = await gw<{ queued: boolean }>("/api/v1/admin/maintenance/reconcile", { method: "POST" });
    refresh();
    return out.queued ? okState(m.reconcilerStarted, { lines: [m.theResultWillAppearInTheClassConsistency] }) : failState(m.workerQueueUnavailableTheReconcilerWillRunOn);
  } catch (e) {
    if (e instanceof GatewayError) return failState(m.notStarted(e.message));
    throw e;
  }
}

export async function clearHoldsAction(): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  try {
    const out = await gw<{ removed: number }>("/api/v1/admin/llm-gate/hold", { method: "DELETE", query: { force: "1" } });
    refresh();
    return out.removed ? okState(m.pauseCleared, { lines: [m.modelRequestsWillResumeImmediatelyIfTheModel] }) : okState(m.thereAreNoPausesThatCanBeCleared);
  } catch (e) {
    if (e instanceof GatewayError) return failState(m.pauseNotCleared(e.message));
    throw e;
  }
}

export async function probeNowAction(): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  try {
    await gw("/api/v1/admin/llm-gate/probe", { method: "POST" });
    refresh();
    return okState(m.theNextRequestWillGoToTheModel, { lines: [m.ifTheModelReportsBusyAgainThePause] });
  } catch (e) {
    if (e instanceof GatewayError) return failState(m.failed(e.message));
    throw e;
  }
}

export async function holdConverterAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const scope = text(formData, "scope");
  if (scope !== "new" && scope !== "all") return failState(m.unknownPause);
  try {
    await gw("/api/v1/admin/converter/hold", { method: "POST", body: { scope } });
    refresh();
    return okState(scope === "new" ? m.newDocumentsPaused : m.conversionPaused,
                   { lines: [scope === "new" ? m.documentsAlreadySentToTheConverterWillFinish : m.documentsAreWaitingWithoutUsingAttemptsClickResume] });
  } catch (e) {
    if (e instanceof GatewayError) return failState(m.pauseNotSet(e.message));
    throw e;
  }
}

export async function resumeConverterAction(): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  try {
    const out = await gw<{ woken?: number }>("/api/v1/admin/converter/resume", { method: "POST" });
    refresh();
    return okState(m.conversionResumed, { lines: [out.woken ? m.waitingDocumentsWillContinueNow(out.woken) : m.documentsWillRunInQueueOrder] });
  } catch (e) {
    if (e instanceof GatewayError) return failState(m.notResumed(e.message));
    throw e;
  }
}

export async function probeConverterAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const confirm = formData.get("confirm_new_principal") === "on";
  try {
    const out = await gw<ConverterProbeResponse>("/api/v1/admin/converter/probe", { method: "POST", body: confirm ? { confirm_new_principal: true } : {}, timeoutMs: 45_000 });
    refresh();
    return out.ok ? okState(out.confirmed ? m.connectionIsWorkingNewAccountConfirmed : m.connectionIsWorking, { lines: probeLines(out).slice(1) })
                  : failState(m.probeFailure(out.text, out.missing_roles ?? [], out.woken ?? 0));
  } catch (e) {
    if (e instanceof GatewayError) return failState(m.checkNotCompleted(e.message));
    throw e;
  }
}

export async function checkConverterNowAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const id = text(formData, "id");
  if (id && !/^[0-9a-f-]{36}$/i.test(id)) return failState(m.recordIdIsMissing);
  try {
    const out = await gw<ConverterCheckNowResponse>("/api/v1/admin/converter/check-now", { method: "POST", body: id ? { record_id: id } : {}, timeoutMs: 60_000 });
    refresh();
    if (!out.woken) return okState(id ? m.theRecordIsNoLongerWaitingForThe : m.noRecordsAreWaitingForTheConverterNothing);
    const lines = [m.ifTheConverterIsPausedUnavailableOrBusy];
    if (out.left) lines.push(m.theRemainingWaitingDocumentsWillBeCheckedAutomatically(out.left));
    return okState(id ? m.checkingNow : m.checkingNow2(out.woken), { lines });
  } catch (e) {
    if (e instanceof GatewayError) return failState(m.failed(e.message));
    throw e;
  }
}
