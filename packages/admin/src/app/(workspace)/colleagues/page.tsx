import { rich } from "@/i18n/rich";
import { texts as M } from "@/messages/ws-colleagues";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { FindRow } from "@/components/find-field";
import { Icon } from "@/components/icons";
import { Empty, Notice, PageHead } from "@/components/ui";
import { callTool, toolErrorMessage, type McpFail } from "@/lib/mcp";
import { requireWorkspace } from "@/lib/me";
import { param, type SearchParams } from "@/lib/paging";
import { PROFILE_PLAIN } from "@/lib/plain";
import { personSelectionHref } from "@/lib/selection";
import { isRecordId, peopleBackHref, peopleListPage, peopleMore, peopleNotFound, peopleQuery, peopleRows, peopleSearchArgs, personRecordsHref, type PersonRow, COLLEAGUES_MESSAGES } from "@/lib/colleagues";
import type { ListResult, ReadResult, SearchResult } from "@/lib/types";

export function generateMetadata(): Metadata { return { title: COLLEAGUES_MESSAGES.colleagues }; }

export default async function PeoplePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { session, me } = await requireWorkspace();
  const sp = await searchParams;
  const q = peopleQuery(param(sp, "q"));
  const card = param(sp, "card");
  if (isRecordId(card)) {
    const r = await callTool<ReadResult>(session.key, "memory_read", { id: card, max_tokens: 1000 });
    const m = r.ok ? (r.data as ReadResult & { hidden?: boolean }).metadata : null;
    redirect(m?.type === "profile" && m.owner ? personSelectionHref(m.owner, peopleBackHref(q)) : `/records/${card}`);
  }
  const org = me.spaces.find((s) => s.kind === "org") ?? null;
  const cursor = param(sp, "cursor");
  let rows: PersonRow[] = [], failed: McpFail | null = null, more: string | null = null, next: string | null = null;
  if (org && q) {
    const res = await callTool<SearchResult>(session.key, "memory_search", peopleSearchArgs(org.slug, q));
    if (!res.ok) failed = res;
    else {
      rows = peopleRows(res.data.hits, "fallback");
      if (res.data.total_estimate > res.data.hits.length) more = peopleMore(rows.length);
    }
  } else if (org) {
    ({ rows, next, failed } = await peopleListPage(org.slug, cursor, (args) => callTool<ListResult>(session.key, "memory_list", args)));
  }

  return (
    <>
      <PageHead title={COLLEAGUES_MESSAGES.colleagues} lead={COLLEAGUES_MESSAGES.findAColleagueByNameOrDepartment} />
      {!org ? <Empty icon="users">{COLLEAGUES_MESSAGES.theColleagueDirectoryIsUnavailableToYou}</Empty> : (
        <>
          <form method="get" action="/colleagues" className="search-form" role="search">
            <FindRow className="find-page" label={COLLEAGUES_MESSAGES.nameOrDepartment} placeholder={COLLEAGUES_MESSAGES.forExampleSmith} defaultValue={q} autoFocus={!q} primary />
          </form>
          {q ? <p className="sp-line"><Link href="/colleagues" prefetch={false}>{M.allColleagues}</Link></p> : null}
          {failed ? (
            <Notice tone="danger">{rich(M.listCouldNotBeLoadedLine, { tag1: (children) => <strong>{children}</strong> }, { value1: toolErrorMessage(failed) })}</Notice>
          ) : !rows.length ? (
            next && !q ? <p className="sp-line">{COLLEAGUES_MESSAGES.noCardsOnThisPageTheyAre}</p> : <Empty icon={q ? "search" : "users"}>{q ? peopleNotFound(q) : COLLEAGUES_MESSAGES.noColleagueCardsYetTheyAppearWhen}</Empty>
          ) : (
            <ul className="row-list sp-rows">
              {rows.map((p) => {
                const line = p.about ? PROFILE_PLAIN.peopleCopyLine : [p.role, p.department].filter(Boolean).join(" · ");
                return (
                  <li className="row sp-row" key={p.id}>
                    <span className="ric"><Icon name="user" /></span>
                    <span className="t">
                      <Link href={`/records/${p.id}`} prefetch={false} title={p.about ? PROFILE_PLAIN.aboutTitle : M.colleagueCard}>{p.name}</Link>
                      {line ? <small>{line}</small> : null}
                    </span>
                    <span className="rmeta">
                      <Link href={personRecordsHref(p.id, q)} prefetch={false} className="sp-link">{COLLEAGUES_MESSAGES.recordsInvolving}<Icon name="chevron" /></Link>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {more ? <p className="sp-line">{more}</p> : null}
          {next ? <p className="sp-more"><Link href={`/colleagues?cursor=${encodeURIComponent(next)}`} prefetch={false} className="btn sm">{rich(M.moreColleaguesLine, { tag1: () => <Icon name="chevron" /> })}</Link></p> : null}
        </>
      )}
    </>
  );
}
