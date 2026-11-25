"use server";
import { recheckActionsText as M } from "@/messages/ws-records";

import { refresh } from "next/cache";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { isId, text } from "@/lib/form";
import { meGw } from "@/lib/me-api";
import { PREVIEW_TEXT } from "@/lib/preview";
import { actionSession } from "@/lib/user-session";
import { RECHECK_BLOCK } from "./recheck-view";

export async function recheckKeepAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  if (session.preview) return failState(PREVIEW_TEXT.previewDenied, { lines: [PREVIEW_TEXT.previewDeniedHint] });
  const id = text(formData, "id");
  if (!isId(id)) return failState(M.recordIdIsMissing);
  const res = await meGw<{ id: string; state: string }>(session.key, `/api/v1/records/${id}/recheck-keep`, { method: "POST" });
  if (!res.ok) return failState(M.failure(res.message));
  refresh();
  return okState(RECHECK_BLOCK.done);
}
