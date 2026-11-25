"use server";
// Actions of "What my agent sees": the person's default for new records in the personal space and a bulk
// "show to agents" plan. Both are a person's own decisions: a preview session is refused before any call. The plan is made by
// the gateway (POST /api/v1/me/agent-view/open-plan) and applied on its page — nothing is opened here.
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { endedState } from "@/lib/action-ended";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { OPEN_PLAN_PATH, UPLOAD_DEFAULT_PATH, defaultTitle, parseDefaultChoice, type OpenPlanCreated, type UploadDefault } from "@/lib/agent-view";
import { avText } from "@/lib/agent-view.messages";
import { isId } from "@/lib/form";
import { meGw } from "@/lib/me-api";
import { PREVIEW_TEXT } from "@/lib/preview";
import { actionSession } from "@/lib/user-session";

export async function setUploadDefaultAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  if (session.preview) return failState(PREVIEW_TEXT.previewDenied, { lines: [PREVIEW_TEXT.previewDeniedHint] });
  const value = parseDefaultChoice(form.get("value"));
  if (value === undefined) return failState(avText("default_invalid"));
  const r = await meGw<UploadDefault>(session.key, UPLOAD_DEFAULT_PATH, { method: "PUT", body: { value } });
  if (!r.ok) return endedState(r) ?? failState(avText("not_saved", { message: r.message }));
  refresh();
  const lines = [avText("default_existing")];
  if (!r.data.open_check_enabled) lines.unshift(avText("default_check_off"));
  return okState(value === null ? avText("default_saved_admin", { value: defaultTitle(r.data.instance_default) })
    : avText(value === "open" ? "default_saved_open" : "default_saved_closed"), { lines });
}

/** Makes the plan and opens its page; the plan page shows the list, the readers and the confirmation. */
export async function createOpenPlanAction(_prev: ActionState, _form: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  if (session.preview) return failState(PREVIEW_TEXT.previewDenied, { lines: [PREVIEW_TEXT.previewDeniedHint] });
  const r = await meGw<OpenPlanCreated>(session.key, OPEN_PLAN_PATH, { method: "POST", body: {} });
  if (!r.ok) {
    refresh();
    return endedState(r) ?? failState(avText("plan_not_made", { message: r.message }));
  }
  if (r.data.status === "empty") { refresh(); return failState(avText("plan_empty")); }
  if (!isId(r.data.plan_id ?? "")) return failState(avText("plan_bad_answer"));
  redirect(`/plans/${r.data.plan_id}`);
}
