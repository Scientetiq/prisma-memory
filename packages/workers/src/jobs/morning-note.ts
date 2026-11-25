// Job morning_note: every 15 minutes and by hand (run-job.ts morning_note [manual]).
// Inside the send window of the day's slot it queues one personal morning note per recipient — numbers and links only
// (@memory/shared morning-note.ts, morning-note-text.ts); the mail queue sends it when SMTP is on.
// Order of the checks — that of the curators' digest (orgDigest): SMTP on → note on (access.morning_note.enabled) → a slot
// exists (weekdays not empty) and now is inside its send window → the mail kind is registered. Recipients: active people,
// neither demo nor test, whose login is an e-mail and who did not turn the note off (people.morning_note); pages of 200 by id.
// A person with all counters zero gets nothing. Right before queueing the person is checked again (deactivated or switched
// off since the page was read — no mail). The dedupe key morning_note:<slot day>:<person> makes a repeated run and two
// workers at once queue one e-mail.
// The operator's manual run (`manual: true`, run-job.ts morning_note manual — a check run by hand, as the curators'
// digest has one): neither the note's switch nor the send window is required, people marked as test are included, the
// window is that of the latest slot (as the workspace card: the latest daily slot when no weekday is enabled), the dedupe key
// is one per person per hour (morning_note:manual:<UTC hour>:<person>). SMTP, the registered mail kind, the person's own
// switch, demo and inactive people stay as on the schedule.
import {
  enqueueMail, log, MAIL_RE, morningNoteConfig, morningNoteCounts, morningNoteDedupeKey, morningNoteMailReady, morningNoteSlot, morningNoteText,
  MORNING_NOTE_MAIL_KIND, MORNING_NOTE_PAGE, MORNING_NOTE_RECIPIENTS_SQL, MORNING_NOTE_STILL_RECIPIENT_SQL, NOTE_KEY_WARN_DAYS, noteRetryLimit, smtpConfig, SCOPE_SYSTEM,
  type MailKind,
} from "@memory/shared";
import { auditWorker, type DbCtx } from "../ctx.ts";

export type MorningNoteSkip = "smtp_disabled" | "note_disabled" | "no_slot" | "outside_window" | "mail_kind_pending";
export interface MorningNoteRun {
  /** Local day of the slot (the dedupe key); null — no slot. */
  day: string | null;
  manual: boolean;
  /** New e-mails queued; a repeated run of the same day queues 0 (already). */
  queued: number;
  already: number;
  /**
   * People read as recipients; empty — all their counters were zero; no_address — the login is not a valid e-mail address
   * (MAIL_RE); gone — no longer a recipient right before queueing.
   */
  recipients: number;
  empty: number;
  no_address: number;
  gone: number;
  pages: number;
  skipped?: MorningNoteSkip;
}

interface Recipient { id: string; login: string; display_name: string | null; given_name: string | null }

export interface MorningNoteOpts {
  now?: Date;
  /** The operator's manual run (see the header). */
  manual?: boolean;
  kickMail?: () => Promise<unknown>;
  /** Tests only: called after the counts of a page and before each person is queued. */
  beforeQueue?: (personId: string) => Promise<void>;
}

export async function morningNoteTick(ctx: DbCtx, o: MorningNoteOpts = {}): Promise<MorningNoteRun> {
  const now = o.now ?? new Date(), manual = o.manual === true;
  const out: MorningNoteRun = { day: null, manual, queued: 0, already: 0, recipients: 0, empty: 0, no_address: 0, gone: 0, pages: 0 };
  await ctx.settings.load(true);
  if (!smtpConfig(ctx.settings).enabled) return { ...out, skipped: "smtp_disabled" };
  const cfg = morningNoteConfig(ctx.settings);
  if (!manual && !cfg.enabled) return { ...out, skipped: "note_disabled" };
  const slot = morningNoteSlot(now, cfg) ?? (manual ? morningNoteSlot(now, { ...cfg, weekdays: [1, 2, 3, 4, 5, 6, 7] }) : null);
  if (!slot) return { ...out, skipped: "no_slot" };
  out.day = slot.day;
  if (!manual && !slot.inWindow) return { ...out, skipped: "outside_window" };
  if (!morningNoteMailReady()) return { ...out, skipped: "mail_kind_pending" };
  const hour = manual ? now.toISOString().slice(0, 13) : undefined;
  const workplaceUrl = String(ctx.settings.get<string>("access.workplace_url", "") ?? "");
  const retryLimit = noteRetryLimit(ctx.settings);
  const src = { control: ctx.db.control, records: (cls: "open" | "closed") => ctx.db.records(cls, SCOPE_SYSTEM) };
  let after: string | null = null;
  for (;;) {
    const page = (await ctx.db.control.query(MORNING_NOTE_RECIPIENTS_SQL, [ctx.instanceId, after, MORNING_NOTE_PAGE, manual])).rows as Recipient[];
    if (!page.length) break;
    out.pages++; out.recipients += page.length;
    const counts = await morningNoteCounts(src, ctx.instanceId, page.map((p) => p.id), { from: slot.from, to: slot.start }, { keyWarnDays: NOTE_KEY_WARN_DAYS, retryLimit });
    for (const p of page) {
      if (!MAIL_RE.test(p.login)) { out.no_address++; continue; }
      const text = morningNoteText({ counts: counts.get(p.id)!, since: slot.from, tz: cfg.tz, displayName: p.display_name, givenName: p.given_name, workplaceUrl });
      if (!text) { out.empty++; continue; }
      await o.beforeQueue?.(p.id);
      if (!(await ctx.db.control.query(MORNING_NOTE_STILL_RECIPIENT_SQL, [p.id, ctx.instanceId, manual])).rows.length) { out.gone++; continue; }
      const r = await enqueueMail(ctx.db.control, ctx.instanceId, { kind: MORNING_NOTE_MAIL_KIND as MailKind, to: p.login, subject: text.subject, text: text.text,
                                                                   dedupeKey: morningNoteDedupeKey(slot.day, p.id, hour) });
      if (r.created) out.queued++; else out.already++;
    }
    if (page.length < MORNING_NOTE_PAGE) break;
    after = page[page.length - 1]!.id;
  }
  if (out.queued) {
    await auditWorker(ctx, { event_type: "admin", details: { tool: "morning_note", op: "morning_note", day: slot.day, manual, queued: out.queued, recipients: out.recipients } });
    await o.kickMail?.().catch((e) => log.warn("morning_note_mail_kick_failed", { error: (e as Error).message.slice(0, 200) }));
    log.info("morning_note", { day: slot.day, manual, queued: out.queued, already: out.already, empty: out.empty, no_address: out.no_address, gone: out.gone });
  }
  return out;
}
