"use server";
import { DONE, ACTIONS_TEXT } from "../../../../messages/panel-approvals";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { denyAuditor } from "@/lib/admin-guard";
import { call } from "@/lib/gateway";
import { clearSessionCookie, requireSession } from "@/lib/session";
import { APPROVAL_ERRORS } from "./view";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Op = "approve" | "reject" | "execute" | "cancel";


async function run(op: Op, formData: FormData): Promise<ActionState> {
  if (op === "execute" || op === "cancel") { const denied = await denyAuditor(); if (denied) return denied; }
  const id = String(formData.get("id") ?? "");
  if (!UUID_RE.test(id)) return failState(ACTIONS_TEXT.noRequestID);
  const session = await requireSession();
  const { status, data } = await call(`/api/v1/admin/approvals/${id}/${op}`, { method: "POST", body: {}, token: session.token, timeoutMs: 60_000 });
  if (status === 401) { await clearSessionCookie(); redirect("/admin/login?expired=1"); }
  refresh();
  const body = (data ?? {}) as { code?: string; message?: string; state?: string };
  if (status >= 200 && status < 300) {
    if (op === "execute") {
      const d = (data ?? {}) as { secret?: unknown; token?: unknown };
      const once = typeof d.secret === "string" ? { label: ACTIONS_TEXT.keySecret, value: d.secret } : typeof d.token === "string" ? { label: ACTIONS_TEXT.sessionToken, value: d.token } : null;
      return okState(DONE.execute, { lines: [ACTIONS_TEXT.actionReturnedValue1(status)],
        ...(once ? { secret: { ...once, warning: ACTIONS_TEXT.shownOnceCopyItNowNobodyCanViewIt } } : {}) });
    }
    return okState(DONE[op]);
  }
  if (op === "execute" && status !== 409 && status !== 403 && status !== 404)
    return failState(ACTIONS_TEXT.requestedActionFailedValue1(body.message ?? ACTIONS_TEXT.responseValue1(status)), { lines: [ACTIONS_TEXT.requestClosedSubmitTheActionAgainIfNeeded] });
  return failState(APPROVAL_ERRORS[body.code ?? ""] ?? body.message ?? ACTIONS_TEXT.notCompletedResponseValue1(status));
}

export async function approveAction(_prev: ActionState, formData: FormData): Promise<ActionState> { return run("approve", formData); }
export async function rejectAction(_prev: ActionState, formData: FormData): Promise<ActionState> { return run("reject", formData); }
export async function executeAction(_prev: ActionState, formData: FormData): Promise<ActionState> { return run("execute", formData); }
export async function cancelAction(_prev: ActionState, formData: FormData): Promise<ActionState> { return run("cancel", formData); }
