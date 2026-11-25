import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/icons";
import { LocalTime } from "@/components/local-time";
import { CursorPager } from "@/components/pager";
import { Badge, Empty, LoadError, Notice, PageHead, Section, TableWrap } from "@/components/ui";
import { requireWorkspace } from "@/lib/me";
import { meGw } from "@/lib/me-api";
import { param, type SearchParams } from "@/lib/paging";
import { SECTION_TITLES } from "@/lib/plain";
import { PLANS_MESSAGES, PLAN_STATUS_TITLES, PLANS_EMPTY, PLANS_MORE, planCascadeShown, planCreator, planExpired, planTitle } from "@/lib/plans";
import { PREVIEW_TEXT } from "@/lib/preview";
import type { PlanSummary, PlansPage } from "@/lib/types";
import { WS_PLANS_MESSAGES } from "@/messages/ws-plans";
import { rich } from "@/i18n/rich";

export function generateMetadata(): Metadata { return { title: SECTION_TITLES.plans }; }
const LIMIT = 20;

const waiting = (p: PlanSummary): boolean => (p.status === "pending" && !planExpired(p)) || p.status === "applying";

function PlansEmpty({ status }: { status: "pending" | "all" }) {
  return (
    <div className="empty empty-rich plans-empty">
      <span className="ichip tone-gray" aria-hidden="true"><Icon name="list-checks" /></span>
      <div className="empty-body">
        <p>{rich(WS_PLANS_MESSAGES.howItWorks, null, { value1: <strong>{PLANS_EMPTY[status]}</strong> })}</p>
        <ol className="plans-steps">{PLANS_EMPTY.steps.map((s) => <li key={s}>{s}</li>)}</ol>
        <p className="muted small">{rich(WS_PLANS_MESSAGES.forExampleAskYourAgent, null, { value1: PLANS_EMPTY.example })}</p>
      </div>
    </div>
  );
}

export default async function PlansPageView({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { session } = await requireWorkspace();
  if (session.preview) return <><PageHead title={SECTION_TITLES.plans} /><Notice tone="info">{PREVIEW_TEXT.previewDeniedHint}</Notice></>;
  const sp = await searchParams, cursor = param(sp, "cursor"), status = param(sp, "status") === "all" ? "all" : "pending";
  const r = await meGw<PlansPage>(session.key, "/api/v1/me/plans", { query: { status, limit: LIMIT, cursor: cursor || undefined } });
  return <>
    <PageHead title={SECTION_TITLES.plans} lead={PLANS_MESSAGES.plansLead} />
    <details className="sp-more-info"><summary>{WS_PLANS_MESSAGES.moreDetails2}</summary>{PLANS_MORE.map((t) => <p key={t}>{t}</p>)}</details>
    <nav className="mt-types plan-filters" aria-label={WS_PLANS_MESSAGES.plansToShow}>
      <Link href="/plans" prefetch={false} className="mt-type" aria-current={status === "pending" ? "true" : undefined}>{rich(WS_PLANS_MESSAGES.awaitingDecision, null, { value1: r.ok ? <span className="mt-count">{r.data.pending}</span> : null })}</Link>
      <Link href="/plans?status=all" prefetch={false} className="mt-type" aria-current={status === "all" ? "true" : undefined}>{WS_PLANS_MESSAGES.allPlans}</Link>
    </nav>
    <Section title={status === "pending" ? WS_PLANS_MESSAGES.awaitingYourDecision : WS_PLANS_MESSAGES.planHistory} icon={status === "pending" ? "list-checks" : "history"}>
      {!r.ok ? <LoadError result={r} what={WS_PLANS_MESSAGES.changePlans} /> : !r.data.items.length ? (cursor ? <Empty>{WS_PLANS_MESSAGES.nothingMoreHere}</Empty> : <PlansEmpty status={status} />) : <>
        <TableWrap><table className="board plan-table">
          <thead><tr><th>{WS_PLANS_MESSAGES.changePlan3}</th><th>{WS_PLANS_MESSAGES.createdBy2}</th><th>{WS_PLANS_MESSAGES.status3}</th><th>{PLANS_MESSAGES.planDueTitle}</th></tr></thead>
          <tbody>{r.data.items.map((p) => <tr key={p.id}>
            <td data-label={WS_PLANS_MESSAGES.changePlan4}><Link href={`/plans/${p.id}`} prefetch={false}><strong>{planTitle(p)}</strong></Link>
              <div className="muted small">{rich(WS_PLANS_MESSAGES.spaces, null, { value1: planCascadeShown(p.op) && p.totals.cascade ? WS_PLANS_MESSAGES.includingDerivedRecords2(p.totals.cascade) : "", value2: p.totals.spaces })}</div></td>
            <td data-label={WS_PLANS_MESSAGES.createdBy3}>{planCreator(p)}<div className="muted small"><LocalTime iso={p.created_at} short /></div></td>
            <td data-label={WS_PLANS_MESSAGES.status4}><Badge tone={planExpired(p) || p.status === "partially_applied" ? "warn" : p.status === "applied" ? "ok" : "neutral"}>{PLAN_STATUS_TITLES[planExpired(p) ? "expired" : p.status]}</Badge>
              {p.status === "applying" ? <div className="small">{rich(WS_PLANS_MESSAGES.recordsRemaining, null, { value1: p.counts.pending })}</div> : null}</td>
            <td data-label={PLANS_MESSAGES.planDueTitle}>{waiting(p) ? <LocalTime iso={p.expires_at} short /> : <span className="muted">—</span>}</td>
          </tr>)}</tbody>
        </table></TableWrap>
        <CursorPager path="/plans" params={{ status }} cursorName="cursor" cursor={cursor} nextCursor={r.data.next_cursor} shown={r.data.items.length} />
      </>}
    </Section>
  </>;
}
