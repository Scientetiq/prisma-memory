// Chaos hook of the conversion queue: `processing.conversion_fault` — only with MEMORY_TEST_HOOKS=1
// (test installations), as `llm_fault` and `open_check_fault`. Read from the DB on each call (not from the minute
// settings cache): a test needs no reread. Firings are counted for all processes in one row
// `maintenance_state.conversion_fault_probe` — `times` means in total, not per worker, and a crashed process after
// a restart does not crash at the same point again. Journal and log: point, action, firing number; no titles or files.

import { ConverterError, conversionFaultFingerprint, conversionFaultMatches, log, parseConversionFault, testHooksEnabled,
         type ConversionFaultAction, type ConversionFaultPoint } from "@memory/shared";
import type { DbCtx } from "./ctx.ts";

/** Process exit for `crash`; unit tests replace `exit` so as not to bring vitest down. */
export const CONVERSION_FAULT_RUNTIME: { exit: (code: number) => void } = { exit: (code) => { process.exit(code); } };

/** The error a fault is wrapped in (except `crash`): classified like a real converter failure. */
export function conversionFaultError(action: Exclude<ConversionFaultAction, "crash">): ConverterError {
  if (action === "http500") return new ConverterError("http", "converter returned 500 (test-induced failure)", 500, false, undefined, "internal_error");
  if (action === "abort") return new ConverterError("network", "converter request was aborted (test-induced failure)", undefined, false, undefined, "aborted");
  return new ConverterError("network", "converter is unavailable (test-induced failure)", undefined, false, "test_fault");
}

/**
 * Conversion pass point: is a fault ordered here for this record (substring of the title or file name), not yet
 * spent. If it fires, `crash` ends the process, other actions throw ConverterError. No test hooks — nothing (and no DB
 * access).
 */
export async function conversionFaultAt(ctx: DbCtx, point: ConversionFaultPoint, texts: ReadonlyArray<string | null | undefined>): Promise<void> {
  if (!testHooksEnabled()) return;
  const raw = (await ctx.db.control.query("SELECT value FROM settings WHERE instance_id = $1 AND category = 'processing' AND key = 'conversion_fault'", [ctx.instanceId])).rows[0]?.value;
  const f = parseConversionFault(raw);
  if (!f || f.point !== point || !conversionFaultMatches(f, texts)) return;
  const fp = conversionFaultFingerprint(f);
  // a firing is taken by one query: another order — count anew; spent — the row stays, RETURNING is empty
  const got = await ctx.db.control.query(
    `INSERT INTO maintenance_state (instance_id, key, value)
     VALUES ($1, 'conversion_fault_probe', jsonb_build_object('fp', $2::text, 'hits', 1, 'point', $3::text, 'action', $4::text, 'at', now()))
     ON CONFLICT (instance_id, key) DO UPDATE SET updated_at = now(), value = jsonb_build_object('fp', $2::text,
       'hits', CASE WHEN maintenance_state.value->>'fp' = $2::text THEN COALESCE((maintenance_state.value->>'hits')::int, 0) + 1 ELSE 1 END,
       'point', $3::text, 'action', $4::text, 'at', now())
     WHERE maintenance_state.value->>'fp' IS DISTINCT FROM $2::text OR COALESCE((maintenance_state.value->>'hits')::int, 0) < $5::int
     RETURNING (value->>'hits')::int AS hits`, [ctx.instanceId, fp, point, f.action, f.times]);
  if (!got.rowCount) return;
  const hits = Number(got.rows[0]?.hits ?? 0);
  log.warn("conversion_fault_hit", { point, action: f.action, hits, times: f.times });
  if (f.action === "crash") {
    CONVERSION_FAULT_RUNTIME.exit(1);
    // replaced exit (tests) — go on as an aborted pass: the stage must not go past the crash point
    throw conversionFaultError("abort");
  }
  throw conversionFaultError(f.action);
}
