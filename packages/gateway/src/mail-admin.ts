import type { Context, Hono } from "hono";
import { CUSTODY_MAIL_STALE, CUSTODY_MAIL_STALE_TEXT, custodyMailForget, custodyMailRecipient, custodyPolicy, enqueueMail, invalid, isUuid, journalSubject, log, MAIL_KINDS, MAIL_RE,
         MEETING_MAIL_NOT_PARTICIPANT, MEETING_MAIL_NOT_PARTICIPANT_TEXT, meetingMailRecipientOk, notFound, releaseMailHold, sendMail, smtpConfig, SmtpFailure, smtpFailure, testMail,
         type MailKind, type MailStatus } from "@memory/shared";
import { HUMAN_SESSION_REQUIRED_TEXT, isHumanSession, isTestDomainLogin, MemoryError, tx, type HumanSessionCaller } from "@memory/shared";
import { edgePrepared, externalContourLock } from "./admin-plane/edge-prepared.ts";
import { humanSessionsHere } from "./admin-plane/human-only.ts";
import type { App } from "./context.ts";
import { intParam, offsetCursor } from "./paging.ts";
import { operatorOf } from "./operator.ts";

type AdminAudit = (c: Context<any>, op: string, details?: Record<string, unknown>) => Promise<void>;

export const SMTP_TEST_RECIPIENT = "smtp_test_recipient";
export const SMTP_TEST_RECIPIENT_TEXT = "Test e-mails can only go to your e-mail address, the memory administrator’s address (smtp.admin_email) or alert recipients (admin.alert_recipients)";

export async function smtpTestRecipientOk(app: App, c: Context<any>, to: string): Promise<boolean> {
  if (isTestDomainLogin(to)) return true;
  const own = (await operatorOf(app, c)).person?.login?.toLowerCase();
  if (own && own === to) return true;
  const adminEmail = String(app.settings.str("smtp.admin_email") ?? "").trim().toLowerCase();
  if (adminEmail && adminEmail === to) return true;
  const list = app.settings.get<unknown>("admin.alert_recipients", []);
  return Array.isArray(list) && list.some((x) => typeof x === "string" && x.trim().toLowerCase() === to);
}
const STATUSES: MailStatus[] = ["pending", "sending", "sent", "failed", "cancelled"];

