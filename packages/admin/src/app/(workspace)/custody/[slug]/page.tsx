import type { Metadata } from "next";
import Link from "next/link";
import { FindRow } from "@/components/find-field";
import { Icon } from "@/components/icons";
import { CursorPager } from "@/components/pager";
import { Badge, Empty, LoadError, Notice, PageHead, Section, TableWrap } from "@/components/ui";
import { custodyBasisLine, custodyHref, custodyName, custodyRefusal, custodyRow, isCustodySlug } from "@/lib/custody-read";
import { requireWorkspace } from "@/lib/me";
import { meGw } from "@/lib/me-api";
import { hrefWith, param, type SearchParams } from "@/lib/paging";
import { CUSTODY_PLAIN, formatDay, SECTION_TITLES } from "@/lib/plain";
import type { CustodyRecords } from "@/lib/types";
import { WS_CUSTODY_MESSAGES } from "@/messages/ws-custody";

export function generateMetadata(): Metadata { return { title: SECTION_TITLES.custody }; }
const LIMIT = 50;

export default async function CustodyPersonPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> }) {
  const { session } = await requireWorkspace();
  const { slug: raw } = await params;
  const sp = await searchParams;
  const slug = decodeURIComponent(raw).toLowerCase();
  const q = param(sp, "q").slice(0, 200), deleted = param(sp, "deleted") === "1", cursor = param(sp, "cursor");
  const res = isCustodySlug(slug)
    ? await meGw<CustodyRecords>(session.key, `/api/v1/me/custody/${encodeURIComponent(slug)}/records`,
        { query: { limit: LIMIT, q: q || undefined, deleted: deleted ? 1 : undefined, cursor: cursor || undefined } })
    : { ok: false as const, status: 404, code: "not_found", message: CUSTODY_PLAIN.gone };
  const back = <Link href="/custody" className="btn sm" prefetch={false}><Icon name="archive" />{CUSTODY_PLAIN.back}</Link>;
  if (!res.ok) {
    const r = custodyRefusal(res);
    return (
      <>
        <PageHead title={SECTION_TITLES.custody} actions={back} />
        {r.off || r.gone ? <Notice tone="info">{r.text}</Notice> : <LoadError result={res} what={WS_CUSTODY_MESSAGES.records} />}
      </>
    );
  }
  const d = res.data, name = custodyName(d.person);
  const base = { q, deleted: deleted ? "1" : "" };
  return (
    <>
      <PageHead title={CUSTODY_PLAIN.personLine(name, formatDay(d.since))} lead={custodyBasisLine(d.basis)} actions={back} />
      <form className="filter-form" action={custodyHref(slug)} method="get" role="search" aria-label={CUSTODY_PLAIN.searchLabel}>
        <FindRow label={CUSTODY_PLAIN.searchLabel} placeholder={CUSTODY_PLAIN.searchLabel} defaultValue={q} maxLength={200} submit={CUSTODY_PLAIN.searchSubmit} className="find-custody" />
        {deleted ? <input type="hidden" name="deleted" value="1" /> : null}
        <Link href={hrefWith(custodyHref(slug), base, { deleted: deleted ? null : "1", cursor: null })} className="btn sm" prefetch={false}>
          {deleted ? CUSTODY_PLAIN.showLive : CUSTODY_PLAIN.showDeleted}</Link>
      </form>
      {d.closed_hidden > 0 ? <Notice tone="info">{q ? CUSTODY_PLAIN.closedHiddenSearch(d.closed_hidden) : CUSTODY_PLAIN.closedHidden(d.closed_hidden)}</Notice> : null}
      <Section title={deleted ? CUSTODY_PLAIN.showDeleted : CUSTODY_PLAIN.backPerson(name)} icon={deleted ? "trash" : "archive"}>
        {!d.items.length ? <Empty>{cursor ? WS_CUSTODY_MESSAGES.nothingMoreHere : q ? CUSTODY_PLAIN.emptyFound : deleted ? CUSTODY_PLAIN.emptyDeleted : CUSTODY_PLAIN.emptyList}</Empty> : <>
          <TableWrap cards><table className="board custody-table">
            <thead><tr><th>{CUSTODY_PLAIN.colTitle}</th><th>{CUSTODY_PLAIN.colType}</th><th>{CUSTODY_PLAIN.colDate}</th></tr></thead>
            <tbody>{d.items.map((x) => {
              const r = custodyRow(x);
              return (
                <tr key={x.id}>
                  <td data-label={CUSTODY_PLAIN.colTitle}><Link href={custodyHref(slug, x.id)} prefetch={false}><strong>{r.title}</strong></Link>
                    {r.closed ? <> <Badge tone="warn">{CUSTODY_PLAIN.closedMark}</Badge></> : null}
                    {r.deleted ? <div className="muted small">{r.deleted}</div> : null}</td>
                  <td data-label={CUSTODY_PLAIN.colType}>{r.kind}</td>
                  <td data-label={CUSTODY_PLAIN.colDate}>{r.day}</td>
                </tr>
              );
            })}</tbody>
          </table></TableWrap>
          <CursorPager path={custodyHref(slug)} params={base} cursorName="cursor" cursor={cursor} nextCursor={d.next_cursor} shown={d.items.length} noun={CUSTODY_PLAIN.pagerNoun} />
        </>}
      </Section>
    </>
  );
}
