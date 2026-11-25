"use server";
import { actions as M } from "@/messages/ws-review";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { endedState } from "@/lib/action-ended";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { isUuid, multiline } from "@/lib/corrections";
import { text } from "@/lib/form";
import { meGw } from "@/lib/me-api";
import { ORG_DONE, ORG_PARTIAL, isOrgOp, type OrgDone, type OrgOp } from "@/lib/org-review";
import { PREVIEW_TEXT } from "@/lib/preview";
import { actionSession } from "@/lib/user-session";

const BACK = /^\/(review(\?c=\d{1,6})?|records\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const TEXT_MAX = 2000;

function route(op: OrgOp, id: string): { method: "POST" | "DELETE"; path: string } {
  switch (op) {
    case "useful": return { method: "POST", path: `/api/v1/records/${id}/org-review/useful` };
    case "unuseful": return { method: "DELETE", path: `/api/v1/records/${id}/org-review/useful` };
    case "wrong": return { method: "POST", path: `/api/v1/records/${id}/org-review/wrong` };
    case "unwrong": return { method: "DELETE", path: `/api/v1/records/${id}/org-review/wrong` };
    default: return { method: "POST", path: `/api/v1/me/org-review/${id}/${op}` };
  }
}

export async function wrongBody(form: FormData): Promise<{ body: { reason: string; text?: string } } | { error: string }> {
  const reason = text(form, "reason"), said = multiline(String(form.get("text") ?? ""));
  if (reason !== "wrong" && reason !== "not_for_all") return { error: M.chooseWrongOrNotForEveryone };
  if (reason === "wrong" && !said) return { error: M.explainWhatIsCorrectThisWillBecome };
  if ([...said].length > TEXT_MAX) return { error: M.tooLongMaximum2000Characters };
  return { body: { reason, ...(said ? { text: said } : {}) } };
}

export async function orgReviewAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  if (session.preview) return failState(PREVIEW_TEXT.previewDenied, { lines: [PREVIEW_TEXT.previewDeniedHint] });
  const id = text(form, "id"), op = text(form, "op"), back = text(form, "back");
  if (!isUuid(id)) return failState(M.recordNotFoundOrNotVisibleTo);
  if (!isOrgOp(op)) return failState(M.unknownAction);
  let body: unknown = {};
  if (op === "wrong") {
    const b = await wrongBody(form);
    if ("error" in b) return failState(b.error);
    body = b.body;
  }
  const { method, path } = route(op, id);
  const r = await meGw<{ deleted?: boolean }>(session.key, path, { method, ...(method === "POST" ? { body } : {}) });
  if (!r.ok) return endedState(r) ?? failState(r.message, r.hint ? { lines: [r.hint] } : {});
  const done: OrgDone = op === "delete" && r.data?.deleted === false ? "delete_partial" : op;
  const to = BACK.test(back) && op === "delete" && back.startsWith("/records/") ? "/review" : back;
  if (BACK.test(to)) redirect(`${to}${to.includes("?") ? "&" : "?"}org=${done}${to.startsWith("/records/") ? "#org-review" : ""}`);
  refresh();
  return done === "delete_partial" ? failState(ORG_PARTIAL.delete_partial) : okState(ORG_DONE[op]!);
}
