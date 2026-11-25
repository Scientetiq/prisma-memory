// Connector page messages in English. Same keys in ru.ts.
export const connectors = {
  "personalDestination": "Personal space of the run-as person",
  "entityDestination": "Entity registry; no record destination",
  "openRecords": "Records are open to agents",
  "choiceHint": "Search for people and spaces before filling the configuration. Suggestions carry their names and IDs.",
  "peopleSearch": "Find a person by name or login",
  "spaceSearch": "Find a space by name or slug",
  "searchChoices": "Find choices",
  "moreChoices": "More matches exist. Narrow the search to find your person or space.",

  "page": "Connectors",
  "lead": "Connect sources and see where records go, who writes them and what needs attention.",
  "add": "Add connector",
  "choose": "1. Choose a connector kind",
  "configure": "2. Configure the source",
  "secrets": "3. Set secrets",
  "target": "4. Choose the destination",
  "activateHint": "5. Create a draft, run a test, then activate from its detail page.",
  "kind": "Kind",
  "name": "Name",
  "scope": "Scope",
  "instance": "Installation",
  "person": "Personal",
  "owner": "Run-as person ID",
  "ownerHint": "Meetings and personal sources use your own linked person card. Team sources require an active person with write access.",
  "space": "Target space ID",
  "personalSpace": "Leave empty for your personal space. Entity-only sources have no destination.",
  "closed": "Records are closed",
  "spaceClass": "Records follow the target space class; an open space makes them open to agents.",
  "create": "Create draft",
  "created": "Draft created. Complete its connection test before activating.",
  "partial": "Draft created, but a secret could not be saved. Open the connector and set the secret again.",
  "open": "Open connector",
  "back": "Back to connectors",
  "save": "Save configuration",
  "saved": "Saved. A changed target, data class or run-as person pauses the connector.",
  "working": "Saving…",
  "done": "Action completed. Refresh to see the latest state.",
  "queued": "Run queued. Refresh to see its result; a queued test is not a passed test.",
  "once": "Webhook signing secret",
  "onceWarning": "Save this secret now. It is shown only in this result. Never put it in configuration fields or URLs.",
  "hideSecret": "Hide secret",
  "webhook": "Webhook address",
  "publicBase": "Public gateway URL",
  "publicHint": "Enter the public gateway address used by senders. It may differ from the panel address. This preview is not saved.",
  "notVerified": "not verified against a live account",
  "status": "Status",
  "destination": "Destination and data class",
  "runAs": "Records are written as",
  "sharedBudget": "This person’s daily upload budget is shared with their own uploads and other connectors.",
  "noOwner": "Entity registry: no run-as person or upload budget.",
  "lastRun": "Last synchronization",
  "nextRun": "Next synchronization",
  "lastOk": "Last successful synchronization",
  "lastError": "Last error",
  "empty": "No connectors yet. Add a source to begin.",
  "runs": "Runs",
  "items": "Items",
  "reason": "Reason and next action",
  "seen": "Seen",
  "staged": "Staged",
  "counts": "Synchronization counters, last 24 hours",
  "partialCounts": "Counters are incomplete: the recent-run pagination limit was reached.",
  "webhookCounts": "Webhook deliveries appear in Items; synchronization counters count pull runs only.",
  "filter": "Filter items",
  "all": "All statuses",
  "next": "Next page",
  "previous": "Newest page",
  "refresh": "Refresh",
  "type": "Type",
  "externalId": "Source item ID",
  "version": "Version",
  "record": "Record ID",
  "none": "None",
  "error": "Unable to load this section.",
  "unknown": "An unrecognized connector error occurred.",
  "unknownAction": "Check the connector configuration and service logs; report the code if it continues.",
  "fieldError": "Check the configuration fields:",
  "invalid": "Check the submitted fields. Identifiers must be lowercase UUIDs.",
  "readOnly": "This view is read-only.",
  "confirmDelete": "I understand that deleting the connector removes its configuration and staged items. Imported records remain.",
  "consent": "Meeting consent",
  "ackConsent": "I have read this consent and confirm it as the run-as person.",
  "consentUnavailable": "The current meeting consent could not be loaded. Confirmation is unavailable.",
  "consentAction": "Read the meeting consent below and confirm it as the run-as person.",
  "noSecret": "This kind requires no vendor secrets.",
  "secretSet": "Set; stored values are never returned.",
  "secretUnset": "Not set",
  "fingerprint": "Fingerprint",
  "secretPlaceholder": "Enter a new secret value",
  "rotation": "The previous signing secret remains valid for 24 hours. Update the sender before that window closes.",
  "rotationConfirm": "I am ready to save the new signing secret and update the sender.",
  "schedule": "Synchronization interval (seconds)",
  "dailyItems": "Daily item limit",
  "dailyMb": "Daily volume (MiB)",
  "participants": "Meeting participants",
  "ownerOnly": "Owner only",
  "attended": "Owner and matched attended email addresses",
  "onChange": "When source content changes",
  "newVersion": "Keep document versions",
  "newRecord": "Create a new record",
  "onDelete": "When the source deletes an item",
  "keep": "Keep the imported record",
  "trash": "Move eligible imported records to trash",
  "optional": "Use manifest default / omit",
  "trueValue": "Yes",
  "falseValue": "No",
  "actions": {
    "test": "Test connection",
    "run": "Synchronize now",
    "pause": "Pause",
    "resume": "Activate / resume",
    "reconfirm": "Confirm meeting consent",
    "rotate": "Rotate webhook secret",
    "delete": "Delete connector",
    "secret": "Save secret"
  },
  "states": {
    "draft": "Draft",
    "active": "Active",
    "paused": "Paused",
    "error": "Needs attention",
    "needs_reconfirm": "Consent required",
    "revoked": "Revoked",
    "pending": "Queued",
    "queued": "Queued",
    "webhook": "Webhook refetch",
    "running": "Running",
    "ok": "Succeeded",
    "failed": "Failed",
    "aborted": "Interrupted",
    "staged": "Staged",
    "delivering": "Delivering",
    "delivered": "Delivered",
    "unchanged": "Unchanged",
    "held": "Held",
    "skipped": "Skipped",
    "deleted_at_source": "Deleted at source",
    "test": "Connection test",
    "sync": "Synchronization",
    "pull": "Synchronization",
    "backfill": "Backfill"
  },
  "jsonHint": "Enter JSON for structured values. Configuration contains no secrets."
};

