// Mail queue: letters from mail_outbox go out over SMTP with retries. Settings —
// the panel section «Mail (SMTP)» (smtp.*); sending a letter and mapping errors — @memory/shared (smtp.ts).
//
// One pass: return stuck sends (a worker restart in the middle of a letter), take due letters (FOR UPDATE SKIP
// LOCKED: two passes never send one letter), send one by one; transient failure — retry after a pause, hard refusal
// or the last attempt — failed with a clear reason. Sent and dropped rows older than smtp.keep_days are deleted.
// A meeting letter (meeting_new) checks its recipient before sending: the person was removed from the meeting,
// the meeting was deleted or the person disabled — cancelled with a reason, not sent once mail works again.
// The same for a custody letter: the employee works again, the custodian changed, reading is off —
// «cancelled», reason custody_not_current (custodyMailRecipient), and the custodian row stops counting the recipient notified.
// A custody letter goes to the recipient's current address by their id from the key; if it changed while the letter
// waited, the row's to_address is rewritten and the letter goes there.
// One pass per instance: a session lock mail:<instance> for the whole pass — else a manual run
// (run-job mail) with a slow mail server returned as «stuck» letters the first pass was still sending (the return
// threshold is set for one letter, and a batch of 20 gets one claim time), and some notices went out twice.
// The final UPDATEs are fenced by status and attempt number: a letter returned and taken again meanwhile is not
// rewritten and not counted.
// A sent letter is marked with a transport fingerprint: an HMAC of the server, port, encryption,
// account and sender fields (smtpTransportDigest) — from this pass's settings, which the letter really used. The gate
// of an alert letter compares it with the current transport: a letter via the former relay, finished after the new one
// was saved, proves nothing of the new transport. No app secret (manual run) — fingerprint NULL: the gate skips it.
// Transport hold: encryption that could not be set up or a refused login (SMTP_HOLD_CODES) is a
// fault of the settings or of the server, not of the letter. The first one in a pass puts that letter and the rest of the
// batch back to pending without counting the attempt, with the reason and the transport fingerprint, and stops the pass;
// while the pause of the current transport runs, no pass sends anything (one login per pause, not one per letter). New
// mail settings (another fingerprint) make held letters due at once; a successful test letter ends the pause
// (releaseMailHold, gateway). A high alert mail_transport_held tells the administrator what broke and what to do.
import { CUSTODY_MAIL_STALE, CUSTODY_MAIL_STALE_TEXT, custodyMailForget, custodyMailRecipient, custodyPolicy, holdPauseSec, LockConnectionLost, log, MEETING_MAIL_NOT_PARTICIPANT, MEETING_MAIL_NOT_PARTICIPANT_TEXT, meetingMailRecipientOk,
         raiseAlert, retryDelaySec, sendMail, SMTP_HOLD_CODES, smtpConfig, smtpFailure, smtpProblems, smtpTransportDigest, smtpTransportHold, tx, watchLock, type SmtpFailure } from "@memory/shared";
import { recordsDb, type DbCtx } from "../ctx.ts";

/** Mail pass context: the app secret is for the transport fingerprint; none — no fingerprint is written. */
export type MailCtx = DbCtx & { appSecret?: string };

const BATCH = 20;

export interface MailTick { reclaimed: number; sent: number; retried: number; failed: number; purged: number; cancelled?: number; held?: number; skipped?: string }

/** Returned if the pass lock is held: another process (worker or run-job) is sending already. */
export const MAIL_BUSY = "another delivery pass is in progress";
/** What a pass returns while the current transport is on hold. */
export const MAIL_HELD = "mail transport on hold after refused encryption or login";
/** Alert code of a transport hold (contracts/edge/audit-codes.json). */
export const MAIL_HOLD_ALERT = "mail_transport_held";

