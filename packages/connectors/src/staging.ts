// Staged record items: the hand-over from the processes that receive items (the
// hooks handler of the gateway, the pull runs of the workers) to the delivery loop of the gateway. One function writes
// a staged item for both: the body goes to the closed bucket under connectors-staging/<connector_id>/<item_id>/ first,
// the state row (connector_items) second — a row never points to a missing object. Bodies are never stored in the
// control database.
//
// Every staging of an item writes a new object (connectors-staging/<connector_id>/<item_id>/<body_id>): a body is never
// overwritten, so two processes that stage the same item at once cannot leave a row whose hash and object disagree —
// each row update names its own object. Objects no row names any more are the cleanup's (workers).
//
// The staged object is one JSON line (the item without its file bytes, plus `content_length` when bytes follow) and,
// for a document with file bytes, the raw bytes after the line break; a base64 body of a webhook is stored decoded. The
// JSON text never holds a raw line break (JSON escapes it inside strings), so the first one ends the header. The
// delivery reads the object back with decodeStaged() and compares the hash of what it read with the hash of the row it
// claimed: an object rewritten by a newer item is never delivered under the older row.
//
// Same content (equal hash) at an item that is delivered or unchanged → `unchanged`: no body, no write, no audit write
// event. Same content at an item that is still staged or being delivered → nothing changes. Anything else (new item,
// changed content, an item that was held, failed, skipped or deleted at the source) → `staged` again with no attempts:
// the source sending it again is the new delivery that a held or failed item waits for. One exception: an item
// deleted at the source whose record stayed, sent again with the content it delivered, is `unchanged` (the deletion is
// cancelled); one whose record went to the trash or is gone is staged again (a new record).
import { randomUUID } from "node:crypto";
import type { Queryable } from "./secrets.ts";
import { itemHash, MAX_FILE_BYTES, validateItem } from "./sdk/items.ts";
import type { DocumentItem, Problem, RecordItem } from "./sdk/types.ts";

/** Prefix of staged bodies in the closed bucket (outside the original-file sweeps and the inbox prefix). */
export const STAGING_PREFIX = "connectors-staging/";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECORD_TYPES = new Set(["document", "meeting", "note"]);
/** Outcomes of a deletion at the source that leave the item's record in memory (deletes.ts of the gateway). */
const KEPT_ON_DELETE: ReadonlySet<string> = new Set(["delete_kept", "delete_skipped_shared", "delete_skipped_moved", "delete_skipped_owner", "delete_failed"]);
/** Header line of a staged object: the item, its JSON form, at most this long (a 2 000 000-character text in JSON escapes). */
export const STAGED_HEADER_MAX = 16 * 1024 * 1024;
/** Largest staged object: the header and the largest file body. */
export const STAGED_OBJECT_MAX = STAGED_HEADER_MAX + MAX_FILE_BYTES;
const VERSION = 1;

/** Object key of one staged body of an item. */
export function stagingKey(connectorId: string, itemId: string, bodyId: string): string {
  if (![connectorId, itemId, bodyId].every((x) => typeof x === "string" && UUID.test(x))) throw new TypeError("staging key: connector, item and body ids are UUIDs");
  return `${STAGING_PREFIX}${connectorId}/${itemId}/${bodyId}`;
}

export class StagedBodyError extends Error {
  constructor(readonly code: "staged_invalid") { super(code); }
}

/** The staged object of a record item. */
export function encodeStaged(item: RecordItem): Buffer {
  const head: Record<string, unknown> = { ...(item as unknown as Record<string, unknown>) };
  let bytes: Buffer | null = null;
  if (item.type === "document") {
    const d = item as DocumentItem;
    if (d.content instanceof Uint8Array) bytes = Buffer.from(d.content);
    else if (typeof d.content_base64 === "string") bytes = Buffer.from(d.content_base64, "base64");
    delete head.content;
    delete head.content_base64;
  }
  const json = JSON.stringify({ v: VERSION, item: head, ...(bytes ? { content_length: bytes.length } : {}) });
  return bytes ? Buffer.concat([Buffer.from(`${json}\n`, "utf8"), bytes]) : Buffer.from(json, "utf8");
}

/** The record item of a staged object; throws StagedBodyError for anything else. */
export function decodeStaged(obj: Uint8Array): RecordItem {
  const buf = Buffer.from(obj.buffer, obj.byteOffset, obj.byteLength);
  const nl = buf.indexOf(0x0a);
  // The limits staging declares are the decoder's too: the delivery loop refuses an object whose header line grew past
  // STAGED_HEADER_MAX or whose whole size grew past STAGED_OBJECT_MAX, exactly as the module refuses anything else that
  // is not a staged object of this version.
  if (buf.length > STAGED_OBJECT_MAX) throw new StagedBodyError("staged_invalid");
  if ((nl < 0 ? buf.length : nl) > STAGED_HEADER_MAX) throw new StagedBodyError("staged_invalid");
  const headText = (nl < 0 ? buf : buf.subarray(0, nl)).toString("utf8");
  let head: { v?: unknown; item?: unknown; content_length?: unknown };
  try { head = JSON.parse(headText); } catch { throw new StagedBodyError("staged_invalid"); }
  if (!head || head.v !== VERSION || !head.item || typeof head.item !== "object" || Array.isArray(head.item)) throw new StagedBodyError("staged_invalid");
  const item = head.item as Record<string, unknown>;
  if (typeof item.type !== "string" || !RECORD_TYPES.has(item.type)) throw new StagedBodyError("staged_invalid");
  if (head.content_length !== undefined) {
    const body = nl < 0 ? Buffer.alloc(0) : buf.subarray(nl + 1);
    if (item.type !== "document" || body.length !== head.content_length) throw new StagedBodyError("staged_invalid");
    item.content = new Uint8Array(body);
  } else if (nl >= 0) throw new StagedBodyError("staged_invalid");
  return item as unknown as RecordItem;
}

