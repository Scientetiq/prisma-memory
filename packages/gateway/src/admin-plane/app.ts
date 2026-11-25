import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ADMIN_SESSION_PREFIX, kindFromPrefix } from "@memory/shared";
import type { App } from "../context.ts";
import { authenticate } from "../auth.ts";
import { adminRoutes, firstRunRoutes } from "../admin.ts";
import { NOT_FOUND_BODY } from "../channel.ts";
import { adminPlaneHealth, healthState } from "../health.ts";
import { errorResponse, remoteOf } from "../rest.ts";
import { factorAdminRoutes, factorResetPrecheck, RESET_PATH } from "../factor-admin.ts";
import { oboConsentAdminRoutes } from "../obo-consent.ts";
import { opsAlertsAdminRoutes } from "../ops-alerts-admin.ts";
import { alertsRoutes } from "./alerts-routes.ts";
import { anchorsRoutes } from "./anchors-routes.ts";
import { auditArchiveRoutes } from "./audit-archive-routes.ts";
import { approvalGate, approvalsRoutes } from "./approvals.ts";
import { breakglassRoutes } from "./breakglass.ts";
import { AdminPlaneNotConfigured } from "./db.ts";
import { ListenerConfigError } from "./listeners.ts";
import { adminClientIp, adminPlaneAuth, directAdminCall, routeGate, type AdminEnv } from "./middleware.ts";
import { adminRouteDefs, routeDefProblems } from "./registry.ts";
import { readinessRoutes } from "./readiness.ts";
import { securityModeRoutes } from "./security-mode.ts";
import { isSessionReject, sessionRoutes, verifyAdminSession } from "./session.ts";
import { ssoRoutes } from "./sso.ts";
import { testClockRoutes } from "./test-clock.ts";
import { webauthnRoutes } from "./webauthn-routes.ts";

export const ADMIN_BODY_MAX = 4 * 1_048_576;

export function buildAdminPlane(app: App): Hono<AdminEnv> {
  let problems: string[];
  try { problems = routeDefProblems(adminRouteDefs()); } catch (e) { problems = [(e as Error).message]; }
  if (problems.length) throw new ListenerConfigError(`contracts/admin/admin-routes.json: ${problems.slice(0, 5).join("; ")}`);
  const ap = new Hono<AdminEnv>();
  ap.onError((e, c) => e instanceof AdminPlaneNotConfigured
    ? c.json({ code: "internal", message: e.message }, 503)
    : errorResponse(c, e, app));
  ap.notFound((c) => c.json(NOT_FOUND_BODY, 404));
  ap.use("/api/v1/*", bodyLimit({ maxSize: ADMIN_BODY_MAX, onError: (c) => c.json({ code: "too_large", message: "The request body exceeds the size limit" }, 413) }));
  ap.use("*", adminPlaneAuth(app));
  ap.use("*", routeGate(app, () => ap.routes));
  ap.use(RESET_PATH, factorResetPrecheck(app));
  ap.use("*", approvalGate(app));

  ap.get("/api/v1/health", async (c) => {
    const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
    let admin = false;
    if (bearer?.startsWith(ADMIN_SESSION_PREFIX)) {
      admin = await verifyAdminSession(app, bearer, await adminClientIp(app, c), { direct: directAdminCall(c) }).then((v) => !isSessionReject(v), () => false);
    } else if (bearer && (kindFromPrefix(bearer) === "system" || bearer.startsWith("mem_adm_"))) {
      admin = await authenticate(app, c.req.raw, remoteOf(c)).then((x) => x.principalType === "system", () => false);
    }
    const h = await healthState(app, admin && c.req.query("force") === "1");
    const code = h.status === "fail_closed" ? 503 : 200;
    if (!admin) return c.json({ status: h.status, version: h.version, instance: h.instance }, code);
    return c.json({ ...h, admin_plane: adminPlaneHealth(app) }, code);
  });
  ap.route("/", firstRunRoutes(app));
  ap.route("/", ssoRoutes(app));
  ap.route("/", sessionRoutes(app));
  ap.route("/", webauthnRoutes(app));
  ap.route("/", approvalsRoutes(app));
  ap.route("/", anchorsRoutes(app));
  ap.route("/", readinessRoutes(app));
  ap.route("/", securityModeRoutes(app));
  ap.route("/", breakglassRoutes(app));
  ap.route("/", alertsRoutes(app));
  ap.route("/", auditArchiveRoutes(app));
  ap.route("/", opsAlertsAdminRoutes(app));
  ap.route("/", oboConsentAdminRoutes(app));
  ap.route("/", testClockRoutes());
  ap.route("/api/v1/admin", factorAdminRoutes(app));
  ap.route("/api/v1/admin", adminRoutes(app) as unknown as Hono<AdminEnv>);
  return ap;
}
