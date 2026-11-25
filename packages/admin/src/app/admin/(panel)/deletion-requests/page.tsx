import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { LocalTime } from "@/components/local-time";
import { PageFrame } from "@/components/page-frame";
import { CursorPager } from "@/components/pager";
import { Badge, Empty, LoadError, Section, TableWrap } from "@/components/ui";
import { guardAuditorPage } from "@/lib/admin-guard";
import { tryGw } from "@/lib/api";
import { DELETION_REQUESTS_MESSAGES, deletionReasonTitle, type AdminDeletionMeeting, type AdminDeletionRequests } from "@/lib/deletion-requests";
import { offsetOf, PAGE_SIZE, param, type SearchParams } from "@/lib/paging";
import { formatCount } from "@/lib/plain";
import { adminDeleteMeetingAction, adminKeepMeetingAction } from "./actions";
import { PANEL_DELETION_REQUESTS_MESSAGES } from "@/messages/panel-deletion-requests";
import { rich } from "@/i18n/rich";

export function generateMetadata(): Metadata { return { title: PANEL_DELETION_REQUESTS_MESSAGES.deletionRequests }; }

function durationText(sec: number | null): string | null {
  if (!sec || sec <= 0) return null;
  const m = Math.round(sec / 60), h = Math.floor(m / 60);
  return h ? PANEL_DELETION_REQUESTS_MESSAGES.h(h, String(m % 60).padStart(2, "0")) : PANEL_DELETION_REQUESTS_MESSAGES.min(Math.max(1, m));
}

const person = (p: { login: string; display_name: string | null }) => (
  <Link href={`/admin/people/${encodeURIComponent(p.login)}`} prefetch={false} title={p.login}>{p.display_name || p.login}</Link>
);

function StateBadge({ m }: { m: AdminDeletionMeeting }) {
  if (m.status === "kept") return <Badge tone="muted">{rich(PANEL_DELETION_REQUESTS_MESSAGES.keptByAdministrator, null, { value1: m.kept ? <> · <LocalTime iso={m.kept.at} /></> : null })}</Badge>;
  if (m.status === "declined") return <Badge tone="warn">{PANEL_DELETION_REQUESTS_MESSAGES.ownerKeptItYourDecision}</Badge>;
  return <Badge tone="neutral">{PANEL_DELETION_REQUESTS_MESSAGES.awaitingDecision}</Badge>;
}

