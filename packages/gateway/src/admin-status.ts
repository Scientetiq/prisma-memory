import type { Hono } from "hono";
import type pg from "pg";
import type { App } from "./context.ts";
import { withAuditRead } from "./report-search-quality.ts";

export const STATUS_LOOKBACK_DAYS = 90;

export interface CheckSummary { at: string; ok: boolean; failed: string[]; failed_steps: string[] }
export interface LoginSourceStatus { last_check: CheckSummary | null; last_login_at: string | null; logins_24h: number; refusals_24h: number }

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
export const changedBy = (label: unknown): string | null => (typeof label === "string" && label.startsWith("admin:") ? label.slice(6) : null);

async function sourceStatus(q: pg.PoolClient, instanceId: string, source: "ldap" | "oidc"): Promise<LoginSourceStatus> {
  const look = `a.at > now() - interval '${STATUS_LOOKBACK_DAYS} days'`;
  const check = (await q.query(
    `SELECT a.at, a.details FROM audit_events a WHERE a.instance_id = $1 AND a.event_type = 'admin' AND a.details->>'op' = $2 AND ${look}
      ORDER BY a.at DESC LIMIT 1`, [instanceId, `${source}_check`])).rows[0];
  const login = (await q.query(
    `SELECT a.at FROM audit_events a WHERE a.instance_id = $1 AND a.event_type = 'admin' AND a.details->>'op' = 'login' AND a.details->>'source' = $2 AND ${look}
      ORDER BY a.at DESC LIMIT 1`, [instanceId, source])).rows[0];
  const day = (await q.query(
    `SELECT count(*) FILTER (WHERE a.event_type = 'admin' AND a.details->>'op' = 'login' AND a.details->>'source' = $2)::int AS logins,
            count(*) FILTER (WHERE a.event_type IN ('auth_failure', 'rate_limited') AND a.details->>'reason' = $3)::int AS refusals
       FROM audit_events a WHERE a.instance_id = $1 AND a.event_type IN ('admin', 'auth_failure', 'rate_limited') AND a.at > now() - interval '24 hours'`,
    [instanceId, source, `${source}_login`])).rows[0];
  return {
    last_check: check ? { at: iso(check.at)!, ok: check.details?.ok === true, failed: strings(check.details?.failed), failed_steps: strings(check.details?.failed_steps) } : null,
    last_login_at: iso(login?.at), logins_24h: Number(day?.logins ?? 0), refusals_24h: Number(day?.refusals ?? 0),
  };
}

export async function loginStatus(app: App) {
  const audit = await withAuditRead(app, async (q) => {
    const ldap = await sourceStatus(q, app.instanceId, "ldap");
    const oidc = await sourceStatus(q, app.instanceId, "oidc");
    const test = (await q.query(
      `SELECT a.at, a.details FROM audit_events a WHERE a.instance_id = $1 AND a.event_type = 'admin' AND a.details->>'op' = 'smtp_test'
          AND a.at > now() - interval '${STATUS_LOOKBACK_DAYS} days' ORDER BY a.at DESC LIMIT 1`, [app.instanceId])).rows[0];
    const change = (await q.query(
      `SELECT a.at, a.client_label FROM audit_events a WHERE a.instance_id = $1 AND a.event_type = 'admin' AND a.details->>'op' = 'settings_update'
          AND a.at > now() - interval '${STATUS_LOOKBACK_DAYS} days'
          AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(a.details->'keys') = 'array' THEN a.details->'keys' ELSE '[]'::jsonb END) k WHERE k LIKE 'smtp.%')
        ORDER BY a.at DESC LIMIT 1`, [app.instanceId])).rows[0];
    return { ldap, oidc, test, change };
  });
  const sent = (await app.db.control.query("SELECT max(sent_at) AS at FROM mail_outbox WHERE instance_id = $1 AND status = 'sent'", [app.instanceId])).rows[0];
  const t = audit.test;
  return {
    ldap: audit.ldap, oidc: audit.oidc,
    smtp: {
      last_test: t ? { at: iso(t.at)!, via: typeof t.details?.via === "string" ? t.details.via : null, ok: typeof t.details?.ok === "boolean" ? t.details.ok : null,
                       code: typeof t.details?.code === "string" ? t.details.code : null } : null,
      last_settings_change: audit.change ? { at: iso(audit.change.at)!, by: changedBy(audit.change.client_label) } : null,
      last_sent_at: iso(sent?.at),
    },
  };
}

export function registerStatusAdmin(r: Hono<any>, app: App): void {
  r.get("/login-status", async (c) => c.json(await loginStatus(app)));
}
