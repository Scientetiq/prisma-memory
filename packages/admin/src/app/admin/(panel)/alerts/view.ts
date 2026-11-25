import { VIEW_TEXT, LEVEL_FILTERS, STATUS_FILTERS, LEVEL_BADGES, STATUS_BADGES, SUBJECT_TITLES, HOST_FACT_TITLES, QUOTA_KIND_TITLES } from "../../../../messages/panel-alerts";
export { VIEW_TEXT };

export type AlertLevel = "page" | "high" | "medium" | "metric";
export type AlertStatus = "open" | "acked" | "closed";

export interface AdminAlert {
  id: string; at: string; level: AlertLevel; code: string; summary: string;
  details?: Record<string, unknown>; acked_by?: string | null; acked_at?: string | null;
  status?: AlertStatus; subject?: string | null; count?: number; first_at?: string; last_at?: string;
}

export type LevelFilter = "all" | AlertLevel;
export { LEVEL_FILTERS };
export const levelFilter = (v: string): LevelFilter => (LEVEL_FILTERS.some((f) => f.value === v) ? v as LevelFilter : "all");

export type StatusFilter = "all" | AlertStatus;
export { STATUS_FILTERS };
export const statusFilter = (v: string): StatusFilter => (STATUS_FILTERS.some((f) => f.value === v) ? v as StatusFilter : "all");

export { LEVEL_BADGES };

export { STATUS_BADGES };

export const ackedBy = (a: Pick<AdminAlert, "acked_by" | "acked_at">): string | null =>
  a.acked_at ? (a.acked_by ?? VIEW_TEXT.administratorWithoutAProfile) : null;

export function repeatText(a: Pick<AdminAlert, "count">): string | null {
  const n = Number(a.count ?? 1);
  return Number.isFinite(n) && n > 1 ? VIEW_TEXT.repeatedValue1Times(n) : null;
}

export function subjectText(subject: string | null | undefined): string | null {
  if (!subject || subject === "*") return null;
  if (subject.startsWith("edge:")) {
    const rest = subjectText(subject.slice("edge:".length));
    return rest ? VIEW_TEXT.fromTheEdgeValue1(rest) : VIEW_TEXT.fromTheEdge;
  }
  const i = subject.indexOf(":");
  if (i <= 0) return subject;
  const k = subject.slice(0, i);
  return `${SUBJECT_TITLES[k] ?? k}: ${subject.slice(i + 1)}`;
}


interface SettingLike { category: string; key: string; value: unknown }

export function alertMailNotice(items: readonly SettingLike[] | null): string | null {
  if (!items) return null;
  const get = (c: string, k: string) => items.find((i) => i.category === c && i.key === k)?.value;
  const smtpOn = get("smtp", "enabled") === true;
  const rec = get("admin", "alert_recipients");
  const recipients = Array.isArray(rec) && rec.some((x) => typeof x === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x.trim()));
  if (smtpOn && recipients) return null;
  const why = [!smtpOn ? VIEW_TEXT.mailIsDisabledSmtpEnabled : null, !recipients ? VIEW_TEXT.noRecipientsSetAdminAlertRecipients : null].filter(Boolean).join(", ");
  return VIEW_TEXT.alertEmailsAreNotBeingSentValue1AlertsAppear(why);
}

export const TEST_LEVELS = ["page", "high", "medium"] as const;


export function testResultText(results: ReadonlyArray<{ level: string; status: number }>): { ok: boolean; text: string } {
  const bad = results.filter((r) => r.status !== 202);
  if (!bad.length) return { ok: true, text: VIEW_TEXT.testAlertsQueuedUrgentAndHighAlertsWillArrive };
  return { ok: false, text: VIEW_TEXT.notQueuedValue1(bad.map((r) => VIEW_TEXT.value1ResponseValue2(LEVEL_BADGES[r.level as AlertLevel]?.title ?? r.level, r.status)).join(", ")) };
}

export function digestResultText(status: number, queued: number | null, message?: string): { ok: boolean; text: string } {
  if (status === 202) return queued ? { ok: true, text: VIEW_TEXT.digestQueuedEmailsValue1(queued) } : { ok: true, text: VIEW_TEXT.nothingToIncludeNoNewMediumAlertsOrUnreviewed };
  if (status === 409) return { ok: false, text: message ?? VIEW_TEXT.alertEmailsAreNotBeingSentEnableMailAnd };
  return { ok: false, text: message ?? VIEW_TEXT.notQueuedResponseValue1(status) };
}

export { HOST_FACT_TITLES };

export function hostFactValue(v: unknown): string {
  if (v === true || v === "true") return VIEW_TEXT.yes;
  if (v === false || v === "false") return VIEW_TEXT.no;
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v.trim() || VIEW_TEXT.no2;
  return "—";
}

export function hostFactRows(facts: Record<string, unknown>): Array<{ key: string; title: string; value: string }> {
  const known = Object.keys(HOST_FACT_TITLES).filter((k) => k in facts);
  const other = Object.keys(facts).filter((k) => !(k in HOST_FACT_TITLES)).sort();
  return [...known, ...other].map((k) => ({ key: k, title: HOST_FACT_TITLES[k] ?? k, value: hostFactValue(facts[k]) }));
}


export interface QuotaRow { person_id: string; display_name: string; kind: string; days_would_refuse: number; days_refused: number }

export { QUOTA_KIND_TITLES };
export const quotaKindTitle = (k: string): string => QUOTA_KIND_TITLES[k] ?? k;
