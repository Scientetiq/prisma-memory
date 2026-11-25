import type { ApprovalState } from "../../app/admin/(panel)/approvals/view";

export const DONE: Readonly<Record<"approve" | "reject" | "execute" | "cancel", string>> = {
    approve: "Request signed: the requester can execute it",
    reject: "Request rejected",
    execute: "Request executed",
    cancel: "Request cancelled",
};

export const STATE_FILTERS: ReadonlyArray<{ value: ApprovalState | "all"; title: string }> = [
    { value: "pending", title: "Awaiting signature" }, { value: "approved", title: "Signed, awaiting execution" }, { value: "executed", title: "Executed" },
    { value: "rejected", title: "Rejected" }, { value: "expired", title: "Expired" }, { value: "cancelled", title: "Cancelled" }, { value: "all", title: "All" },
];

export const STATE_BADGES: Readonly<Record<ApprovalState, { title: string; tone: "info" | "ok" | "muted" | "danger" | "warn" }>> = {
    pending: { title: "awaiting signature", tone: "info" },
    approved: { title: "signed — the requester can execute it", tone: "warn" },
    executed: { title: "executed", tone: "ok" },
    rejected: { title: "rejected", tone: "danger" },
    expired: { title: "expired", tone: "muted" },
    cancelled: { title: "cancelled", tone: "muted" },
};

export const APPROVAL_ERRORS: Readonly<Record<string, string>> = {
    approval_self: "You cannot sign your own request: another person must sign",
    approval_role: "This request needs a different role to sign",
    approval_state: "Request already signed, rejected, cancelled or executed — refresh the page",
    approval_expired: "Request expired — submit the action again",
    approval_mismatch: "Request does not match the action: execution cancelled; submit the action again",
    approval_not_found: "Request not found",
    stepup_required: "Touch your security key: signing requires a recent touch (sign in again with your key)",
};

export const ACTIONS_TEXT = {
  noRequestID: "No request ID",
  keySecret: "Key secret",
  sessionToken: "Session token",
  actionReturnedValue1: (value1: string | number): string => `Action returned: ${value1}`,
  shownOnceCopyItNowNobodyCanViewIt: "Shown once: copy it now; nobody can view it later",
  responseValue1: (value1: string | number): string => `response ${value1}`,
  requestedActionFailedValue1: (value1: string | number): string => `Requested action failed: ${value1}`,
  requestClosedSubmitTheActionAgainIfNeeded: "Request closed — submit the action again if needed",
  notCompletedResponseValue1: (value1: string | number): string => `Not completed: response ${value1}`,
};

export const PAGE_TEXT = {
  lead: "In advanced security mode, actions that expand access require another person’s signature — an administrator or security auditor. The requester executes the signed request. Signatures expire after admin.second_signature_ttl_hours (24 hours). In basic mode, actions run immediately without requests; the audit log notes when an advanced mode signature would have been needed.",
  secondSignatures: "Second signatures",
  request: "Request",
  actionAdminAPIRoute: "Action (admin API route)",
  tag1Value2Tag1Tag3NoValue4Tag3: "<tag1>{value2}</tag1> · <tag3>No. {value4}</tag3>",
  status: "Status",
  rejectedBy: "rejected by",
  signedBy: "signed by",
  executedValue1: "executed {value1}",
  requestedBy: "Requested by",
  expiry: "Expiry",
  actions: "Actions",
  sign: "Sign",
  signThisRequest: "Sign this request?",
  value1SigningAllowsTheRequesterToExecuteTheAction: (value1: string | number): string => `${value1}. Signing allows the requester to execute the action.`,
  sign2: "Sign",
  reject: "Reject",
  execute: "Execute",
  executeTheSignedRequest: "Execute the signed request?",
  execute2: "Execute",
  cancel: "Cancel",
  request2: "Request",
  status2: "Status",
  requestedBy2: "Requested by",
  signBy: "Sign by",
  actions2: "Actions",
  secondSignatures2: "Second signatures",
  linkedRequest: "Linked request",
  request3: "request",
  requestsByStatus: "Requests by status",
  requests: "Requests",
  requests2: "requests",
  noRequests: "No requests.",
};
