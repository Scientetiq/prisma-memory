import { STATE_FILTERS, STATE_BADGES, APPROVAL_ERRORS } from "../../../../messages/panel-approvals";

export type ApprovalState = "pending" | "approved" | "executed" | "rejected" | "expired" | "cancelled";
export interface ApprovalSummary {
  id: string; state: ApprovalState; action: string; summary: string; requested_by: string | null; requested_at: string; expires_at: string;
  decided_by: string | null; decided_at: string | null; executed_at: string | null;
}

export { STATE_FILTERS };

export { STATE_BADGES };

export function stateFilter(raw: string): ApprovalState | "all" {
  return STATE_FILTERS.some((f) => f.value === raw) ? (raw as ApprovalState | "all") : "pending";
}

export function approvalButtons(a: Pick<ApprovalSummary, "state" | "requested_by">, me: { login: string | null; role: string | null }): Array<"approve" | "reject" | "execute" | "cancel"> {
  const mine = Boolean(me.login && a.requested_by && a.requested_by === me.login);
  const out: Array<"approve" | "reject" | "execute" | "cancel"> = [];
  if (a.state === "pending" && !mine) out.push("approve", "reject");
  if (mine && me.role === "memory_admin") {
    if (a.state === "approved") out.push("execute");
    if (a.state === "pending" || a.state === "approved") out.push("cancel");
  }
  return out;
}

export { APPROVAL_ERRORS };
