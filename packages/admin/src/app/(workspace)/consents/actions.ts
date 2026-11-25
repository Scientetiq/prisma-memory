"use server";
import { actionsText as M } from "@/messages/ws-consents";

import { refresh } from "next/cache";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { endedState } from "@/lib/action-ended";
import { isId, text } from "@/lib/form";
import { formatDay } from "@/lib/plain";
import { meGw } from "@/lib/me-api";
import { PREVIEW_TEXT } from "@/lib/preview";
import { actionSession } from "@/lib/user-session";
import { consentTexts, type OboConsent } from "@/app/admin/(panel)/obo-consents/view";

export async function grantConsentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  if (session.preview) return failState(PREVIEW_TEXT.previewDenied, { lines: [PREVIEW_TEXT.previewDeniedHint] });
  const service = text(formData, "service_id");
  if (!isId(service)) return failState(M.noServiceSelected);
  const res = await meGw<OboConsent>(session.key, "/api/v1/me/obo-consents", { method: "POST", body: { service_id: service } });
  if (!res.ok) return (await endedState(res)) ?? failState(res.status === 404 ? M.thisServiceNoLongerReadsOn : res.message);
  refresh();
  return okState(M.allowedCanReadMemoryOnYour(res.data.service.name),
    { lines: res.data.expires_at ? [M.untilRenewPermissionAfterwardsIfNeeded(formatDay(res.data.expires_at))] : [] });
}

export async function revokeConsentAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  if (session.preview) return failState(PREVIEW_TEXT.previewDenied, { lines: [PREVIEW_TEXT.previewDeniedHint] });
  const id = text(formData, "id");
  if (!isId(id)) return failState(M.noConsentId);
  const res = await meGw<unknown>(session.key, `/api/v1/me/obo-consents/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) return (await endedState(res)) ?? failState(res.status === 404 ? M.consentHasAlreadyEnded : res.message);
  refresh();
  return okState(consentTexts(text(formData, "mode")).revokedOk);
}
