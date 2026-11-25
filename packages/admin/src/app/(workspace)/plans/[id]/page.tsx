import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { LocalTime } from "@/components/local-time";
import { CursorPager } from "@/components/pager";
import { Badge, Empty, LoadError, Notice, PageHead, Section, TableWrap } from "@/components/ui";
import { VisibilityBadge } from "@/components/visibility-badge";
import { AGENT_VIEW_HREF, readersLine, records } from "@/lib/agent-view";
import { avText } from "@/lib/agent-view.messages";
import { isId } from "@/lib/form";
import { recordKind } from "@/lib/home";
import { requireWorkspace } from "@/lib/me";
import { meGw } from "@/lib/me-api";
import { param, type SearchParams } from "@/lib/paging";
import { SECTION_TITLES } from "@/lib/plain";
import { PLANS_MESSAGES, PLAN_GONE, PLAN_ITEM_BUTTONS, PLAN_ITEM_CORRECTION, PLAN_STATUS_TITLES, planApplyHintReason, planCascadeShown, planConfirmationNotice, planCount, planCreator, planExpired, planItemBadge, planPageSize, planReasonTitle, planTitle } from "@/lib/plans";
import { PREVIEW_TEXT } from "@/lib/preview";
import type { PlanDetail, PlanItem } from "@/lib/types";
import { planCancelAction, planItemAction } from "../actions";
import { PlanApplyForm } from "../apply-form";
import { WS_PLANS_MESSAGES } from "@/messages/ws-plans";
import { rich } from "@/i18n/rich";

export function generateMetadata(): Metadata { return { title: PLANS_MESSAGES.planPageTitle }; }

const allPlans = () => <Link href="/plans" className="btn" prefetch={false}>{PLAN_GONE.back}</Link>;

function PlanGone() {
  return <>
    <PageHead title={PLAN_GONE.title} />
    <div className="plan-gone">
      <p>{PLAN_GONE.text}</p>
      {allPlans()}
    </div>
  </>;
}

const placeOf = (item: PlanItem): string => item.space_kind === "personal" ? WS_PLANS_MESSAGES.personal : item.space_name || item.space || "—";