export function registerMailAdmin(r: Hono<any>, app: App, adminAudit: AdminAudit): void {
  const ctl = app.db.control;

  r.post("/smtp/test", async (c) => {
    const b = await c.req.json().catch(() => ({})) as { to?: unknown; via?: unknown };
    const to = typeof b.to === "string" ? b.to.trim().toLowerCase() : "";
    if (!MAIL_RE.test(to)) throw invalid("Enter the e-mail address for the test message (to)");
    if (!(await smtpTestRecipientOk(app, c, to)))
      throw new MemoryError("invalid_argument", SMTP_TEST_RECIPIENT_TEXT, { reason: SMTP_TEST_RECIPIENT });
    const via = b.via === "queue" ? "queue" : "direct";
    await app.settings.load(true);
    const cfg = smtpConfig(app.settings);
    const by = c.get("caller").clientLabel ?? "admin";
    const mail = testMail(to, app.settings.str("access.workplace_url") ?? "", by);
    if (via === "queue") {
      const q = await enqueueMail(ctl, app.instanceId, { ...mail, kind: "test", createdBy: by });
      const woke = await app.queue.wake("mail");
      await adminAudit(c, "smtp_test", { via, to, mail_id: q.id, enabled: cfg.enabled });
      return c.json({ queued: true, id: q.id, enabled: cfg.enabled, woke,
                      note: cfg.enabled ? "e-mail queued: check the status in the “Mail” log" : "sending is disabled (smtp.enabled = false). The e-mail will stay queued until sending is enabled" }, 202);
    }
    const started = Date.now();
    try {
      const sent = await sendMail(cfg, mail);
      // the current settings work again (the server was fixed on its side) — the transport hold ends, held letters go
      const released = await releaseMailHold(ctl, app.instanceId).catch((e: unknown) => {
        log.warn("mail_hold_release_failed", { error: ((e as Error)?.message ?? "").slice(0, 160) });
        return 0;
      });
      if (released) { log.info("mail_hold_released", { letters: released }); await app.queue.wake("mail"); }
      await adminAudit(c, "smtp_test", { via, to, ok: true, host: cfg.host, port: cfg.port, security: cfg.security, latency_ms: Date.now() - started });
      return c.json({ ok: true, to, host: cfg.host, port: cfg.port, security: cfg.security, message_id: sent.messageId, latency_ms: Date.now() - started });
    } catch (e) {
      const f = e instanceof SmtpFailure ? e : smtpFailure(e, cfg);
      await adminAudit(c, "smtp_test", { via, to, ok: false, host: cfg.host, port: cfg.port, security: cfg.security, code: f.code, latency_ms: Date.now() - started });
      return c.json({ ok: false, to, host: cfg.host, port: cfg.port, security: cfg.security, code: f.code, message: f.message, detail: f.detail.slice(0, 300), latency_ms: Date.now() - started });
    }
  });

  r.get("/mail", async (c) => {
    const limit = intParam(c.req.query("limit"), 50, 1, 200), offset = offsetCursor(c.req.query("cursor"));
    const status = c.req.query("status"), kind = c.req.query("kind");
    if (status && !STATUSES.includes(status as MailStatus)) throw invalid(`status must be one of ${STATUSES.join(", ")}`);
    if (kind && !MAIL_KINDS.includes(kind as MailKind)) throw invalid(`kind must be one of ${MAIL_KINDS.join(", ")}`);
    const { rows } = await ctl.query(
      `SELECT id, kind, to_address, subject, status, attempts, next_attempt_at, last_error_code, last_error, created_by, created_at, updated_at, sent_at
         FROM mail_outbox WHERE instance_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::text IS NULL OR kind = $3)
        ORDER BY created_at DESC, id DESC LIMIT $4 OFFSET $5`, [app.instanceId, status ?? null, kind ?? null, limit + 1, offset]);
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<MailStatus, number>;
    for (const row of (await ctl.query("SELECT status, count(*)::int AS n FROM mail_outbox WHERE instance_id = $1 GROUP BY status", [app.instanceId])).rows) counts[row.status as MailStatus] = row.n;
    const cfg = smtpConfig(app.settings);
    const lastSent = (await ctl.query("SELECT max(sent_at) AS at FROM mail_outbox WHERE instance_id = $1 AND status = 'sent'", [app.instanceId])).rows[0]?.at ?? null;
    const items = rows.slice(0, limit).map((r) => ({ ...r, subject: journalSubject(r.kind, r.subject) }));
    return c.json({ items, next_cursor: rows.length > limit ? String(offset + limit) : null, counts,
                    enabled: cfg.enabled, max_attempts: cfg.max_attempts, keep_days: cfg.keep_days, last_sent_at: lastSent ? new Date(lastSent).toISOString() : null });
  });

  r.post("/mail/:id/retry", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) throw invalid("The e-mail id must be a UUID");
    const row = (await ctl.query("SELECT kind, status, dedupe_key, to_address FROM mail_outbox WHERE id = $1 AND instance_id = $2", [id, app.instanceId])).rows[0];
    let to: string | null = null;
    const stale = row && (row.status === "failed" || row.status === "cancelled")
      ? row.kind === "meeting_new"
        ? !(await meetingMailRecipientOk({ control: ctl, records: (cls) => app.db.records(cls, { classes: ["open", "closed"], tier: "system" }) }, app.instanceId, row.dedupe_key))
          && { code: MEETING_MAIL_NOT_PARTICIPANT, text: MEETING_MAIL_NOT_PARTICIPANT_TEXT }
        : row.kind === "custody"
          ? (to = await custodyMailRecipient(ctl, app.instanceId, row.dedupe_key, custodyPolicy(app.settings))) === null && { code: CUSTODY_MAIL_STALE, text: CUSTODY_MAIL_STALE_TEXT }
          : false
      : false;
    if (stale) {
      await ctl.query(
        `UPDATE mail_outbox SET status = 'cancelled', last_error_code = $3, last_error = $4, updated_at = now()
          WHERE id = $1 AND instance_id = $2 AND status IN ('failed','cancelled')`, [id, app.instanceId, stale.code, stale.text]);
      if (row.kind === "custody") await custodyMailForget(ctl, app.instanceId, row.dedupe_key);
      throw invalid(stale.text);
    }
    const res = await ctl.query(
      `UPDATE mail_outbox SET status = 'pending', attempts = 0, next_attempt_at = now(), updated_at = now(), to_address = COALESCE($3, to_address)
        WHERE id = $1 AND instance_id = $2 AND status IN ('failed','cancelled') RETURNING id, kind`, [id, app.instanceId, to]);
    if (!res.rowCount) {
      const cur = (await ctl.query("SELECT status FROM mail_outbox WHERE id = $1 AND instance_id = $2", [id, app.instanceId])).rows[0];
      if (!cur) throw notFound();
      throw invalid(`You can only retry e-mail marked “Failed” or “Canceled”. This e-mail’s status is ${cur.status}`);
    }
    await app.queue.wake("mail");
    await adminAudit(c, "mail_retry", { mail_id: id, kind: res.rows[0].kind, ...(to && to !== row?.to_address ? { readdressed: true } : {}) });
    return c.json({ id, status: "pending" });
  });

  r.post("/mail/:id/cancel", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) throw invalid("The e-mail id must be a UUID");
    const admin = (c.get("caller") as { admin?: HumanSessionCaller } | undefined)?.admin ?? null;
    const out = await tx(ctl, async (q) => {
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [externalContourLock(app)]);
      const prepared = await edgePrepared(q, app.instanceId, { inTx: true });
      const row = (await q.query("SELECT kind, status FROM mail_outbox WHERE id = $1 AND instance_id = $2 FOR UPDATE", [id, app.instanceId])).rows[0] as
        { kind: string; status: string } | undefined;
      if (!row) return { refuse: "not_found" as const };
      if (row.kind === "alert" && prepared && humanSessionsHere() && !isHumanSession(admin)) return { refuse: "human" as const };
      if (row.status !== "pending") return { refuse: "state" as const, status: row.status };
      await q.query("UPDATE mail_outbox SET status = 'cancelled', updated_at = now() WHERE id = $1 AND instance_id = $2", [id, app.instanceId]);
      return { kind: row.kind };
    });
    if ("refuse" in out) {
      if (out.refuse === "not_found") throw notFound();
      if (out.refuse === "human") return c.json({ code: "human_session_required", message: HUMAN_SESSION_REQUIRED_TEXT }, 403);
      throw invalid(`You can only cancel queued e-mail. This e-mail’s status is ${out.status}`);
    }
    await adminAudit(c, "mail_cancel", { mail_id: id, kind: out.kind });
    return c.json({ id, status: "cancelled" });
  });
}

