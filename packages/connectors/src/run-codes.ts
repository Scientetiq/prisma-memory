// Error codes of connector runs: what the scheduler of the workers writes into connectors.last_error and
// connector_runs.error, with the English explanation and the action the admin page shows (the interface localises by code).
// Configuration errors stop the connector at once (status `error`): retrying cannot fix a refused address, an unreadable
// secret, an invalid configuration or a key the vendor refuses. Every other code is retried with backoff, and the
// connector stops after integrations.connectors_max_failures failed runs in a row. Every code of the egress client
// (EGRESS_CODES) has an entry here — a test checks it.

export interface RunError {
  /** What happened, for people. */
  text: string;
  /** What clears it. */
  action: string;
  /** A configuration error: the connector stops at once instead of retrying. */
  config?: true;
}

const BLOCKED: Record<string, string> = {
  url: "The configured address is not a valid URL for a connector (user names, passwords and port 0 are refused).",
  scheme: "The connector may use https only (plain http only inside the allowed private networks).",
  host: "The connector asked for a host it is not allowed to reach (its manifest or its configured address names the only allowed host).",
  private: "The address is in a private network that integrations.connectors_private_networks does not list.",
  loopback: "The address is a loopback address of this server; connectors never reach it.",
  link_local: "The address is link-local; connectors never reach it.",
  metadata: "The address is a cloud metadata service; connectors never reach it.",
  reserved: "The address is in a reserved or special-purpose range; connectors never reach it.",
  redirect: "The vendor answered with a redirect the connector may not follow.",
};

export const RUN_ERRORS: Readonly<Record<string, RunError>> = {
  ...Object.fromEntries(Object.entries(BLOCKED).map(([k, text]) => [`egress_blocked:${k}`, {
    text, action: "Correct the address of the connector, or allow its private network in the integrations settings, then resume.", config: true as const,
  }])),
  egress_request_invalid: { text: "The connector built a request the egress policy refuses (method, headers or size).", action: "Report it to the connector's author; the run retries by itself." },
  egress_dns: { text: "The vendor's host name could not be resolved.", action: "Check the address and the DNS of the workers; the run retries by itself." },
  egress_tls: { text: "The TLS connection to the vendor failed (certificate or handshake).", action: "Check the vendor's certificate; the run retries by itself." },
  egress_unreachable: { text: "The vendor could not be reached.", action: "None if it is short; the run retries by itself." },
  egress_timeout: { text: "The vendor did not answer in time.", action: "None if it is short; the run retries by itself." },
  egress_too_large: { text: "The vendor's answer was larger than the connector may read.", action: "Lower the page size of the connector; the run retries by itself." },
  egress_aborted: { text: "The request was stopped (the run ended or the workers stopped).", action: "None: the next run continues." },
  egress_bad_json: { text: "The vendor's answer was not the JSON the connector expected.", action: "Check the address of the connector; the run retries by itself." },
  auth_failed: { text: "The vendor refused the credentials of the connector.", action: "Set a valid key or token in the connector's secrets, then resume.", config: true },
  rate_limited: { text: "The vendor asked to slow down.", action: "None: the next run waits as long as the vendor asked." },
  vendor_unavailable: { text: "The vendor's service answered with an error of its own.", action: "None if it is short; the run retries by itself." },
  vendor_not_found: { text: "The vendor answered that the requested resource does not exist.", action: "Check the address and the configuration of the connector." },
  vendor_refused: { text: "The vendor refused the request.", action: "Check the configuration of the connector." },
  secret_unreadable: { text: "A secret of the connector cannot be decrypted (the settings key changed or the value is damaged).", action: "Set the secret again, then resume.", config: true },
  secret_missing: { text: "A required secret of the connector is not set.", action: "Set the secret, then resume.", config: true },
  config_invalid: { text: "The configuration of the connector does not match its kind.", action: "Correct the configuration, then resume.", config: true },
  kind_unknown: { text: "This build has no connector of this kind (or its pack is not enabled).", action: "Enable the pack in integrations.connectors_packs, or delete the connector.", config: true },
  pull_unsupported: { text: "This kind of connector does not fetch by itself; it only receives webhooks.", action: "None: send items to its webhook address." },
  folder_root_denied: { text: "The folder of the connector is not under an allowed root (integrations.connectors_folder_roots).", action: "Mount the folder under an allowed root, or add the root, then resume.", config: true },
  "entity_system:missing": { text: "The connector writes entities but has no system code.", action: "Set the system code of the connector, then resume.", config: true },
  "entity_system:invalid": { text: "The system code of the connector is not a valid code.", action: "Correct the system code, then resume.", config: true },
  "entity_system:reserved": { text: "The system code of the connector is reserved by the memory or by a pack.", action: "Choose another system code, then resume.", config: true },
  "entity_system:taken": { text: "Another connector already writes entities under this system code.", action: "Choose another system code, then resume.", config: true },
  state_too_large: { text: "The connector tried to keep more than 16 KiB of state.", action: "Report it to the connector's author." },
  state_readonly: { text: "The connector tried to change its state during a test, which writes nothing.", action: "Report it to the connector's author." },
  state_not_json: { text: "The connector tried to keep a state that is not plain JSON.", action: "Report it to the connector's author." },
  storage_unavailable: { text: "Object storage of the closed class did not answer, so items could not be staged.", action: "Check the storage; the run retries by itself." },
  connector_not_active: { text: "The connector is not active, so the requested run did not start.", action: "Resume the connector, then run it again." },
  connector_revoked: { text: "The connector was revoked or deleted while the run waited.", action: "None." },
  lease_lost: { text: "Another worker process took the run over after this one stopped answering.", action: "None: one run continues." },
  interrupted: { text: "The worker process that ran this stopped before the run ended.", action: "None: the next run continues." },
  aborted: { text: "The workers were stopped during the run; the cursor of the last finished page is kept.", action: "None: the next run continues." },
  deadline: { text: "The run took longer than a run may take; the cursor of the last finished page is kept.", action: "None: the next run continues where this one stopped." },
  internal: { text: "An unexpected error in the connector or the runner.", action: "Check the workers log if it lasts." },
};

/** Codes that stop the connector at once. */
export const CONFIG_ERROR_CODES: readonly string[] = Object.entries(RUN_ERRORS).filter(([, r]) => r.config).map(([c]) => c);
const CONFIG = new Set(CONFIG_ERROR_CODES);

/** True for a configuration error (every refusal of the egress policy included). */
export const isConfigErrorCode = (code: string): boolean => CONFIG.has(code) || code.startsWith("egress_blocked:");

/** The explanation of a run error code, or null for a code this table does not know (the page shows a generic text). */
export function runErrorText(code: string): RunError | null {
  if (Object.hasOwn(RUN_ERRORS, code)) return RUN_ERRORS[code]!;
  return null;
}
