import { instanceLocale } from "@memory/i18n/context";
import { alertCodeInfo, type AlertCodeInfo } from "./alert-codes.ts";
import { newId } from "./ids.ts";
import { log } from "./log.ts";
import { MAIL_CATCHUP_LINES, mailAlertsWhere, mailDay, mailTime, renderMail } from "./mail-render.ts";
import { MAIL_RE } from "./smtp.ts";
import { fallbackTz } from "./zoned-time.ts";
import type { AlertLevel } from "./admin-plane-types.ts";

interface Queryable { query: (sql: string, args?: unknown[]) => Promise<{ rowCount: number | null }> }

/**
 * A pool (each statement in its own autocommit transaction), never a checked-out client: raiseAlert swallows a failed
 * write, and on a client inside the caller's transaction that would leave the transaction aborted — the caller's COMMIT then
 * silently becomes ROLLBACK. An alert about an attempt (a sign-in, a refusal) must also survive the rollback of the attempt's
 * own transaction, so it is raised after the outcome is known, on the pool. The type refuses a pg.PoolClient (it has release).
 */
type AlertQueryable = Queryable & { release?: never };

export interface AlertDb { control: AlertQueryable; audit?: AlertQueryable }

/**
 * One best-effort write of raiseAlert. A caller that bypassed the type and handed a checked-out client gets the write inside a
 * savepoint, so its failure is undone to the savepoint and the caller's transaction stays usable; outside a transaction the
 * SAVEPOINT itself is refused (25P01) and the write runs plainly — an error there aborts nothing.
 */
async function bestEffortWrite<R>(q: Queryable, write: () => Promise<R>): Promise<R> {
  if (typeof (q as { release?: unknown }).release !== "function") return write();
  let savepoint = false;
  try { await q.query("SAVEPOINT memory_alert_write"); savepoint = true; } catch { /* not in a transaction block */ }
  if (!savepoint) return write();
  try {
    const r = await write();
    await q.query("RELEASE SAVEPOINT memory_alert_write");
    return r;
  } catch (e) {
    await q.query("ROLLBACK TO SAVEPOINT memory_alert_write");
    throw e;
  }
}

export interface AlertInput {
  instanceId: string;
  level: AlertLevel;
  code: string;
  summary: string;
  details?: Record<string, unknown>;
  dedupeKey?: string | null;
}

export async function raiseAlert(db: AlertDb, a: AlertInput): Promise<{ id: string; inserted: boolean }> {
  const id = newId();
  const summary = a.summary.slice(0, 300);
  const details = a.details ?? {};
  let inserted = false;
  try {
    const r = await bestEffortWrite(db.control, () => db.control.query(
      `INSERT INTO admin_alerts (id, instance_id, level, code, summary, details, dedupe_key)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) ON CONFLICT DO NOTHING`,
      [id, a.instanceId, a.level, a.code, summary, JSON.stringify(details), a.dedupeKey ?? null]));
    inserted = (r.rowCount ?? 0) > 0;
  } catch (e) {
    log.error("admin_alert_write_failed", { code: a.code, alert_level: a.level, error: ((e as Error)?.message ?? String(e)).slice(0, 300) });
    return { id, inserted: false };
  }
  if (inserted && db.audit) {
    const audit = db.audit;
    await bestEffortWrite(audit, () => audit.query(
      `INSERT INTO audit_events (id, instance_id, event_type, principal_type, details) VALUES ($1, $2, 'admin', 'system', $3::jsonb)`,
      [newId(), a.instanceId, JSON.stringify({ op: "alert", code: a.code, level: a.level, alert: id })],
    )).catch((e: unknown) => log.error("audit_write_failed", { event_type: "admin", op: "alert", error: ((e as Error)?.message ?? String(e)).slice(0, 300) }));
  }
  if (inserted) log.warn("admin_alert", { code: a.code, alert_level: a.level, alert: id });
  return { id, inserted };
}

export const ALERT_MAIL_EVERY_MS = 15_000;
export const ALERT_MAIL_WINDOW_HOURS = 24;
export const ALERT_CATCHUP_DAYS = 30;
export const ALERT_CATCHUP_LINES = MAIL_CATCHUP_LINES;
export const ALERT_DIGEST_WINDOW_DAYS = 7;
export const ALERT_RECIPIENTS_MAX = 10;

