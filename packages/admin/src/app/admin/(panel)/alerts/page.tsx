import { PAGE_TEXT } from "../../../../messages/panel-alerts";
import { rich } from "../../../../i18n/rich";
import type { Metadata } from "next";
import Link from "next/link";
import { Fragment } from "react";
import { ActionForm } from "@/components/action-form";
import { LocalTime } from "@/components/local-time";
import { PageFrame } from "@/components/page-frame";
import { CursorPager } from "@/components/pager";
import { Badge, Empty, LoadError, Notice, Section, TableWrap } from "@/components/ui";
import { guardAuditorPage } from "@/lib/admin-guard";
import { tryGw } from "@/lib/api";
import { param, type SearchParams } from "@/lib/paging";
import { readSession } from "@/lib/session";
import { ackAlertAction, digestNowAction, testAlertsAction } from "./actions";
import type { SettingsResponse } from "@/lib/types";
import { ackedBy, alertMailNotice, hostFactRows, LEVEL_BADGES, LEVEL_FILTERS, levelFilter, quotaKindTitle, repeatText, STATUS_BADGES, STATUS_FILTERS, statusFilter, subjectText, type AdminAlert, type QuotaRow, VIEW_TEXT } from "./view";

export function generateMetadata(): Metadata { return { title: PAGE_TEXT.alerts }; }

const PAGE = 50, QUOTA_PAGE = 20;

