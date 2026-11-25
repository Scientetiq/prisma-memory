// Reason codes of staged record items (connector_items.reason) that the delivery of the gateway writes (changes,
// deletions at the source and the connector's daily quota), with the English explanation and what clears them. The admin page explains an item by its code from this table (the interface
// localises by code); a code the delivery writes and this table lacks fails a gateway test.

export interface DeliveryReason {
  /** Item status the code goes with. */
  status: "staged" | "held" | "failed" | "skipped" | "delivered" | "deleted_at_source";
  /** What happened, for people. */
  text: string;
  /** What clears it. */
  action: string;
}

export const DELIVERY_REASONS = {
  owner_inactive: { status: "held", text: "The person the connector writes as is missing, deactivated or a demo person.", action: "Choose an active run-as person, then resume the connector." },
  run_as_denied: { status: "held", text: "The connector writes meetings or into a personal space, and the run-as person did not create it or acknowledge its meeting consent themselves.", action: "Delete the connector; the person connects their own meetings and personal sources." },
  space_denied: { status: "held", text: "The target space is archived, gone, or the run-as person can no longer write there.", action: "Restore the person's membership or choose another target, then resume." },
  space_unsupported: { status: "held", text: "Connectors do not write into the organisation-wide space in this release.", action: "Choose a team, project or personal target space." },
  class_gate: { status: "held", text: "The connector delivers closed records only, and the target space would make this record open.", action: "Target a closed space, or switch the connector's data class to follow the space." },
  consent_outdated: { status: "held", text: "The meeting consent text changed since the run-as person acknowledged it.", action: "The run-as person acknowledges the current text; held meetings are then delivered." },
  open_check: { status: "held", text: "The record would be open to agents, and the open-content check found something that must stay closed.", action: "Fix the content at the source, or deliver it into a closed space." },
  class_denied: { status: "held", text: "The memory refused to write this record with this data class.", action: "Check the target space and its class." },
  never_open: { status: "held", text: "A rule of this installation keeps this content out of the open class.", action: "Deliver it into a closed space." },
  placement_unavailable: { status: "held", text: "The same file already exists in another space of the run-as person, and the memory cannot place it into the connector's target space.", action: "Move or remove the existing copy, then retry the held item." },
  over_daily_budget: { status: "held", text: "This item alone is larger than the run-as person's whole daily upload budget, so it would wait for ever.", action: "Raise limits.upload_daily, then retry the held item; or send a smaller item from the source." },
  versions_unavailable: { status: "held", text: "The document changed at the source, and this installation cannot keep document versions yet.", action: "Wait for document versions, or switch the connector to create a new record on change." },
  version_denied: { status: "held", text: "The document changed at the source, and the run-as person may not add a version to it (somebody else is the author of the current version).", action: "Make the author the run-as person, or switch the connector to create a new record on change; then retry the held item." },
  record_moved: { status: "held", text: "The document changed at the source, and the record it became was moved out of the connector's target space; the connector does not follow it.", action: "Move the record back, or delete it to get a new record, then retry the held item." },
  over_connector_daily: { status: "held", text: "This item alone is larger than the connector's whole daily volume, so it would wait for ever.", action: "Raise the connector's daily volume (policy daily_mb or integrations.connectors_daily_mb), then retry the held item." },
  connector_daily: { status: "staged", text: "The connector's own daily quota (items or volume) is used up.", action: "None: the waiting items are delivered the next day by themselves. A raised daily quota applies to new items at once; the items already waiting still wait for the next day." },
  upload_daily: { status: "staged", text: "The run-as person's daily upload budget is used up (it is shared with their own uploads).", action: "None: delivery continues the next day by itself." },
  in_progress: { status: "staged", text: "The target record was being moved; delivery retries by itself.", action: "None." },
  rate_limited: { status: "staged", text: "The memory asked to slow down; delivery retries by itself.", action: "None." },
  storage_unavailable: { status: "staged", text: "Object storage did not answer; delivery retries by itself.", action: "Check the storage if it lasts." },
  internal: { status: "staged", text: "An unexpected error; delivery retries by itself.", action: "Check the gateway log if it lasts." },
  invalid_argument: { status: "failed", text: "The memory refused the item as invalid.", action: "Fix the item at the source and send it again." },
  too_large: { status: "failed", text: "The item is larger than this installation accepts.", action: "Send a smaller item, or raise the upload limit." },
  staged_missing: { status: "failed", text: "The staged body of the item is gone (removed after 7 days without delivery).", action: "Send the item again from the source." },
  staged_invalid: { status: "failed", text: "The staged body of the item could not be read.", action: "Send the item again from the source." },
  format_not_accepted: { status: "skipped", text: "This file format is not accepted by the memory now.", action: "Enable the format (document converter) and send the file again." },
  entities_unresolved: { status: "delivered", text: "Delivered; some entity references of the item were not found and were not linked.", action: "None: linking by name happens in the pipeline." },
  delete_kept: { status: "deleted_at_source", text: "Deleted at the source; the record stays in memory (the connector keeps records when the source deletes them).", action: "None; delete the record by hand if it should go, or switch the connector to move such records to the trash." },
  delete_trashed: { status: "deleted_at_source", text: "Deleted at the source; the record was moved to the run-as person's trash. Only its latest form goes: earlier versions of a meeting that changed at the source, and earlier records of a note or document that changed, stay in memory.", action: "None; the person can restore it from the trash while the trash keeps it, and delete earlier versions by hand if they should go." },
  delete_skipped_shared: { status: "deleted_at_source", text: "Deleted at the source; the record stays, because the connector did not create it alone: it existed before the connector, another connector item points to it, somebody placed the same file into another space, or it has another owner now.", action: "None; delete the record by hand if it should go." },
  delete_skipped_moved: { status: "deleted_at_source", text: "Deleted at the source; the record stays, because it is no longer in the connector's target space (moved, or the target cannot be used, for example archived). The deletion is not tried again.", action: "None; delete the record by hand if it should go." },
  delete_skipped_owner: { status: "deleted_at_source", text: "Deleted at the source; the record stays, because the run-as person could not act when the deletion was handled (missing, deactivated, or not the person the connector writes as). The deletion is not tried again.", action: "None; delete the record by hand if it should go." },
  delete_no_record: { status: "deleted_at_source", text: "Deleted at the source before it became a record, or its record is already gone.", action: "None." },
  delete_failed: { status: "deleted_at_source", text: "Deleted at the source; moving the record to the trash failed several times, the record stays.", action: "Check the gateway log; delete the record by hand if it should go." },
} as const satisfies Record<string, DeliveryReason>;

export type DeliveryReasonCode = keyof typeof DELIVERY_REASONS;
