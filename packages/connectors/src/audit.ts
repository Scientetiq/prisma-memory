// Audit events of connectors: pure builders, no I/O. The gateway writes them with its audit writer, the workers
// with theirs; both accept the shape returned here. Details carry ids and codes only — never the connector's name, a
// config value, a URL, an item title, an external id, a vendor message or a secret. Every string passes one guard: a
// UUID or a code; anything else becomes the literal "invalid". A value of the form of a code that looks like a token
// (a part of 24 characters or more, or of 12 or more with a digit: hex digests, vendor keys) is "invalid" as well — the
// guard sees no secrets, so it refuses their usual shape. Builders never throw.

export const CONNECTOR_AUDIT_OPS = [
  "connector_created", "connector_changed", "connector_deleted", "connector_status", "connector_secret_set", "connector_secret_rotated",
  "connector_secret_deleted", "connector_webhook", "connector_run", "connector_delivered", "connector_paused", "connector_trashed",
] as const;
export type ConnectorAuditOp = (typeof CONNECTOR_AUDIT_OPS)[number];
export type ConnectorAdminOp = Extract<ConnectorAuditOp, "connector_created" | "connector_changed" | "connector_deleted" | "connector_status"
  | "connector_secret_set" | "connector_secret_rotated" | "connector_secret_deleted">;

export type AuditDetail = string | number | boolean | string[];
export interface ConnectorAuditEvent<T extends "admin" | "processing" | "auth_failure" = "admin" | "processing" | "auth_failure"> {
  event_type: T;
  details: Record<string, AuditDetail>;
  record_ids?: string[];
  class?: "open" | "closed";
}

/** The connector an event is about. */
export interface ConnectorRef { id: string; kind: string; scope: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE = /^[a-z0-9][a-z0-9_.:-]{0,79}$/;
const MAX_LIST = 50;

/** A part (between _ . : -) of 24 characters or more, or of 12 or more with a digit: the shape of a token, not of a word. */
const tokenLike = (v: string): boolean => v.split(/[_.:-]/).some((p) => p.length >= 24 || (p.length >= 12 && /[0-9]/.test(p)));
/** A UUID or a code passes; anything else (text, a URL, a long string, a token, not a string) is "invalid". */
const safe = (v: unknown): string => (typeof v === "string" && (UUID.test(v) || (CODE.test(v) && !tokenLike(v))) ? v : "invalid");
const uuidOnly = (v: unknown): string => (typeof v === "string" && UUID.test(v) ? v : "invalid");
const count = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.slice(0, MAX_LIST).map(safe) : []);

function base(op: ConnectorAuditOp, ref: ConnectorRef): Record<string, AuditDetail> {
  const r = (ref ?? {}) as Partial<ConnectorRef>;
  return { op, connector_id: uuidOnly(r.id), kind: safe(r.kind), scope: safe(r.scope) };
}

/** Administrator actions on a connector (admin API). Changed fields are names, never values. */
export function auditConnectorAdmin(op: ConnectorAdminOp, ref: ConnectorRef,
                                    o: { fields?: string[]; run_as?: string; status?: string; secret_name?: string; fingerprint?: string } = {}): ConnectorAuditEvent<"admin"> {
  const details = base(CONNECTOR_AUDIT_OPS.includes(op) ? op : "connector_changed", ref);
  const x = (o ?? {}) as Record<string, unknown>;
  if (x.fields !== undefined) details.fields = list(x.fields);
  if (x.run_as !== undefined) details.run_as = uuidOnly(x.run_as);
  if (x.status !== undefined) details.status = safe(x.status);
  if (x.secret_name !== undefined) details.secret_name = safe(x.secret_name);
  if (x.fingerprint !== undefined) details.fingerprint = typeof x.fingerprint === "string" && /^fp:[a-z0-9-]{1,32}:[0-9a-f]{16}$/.test(x.fingerprint) ? x.fingerprint : "invalid";
  return { event_type: "admin", details };
}

/** A refused webhook call (signature, timestamp window, replay, disabled connector): a code, nothing of the request. */
export function auditWebhookRefused(ref: ConnectorRef, reason: string): ConnectorAuditEvent<"auth_failure"> {
  return { event_type: "auth_failure", details: { ...base("connector_webhook", ref), reason: safe(reason) } };
}

/** The end of a run: counters and a code. */
export function auditConnectorRun(ref: ConnectorRef, r: { run_id: string; kind: string; status: string; seen: number; staged: number; entities?: number;
                                                         deleted?: number; error?: string }): ConnectorAuditEvent<"processing"> {
  const x = (r ?? {}) as Record<string, unknown>;
  const details: Record<string, AuditDetail> = {
    ...base("connector_run", ref), run_id: uuidOnly(x.run_id), run_kind: safe(x.kind), status: safe(x.status), seen: count(x.seen), staged: count(x.staged),
  };
  if (x.entities !== undefined) details.entities = count(x.entities);
  if (x.deleted !== undefined) details.deleted = count(x.deleted);
  if (x.error !== undefined) details.error = safe(x.error);
  return { event_type: "processing", details };
}

/** One staged item became a record. */
export function auditConnectorDelivered(ref: ConnectorRef, d: { item_type: string; record_id: string; record_class: "open" | "closed" }): ConnectorAuditEvent<"processing"> {
  const x = (d ?? {}) as Record<string, unknown>;
  const record = uuidOnly(x.record_id);
  return {
    event_type: "processing",
    details: { ...base("connector_delivered", ref), item_type: safe(x.item_type) },
    record_ids: record === "invalid" ? [] : [record],
    class: x.record_class === "open" ? "open" : "closed",
  };
}

/** The source deleted an item, and the connector's policy moved the record it had become to the run-as person's trash. */
export function auditConnectorTrashed(ref: ConnectorRef, d: { item_type: string; record_id: string; record_class: "open" | "closed" }): ConnectorAuditEvent<"processing"> {
  const x = (d ?? {}) as Record<string, unknown>;
  const record = uuidOnly(x.record_id);
  return {
    event_type: "processing",
    details: { ...base("connector_trashed", ref), item_type: safe(x.item_type) },
    record_ids: record === "invalid" ? [] : [record],
    class: x.record_class === "open" ? "open" : "closed",
  };
}

/** The connector paused itself (failures in a row, quota, owner inactive, consent outdated): a code. */
export function auditConnectorPaused(ref: ConnectorRef, reason: string): ConnectorAuditEvent<"processing"> {
  return { event_type: "processing", details: { ...base("connector_paused", ref), reason: safe(reason) } };
}
