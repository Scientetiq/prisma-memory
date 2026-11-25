import { log } from "@memory/shared";
import { auditWorkerStrictMany, type DbCtx } from "../ctx.ts";

export const ADMIN_PLANE_KEEP = {
  sessionsDays: 30, approvalsDays: 365, alertsDays: 180, attemptsDays: 365, consentsDays: 365,
} as const;

export interface AdminPlaneGcResult {
  consents: { expired: number; person_inactive: number; service_off: number; deleted: number };
  webauthn: { disabled: number; deleted: number };
  approvals: { bodies: number; deleted: number };
  sessions: number; alerts: number; attempts: number;
}

async function closeConsents(ctx: DbCtx, reason: "expired" | "person_inactive" | "service_off", where: string): Promise<number> {
  const { rows } = await ctx.db.control.query(
    `UPDATE obo_read_consents x SET revoked_at = now(), revoked_by = $2
      WHERE x.instance_id = $1 AND x.revoked_at IS NULL AND (${where})
      RETURNING x.person_id::text AS person, x.service_id::text AS service`, [ctx.instanceId, reason]);
  if (rows.length) {
    await auditWorkerStrictMany(ctx, (rows as Array<{ person: string; service: string }>).map((r) => ({
      event_type: "admin" as const, details: { op: "obo_consent_revoke", service: r.service, revoked_by: reason, author: r.person } })))
      .catch((e: unknown) => log.error("audit_write_failed", { op: "obo_consent_revoke", error: ((e as Error)?.message ?? "").slice(0, 200) }));
  }
  return rows.length;
}

const PERSON_GONE = "NOT EXISTS (SELECT 1 FROM people p WHERE p.id = x.person_id AND p.active)";
const SERVICE_OFF = "NOT EXISTS (SELECT 1 FROM services s WHERE s.id = x.service_id AND s.active AND s.obo_allowed AND s.obo_read)";

export async function oboConsentSweep(ctx: DbCtx): Promise<{ person_inactive: number; service_off: number }> {
  return {
    person_inactive: await closeConsents(ctx, "person_inactive", PERSON_GONE),
    service_off: await closeConsents(ctx, "service_off", SERVICE_OFF),
  };
}

export async function adminPlaneGc(ctx: DbCtx): Promise<AdminPlaneGcResult> {
  const c = ctx.db.control, i = ctx.instanceId, K = ADMIN_PLANE_KEEP;
  const n = async (sql: string, args: unknown[]): Promise<number> => (await c.query(sql, args)).rowCount ?? 0;

  const consents = {
    expired: await closeConsents(ctx, "expired", "x.expires_at <= now()"),
    person_inactive: await closeConsents(ctx, "person_inactive", PERSON_GONE),
    service_off: await closeConsents(ctx, "service_off", SERVICE_OFF),
    deleted: await n("DELETE FROM obo_read_consents WHERE instance_id = $1 AND revoked_at < now() - make_interval(days => $2)", [i, K.consentsDays]),
  };
  const webauthn = {
    deleted: await n("DELETE FROM admin_webauthn_credentials w WHERE w.instance_id = $1 AND NOT EXISTS (SELECT 1 FROM people p WHERE p.id = w.person_id)", [i]),
    disabled: await n(
      `UPDATE admin_webauthn_credentials w SET disabled_at = now(), disabled_reason = 'person_inactive'
        WHERE w.instance_id = $1 AND w.disabled_at IS NULL AND EXISTS (SELECT 1 FROM people p WHERE p.id = w.person_id AND NOT p.active)`, [i]),
  };
  const approvals = {
    bodies: await n(
      `UPDATE admin_approvals SET body_enc = NULL
        WHERE instance_id = $1 AND body_enc IS NOT NULL
          AND (decision = 'rejected' OR cancelled_at IS NOT NULL OR executed_at IS NOT NULL OR expires_at <= now())`, [i]),
    deleted: await n("DELETE FROM admin_approvals WHERE instance_id = $1 AND requested_at < now() - make_interval(days => $2)", [i, K.approvalsDays]),
  };
  const sessions = await n(
    `DELETE FROM admin_sessions WHERE instance_id = $1
       AND (expires_at < now() - make_interval(days => $2) OR revoked_at < now() - make_interval(days => $2))`, [i, K.sessionsDays]);
  const alerts = await n(
    `DELETE FROM admin_alerts WHERE instance_id = $1
       AND CASE WHEN code = 'admin_sso_login_disabled'
         THEN coalesce((SELECT coalesce(nullif(value, 'null'::jsonb), default_value) = 'true'::jsonb
           FROM settings WHERE instance_id = $1 AND category = 'admin' AND key = 'sso_login_enabled'), false)
           AND greatest(last_at, coalesce(acked_at, last_at)) < now() - make_interval(days => $2)
         ELSE last_at < now() - make_interval(days => $2) END`,
    [i, K.alertsDays]);
  const attempts = await n("DELETE FROM breakglass_attempts WHERE instance_id = $1 AND at < now() - make_interval(days => $2)", [i, K.attemptsDays]);

  const out = { consents, webauthn, approvals, sessions, alerts, attempts };
  const total = Object.values(consents).reduce((a, b) => a + b, 0) + webauthn.deleted + webauthn.disabled + approvals.bodies + approvals.deleted + sessions + alerts + attempts;
  if (total) log.info("admin_plane_gc", out as unknown as Record<string, unknown>);
  return out;
}