export async function mailHealth(app: App): Promise<{ ok: boolean; detail: string }> {
  const cfg = smtpConfig(app.settings);
  const q = (await app.db.control.query(
    `SELECT count(*) FILTER (WHERE status IN ('pending','sending'))::int AS waiting,
            count(*) FILTER (WHERE status IN ('pending','sending') AND created_at < now() - interval '1 hour')::int AS stuck,
            count(*) FILTER (WHERE status = 'failed' AND updated_at > now() - interval '1 day')::int AS failed_day
       FROM mail_outbox WHERE instance_id = $1`, [app.instanceId])).rows[0] as { waiting: number; stuck: number; failed_day: number };
  if (!cfg.enabled) return { ok: true, detail: `e-mail sending is disabled (smtp.enabled = false)${q.waiting ? `; waiting for sending to be enabled: ${q.waiting}` : ""}` };
  const tail = q.failed_day ? `; failed in the last day: ${q.failed_day} (“Mail” log)` : "";
  if (q.stuck) return { ok: false, detail: `e-mails have been waiting for over an hour: ${q.stuck}. Check “Mail (SMTP)” and the worker${tail}` };
  return { ok: true, detail: `e-mail: ${cfg.host}:${cfg.port}${q.waiting ? `, queued: ${q.waiting}` : ""}${tail}` };
}
