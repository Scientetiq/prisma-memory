// One mechanism for the text of every e-mail: renderMail(template, locale, vars) builds the subject and the
// plain-text body from the message catalog (src/messages/mail-*.ts), English by default, Russian as the ru locale.
//
// The locale is a parameter. Every producer passes instanceLocale() today: a mail is rendered when it is queued, stored
// in mail_outbox and sent later, so its language must not follow the request that triggered it. The parameter exists so
// that a recipient's own language can be passed later without touching the templates.
//
// A new mail of another area adds its template here (an entry of MailVars and of TEMPLATES) and its texts to a
// messages file; it brings no rendering of its own. Rules for a template:
//   - texts come from the catalog only; the product name is {product}, never a literal;
//   - times go through mailTime (the zone is a variable of the template, the caller passes the instance zone);
//   - variables are data: they are substituted in one pass and never scanned for placeholders;
//   - nothing rendered here may become part of a dedupe key (the same event would be mailed again after a language
//     switch): keys are built from identifiers by the producer.
import { fmtDateTime, type Locale, type Message, type ParamsArg } from "@memory/i18n";
import { currentLocale, tr, withLocale } from "@memory/i18n/context";
import { alertCodeInfo } from "./alert-codes.ts";
import type { AlertForMail, OpenSecurityLine } from "./alerts.ts";
import type { CustodyBasis } from "./custody.ts";
import type { IdentityLinkChange } from "./identity-mail.ts";
import { M as ALERTS } from "./messages/mail-alerts.ts";
import { M as CUSTODY } from "./messages/mail-custody.ts";
import { M as DIGEST } from "./messages/mail-digest.ts";
import { M as IDENTITY } from "./messages/mail-identity.ts";
import { M as MEETINGS } from "./messages/mail-meetings.ts";
import { M as OPS } from "./messages/mail-ops.ts";
import type { OpenRecheckReason } from "./open-recheck.ts";
import type { DigestCounts } from "./org-review.ts";
import { fallbackTz } from "./zoned-time.ts";

/** Subject and plain-text body of one mail. */
export interface MailText { subject: string; text: string }

/** Alert rows listed in the catch-up mail; the rest are given as a number. */
export const MAIL_CATCHUP_LINES = 30;

interface AlertMailCommon { instance: string; tz?: string; panelOrigin?: string | null }

/** Variables of every mail template. */
export interface MailVars {
  /** To the new custodian of a former employee's personal records. link — the page of the records or null. */
  "custody.handed": { name: string; basis: CustodyBasis; link: string | null; meetings: number };
  /** To the previous custodian: the records went to someone else. */
  "custody.off": { name: string };
  /** To a person whose profile gained or lost linked accounts. link — the workspace address or null. */
  "identity.change": { changes: readonly IdentityLinkChange[]; link: string | null };
  /** Weekly numbers to the curators of the company knowledge space. tz — the zone of the "waiting since" day (UTC when absent). */
  "digest.curator": { counts: DigestCounts; workplaceUrl: string | null; tz?: string };
  /** One high or urgent alert. */
  "alert.single": AlertMailCommon & { alert: AlertForMail };
  /** High alerts that were not mailed while alert mail was off. */
  "alert.catchup": AlertMailCommon & { rows: readonly AlertForMail[] };
  /** Daily digest of medium alerts. day — the day as the caller wants it shown (mailDay). */
  "alert.digest": AlertMailCommon & { rows: readonly AlertForMail[]; day: string; openSecurity?: readonly OpenSecurityLine[]; hostFactsAt?: Date | string | null; more?: number };
  /** Sent through the previous transport right before the transport of alert mail changes. */
  "alert.transportChange": { keys: readonly string[]; who: string | null };
  /** The test message of the mail settings. workplaceUrl — empty when not set. */
  "mail.test": { workplaceUrl: string; by: string };
  /** Report of an open-check recheck run: numbers only. */
  "openRecheck.report": { checked: number; held: number; unchecked: number; onRestore: number; spaces: number; entities: number; failed?: number; reason?: OpenRecheckReason };
  /** To the organizer: a participant asks to delete the meeting. date — YYYY-MM-DD, the day in the instance zone (mailIsoDay). */
  "deletion.owner": { who: string; login: string; title: string | null; date: string; days: number; recordUrl: string | null; recordId: string };
  /** To the administrator: a participant asks to delete a meeting (no title). */
  "deletion.admin": { login: string; owner: string | null; date: string; days: number; panelUrl: string | null; recordId: string };
  /** To the person who asked: the administrator kept the meeting. date — the day as mailIsoDay gives it (an instant is cut to its first ten characters). */
  "deletion.kept": { date: string | null; recordUrl: string | null; recordId: string };
  /** To the administrators: a request to return the security mode to basic. notBefore — ISO instant or null. */
  "securityMode.downgrade": { by: string; notBefore: string | null };
}