export async function mailTick(ctx: MailCtx): Promise<MailTick> {
  // The periodic pass and wake both read settings after the previous pass ends: a stale cache will not send
  // a new letter to the old server nor bypass a just disabled sending.
  await ctx.settings.load(true);
  // the lock on its own pool client (pattern — purgeLocked, maintenance.ts): no lock waiting; failed to release —
  // the connection is closed; the lock ends with the session
  const lock = await ctx.db.control.connect();
  let clean = false;
  try {
    const ok = (await lock.query("SELECT pg_try_advisory_lock(hashtext('mail:' || $1)) AS ok", [ctx.instanceId])).rows[0]?.ok === true;
    if (!ok) { clean = true; log.info("mail_busy", {}); return { reclaimed: 0, sent: 0, retried: 0, failed: 0, purged: 0, skipped: MAIL_BUSY }; }
    const watch = watchLock(lock);
    try { return await mailPass(ctx, watch.alive); }
    finally {
      try {
        if (!watch.lost()) await lock.query("SELECT pg_advisory_unlock(hashtext('mail:' || $1))", [ctx.instanceId]).then(() => { clean = true; }, () => undefined);
        if (watch.lost()) {
          clean = false;
          log.warn("lock_connection_lost", { job: "mail" });
        }
      } finally { watch.done(); }
    }
  } finally { lock.release(!clean); }
}

