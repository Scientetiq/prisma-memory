"use server";
import { ACTIONS_TEXT } from "../../../../messages/panel-security-mode";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { denyAuditor } from "@/lib/admin-guard";
import { call } from "@/lib/gateway";
import { formatDateTime, zoneLabel } from "@/i18n/format";
import { instanceTz } from "@/i18n/runtime";
import { clearSessionCookie, requireSession } from "@/lib/session";
import { DOWNGRADE_REASON_MIN, SM_ERROR_TEXTS } from "./view";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ATTEST_KINDS = new Set(["device_binding", "it_instructions", "gitlab_protected", "human_signer", "docker_user_filter", "machine_keys_destroyed", "host_hardened",
  "bridge_vm", "edge_proxy_dedicated", "release_signers_human", "e5_hostile_bridge"]);

async function post(path: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const session = await requireSession();
  const { status, data } = await call(path, { method: "POST", body, token: session.token, timeoutMs: 60_000 });
  if (status === 401) { await clearSessionCookie(); redirect("/admin/login?expired=1"); }
  refresh();
  return { status, data: (data ?? {}) as Record<string, unknown> };
}

const refused = (status: number, d: Record<string, unknown>): ActionState =>
  failState(SM_ERROR_TEXTS[String(d.code ?? "")] ?? (typeof d.message === "string" ? d.message : ACTIONS_TEXT.notCompletedResponseValue1(status)));

export async function requestDowngradeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const reason = String(formData.get("reason") ?? "").trim();
  if ([...reason].length < DOWNGRADE_REASON_MIN) return failState(ACTIONS_TEXT.explainTheReasonForReturningAtLeastValue1Characters(DOWNGRADE_REASON_MIN));
  if (formData.get("ack") !== "on") return failState(ACTIONS_TEXT.confirmThatYouUnderstandAfterReturningThereAreNo);
  const { status, data } = await post("/api/v1/admin/security-mode/downgrade", { reason: [...reason].slice(0, 500).join("") });
  if (status === 201) {
    const tz = instanceTz();
    const nb = typeof data.not_before === "string" ? formatDateTime(data.not_before, tz) : "—";
    return okState(ACTIONS_TEXT.requestToReturnToBasicSubmitted, { lines: [ACTIONS_TEXT.anotherMemoryAdministratorMustSignIt, ACTIONS_TEXT.canBeExecutedNoEarlierThanValue1Value2(nb, zoneLabel(tz)), ACTIONS_TEXT.aHighAlertWasSentToAllAdministrators] });
  }
  return refused(status, data);
}

async function onPending(op: "approve" | "approve-retire" | "cancel" | "execute", formData: FormData): Promise<ActionState> {
  if (op !== "cancel") { const denied = await denyAuditor(); if (denied) return denied; }
  const id = String(formData.get("id") ?? "");
  if (!UUID_RE.test(id)) return failState(ACTIONS_TEXT.noRequestID);
  const { status, data } = await post(`/api/v1/admin/security-mode/downgrade/${id}/${op}`, {});
  if (status >= 200 && status < 300) {
    if (op === "approve") return okState(ACTIONS_TEXT.requestSignedItCanBeExecutedAfterTheDelay);
    if (op === "approve-retire") return okState(ACTIONS_TEXT.requestSignedWithRetirementDocumentValue1ItCanBe(String(data.approved_anchors_serial ?? "—")));
    if (op === "cancel") return okState(Number(data.cancelled ?? 0) ? ACTIONS_TEXT.returnRequestCancelled : ACTIONS_TEXT.noOpenRequestRemains);
    return okState(ACTIONS_TEXT.modeReturnedToBasic, { lines: [ACTIONS_TEXT.secondSignatureRequestsCancelledValue1(Number(data.approvals_cancelled ?? 0)),
      ACTIONS_TEXT.flagsRestoredToTheirPreviousValuesValue1(Array.isArray(data.flags_restored) ? data.flags_restored.length : 0)] });
  }
  return refused(status, data);
}

export async function approveDowngradeAction(_prev: ActionState, formData: FormData): Promise<ActionState> { return onPending("approve", formData); }
export async function approveRetireDowngradeAction(_prev: ActionState, formData: FormData): Promise<ActionState> { return onPending("approve-retire", formData); }
export async function cancelDowngradeAction(_prev: ActionState, formData: FormData): Promise<ActionState> { return onPending("cancel", formData); }
export async function executeDowngradeAction(_prev: ActionState, formData: FormData): Promise<ActionState> { return onPending("execute", formData); }

export async function attestAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const kind = String(formData.get("kind") ?? "");
  if (!ATTEST_KINDS.has(kind)) return failState(ACTIONS_TEXT.selectWhatYouAreConfirming);
  const subjects = String(formData.get("subjects") ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  if (!subjects.length || subjects.length > 50) return failState(ACTIONS_TEXT.list1To50SubjectsOnePerLine);
  const note = String(formData.get("note") ?? "").trim().slice(0, 300);
  const { status, data } = await post("/api/v1/admin/security-attestations", { kind, subjects, ...(note ? { note } : {}) });
  if (status === 201) return okState(ACTIONS_TEXT.confirmedValue1(Number(data.attested ?? subjects.length)));
  return refused(status, data);
}