export type MailTemplate = keyof MailVars;

// ---------------------------------------------------------------------------------------------------------------- helpers

/** One line without control characters, at most max characters. */
const oneLine = (s: string, max: number): string => {
  const flat = String(s).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Render in a given locale (the forced locale of the legacy test profile still wins, as for every server text). */
const say = <P>(locale: Locale, m: Message<P>, ...params: ParamsArg<P>): string => withLocale(locale, () => tr(m, ...params));

/**
 * An instant as mail text in the zone tz, with the zone named: ru «24.10.2026, 06:15 (UTC)», en "2026-10-24 06:15 (UTC)".
 * An invalid date gives the words "time unknown"; an unknown zone falls back to UTC.
 */
export function mailTime(locale: Locale, at: Date | string, tz: string = fallbackTz()): string {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return say(locale, ALERTS.timeUnknown);
  try {
    return fmtDateTime(locale, tz, d, "dateTimeZone");
  } catch {
    return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  }
}

/** A calendar day YYYY-MM-DD as mail text: ru DD.MM.YYYY, en as it is. Anything else is returned unchanged. */
export function mailDay(locale: Locale, isoDay: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay);
  return m && locale === "ru" ? `${m[3]}.${m[2]}.${m[1]}` : isoDay;
}

/**
 * The calendar day of an instant in the zone tz as YYYY-MM-DD, the same in every language (the day of a meeting in the
 * mails about a request to delete it). An unknown zone falls back to UTC; a value that is not a date is returned cut to
 * ten characters.
 */
