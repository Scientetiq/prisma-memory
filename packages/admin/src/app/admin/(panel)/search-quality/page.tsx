import { derivedList } from "@/i18n/runtime";
import { searchQualityPage as m } from "@/messages/panel-search-quality";
import { rich } from "@/i18n/rich";
import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { LocalTime } from "@/components/local-time";
import { PageFrame } from "@/components/page-frame";
import { LocalPager } from "@/components/pager";
import { Empty, Notice, Section, TableWrap } from "@/components/ui";
import { guardAuditorPage } from "@/lib/admin-guard";
import { tryGw } from "@/lib/api";
import { SEARCH_SLICE_DIMS, searchSliceTitle } from "@/lib/labels";
import { param, slicePage, type SearchParams } from "@/lib/paging";
import { dayMonth, formatCount, plusDays, weekSpan } from "@/lib/plain";
import { buildStatus, correctionsNote, emptyNothing, emptyQueriesLead, emptyQueriesNone, emptyQueriesTail, previousWeek, rank, share,
         smallNote, smallWeek, SQ_TEXT, topChange, weekDelta, type ShareKey } from "@/lib/search-quality";
import type { SearchQuality, SearchQualityPooled, SearchQualityWeek } from "@/lib/types";
import { readAdminView } from "@/lib/view-as";
import { recountSearchQualityAction } from "./actions";

export function generateMetadata(): Metadata { return { title: m.searchQuality }; }

const ROWS = 25;
const WINDOWS = [4, 12, 26] as const;
type Col = { label: Parameters<typeof m.metricDetail>[0]; title: string; value: (w: SearchQualityWeek) => string };
const COLS = derivedList((): Array<Col & { narrow: boolean }> => ([
  { label: "searches", title: m.searches, narrow: true, value: (w) => formatCount(w.searches ?? 0) },
  { label: "nothingFound", title: m.nothingFound, narrow: true, value: (w) => share(w.zero_share) },
  { label: "firstResult", title: m.firstResult, narrow: false, value: (w) => share(w.read1_share) },
  { label: "amongTheFirstThree", title: m.amongTheFirstThree, narrow: true, value: (w) => share(w.read3_share) },
  { label: "nothingOpened", title: m.nothingOpened, narrow: false, value: (w) => share(w.no_read_share) },
]));
const MORE = derivedList((): Col[] => ([
  { label: "rephrased", title: m.rephrased, value: (w) => share(w.reformulated_share) },
  { label: "positionOfFirstOpenedResult", title: m.positionOfFirstOpenedResult, value: (w) => rank(w.avg_first_read_rank) },
  { label: "resultsLaterCorrected", title: m.resultsLaterCorrected, value: (w) => share(w.corrected_share) },
  { label: "markedOutdated", title: m.markedOutdated, value: (w) => share(w.outdated_share) },
  { label: "markedUseful", title: m.markedUseful, value: (w) => share(w.useful_share) },
]));

function WeekNotes({ w }: { w: SearchQualityWeek }) {
  const notes = [w.current ? SQ_TEXT.current : null, correctionsNote(w), w.rules_changed ? SQ_TEXT.rules : null].filter((n): n is string => !!n);
  return notes.length ? (
    <details className="sq-note">
      <summary title={m.weekNotes(w.current, !w.current && !w.corrections_complete ? dayMonth(plusDays(w.week_end, 7)) : null, w.rules_changed)} aria-label={m.weekNote}>!</summary>
      {notes.map((n) => <div key={n} className="cell-sub">{n}</div>)}
    </details>
  ) : null;
}

function ShareValue({ w, prev, k }: { w: SearchQualityWeek; prev: SearchQualityWeek | null; k: ShareKey }) {
  const d = weekDelta(w, prev, k);
  return <>{share(w[k])}{d ? <span className={`sq-delta ${d.tone === "good" ? "ok-text" : "danger-text"}`} title={d.title}>{d.arrow}</span> : null}</>;
}

function PooledTiles({ p }: { p: SearchQualityPooled }) {
  return (
    <>
      <p className="hint">{m.pooledSummary(weekSpan(p.from, p.to), p.weeks)}</p>
      <div className="stat-tiles">
        <div className="stat-tile"><div className="v">{formatCount(p.searches ?? 0)}</div><div className="k">{m.searchesInThePeriod}</div></div>
        <div className="stat-tile"><div className="v">{share(p.zero_share)}</div><div className="k">{m.nothingFound}</div></div>
        <div className="stat-tile"><div className="v">{share(p.read1_share)}</div><div className="k">{m.openedTheFirstResult}</div></div>
        <div className="stat-tile"><div className="v">{share(p.read3_share)}</div><div className="k">{m.openedOneOfTheFirstThree}</div></div>
        <div className="stat-tile"><div className="v">{share(p.no_read_share)}</div><div className="k">{m.nothingOpened}</div></div>
      </div>
    </>
  );
}

