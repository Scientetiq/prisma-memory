// Alert mails to administrators: any service writes an alert with raiseAlert (shared/src/alerts.ts), mails
// are queued only by the worker — here. Recipients — alertRecipients (only admin.alert_recipients: a set list and
// mails switched on, a dark launch). Mail off or no recipients — no mails are queued, the alert stays in the
// panel; mailed_at and digest_at mean «mail queued» (read by «Readiness»).
//   alert_mail (every 15 s) — high alerts with no mail, at most a day old: a mail per recipient (kind alert, retry
//     key alert:<alert>:<address>), mark mailed_at. High ones older than a day (up to ALERT_CATCHUP_DAYS) that did not go
//     while mails were off — in one catch-up mail (key alert_catchup:<first alert>:<address>): turning mail off
//     in settings, acting on a high alert and turning mail on a day later is no way to hide an alert;
//   alert_digest (hourly) — at admin.alert_digest_hour, instance zone: a digest of the week's undigested medium alerts
//     (key alert_digest:<day>:<first alert of the digest>:<address>: a second pass the same day — e.g. «digest now»
//     from run-job — sends its own mail on new alerts, not quenched by the first key), mark digest_at.
// Rows are taken FOR UPDATE SKIP LOCKED: two processes never send one alert twice.
// A mail about a change of the alert channel (smtp.*, admin.alert_recipients) goes to the union of the former and new
// recipients: the former list comes from the «before» record of that change (details.recipients_before), not only
// the list at sending time. Else whoever changed the recipients would hide the mail about it. Also when the recipients
// were wiped (mail on), the change mail goes to the former ones; other high alerts wait for recipients (catch-up).
// Level page (wakes the person on duty) — also mailed at once, like high.
// Also:
//   - high «daytime only» codes (work_hours_only in contracts/edge/audit-codes.json: silent service, cert expiry) out of
//     admin.alert_work_hours wait for the window — as a single mail and in catch-up; their single-mail window is
//     WORK_HOURS_WAIT_HOURS (no weekend catch-up for them);
//   - repeat of an open alert (detector merge: count grew after the mail) — new mail at most every admin.alert_cooldown_min
//     (key alert:<alert>:<count>:<address>);
//   - digest: medium ones without a digest and open medium ones repeated after it; a reminder of unhandled high
//     security and mode alerts (securityAlertCodes: mode codes, high bridge and edge-logpump codes) and the time
//     of the host's last facts. No medium ones but some unhandled — the digest goes anyway (key
//     alert_digest:<day>:open:<address>, one a day; via «Build digest now» — on every press, the key holds the id
//     of the job: the admin checks delivery, and the answer «mails queued: N» must not lie).
// Urgent mails go before high ones (a captured edge with a stream of high ones won't delay urgent ones); a digest takes
// at most DIGEST_BATCH medium ones at a time, the rest — as a number and in the next digest; a repeat mail has the last time.
// Former recipients from the «before» record get the same cleaning as current ones (trim, lower case, MAIL_RE,
// no repeats), and an address the queue still refuses (smtp_rejected) is skipped with a log line: before, one
// such address rolled back the pass transaction every 15 seconds, and for up to 30 days no high mail left.
import { ALERT_CATCHUP_DAYS, ALERT_DIGEST_WINDOW_DAYS, ALERT_MAIL_WINDOW_HOURS, alertCatchupMail, alertDigestDay, alertDigestMail, alertMail, alertMailOff, alertRecipients, enqueueMail,
         inWorkHours, instanceTz, log, MAIL_RE, panelOrigin, securityAlertCodes, SmtpFailure, tx, workHoursCodes, workHoursOf, type AlertForMail,
         type MailMessage, type OpenSecurityLine } from "@memory/shared";
import type { DbCtx } from "../ctx.ts";

