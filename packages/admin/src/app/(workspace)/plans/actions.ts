"use server";
import { refresh } from "next/cache";
import { endedState } from "@/lib/action-ended";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { isId, text } from "@/lib/form";
import { meGw } from "@/lib/me-api";
import { planProgress } from "@/lib/plans";
import { avText } from "@/lib/agent-view.messages";
import { PREVIEW_TEXT } from "@/lib/preview";
import type { PlanApplyResult, PlanDetail } from "@/lib/types";
import { actionSession } from "@/lib/user-session";
import { WS_PLANS_MESSAGES } from "@/messages/ws-plans";
import { PLANS_MESSAGES } from "@/messages/plans";

export type PlanApplyState = (NonNullable<ActionState> & { progress?: PlanApplyResult; retryAfter?: number }) | null;
const retryState = (retryAfter?: number): PlanApplyState => ({
  ...failState(WS_PLANS_MESSAGES.youHaveReachedTheAction, { lines: [WS_PLANS_MESSAGES.completedChangesAreKeptWithout] }),
  retryAfter: Math.max(1, Math.ceil(retryAfter ?? 60)),
});

export async function planItemAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  if (session.preview) return failState(PREVIEW_TEXT.previewDenied, { lines: [PREVIEW_TEXT.previewDeniedHint] });
  const id = text(form, "id"), recordId = text(form, "record_id"), op = text(form, "op");
  if (!isId(id) || !isId(recordId)) return failState(WS_PLANS_MESSAGES.missingPlanOrRecordId);
  if (op !== "include" && op !== "exclude") return failState(WS_PLANS_MESSAGES.unknownListAction);
  const r = await meGw<{ excluded: number }>(session.key, `/api/v1/me/plans/${id}/items`, { method: "PATCH", body: { [op]: [recordId] } });
  if (!r.ok) return endedState(r) ?? failState(WS_PLANS_MESSAGES.listUnchanged(r.message));
  refresh();
  return okState(op === "exclude" ? WS_PLANS_MESSAGES.thisRecordWillBeLeft : WS_PLANS_MESSAGES.recordReturnedToList);
}

export async function planApplyAction(_prev: PlanApplyState, form: FormData): Promise<PlanApplyState> {
  const session = await actionSession(); if ("ok" in session) return session;
  if (session.preview) return failState(PREVIEW_TEXT.previewDenied, { lines: [PREVIEW_TEXT.previewDeniedHint] });
  const id = text(form, "id");
  if (!isId(id)) return failState(WS_PLANS_MESSAGES.missingPlanId);
  const current = await meGw<PlanDetail>(session.key, `/api/v1/me/plans/${id}`, { query: { limit: 1 } });
  if (!current.ok) return current.code === "rate_limited" ? retryState(current.retryAfter) : endedState(current) ?? failState(WS_PLANS_MESSAGES.planNotApplied(current.message));
  if (current.data.op === "purge" && form.get("confirm") !== "on") return failState(WS_PLANS_MESSAGES.confirmThatRecoveryWillBe);
  // showing records to agents in bulk is confirmed the same way — by the op and the counts of the stored plan;
  // a plan with no record left to apply opens nothing and is closed without the tick
  if (current.data.op === "open" && current.data.counts.pending > 0 && form.get("confirm") !== "on") return failState(avText("plan_confirm_missing"));
  const r = await meGw<PlanApplyResult>(session.key, `/api/v1/me/plans/${id}/apply`, { method: "POST", body: {} });
  if (!r.ok) {
    refresh();
    if (r.code === "rate_limited") return retryState(r.retryAfter);
    const gone = endedState(r); if (gone) return gone;
    return failState(WS_PLANS_MESSAGES.changesStopped(r.message), { lines: [WS_PLANS_MESSAGES.completedChangesAreKeptRefresh] });
  }
  refresh();
  return { ...okState(planProgress(r.data)), progress: r.data };
}

export async function planCancelAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  if (session.preview) return failState(PREVIEW_TEXT.previewDenied, { lines: [PREVIEW_TEXT.previewDeniedHint] });
  const id = text(form, "id");
  if (!isId(id)) return failState(WS_PLANS_MESSAGES.missingPlanId2);
  const r = await meGw<{ status: "cancelled" }>(session.key, `/api/v1/me/plans/${id}/cancel`, { method: "POST", body: {} });
  if (!r.ok) return endedState(r) ?? failState(WS_PLANS_MESSAGES.planNotCancelled(r.message));
  refresh();
  return okState(WS_PLANS_MESSAGES.planCancelled);
}