const NoNumbers = ({ minGroup }: { minGroup: number }) => (
  <Empty>{rich(m.emptyGuidance(minGroup), { link1: (children) => <Link href="/admin/report#rollout" prefetch={false}>{children}</Link> })}</Empty>
);

export default async function SearchQualityPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await guardAuditorPage(true);
  const auditor = (await readAdminView()) === "auditor";
  const sp = await searchParams;
  const asked = Number.parseInt(param(sp, "weeks"), 10);
  const weeks = (WINDOWS as readonly number[]).includes(asked) ? asked : 12;
  const hook = { ...(param(sp, "include_test") === "true" ? { include_test: "true" } : {}), ...(param(sp, "current") === "true" ? { current: "true" } : {}) };
  const res = await tryGw<SearchQuality>("/api/v1/admin/search-quality", { query: { weeks, ...hook } });
  const keep = { ...(weeks === 12 ? {} : { weeks: String(weeks) }), ...hook } as Record<string, string>;
  const href = (n: number) => `/admin/search-quality?${new URLSearchParams({ ...hook, ...(n === 12 ? {} : { weeks: String(n) }) }).toString()}`.replace(/\?$/, "");
  const recount = auditor ? null : <ActionForm action={recountSearchQualityAction} submitLabel={m.recalculateNow} pendingLabel="…" compact quiet>{null}</ActionForm>;

  return (
    <PageFrame allowAuditor title={m.searchQuality} lead={SQ_TEXT.lead} actions={recount}>
      {!res.ok ? <Notice tone="danger" role="alert">{SQ_TEXT.failed}</Notice> : <Body q={res.data} sp={sp} keep={keep} weeks={weeks} href={href} />}
    </PageFrame>
  );
}