export default async function AlertsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await guardAuditorPage(true);
  const sp = await searchParams;
  const level = levelFilter(param(sp, "level"));
  const status = statusFilter(param(sp, "status"));
  const cursor = param(sp, "cursor");
  const qcursor = param(sp, "qcursor");
  const [res, session, settings, facts, quota] = await Promise.all([
    tryGw<{ items: AdminAlert[]; next_cursor: string | null }>("/api/v1/admin/alerts", {
      query: { ...(level === "all" ? {} : { level }), ...(status === "all" ? {} : { status }), ...(cursor ? { cursor } : {}), limit: String(PAGE) } }),
    readSession(),
    tryGw<SettingsResponse>("/api/v1/admin/settings"),
    tryGw<{ at: string | null; facts: Record<string, unknown> }>("/api/v1/admin/alerts/host-facts"),
    tryGw<{ days: number; items: QuotaRow[]; next_cursor: string | null }>("/api/v1/admin/edge/quota-report", {
      query: { days: "14", limit: String(QUOTA_PAGE), ...(qcursor ? { cursor: qcursor } : {}) } }),
  ]);
  const mailOff = alertMailNotice(settings.ok ? settings.data.items : null);
  const canAct = session?.role !== "security_auditor";
  const params: Record<string, string> = { ...(level === "all" ? {} : { level }), ...(status === "all" ? {} : { status }) };
  const href = (p: Record<string, string>) => { const q = new URLSearchParams(p).toString(); return q ? `/admin/alerts?${q}` : "/admin/alerts"; };
  const prev = /^\d+$/.test(cursor) ? String(Math.max(0, Number(cursor) - PAGE)) : null;
  const qprev = /^\d+$/.test(qcursor) ? String(Math.max(0, Number(qcursor) - QUOTA_PAGE)) : null;
  const factRows = facts.ok ? hostFactRows(facts.data.facts ?? {}) : [];

  return (
    <PageFrame title={PAGE_TEXT.alerts2} lead={VIEW_TEXT.alertsLead} allowAuditor>
      {mailOff ? <Notice tone="warn" role="status">{mailOff}</Notice> : null}
      <nav className="tabs" aria-label={PAGE_TEXT.alertsBySeverity}>
        {LEVEL_FILTERS.map((f) => (
          <Link key={f.value} prefetch={false} href={href({ ...(f.value === "all" ? {} : { level: f.value }), ...(status === "all" ? {} : { status }) })}
            className={f.value === level ? "on" : undefined} aria-current={f.value === level ? "page" : undefined}>{f.title}</Link>
        ))}
      </nav>
      <nav className="tabs" aria-label={PAGE_TEXT.alertsByStatus}>
        {STATUS_FILTERS.map((f) => (
          <Link key={f.value} prefetch={false} href={href({ ...(level === "all" ? {} : { level }), ...(f.value === "all" ? {} : { status: f.value }) })}
            className={f.value === status ? "on" : undefined} aria-current={f.value === status ? "page" : undefined}>{f.title}</Link>
        ))}
      </nav>
      <Section title={PAGE_TEXT.value1Value2(LEVEL_FILTERS.find((f) => f.value === level)?.title ?? PAGE_TEXT.alerts3, STATUS_FILTERS.find((f) => f.value === status)?.title.toLowerCase() ?? PAGE_TEXT.all)}>
        {!res.ok ? <LoadError result={res} what={PAGE_TEXT.alerts4} /> : !res.data.items.length ? <Empty icon="circle-check">{PAGE_TEXT.noAlerts}</Empty> : (
          <>
            <TableWrap cards>
              <table className="board">
                <thead><tr><th>{PAGE_TEXT.when}</th><th>{PAGE_TEXT.severity}</th><th>{PAGE_TEXT.whatHappened}</th><th>{PAGE_TEXT.acknowledged}</th></tr></thead>
                <tbody>
                  {res.data.items.map((a) => {
                    const b = LEVEL_BADGES[a.level] ?? LEVEL_BADGES.medium;
                    const st = a.status ? STATUS_BADGES[a.status] : null;
                    const who = ackedBy(a);
                    const again = repeatText(a);
                    const subj = subjectText(a.subject);
                    return (
                      <tr key={a.id} id={`alert-${a.id}`}>
                        <td data-label={PAGE_TEXT.when2}>
                          <LocalTime iso={a.last_at ?? a.at} />
                          {again && a.first_at ? <div className="cell-sub">{rich(PAGE_TEXT.firstSeenValue1, null, { value1: <LocalTime iso={a.first_at} relative={false} /> })}</div> : null}
                        </td>
                        <td data-label={PAGE_TEXT.severity2}>
                          <Badge tone={b.tone} title={b.hint}>{b.title}</Badge>
                          {st && a.status !== "acked" ? <div className="cell-sub"><Badge tone={st.tone}>{st.title}</Badge></div> : null}
                        </td>
                        <td data-label={PAGE_TEXT.whatHappened2}>
                          <span className="cell-main">{a.summary}</span>
                          <div className="cell-sub">{rich(PAGE_TEXT.tag1Value2Tag1Value3Value4, { tag1: (children) => <code className="code" title={PAGE_TEXT.eventCode}>{children}</code> }, { value2: a.code, value3: again ? <> · {again}</> : null, value4: subj ? <>{rich(PAGE_TEXT.tag1Value2Tag1, { tag1: (children) => <span title={PAGE_TEXT.groupingSubjectIdentifierNotAName}>{children}</span> }, { value2: subj })}</> : null })}</div>
                        </td>
                        <td data-label={PAGE_TEXT.acknowledged2}>
                          {who ? <>{who}{a.acked_at ? <div className="cell-sub"><LocalTime iso={a.acked_at} /></div> : null}</>
                            : canAct ? (
                              <ActionForm action={ackAlertAction} submitLabel={PAGE_TEXT.acknowledge} pendingLabel="…" compact quiet>
                                <input type="hidden" name="id" value={a.id} />
                              </ActionForm>
                            ) : <span className="muted">{PAGE_TEXT.pending}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
            <CursorPager path="/admin/alerts" params={{ ...params, ...(qcursor ? { qcursor } : {}) }} cursorName="cursor" cursor={cursor}
              nextCursor={res.data.next_cursor} prevCursor={prev} shown={res.data.items.length} noun={PAGE_TEXT.alerts5} />
          </>
        )}
      </Section>

      <Section title={PAGE_TEXT.deliveryTest} hint={VIEW_TEXT.testHint}>
        {canAct ? (
          <div className="row-actions">
            <ActionForm action={testAlertsAction} submitLabel={PAGE_TEXT.sendTestAlerts} pendingLabel={PAGE_TEXT.queuing} quiet>{null}</ActionForm>
            <ActionForm action={digestNowAction} submitLabel={PAGE_TEXT.prepareDigestNow} pendingLabel={PAGE_TEXT.queuing2} quiet>{null}</ActionForm>
          </div>
        ) : <p className="hint">{PAGE_TEXT.aMemoryAdministratorCanSendTestAlertsAndPrepare}</p>}
      </Section>

      <Section title={PAGE_TEXT.hostFacts} hint={VIEW_TEXT.hostFactsHint}>
        {!facts.ok ? <LoadError result={facts} what={PAGE_TEXT.hostFacts2} />
          : !facts.data.at ? <Empty icon="circle-check">{PAGE_TEXT.theHostCheckHasNotReportedAnyFactsYet}</Empty> : (
            <>
              <p className="hint">{rich(PAGE_TEXT.lastCheckValue1, null, { value1: <LocalTime iso={facts.data.at} /> })}</p>
              <dl className="kv">
                {factRows.map((f) => <Fragment key={f.key}><dt>{f.title}</dt><dd>{f.value}</dd></Fragment>)}
              </dl>
            </>
          )}
      </Section>

      <Section title={PAGE_TEXT.edgeQuotasRequestsThatWouldBeRefused} hint={VIEW_TEXT.quotaHint}>
        {!quota.ok ? <LoadError result={quota} what={PAGE_TEXT.quotaReport} /> : !quota.data.items.length ? <Empty icon="circle-check">{PAGE_TEXT.noRequestsWouldHaveBeenRefusedInTheLast}</Empty> : (
          <>
            <TableWrap cards>
              <table className="board">
                <thead><tr><th>{PAGE_TEXT.who}</th><th>{PAGE_TEXT.quota}</th><th>{PAGE_TEXT.daysWithRequestsThatWouldBeRefused}</th><th>{PAGE_TEXT.daysWithRefusedRequests}</th></tr></thead>
                <tbody>
                  {quota.data.items.map((q) => (
                    <tr key={`${q.person_id}:${q.kind}`}>
                      <td data-label={PAGE_TEXT.who2}>{q.display_name}</td>
                      <td data-label={PAGE_TEXT.quota2}>{quotaKindTitle(q.kind)}</td>
                      <td data-label={PAGE_TEXT.daysWithRequestsThatWouldBeRefused2}>{q.days_would_refuse}</td>
                      <td data-label={PAGE_TEXT.daysWithRefusedRequests2}>{q.days_refused}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <CursorPager path="/admin/alerts" params={{ ...params, ...(cursor ? { cursor } : {}) }} cursorName="qcursor" cursor={qcursor}
              nextCursor={quota.data.next_cursor} prevCursor={qprev} shown={quota.data.items.length} noun={PAGE_TEXT.rows} />
          </>
        )}
      </Section>
    </PageFrame>
  );
}
