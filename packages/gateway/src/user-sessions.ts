import type pg from "pg";
import { generateSessionToken, hashApiKey, log, newId } from "@memory/shared";
import type { App } from "./context.ts";

export type SessionSource = "ldap" | "oidc" | "local" | "test";
export type SessionEndReason = "logout" | "ended_by_person" | "end_all" | "deactivated" | "expired" | "hook_off" | "idle" | "config_changed";

export const SESSION_CLIENT_LABEL = "workspace";
export const TEST_SESSION_TTL_SEC = 3600;
const DAY_SEC = 86_400;

export interface SessionRow {
  id: string; person_id: string; source: SessionSource; created_at: Date; last_seen_at: Date; expires_at: Date;
  ended_at: Date | null; ended_reason: SessionEndReason | null;
  auth_time: Date | null;
}

export function sessionTtlSec(app: App): number {
  const days = Number(app.settings.get<number>("access.session_days", 7));
  return Math.round((Number.isFinite(days) ? Math.min(30, Math.max(1, days)) : 7) * DAY_SEC);
}

export const testSessionsOn = (app: App): boolean => app.settings.get<boolean>("access.test_sessions", false) === true;

export function sessionIdleMs(app: App): number {
  const h = Number(app.settings.get<number>("access.session_idle_hours", 72));
  return Number.isFinite(h) && h > 0 ? Math.min(h, 720) * 3_600_000 : 0;
}

export async function createSession(app: App, personId: string, source: SessionSource,
                                    o: { id?: string; ip?: string | null; userAgent?: string | null; ttlSec?: number; q?: Pick<pg.PoolClient, "query">; authTime?: Date | "now" | null } = {}):
  Promise<{ id: string; token: string; expires_at: string; source: SessionSource }> {
  const { plain, hash } = generateSessionToken(), id = o.id ?? newId();
  const ttl = Math.max(60, Math.min(o.ttlSec ?? sessionTtlSec(app), sessionTtlSec(app)));
  const { rows } = await (o.q ?? app.db.control).query(
    `INSERT INTO user_sessions (id, token_hash, person_id, instance_id, source, expires_at, ip, user_agent, auth_time)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6::int), $7::inet, $8,
             CASE WHEN $9::text = 'now' THEN now() ELSE $10::timestamptz END) RETURNING expires_at`,
    [id, hash, personId, app.instanceId, source, ttl, o.ip ?? null, o.userAgent?.slice(0, 300) ?? null,
     o.authTime === "now" ? "now" : null, o.authTime instanceof Date ? o.authTime.toISOString() : null]);
  return { id, token: plain, expires_at: new Date(rows[0].expires_at).toISOString(), source };
}

export async function findSession(app: App, token: string): Promise<SessionRow | null> {
  const { rows } = await app.db.control.query(
    `SELECT id, person_id, source, created_at, last_seen_at, expires_at, ended_at, ended_reason, auth_time
     FROM user_sessions WHERE token_hash = $1 AND instance_id = $2`, [hashApiKey(token), app.instanceId]);
  return rows[0] ?? null;
}

export function touchSession(app: App, s: SessionRow): void {
  if (Date.now() - new Date(s.last_seen_at).getTime() < 60_000) return;
  void app.db.control.query("UPDATE user_sessions SET last_seen_at = now() WHERE id = $1 AND ended_at IS NULL", [s.id]).catch(() => undefined);
}

export async function endSession(app: App, id: string, reason: SessionEndReason, personId?: string): Promise<boolean> {
  const res = await app.db.control.query(
    `UPDATE user_sessions SET ended_at = now(), ended_reason = $2
     WHERE id = $1 AND instance_id = $3 AND ended_at IS NULL AND ($4::uuid IS NULL OR person_id = $4::uuid)`, [id, reason, app.instanceId, personId ?? null]);
  return (res.rowCount ?? 0) > 0;
}

export async function endPersonSessions(app: App, personIds: string[], reason: SessionEndReason, q: Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query"> = app.db.control): Promise<number> {
  if (!personIds.length) return 0;
  const res = await q.query(
    "UPDATE user_sessions SET ended_at = now(), ended_reason = $2 WHERE person_id = ANY($1::uuid[]) AND ended_at IS NULL", [personIds, reason]);
  if (res.rowCount) log.info("user_sessions_ended", { reason, count: res.rowCount });
  return res.rowCount ?? 0;
}

export async function endSourceSessions(app: App, source: SessionSource, reason: SessionEndReason): Promise<number> {
  const res = await app.db.control.query(
    "UPDATE user_sessions SET ended_at = now(), ended_reason = $3 WHERE source = $1 AND instance_id = $2 AND ended_at IS NULL", [source, app.instanceId, reason]);
  if (res.rowCount) log.info("user_sessions_ended", { reason, source, count: res.rowCount });
  return res.rowCount ?? 0;
}

export async function listSessions(app: App, personId: string, currentId: string | null): Promise<Array<Record<string, unknown>>> {
  const { rows } = await app.db.control.query(
    `SELECT id, source, created_at, last_seen_at, expires_at, host(ip) AS ip, user_agent, (id = $2::uuid) AS current
     FROM user_sessions WHERE person_id = $1 AND instance_id = $3 AND ended_at IS NULL AND expires_at > now()
     ORDER BY created_at DESC LIMIT 100`, [personId, currentId, app.instanceId]);
  return rows.map((r) => ({ ...r, created_at: iso(r.created_at), last_seen_at: iso(r.last_seen_at), expires_at: iso(r.expires_at) }));
}

const iso = (d: Date | string | null): string | null => (d ? new Date(d).toISOString() : null);
