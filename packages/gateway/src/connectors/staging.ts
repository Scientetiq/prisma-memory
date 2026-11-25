// Reading a staged item body for delivery: the object the hooks handler or a pull run wrote to the closed
// bucket (stageRecordItem of @memory/connectors). What was read must hash to the content hash of the claimed row:
// every staging writes a new object and each row names its own, so a mismatch is a damaged object, never a race.
import { decodeStaged, itemHashBytes, STAGED_OBJECT_MAX, StagedBodyError, type RecordItem } from "@memory/connectors";
import type { App } from "../context.ts";

export class StagedReadError extends Error {
  constructor(readonly code: "staged_missing" | "staged_invalid" | "storage_unavailable") { super(code); }
}

const missing = (e: unknown): boolean => {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "NoSuchKey" || code === "NotFound" || code === "NoSuchObject";
};

/** The staged record item of a claimed row; StagedReadError with a code otherwise. */
export async function readStaged(app: App, row: { staged_key: string | null; content_hash: Buffer; item_type: string }): Promise<RecordItem> {
  if (!row.staged_key) throw new StagedReadError("staged_missing");
  let obj: Buffer | null;
  try {
    obj = await app.storage.get("closed", row.staged_key, STAGED_OBJECT_MAX);
  } catch (e) {
    if (missing(e)) throw new StagedReadError("staged_missing");
    if ((e as { code?: unknown })?.code === "too_large") throw new StagedReadError("staged_invalid");
    throw new StagedReadError("storage_unavailable");
  }
  if (!obj) throw new StagedReadError("storage_unavailable");      // storage of the closed class is not configured
  let item: RecordItem;
  try { item = decodeStaged(obj); } catch (e) {
    if (e instanceof StagedBodyError) throw new StagedReadError("staged_invalid");
    throw e;
  }
  if (item.type !== row.item_type || Buffer.compare(itemHashBytes(item), Buffer.from(row.content_hash)) !== 0) throw new StagedReadError("staged_invalid");
  return item;
}
