import { Hono } from "hono";
import { invalid, isHumanSession, log, notFound } from "@memory/shared";
import type { App } from "../context.ts";
import { audit } from "../audit.ts";
import { intParam, isUuidParam, offsetCursor } from "../paging.ts";
import { adminDb, alertsPool } from "./db.ts";
import type { AdminEnv } from "./middleware.ts";

interface AlertRow {
  id: string; at: Date; level: string; code: string; summary: string; details: Record<string, unknown> | null;
  acked_by: string | null; acked_login: string | null; acked_at: Date | null;
  status: string; subject: string | null; count: number; first_at: Date; last_at: Date;
}
const alertView = (r: AlertRow) => ({
  id: r.id, at: new Date(r.at).toISOString(), level: r.level, code: r.code, summary: r.summary, details: r.details ?? {},
  acked_by: r.acked_by ? (r.acked_login ?? r.acked_by) : null,
  acked_at: r.acked_at ? new Date(r.acked_at).toISOString() : null,
  status: r.status, subject: r.subject, count: Number(r.count), first_at: new Date(r.first_at).toISOString(), last_at: new Date(r.last_at).toISOString(),
});
const ALERT_COLS = `a.id, a.at, a.level, a.code, a.summary, a.details, a.acked_by, p.login AS acked_login, a.acked_at,
                    a.status, a.subject, a.count, a.first_at, a.last_at`;
export const ALERT_LEVEL_FILTERS = ["page", "high", "medium", "metric"] as const;
export const ALERT_STATUS_FILTERS = ["open", "acked", "closed"] as const;

export type AuditShipMode = "off" | "file" | "syslog_tls";
export function auditShipMode(app: Pick<App, "settings">): AuditShipMode {
  const v = app.settings.get<unknown>("observability.audit_ship_mode", "off");
  return v === "file" || v === "syslog_tls" ? v : "off";
}

function shipLagSec(app: Pick<App, "settings">): number {
  const n = Number(app.settings.get<unknown>("observability.audit_ship_lag_sec", 120));
  return Number.isFinite(n) ? Math.min(900, Math.max(30, Math.trunc(n))) : 120;
}

export async function shipBacklogSec(app: App, cursor: { at: string | null; id: string | null }): Promise<number | null> {
  const args: unknown[] = [app.instanceId, shipLagSec(app)];
  let after = "";
  if (cursor.at && cursor.id) { args.push(cursor.at, cursor.id); after = " AND at >= $3::timestamptz AND (at, id) > ($3::timestamptz, $4::uuid)"; }
  try {
    const r = await app.db.auditRead().query(
      `SELECT greatest(0, extract(epoch FROM now() - min(at)))::int AS age FROM audit_events
        WHERE instance_id = $1 AND at < now() - make_interval(secs => $2::int)${after}`, args);
    const age = r.rows[0]?.age;
    return age === null || age === undefined ? 0 : Number(age);
  } catch (e) {
    log.warn("audit_ship_backlog_unreadable", { error: ((e as Error)?.message ?? "").slice(0, 200) });
    return null;
  }
}

export async function auditShipStatus(app: App): Promise<Record<string, unknown>> {
  const mode = auditShipMode(app);
  if (mode === "off") return { mode };
  const st = (await app.db.control.query(
    `SELECT to_char(cursor_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at, cursor_id::text AS cursor_id,
            last_ok_at, last_error_code, last_error_at, to_char(reconciled_day, 'YYYY-MM-DD') AS reconciled_day,
            start_at, history_requested_at, history_per_hour, history_sent, history_done_at
       FROM audit_ship_state WHERE instance_id = $1 AND sink = $2`, [app.instanceId, mode])).rows[0] as
    { cursor_at: string | null; cursor_id: string | null; last_ok_at: Date | null; last_error_code: string | null; last_error_at: Date | null; reconciled_day: string | null;
      start_at: Date | null; history_requested_at: Date | null; history_per_hour: number | null; history_sent: string | number | null; history_done_at: Date | null } | undefined;
  if (!st) return { mode, lag_sec: 0, last_ok_at: null, last_error_code: null, last_error_at: null, reconciled_day: null, mismatch: null, start_at: null, history: null };
  const lag = st.cursor_at ? await shipBacklogSec(app, { at: st.cursor_at, id: st.cursor_id }) : 0;
  let mismatch: boolean | null = null;
  if (st.reconciled_day) {
    const m = await adminDb(app).query("SELECT 1 FROM admin_alerts WHERE instance_id = $1 AND dedupe_key = $2 LIMIT 1",
      [app.instanceId, `audit_ship_mismatch:${mode}:${st.reconciled_day}`]);
    mismatch = (m.rowCount ?? 0) > 0;
  }
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  return {
    mode, lag_sec: lag, last_ok_at: iso(st.last_ok_at),
    last_error_code: st.last_error_code, last_error_at: iso(st.last_error_at),
    reconciled_day: st.reconciled_day, mismatch, start_at: iso(st.start_at),
    history: st.history_requested_at || st.history_done_at || st.history_per_hour != null
      ? { requested_at: iso(st.history_requested_at), per_hour: st.history_per_hour ?? HISTORY_PER_HOUR_DEFAULT, sent: Number(st.history_sent ?? 0), done_at: iso(st.history_done_at) }
      : null,
  };
}

