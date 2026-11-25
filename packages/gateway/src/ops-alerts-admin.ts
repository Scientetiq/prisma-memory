// Alerts in the admin API: "Send test alerts", "Build the digest now", the edge quota report
// "who would be refused" and host facts of the mode. The alert list and "Accepted" are in admin-plane/alerts-routes.ts (the core
// and joining fields). Route classes and roles: contracts/admin/admin-routes.json (checked by the listener's routeGate).
// - POST /api/v1/admin/alerts/test — an ops event with the code ops_test_<level> along the same path as real alerts: journal →
// the alert_detectors worker job → mail (urgent and high at once, medium into the digest). Who pressed — an admin event;
// - POST /api/v1/admin/alerts/digest-now — wakes the alert_digest worker queue (a digest without the hour check); mail off
// or no recipients — 409, nothing to digest — 202 with queued 0 without waking. Something to digest — queued = the number of
// recipients, and the mail really goes to them: the reminder of unhandled alerts by the button is set with the job
// key, not once a day (worker, alertDigestPass runKey);
// - GET /api/v1/admin/edge/quota-report — from the journal (edge events quota_would_refuse, quota_refused): people, quota kinds,
// on how many days there would have been a refusal and there was one. The person's name is from the card; by pages;
// - GET /api/v1/admin/alerts/host-facts — the last host_mode_facts event (the host mode check): only the keys of
// detail_keys of the code from contracts/edge/audit-codes.json, plain values.
// Plus the health line alertChannelCheck: sign-in from outside is on but there are no alert recipients — the warning "alerts go
// to no one" (the embedding is one line in health.ts).
import { Hono } from "hono";
import { alertMailOff, alertRecipients, instanceTz, invalid, log, opsCode, opsEvent, securityAlertCodes } from "@memory/shared";
import type { App } from "./context.ts";
import { audit } from "./audit.ts";
import { intParam, offsetCursor } from "./paging.ts";
import { adminDb } from "./admin-plane/db.ts";
import type { AdminEnv } from "./admin-plane/middleware.ts";

/** Test codes by level (contracts/edge/audit-codes.json). */
export const TEST_ALERT_CODES = { page: "ops_test_page", high: "ops_test_high", medium: "ops_test_medium" } as const;
type TestLevel = keyof typeof TEST_ALERT_CODES;
/** Edge quota kinds — as EdgeQuotaReport.kind in OpenAPI. */
export const QUOTA_KINDS = ["search", "read", "list", "text_tokens", "originals", "originals_mib", "c2_items", "c2_mib"] as const;
/** The digest and reminder window — as in the worker (ALERT_DIGEST_WINDOW_DAYS, ALERT_CATCHUP_DAYS). */
const DIGEST_DAYS = 7, OPEN_DAYS = 30;
/** Settings reads — as in alertMailOff. */
interface SettingsGet { get<T>(path: string, fallback: T): T }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is there anything to digest: medium ones without a digest (or repeated after it) and unhandled high security alerts. */
export async function digestPending(app: App): Promise<boolean> {
  const r = await adminDb(app).query(
    `SELECT EXISTS (SELECT 1 FROM admin_alerts WHERE instance_id = $1 AND level = 'medium' AND last_at > now() - make_interval(days => $2)
                       AND (digest_at IS NULL OR (status = 'open' AND last_at > digest_at)))
         OR EXISTS (SELECT 1 FROM admin_alerts WHERE instance_id = $1 AND level IN ('high', 'page') AND status = 'open' AND acked_at IS NULL
                       AND code = ANY($3::text[]) AND last_at > now() - make_interval(days => $4)) AS any`,
    [app.instanceId, DIGEST_DAYS, securityAlertCodes(), OPEN_DAYS]);
  return r.rows[0]?.any === true;
}

/** Plain values of host facts by the code's keys; long strings are cut. */
export function hostFacts(details: Record<string, unknown> | null | undefined): Record<string, string | number | boolean> {
  const keys = opsCode("host_mode_facts")?.detail_keys ?? [];
  const out: Record<string, string | number | boolean> = {};
  for (const k of keys) {
    const v = details?.[k];
    if (typeof v === "string") out[k] = v.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 300);
    else if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) out[k] = v;
  }
  return out;
}

/**
 * Health: sign-in from outside is on (edge.login_enabled) but no alert recipients — ok with level warn: the status stays, but
 * the panel shows that no one would learn of an edge capture. Sign-in off — null (no line, a dark launch).
 */
export function alertChannelCheck(s: SettingsGet): { ok: boolean; level?: "ok" | "warn" | "fail"; detail?: string } | null {
  if (s.get<unknown>("edge.login_enabled", false) !== true) return null;
  const off = alertMailOff(s);
  return off
    ? { ok: true, level: "warn", detail: `Sign-in from outside is on, but alert e-mails have no recipients: ${off}. Set recipients under “Alerts”` }
    : { ok: true, detail: `alert recipients: ${alertRecipients(s).length}` };
}