async function mailPass(ctx: MailCtx, alive: () => Promise<void>): Promise<MailTick> {
  const cfg = smtpConfig(ctx.settings), control = ctx.db.control;
  // transport fingerprint of this pass: the letters below go with exactly this cfg
  const transportFp = ctx.appSecret ? smtpTransportDigest(ctx.appSecret, cfg) : null;
  const out: MailTick = { reclaimed: 0, sent: 0, retried: 0, failed: 0, purged: 0 };
  // send over the timeout (connect + three server replies) — aborted: the letter waits again, the attempt counts
  out.reclaimed = (await control.query(
    `UPDATE mail_outbox SET status = 'pending', next_attempt_at = now(), updated_at = now(), last_error_code = 'smtp_interrupted',
            last_error = 'Delivery interrupted (worker restarted): the e-mail will be sent again'
      WHERE instance_id = $1 AND status = 'sending' AND updated_at < now() - make_interval(secs => $2)`,
    [ctx.instanceId, cfg.timeout_sec * 5 + 60])).rowCount ?? 0;
  if (out.reclaimed) log.warn("mail_reclaimed", { rows: out.reclaimed });
  out.purged = (await control.query(
    `DELETE FROM mail_outbox WHERE instance_id = $1 AND status IN ('sent','failed','cancelled') AND updated_at < now() - make_interval(days => $2)`,
    [ctx.instanceId, cfg.keep_days])).rowCount ?? 0;
  if (!cfg.enabled) return { ...out, skipped: "smtp.enabled = false" };
  const problems = smtpProblems(cfg);
  if (problems.length) { log.warn("mail_not_configured", { problems: problems.map((p) => p.key) }); return { ...out, skipped: "settings are invalid" }; }

  // transport hold: while the pause of this transport runs, nothing is sent
  const hold = await transportHold(control, ctx.instanceId, transportFp);
  if (hold.waiting) {
    log.info("mail_transport_waiting", { code: hold.code, held: hold.letters });
    return { ...out, held: hold.letters, skipped: MAIL_HELD };
  }
  // letters held under other mail settings are due at once: the settings changed, the new transport gets its try
  const otherTransport = hold.fpColumn ? " OR (last_error_code = ANY($3::text[]) AND transport_fp IS DISTINCT FROM $4::text)" : "";
  // letters are picked once — CTE MATERIALIZED: the form UPDATE … WHERE id IN (SELECT … LIMIT … FOR UPDATE SKIP
  // LOCKED) with the stats of an almost empty queue ran as a nested loop and ran the subquery again for each row — a batch
  // came out over BATCH
  const batch = await tx(control, async (q) => (await q.query(
    `WITH picked AS MATERIALIZED (
       SELECT id AS pick_id FROM mail_outbox WHERE instance_id = $1 AND status = 'pending' AND (next_attempt_at <= now()${otherTransport})
        ORDER BY next_attempt_at LIMIT $2 FOR UPDATE SKIP LOCKED)
     UPDATE mail_outbox SET status = 'sending', attempts = attempts + 1, updated_at = now() FROM picked WHERE id = picked.pick_id
      RETURNING id, kind, to_address, subject, body_text, attempts, dedupe_key`,
    hold.fpColumn ? [ctx.instanceId, BATCH, [...SMTP_HOLD_CODES], transportFp] : [ctx.instanceId, BATCH])).rows as Array<{ id: string; kind: string; to_address: string; subject: string; body_text: string; attempts: number; dedupe_key?: string | null }>);

  // letter returned and taken again while this send ran (status or attempt number differ) — no result is written or counted
  const fenced = (m: { id: string; kind: string; attempts: number }, n: number): boolean => {
    if (n) return true;
    log.warn("mail_outcome_fenced", { mail_id: m.id, kind: m.kind, attempt: m.attempts });
    return false;
  };
  // settings are fresh (settings.load(true) in mailTick): custodian reading turned off — custody letters do not go
  const policy = custodyPolicy(ctx.settings);
  for (const [i, m] of batch.entries()) {
    // check before sending: a meeting letter — the recipient is still a participant; a custody one — custody is the same
    // as in the letter, and the address is the recipient's current one. The check did not run (database down) — the
    // letter is not sent but waits for a retry, as on a temporary mail failure
    const check = m.kind === "meeting_new"
      ? { to: meetingMailRecipientOk({ control, records: (cls) => recordsDb(ctx, cls) }, ctx.instanceId, m.dedupe_key).then((ok) => (ok ? m.to_address : null)),
          code: MEETING_MAIL_NOT_PARTICIPANT, text: MEETING_MAIL_NOT_PARTICIPANT_TEXT,
          failedText: "Could not verify that the recipient is still a meeting participant. The e-mail was not sent and will be retried later" }
      : m.kind === "custody"
        ? { to: custodyMailRecipient(control, ctx.instanceId, m.dedupe_key, policy), code: CUSTODY_MAIL_STALE,
            text: CUSTODY_MAIL_STALE_TEXT, failedText: "Could not verify that the custody arrangement still matches the e-mail. The e-mail was not sent and will be retried later" }
        : null;
    let to = m.to_address;
    if (check) {
      const got = await check.to.catch((e: Error) => e);
      if (typeof got === "string" && got !== to) {
        // the custodian's mail changed while the letter waited: send to the current address, the queue row too
        // (the «Mail» journal shows where it went); fenced like the send result below
        const n = (await control.query("UPDATE mail_outbox SET to_address = $2, updated_at = now() WHERE id = $1 AND status = 'sending' AND attempts = $3",
                                       [m.id, got, m.attempts])).rowCount ?? 0;
        if (!fenced(m, n)) continue;
        log.info("mail_readdressed", { mail_id: m.id, kind: m.kind });
        to = got;
      }
      const ok = typeof got === "string" ? true : got ?? false;
      if (ok !== true) {
        const failed = ok instanceof Error, last = failed && m.attempts >= cfg.max_attempts;
        // fenced like the send result below: a letter returned and taken again meanwhile is not rewritten
        const n = (await control.query(
          `UPDATE mail_outbox SET status = $2, next_attempt_at = CASE WHEN $2 = 'pending' THEN now() + make_interval(secs => $5) ELSE next_attempt_at END,
                  last_error_code = $3, last_error = $4, updated_at = now() WHERE id = $1 AND status = 'sending' AND attempts = $6`,
          [m.id, failed ? (last ? "failed" : "pending") : "cancelled", failed ? "recipient_check_failed" : check.code,
           failed ? check.failedText : check.text, retryDelaySec(cfg, m.attempts), m.attempts])).rowCount ?? 0;
        if (!fenced(m, n)) continue;
        // custody letter cancelled — the recipient is no longer «notified», true again; the job queues it anew
        if (!failed && m.kind === "custody")
          await custodyMailForget(control, ctx.instanceId, m.dedupe_key).catch((e: Error) => log.warn("custody_mail_forget_failed", { mail_id: m.id, error: e.message.slice(0, 160) }));
        if (!failed) out.cancelled = (out.cancelled ?? 0) + 1; else if (last) out.failed++; else out.retried++;
        log[failed ? "warn" : "info"](failed ? "mail_recipient_check_failed" : "mail_cancelled", { mail_id: m.id, kind: m.kind, ...(failed ? { error: ok.message.slice(0, 160) } : { code: check.code }) });
        continue;
      }
    }
    try {
      await alive();
      const sent = await sendMail(cfg, { to, subject: m.subject, text: m.body_text });
      const n = await markSent(control, m, sent.messageId.slice(0, 250), transportFp);
      if (!fenced(m, n)) continue;
      out.sent++;
      log.info("mail_sent", { mail_id: m.id, kind: m.kind, attempt: m.attempts });
    } catch (e) {
      if (e instanceof LockConnectionLost) throw e;
      const f = smtpFailure(e, cfg);
      if (smtpTransportHold(f.code)) {
        // not the letter's fault — this letter and the rest of the batch wait, the pass stops here
        const pause = holdPauseSec(cfg, f.code, hold.pause);
        out.held = await holdTransport(control, batch.slice(i), f, pause, hold.fpColumn ? { fp: transportFp } : null);
        log.warn("mail_transport_held", { mail_id: m.id, kind: m.kind, code: f.code, held: out.held, pause_sec: pause, detail: f.detail.slice(0, 200) });
        await holdAlert(ctx, f, out.held, pause);
        break;
      }
      const last = f.permanent || m.attempts >= cfg.max_attempts;
      const n = (await control.query(
        `UPDATE mail_outbox SET status = $2, next_attempt_at = CASE WHEN $2 = 'pending' THEN now() + make_interval(secs => $3) ELSE next_attempt_at END,
                last_error_code = $4, last_error = $5, updated_at = now() WHERE id = $1 AND status = 'sending' AND attempts = $6`,
        [m.id, last ? "failed" : "pending", retryDelaySec(cfg, m.attempts), f.code, f.message.slice(0, 500), m.attempts])).rowCount ?? 0;
      if (!fenced(m, n)) continue;
      if (last) out.failed++; else out.retried++;
      log.warn(last ? "mail_failed" : "mail_retry", { mail_id: m.id, kind: m.kind, attempt: m.attempts, code: f.code, detail: f.detail.slice(0, 200) });
    }
  }
  return out;
}