export default async function DeletionRequestsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await guardAuditorPage();
  const sp = await searchParams;
  const cursor = param(sp, "cursor"), offset = offsetOf(cursor);
  const res = await tryGw<AdminDeletionRequests>("/api/v1/admin/deletion-requests", { query: { limit: PAGE_SIZE, cursor: cursor || undefined } });
  const items = res.ok ? res.data.items : [];
  const title = res.ok
    ? [PANEL_DELETION_REQUESTS_MESSAGES.awaitingDecision2(formatCount(res.data.open)), res.data.declined ? PANEL_DELETION_REQUESTS_MESSAGES.keptByOwner(formatCount(res.data.declined)) : null,
      res.data.kept ? PANEL_DELETION_REQUESTS_MESSAGES.keptByYou(formatCount(res.data.kept)) : null].filter(Boolean).join(" · ")
    : PANEL_DELETION_REQUESTS_MESSAGES.requests;
  return (
    <PageFrame title={PANEL_DELETION_REQUESTS_MESSAGES.deletionRequests2} lead={PANEL_DELETION_REQUESTS_MESSAGES.meetingParticipantsAskToDelete}>
      <Section title={title} icon="file-x">
        {!res.ok ? <LoadError result={res} what={PANEL_DELETION_REQUESTS_MESSAGES.deletionRequests3} /> : !items.length ? <Empty icon="circle-check">{PANEL_DELETION_REQUESTS_MESSAGES.noRequests}</Empty> : (
          <>
            <TableWrap cards>
              <table className="board deletion-board">
                <thead><tr><th>{PANEL_DELETION_REQUESTS_MESSAGES.meeting}</th><th>{PANEL_DELETION_REQUESTS_MESSAGES.statusAndDecision}</th><th>{PANEL_DELETION_REQUESTS_MESSAGES.requestedBy}</th><th>{PANEL_DELETION_REQUESTS_MESSAGES.owner}</th></tr></thead>
                <tbody>
                  {items.map((m) => {
                    const facts = [durationText(m.duration_sec), m.participants ? PANEL_DELETION_REQUESTS_MESSAGES.participants(formatCount(m.participants)) : null].filter(Boolean).join(" · ");
                    const asks = m.requests.filter((q) => q.status !== "kept");
                    const n = (asks.length ? asks : m.requests).length;
                    return (
                      <tr key={m.record_id}>
                        <td data-label={PANEL_DELETION_REQUESTS_MESSAGES.meeting2}>
                          <span className="cell-main">{m.occurred_at ? <LocalTime iso={m.occurred_at} /> : PANEL_DELETION_REQUESTS_MESSAGES.dateNotRecorded}</span>
                          {m.class === "closed" ? <> <Badge tone="warn" title={PANEL_DELETION_REQUESTS_MESSAGES.closedPeopleOnlyAiAgents}>{PANEL_DELETION_REQUESTS_MESSAGES.closed}</Badge></> : null}
                          {facts ? <div className="cell-sub">{facts}</div> : null}
                          <div className="cell-sub">
                            {m.space ? <Link href={`/admin/spaces/${encodeURIComponent(m.space.slug)}`} prefetch={false}>{m.space.name}</Link> : PANEL_DELETION_REQUESTS_MESSAGES.spaceNotFound}
                            {" · "}<span className="muted" title={PANEL_DELETION_REQUESTS_MESSAGES.meetingId(m.record_id)}>№ {m.record_id.slice(0, 8)}</span>
                            {" · "}<Link href={`/admin/audit?record=${encodeURIComponent(m.record_id)}#events`} prefetch={false}>{PANEL_DELETION_REQUESTS_MESSAGES.eventsInTheAuditLog}</Link>
                          </div>
                        </td>
                        <td data-label={PANEL_DELETION_REQUESTS_MESSAGES.statusAndDecision2}>
                          <StateBadge m={m} />
                          {m.status === "kept" ? (m.kept?.by ? <div className="cell-sub">{rich(PANEL_DELETION_REQUESTS_MESSAGES.keptBy, null, { value1: m.kept.by })}</div> : null) : (
                            <div className="row-actions">
                              <ActionForm action={adminKeepMeetingAction} submitLabel={PANEL_DELETION_REQUESTS_MESSAGES.keepMeeting} pendingLabel="…" compact confirm={DELETION_REQUESTS_MESSAGES.adminKeepConfirm}>
                                <input type="hidden" name="request" value={m.requests[0]?.id ?? ""} />
                              </ActionForm>
                              <ActionForm action={adminDeleteMeetingAction} submitLabel={PANEL_DELETION_REQUESTS_MESSAGES.deleteMeeting} pendingLabel="…" compact danger confirm={DELETION_REQUESTS_MESSAGES.adminDeleteConfirm}>
                                <input type="hidden" name="request" value={m.requests[0]?.id ?? ""} />
                              </ActionForm>
                            </div>
                          )}
                        </td>
                        <td data-label={PANEL_DELETION_REQUESTS_MESSAGES.requestedBy2}>
                          <div>{PANEL_DELETION_REQUESTS_MESSAGES.requesterCount(n)}</div>
                          {m.requests.map((q) => (
                            <div key={q.id} className="cell-sub">
                              {person(q.requester)} · <LocalTime iso={q.created_at} />
                              {deletionReasonTitle(q.reason) ? <> · {deletionReasonTitle(q.reason)}</> : null}
                              {q.status === "declined" ? PANEL_DELETION_REQUESTS_MESSAGES.keptByOwner2 : null}
                            </div>
                          ))}
                        </td>
                        <td data-label={PANEL_DELETION_REQUESTS_MESSAGES.owner2}>{person(m.owner)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableWrap>
            <CursorPager path="/admin/deletion-requests" params={{ cursor }} cursorName="cursor" cursor={cursor} nextCursor={res.data.next_cursor}
              prevCursor={offset ? String(Math.max(0, offset - PAGE_SIZE)) : null} shown={items.length} />
          </>
        )}
      </Section>
    </PageFrame>
  );
}
