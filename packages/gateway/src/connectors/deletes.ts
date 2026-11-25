// Deletions at the source (a source deletes what it does not own): the delivery loop
// claims record items marked `deleted_at_source` and not handled yet (reason NULL — markDeletedAtSource of
// @memory/connectors) and applies the connector's `policy.on_delete`:
// - `keep` (default): the record stays; the item is marked `delete_kept`;
// - `trash`: the record goes to the run-as person's trash through deleteRecord() — restorable for access.trash_days — but
//   only when the connector made it alone: the item did not adopt an existing record (`adopted`: a file the person had
//   uploaded before), no other connector item points to the same record, the record's owner is still the run-as person,
//   the record is still in the connector's target space, and nobody placed the same file into another space by hand
//   (record_placements). Otherwise the record stays (`delete_skipped_shared`, `delete_skipped_moved`,
//   `delete_skipped_owner`) and the deletion is not tried again.
//   Only the record the item points to now goes to the trash, with what deleteRecord() takes along (its derived records):
//   earlier versions of a meeting that changed at the source, the earlier note of a changed note and the earlier record
//   of a document under on_change `new_record` stay where they are (deleteRecord() of owner.ts takes a whole version
//   chain for notes and meeting events only; a change of that is a request to its owner).
// An item that never became a record, or whose record is already gone, is `delete_no_record`. Entities are never deleted
// here (the registry marks them). A claim is a 2-minute lease on the row (the status stays `deleted_at_source`);
// a failing trash is retried on the delivery ladder and ends `delete_failed` — the record then stays.
import { auditConnectorTrashed, type DeliveryReasonCode } from "@memory/connectors";
import { log, MemoryError, type DataClass } from "@memory/shared";
import { locate } from "../access.ts";
import { audit } from "../audit.ts";
import type { App, Caller } from "../context.ts";
import { deleteRecord } from "../owner.ts";
import { runAs, type ConnectorRow } from "./caller.ts";
import { deliveryTarget } from "./gates.ts";

export type OnDelete = "keep" | "trash";

/** The connector's policy for an item deleted at the source (anything else than `trash` is the default `keep`). */
export const onDeleteOf = (c: Pick<ConnectorRow, "policy">): OnDelete => (c.policy?.on_delete === "trash" ? "trash" : "keep");

/** A claimed deletion. */
export interface ClaimedDelete { id: string; connector_id: string; item_type: string; record_id: string | null; adopted: boolean; attempts: number }

const SQL_DUE = `i.status = 'deleted_at_source' AND i.reason IS NULL AND i.item_type = ANY($2::text[])
                 AND (i.next_attempt_at IS NULL OR i.next_attempt_at <= now()) AND (i.lease_until IS NULL OR i.lease_until < now())`;

/** Claims one due deletion of an active connector of this instance (a lease; every claim counts as an attempt). */
export async function claimDelete(app: App, types: readonly string[], leaseSec: number): Promise<ClaimedDelete | null> {
  const { rows } = await app.db.control.query(
    `WITH cand AS (
       SELECT i.id FROM connector_items i JOIN connectors c ON c.id = i.connector_id
       WHERE c.instance_id = $1 AND c.status = 'active' AND ${SQL_DUE}
       ORDER BY i.next_attempt_at NULLS FIRST, i.id
       LIMIT 1
       FOR UPDATE OF i SKIP LOCKED)
     UPDATE connector_items x SET lease_until = now() + make_interval(secs => $3), attempts = x.attempts + 1
     FROM cand WHERE x.id = cand.id
     RETURNING x.id, x.connector_id, x.item_type, x.record_id, x.adopted, x.attempts`,
    [app.instanceId, [...types], leaseSec]);
  return (rows[0] as ClaimedDelete | undefined) ?? null;
}

/** Whether a deletion of an active connector of this instance is due. */
export async function anyDeleteDue(app: App, types: readonly string[]): Promise<boolean> {
  const { rows } = await app.db.control.query(
    `SELECT EXISTS (SELECT 1 FROM connector_items i JOIN connectors c ON c.id = i.connector_id WHERE c.instance_id = $1 AND c.status = 'active' AND ${SQL_DUE}) AS due`,
    [app.instanceId, [...types]]);
  return rows[0]?.due === true;
}

type DeleteOutcome = { kind: "done"; reason: DeliveryReasonCode } | { kind: "retry" };

/** Refusals of deleteRecord() that pass by themselves: retried on the ladder, never taken as "not the connector's alone". */
const TEMPORARY: ReadonlySet<string> = new Set(["in_progress", "rate_limited", "internal"]);