export function opsAlertsAdminRoutes(app: App): Hono<AdminEnv> {
  const r = new Hono<AdminEnv>();

  r.post("/api/v1/admin/alerts/test", async (c) => {
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const level = body && typeof body === "object" && !Array.isArray(body) ? body.level : undefined;
    if (!body || Object.keys(body).some((k) => k !== "level") || typeof level !== "string" || !Object.hasOwn(TEST_ALERT_CODES, level))
      throw invalid("level: page, high or medium");
    const code = TEST_ALERT_CODES[level as TestLevel];
    if (!(await opsEvent(app.db.audit, app.instanceId, code, {}))) {
      log.error("ops_test_code_missing", { code });
      return c.json({ code: "internal", message: "The test alert code was not found in contracts/edge/audit-codes.json" }, 500);
    }
    await audit(app, c.get("caller"), { event_type: "admin", details: { op: "alert_test", level } });
    return c.json({ code }, 202);
  });

  r.post("/api/v1/admin/alerts/digest-now", async (c) => {
    const off = alertMailOff(app.settings);
    if (off) return c.json({ code: "conflict", message: `Alert e-mails are not being sent: ${off}` }, 409);
    const queued = (await digestPending(app)) ? alertRecipients(app.settings).length : 0;
    if (queued) {
      // the alert_digest queue is created by the worker (registerAlertDetectors)
      const ok = await app.queue.wake("alert_digest");
      if (!ok) return c.json({ code: "internal", message: "The job queue is unavailable. Try again later" }, 503);
    }
    await audit(app, c.get("caller"), { event_type: "admin", details: { op: "alert_digest_now", queued } });
    return c.json({ queued }, 202);
  });

  r.get("/api/v1/admin/edge/quota-report", async (c) => {
    const days = intParam(c.req.query("days"), 14, 1, 60, "days");
    const limit = intParam(c.req.query("limit"), 50, 1, 200);
    const cursor = c.req.query("cursor");
    if (cursor !== undefined && cursor.length > 200) throw invalid("cursor: the opaque string from the previous response (next_cursor)");
    const offset = offsetCursor(cursor);
    const tz = instanceTz(app.settings);
    const rows = (await app.db.auditRead().query(
      `WITH ev AS (
         SELECT details->>'person_id' AS person_id, details->>'kind' AS kind, details->>'code' AS code, (at AT TIME ZONE $3)::date AS day
           FROM audit_events
          WHERE instance_id = $1 AND event_type = 'edge_event' AND details->>'code' IN ('quota_would_refuse', 'quota_refused')
            AND at > now() - make_interval(days => $2) AND details->>'kind' = ANY($4::text[])
            AND details->>'person_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
       SELECT person_id, kind, count(DISTINCT day) FILTER (WHERE code = 'quota_would_refuse')::int AS w,
              count(DISTINCT day) FILTER (WHERE code = 'quota_refused')::int AS r
         FROM ev GROUP BY person_id, kind
        ORDER BY count(DISTINCT day) DESC, person_id, kind LIMIT $5 OFFSET $6`,
      [app.instanceId, days, tz, [...QUOTA_KINDS], limit + 1, offset])).rows as Array<{ person_id: string; kind: string; w: number; r: number }>;
    const page = rows.slice(0, limit);
    const ids = [...new Set(page.map((x) => x.person_id).filter((x) => UUID.test(x)))];
    const names = new Map<string, string>();
    if (ids.length) {
      const p = await app.db.control.query("SELECT id::text AS id, display_name, login FROM people WHERE instance_id = $1 AND id = ANY($2::uuid[])", [app.instanceId, ids]);
      for (const x of p.rows as Array<{ id: string; display_name: string | null; login: string }>) names.set(x.id, x.display_name || x.login);
    }
    return c.json({
      days,
      items: page.map((x) => ({ person_id: x.person_id, display_name: names.get(x.person_id) ?? "no profile", kind: x.kind, days_would_refuse: x.w, days_refused: x.r })),
      next_cursor: rows.length > limit ? String(offset + limit) : null,
    });
  });

  r.get("/api/v1/admin/alerts/host-facts", async (c) => {
    const row = (await app.db.auditRead().query(
      `SELECT at, details FROM audit_events WHERE instance_id = $1 AND event_type = 'ops' AND details->>'code' = 'host_mode_facts'
        ORDER BY at DESC, id DESC LIMIT 1`, [app.instanceId])).rows[0] as { at: Date; details: Record<string, unknown> } | undefined;
    return c.json({ at: row ? new Date(row.at).toISOString() : null, facts: row ? hostFacts(row.details) : {} });
  });

  return r;
}