/** How many high alerts per pass. */
export const ALERT_MAIL_BATCH = 50;
/** How many high alerts a catch-up mail takes per pass (the rest — in the next mail). */
export const ALERT_CATCHUP_BATCH = 500;
/** How many medium alerts one digest takes (the rest — counted in the mail and next digest). */
export const DIGEST_BATCH = 1000;
/** Single-mail window for «daytime only» codes: a Friday evening alert goes out on Monday as a mail, not in catch-up. */
export const WORK_HOURS_WAIT_HOURS = 96;
/** Pause between repeat mails of one alert, minutes: default and bounds of admin.alert_cooldown_min. */
export const ALERT_COOLDOWN_DEFAULT_MIN = 30;

/** Repeat pause from settings (5–1440 min). */
export function alertCooldownMin(ctx: DbCtx): number {
  const v = Number(ctx.settings.get<unknown>("admin.alert_cooldown_min", ALERT_COOLDOWN_DEFAULT_MIN));
  return Number.isFinite(v) ? Math.min(1440, Math.max(5, Math.trunc(v))) : ALERT_COOLDOWN_DEFAULT_MIN;
}

/** «Daytime only» codes and those waiting now (outside work hours). */
export function workHoursState(ctx: DbCtx, now = new Date()): { codes: string[]; waiting: string[] } {
  const codes = workHoursCodes();
  return { codes, waiting: inWorkHours(workHoursOf(ctx.settings), now) ? [] : codes };
}

export interface AlertMailResult { alerts: number; letters: number; repeats?: number; catchup?: number; open?: number; skipped?: string }

/** Why alert mails are not queued now, or who gets them. */
function mailBlocked(ctx: DbCtx): { skipped: string } | { to: string[] } {
  const off = alertMailOff(ctx.settings);
  return off ? { skipped: off } : { to: alertRecipients(ctx.settings) };
}

/**
 * For high ones: mail off — not queued; no recipients — only alerts with former recipients
 * (details.recipients_before: a channel change), the rest wait.
 */
function highBlocked(ctx: DbCtx): { skipped: string } | { to: string[]; onlyBefore: string | null } {
  const b = mailBlocked(ctx);
  if (!("skipped" in b)) return { to: b.to, onlyBefore: null };
  return ctx.settings.get<unknown>("smtp.enabled", false) === true ? { to: [], onlyBefore: b.skipped } : b;
}

/** Filter: only alerts with a non-empty list of former recipients. */
const WITH_BEFORE = "jsonb_typeof(details->'recipients_before') = 'array' AND jsonb_array_length(details->'recipients_before') > 0";

/** Wake the mail queue (do not wait for its 15-second pass); failed — the mails go with the pass. */
async function wakeMail(ctx: DbCtx): Promise<void> {
  const boss = (ctx as Partial<{ boss: { send(q: string, d: object, o: object): Promise<unknown> } }>).boss;
  await boss?.send("mail", {}, { singletonKey: "mail", retryLimit: 1 }).catch(() => undefined);
}

/**
 * Recipients of alert mail: current and former (the «before» record, details.recipients_before), no repeats. Former —
 * as alertRecipients: trim, lowercase, only addresses by MAIL_RE (the queue accepts them), at most 254.
 */
export function recipientsFor(now: readonly string[], before: unknown): string[] {
  const clean = (x: unknown): string | null => {
    if (typeof x !== "string") return null;
    const k = x.trim().toLowerCase();
    return k.length <= 254 && MAIL_RE.test(k) ? k : null;
  };
  const old = Array.isArray(before) ? before : [];
  return [...new Set([...now, ...old].map(clean).filter((x): x is string => x !== null))];
}

/**
 * Queue an alert mail to one address. An address the queue won't accept (smtp_rejected) — to the log and on: one
 * bad address neither rolls back the pass nor delays mails to the others. Other errors — as before.
 */