export function mailIsoDay(at: Date | string, tz: string = fallbackTz()): string {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return String(at).slice(0, 10);
  try {
    return fmtDateTime("en", tz, d, "date");
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** Where the alerts are: the panel's alerts page when its origin is known, else words. */
export function mailAlertsWhere(locale: Locale, panelOrigin: string | null | undefined): string {
  return panelOrigin ? `${panelOrigin.replace(/\/+$/, "")}/admin/alerts` : say(locale, ALERTS.where);
}

/** A subject "without a subject": "*" inside and "edge:*" from the edge. */
const noSubject = (s: string | null | undefined): boolean => !s || s === "*" || s === "edge:*";

const LEVELS = { page: ALERTS.levelPage, high: ALERTS.levelHigh, medium: ALERTS.levelMedium, metric: ALERTS.levelMetric } as const;
const levelOf = (level: string): string => (Object.hasOwn(LEVELS, level) ? tr(LEVELS[level as keyof typeof LEVELS]) : level);

/** The title of an alert code in the locale, or null: English from title; Russian from title_ru, else the English title. */
function codeTitle(l: Locale, code: string): string | null {
  const info = alertCodeInfo(code);
  return (l === "ru" ? info?.title_ru || info?.title : info?.title) || null;
}
function codeHint(l: Locale, code: string): string | null {
  const info = alertCodeInfo(code);
  return (l === "ru" ? info?.hint_ru || info?.hint : info?.hint) || null;
}
/** "Title (code)" — or "Title (code, extra)"; without a title in the locale ru repeats the code (as before), en names it once. */
function codeNamed(l: Locale, code: string, extra?: string): string {
  const title = codeTitle(l, code);
  const tail = extra ? `${code}, ${extra}` : code;
  if (title) return `${title} (${tail})`;
  if (l === "ru") return `${code} (${tail})`;
  return extra ? `${code} (${extra})` : code;
}

const weight = (r: AlertForMail): number => Math.max(1, Number(r.count ?? 1));
const ms = (at: Date | string): number => new Date(at).getTime();

/**
 * Names of the account systems (person_identities.system) in a mail. A system without a name of its own — an unknown
 * one, or one whose name would point at a particular vendor's product — is called simply "account".
 */
const IDENTITY_SYSTEMS = {
  ad: IDENTITY.systemAd, sap: IDENTITY.systemSap, telegram: IDENTITY.systemTelegram, hub: IDENTITY.systemHub, sso: IDENTITY.systemSso,
  other: IDENTITY.systemOther,
} as const;
const identitySystem = (system: string): string =>
  tr(Object.hasOwn(IDENTITY_SYSTEMS, system) ? IDENTITY_SYSTEMS[system as keyof typeof IDENTITY_SYSTEMS] : IDENTITY.systemOther);
/** An account identifier in a mail: one line, at most 80 characters. */
const shownId = (s: string): string => {
  const one = String(s).replace(/[\r\n\t]+/g, " ").trim();
  return one.length > 80 ? `${one.slice(0, 79)}…` : one;
};

const CUSTODY_BASIS: Record<CustodyBasis, typeof CUSTODY.basisAdmin> = {
  manager: CUSTODY.basisManager, department_head: CUSTODY.basisDepartmentHead, admin: CUSTODY.basisAdmin, manual: CUSTODY.basisAdmin,
};

// -------------------------------------------------------------------------------------------------------------- templates

type Build<K extends MailTemplate> = (v: MailVars[K], l: Locale) => MailText;

const TEMPLATES: { readonly [K in MailTemplate]: Build<K> } = {
  "custody.handed": (a) => {
    const basis = tr(Object.hasOwn(CUSTODY_BASIS, a.basis) ? CUSTODY_BASIS[a.basis] : CUSTODY.basisAdmin);
    const lines = [
      tr(CUSTODY.handedIntro, { name: a.name, basis }),
      tr(CUSTODY.handedView, { where: a.link ?? tr(CUSTODY.handedPlace) }),
    ];
    if (a.meetings > 0) lines.push(tr(CUSTODY.handedMeetings, { meetings: a.meetings }));
    lines.push(tr(CUSTODY.handedOnlyYou));
    lines.push(tr(CUSTODY.handedWrongPerson));
    return { subject: tr(CUSTODY.handedSubject, { name: a.name }), text: lines.join("\n") };
  },

  "custody.off": (a) => ({ subject: tr(CUSTODY.offSubject, { name: a.name }), text: tr(CUSTODY.offText, { name: a.name }) }),

  "identity.change": (a) => {
    if (!a.changes.length) throw new Error("renderMail identity.change: no link changes");
    const added = a.changes.filter((x) => x.change === "added"), removed = a.changes.filter((x) => x.change === "removed");
    const lines = [tr(IDENTITY.intro)];
    for (const x of added) lines.push(tr(IDENTITY.added, { account: identitySystem(x.system), id: shownId(x.externalId) }));
    for (const x of removed) lines.push(tr(IDENTITY.removed, { account: identitySystem(x.system), id: shownId(x.externalId) }));
    lines.push(tr(IDENTITY.agents));
    lines.push(tr(IDENTITY.unexpected));
    lines.push(tr(IDENTITY.keys, { where: a.link ?? tr(IDENTITY.keysPlace) }));
    const subject = added.length && removed.length ? tr(IDENTITY.subjectBoth) : added.length ? tr(IDENTITY.subjectAdded) : tr(IDENTITY.subjectRemoved);
    return { subject, text: lines.join("\n") };
  },

  "digest.curator": (a, l) => {
    const c = a.counts;
    const url = a.workplaceUrl ? `${a.workplaceUrl.replace(/\/+$/, "")}/review` : null;
    let oldest: string | null = null;
    if (c.oldest) {
      try { oldest = fmtDateTime(l, a.tz ?? "UTC", c.oldest, "date"); } catch { oldest = null; }
    }
    const lines = [
      tr(DIGEST.waiting, { waiting: c.waiting, newWeek: c.newWeek }),
      ...(c.held ? [tr(DIGEST.held, { held: c.held })] : []),
      tr(DIGEST.due, { dueWeek: c.dueWeek }),
      ...(oldest ? [tr(DIGEST.oldest, { day: oldest })] : []),
      url ? tr(DIGEST.list, { limit: c.limit, url }) : tr(DIGEST.listPlace, { limit: c.limit }),
      tr(DIGEST.note),
    ];
    return { subject: tr(DIGEST.subject, { waiting: c.waiting }), text: lines.join("\n") };
  },

  "alert.single": (o, l) => {
    const a = o.alert;
    const title = codeTitle(l, a.code);
    const hint = codeHint(l, a.code);
    const n = Number(a.count ?? 1);
    const again = n > 1;
    const last = again && a.last_at ? a.last_at : null;
    return {
      subject: oneLine(tr(ALERTS.subject, { kind: tr(a.level === "page" ? ALERTS.kindPage : ALERTS.kindAlert), again: again ? tr(ALERTS.again) : "", title: title ?? a.code }), 200),
      text: [
        tr(ALERTS.intro, { instance: oneLine(o.instance, 64), level: levelOf(a.level) }),
        "",
        title ? tr(ALERTS.what, { title, code: a.code }) : tr(ALERTS.whatCode, { code: a.code }),
        // a repeated alert: "when" is the last time, the first time is in the "repeated" line
        last ? tr(ALERTS.whenLast, { time: mailTime(l, last, o.tz) }) : tr(ALERTS.when, { time: mailTime(l, a.at, o.tz) }),
        ...(again ? [a.first_at ? tr(ALERTS.repeatedSince, { count: n, first: mailTime(l, a.first_at, o.tz) }) : tr(ALERTS.repeated, { count: n })] : []),
        ...(!noSubject(a.subject) ? [tr(ALERTS.about, { subject: oneLine(a.subject!, 128) })] : []),
        tr(ALERTS.details, { summary: oneLine(a.summary, 300) }),
        ...(hint ? [tr(ALERTS.todo, { hint })] : []),
        "",
        tr(ALERTS.all, { where: mailAlertsWhere(l, o.panelOrigin) }),
        "",
        tr(ALERTS.footer),
      ].join("\n"),
    };
  },

  "alert.catchup": (o, l) => {
    const sorted = [...o.rows].sort((x, y) => ms(x.at) - ms(y.at));
    const shown = sorted.slice(0, MAIL_CATCHUP_LINES);
    return {
      subject: oneLine(tr(ALERTS.catchupSubject, { count: o.rows.length }), 200),
      text: [
        tr(ALERTS.catchupIntro, { instance: oneLine(o.instance, 64), count: o.rows.length }),
        "",
        ...shown.map((r) => `• ${mailTime(l, r.at, o.tz)} — ${codeNamed(l, r.code)}: ${oneLine(r.summary, 200)}`),
        ...(sorted.length > shown.length ? [tr(ALERTS.catchupMore, { count: sorted.length - shown.length })] : []),
        "",
        tr(ALERTS.all, { where: mailAlertsWhere(l, o.panelOrigin) }),
        "",
        tr(ALERTS.footer),
      ].join("\n"),
    };
  },

  "alert.digest": (o, l) => {
    const rows = o.rows;
    const byCode = new Map<string, { n: number; last: AlertForMail }>();
    for (const r of rows) {
      const cur = byCode.get(r.code);
      if (!cur) byCode.set(r.code, { n: weight(r), last: r });
      else { cur.n += weight(r); if (ms(r.at) > ms(cur.last.at)) cur.last = r; }
    }
    const total = rows.reduce((s, r) => s + weight(r), 0);
    const groups = [...byCode.entries()].sort((x, y) => y[1].n - x[1].n || x[0].localeCompare(y[0]));
    const recent = [...rows].sort((x, y) => ms(y.at) - ms(x.at)).slice(0, 30);
    const open = [...(o.openSecurity ?? [])].sort((x, y) => ms(y.last_at) - ms(x.last_at));
    const openAlerts = open.reduce((s, x) => s + x.alerts, 0);
    return {
      subject: oneLine(open.length ? tr(ALERTS.digestSubjectOpen, { day: o.day, total, open: openAlerts }) : tr(ALERTS.digestSubject, { day: o.day, total }), 200),
      text: [
        tr(ALERTS.digestIntro, { instance: oneLine(o.instance, 64), day: o.day, total }),
        ...(rows.length ? [
          "",
          tr(ALERTS.digestByKind),
          ...groups.map(([code, g]) => tr(ALERTS.digestGroup, { name: codeNamed(l, code), total: g.n, time: mailTime(l, g.last.at, o.tz) })),
          "",
          rows.length > recent.length ? tr(ALERTS.digestRecentOf, { shown: recent.length, total: rows.length }) : tr(ALERTS.digestRecent),
          ...recent.map((r) => `• ${mailTime(l, r.at, o.tz)} — ${r.code}${weight(r) > 1 ? ` ×${weight(r)}` : ""}: ${oneLine(r.summary, 200)}`),
        ] : []),
        // the digest takes at most one batch of rows: the rest are a number and come with the next digest
        ...(o.more && o.more > 0 ? ["", tr(ALERTS.digestMore, { count: o.more })] : []),
        ...(open.length ? [
          "",
          tr(ALERTS.digestOpen),
          ...open.slice(0, 30).map((x) => {
            const name = codeNamed(l, x.code, levelOf(x.level)), time = mailTime(l, x.last_at, o.tz);
            return x.repeats > x.alerts ? tr(ALERTS.digestOpenRowRepeats, { name, alerts: x.alerts, repeats: x.repeats, time }) : tr(ALERTS.digestOpenRow, { name, alerts: x.alerts, time });
          }),
          ...(open.length > 30 ? [tr(ALERTS.digestOpenMore, { count: open.length - 30 })] : []),
        ] : []),
        ...(o.hostFactsAt ? ["", tr(ALERTS.digestHostFacts, { time: mailTime(l, o.hostFactsAt, o.tz) })] : []),
        "",
        tr(ALERTS.all, { where: mailAlertsWhere(l, o.panelOrigin) }),
        "",
        tr(ALERTS.footer),
      ].join("\n"),
    };
  },

  "alert.transportChange": (a) => {
    const keys = a.keys.join(", ");
    return {
      subject: tr(ALERTS.transportSubject),
      text: [
        a.who ? tr(ALERTS.transportNowWho, { keys, who: a.who }) : tr(ALERTS.transportNow, { keys }),
        tr(ALERTS.transportOld),
        tr(ALERTS.transportNext),
      ].join("\n\n"),
    };
  },

  "mail.test": (a) => ({
    subject: tr(OPS.testSubject),
    text: [
      tr(OPS.testIntro),
      "",
      tr(OPS.testBy, { by: a.by }),
      a.workplaceUrl ? tr(OPS.testWorkplace, { url: a.workplaceUrl }) : tr(OPS.testNoWorkplace),
      "",
      tr(OPS.testNoReply),
    ].join("\n"),
  }),

  "openRecheck.report": (c) => {
    const nfd = c.reason === "nfd";
    const lines = [
      nfd ? tr(OPS.recheckIntroNfd, { checked: c.checked, held: c.held }) : tr(OPS.recheckIntro, { checked: c.checked, held: c.held }),
      ...(c.unchecked ? [tr(OPS.recheckUnchecked, { unchecked: c.unchecked })] : []),
      ...(c.failed ? [tr(OPS.recheckFailed, { failed: c.failed })] : []),
      ...(c.onRestore ? [tr(OPS.recheckOnRestore, { onRestore: c.onRestore })] : []),
      ...(c.spaces || c.entities ? [tr(OPS.recheckNames, { spaces: c.spaces, entities: c.entities })] : []),
      nfd ? tr(OPS.recheckLookNfd) : tr(OPS.recheckLook),
      nfd ? tr(OPS.recheckNoTextNfd) : tr(OPS.recheckNoText),
    ];
    return { subject: nfd ? tr(OPS.recheckSubjectNfd) : tr(OPS.recheckSubject), text: lines.join("\n") };
  },

  "deletion.owner": (a) => {
    const title = a.title ?? tr(MEETINGS.untitled);
    return {
      subject: tr(MEETINGS.ownerSubject, { title: title.slice(0, 120) }),
      text: [
        tr(MEETINGS.ownerAsks, { who: a.who, login: a.login, title, date: a.date }),
        "",
        tr(MEETINGS.ownerWho, { count: a.days }),
        a.recordUrl ? tr(MEETINGS.ownerOpen, { url: a.recordUrl }) : tr(MEETINGS.meetingPlace),
        tr(MEETINGS.ownerNotThere, { who: a.who }),
        tr(MEETINGS.ownerKeep),
        "",
        tr(MEETINGS.recordLine, { id: a.recordId }),
      ].join("\n"),
    };
  },

  "deletion.admin": (a) => ({
    subject: tr(MEETINGS.adminSubject),
    text: [
      tr(MEETINGS.adminAsks, { login: a.login, owner: a.owner ?? "—", date: a.date }),
      "",
      tr(MEETINGS.adminWho, { count: a.days }),
      a.panelUrl ? tr(MEETINGS.adminPanel, { url: a.panelUrl }) : tr(MEETINGS.adminPanelPlace),
      "",
      tr(MEETINGS.recordLine, { id: a.recordId }),
    ].join("\n"),
  }),

  "deletion.kept": (a) => ({
    subject: tr(MEETINGS.keptSubject),
    text: [
      a.date ? tr(MEETINGS.keptDated, { date: a.date.slice(0, 10) }) : tr(MEETINGS.kept),
      "",
      a.recordUrl ? tr(MEETINGS.keptLink, { url: a.recordUrl }) : tr(MEETINGS.meetingPlace),
      tr(MEETINGS.keptQuestions),
      "",
      tr(MEETINGS.recordLine, { id: a.recordId }),
    ].join("\n"),
  }),

  "securityMode.downgrade": (a) => ({
    subject: tr(OPS.downgradeSubject),
    text: [
      tr(OPS.downgradeAsked, { by: a.by }),
      tr(OPS.downgradeWhen, { when: a.notBefore ? `${a.notBefore.slice(0, 16).replace("T", " ")} UTC` : tr(OPS.downgradeDelayEnd) }),
      tr(OPS.downgradeCancel),
    ].join("\n\n"),
  }),
};

/** Every mail template, in the order of MailVars. */
export const MAIL_TEMPLATES = Object.freeze(Object.keys(TEMPLATES)) as readonly MailTemplate[];

/**
 * Subject and body of a mail in the given locale. The texts come from the catalog; vars are data and are never scanned
 * for placeholders. An unknown template is the caller's error and throws.
 */
export function renderMail<K extends MailTemplate>(template: K, locale: Locale, vars: MailVars[K]): MailText {
  const build = (Object.hasOwn(TEMPLATES, template) ? TEMPLATES[template] : undefined) as Build<K> | undefined;
  if (!build) throw new Error(`renderMail: unknown template ${String(template)}`);
  return withLocale(locale, () => build(vars, currentLocale()));
}
