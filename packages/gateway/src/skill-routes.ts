// The memory skill without a key: the SKILL.md core, the install archive, the manifest with sums and the manifest signature
// (no signature for the version — 404). They hold no memory
// data — only rules and made-up examples, so the routes stand before the key check and are served in fail-closed too; they
// do not query the database (except the client address behind a trusted proxy); no download log, no cookies, no CORS (a
// browser script cannot read them; the gateway Origin gate applies). The request path is joined to nothing. Other
// /api/v1/skill/* go on to the key check: 401 without a key, 404 with a key.
// The four paths are fixed when the routes are registered, from the skill name of the package description
// (contracts/skills/bundle.json via SKILL_NAME); the OpenAPI completeness check reads `${SKILL_NAME}` in them as that name.
import type { Context, Hono } from "hono";
import { notFound, rateLimited, SKILL_NAME, skillFile, skillManifest, skillManifestBytes, skillSignature, skillVersion, skillZip } from "@memory/shared";
import { createHash } from "node:crypto";
import type { App } from "./context.ts";
import { clientAddress } from "./auth.ts";
import { audit } from "./audit.ts";

const sha256 = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

/** Weak If-None-Match comparison (RFC 9110 §13.1.2): W/ is dropped, a comma-separated list, "*" matches any. */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const bare = etag.replace(/^W\//, "");
  return header.split(",").map((t) => t.trim()).some((t) => t === "*" || t.replace(/^W\//, "") === bare);
}

interface Body { bytes: Uint8Array; type: string; disposition?: string }

export function registerSkillRoutes(r: Hono<any>, app: App, remoteOf: (c: Context) => string | null): void {
  /**
   * Limit by client address without a key (the skill bucket, 120 a minute by default). An address behind a trusted proxy needs
   * a database query: database down — window by socket address (shared behind a proxy), the skill is still served. Over it —
   * 429 right here, not a throw into onError: otherwise every refusal would become a log row; only the first
   * refusal of a window is written.
   */
  const limited = async (c: Context): Promise<Response | null> => {
    const sock = remoteOf(c);
    let ip: string | null = sock;
    try { ip = await clientAddress(app, c.req.raw, sock); } catch { ip = sock?.replace(/^::ffff:/, "") ?? null; }
    const hit = app.limiter.takeAnonymous("skill", ip ?? "unknown");
    if (!hit) return null;
    const e = rateLimited(hit.retryAfter);
    if (hit.firstRefusal) void audit(app, null, { event_type: "rate_limited", details: { path: c.req.path }, ip });   // first only
    c.header("Retry-After", String(e.extra.retry_after ?? 1)); c.header("RateLimit-Remaining", "0");
    return c.json(e.body(), 429);
  };

  const send = async (c: Context, body: () => Body): Promise<Response> => {
    const refused = await limited(c);
    if (refused) return refused;
    const b = body();
    const etag = `"sha256-${sha256(b.bytes)}"`;
    const headers: Record<string, string> = {
      ETag: etag, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox", "X-Skill-Version": skillVersion(),
    };
    if (etagMatches(c.req.header("if-none-match"), etag)) return new Response(null, { status: 304, headers });
    return new Response(new Uint8Array(b.bytes), { status: 200, headers: { ...headers, "Content-Type": b.type, ...(b.disposition ? { "Content-Disposition": b.disposition } : {}) } });
  };

  r.get(`/api/v1/skill/${SKILL_NAME}/SKILL.md`, (c) => send(c, () => ({ bytes: skillFile("SKILL.md")!.bytes, type: "text/markdown; charset=utf-8" })));
  r.get(`/api/v1/skill/${SKILL_NAME}.zip`, (c) => send(c, () => ({ bytes: skillZip(), type: "application/zip", disposition: `attachment; filename="${SKILL_NAME}.zip"` })));
  r.get(`/api/v1/skill/${SKILL_NAME}/manifest.json`, (c) => send(c, () => ({ bytes: skillManifestBytes(skillManifest()), type: "application/json; charset=utf-8" })));
  // the version's manifest signature: the same openness and the same limit; no signature for this version — 404 (after the limit)
  r.get(`/api/v1/skill/${SKILL_NAME}/manifest.json.sig`, (c) => send(c, () => {
    const sig = skillSignature();
    if (!sig) throw notFound();
    return { bytes: sig, type: "text/plain; charset=utf-8" };
  }));
}
