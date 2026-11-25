// The gateway's HTTP application: index.ts starts exactly this one, tests get the very assembly that runs in production.
// The channel handler is first (channel.ts): request channel, the limit before the key check, paths closed by channel, before
// the key and the database. Then the order is as before: the body limit and /mcp, first run, REST (the admin API inside).
//
// Admin plane: if the admin API has its own listener (MEMORY_ADMIN_LISTEN), this assembly is the main
// listener and the workplace listener: the paths of the admin API, admin sign-in and first setup answer with the same 404
// as an unknown path (adminPathsNotFound, right after the channel handler); firstRunRoutes and adminRoutes are not mounted.
// An unknown path under /api/v1 is then also a 404 before the Origin gate and the key (unknownApiNotFound): otherwise
// without a key it would give 401 and a hidden admin path 404, and the difference would show that admin paths exist.
import { Hono, type MiddlewareHandler } from "hono";
import { streamingBodyLimit } from "./body-limit.ts";
import type { App } from "./context.ts";
import { buildMcp } from "./mcp.ts";
import { buildRest, remoteOf, uploadBodyLimit } from "./rest.ts";
import { firstRunRoutes } from "./admin.ts";
import { channelGate, NOT_FOUND_BODY } from "./channel.ts";
import { processTopology } from "./admin-plane/listeners.ts";
import { compilePath, matchRoute } from "./admin-plane/registry.ts";
import { probeRoutes } from "./probes.ts";

export interface HttpOptions {
  /** Which listener the assembly serves: the main one or the workplace socket (they share one set of routes). */
  listener?: "main" | "workplace";
  /** The admin API on its own listener; by default per MEMORY_ADMIN_LISTEN. */
  adminSeparate?: boolean;
}

/** Paths absent on the main listener when the admin API is separate. Compared case-insensitively and without repeated slashes. */
const ADMIN_ONLY_PATHS = [/^\/api\/v1\/admin(?:\/.*)?$/, /^\/api\/v1\/admin-auth(?:\/.*)?$/, /^\/api\/v1\/first-run\/?$/, /^\/api\/v1\/admin-login\/?$/];
export const isAdminOnlyPath = (path: string): boolean => {
  const p = path.toLowerCase().replace(/\/{2,}/g, "/");
  return ADMIN_ONLY_PATHS.some((re) => re.test(p));
};

/** A 404 on an admin plane path — the unknown-path handler's answer (c.notFound()), with no hint that the path exists. */
export const adminPathsNotFound: MiddlewareHandler = async (c, next) => {
  if (isAdminOnlyPath(c.req.path)) return c.notFound();
  await next();
};

type RouteList = ReadonlyArray<{ method: string; path: string }>;
/**
 * A 404 for an unknown path on /api/v1/* that has no handler for this method (OPTIONS: for no method), before
 * the Origin gate and the key check. routes — the routes of the assembly (Hono keeps the list); read at the first request.
 */
export function unknownApiNotFound(routes: () => RouteList): MiddlewareHandler {
  let known: Array<{ def: { method: string; path: string }; re: RegExp; statics: number }> | null = null;
  return async (c, next) => {
    const path = c.req.path;
    if (!/^\/api\/v1(?:\/|$)/.test(path)) return next();
    known ??= routes().filter((r) => r.method !== "ALL" && !r.path.endsWith("*") && r.path.startsWith("/api/v1"))
      .map((r) => ({ def: r, ...compilePath(r.path) }));
    const method = c.req.method.toUpperCase();
    const hit = method === "OPTIONS" ? known.some((x) => x.re.test(path)) : matchRoute(known, method, path) !== null;
    if (!hit) return c.notFound();
    await next();
  };
}

export function buildHttp(app: App, mcp: ReturnType<typeof buildMcp> = buildMcp(app), o: HttpOptions = {}): Hono {
  const adminSeparate = o.adminSeparate ?? processTopology().adminSeparate;
  const http = new Hono();
  // an unknown path is a JSON not_found, like the whole API: without this the top app answered with a plain 404 text,
  // and with a separate admin API the hidden paths answered unlike the rest of the API
  http.notFound((c) => c.json(NOT_FOUND_BODY, 404));
  http.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    if (!c.res.headers.has("Content-Security-Policy")) c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  });
  http.use("*", channelGate(app, remoteOf));
  // after the channel handler: from outside and on the agents' address its 404 already closes these paths; same answer as before
  if (adminSeparate) {
    http.use("*", adminPathsNotFound);
    http.use("/api/v1/*", unknownApiNotFound(() => http.routes));
  }
  // liveness and readiness probes: outside /api/v1 and not on the external channel's allowlist
  http.route("/", probeRoutes(app));
  // the /mcp body is limited before reading (memory_upload with content_base64): the same limit as a REST document upload
  http.use("/mcp", (c, next) => streamingBodyLimit(uploadBodyLimit(app), (c) => c.json({ code: "too_large", message: "The request body exceeds the size limit" }, 413))(c, next));
  http.all("/mcp", (c) => mcp(c.req.raw, remoteOf(c)));
  if (!adminSeparate) http.route("/", firstRunRoutes(app));
  http.route("/", buildRest(app, { adminSeparate }));
  return http;
}
