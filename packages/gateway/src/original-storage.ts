// persist only the latest put outcome per class. A successful bucket probe does not prove that uploads work.
import { log, type DataClass } from "@memory/shared";
import type { App } from "./context.ts";
import { originalHealthDetail, originalStateUnavailable, type OriginalReason } from "./original-storage.messages.ts";

type PutOutcome = { ok: true } | { ok: false; reason: OriginalReason };
const keys = ["original_storage:open", "original_storage:closed"];
const reasonOf = (error: unknown): OriginalReason => {
  const e = error as { code?: unknown; statusCode?: unknown } | null;
  // Classify structured status/code only. Unknown transport failures stay unavailable, never copy remote error text.
  if ((typeof e?.statusCode === "number" && e.statusCode >= 400 && e.statusCode < 500 && e.statusCode !== 408 && e.statusCode !== 429)
      || ["AccessDenied", "NoSuchBucket", "InvalidAccessKeyId", "SignatureDoesNotMatch", "EntityTooLarge", "ENAMETOOLONG"].includes(String(e?.code)))
    return "storage_refused";
  return "storage_unavailable";
};

/** The caller keeps the actual put inside its upload lock. No provider reply or object identifier is persisted or logged. */
export async function originalPut(app: App, cls: DataClass, put: () => Promise<boolean>): Promise<PutOutcome> {
  let outcome: PutOutcome;
  try { outcome = await put() ? { ok: true } : { ok: false, reason: "storage_not_configured" }; }
  catch (error) { outcome = { ok: false, reason: reasonOf(error) }; }
  if (!outcome.ok) log.warn("original_not_stored", { class: cls, reason: outcome.reason });
  await app.db.control.query(
    `INSERT INTO maintenance_state (instance_id, key, value, updated_at) VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (instance_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [app.instanceId, `original_storage:${cls}`, JSON.stringify(outcome)]);
  return outcome;
}

export async function originalStorageCheck(app: App): Promise<{ ok: boolean; detail?: string }> {
  const rows = (await app.db.control.query("SELECT key, value FROM maintenance_state WHERE instance_id = $1 AND key = ANY($2::text[])", [app.instanceId, keys])).rows;
  const details: string[] = [];
  for (const row of rows) {
    if (row.value?.ok === true) continue;
    const reason: unknown = row.value?.reason;
    if (row.value?.ok !== false || !["storage_not_configured", "storage_unavailable", "storage_refused"].includes(String(reason)))
      return { ok: false, detail: originalStateUnavailable() };
    details.push(originalHealthDetail(reason as OriginalReason, row.key === keys[0] ? "open" : "closed"));
  }
  return details.length ? { ok: false, detail: details.join(" ") } : { ok: true };
}
