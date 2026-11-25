// run-job exit code by the job result: 3 — busy or stopped (lock, cleanup
// locks), 4 — a search outcomes pass with an error (batch infrastructure or failed stage: weeks, test recount,
// unsettled rows) — rebuild automation must not count such a run as a success; caught_up is only about the cursor.
// 1 — the check after the final purge of test data (test_purge_preview --check) found differences, including
// left or unchecked storage files: `ok: false` must not look like a successful run.
export function jobExitCode(name: string, out: unknown): number {
  if (!out || typeof out !== "object") return 0;
  const o = out as { busy?: unknown; blocked?: unknown; error?: unknown };
  if (name === "outcomes_build") {
    if (o.busy) return 3;
    return typeof o.error === "string" && o.error ? 4 : 0;
  }
  // dismissed people pass: another runs — 3
  if (name === "dismissed_retention") return o.busy ? 3 : 0;
  // open recheck: another run or job tick is going — 3
  if (name === "open_recheck") return o.busy ? 3 : 0;
  if (name === "test_purge_auto") return o.busy || (Array.isArray(o.blocked) && o.blocked.length > 0) ? 3 : 0;
  // storage clean-up: another pass runs — 3; a class's storage did not answer — 4 (the pass is incomplete)
  if (name === "storage_sweep") return (out as { skipped?: unknown }).skipped === "busy" ? 3 : typeof (out as { unavailable?: unknown }).unavailable === "string" ? 4 : 0;
  // whole-instance export: refused before any record was read and before the archive was written — 2; the archive is incomplete — 4
  if (name === "export_instance") { const x = out as { refused?: unknown; complete?: unknown }; return typeof x.refused === "string" ? 2 : x.complete === false ? 4 : 0; }
  if (name === "test_purge_preview") { const c = out as { kind?: unknown; ok?: unknown }; return c.kind === "test_purge_check" && c.ok === false ? 1 : 0; }
  return 0;
}