export default async function PlanPageView({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const { session } = await requireWorkspace();
  if (session.preview) return <><PageHead title={SECTION_TITLES.plans} /><Notice tone="info">{PREVIEW_TEXT.previewDeniedHint}</Notice></>;
  const { id } = await params, sp = await searchParams, cursor = param(sp, "cursor");
  const limit = planPageSize(param(sp, "limit"));
  if (!isId(id)) return <PlanGone />;
  const r = await meGw<PlanDetail>(session.key, `/api/v1/me/plans/${id}`, { query: { limit, cursor: cursor || undefined } });
  if (!r.ok && r.code === "not_found") return <PlanGone />;
  if (!r.ok) return <><PageHead title={WS_PLANS_MESSAGES.changePlan} actions={allPlans()} /><LoadError result={r} what={WS_PLANS_MESSAGES.changePlan2} /></>;
  const p = r.data, expired = planExpired(p), editable = p.status === "pending" && !expired;
  const bulk = p.op === "correct_bulk", applyReason = planApplyHintReason(p);
  const applying = p.status === "applying", finished = p.status === "applied" || p.status === "partially_applied";
  const lead = finished ? WS_PLANS_MESSAGES.thisPlanIsCompleteThe
    : WS_PLANS_MESSAGES.onlyThisSavedListWill;
  return <>
    <PageHead title={planTitle(p)} lead={lead} actions={allPlans()} />
    {finished ? null : (
      <details className="sp-more-info"><summary>{WS_PLANS_MESSAGES.moreDetails}</summary>
        <p>{rich(WS_PLANS_MESSAGES.newMatchingRecordsWillNot, null, { value1: PLAN_ITEM_BUTTONS.exclude, value2: PLAN_ITEM_BUTTONS.include })}</p>
      </details>
    )}
    <div className="plan-meta"><Badge tone={expired || p.status === "partially_applied" ? "warn" : finished ? "ok" : "info"}>{PLAN_STATUS_TITLES[expired ? "expired" : p.status]}</Badge>
      <span>{rich(WS_PLANS_MESSAGES.createdBy, null, { value1: planCreator(p) })}</span><span><LocalTime iso={p.created_at} short /></span>
      {editable ? <span>{PLANS_MESSAGES.planDueTitle}: <LocalTime iso={p.expires_at} short /></span> : null}</div>
    {expired ? <Notice tone="warn">{rich(WS_PLANS_MESSAGES.thisPlanExpiredNoChanges, null, { value1: p.op === "open" ? <Link href={AGENT_VIEW_HREF} prefetch={false}>{avText("plan_expired")}</Link> : bulk ? WS_PLANS_MESSAGES.createItAgainOnThe : WS_PLANS_MESSAGES.askYourAgentToCreate })}</Notice> : null}
    {applying ? <Notice tone="info">{rich(WS_PLANS_MESSAGES.changesStartedRecordsRemainingCompleted, null, { value1: p.started_at ? <>: <LocalTime iso={p.started_at} short /></> : null, value2: p.counts.pending })}</Notice> : null}
    {p.status === "cancelled" ? <Notice tone="info">{p.op === "open" && p.counts.done > 0 ? avText("plan_stopped", { records: records(p.counts.done) })
      : WS_PLANS_MESSAGES.thisPlanWasCancelledIt}</Notice> : null}
    {p.apply_via === "workplace" && editable ? <p className="hint">{rich(WS_PLANS_MESSAGES.onlyYouCanApplyThis, null, { value1: applyReason ? `: ${applyReason.charAt(0).toLowerCase()}${applyReason.slice(1)}` : "" })}</p> : null}
    {bulk && editable ? <Notice tone="info">{PLANS_MESSAGES.planCorrectProposeNotice}</Notice> : null}
    {editable && planConfirmationNotice(p) ? <Notice tone="info">{planConfirmationNotice(p)}</Notice> : null}
    {/* op open: who will be able to read the records and what the check does not see */}
    {p.op === "open" && !finished && p.status !== "cancelled" && !expired ? <Section title={avText("plan_readers_title")}>
      {p.open_preview?.spaces.length ? <ul className="plain">{p.open_preview.spaces.map((s) => <li key={s.slug}>{readersLine(s)}</li>)}</ul> : null}
      <p><strong>{avText("plan_unchecked")}</strong></p>
      {editable ? <p className="hint">{avText("plan_keep_hidden", { button: PLAN_ITEM_BUTTONS.exclude })}</p> : null}
    </Section> : null}
    {finished ? <Notice tone={p.counts.skipped ? "warn" : "ok"}>{rich(WS_PLANS_MESSAGES.theReasonForEachRecord, null, { value1: <strong>{rich(WS_PLANS_MESSAGES.doneAppliedSkippedLeftUntouched, null, { value1: p.counts.done, value2: p.counts.skipped, value3: p.counts.excluded, value4: p.counts.proposed > 0 ? WS_PLANS_MESSAGES.sentForConfirmation(p.counts.proposed) : "" })}</strong>, value2: p.op === "delete" && p.counts.done ? <>{rich(WS_PLANS_MESSAGES.deletedRecordsAreIn, null, { value1: <Link href="/trash">{WS_PLANS_MESSAGES.trash}</Link> })}</> : null })}</Notice> : null}
    <Section title={WS_PLANS_MESSAGES.exactList} hint={WS_PLANS_MESSAGES.total(planCount(p.op, p.totals.items), planCascadeShown(p.op) && p.totals.cascade ? WS_PLANS_MESSAGES.includingDerivedRecords(p.totals.cascade) : "", p.totals.spaces)}>
      {!p.items.length ? <Empty>{WS_PLANS_MESSAGES.thereAreNoRecordsOn}</Empty> : <TableWrap><table className="board plan-table plan-items">
        <thead><tr><th>{WS_PLANS_MESSAGES.record}</th><th>{WS_PLANS_MESSAGES.space}</th><th>{finished ? WS_PLANS_MESSAGES.result : WS_PLANS_MESSAGES.whatWillHappen}</th><th>{WS_PLANS_MESSAGES.status}</th>{editable ? <th><span className="vis-hidden">{WS_PLANS_MESSAGES.action}</span></th> : null}</tr></thead>
        <tbody>{p.items.map((item) => <tr key={item.id} className={item.status === "excluded" ? "off" : undefined}>
          <td data-label={WS_PLANS_MESSAGES.record2}>{item.unavailable ? <span className="muted">{item.status === "pending" ? WS_PLANS_MESSAGES.recordUnavailableItWillBe : WS_PLANS_MESSAGES.recordUnavailable}</span> : p.op === "purge" ? <strong>{item.title || WS_PLANS_MESSAGES.untitled}</strong> : <Link href={`/records/${item.id}`} prefetch={false}>{item.title || WS_PLANS_MESSAGES.untitled2}</Link>}
            {!item.unavailable ? <div className="muted small">{item.type ? recordKind(item.type, item.event_kind) : WS_PLANS_MESSAGES.record3} · <VisibilityBadge cls={item.class} /></div> : null}</td>
          <td data-label={WS_PLANS_MESSAGES.space2}>{item.unavailable ? "—" : placeOf(item)}</td>
          <td data-label={finished ? WS_PLANS_MESSAGES.result2 : WS_PLANS_MESSAGES.whatWillHappen2}>{item.unavailable ? {
            pending: WS_PLANS_MESSAGES.recordWillBeSkipped, excluded: WS_PLANS_MESSAGES.removedFromList, skipped: WS_PLANS_MESSAGES.recordSkipped,
            done: item.correction_status ? WS_PLANS_MESSAGES.actionCompleted(PLAN_ITEM_CORRECTION[item.correction_status]) : WS_PLANS_MESSAGES.actionCompleted2,
          }[item.status] : item.effect}</td>
          <td data-label={WS_PLANS_MESSAGES.status2}><Badge tone={item.status === "done" ? (item.correction_status === "proposed" ? "info" : "ok") : item.status === "skipped" ? "warn" : "neutral"}>{planItemBadge(item)}</Badge>
            {item.reason ? <div className="small">{planReasonTitle(p.op, item.reason)}</div> : null}</td>
          {editable ? <td className="plan-act" data-label="">{item.status === "pending" || item.status === "excluded" ? <ActionForm action={planItemAction} submitLabel={item.status === "excluded" ? PLAN_ITEM_BUTTONS.include : PLAN_ITEM_BUTTONS.exclude} pendingLabel="…" compact quiet>
            <input type="hidden" name="id" value={id} /><input type="hidden" name="record_id" value={item.id} /><input type="hidden" name="op" value={item.status === "excluded" ? "include" : "exclude"} />
          </ActionForm> : "—"}</td> : null}
        </tr>)}</tbody>
      </table></TableWrap>}
      <CursorPager path={`/plans/${id}`} params={limit === 20 ? {} : { limit: String(limit) }} cursorName="cursor" cursor={cursor} nextCursor={p.next_cursor} shown={p.items.length} />
    </Section>
    {editable || applying ? <Section title={applying ? WS_PLANS_MESSAGES.continueApplyingChanges : WS_PLANS_MESSAGES.yourDecision} hint={WS_PLANS_MESSAGES.theButtonAppliesAllRemaining}>
      <PlanApplyForm id={id} op={p.op} count={p.counts.pending} continuing={applying} target={p.target ?? null} />
      {editable ? <ActionForm action={planCancelAction} submitLabel={WS_PLANS_MESSAGES.cancelPlan} compact quiet><input type="hidden" name="id" value={id} /></ActionForm> : null}
      {/* a started open plan may be stopped (the gateway's cancelPlan): what is shown stays shown, the rest stays hidden */}
      {applying && p.op === "open" ? <ActionForm action={planCancelAction} submitLabel={avText("plan_stop")} compact quiet><input type="hidden" name="id" value={id} /></ActionForm> : null}
    </Section> : null}
  </>;
}
