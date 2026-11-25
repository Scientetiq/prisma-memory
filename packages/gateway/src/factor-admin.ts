import { createHash } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { asMfaMode } from "@memory/shared/factor";
import { canonicalJson, isHumanSession, newId } from "@memory/shared";
import { APPROVED_EXECUTION_HEADER, HUMAN_SESSION_REQUIRED, approvalIdOf, secondSignatureOn } from "./admin-plane/approvals.ts";
import { describeApproval } from "./admin-plane/approvals-describe.ts";
import { adminDb, AdminPlaneNotConfigured } from "./admin-plane/db.ts";
import type { AdminEnv } from "./admin-plane/middleware.ts";
import { adminNow } from "./admin-plane/test-clock.ts";
import { audit } from "./audit.ts";
import { authcheckFactor, AuthcheckUnavailable } from "./authcheck-client.ts";
import type { AdminCaller, App, Caller } from "./context.ts";

export const RESET_ACTION = "mfa.factor_reset";
export const RESET_PATH = "/api/v1/admin/people/:id/factor/reset";
const BASIC_TTL_MS = 5 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const RESET_ERRORS = {
  reset_approval_invalid: { code: "reset_approval_invalid", message: "The request to reset the second factor was not found, was not approved, has expired or was already used" },
  factor_unavailable: { code: "factor_unavailable", message: "The second factor is not available now. Try again later" },
  admin_plane_required: { code: "admin_plane_required", message: "Resetting a second factor requires the admin plane, which is not configured" },
  not_found: { code: "not_found", message: "No employee has that identifier" },
  factor_self_reset: { code: "factor_self_reset",
    message: "You cannot reset your own second factor: another administrator does that. You can replace the phone yourself with a recovery code in the workplace" },
  security_mode_changed: { code: "conflict", reason: "security_mode_changed",
    message: "Security mode changed to advanced during the reset. The second factor was not reset. Try again using a second signature" },
} as const;

export interface ResetBody { reason: string; identity_confirmed: true; manager_confirmed: true }

export function resetBodyProblem(b: unknown): string | null {
  if (!b || typeof b !== "object" || Array.isArray(b)) return "The body must be an object with {reason, identity_confirmed, manager_confirmed}";
  const o = b as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !["reason", "identity_confirmed", "manager_confirmed"].includes(k));
  if (extra.length) return `Unexpected fields: ${extra.join(", ")}`;
  if (typeof o.reason !== "string" || o.reason.trim().length < 3 || o.reason.length > 300) return "reason: why the factor is being reset, 3 to 300 characters";
  if (o.identity_confirmed !== true) return "identity_confirmed: confirm that you verified identity in person or by video call, rather than by e-mail";
  if (o.manager_confirmed !== true) return "manager_confirmed: confirm that a manager approved the reset";
  return null;
}

const invalidArg = (c: Context, message: string): Response => c.json({ code: "invalid_argument", message }, 400);
const sleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));
export const LATE_RECHECK_MS = 1_000;
const adminOf = (c: Context): AdminCaller | null => (c.get("caller") as Caller | undefined)?.admin ?? null;

async function readBody(c: Context): Promise<unknown> {
  const raw = await c.req.text().catch(() => "");
  try { return raw.trim() ? JSON.parse(raw) : null; } catch { return null; }
}

export function factorResetPrecheck(app: App): MiddlewareHandler<AdminEnv> {
  return async (c, next) => {
    if (c.req.method !== "POST") { await next(); return; }
    if (!c.req.header(APPROVED_EXECUTION_HEADER) && !secondSignatureOn(app) && !isHumanSession(adminOf(c))) return c.json(HUMAN_SESSION_REQUIRED, 403);
    const id = c.req.param("id") ?? "";
    if (!UUID.test(id)) return invalidArg(c, "id: employee identifier (uuid)");
    const r = await app.db.control.query<{ login: string | null }>("SELECT login FROM people WHERE id = $1 AND instance_id = $2",
      [id.toLowerCase(), app.instanceId]);
    if (!r.rows.length) return c.json(RESET_ERRORS.not_found, 404);
    if (!c.req.header(APPROVED_EXECUTION_HEADER)) {
      const problem = resetBodyProblem(await readBody(c));
      if (problem) return invalidArg(c, problem);
    }
    const login = r.rows[0]?.login;
    if (typeof login === "string" && login.trim()) c.set("approvalNames", { person_login: login.trim() });
    await next();
  };
}

