"use server";
import { refresh } from "next/cache";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { denyAuditor } from "@/lib/admin-guard";
import { gw } from "@/lib/api";
import { GatewayError } from "@/lib/gateway";
import { formatDay } from "@/lib/plain";
import { PANEL_DELETION_REQUESTS_MESSAGES } from "@/messages/panel-deletion-requests";
import { DELETION_REQUESTS_MESSAGES } from "@/messages/deletion-requests";

export async function adminDeleteMeetingAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const id = String(formData.get("request") ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return failState(PANEL_DELETION_REQUESTS_MESSAGES.missingRequestId);
  try {
    const out = await gw<{ record_id: string; purge_after: string; affected: number }>(`/api/v1/admin/deletion-requests/${id}/delete`, { method: "POST" });
    refresh();
    return okState(PANEL_DELETION_REQUESTS_MESSAGES.meetingMovedToTheOwner, { lines: [PANEL_DELETION_REQUESTS_MESSAGES.recordsAffected(out.affected, formatDay(out.purge_after))] });
  } catch (e) {
    if (e instanceof GatewayError) return failState(PANEL_DELETION_REQUESTS_MESSAGES.notDeleted(e.message));
    throw e;
  }
}

export async function adminKeepMeetingAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const id = String(formData.get("request") ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return failState(PANEL_DELETION_REQUESTS_MESSAGES.missingRequestId2);
  try {
    const out = await gw<{ record_id: string; closed: number; mailed: number }>(`/api/v1/admin/deletion-requests/${id}/keep`, { method: "POST" });
    refresh();
    return okState(PANEL_DELETION_REQUESTS_MESSAGES.meetingKept, { lines: [
      PANEL_DELETION_REQUESTS_MESSAGES.requestsClosed(out.closed),
      out.mailed ? PANEL_DELETION_REQUESTS_MESSAGES.emailsQueued(out.mailed) : PANEL_DELETION_REQUESTS_MESSAGES.noEmailsEmailIsDisabled,
    ] });
  } catch (e) {
    if (e instanceof GatewayError) return failState(PANEL_DELETION_REQUESTS_MESSAGES.notSaved(e.message));
    throw e;
  }
}