export async function enqueueAlert(q: Parameters<typeof enqueueMail>[0], instanceId: string, m: MailMessage & { dedupeKey: string }): Promise<boolean> {
  try {
    return (await enqueueMail(q, instanceId, { ...m, kind: "alert" })).created;
  } catch (e) {
    if (!(e instanceof SmtpFailure) || e.code !== "smtp_rejected") throw e;
    log.warn("alert_mail_bad_recipient", { code: e.code });
    return false;
  }
}

const MAIL_COLS = "id::text AS id, at, level, code, summary, count, first_at, last_at, subject, details->'recipients_before' AS recipients_before";
type MailRow = AlertForMail & { recipients_before?: unknown };

/** Pass alert_mail: high alerts with no mail, repeats after the pause, catch-up. now — for tests (work hours). */
export async function alertMailPass(ctx: DbCtx, o: { now?: Date } = {}): Promise<AlertMailResult> {
  const b = highBlocked(ctx);
  if ("skipped" in b) return { alerts: 0, letters: 0, skipped: b.skipped };
  const only = b.onlyBefore !== null ? ` AND ${WITH_BEFORE}` : "";
  const origin = panelOrigin(ctx.settings), tz = instanceTz(ctx.settings);
  const wh = workHoursState(ctx, o.now);
  const cooldown = alertCooldownMin(ctx);
  const out = await tx(ctx.db.control, async (q) => {
    // $2 — day window, $3 — «daytime only» codes (WORK_HOURS_WAIT_HOURS), $4 — codes now waiting
    const rows = (await q.query(
      `SELECT ${MAIL_COLS} FROM admin_alerts
        WHERE instance_id = $1 AND level IN ('high', 'page') AND mailed_at IS NULL
          AND (last_at > now() - make_interval(hours => $2) OR (code = ANY($3::text[]) AND last_at > now() - make_interval(hours => $5)))
          AND NOT (code = ANY($4::text[]))${only}
        ORDER BY (level = 'page') DESC, at LIMIT $6 FOR UPDATE SKIP LOCKED`,
      [ctx.instanceId, ALERT_MAIL_WINDOW_HOURS, wh.codes, wh.waiting, WORK_HOURS_WAIT_HOURS, ALERT_MAIL_BATCH])).rows as MailRow[];
    let letters = 0;
    for (const row of rows) {
      const { recipients_before: before, ...a } = row;
      const m = alertMail(a, { instance: ctx.instanceId, tz, panelOrigin: origin });
      for (const to of recipientsFor(b.to, before))
        if (await enqueueAlert(q, ctx.instanceId, { to, subject: m.subject, text: m.text, dedupeKey: `alert:${a.id}:${to}` })) letters++;
    }
    if (rows.length) await q.query("UPDATE admin_alerts SET mailed_at = now() WHERE id = ANY($1::uuid[])", [rows.map((r) => r.id)]);
    // open alert repeated after its mail: not within the pause, key by repeat count
    const again = (await q.query(
      `SELECT ${MAIL_COLS} FROM admin_alerts
        WHERE instance_id = $1 AND level IN ('high', 'page') AND status = 'open' AND mailed_at IS NOT NULL AND count > 1
          AND last_at > mailed_at AND mailed_at < now() - make_interval(mins => $2)
          AND last_at > now() - make_interval(hours => $3) AND NOT (code = ANY($4::text[]))${only}
        ORDER BY (level = 'page') DESC, last_at LIMIT $5 FOR UPDATE SKIP LOCKED`,
      [ctx.instanceId, cooldown, ALERT_MAIL_WINDOW_HOURS, wh.waiting, ALERT_MAIL_BATCH])).rows as MailRow[];
    for (const row of again) {
      const { recipients_before: before, ...a } = row;
      const m = alertMail(a, { instance: ctx.instanceId, tz, panelOrigin: origin });
      for (const to of recipientsFor(b.to, before))
        if (await enqueueAlert(q, ctx.instanceId, { to, subject: m.subject, text: m.text, dedupeKey: `alert:${a.id}:${a.count}:${to}` })) letters++;
    }
    if (again.length) await q.query("UPDATE admin_alerts SET mailed_at = now() WHERE id = ANY($1::uuid[])", [again.map((r) => r.id)]);
    // catch-up: high ones over a day old unsent while mails were off — in one mail («daytime only» codes in their
    // window await a single mail)
    const oldRows = (await q.query(
      `SELECT ${MAIL_COLS} FROM admin_alerts
        WHERE instance_id = $1 AND level IN ('high', 'page') AND mailed_at IS NULL
          AND last_at <= now() - make_interval(hours => $2) AND at > now() - make_interval(days => $3)
          AND NOT (code = ANY($4::text[]) AND last_at > now() - make_interval(hours => $6)) AND NOT (code = ANY($5::text[]))${only}
        ORDER BY at LIMIT $7 FOR UPDATE SKIP LOCKED`,
      [ctx.instanceId, ALERT_MAIL_WINDOW_HOURS, ALERT_CATCHUP_DAYS, wh.codes, wh.waiting, WORK_HOURS_WAIT_HOURS, ALERT_CATCHUP_BATCH])).rows as MailRow[];
    const old: AlertForMail[] = oldRows.map(({ recipients_before: _b, ...a }) => a);
    if (old.length) {
      const m = alertCatchupMail(old, { instance: ctx.instanceId, tz, panelOrigin: origin });
      for (const to of recipientsFor(b.to, oldRows.flatMap((r) => (Array.isArray(r.recipients_before) ? r.recipients_before : []))))
        if (await enqueueAlert(q, ctx.instanceId, { to, subject: m.subject, text: m.text, dedupeKey: `alert_catchup:${old[0]!.id}:${to}` })) letters++;
      await q.query("UPDATE admin_alerts SET mailed_at = now() WHERE id = ANY($1::uuid[])", [old.map((r) => r.id)]);
    }
    // no recipients: usual mails are not queued (skipped), only channel-change mails to former recipients went
    return { alerts: rows.length, letters, ...(again.length ? { repeats: again.length } : {}), ...(old.length ? { catchup: old.length } : {}),
             ...(b.onlyBefore !== null ? { skipped: b.onlyBefore } : {}) };
  });
  if (out.letters) { log.info("alert_mail_queued", out as unknown as Record<string, unknown>); await wakeMail(ctx); }
  return out;
}

