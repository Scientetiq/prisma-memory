export const auditText = {
  workspace: "workspace",
  adminPanel: "admin panel",
  yes: "yes",
  no: "no",
  theMemoryAdministratorBecameTheCustodian: (value1: string | number): string => `${value1} — the memory administrator became the custodian`,
  overS: (value1: string | number): string => `over ${value1} s`,
  overMin: (value1: string | number): string => `over ${value1} min`,
  overH: (value1: string | number): string => `over ${value1} h`,
};

export const AUDIT_TIER_TITLES: Record<string, string> = { T0: "service key", T1: "trusted external key", T2: "personal key" };

export const DETAIL_LABELS: Record<string, string> = {
  tool: "tool", reason: "reason", result: "result", method: "request", session: "workspace session", session_id: "session",
  limit: "requested count", excluded: "excluded", rerank: "reranker", rerank_failed: "reranker failed", archive: "archive",
  search_id: "search", rank: "search rank", request_id: "request", author: "author", source: "source", server: "directory server",
  matched_by: "matched by", keys: "settings", ok: "succeeded", failed: "failed", failed_steps: "failed steps", via: "via",
  to: "recipient", code: "code", stage: "stage", login: "login", person: "person", records: "records", affected: "affected",
  batch: "batch", action: "action", filter: "filter", reset: "reset", waiting: "waiting for the model", kicked: "queued",
  queued: "queued", mail_id: "email", host: "server", port: "port", security: "encryption", latency_ms: "response time, ms",
  closed: "closed", record_id: "record", move_id: "move", new_move_id: "new move", reason_code: "request reason",
  by_operator: "custodian is the memory administrator", manager_login: "head from the org table", renamed: "email assigned to",
};

/** Reasons for ending custody, changing custodians and returning meetings. */
export const OP_REASON_TITLES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  custody_end: { reactivated: "employee reactivated", deleted: "personal records deleted when due", policy: "according to settings", orphan: "according to settings" },

  // A corrected department head is distinct from a policy recalculation.
  custody_change: { correction: "head corrected in the org table", custodian_dismissed: "previous custodian departed" },
  organizer_return: { reactivated: "organizer returned to the company", wait: "configured by an administrator" },
};