function Body({ q, sp, keep, weeks, href }: { q: SearchQuality; sp: SearchParams; keep: Record<string, string>; weeks: number; href: (n: number) => string }) {
  const st = buildStatus(q.enabled, q.last_build);
  const latest = q.weeks[0] ?? null;
  const prev = previousWeek(q.weeks, latest);
  const change = topChange(latest, prev, true);
  const rows = slicePage(q.weeks, param(sp, "wp"), ROWS);
  const nextWeek = latest && !latest.current ? plusDays(latest.week_start, 7) : null;
  const eq = q.empty_queries;
  const eqPage = eq ? slicePage(eq.shown, param(sp, "ep"), ROWS) : null;
  return (
    <>
      <p className={st.tone === "warn" ? "danger-text" : "hint"} role={st.tone === "warn" ? "alert" : undefined}>
        {st.text}{st.at ? <> <LocalTime iso={st.at} /></> : null}
      </p>

      {!latest || latest.small ? (
        <>
          {latest ? <p className="hint">{m.smallWeekSummary(weekSpan(latest.week_start, latest.week_end), q.min_group)}</p> : null}
          {q.pooled ? <PooledTiles p={q.pooled} /> : <NoNumbers minGroup={q.min_group} />}
        </>
      ) : (
        <>
          <p className="hint">{m.weekHeading(weekSpan(latest.week_start, latest.week_end), latest.current, !!prev)}</p>
          <div className="stat-tiles">
            <div className="stat-tile"><div className="v">{formatCount(latest.searches ?? 0)}</div><div className="k">{m.searchesInTheWeek}</div></div>
            <div className="stat-tile"><div className="v"><ShareValue w={latest} prev={prev} k="zero_share" /></div><div className="k">{m.nothingFound}</div></div>
            <div className="stat-tile"><div className="v"><ShareValue w={latest} prev={prev} k="read1_share" /></div><div className="k">{m.openedTheFirstResult}</div></div>
            <div className="stat-tile"><div className="v"><ShareValue w={latest} prev={prev} k="read3_share" /></div><div className="k">{m.openedOneOfTheFirstThree}</div></div>
            <div className="stat-tile"><div className="v"><ShareValue w={latest} prev={prev} k="no_read_share" /></div><div className="k">{m.nothingOpened}</div></div>
            <div className="stat-tile"><div className="v"><ShareValue w={latest} prev={prev} k="reformulated_share" /></div><div className="k">{m.immediatelyRephrased}</div></div>
            <div className="stat-tile" title={SQ_TEXT.exactHint}><div className="v">{share(latest.explicit_link_share)}</div><div className="k">{m.explicitlyLinked}</div></div>
          </div>
          {change ? <p className="sq-change">{change}</p> : null}
          <p className="hint">{m.exactExplanation()}</p>
        </>
      )}

      <Section title={m.byWeek} id="weeks" hint={smallNote(q.min_group)}>
        <nav className="tabs" aria-label={m.howManyWeeksToShow}>
          {WINDOWS.map((n) => (
            <Link key={n} prefetch={false} href={href(n)} className={n === weeks ? "on" : undefined} aria-current={n === weeks ? "page" : undefined}>{m.weekCount(n)}</Link>
          ))}
        </nav>
        {!q.weeks.length ? <NoNumbers minGroup={q.min_group} /> : (
          <>
            <TableWrap>
              <table className="board">
                <thead><tr><th>{m.week}</th>{COLS.map((c) => <th key={c.title} className={c.narrow ? "num" : "num sq-wide"}>{c.title}</th>)}</tr></thead>
                <tbody>
                  {nextWeek && rows.page === 1 ? (
                    <tr><td>{weekSpan(nextWeek, plusDays(nextWeek, 6))}</td><td colSpan={COLS.length} className="muted">{SQ_TEXT.current}</td></tr>
                  ) : null}
                  {rows.items.map((w) => (
                    <tr key={`${w.week_start}${w.current ? "c" : ""}`}>
                      <td>
                        {weekSpan(w.week_start, w.week_end)}
                        <WeekNotes w={w} />
                        {!w.small ? (
                          <details className="sq-more">
                            <summary>{m.more}</summary>
                            {COLS.filter((c) => !c.narrow).map((c) => <div key={c.title} className="cell-sub sq-narrow-only">{m.metricDetail(c.label, c.value(w))}</div>)}
                            {MORE.map((c) => <div key={c.title} className="cell-sub">{m.metricDetail(c.label, c.value(w))}</div>)}
                          </details>
                        ) : null}
                      </td>
                      {w.small ? <td colSpan={COLS.length} className="muted">{smallWeek(q.min_group)}</td>
                        : COLS.map((c) => <td key={c.title} className={c.narrow ? "num" : "num sq-wide"}>{c.value(w)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <LocalPager path="/admin/search-quality" params={keep} pageName="wp" page={rows} anchor="weeks" label={latest?.current ? m.weeks3 : m.completedWeeks} />
          </>
        )}
      </Section>

      <Section title={m.breakdowns} id="slices" hint={q.slices ? m.theLastCompletedWeeksUsingOnlyWeeksWith(weekSpan(q.slices.from, q.slices.to)) : m.theLastCompletedWeeks}>
        {!q.slices ? <Empty>{emptyNothing(q.min_group)}</Empty> : q.slices.stale ? <Notice tone="info">{SQ_TEXT.stale}</Notice> : !q.slices.weeks_used ? <Empty>{emptyNothing(q.min_group)}</Empty> : (
          SEARCH_SLICE_DIMS.map(({ dim, title }) => {
            const list = q.slices![dim];
            const page = list ? slicePage(list, param(sp, `s_${dim}`), ROWS) : null;
            return (
              <div key={dim} id={`slice-${dim}`} className="sq-slice">
                <h3>{title}</h3>
                {!list || !page ? <p className="hint">{m.hiddenSlice(q.min_group)}</p> : (
                  <>
                    <TableWrap>
                      <table className="board">
                        <thead><tr><th>{m.value}</th><th className="num">{m.searches}</th><th className="num">{m.nothingFound}</th><th className="num">{m.amongTheFirstThree}</th><th className="num">{m.nothingOpened}</th></tr></thead>
                        <tbody>
                          {page.items.map((r) => (
                            <tr key={r.value}><td>{searchSliceTitle(dim, r.value)}</td><td className="num">{formatCount(r.searches)}</td><td className="num">{share(r.zero_share)}</td>
                              <td className="num">{share(r.read3_share)}</td><td className="num">{share(r.no_read_share)}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    </TableWrap>
                    {page.pages > 1 ? <LocalPager path="/admin/search-quality" params={keep} pageName={`s_${dim}`} page={page} anchor={`slice-${dim}`} /> : null}
                  </>
                )}
              </div>
            );
          })
        )}
      </Section>

      <Section title={m.frequentQueriesWithNoResults} id="empty-queries" hint={emptyQueriesLead(q.min_group)}>
        {!eq || !eqPage ? <Empty>{emptyNothing(q.min_group)}</Empty> : (
          <>
            {!eq.shown.length ? <Empty>{emptyQueriesNone(q.min_group)}</Empty> : (
              <>
                <TableWrap>
                  <table className="board">
                    <thead><tr><th>{m.query}</th><th className="num">{m.people}</th><th className="num">{m.searches}</th></tr></thead>
                    <tbody>{eqPage.items.map((x) => <tr key={x.text}><td>{x.text}</td><td className="num">{formatCount(x.people)}</td><td className="num">{formatCount(x.searches)}</td></tr>)}</tbody>
                  </table>
                </TableWrap>
                <LocalPager path="/admin/search-quality" params={keep} pageName="ep" page={eqPage} anchor="empty-queries" />
              </>
            )}
            {eq.hidden_searches ? <p className="hint">{emptyQueriesTail(eq.hidden_searches, q.min_group)}</p> : null}
          </>
        )}
      </Section>
    </>
  );
}