/** State of the transport hold for the current mail settings. */
interface TransportHold { waiting: boolean; letters: number; pause: number | null; code: string | null; fpColumn: boolean }

/**
 * Hold of the current transport: letters held by SMTP_HOLD_CODES under this fingerprint; waiting — the pause of at least
 * one of them still runs; pause — the longest pause set so far (next_attempt_at − updated_at, the next one doubles it).
 * Without the transport_fp column (schema 12 not applied yet, the worker already new) every held letter counts as held
 * by the current transport, and the claim does not look at the fingerprint.
 */
async function transportHold(control: MailCtx["db"]["control"], instanceId: string, fp: string | null): Promise<TransportHold> {
  const sql = (byFp: boolean) =>
    `SELECT count(*)::int AS letters, coalesce(bool_or(next_attempt_at > now()), false) AS waiting,
            max(extract(epoch FROM next_attempt_at - updated_at))::int AS pause, max(last_error_code) AS code
       FROM mail_outbox WHERE instance_id = $1 AND status = 'pending' AND last_error_code = ANY($2::text[])${byFp ? " AND transport_fp IS NOT DISTINCT FROM $3::text" : ""}`;
  const read = (r: { rows: Array<Record<string, unknown>> }, fpColumn: boolean): TransportHold => {
    const row = r.rows[0] ?? {};
    const pause = row.pause === null || row.pause === undefined ? null : Number(row.pause);
    return { waiting: row.waiting === true, letters: Number(row.letters ?? 0), pause: Number.isFinite(pause) ? pause : null,
             code: typeof row.code === "string" ? row.code : null, fpColumn };
  };
  try {
    return read(await control.query(sql(true), [instanceId, [...SMTP_HOLD_CODES], fp]), true);
  } catch (e) {
    if ((e as { code?: string })?.code !== "42703") throw e;
    log.warn("mail_transport_fp_missing", { at: "hold" });
    return read(await control.query(sql(false), [instanceId, [...SMTP_HOLD_CODES]]), false);
  }
}

