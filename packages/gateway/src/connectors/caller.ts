// The run-as caller of a connector. Records a connector produces are written as its
// run-as person, through the same functions as REST and MCP: the caller is the one a personal script key of that person
// would give (personal, T2, client kind `script`, no on-behalf, no preview, internal channel), built at delivery time
// from the person's current row — loss of membership, dismissal or deactivation stop the delivery with no extra code.
// It is not a key: `keyId` is the connector id (the audit events of the called functions carry it), and the operation
// set is documentation only — upload(), remember() and acceptMeeting() do not check it; that a connector cannot read is
// guaranteed by the imports of this folder (an import test checks them).
//
// Who may be the run-as person is decided when a connector is created or changed (admin API): meetings and
// personal-space targets and person-scoped connectors only for the person who creates the connector and acknowledges
// the meeting consent; instance-scoped team targets — an active person who can write there. Delivery checks it again
// from the row: the person exists, is active and not a demo person; a connector that writes meetings or into a personal
// space, or has person scope, was created by that same person
// (`created_by` is the login of the creator — the admin API writes the login of the administrator's own person card,
// see above) and, for meetings, its consent was acknowledged by that person; the target space is the person's own
// personal space or a space they can still write (gates.ts).
import { cleanLine } from "@memory/connectors";
import { personCols, scopeFor } from "../auth.ts";
import type { App, Caller, PersonRow } from "../context.ts";

/** What the run-as caller is meant to do (documentation; the write functions do not check operations). */
export const CONNECTOR_CALLER_OPS = ["upload", "remember", "ingest_transcripts", "ingest_documents"] as const;

/** The columns of a connector the delivery reads. */
export interface ConnectorRow {
  id: string;
  instance_id: string;
  kind: string;
  pack: string | null;
  name: string;
  scope: "instance" | "person";
  owner_id: string | null;
  target_space_id: string | null;
  data_class: "closed" | "space";
  status: string;
  config: Record<string, unknown>;
  policy: Record<string, unknown>;
  consent_version: string | null;
  consent_by: string | null;
  last_error: string | null;
  /** Login of the person who created the connector (text, no foreign key). */
  created_by: string;
}

/** Client label of the connector's writes: `connector:<kind>:<name>` (one line, capped). */
export const connectorClientLabel = (kind: string, name: string): string => `connector:${kind}:${cleanLine(String(name ?? ""), 80)}`;

/** The caller of a connector for its run-as person (a personal script key of that person, without the key). */
export function connectorCaller(app: App, c: Pick<ConnectorRow, "id" | "kind" | "name">, owner: PersonRow): Caller {
  return {
    keyId: c.id, keyKind: "personal", tier: "T2", principalType: "person", person: owner, service: null, onBehalfOf: false,
    allowedOps: new Set<string>(CONNECTOR_CALLER_OPS), clientLabel: connectorClientLabel(c.kind, c.name), clientKind: "script",
    expiresAt: null, ip: null, netBound: false, preview: false, scope: scopeFor("personal", "T2"),
    baseUrl: app.settings.str("access.public_base_url")?.trim() || "", channel: "internal",
  };
}

export type RunAs = { ok: true; owner: PersonRow; caller: Caller } | { ok: false; reason: "owner_inactive" | "run_as_denied" | "consent_outdated" };

/**
 * The run-as person of a connector for one item type, checked again at delivery: missing, inactive or demo →
 * `owner_inactive`; a meeting, personal-space target or person-scoped connector somebody else created, or a meeting
 * consent somebody else acknowledged → `run_as_denied`; a meeting consent nobody acknowledged yet → `consent_outdated` (the
 * person acknowledges it, the connector needs a reconfirmation, not a deletion).
 */
export async function runAs(app: App, c: ConnectorRow, itemType: string): Promise<RunAs> {
  if (!c.owner_id) return { ok: false, reason: "owner_inactive" };
  const { rows } = await app.db.control.query(`SELECT ${personCols()} FROM people WHERE id = $1 AND instance_id = $2`, [c.owner_id, app.instanceId]);
  const owner = rows[0] as PersonRow | undefined;
  if (!owner || !owner.active || owner.demo) return { ok: false, reason: "owner_inactive" };
  const own = itemType === "meeting" || c.target_space_id === null || c.scope === "person";
  if (own && String(c.created_by ?? "").trim().toLowerCase() !== String(owner.login ?? "").trim().toLowerCase()) return { ok: false, reason: "run_as_denied" };
  if (itemType === "meeting" && !c.consent_by) return { ok: false, reason: "consent_outdated" };
  if (itemType === "meeting" && c.consent_by !== owner.id) return { ok: false, reason: "run_as_denied" };
  return { ok: true, owner, caller: connectorCaller(app, c, owner) };
}
