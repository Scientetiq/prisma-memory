import type { EdgeExportStatus, RecordEdgeStatus } from "../../lib/edge-status";

export const EDGE_STATE_TEXT: Readonly<Record<RecordEdgeStatus["state"], string>> = {
  shown: "Outside: visible",
  held: "Not visible outside",
  close_confirmed: "Closure requested and confirmed by the edge",
  close_failed: "Not visible outside: closure failed",
  not_shown: "Not visible outside",
  revoked: "No longer visible outside",
};

export const EDGE_REASON_TEXT: Readonly<Record<string, string>> = {
  close_requested: "you or the space owner asked to close the record",
  hidden: "the record was hidden",
  deleted: "the record was moved to Trash",
  open_check: "the check found text that cannot be shown",
  held: "the file did not pass the check before showing",
  org_review: "Company knowledge curators held the record",
  audience_people: "the record is visible only to selected people",
  restore_tomb: "memory was restored from a backup",
  manual: "an administrator held the record",

  canary_trip: "a canary marker was found in the record on the edge",
};

export const EDGE_SHOW = {
  button: "Show outside again",
  hint: "The record will be checked again before showing outside, as if it were new. It will appear there only if it passes.",
  confirm: "Show this record outside again? Colleagues’ agents connected externally will see it if they already have internal access.",
  done: "Done: the record is being checked again before showing outside",
  nothing: "Nothing to release: the record is not held",
  failed: "Could not complete the action",
} as const;

export const KILL_REASON_TEXT: Readonly<Record<string, string>> = {
  canary: "a closed canary record or its marker was found on the edge",
  reconcile_extra_twice: "reconciliation found extra data outside twice in a row",
  canary_pre_send: "a canary record was included in an outgoing batch",
  restore: "the database was restored from a backup — export is paused until recovery is verified",
};

export const UNKILL_REASON_TEXT: Readonly<Record<string, string>> = {
  not_killed: "no automatic shutdown — nothing to clear",
  reconcile_none: "no reconciliation has run yet",
  reconcile_before_kill: "no reconciliation has run since the automatic shutdown — it runs automatically; wait up to 15 minutes",
  reconcile_stale: "the last reconciliation is too old — check that the reconciliation service is running",
  reconcile_skipped: "the last reconciliation was skipped",
  reconcile_error: "the last reconciliation failed",
  reconcile_extra: "reconciliation found extra data on the edge",
  reconcile_revoke: "extra data has not yet been revoked from the edge",
  canary_found: "a canary was found on the edge and the finding has been revoked. Clearing is possible after the next clean marker scan (it runs automatically with reconciliation). Release findings below only after investigating and rebuilding the edge",
  canary_unchecked: "canaries have not been checked since the automatic shutdown",
  canary_stale: "canaries have not been checked recently",
  canary_scan_missing: "no canary marker scan has run on the edge since the automatic shutdown",
  canary_none: "no canaries exist — recreate them",

  restore_auth_unchecked: "the database was restored from a backup but external sign-in has not been verified: second factor, recovery codes and sessions — follow step 4 of the backup recovery procedure",
  kill_changed: "automatic shutdown triggered again while you were viewing — refresh the page",
};

export const CANARY_HOLD_RELEASE_CONFIRM = {
  question: "Release this finding?",
  change: "The record will be queued again and sent to the edge only if it passes the pre-publication check and canary marker check. Release it after investigating and rebuilding the edge.",
  verb: "Release",
} as const;

export const CANARY_HOLDS_RELEASE_ALL_CONFIRM = {
  question: "Release all canary findings?",
  change: "All held records will be queued again and sent to the edge only if they pass pre-publication and marker checks. Do this after investigating and rebuilding the edge.",
  verb: "Release all",
  danger: true,
} as const;

export const SERVICE_TITLES: Readonly<Record<string, string>> = { exporter: "Exporter", intake: "Edge log intake", reconciler: "Reconciler" };

export const CANARY_TEXT: Readonly<Record<EdgeExportStatus["canary_state"], string>> = {
  ok: "No canaries found outside",
  tripped: "Canary found outside — export is off",
  unknown: "Canaries have not been checked yet",
};

export const TEXT = {
  thereIsAReasonAnAdministratorMustResolve: "there is a reason an administrator must resolve",
  reason: (p0: string | number): string => `Reason: ${p0}.`,
  theRecordRemainsOpenInternallyItWillStay: "The record remains open internally. It will stay hidden outside until you choose to show it again.",
  sendingRecordsOutsideIsCurrentlyOff: "Sending records outside is currently off.",
  s: (p0: string | number): string => `${p0} s`,
  min: (p0: string | number): string => `${p0} min`,
  h: (p0: string | number): string => `${p0} h`,
  d: (p0: string | number): string => `${p0} d`,
  thereIsAReasonRecordedInTheLog: "there is a reason recorded in the log",
  unkillHint: "Your investigation and reason why sending can safely resume will be recorded in the audit log. An administrator in a personal session (company account sign-in) clears it; advanced mode also requires a second signature. Clearing requires clean reconciliation and a fresh canary check.",
  automaticProtectionWasTriggered: "automatic protection was triggered",
  shutDownAutomatically: "Shut down automatically",
  on: "On",
  off: "Off",
  lastFreshnessMarkerSentToTheEdgeAgo: (p0: string | number): string => `Last freshness marker sent to the edge ${p0} ago`,
  noFreshnessMarkerHasBeenSentYetWaiting: "No freshness marker has been sent yet: waiting for the first reconciliation after all records are exported. Until then, the edge does not answer agents",
  noFreshnessMarkerHasBeenSentToThe: "No freshness marker has been sent to the edge yet",
  awaitingRevocationAwaitingPublication: (p0: string | number, p1: string | number, p2: string | number): string => `Awaiting revocation: ${p0}${p1}; awaiting publication: ${p2}`,
  oldest: (p0: string | number): string => ` (oldest: ${p0})`,
  exportOffConfirm: "Turn off edge export? The edge will stop receiving records and will soon stop answering agents outside the company network. Enable it again in settings, through an administrator’s personal session (with a second signature in advanced mode).",
  canariesConfirm: "Recreate canary records? Existing ones will be removed and new ones will appear within a minute.",
  reasonList: (reasons: readonly string[]): string => reasons.join("; "),
};