/**
 * Put letters back to pending on a transport hold: the attempt is not counted (attempts − 1: the claim added it), the
 * reason and the fingerprint of the refused transport are kept, the next try is after the pause. Fenced by status and
 * attempt like every outcome. Returns how many letters wait.
 */
async function holdTransport(control: MailCtx["db"]["control"], letters: Array<{ id: string; attempts: number }>, f: SmtpFailure,
                             pause: number, fp: { fp: string | null } | null): Promise<number> {
  return (await control.query(
    `UPDATE mail_outbox SET status = 'pending', attempts = attempts - 1, next_attempt_at = now() + make_interval(secs => $3),
            last_error_code = $4, last_error = $5, updated_at = now()${fp ? ", transport_fp = $6::text" : ""}
      WHERE status = 'sending' AND (id, attempts) IN (SELECT * FROM unnest($1::uuid[], $2::int[]))`,
    [letters.map((m) => m.id), letters.map((m) => m.attempts), pause, f.code, f.message.slice(0, 500), ...(fp ? [fp.fp] : [])])).rowCount ?? 0;
}

/**
 * High alert of a transport hold (contracts/edge/audit-codes.json mail_transport_held): one per failure code a day
 * while open. After acknowledgement or closure, the next pause gets its own row. No server reply or password inside.
 */
async function holdAlert(ctx: MailCtx, f: SmtpFailure, held: number, pause: number): Promise<void> {
  const what = f.code === "smtp_auth_failed" ? "the mail server refused the login of the mail account"
    : "encryption with the mail server (STARTTLS or TLS) was not established";
  const until = new Date(Date.now() + pause * 1000).toISOString();
  const base = `${MAIL_HOLD_ALERT}:${f.code}:${new Date().toISOString().slice(0, 10)}`;
  let generation: number;
  try {
    const r = await ctx.db.control.query(
      `SELECT count(*)::int AS n FROM admin_alerts WHERE instance_id = $1
         AND (dedupe_key = $2 OR starts_with(dedupe_key, $2 || ':'))
         AND (acked_at IS NOT NULL OR status = 'closed')`, [ctx.instanceId, base]);
    generation = Number(r.rows[0]?.n ?? 0);
  } catch {
    log.warn("mail_hold_alert_read_failed", { code: f.code });
    generation = 0;
  }
  await raiseAlert({ control: ctx.db.control, audit: ctx.db.audit }, {
    instanceId: ctx.instanceId, level: "high", code: MAIL_HOLD_ALERT,
    summary: `Mail is on hold: ${what} (${f.code}). Letters wait in the queue (${held} in this pass); next try in ${Math.max(1, Math.round(pause / 60))} min, at once after new mail settings or a successful test letter`,
    details: { error_code: f.code, held, until }, dedupeKey: generation ? `${base}:${generation}` : base,
  });
}

/**
 * Result «sent» with the transport fingerprint, fenced by status and attempt number. Column transport_fp does not
 * exist yet (schema 12 not applied, the worker new) — same result by the old query, no fingerprint: the letter left,
 * and a failed write must not resend it; the gate skips it, like a NULL row.
 */
async function markSent(control: MailCtx["db"]["control"], m: { id: string; attempts: number }, messageId: string, transportFp: string | null): Promise<number> {
  const set = "status = 'sent', sent_at = now(), updated_at = now(), message_id = $2, last_error_code = NULL, last_error = NULL";
  const where = "WHERE id = $1 AND status = 'sending' AND attempts = $3";
  try {
    return (await control.query(`UPDATE mail_outbox SET ${set}, transport_fp = $4 ${where}`, [m.id, messageId, m.attempts, transportFp])).rowCount ?? 0;
  } catch (e) {
    if ((e as { code?: string })?.code !== "42703") throw e;
    log.warn("mail_transport_fp_missing", { mail_id: m.id });
    return (await control.query(`UPDATE mail_outbox SET ${set} ${where}`, [m.id, messageId, m.attempts])).rowCount ?? 0;
  }
}