export const connectorErrors = {
  "egress_request_invalid": {
    "text": "The connector built a request the egress policy refuses (method, headers or size).",
    "action": "Report it to the connector's author; the run retries by itself."
  },
  "egress_dns": {
    "text": "The vendor's host name could not be resolved.",
    "action": "Check the address and the DNS of the workers; the run retries by itself."
  },
  "egress_tls": {
    "text": "The TLS connection to the vendor failed (certificate or handshake).",
    "action": "Check the vendor's certificate; the run retries by itself."
  },
  "egress_unreachable": {
    "text": "The vendor could not be reached.",
    "action": "None if it is short; the run retries by itself."
  },
  "egress_timeout": {
    "text": "The vendor did not answer in time.",
    "action": "None if it is short; the run retries by itself."
  },
  "egress_too_large": {
    "text": "The vendor's answer was larger than the connector may read.",
    "action": "Lower the page size of the connector; the run retries by itself."
  },
  "egress_aborted": {
    "text": "The request was stopped (the run ended or the workers stopped).",
    "action": "None: the next run continues."
  },
  "egress_bad_json": {
    "text": "The vendor's answer was not the JSON the connector expected.",
    "action": "Check the address of the connector; the run retries by itself."
  },
  "auth_failed": {
    "text": "The vendor refused the credentials of the connector.",
    "action": "Set a valid key or token in the connector's secrets, then resume."
  },
  "rate_limited": {
    "text": "The service asked to slow down.",
    "action": "Wait: processing resumes automatically after the requested delay."
  },
  "vendor_unavailable": {
    "text": "The vendor's service answered with an error of its own.",
    "action": "None if it is short; the run retries by itself."
  },
  "vendor_not_found": {
    "text": "The vendor answered that the requested resource does not exist.",
    "action": "Check the address and the configuration of the connector."
  },
  "vendor_refused": {
    "text": "The vendor refused the request.",
    "action": "Check the configuration of the connector."
  },
  "secret_unreadable": {
    "text": "A secret of the connector cannot be decrypted (the settings key changed or the value is damaged).",
    "action": "Set the secret again, then resume."
  },
  "secret_missing": {
    "text": "A required secret of the connector is not set.",
    "action": "Set the secret, then resume."
  },
  "config_invalid": {
    "text": "The configuration of the connector does not match its kind.",
    "action": "Correct the configuration, then resume."
  },
  "kind_unknown": {
    "text": "This build has no connector of this kind (or its pack is not enabled).",
    "action": "Enable the pack in integrations.connectors_packs, or delete the connector."
  },
  "pull_unsupported": {
    "text": "This kind of connector does not fetch by itself; it only receives webhooks.",
    "action": "None: send items to its webhook address."
  },
  "folder_root_denied": {
    "text": "The folder of the connector is not under an allowed root (integrations.connectors_folder_roots).",
    "action": "Mount the folder under an allowed root, or add the root, then resume."
  },
  "entity_system:missing": {
    "text": "The connector writes entities but has no system code.",
    "action": "Set the system code of the connector, then resume."
  },
  "entity_system:invalid": {
    "text": "The system code of the connector is not a valid code.",
    "action": "Correct the system code, then resume."
  },
  "entity_system:reserved": {
    "text": "The system code of the connector is reserved by the memory or by a pack.",
    "action": "Choose another system code, then resume."
  },
  "entity_system:taken": {
    "text": "Another connector already writes entities under this system code.",
    "action": "Choose another system code, then resume."
  },
  "state_too_large": {
    "text": "The connector tried to keep more than 16 KiB of state.",
    "action": "Report it to the connector's author."
  },
  "state_readonly": {
    "text": "The connector tried to change its state during a test, which writes nothing.",
    "action": "Report it to the connector's author."
  },
  "state_not_json": {
    "text": "The connector tried to keep a state that is not plain JSON.",
    "action": "Report it to the connector's author."
  },
  "storage_unavailable": {
    "text": "Object storage is unavailable.",
    "action": "Check object storage; processing retries automatically."
  },
  "connector_not_active": {
    "text": "The connector is not active, so the requested run did not start.",
    "action": "Resume the connector, then run it again."
  },
  "connector_revoked": {
    "text": "The connector was revoked or deleted while the run waited.",
    "action": "None."
  },
  "lease_lost": {
    "text": "Another worker process took the run over after this one stopped answering.",
    "action": "None: one run continues."
  },
  "interrupted": {
    "text": "The worker process that ran this stopped before the run ended.",
    "action": "None: the next run continues."
  },
  "aborted": {
    "text": "The workers were stopped during the run; the cursor of the last finished page is kept.",
    "action": "None: the next run continues."
  },
  "deadline": {
    "text": "The run took longer than a run may take; the cursor of the last finished page is kept.",
    "action": "None: the next run continues where this one stopped."
  },
  "internal": {
    "text": "An unexpected error interrupted processing.",
    "action": "Processing retries automatically; check service logs if it continues."
  },
  "egress_blocked:url": {
    "text": "The configured address is not a valid URL for a connector (user names, passwords and port 0 are refused).",
    "action": "Correct the address or the allowed private networks in Integrations, then resume."
  },
  "egress_blocked:scheme": {
    "text": "The connector may use https only (plain http only inside the allowed private networks).",
    "action": "Correct the address or the allowed private networks in Integrations, then resume."
  },
  "egress_blocked:host": {
    "text": "The connector asked for a host it is not allowed to reach (its manifest or its configured address names the only allowed host).",
    "action": "Correct the address or the allowed private networks in Integrations, then resume."
  },
  "egress_blocked:private": {
    "text": "The address is in a private network that integrations.connectors_private_networks does not list.",
    "action": "Correct the address or the allowed private networks in Integrations, then resume."
  },
  "egress_blocked:loopback": {
    "text": "The address is a loopback address of this server; connectors never reach it.",
    "action": "Correct the address or the allowed private networks in Integrations, then resume."
  },
  "egress_blocked:link_local": {
    "text": "The address is link-local; connectors never reach it.",
    "action": "Correct the address or the allowed private networks in Integrations, then resume."
  },
  "egress_blocked:metadata": {
    "text": "The address is a cloud metadata service; connectors never reach it.",
    "action": "Correct the address or the allowed private networks in Integrations, then resume."
  },
  "egress_blocked:reserved": {
    "text": "The address is in a reserved or special-purpose range; connectors never reach it.",
    "action": "Correct the address or the allowed private networks in Integrations, then resume."
  },
  "egress_blocked:redirect": {
    "text": "The vendor answered with a redirect the connector may not follow.",
    "action": "Correct the address or the allowed private networks in Integrations, then resume."
  },
  "owner_inactive": {
    "text": "The person the connector writes as is missing, deactivated or a demo person.",
    "action": "Choose an active run-as person, then resume the connector."
  },
  "run_as_denied": {
    "text": "The connector writes meetings or into a personal space, and the run-as person did not create it or acknowledge its meeting consent themselves.",
    "action": "Delete the connector; the person connects their own meetings and personal sources."
  },
  "space_denied": {
    "text": "The target space is archived, gone, or the run-as person can no longer write there.",
    "action": "Restore the person's membership or choose another target, then resume."
  },
  "space_unsupported": {
    "text": "Connectors do not write into the organisation-wide space in this release.",
    "action": "Choose a team, project or personal target space."
  },
  "class_gate": {
    "text": "The connector delivers closed records only, and the target space would make this record open.",
    "action": "Target a closed space, or switch the connector's data class to follow the space."
  },
  "consent_outdated": {
    "text": "The meeting consent text changed since the run-as person acknowledged it.",
    "action": "The run-as person acknowledges the current text; held meetings are then delivered."
  },
  "open_check": {
    "text": "The record would be open to agents, and the open-content check found something that must stay closed.",
    "action": "Fix the content at the source, or deliver it into a closed space."
  },
  "class_denied": {
    "text": "The memory refused to write this record with this data class.",
    "action": "Check the target space and its class."
  },
  "never_open": {
    "text": "A rule of this installation keeps this content out of the open class.",
    "action": "Deliver it into a closed space."
  },
  "placement_unavailable": {
    "text": "The same file already exists in another space of the run-as person, and the memory cannot place it into the connector's target space.",
    "action": "Move or remove the existing copy, then retry the held item."
  },
  "over_daily_budget": {
    "text": "This item alone is larger than the run-as person's whole daily upload budget, so it would wait for ever.",
    "action": "Raise limits.upload_daily, then retry the held item; or send a smaller item from the source."
  },
  "versions_unavailable": {
    "text": "The document changed at the source, and this installation cannot keep document versions yet.",
    "action": "Wait for document versions, or switch the connector to create a new record on change."
  },
  "version_denied": {
    "text": "The document changed at the source, and the run-as person may not add a version to it (somebody else is the author of the current version).",
    "action": "Make the author the run-as person, or switch the connector to create a new record on change; then retry the held item."
  },
  "record_moved": {
    "text": "The document changed at the source, and the record it became was moved out of the connector's target space; the connector does not follow it.",
    "action": "Move the record back, or delete it to get a new record, then retry the held item."
  },
  "over_connector_daily": {
    "text": "This item alone is larger than the connector's whole daily volume, so it would wait for ever.",
    "action": "Raise the connector's daily volume (policy daily_mb or integrations.connectors_daily_mb), then retry the held item."
  },
  "connector_daily": {
    "text": "The connector's own daily quota (items or volume) is used up.",
    "action": "None: the waiting items are delivered the next day by themselves. A raised daily quota applies to new items at once; the items already waiting still wait for the next day."
  },
  "upload_daily": {
    "text": "The run-as person's daily upload budget is used up (it is shared with their own uploads).",
    "action": "None: delivery continues the next day by itself."
  },
  "in_progress": {
    "text": "The target record was being moved; delivery retries by itself.",
    "action": "None."
  },
  "invalid_argument": {
    "text": "The memory refused the item as invalid.",
    "action": "Fix the item at the source and send it again."
  },
  "too_large": {
    "text": "The item is larger than this installation accepts.",
    "action": "Send a smaller item, or raise the upload limit."
  },
  "staged_missing": {
    "text": "The staged body of the item is gone (removed after 7 days without delivery).",
    "action": "Send the item again from the source."
  },
  "staged_invalid": {
    "text": "The staged body of the item could not be read.",
    "action": "Send the item again from the source."
  },
  "format_not_accepted": {
    "text": "This file format is not accepted by the memory now.",
    "action": "Enable the format (document converter) and send the file again."
  },
  "entities_unresolved": {
    "text": "Delivered; some entity references of the item were not found and were not linked.",
    "action": "None: linking by name happens in the pipeline."
  },
  "delete_kept": {
    "text": "Deleted at the source; the record stays in memory (the connector keeps records when the source deletes them).",
    "action": "None; delete the record by hand if it should go, or switch the connector to move such records to the trash."
  },
  "delete_trashed": {
    "text": "Deleted at the source; the record was moved to the run-as person's trash. Only its latest form goes: earlier versions of a meeting that changed at the source, and earlier records of a note or document that changed, stay in memory.",
    "action": "None; the person can restore it from the trash while the trash keeps it, and delete earlier versions by hand if they should go."
  },
  "delete_skipped_shared": {
    "text": "Deleted at the source; the record stays, because the connector did not create it alone: it existed before the connector, another connector item points to it, somebody placed the same file into another space, or it has another owner now.",
    "action": "None; delete the record by hand if it should go."
  },
  "delete_skipped_moved": {
    "text": "Deleted at the source; the record stays, because it is no longer in the connector's target space (moved, or the target cannot be used, for example archived). The deletion is not tried again.",
    "action": "None; delete the record by hand if it should go."
  },
  "delete_skipped_owner": {
    "text": "Deleted at the source; the record stays, because the run-as person could not act when the deletion was handled (missing, deactivated, or not the person the connector writes as). The deletion is not tried again.",
    "action": "None; delete the record by hand if it should go."
  },
  "delete_no_record": {
    "text": "Deleted at the source before it became a record, or its record is already gone.",
    "action": "None."
  },
  "delete_failed": {
    "text": "Deleted at the source; moving the record to the trash failed several times, the record stays.",
    "action": "Check the gateway log; delete the record by hand if it should go."
  },
  "operator_unlinked": {
    "text": "Your administrator account has no active person card.",
    "action": "Link your account to a person before connecting personal sources or meetings."
  },
  "connector_untested": {
    "text": "This draft has no successful connection test.",
    "action": "Run a test, refresh to see its result, then activate."
  },
  "connector_config": {
    "text": "The configuration does not match this connector kind.",
    "action": "Correct the highlighted fields and save again."
  },
  "connector_request": {
    "text": "The connector request contains an invalid field.",
    "action": "Check the name, identifiers, target and field formats."
  },
  "connector_policy": {
    "text": "The synchronization policy is invalid.",
    "action": "Check the interval and daily limits against the manifest."
  },
  "connector_kind": {
    "text": "This connector kind is unavailable.",
    "action": "Choose a kind enabled in this installation."
  },
  "connector_owner": {
    "text": "This connector needs a run-as person.",
    "action": "Choose an active person who can write to the target."
  },
  "connector_scope": {
    "text": "This scope is not supported by the connector kind.",
    "action": "Choose an offered scope."
  },
  "connector_preset": {
    "text": "This connector preset is unavailable.",
    "action": "Enable the pack or create the connector without a preset."
  },
  "connector_secret": {
    "text": "The secret could not be stored.",
    "action": "Enter a value of 1–8192 characters and try again."
  },
  "connector_secret_name": {
    "text": "This secret is not declared by the connector kind.",
    "action": "Use the named secret fields; rotate the webhook signing secret instead."
  },
  "connector_consent": {
    "text": "Meeting consent has not been acknowledged.",
    "action": "Read the current meeting consent and confirm it as the run-as person."
  },
  "connector_no_meetings": {
    "text": "This connector does not deliver meetings.",
    "action": "No meeting consent is needed."
  },
  "connector_no_pull": {
    "text": "This connector receives items instead of fetching them.",
    "action": "Send a signed webhook request."
  },
  "connector_no_webhook": {
    "text": "This connector has no webhook endpoint.",
    "action": "Use synchronization for this connector kind."
  },
  "connector_busy": {
    "text": "A run is already queued or running.",
    "action": "Wait for its result and refresh this page."
  },
  "run_as_fixed": {
    "text": "The run-as person cannot be changed for this connector.",
    "action": "Delete it and have the new person create their own connector."
  },
  "personal_target": {
    "text": "A personal space cannot be named as a team target.",
    "action": "Leave the target empty to use your own personal space."
  },
  "entity_scope": {
    "text": "Entity registries require installation scope.",
    "action": "Choose installation scope without a run-as person."
  },
  "role_forbidden": {
    "text": "Your administrator role cannot perform this action.",
    "action": "Ask a memory administrator to make this change."
  },
  "breakglass_only": {
    "text": "Emergency access allows only narrowing actions.",
    "action": "Pause or delete the connector; use ordinary administrator access for other changes."
  },
  "forbidden": {
    "text": "Your account cannot perform this action.",
    "action": "Check your role and run-as person."
  },
  "not_found": {
    "text": "The connector was not found.",
    "action": "Return to the list and refresh."
  },
  "gateway_unreachable": {
    "text": "The gateway is unavailable.",
    "action": "Check the gateway service and try again."
  },
  "response_lost": {
    "text": "The response was lost; the outcome is unknown.",
    "action": "Refresh and check the connector before repeating an action."
  },
  "tool_error": {
    "text": "The external lookup tool failed.",
    "action": "Check the configured tool and its arguments; the lookup retries."
  },
  "pack_disabled": {
    "text": "The optional connector pack is disabled.",
    "action": "Enable the pack in Integrations."
  },
  "headers_missing": {
    "text": "The webhook signature headers are missing.",
    "action": "Configure the sender to sign the raw body using Standard Webhooks."
  },
  "headers_invalid": {
    "text": "The webhook signature headers are invalid.",
    "action": "Check the signature format at the sender."
  },
  "timestamp_out_of_window": {
    "text": "The signed webhook timestamp is outside the accepted window.",
    "action": "Synchronize the sender clock and send a newly signed request."
  },
  "secret_invalid": {
    "text": "The webhook signing secret is invalid.",
    "action": "Rotate the secret and update the sender."
  },
  "signature_mismatch": {
    "text": "The webhook signature does not match its raw body.",
    "action": "Use the current signing secret and sign the exact bytes sent."
  },
  "push_token": {
    "text": "The push credential is invalid.",
    "action": "Use a current credential authorized for this connector."
  },
  "push_disabled": {
    "text": "Webhook ingestion is disabled for this installation.",
    "action": "Enable webhook ingestion in Integrations after reviewing its reach."
  }
};
