"use server";
import { actionsText as M } from "@/messages/ws-connect";

import { refresh } from "next/cache";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { isId, text } from "@/lib/form";
import { meGw } from "@/lib/me-api";
import { actionSession, sessionEndedState } from "@/lib/user-session";
import { PREVIEW_TEXT } from "@/lib/preview";

export async function revokeConnectionAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  if (session.preview) return failState(PREVIEW_TEXT.previewDenied, { lines: [PREVIEW_TEXT.previewDeniedHint] });
  const id = text(form, "id");
  if (!isId(id)) return failState(M.connectionIdIsMissing);
  const result = await meGw<{ revoked: boolean }>(session.key, `/api/v1/me/connections/${id}`, { method: "DELETE" });
  if (!result.ok) return result.code === "unauthorized" ? sessionEndedState() : failState(result.code === "response_lost" ? result.message : M.connectionWasNotDisconnected(result.message));
  refresh();
  return okState(M.disconnectedTheAgentSNextRequest);
}
