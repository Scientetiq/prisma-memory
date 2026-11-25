// The generic webhook kind: any automation tool, script or system that can send a signed HTTP request delivers
// normalised items (contract `connectors` 1.0.0). This file is the manifest only: the hooks route that verifies the
// signature and stages the items is the gateway's; the signing secret is managed by the framework (rotation
// with an overlap window), not declared as a manifest secret.
import { NO_EGRESS_HOST } from "../../sdk/manifest.ts";
import type { Connector, ConnectorManifest } from "../../sdk/types.ts";

export interface WebhookConfig {
  /** Language of meeting items that do not name one. */
  language: string;
  /** Notes from this connector are marked as stated by a person (an administrator's explicit choice). */
  human_authored: boolean;
  /** Code of the external system whose entities this connector sends (needed only to send entity items). */
  system?: string;
}

export const webhookManifest: ConnectorManifest = {
  kind: "webhook",
  sdk: 1,
  version: "1.1.0",
  title: "Webhook",
  description: "Receives signed documents, meetings, notes and entities from n8n, Zapier, Make, scripts or any system that can send an HTTP request.",
  // there is no vendor account to verify against: the kind is our own endpoint
  verified: "live",
  scopes: ["instance", "person"],
  produces: ["document", "meeting", "note", "entity"],
  capabilities: { webhook: "standard_webhooks" },
  config: {
    type: "object",
    additionalProperties: false,
    properties: {
      language: {
        type: "string",
        pattern: "^[a-z]{2}(-[A-Z]{2})?$",
        default: "en",
        title: "Meeting language",
        description: "Language of meeting items that do not name one (BCP 47, for example en or en-GB).",
      },
      human_authored: {
        type: "boolean",
        default: false,
        title: "Notes are written by people",
        description: "Mark notes from this connector as stated by a person and confirmed. Leave off for notes written by tools or agents.",
      },
      system: {
        type: "string",
        pattern: "^[a-z][a-z0-9_]{1,31}$",
        title: "Entity system code",
        description: "Code of the external system the entities come from, for example crm. Needed only to send entities; two connectors never share one.",
      },
    },
  },
  secrets: [],
  // a push kind makes no outbound requests
  egress: { hosts: [NO_EGRESS_HOST] },
  // one request carries at most 50 items; the hooks body limit (integrations.webhooks_max_body_mb) applies on top
  limits: { minIntervalSec: 60, maxItemsPerRun: 50, maxBytesPerItem: 8_388_608 },
};

export const webhookConnector: Connector<WebhookConfig> = {
  manifest: webhookManifest,
  // nothing to reach: the source calls us
  test: async () => ({ ok: true, code: "ok" }),
};
