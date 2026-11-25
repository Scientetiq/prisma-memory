import { rich } from "@/i18n/rich";
import { texts as M } from "@/messages/ws-review";
import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Icon } from "@/components/icons";
import { LocalTime } from "@/components/local-time";
import { CursorPager } from "@/components/pager";
import { RowMenu } from "@/components/row-menu";
import { Badge, Empty, Notice, PageHead, Section, TableWrap } from "@/components/ui";
import { VisibilityBadge } from "@/components/visibility-badge";
import { recordKind } from "@/lib/home";
import { requireWorkspace } from "@/lib/me";
import { meGw } from "@/lib/me-api";
import { ORG_REVIEW_TEXT, ORG_DONE, ORG_PARTIAL, REVIEW_FOR_EMPLOYEE, REVIEW_MORE, deleteConfirm, fromText, isOrgOp, isOrgPartial, itemBadges, itemDue, queueTail, returnConfirm, ORG_REVIEW_MESSAGES } from "@/lib/org-review";
import { param, type SearchParams } from "@/lib/paging";
import { PREVIEW_TEXT } from "@/lib/preview";
import type { OrgReviewItem, OrgReviewQueue } from "@/lib/types";
import { orgReviewAction } from "./actions";

export function generateMetadata(): Metadata { return { title: ORG_REVIEW_MESSAGES.reviewTitle }; }

function Decide({ it, back }: { it: OrgReviewItem; back: string }) {
  if (it.restricted) return <p className="muted small">{ORG_REVIEW_MESSAGES.youCannotSeeThisRecordACurator}</p>;
  const form = (op: "confirm" | "return" | "delete", label: string, confirm: string, look: { danger?: boolean; quiet?: boolean } = {}) => (
    <ActionForm key={op} action={orgReviewAction} submitLabel={label} pendingLabel="…" compact quiet={look.quiet} danger={look.danger} confirm={confirm}>
      <input type="hidden" name="id" value={it.id} />
      <input type="hidden" name="op" value={op} />
      <input type="hidden" name="back" value={back} />
    </ActionForm>
  );
  return (
    <div className="corr-acts">
      {form("confirm", M.confirm, ORG_REVIEW_TEXT.confirmReview)}
      {it.no_target ? null : form("return", ORG_REVIEW_MESSAGES.return, returnConfirm(it.from), { quiet: true })}
      <RowMenu>{form("delete", M.delete, deleteConfirm(it.from), { danger: true })}</RowMenu>
    </div>
  );
}

function ForEmployee() {
  const t = REVIEW_FOR_EMPLOYEE;
  return (
    <div className="review-employee">
      <p><strong>{t.title}.</strong> {t.what}</p>
      <p>{t.you}</p>
      <p className="muted">{t.who}</p>
      <p><Link href={t.href} prefetch={false} className="btn"><Icon name="globe" />{t.open}</Link></p>
    </div>
  );
}

const tailOf = (q: OrgReviewQueue, c: string): string | null => queueTail((/^\d{1,6}$/.test(c) ? Number(c) : 0) + q.items.length, q.total);

export default async function ReviewPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { session } = await requireWorkspace();
  if (session.preview) return <><PageHead title={ORG_REVIEW_MESSAGES.reviewTitle} /><Notice tone="info">{PREVIEW_TEXT.previewDeniedHint}</Notice></>;
  const sp = await searchParams, c = param(sp, "c"), done = param(sp, "org");
  const r = await meGw<OrgReviewQueue>(session.key, "/api/v1/me/org-review", { query: { cursor: c || undefined } });
  const back = c && /^\d{1,6}$/.test(c) ? `/review?c=${c}` : "/review";
  if (!r.ok && r.status === 404) return <><PageHead title={ORG_REVIEW_MESSAGES.reviewTitle} /><ForEmployee /></>;
  return (
    <>
      <PageHead title={ORG_REVIEW_MESSAGES.reviewTitle} lead={ORG_REVIEW_MESSAGES.confirmUsefulRecordsAndReturnTheRest} />
      <details className="sp-more-info"><summary>{M.moreDetails}</summary>{REVIEW_MORE.map((t) => <p key={t}>{t}</p>)}</details>
      {isOrgOp(done) && ["confirm", "return", "delete"].includes(done) ? <Notice tone="ok">{ORG_DONE[done]}</Notice> : null}
      {isOrgPartial(done) ? <Notice tone="warn">{ORG_PARTIAL[done]}</Notice> : null}
      {!r.ok ? <Notice tone="warn">{r.message}</Notice> : (
        <Section title={M.awaitingADecision(r.data.total)} id="queue"
          hint={r.data.held ? M.hiddenFromAgentsUntilYouDecideThese(r.data.held) : r.data.oldest_entered_at ? <>{rich(M.oldestRecordArrivedOnLine, { tag1: () => <LocalTime iso={r.data.oldest_entered_at} short /> })}</> : undefined}>
          {!r.data.items.length ? (c ? <Empty>{M.nothingFurther}</Empty> : <Empty icon="badge-check">{ORG_REVIEW_MESSAGES.nothingToReview}</Empty>) : (
            <>
              <TableWrap>
                <table className="board corr-table">
                  <thead><tr><th>{M.record}</th><th>{M.author}</th><th>{M.whereFromAndWhen}</th><th>{M.marks}</th><th>{M.decision}</th></tr></thead>
                  <tbody>{r.data.items.map((it) => (
                    <tr key={it.id}>
                      <td data-label={M.record2}>
                        {it.restricted ? <span className="muted">{ORG_REVIEW_MESSAGES.readershipRestrictedTitleHidden}</span>
                          : <Link href={`/records/${it.id}`} prefetch={false}>{it.title || M.untitled}</Link>}
                        <div className="muted small">{recordKind(it.type, it.restricted ? null : it.event_kind)}{it.class === "closed" ? <> · <VisibilityBadge cls="closed" /></> : null}</div>
                      </td>
                      <td data-label={M.author2}>{it.author.name || it.author.login}{it.author.active ? null : <div className="muted small">{M.leftTheCompany}</div>}</td>
                      <td data-label={M.whereFromAndWhen2}>{fromText(it.from)}<div className="muted small">{rich(M.arrivedOnLine, { tag1: () => <LocalTime iso={it.entered_at} short /> }, { value1: itemDue(it) })}</div></td>
                      <td data-label={M.marks2}><div className="chips">{itemBadges(it).map((b, i) => <Badge key={i} tone={b.tone} title={b.title}>{b.text}</Badge>)}</div></td>
                      <td data-label={M.decision2}><Decide it={it} back={back} /></td>
                    </tr>
                  ))}</tbody>
                </table>
              </TableWrap>
              {tailOf(r.data, c) ? <p className="hint">{tailOf(r.data, c)}</p> : null}
              <CursorPager path="/review" params={{}} cursorName="c" cursor={c} nextCursor={r.data.next_cursor} shown={r.data.items.length} anchor="queue" />
            </>
          )}
        </Section>
      )}
    </>
  );
}