/** Hour and day in zone tz now. */
export function zonedHourDay(tz: string, now = new Date()): { hour: number; day: string } {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit" }).formatToParts(now);
  const g = (k: string) => p.find((x) => x.type === k)!.value;
  return { hour: Number(g("hour")), day: `${g("year")}-${g("month")}-${g("day")}` };
}

/** Time of the host's last facts (state of the alert detectors); no table or row — null. */
async function hostFactsAt(ctx: DbCtx): Promise<string | null> {
  const r = await ctx.db.control.query("SELECT detectors->>'host_facts_at' AS at FROM alert_feed_cursor WHERE instance_id = $1", [ctx.instanceId])
    .catch((e: unknown) => {
      if ((e as { code?: string }).code === "42P01" || (e as { code?: string }).code === "42703") return { rows: [] };
      throw e;
    });
  const at = (r.rows[0] as { at?: string | null } | undefined)?.at;
  return typeof at === "string" && at ? at : null;
}

/**
 * Pass alert_digest: at admin.alert_digest_hour — a digest of medium alerts and a reminder of unhandled security
 * alerts. force — with no hour check (run-job, «Build digest now», tests); runKey — the job id of the button «Build
 * digest now»: a reminder without medium ones goes on every press (key with runKey), not once a day.
 */
