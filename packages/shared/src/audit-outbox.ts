// Audit outbox: an audit event that the journal (memory_audit) refused is kept in audit_outbox of memory_control and
// moved to audit_events later by the worker job audit_outbox_drain (packages/workers/src/jobs/audit-outbox.ts). The two
// writers that would otherwise lose the event call spoolAudit: audit() of the gateway and auditWorker() of the workers.
// Strict events (sign-in, reads of closed data, auditWorkerStrict) are never spooled — their callers refuse instead.
//
// The writer roles may insert only id, instance_id, source and payload (17-basic-tails.sql, [SEC]): the time of the failure
// (occurred_at) is the database's, and only the worker deletes a moved row. spoolAudit never throws: when the outbox fails
// too, the event is lost — counted here (auditLost, read by the gateway health check) and logged without its payload, which
// holds query texts, filters and addresses.
import { log } from "./log.ts";
import { infraFailureClass } from "./failure-class.ts";

/** observability.audit_open_reads: spool — a read of open data whose event reached the outbox is served; strict — refused. */
export const AUDIT_OPEN_READS = ["spool", "strict"] as const;
export type AuditOpenReads = (typeof AUDIT_OPEN_READS)[number];
export const AUDIT_OPEN_READS_SETTING = "observability.audit_open_reads";

/**
 * Event columns of audit_events that a spooled payload may carry, in the order of the journal. id, at and instance_id are
 * not among them: the drain takes them from the outbox row (the id and the instance) and from its replay time.
 */
export const AUDIT_OUTBOX_COLUMNS = ["event_type", "key_id", "principal_type", "principal_id", "on_behalf_of", "service_id", "tier", "class",
  "record_ids", "space_id", "query_text", "filters", "result_count", "details", "client_label", "ip"] as const;
export type AuditOutboxColumn = (typeof AUDIT_OUTBOX_COLUMNS)[number];

export interface AuditOutboxRow {
  /** The event id, fixed before the first attempt: the journal row gets the same id. */
  id: string;
  instanceId: string;
  source: "gateway" | "workers";
  /** Column → value; `details` and `filters` as objects (not JSON text), `record_ids` as an array. */
  payload: Partial<Record<AuditOutboxColumn, unknown>>;
}

interface Queryable { query(sql: string, params?: unknown[]): Promise<unknown> }

let lost = 0;
let lastLostAt: number | null = null;

/** Events lost in this process since start: neither the journal nor the outbox took them. */
export const auditLost = (): { total: number; lastAt: number | null } => ({ total: lost, lastAt: lastLostAt });
/** For tests. */
export const resetAuditLost = (): void => { lost = 0; lastLostAt = null; };

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** jsonb refuses U+0000 and lone surrogates: such a payload would be refused and the event lost. Keys are cleaned too. */
function clean(v: unknown): unknown {
  if (typeof v === "string") return v.replace(/\u0000/g, "").replace(LONE_SURROGATE, "�");
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[clean(k) as string] = clean(x);
    return out;
  }
  return v;
}

/**
 * Keep an event the journal refused. true — the outbox has it (or already had it: same id); false — lost (counted and
 * logged). Never throws and never logs the payload.
 */
export async function spoolAudit(control: Queryable, row: AuditOutboxRow): Promise<boolean> {
  try {
    await control.query("INSERT INTO audit_outbox (id, instance_id, source, payload) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING",
      [row.id, row.instanceId, row.source, JSON.stringify(clean(row.payload))]);
    return true;
  } catch (err) {
    lost++;
    lastLostAt = Date.now();
    // a class of the failure, never the driver's code or text (the event type and the source are our own)
    log.error("audit_lost", {
      event_type: typeof row.payload?.event_type === "string" ? row.payload.event_type.slice(0, 64) : null, source: row.source,
      error: infraFailureClass(err),
    });
    return false;
  }
}