/** Content hash of an item as the state row keeps it (32 bytes). */
export const itemHashBytes = (item: RecordItem): Buffer => Buffer.from(itemHash(item), "hex");

export type StageResult =
  | { ok: true; status: "staged" | "unchanged"; itemId: string; changed: boolean }
  | { ok: false; problems: Problem[] };

/** Writes an object of the closed bucket; the caller binds it to its own storage client. */
export type PutStaged = (key: string, body: Buffer) => Promise<void>;

/**
 * Stages one record item of a connector. The item is checked against the contract first (a refused item writes
 * nothing); the connector is the caller's to check (it exists, belongs to the instance and may run). `runId` — the run
 * that listed the item (deletion detection of pull sources).
 */
export async function stageRecordItem(q: Queryable, put: PutStaged, connectorId: string, item: RecordItem, o: { runId?: string; maxBytes?: number } = {}): Promise<StageResult> {
  if (!item || typeof item !== "object" || !RECORD_TYPES.has((item as { type?: unknown }).type as string))
    return { ok: false, problems: [{ code: "item_invalid:type", path: "/type", message: "a staged item is a document, a meeting or a note" }] };
  const problems = validateItem(item, { maxBytes: o.maxBytes });
  if (problems.length) return { ok: false, problems };
  const body = encodeStaged(item);
  const nl = body.indexOf(0x0a);
  if (body.length > STAGED_OBJECT_MAX || (nl < 0 ? body.length : nl) > STAGED_HEADER_MAX)
    return { ok: false, problems: [{ code: "too_large", path: "", message: "too_large" }] };
  const hash = itemHashBytes(item);
  const runId = o.runId !== undefined && UUID.test(o.runId) ? o.runId : null;
  const version = typeof item.external_version === "string" ? item.external_version : null;
  const cur = (await q.query(
    `SELECT id, content_hash, status, record_id IS NOT NULL AND delivered_at IS NOT NULL AND delivered_at >= received_at AS delivered_this,
            reason IS NULL AND lease_until IS NOT NULL AND lease_until >= now() AS leased, reason
       FROM connector_items WHERE connector_id = $1 AND item_type = $2 AND external_id = $3`,
    [connectorId, item.type, item.external_id])).rows[0] as
    { id: string; content_hash: Buffer; status: string; delivered_this: boolean; leased: boolean; reason: string | null } | undefined;
  if (cur && Buffer.compare(Buffer.from(cur.content_hash), hash) === 0) {
    if (cur.status === "delivered" || cur.status === "unchanged") {
      await q.query("UPDATE connector_items SET status = 'unchanged', external_version = $2, seen_run = COALESCE($3, seen_run) WHERE id = $1",
                    [cur.id, version, runId]);
      return { ok: true, status: "unchanged", itemId: cur.id, changed: false };
    }
    // deleted at the source, and the source lists it again with the content this item already delivered while its
    // record stayed (kept by on_delete, or not handled yet and not being handled now): nothing changed for the memory —
    // `unchanged`, the pending deletion is cancelled; never a "changed document" (versions_unavailable) or a second
    // delivery that takes the connector's quota again (a pull run that missed the file once, a folder that came back)
    if (cur.status === "deleted_at_source" && cur.delivered_this && !cur.leased && (cur.reason === null || KEPT_ON_DELETE.has(cur.reason))) {
      await q.query(
        `UPDATE connector_items SET status = 'unchanged', reason = NULL, attempts = 0, next_attempt_at = NULL, lease_until = NULL, external_version = $2,
                seen_run = COALESCE($3, seen_run) WHERE id = $1 AND status = 'deleted_at_source'`, [cur.id, version, runId]);
      return { ok: true, status: "unchanged", itemId: cur.id, changed: false };
    }
    if (cur.status === "staged" || cur.status === "delivering") {
      if (runId) await q.query("UPDATE connector_items SET seen_run = $2 WHERE id = $1", [cur.id, runId]);
      return { ok: true, status: "staged", itemId: cur.id, changed: false };
    }
  }
  const id = cur?.id ?? randomUUID();
  const key = stagingKey(connectorId, id, randomUUID());
  await put(key, body);
  const { rows } = await q.query(
    `INSERT INTO connector_items AS i (id, connector_id, item_type, external_id, external_version, content_hash, status, attempts, next_attempt_at, staged_key, seen_run)
     VALUES ($1, $2, $3, $4, $5, $6, 'staged', 0, now(), $7, $8)
     ON CONFLICT (connector_id, item_type, external_id) DO UPDATE
       SET external_version = EXCLUDED.external_version, content_hash = EXCLUDED.content_hash, status = 'staged', reason = NULL, attempts = 0,
           next_attempt_at = now(), lease_until = NULL, staged_key = EXCLUDED.staged_key, received_at = now(), seen_run = COALESCE(EXCLUDED.seen_run, i.seen_run)
     RETURNING id`,
    [id, connectorId, item.type, item.external_id, version, hash, key, runId]);
  return { ok: true, status: "staged", itemId: rows[0]?.id ?? id, changed: true };
}
