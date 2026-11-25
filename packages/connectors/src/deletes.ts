// Deletions at the source (item type `delete`, deletion detection): the hand-over
// from the processes that learn of a deletion (the hooks handler of the gateway for a `delete` item, the pull runs of the
// workers after a complete run) to the delivery loop of the gateway, which applies the connector's `on_delete` policy.
//
// An item deleted at the source gets status `deleted_at_source` with no reason and a due time: the delivery loop claims
// such rows (reason NULL — not handled yet), keeps or trashes the record and writes the outcome as the reason
// (`delete_kept`, `delete_trashed`, `delete_skipped_*`, `delete_no_record`, `delete_failed`). An item that is being
// delivered right now keeps its lease: the deletion is handled when the lease ends, after the delivery wrote the record id.
// A deleted item that the source sends again is staged again by stageRecordItem (a new delivery).
//
// Entity items are not handled here: a deleted entity is marked in the registry by upsertEntityBatch and never
// deleted. Only record items (document, meeting, note) are marked.
import type { Queryable } from "./secrets.ts";

/** Item types whose deletion at the source the delivery handles. */
export const DELETABLE_ITEM_TYPES = ["document", "meeting", "note"] as const;
export type DeletableItemType = (typeof DELETABLE_ITEM_TYPES)[number];

/** One deleted item: the `of` and `external_id` of a `delete` item, or of a `{deleted}` pull event. */
export interface DeletedRef { of: string; external_id: string }

// the row becomes `deleted_at_source` and due: now, or when the lease of a delivery that runs now ends
const MARK = `status = 'deleted_at_source', reason = NULL, attempts = 0,
              next_attempt_at = CASE WHEN i.status = 'delivering' AND i.lease_until >= now() THEN i.lease_until ELSE now() END,
              lease_until = CASE WHEN i.status = 'delivering' AND i.lease_until >= now() THEN i.lease_until ELSE NULL END`;

/**
 * Marks record items of a connector as deleted at the source (items not staged before are not created; entity refs and
 * items already marked are left as they are). Returns how many items were marked.
 */
export async function markDeletedAtSource(q: Queryable, connectorId: string, refs: readonly DeletedRef[]): Promise<number> {
  const types: string[] = [], ids: string[] = [];
  for (const r of refs ?? []) {
    if (!r || !(DELETABLE_ITEM_TYPES as readonly string[]).includes(r.of) || typeof r.external_id !== "string" || !r.external_id) continue;
    types.push(r.of);
    ids.push(r.external_id);
  }
  if (!types.length) return 0;
  const { rowCount } = await q.query(
    `UPDATE connector_items i SET ${MARK}
       FROM unnest($2::text[], $3::text[]) AS d(item_type, external_id)
      WHERE i.connector_id = $1 AND i.item_type = d.item_type AND i.external_id = d.external_id AND i.status <> 'deleted_at_source'`,
    [connectorId, types, ids]);
  return rowCount ?? 0;
}

/**
 * Deletion detection of a pull source after a COMPLETE run (never after an aborted or capped one): every record item of
 * the connector that this run did not list (`seen_run` is another run or none) and that was received before the run
 * started (an item a webhook staged during the run is not judged by it) is marked deleted at the source.
 * The start of the run is the database's own: `started_at` of the run's row in connector_runs when it has one (both
 * times then come from one clock — `received_at` is set by the database); `runStartedAt` only for a run without a row,
 * and it must then be a time the database gave (a worker's clock ahead of the database would judge items staged during
 * the run).
 */
export async function markUnseenDeleted(q: Queryable, connectorId: string, runId: string, runStartedAt: Date): Promise<number> {
  const { rowCount } = await q.query(
    `UPDATE connector_items i SET ${MARK}
      WHERE i.connector_id = $1 AND i.item_type = ANY($4::text[]) AND i.status <> 'deleted_at_source'
        AND i.seen_run IS DISTINCT FROM $2::uuid
        AND i.received_at < COALESCE((SELECT r.started_at FROM connector_runs r WHERE r.id = $2::uuid AND r.connector_id = $1), $3)`,
    [connectorId, runId, runStartedAt, [...DELETABLE_ITEM_TYPES]]);
  return rowCount ?? 0;
}