export const HISTORY_PER_HOUR_DEFAULT = 2000;
export const HISTORY_PER_HOUR_RANGE = [100, 100_000] as const;
const HISTORY_NOT_STARTED = { code: "conflict", message: "Audit log forwarding has not run yet. The first pass will establish the cutoff for historical events. Try again in a minute" } as const;
const HISTORY_DONE = { code: "conflict", message: "Historical events have already been forwarded" } as const;

export function alertsRoutes(app: App, o: { alertsOnly?: boolean } = {}): Hono<AdminEnv> {
  const r = new Hono<AdminEnv>();
  // This router also mounts on the legacy listener; unrelated public routes keep their own response rules.
  r.use("/api/v1/admin/alerts/*", async (c, next) => {
    const caller = c.get("caller");
    if (caller?.principalType !== "system") return c.json({ code: "forbidden", message: "Administrator access required." }, 403);
    if (caller.admin?.role === "security_auditor" && c.req.method !== "GET")
      return c.json({ code: "role_forbidden", message: "Administrator access required." }, 403);
    await next();
  });

  r.get("/api/v1/admin/alerts", async (c) => {
    const level = c.req.query("level"), status = c.req.query("status");
    if (level !== undefined && level !== "" && !(ALERT_LEVEL_FILTERS as readonly string[]).includes(level)) throw invalid("level: page, high, medium or metric");
    if (status !== undefined && status !== "" && !(ALERT_STATUS_FILTERS as readonly string[]).includes(status)) throw invalid("status: open, acked or closed");
    const limit = intParam(c.req.query("limit"), 100, 1, 500), offset = offsetCursor(c.req.query("cursor"));
    const { rows } = await alertsPool(app).query(
      `SELECT ${ALERT_COLS} FROM admin_alerts a LEFT JOIN people p ON p.id = a.acked_by
        WHERE a.instance_id = $1 AND ($2::text IS NULL OR a.level = $2) AND ($5::text IS NULL OR a.status = $5)
        ORDER BY a.last_at DESC, a.id DESC LIMIT $3 OFFSET $4`, [app.instanceId, level || null, limit + 1, offset, status || null]);
    return c.json({ items: (rows as AlertRow[]).slice(0, limit).map(alertView), next_cursor: rows.length > limit ? String(offset + limit) : null });
  });

  r.post("/api/v1/admin/alerts/:id/ack", async (c) => {
    const id = c.req.param("id");
    if (!isUuidParam(id)) throw notFound();
    const caller = c.get("caller"), a = caller?.admin;
    if (a?.breakglassWindowId || a?.authMethod === "local_breakglass" || a?.authMethod === "sso_breakglass")
      return c.json({ code: "breakglass_only", message: "Emergency access may only read alerts." }, 403);
    const q = await alertsPool(app).connect(), who = a?.personId ?? null;
    try {
      await q.query("BEGIN");
      const row = (await q.query(`SELECT ${ALERT_COLS} FROM admin_alerts a LEFT JOIN people p ON p.id = a.acked_by WHERE a.id = $1 AND a.instance_id = $2 FOR UPDATE OF a`, [id, app.instanceId])).rows[0] as AlertRow | undefined;
      if (!row) throw notFound();
      // No acked_kind column marks how an alert was acknowledged, so high and page alerts need a human session.
      if ((row.level === "high" || row.level === "page") && !isHumanSession(a ?? null)) {
        await q.query("ROLLBACK");
        return c.json({ code: "human_session_required", message: "A personal administrator session is required." }, 403);
      }
      const byKind = isHumanSession(a ?? null) ? "person" : a?.authMethod === "local" || a?.authMethod === "legacy_session" ? "admin_local" : "system";
      const changed = await q.query("UPDATE admin_alerts SET acked_by = $3, acked_at = now() WHERE id = $1 AND instance_id = $2 AND acked_at IS NULL RETURNING id", [id, app.instanceId, who]);
      // The journal is a separate database: require its receipt before committing the acknowledgement.
      if (changed.rowCount) await audit(app, caller, { event_type: "admin", details: { op: "alert_ack", alert: id, code: row.code, level: row.level, by_kind: byKind } }, { strict: true });
      const acknowledged = (await q.query(`SELECT ${ALERT_COLS} FROM admin_alerts a LEFT JOIN people p ON p.id = a.acked_by WHERE a.id = $1 AND a.instance_id = $2`, [id, app.instanceId])).rows[0] as AlertRow;
      await q.query("COMMIT");
      return c.json(alertView(acknowledged));
    } catch (e) { await q.query("ROLLBACK").catch(() => undefined); throw e; }
    finally { q.release(); }
  });

  if (o.alertsOnly) return r;

  r.get("/api/v1/admin/audit-ship", async (c) => c.json(await auditShipStatus(app)));

  r.post("/api/v1/admin/audit-ship/reconcile", async (c) => {
    if (auditShipMode(app) === "off") throw invalid("External audit log forwarding is off (observability.audit_ship_mode = off). There is nothing to reconcile");
    const queued = await app.queue.wake("audit_ship_reconcile");
    if (!queued) return c.json({ code: "internal", message: "The job queue is unavailable. Try again later" }, 503);
    return c.body(null, 202);
  });

  r.post("/api/v1/admin/audit-ship/history", async (c) => {
    const mode = auditShipMode(app);
    if (mode === "off") throw invalid("External audit log forwarding is off (observability.audit_ship_mode = off). There is no destination for historical events");
    const body = await c.req.json().catch(() => ({})) as { per_hour?: unknown };
    const perHour = body?.per_hour === undefined ? HISTORY_PER_HOUR_DEFAULT : Number(body.per_hour);
    if (!Number.isInteger(perHour) || perHour < HISTORY_PER_HOUR_RANGE[0] || perHour > HISTORY_PER_HOUR_RANGE[1])
      throw invalid(`per_hour must be an integer from ${HISTORY_PER_HOUR_RANGE[0]} to ${HISTORY_PER_HOUR_RANGE[1]} events per hour`);
    const db = adminDb(app);
    const st = (await db.query("SELECT start_at, history_done_at FROM audit_ship_state WHERE instance_id = $1 AND sink = $2", [app.instanceId, mode])).rows[0] as
      { start_at: Date | null; history_done_at: Date | null } | undefined;
    if (!st || !st.start_at) return c.json(HISTORY_NOT_STARTED, 409);
    if (st.history_done_at) return c.json(HISTORY_DONE, 409);
    const upd = await db.query(
      `UPDATE audit_ship_state SET history_requested_at = coalesce(history_requested_at, now()), history_per_hour = $3
        WHERE instance_id = $1 AND sink = $2 AND start_at IS NOT NULL AND history_done_at IS NULL`, [app.instanceId, mode, perHour]);
    if (!upd.rowCount) return c.json(HISTORY_DONE, 409);
    await audit(app, c.get("caller"), { event_type: "admin", details: { op: "audit_ship_history", sink: mode, per_hour: perHour } });
    return c.json(await auditShipStatus(app), 202);
  });

  r.delete("/api/v1/admin/audit-ship/history", async (c) => {
    const mode = auditShipMode(app);
    if (mode === "off") throw invalid("External audit log forwarding is off (observability.audit_ship_mode = off)");
    const res = await adminDb(app).query(
      "UPDATE audit_ship_state SET history_requested_at = NULL WHERE instance_id = $1 AND sink = $2 AND history_requested_at IS NOT NULL AND history_done_at IS NULL",
      [app.instanceId, mode]);
    if ((res.rowCount ?? 0) > 0) await audit(app, c.get("caller"), { event_type: "admin", details: { op: "audit_ship_history_cancel", sink: mode } });
    return c.json(await auditShipStatus(app));
  });
  return r;
}
