// Read-back of closed audit archives on the admin listener only. Authentication and the registry's
// memory_admin/security_auditor role checks run before these handlers; keys and hashes are checked by the reader.
import { Readable } from "node:stream";
import { Hono } from "hono";
import { ArchiveAuditUnavailable, ArchiveStorageUnavailable, listArchiveRuns, openArchivePart, parseArchivePart, parseArchiveVerify,
         type ArchiveList } from "../audit-archive.ts";
import type { App } from "../context.ts";
import type { AdminEnv } from "./middleware.ts";

const ROOT = "/api/v1/admin/audit/archive";

/** ASCII fallback plus RFC 5987: even a verified storage filename cannot add a response header. */
function disposition(filename: string): string {
  const fallback = filename.replace(/[^A-Za-z0-9._-]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function auditArchiveRoutes(app: App): Hono<AdminEnv> {
  const r = new Hono<AdminEnv>();
  // Share only in-flight full checks. Each later request checks storage again; quick checks remain independent.
  let full: Promise<ArchiveList> | null = null;
  const fullList = (): Promise<ArchiveList> => {
    if (!full) full = listArchiveRuns(app, { verify: "full" }).finally(() => { full = null; });
    return full;
  };
  // Hono dispatches HEAD as GET. Intercept the original method after the plane's authentication and role gates.
  r.use(ROOT, async (c, next) => {
    if (c.req.method !== "HEAD") return next();
    parseArchiveVerify(c.req.query("verify"));
    return c.body(null, 200, { "Cache-Control": "no-store", "Content-Type": "application/json" });
  });
  r.use("/api/v1/admin/audit/archive/:partition/:part", async (c, next) => {
    if (c.req.method !== "HEAD") return next();
    const { part } = parseArchivePart(c.req.param("partition") ?? "", c.req.param("part") ?? "");
    return c.body(null, 200, { "Cache-Control": "no-store", "Content-Type": part === "manifest" ? "application/json" : "application/gzip" });
  });
  r.get(ROOT, async (c) => {
    c.header("Cache-Control", "no-store");
    const verify = parseArchiveVerify(c.req.query("verify"));
    return c.json(await (verify === "full" ? fullList() : listArchiveRuns(app, { verify })));
  });
  r.get("/api/v1/admin/audit/archive/:partition/:part", async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      const dl = await openArchivePart(app, c.get("caller"), c.req.param("partition"), c.req.param("part"));
      return new Response(Readable.toWeb(dl.stream) as unknown as ReadableStream<Uint8Array>, {
        headers: { "Content-Type": dl.contentType,
          "Content-Disposition": disposition(dl.filename), "X-Content-SHA256": dl.sha256, "Cache-Control": "no-store" },
      });
    } catch (e) {
      if (e instanceof ArchiveStorageUnavailable || e instanceof ArchiveAuditUnavailable)
        return c.json({ code: "internal", reason: e.reason, message: e.message }, 503);
      throw e;
    }
  });
  return r;
}