/**
 * Whether the record has a placement in any space (record_placements: the same file uploaded into another space). One
 * boolean, no text: the connector still reads nothing of the record. The run-as caller's write pool of the record's class.
 */
async function placedElsewhere(app: App, caller: Caller, cls: DataClass, recordId: string): Promise<boolean> {
  const { rows } = await app.db.recordsForWrite(cls, caller.scope).query("SELECT EXISTS (SELECT 1 FROM record_placements WHERE record_id = $1) AS placed", [recordId]);
  return rows[0]?.placed === true;
}

/** What the policy does with one deletion (the trash itself included); never throws for an ordinary refusal. */
async function decide(app: App, c: ConnectorRow, it: ClaimedDelete): Promise<DeleteOutcome> {
  if (!it.record_id) return { kind: "done", reason: "delete_no_record" };
  if (onDeleteOf(c) === "keep") return { kind: "done", reason: "delete_kept" };
  if (it.adopted) return { kind: "done", reason: "delete_skipped_shared" };
  const shared = await app.db.control.query("SELECT 1 FROM connector_items WHERE record_id = $1 AND id <> $2 LIMIT 1", [it.record_id, it.id]);
  if (shared.rows.length) return { kind: "done", reason: "delete_skipped_shared" };
  const loc = await locate(app, it.record_id);
  if (!loc || loc.deleted) return { kind: "done", reason: "delete_no_record" };
  const who = await runAs(app, c, it.item_type);
  if (!who.ok) return { kind: "done", reason: "delete_skipped_owner" };
  if (loc.owner_id !== who.owner.id) return { kind: "done", reason: "delete_skipped_shared" };
  const gate = await deliveryTarget(app, who.caller, c, it.item_type);
  if (!gate.ok || loc.space_id !== gate.space.id) return { kind: "done", reason: "delete_skipped_moved" };
  // somebody placed the same file into another space by hand (upload() answered already_known and placed the record
  // there): the record is used outside the connector, the trash would take it away from that space too
  if (await placedElsewhere(app, who.caller, loc.class, it.record_id)) return { kind: "done", reason: "delete_skipped_shared" };
  try {
    await deleteRecord(app, who.caller, { id: it.record_id }, "connector_on_delete");
  } catch (e) {
    if (e instanceof MemoryError && e.code === "not_found") return { kind: "done", reason: "delete_no_record" };
    // an operation on the record that runs now (a class move, a version), or a temporary refusal: later
    if (e instanceof MemoryError && TEMPORARY.has(e.code)) return { kind: "retry" };
    if (e instanceof MemoryError) return { kind: "done", reason: "delete_skipped_shared" };
    log.warn("connector_delete_retry", { item_id: it.id, connector_id: c.id, error: String((e as Error)?.name ?? "error") });
    return { kind: "retry" };
  }
  const ev = auditConnectorTrashed({ id: c.id, kind: c.kind, scope: c.scope }, { item_type: it.item_type, record_id: it.record_id, record_class: loc.class });
  await audit(app, who.caller, { event_type: ev.event_type, details: ev.details, record_ids: ev.record_ids, class: ev.class });
  return { kind: "done", reason: "delete_trashed" };
}

/**
 * Handles one claimed deletion: writes the outcome as the reason while the row is still the claimed deletion (a newer
 * staging of the item wins and is delivered instead). `ladder` — minutes before the next attempt; `maxAttempts` — then
 * `delete_failed`.
 */
export async function handleDelete(app: App, c: ConnectorRow, it: ClaimedDelete, ladder: readonly number[], maxAttempts: number): Promise<{ status: string; reason: string | null } | null> {
  const own = "id = $1 AND status = 'deleted_at_source' AND reason IS NULL";
  let o: DeleteOutcome;
  try { o = await decide(app, c, it); } catch (e) {
    log.warn("connector_delete_failed", { item_id: it.id, connector_id: c.id, error: String((e as Error)?.message ?? e).slice(0, 120) });
    o = { kind: "retry" };
  }
  if (o.kind === "retry") {
    if (it.attempts >= maxAttempts) o = { kind: "done", reason: "delete_failed" };
    else {
      const r = await app.db.control.query(`UPDATE connector_items SET lease_until = NULL, next_attempt_at = now() + make_interval(mins => $2) WHERE ${own}`,
                                           [it.id, ladder[Math.min(it.attempts, ladder.length) - 1] ?? 1]);
      return r.rowCount ? { status: "deleted_at_source", reason: null } : null;
    }
  }
  const r = await app.db.control.query(`UPDATE connector_items SET reason = $2, lease_until = NULL, next_attempt_at = NULL WHERE ${own}`, [it.id, o.reason]);
  return r.rowCount ? { status: "deleted_at_source", reason: o.reason } : null;
}