interface SettingsGet { get<T>(path: string, fallback: T): T }

export function alertRecipients(s: SettingsGet): string[] {
  const raw = s.get<unknown>("admin.alert_recipients", []);
  const list = (Array.isArray(raw) ? raw : []).filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase()).filter((x) => MAIL_RE.test(x));
  return [...new Set(list)].slice(0, ALERT_RECIPIENTS_MAX);
}

export function alertMailOff(s: SettingsGet): string | null {
  const smtpOn = s.get<unknown>("smtp.enabled", false) === true;
  const noRecipients = alertRecipients(s).length === 0;
  if (!smtpOn && noRecipients) return "e-mail is disabled (smtp.enabled) and no recipients are set (admin.alert_recipients)";
  if (!smtpOn) return "mail is disabled (smtp.enabled)";
  return noRecipients ? "no recipients set (admin.alert_recipients)" : null;
}

export { alertCodeInfo, type AlertCodeInfo };

export interface AlertForMail {
  id: string; at: Date | string; level: string; code: string; summary: string;
  count?: number | null; first_at?: Date | string | null; last_at?: Date | string | null; subject?: string | null;
}

export interface AlertMailText { subject: string; text: string }

/**
 * The time of an alert in a mail, in the instance language: local time of the zone tz (the instance zone falls back to
 * UTC) with the zone named.
 */
export function alertTime(at: Date | string, tz: string = fallbackTz()): string {
  return mailTime(instanceLocale(), at, tz);
}

/** The day of the alert digest (YYYY-MM-DD) as the digest mail shows it, in the instance language. */
export function alertDigestDay(isoDay: string): string {
  return mailDay(instanceLocale(), isoDay);
}

/** Where to look at the alerts: the link to the panel's page when its origin is known (the first admin.webauthn_origins), else words. */
export function alertsWhere(panelOrigin: string | null): string {
  return mailAlertsWhere(instanceLocale(), panelOrigin);
}

export function panelOrigin(s: SettingsGet): string | null {
  const v = s.get<unknown>("admin.webauthn_origins", []);
  const first = Array.isArray(v) ? v.find((x): x is string => typeof x === "string" && /^https?:\/\/[^\s/?#]+$/.test(x)) : undefined;
  return first ?? null;
}

/** Mail about a high (or urgent) alert: what happened, when, what to do, where to look. No details. Template alert.single. */
export function alertMail(a: AlertForMail, o: { instance: string; tz?: string; panelOrigin?: string | null }): AlertMailText {
  return renderMail("alert.single", instanceLocale(), { alert: a, ...o });
}

/**
 * The catch-up mail: high alerts that were not mailed while alert mail was off (mail switched off or no recipients).
 * The first ALERT_CATCHUP_LINES as lines (oldest first), the rest as a number. No details. Template alert.catchup.
 */
export function alertCatchupMail(rows: AlertForMail[], o: { instance: string; tz?: string; panelOrigin?: string | null }): AlertMailText {
  return renderMail("alert.catchup", instanceLocale(), { rows, ...o });
}

/** An open security alert for the digest: code, level, how many rows and repeats, the last time. */
export interface OpenSecurityLine { code: string; level: string; alerts: number; repeats: number; last_at: Date | string }

/**
 * The daily digest (template alert.digest): medium alerts by code (how many, counting merged repeats, and the latest),
 * then the latest rows (up to 30), then a reminder of the open (not acknowledged) security and security-mode alerts — the
 * mail about them has already gone, the digest reminds that they are not dealt with. Host facts — only the time of the
 * last event: account names of the host never go into a mail. day — as alertDigestDay gives it.
 */
export function alertDigestMail(rows: AlertForMail[], o: { instance: string; day: string; tz?: string; panelOrigin?: string | null;
                                                         openSecurity?: OpenSecurityLine[]; hostFactsAt?: Date | string | null;
                                                         more?: number }): AlertMailText {
  return renderMail("alert.digest", instanceLocale(), { rows, ...o });
}
