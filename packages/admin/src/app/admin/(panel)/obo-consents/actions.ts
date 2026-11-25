"use server";
import { ACTIONS_TEXT } from "../../../../messages/panel-obo-consents";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { denyAuditor } from "@/lib/admin-guard";
import { call } from "@/lib/gateway";
import { clearSessionCookie, requireSession } from "@/lib/session";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function revokeConsentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const id = String(formData.get("id") ?? "");
  if (!UUID_RE.test(id)) return failState(ACTIONS_TEXT.noConsentID);
  const session = await requireSession();
  const { status, data } = await call(`/api/v1/admin/obo-consents/${id}`, { method: "DELETE", token: session.token });
  if (status === 401) { await clearSessionCookie(); redirect("/admin/login?expired=1"); }
  refresh();
  if (status === 204) return okState(ACTIONS_TEXT.consentRevoked, { lines: [ACTIONS_TEXT.theServiceCanNoLongerReadOnBehalfOf] });
  const body = (data ?? {}) as { message?: string };
  return failState(status === 404 ? ACTIONS_TEXT.consentAlreadyClosed : body.message ?? ACTIONS_TEXT.notRevokedResponseValue1(status));
}
