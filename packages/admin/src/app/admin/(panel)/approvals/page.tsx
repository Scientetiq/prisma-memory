import { PAGE_TEXT } from "../../../../messages/panel-approvals";
import { rich } from "../../../../i18n/rich";
import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { LocalTime } from "@/components/local-time";
import { PageFrame } from "@/components/page-frame";
import { LocalPager } from "@/components/pager";
import { Badge, Empty, LoadError, Section, TableWrap } from "@/components/ui";
import { guardAuditorPage } from "@/lib/admin-guard";
import { tryGw } from "@/lib/api";
import { param, slicePage, type SearchParams } from "@/lib/paging";
import { readSession } from "@/lib/session";
import { approveAction, cancelAction, executeAction, rejectAction } from "./actions";
import { approvalButtons, STATE_BADGES, STATE_FILTERS, stateFilter, type ApprovalSummary } from "./view";

export function generateMetadata(): Metadata { return { title: PAGE_TEXT.secondSignatures }; }


export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await guardAuditorPage(true);
  const sp = await searchParams;
  const state = stateFilter(param(sp, "state"));
  const focus = param(sp, "id");
  const [res, one, session] = await Promise.all([
    tryGw<{ items: ApprovalSummary[] }>("/api/v1/admin/approvals", { query: state === "all" ? {} : { state } }),
    /^[0-9a-f-]{36}$/i.test(focus) ? tryGw<ApprovalSummary>(`/api/v1/admin/approvals/${focus}`) : Promise.resolve(null),
    readSession(),
  ]);
  const me = { login: session?.login ?? null, role: session?.role ?? null };
  const page = slicePage(res.ok ? res.data.items : [], param(sp, "page"));
  const params: Record<string, string> = state === "pending" ? {} : { state };

  const row = (a: ApprovalSummary, hl = false) => {
    const b = STATE_BADGES[a.state];
    const buttons = approvalButtons(a, me);
    return (
      <tr key={a.id} className={hl ? "hl" : undefined} id={`approval-${a.id}`}>
        <td data-label={PAGE_TEXT.request}>
          <span className="cell-main">{a.summary}</span>
          <div className="cell-sub">{rich(PAGE_TEXT.tag1Value2Tag1Tag3NoValue4Tag3, { tag1: (children) => <code className="code" title={PAGE_TEXT.actionAdminAPIRoute}>{children}</code>, tag3: (children) => <span className="muted" title={a.id}>{children}</span> }, { value2: a.action, value4: a.id.slice(0, 8) })}</div>
        </td>
        <td data-label={PAGE_TEXT.status}><Badge tone={b.tone}>{b.title}</Badge>
          {a.decided_by ? <div className="cell-sub">{a.state === "rejected" ? PAGE_TEXT.rejectedBy : PAGE_TEXT.signedBy} {a.decided_by}{a.decided_at ? <> · <LocalTime iso={a.decided_at} /></> : null}</div> : null}
          {a.executed_at ? <div className="cell-sub">{rich(PAGE_TEXT.executedValue1, null, { value1: <LocalTime iso={a.executed_at} /> })}</div> : null}
        </td>
        <td data-label={PAGE_TEXT.requestedBy}>{a.requested_by ?? "—"}<div className="cell-sub"><LocalTime iso={a.requested_at} /></div></td>
        <td data-label={PAGE_TEXT.expiry}>{a.state === "pending" || a.state === "approved" ? <LocalTime iso={a.expires_at} /> : "—"}</td>
        <td data-label={PAGE_TEXT.actions}>
          <div className="row-actions">
            {buttons.includes("approve") ? (
              <ActionForm action={approveAction} submitLabel={PAGE_TEXT.sign} pendingLabel="…" compact
                confirm={{ question: PAGE_TEXT.signThisRequest, change: PAGE_TEXT.value1SigningAllowsTheRequesterToExecuteTheAction(a.summary), verb: PAGE_TEXT.sign2 }}>
                <input type="hidden" name="id" value={a.id} />
              </ActionForm>) : null}
            {buttons.includes("reject") ? (
              <ActionForm action={rejectAction} submitLabel={PAGE_TEXT.reject} pendingLabel="…" compact danger>
                <input type="hidden" name="id" value={a.id} />
              </ActionForm>) : null}
            {buttons.includes("execute") ? (
              <ActionForm action={executeAction} submitLabel={PAGE_TEXT.execute} pendingLabel="…" compact
                confirm={{ question: PAGE_TEXT.executeTheSignedRequest, change: a.summary, verb: PAGE_TEXT.execute2 }}>
                <input type="hidden" name="id" value={a.id} />
              </ActionForm>) : null}
            {buttons.includes("cancel") ? (
              <ActionForm action={cancelAction} submitLabel={PAGE_TEXT.cancel} pendingLabel="…" compact quiet>
                <input type="hidden" name="id" value={a.id} />
              </ActionForm>) : null}
            {!buttons.length ? <span className="muted">—</span> : null}
          </div>
        </td>
      </tr>
    );
  };
  const head = <thead><tr><th>{PAGE_TEXT.request2}</th><th>{PAGE_TEXT.status2}</th><th>{PAGE_TEXT.requestedBy2}</th><th>{PAGE_TEXT.signBy}</th><th>{PAGE_TEXT.actions2}</th></tr></thead>;

  return (
    <PageFrame title={PAGE_TEXT.secondSignatures2} lead={PAGE_TEXT.lead} allowAuditor>
      {one ? (
        <Section title={PAGE_TEXT.linkedRequest} icon="shield">
          {one.ok ? <TableWrap cards><table className="board">{head}<tbody>{row(one.data, true)}</tbody></table></TableWrap>
            : <LoadError result={one} what={PAGE_TEXT.request3} retry={false} />}
        </Section>
      ) : null}
      <nav className="tabs" aria-label={PAGE_TEXT.requestsByStatus}>
        {STATE_FILTERS.map((f) => (
          <Link key={f.value} prefetch={false} href={f.value === "pending" ? "/admin/approvals" : `/admin/approvals?state=${f.value}`}
            className={f.value === state ? "on" : undefined} aria-current={f.value === state ? "page" : undefined}>{f.title}</Link>
        ))}
      </nav>
      <Section title={STATE_FILTERS.find((f) => f.value === state)?.title ?? PAGE_TEXT.requests}>
        {!res.ok ? <LoadError result={res} what={PAGE_TEXT.requests2} /> : !page.items.length ? <Empty icon="circle-check">{PAGE_TEXT.noRequests}</Empty> : (
          <>
            <TableWrap cards><table className="board">{head}<tbody>{page.items.map((a) => row(a, a.id === focus))}</tbody></table></TableWrap>
            <LocalPager path="/admin/approvals" params={params} pageName="page" page={page} />
          </>
        )}
      </Section>
    </PageFrame>
  );
}