export async function alertDigestPass(ctx: DbCtx, o: { force?: boolean; now?: Date; runKey?: string } = {}): Promise<AlertMailResult> {
  const tz = instanceTz(ctx.settings);
  const { hour, day } = zonedHourDay(tz, o.now);
  const want = Number(ctx.settings.get<number>("admin.alert_digest_hour", 9));
  if (!o.force && hour !== want) return { alerts: 0, letters: 0, skipped: "outside the digest hour" };
  const b = mailBlocked(ctx);
  if ("skipped" in b) return { alerts: 0, letters: 0, skipped: b.skipped };
  const origin = panelOrigin(ctx.settings);
  const factsAt = await hostFactsAt(ctx);
  const out = await tx(ctx.db.control, async (q) => {
    // medium ones without a digest and open medium ones repeated after their digest
    const rows = (await q.query(
      `SELECT id::text AS id, at, level, code, summary, count, first_at, subject, digest_at FROM admin_alerts
        WHERE instance_id = $1 AND level = 'medium' AND last_at > now() - make_interval(days => $2)
          AND (digest_at IS NULL OR (status = 'open' AND last_at > digest_at))
        ORDER BY at LIMIT $3 FOR UPDATE SKIP LOCKED`, [ctx.instanceId, ALERT_DIGEST_WINDOW_DAYS, DIGEST_BATCH])).rows as Array<AlertForMail & { digest_at: Date | null }>;
    // left beyond the batch (a captured edge with thousands of medium ones): counted in the mail
    const more = rows.length < DIGEST_BATCH ? 0 : Number((await q.query(
      `SELECT count(*)::int AS n FROM admin_alerts
        WHERE instance_id = $1 AND level = 'medium' AND last_at > now() - make_interval(days => $2)
          AND (digest_at IS NULL OR (status = 'open' AND last_at > digest_at)) AND NOT (id = ANY($3::uuid[]))`,
      [ctx.instanceId, ALERT_DIGEST_WINDOW_DAYS, rows.map((r) => r.id)])).rows[0]?.n ?? 0);
    const open = (await q.query(
      `SELECT code, level, count(*)::int AS alerts, sum(count)::int AS repeats, max(last_at) AS last_at FROM admin_alerts
        WHERE instance_id = $1 AND level IN ('high', 'page') AND status = 'open' AND acked_at IS NULL AND code = ANY($2::text[])
          AND last_at > now() - make_interval(days => $3)
        GROUP BY code, level ORDER BY max(last_at) DESC LIMIT 100`,
      [ctx.instanceId, securityAlertCodes(), ALERT_CATCHUP_DAYS])).rows as OpenSecurityLine[];
    if (!rows.length && !open.length) return { alerts: 0, letters: 0 };
    const mail = alertDigestMail(rows, { instance: ctx.instanceId, day: alertDigestDay(day), tz, panelOrigin: origin, openSecurity: open, hostFactsAt: factsAt, more });
    // key per digest, not per day: a second pass that day sends its own (new) alerts, not quenched by the first key;
    // ones already digested repeat with their count; a reminder alone — once a day
    const again = rows.some((r) => r.digest_at !== null);
    const sum = rows.reduce((s, r) => s + Math.max(1, Number(r.count ?? 1)), 0);
    const key = !rows.length ? `alert_digest:${day}:open${o.runKey ? `:now:${o.runKey.slice(0, 64)}` : ""}` : `alert_digest:${day}:${rows[0]!.id}${again ? `:r${sum}` : ""}`;
    let letters = 0;
    for (const to of b.to)
      if (await enqueueAlert(q, ctx.instanceId, { to, subject: mail.subject, text: mail.text, dedupeKey: `${key}:${to}` })) letters++;
    if (rows.length) await q.query("UPDATE admin_alerts SET digest_at = now() WHERE id = ANY($1::uuid[])", [rows.map((r) => r.id)]);
    return { alerts: rows.length, letters, ...(open.length ? { open: open.reduce((s, x) => s + x.alerts, 0) } : {}) };
  });
  if (out.letters) { log.info("alert_digest_queued", out); await wakeMail(ctx); }
  return out;
}
