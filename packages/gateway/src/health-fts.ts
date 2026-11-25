// Health check fts_index: the full-text language of each records database and whether its
// stored index is whole. A passage without a full-text vector (tsv NULL — retrieval_config without its row) is not found
// by keyword: degraded. A missing row and a wish of search.fts_configs the worker could not apply (a database with
// passages needs a rebuild, an unknown configuration, and the other database that waits for it — both change their
// language together) are ok with a warning — search goes on in the applied language.
import { readAppliedFts, type DataClass } from "@memory/shared";
import type { App } from "./context.ts";
import { poolExhausted } from "./control-lock.ts";

/** Passages without tsv are counted up to this number (the partial index chunks_tsv_null_idx keeps it cheap). */
const MISSING_CAP = 1000;
const SYSTEM = { classes: ["open", "closed"] as const, tier: "system" as const };

export interface FtsIndexCheck { ok: boolean; level?: "warn"; detail: string }

export async function ftsIndexCheck(app: Pick<App, "db" | "instanceId">): Promise<FtsIndexCheck> {
  const parts: string[] = [], problems: string[] = [], warnings: string[] = [];
  for (const cls of ["open", "closed"] as DataClass[]) {
    const db = app.db.records(cls, SYSTEM);
    const fts = await readAppliedFts(db);
    const missing = Number((await db.query(`SELECT count(*)::int AS n FROM (SELECT 1 FROM chunks WHERE tsv IS NULL LIMIT ${MISSING_CAP}) x`)).rows[0]?.n ?? 0);
    parts.push(`${cls}: ${fts.configs.join(" + ") || "none"}${fts.pending ? ` (rebuild to ${fts.pending.join(" + ")})` : ""}`);
    // no row is a defect, but it hurts only through the passages it leaves without tsv (counted next): a warning
    if (!fts.configs.length) warnings.push(`${cls}: no full-text configuration is applied (retrieval_config has no row)`);
    if (missing) problems.push(`${cls}: ${missing >= MISSING_CAP ? `${MISSING_CAP} or more` : missing} passages have no full-text index`);
  }
  try {
    const r = await app.db.control.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = 'fts_config_reconcile'", [app.instanceId]);
    const dbs = (r.rows[0]?.value?.databases ?? {}) as Record<string, { state?: unknown; detail?: unknown } | undefined>;
    for (const [cls, o] of Object.entries(dbs))
      if (o && o.state !== "kept" && o.state !== "applied") warnings.push(`${cls}: search.fts_configs not applied — ${typeof o.detail === "string" ? o.detail.slice(0, 200) : String(o.state)}`);
  } catch (err) {
    if (poolExhausted(err)) throw err;
  }
  const detail = [parts.join("; "), ...problems, ...warnings].join(" | ");
  if (problems.length) return { ok: false, detail };
  return warnings.length ? { ok: true, level: "warn", detail } : { ok: true, detail };
}
