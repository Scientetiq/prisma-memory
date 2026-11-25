// REST routes of the space export: POST /api/v1/me/spaces/:slug/export (a streamed tar.gz) and
// GET /api/v1/me/spaces/:slug/export/preview (numbers of what would be exported). Workplace session only; the external
// agents' address does not route /api/v1/me/* at all (channel.ts EXTERNAL_PATHS). The OpenAPI contract describes them
// later; until then these routes are additive and nothing validates them against the contract.
import { Readable, Transform, pipeline } from "node:stream";
import type { Hono } from "hono";
import { archiveFileName, EXPORT_FORMAT, ExportAbort, exportArchive, exportMessage, log, type ExportResult } from "@memory/shared";
import type { App, Caller } from "../context.ts";
import { audit, AuditUnavailable } from "../audit.ts";
import { EXPORT_TIMING, exportPreview, ownerNotices, requireExportEnabled, startSpaceExport, type ExportRun } from "./space-export.ts";

type Env = { Variables: { caller: Caller } };

/** Rate-limit bucket of the export itself (6 a minute by default, limits.ts); the preview uses spaces_view. */
export const EXPORT_BUCKET = "export";

export function registerExport(r: Hono<Env>, app: App): void {
  r.get("/api/v1/me/spaces/:slug/export/preview", async (c) => {
    requireExportEnabled(app);                       // the switch first: a switched-off feature does not spend the window
    const caller = c.get("caller");
    app.limiter.check(caller, "spaces_view");
    return c.json(await exportPreview(app, caller, c.req.param("slug") ?? ""));
  });

  r.post("/api/v1/me/spaces/:slug/export", async (c) => {
    requireExportEnabled(app);
    const caller = c.get("caller");
    app.limiter.check(caller, EXPORT_BUCKET);
    let run: ExportRun;
    try { run = await startSpaceExport(app, caller, c.req.param("slug") ?? ""); }
    catch (e) {
      // the audit log did not accept the start (or its read side is down): nothing is sent — in this feature's own words
      if (e instanceof AuditUnavailable) { log.error("space_export_audit_unavailable", { path: c.req.path }); return c.json({ code: "internal", message: exportMessage("export.audit_unavailable") }, 503); }
      throw e;
    }
    const createdAt = new Date();
    const deadline = createdAt.getTime() + EXPORT_TIMING.capMs;
    let outcome: ExportResult | null = null, sent = 0, closed = false, timedOut = false;
    const stop = new AbortController();
    const tgz = exportArchive(run.items, {
      instance: app.instanceId, by: caller.person!.login, createdAt, deadline, signal: stop.signal,
      scope: { kind: "space", spaces: [run.space.slug], classes: run.classes, originals: true },
      skipped: () => run.skipped, onDone: (res) => { outcome = res; },
    });
    const counter = new Transform({ transform(chunk: Buffer, _enc, cb) { sent += chunk.length; cb(null, chunk); } });
    pipeline(tgz, counter, () => undefined);
    // the time cap, also when nothing moves (as the original download, originals.ts): at the cap the export is stopped
    // where it waits (EXPORT-INCOMPLETE.txt when the reader still reads); a grace later the response is closed — a reader
    // that stopped reading, or a storage that does not answer, must not hold the slot
    const capTimer = setTimeout(() => { timedOut = true; stop.abort(new ExportAbort("time_limit")); }, Math.max(0, deadline - Date.now()));
    const hardTimer = setTimeout(() => { timedOut = true; counter.destroy(new Error("space export time limit")); }, Math.max(0, deadline - Date.now()) + EXPORT_TIMING.graceMs);
    capTimer.unref?.(); hardTimer.unref?.();
    // the closing event — when the response stream is closed: sent to the end, the reader went away, or the time cap
    counter.once("close", () => {
      clearTimeout(capTimer); clearTimeout(hardTimer);
      if (closed) return;
      closed = true;
      // the source frees its slot in its own `finally`; a source never started (the reader left at once) has none to run
      void run.items.return(undefined).catch(() => undefined);
      run.release();
      const o: ExportResult = { ...(outcome ?? { complete: false, reason: "client_closed", spaces: 0, records: 0, originals: 0, original_bytes: 0, skipped: {}, last: null }) };
      if (!o.complete && timedOut && o.reason === "client_closed") o.reason = "time_limit";
      const skipped = { ...run.skipped, ...o.skipped };
      if (!o.complete) log.warn("space_export_incomplete", { space: run.space.slug, reason: o.reason, records: o.records });
      const details = { op: "export_done", space: run.space.slug, format: EXPORT_FORMAT, records: o.records, originals: o.originals, original_bytes: o.original_bytes,
                        bytes: sent, skipped, complete: o.complete, ...(o.reason ? { reason: o.reason } : {}) };
      // the person's own event first, then its copies for the other owners of the space (their "My actions")
      void (async () => {
        await audit(app, caller, { event_type: "read", class: null, space_id: run.space.id, result_count: o.records, details });
        await ownerNotices(app, caller, run.space, run.owners, details, false, o.records);
      })().catch(() => undefined);
    });
    return new Response(Readable.toWeb(counter) as unknown as ReadableStream<Uint8Array>, {
      status: 200,
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${archiveFileName(run.space.slug, createdAt)}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });
}