async function dbMode(app: App): Promise<"basic" | "advanced"> {
  const has = (await app.db.control.query<{ ok: boolean }>("SELECT to_regprocedure('security_mode(text)') IS NOT NULL AS ok")).rows[0]?.ok === true;
  if (!has) return "basic";
  return (await app.db.control.query<{ m: string }>("SELECT security_mode($1) AS m", [app.instanceId])).rows[0]?.m === "advanced" ? "advanced" : "basic";
}

export function factorAdminRoutes(app: App): Hono<AdminEnv> {
  const r = new Hono<AdminEnv>();

  r.post("/people/:id/factor/reset", async (c) => {
    const a = adminOf(c);
    const personId = c.req.param("id").toLowerCase();
    const b = (await readBody(c)) as ResetBody;
    const problem = resetBodyProblem(b);
    if (problem) return invalidArg(c, problem);
    let db;
    try { db = adminDb(app); } catch (e) {
      if (!(e instanceof AdminPlaneNotConfigured)) throw e;
      return c.json(RESET_ERRORS.admin_plane_required, 503);
    }
    let approvalId: string, requestedBy: string;
    const mode = secondSignatureOn(app) ? "advanced" : "basic";
    const signed = approvalIdOf(c);
    if (signed) {
      const row = (await db.query<{ requested_by: string | null }>("SELECT requested_by FROM admin_approvals WHERE id = $1 AND instance_id = $2",
        [signed, app.instanceId])).rows[0];
      if (!row?.requested_by) return c.json(RESET_ERRORS.reset_approval_invalid, 409);
      approvalId = signed;
      requestedBy = row.requested_by;
    } else {
      if (mode === "advanced") return c.json(RESET_ERRORS.reset_approval_invalid, 409);
      if (!isHumanSession(a) || !a?.personId || !a.sessionId) return c.json(HUMAN_SESSION_REQUIRED, 403);
      if (a.personId.toLowerCase() === personId) return c.json(RESET_ERRORS.factor_self_reset, 403);
      const def = c.get("adminRoute") ?? { id: "admin.people.id.factor.reset.post", action: RESET_ACTION };
      let summary: string;
      try { summary = describeApproval(def, b, { params: { ...(c.get("approvalNames") ?? {}), id: personId } }) || "Reset the second factor"; }
      catch { summary = "Reset the second factor"; }
      summary = summary.replace(/[\u0000-\u001f\u007f]+/g, " ");
      summary = summary.length > 300 ? `${summary.slice(0, 299)}…` : summary;
      const now = adminNow();
      approvalId = newId();
      requestedBy = a.personId;
      await db.query(
        `INSERT INTO admin_approvals (id, instance_id, action, summary, method, path, payload_hash, body_enc, requested_by, requested_local,
                                      requested_session, requested_at, expires_at, subject_hash)
         VALUES ($1, $2, $3, $4, 'POST', $5, $6, NULL, $7, NULL, $8, $9, $10, $11)`,
        [approvalId, app.instanceId, RESET_ACTION, summary, c.req.path, createHash("sha256").update(canonicalJson(b)).digest(), a.personId, a.sessionId,
         now, new Date(now.getTime() + BASIC_TTL_MS), createHash("sha256").update(`${RESET_ACTION}\n${personId}`).digest()]);
      const ok = (await db.query<{ ok: boolean }>("SELECT approval_basic_auto($1) AS ok", [approvalId])).rows[0]?.ok === true;
      if (!ok) {
        await db.query("UPDATE admin_approvals SET cancelled_at = now() WHERE id = $1 AND decision IS NULL", [approvalId]);
        if ((await dbMode(app)) === "advanced") return c.json(RESET_ERRORS.security_mode_changed, 409);
        return c.json(HUMAN_SESSION_REQUIRED, 403);
      }
    }
    let res;
    try {
      res = await authcheckFactor("/v1/factor/reset", { person_id: personId, approval_id: approvalId, requested_by: requestedBy });
    } catch (e) {
      if (!(e instanceof AuthcheckUnavailable)) throw e;
      res = null;
    }
    let late = false;
    if (!res || (res.status !== 200 && res.status !== 404 && res.status !== 409)) {
      for (let i = 0; i < 2 && !late; i++) {
        if (i) await sleep(LATE_RECHECK_MS);
        late = (await db.query<{ c: boolean }>("SELECT consumed_at IS NOT NULL AS c FROM admin_approvals WHERE id = $1", [approvalId])).rows[0]?.c === true;
      }
    }
    const status = late ? 200 : !res ? 503 : res.status === 200 ? 200 : res.status === 404 ? 404 : res.status === 409 ? 409 : 503;
    if (!signed) await db.query("UPDATE admin_approvals SET executed_status = $2 WHERE id = $1", [approvalId, status]);
    if (status !== 200) {
      await audit(app, c.get("caller") as Caller, { event_type: "admin", details: { op: "factor_reset_refused", person_id: personId, approval: approvalId, status, mode } });
      if (status === 404) return c.json(RESET_ERRORS.not_found, 404);
      if (status === 409) return c.json(RESET_ERRORS.reset_approval_invalid, 409);
      return c.json(RESET_ERRORS.factor_unavailable, 503);
    }
    const revoked = late ? 0 : Math.max(0, Math.trunc(Number(res!.body.sessions_revoked ?? 0)) || 0);
    const mailed = late ? null : typeof res!.body.mailed === "boolean" ? res!.body.mailed : null;
    await audit(app, c.get("caller") as Caller, { event_type: "admin", details: {
      op: "factor_reset", person_id: personId, approval: approvalId, mode, sessions_revoked: revoked, reason: b.reason.trim().slice(0, 300),
      identity_confirmed: true, manager_confirmed: true, ...(mailed === null ? {} : { mailed }), ...(late ? { confirmed_late: true } : {}) } });
    return c.json({ reset: true, sessions_revoked: revoked, ...(mailed === null ? {} : { mailed }), ...(late ? { confirmed_late: true } : {}) });
  });

  r.get("/factor/overview", async (c) => {
    const ctl = app.db.control;
    const row = (await ctl.query<{ v: unknown; updated_at: Date | null }>(
      "SELECT COALESCE(value, default_value) AS v, updated_at FROM settings WHERE instance_id = $1 AND category = 'edge' AND key = 'mfa_mode'", [app.instanceId])).rows[0];
    const setting = row ? asMfaMode(row.v) : asMfaMode(app.settings.get<unknown>("edge.mfa_mode", "off"));
    const has = (await ctl.query<{ policy: boolean; floor: boolean; coverage: boolean }>(
      `SELECT to_regprocedure('mfa_policy(text)') IS NOT NULL AS policy, to_regprocedure('mfa_mode_floor(text)') IS NOT NULL AS floor,
              to_regprocedure('mfa_coverage(text)') IS NOT NULL AS coverage`)).rows[0];
    const installed = !!has?.policy && !!has.floor && !!has.coverage;
    const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);
    if (!installed) {
      return c.json({ installed: false, mode: setting, setting, floor: "off", setting_updated_at: iso(row?.updated_at), required_since: null, grace_days: 0, grace_until: null,
                      coverage: { optin: 0, enrolled: 0 }, grace_connections: 0 });
    }
    const [p, f, cov, conn] = await Promise.all([
      ctl.query<{ mode: string; required_since: Date | null; grace_days: number; grace_until: Date | null }>("SELECT * FROM mfa_policy($1)", [app.instanceId]),
      ctl.query<{ f: string }>("SELECT mfa_mode_floor($1) AS f", [app.instanceId]),
      ctl.query<{ optin: number; enrolled: number }>("SELECT * FROM mfa_coverage($1)", [app.instanceId]),
      ctl.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM oauth_connections oc JOIN api_keys k ON k.id = oc.id
          WHERE oc.instance_id = $1 AND oc.origin = 'edge' AND oc.mfa_level = 'none' AND k.revoked_at IS NULL AND k.expires_at > now()`, [app.instanceId]),
    ]);
    const pol = p.rows[0];
    return c.json({
      installed: true, mode: asMfaMode(pol?.mode), setting, floor: asMfaMode(f.rows[0]?.f ?? "off"), setting_updated_at: iso(row?.updated_at),
      required_since: iso(pol?.required_since), grace_days: Math.max(0, Math.min(60, Number(pol?.grace_days ?? 0) || 0)), grace_until: iso(pol?.grace_until),
      coverage: { optin: Number(cov.rows[0]?.optin ?? 0), enrolled: Number(cov.rows[0]?.enrolled ?? 0) },
      grace_connections: Number(conn.rows[0]?.n ?? 0),
    });
  });

  return r;
}
