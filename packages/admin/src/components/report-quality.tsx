import { REPORT_QUALITY_TEXT } from "../messages/components";
import { rich } from "../i18n/rich";
import Link from "next/link";
import type { ReactNode } from "react";
import { LocalPager } from "@/components/pager";
import { Badge, Empty, Notice, Section, TableWrap } from "@/components/ui";
import { formatDecimal } from "@/i18n/format";
import { OPEN_CHECK_VIA_TITLES, ROLLOUT_STEP_TITLES, SPACE_KIND_TITLES } from "@/lib/labels";
import { slicePage } from "@/lib/paging";
import { formatCount, weekSpan } from "@/lib/plain";
import { REPORT_TOC_TEXT } from "@/lib/report-toc";
import { numbersAppear, pooledLead, SQ_TEXT, share, smallSessions, smallSpaces, smallWeek, topChange, weekDelta, type ShareKey } from "@/lib/search-quality";
import type { RolloutReport, SearchQualitySummary, SearchQualityWeek } from "@/lib/types";

const ROWS = 25;
type Fold = { open: boolean; state?: ReactNode };

function ShareWithDelta({ w, prev, k }: { w: SearchQualityWeek; prev: SearchQualityWeek | null; k: ShareKey }) {
  const d = weekDelta(w, prev, k);
  return <>{share(w[k])}{d ? <span className={`sq-delta ${d.tone === "good" ? "ok-text" : "danger-text"}`} title={d.title}>{d.arrow}</span> : null}</>;
}

export function SearchQualityWeekSection({ sq, fold, counted }: { sq: SearchQualitySummary | null; fold?: Fold; counted?: string }) {
  const w = sq?.week ?? null;
  const prev = sq?.previous ?? null;
  const change = topChange(w, prev);
  const pooled = w?.small || !w ? sq?.pooled ?? null : null;
  const link = <p className="hint"><Link href="/admin/search-quality" prefetch={false}>{REPORT_QUALITY_TEXT.details}</Link></p>;
  return (
    <Section title={REPORT_QUALITY_TEXT.title} id="search-quality" fold={fold} hint={w ? REPORT_QUALITY_TEXT.week(weekSpan(w.week_start, w.week_end)) : undefined}>
      {sq === null ? <Notice tone="warn">{SQ_TEXT.failed}</Notice> : !sq.enabled ? <p className="hint">{SQ_TEXT.off}</p> : null}
      {sq && !w && !pooled ? <Empty>{numbersAppear(sq.min_group)}.</Empty> : null}
      {w?.small ? <p className="hint">{smallWeek(sq!.min_group)}.</p> : null}
      {w?.rules_changed ? <p className="hint">{SQ_TEXT.rules}.</p> : null}
      {w && !w.small ? (
        <>
          <div className="stat-tiles">
            <div className="stat-tile"><div className="v">{formatCount(w.searches ?? 0)}</div><div className="k">{REPORT_QUALITY_TEXT.searches}</div></div>
            <div className="stat-tile"><div className="v"><ShareWithDelta w={w} prev={prev} k="zero_share" /></div><div className="k">{REPORT_QUALITY_TEXT.nothingFound}</div></div>
            <div className="stat-tile"><div className="v"><ShareWithDelta w={w} prev={prev} k="read3_share" /></div><div className="k">{REPORT_QUALITY_TEXT.firstThree}</div></div>
            <div className="stat-tile"><div className="v"><ShareWithDelta w={w} prev={prev} k="no_read_share" /></div><div className="k">{REPORT_QUALITY_TEXT.nothingOpened}</div></div>
          </div>
          {change ? <p className="sq-change">{rich(REPORT_QUALITY_TEXT.largestChange, null, { value1: change })}</p> : null}
        </>
      ) : null}
      {pooled ? (
        <>
          <p className="hint">{weekSpan(pooled.from, pooled.to)}. {pooledLead(pooled.weeks)}</p>
          <div className="stat-tiles">
            <div className="stat-tile"><div className="v">{formatCount(pooled.searches ?? 0)}</div><div className="k">{REPORT_QUALITY_TEXT.periodSearches}</div></div>
            <div className="stat-tile"><div className="v">{share(pooled.zero_share)}</div><div className="k">{REPORT_QUALITY_TEXT.nothingFound}</div></div>
            <div className="stat-tile"><div className="v">{share(pooled.read3_share)}</div><div className="k">{REPORT_QUALITY_TEXT.firstThree}</div></div>
            <div className="stat-tile"><div className="v">{share(pooled.no_read_share)}</div><div className="k">{REPORT_QUALITY_TEXT.nothingOpened}</div></div>
          </div>
        </>
      ) : null}
      {counted ? <p className="hint">{counted}</p> : null}
      {link}
    </Section>
  );
}

export function RolloutSection({ ro, page, keep, rulesChanged = false, fold, counted }: { ro: RolloutReport | null; page: string; keep: Record<string, string>; rulesChanged?: boolean;
  fold?: Fold; counted?: string }) {
  if (ro === null) {
    return <Section title={REPORT_QUALITY_TEXT.rollout} id="rollout" fold={fold}><Notice tone="warn">{SQ_TEXT.failed}</Notice></Section>;
  }
  const span = weekSpan(ro.week_start, ro.week_end);
  const s = ro.sessions, oc = ro.open_check, nb = ro.notes_by_space;
  const others = oc ? Object.entries(oc.other_by_via).filter(([, n]) => n > 0) : [];
  const spaces = slicePage(nb.items, page, ROWS);
  const steps = [...ro.funnel.steps].sort((a, b) => a.step - b.step);
  const median = ro.funnel.median_days_first_login_to_read;
  const notesTotal = nb.personal.notes + nb.small.notes + nb.items.reduce((a, x) => a + x.notes, 0);
  const newTotal = nb.personal.new_week + nb.small.new_week + nb.items.reduce((a, x) => a + x.new_week, 0);
  return (
    <Section title={REPORT_QUALITY_TEXT.rollout} id="rollout" fold={fold} hint={REPORT_QUALITY_TEXT.rolloutHint(span, counted ? ` ${counted}` : "")}>
      <h3>{REPORT_QUALITY_TEXT.conversations}</h3>
      {!s ? <Empty>{REPORT_QUALITY_TEXT.notCalculated}</Empty> : s.small ? <p className="hint">{smallSessions(ro.min_group)}.</p> : (
        <ul>
          <li>{rich(REPORT_QUALITY_TEXT.conversationCount, null, { value1: formatCount(s.total ?? 0) })}</li>
          <li>{rich(REPORT_QUALITY_TEXT.queryCount, null, { value1: formatCount(s.with_query ?? 0) })}</li>
          <li>{rich(REPORT_QUALITY_TEXT.pastNotesFound, null, { value1: formatCount(s.found_past_by_query ?? 0) })}</li>
          <li>{rich(REPORT_QUALITY_TEXT.pastNotesOpened, null, { value1: formatCount(s.read_past ?? 0) })}</li>
          <li>{rich(REPORT_QUALITY_TEXT.colleagueNotes, null, { value1: formatCount(s.found_colleague_notes ?? 0) })}</li>
          <li>{rich(REPORT_QUALITY_TEXT.overviewPastNotes, null, { value1: formatCount(s.overview_found_past ?? 0) })}</li>
        </ul>
      )}
      {rulesChanged ? <p className="hint">{SQ_TEXT.rules}.</p> : null}
      <p className="hint">{REPORT_QUALITY_TEXT.conversationHint}</p>

      <h3>{REPORT_QUALITY_TEXT.openCheck}</h3>
      {!oc ? <Empty>{REPORT_QUALITY_TEXT.notCalculated}</Empty> : (
        <>
          <p>{rich(REPORT_QUALITY_TEXT.agentNotes, null, { value1: formatCount(oc.agent_notes), value2: formatCount(oc.agent_saved_closed), value3: formatCount(oc.agent_refused) })}</p>
          {others.length ? <p className="hint">{rich(REPORT_QUALITY_TEXT.otherChecks, null, { value1: others.map(([via, n]) => `${OPEN_CHECK_VIA_TITLES[via] ?? REPORT_QUALITY_TEXT.other} — ${formatCount(n)}`).join(", ") })}</p> : null}
        </>
      )}

      <h3 id="rollout-spaces">{REPORT_QUALITY_TEXT.notesBySpace}</h3>
      <TableWrap>
        <table className="board">
          <thead><tr><th>{REPORT_QUALITY_TEXT.space}</th><th>{REPORT_QUALITY_TEXT.kind}</th><th className="num">{REPORT_QUALITY_TEXT.notes}</th><th className="num">{REPORT_QUALITY_TEXT.newThisWeek}</th></tr></thead>
          <tbody>
            {spaces.page === 1 ? (
              <>
                <tr><td>{rich(REPORT_QUALITY_TEXT.personalSpaces, null, { value1: formatCount(nb.personal.spaces) })}</td><td>{SPACE_KIND_TITLES.personal}</td><td className="num">{formatCount(nb.personal.notes)}</td><td className="num">{formatCount(nb.personal.new_week)}</td></tr>
                <tr><td>{smallSpaces(ro.min_group, nb.small.spaces)}</td><td>—</td><td className="num">{formatCount(nb.small.notes)}</td><td className="num">{formatCount(nb.small.new_week)}</td></tr>
              </>
            ) : null}
            {spaces.items.map((x) => (
              <tr key={x.slug}>
                <td>{x.name}{x.archived ? <> <Badge tone="muted">{REPORT_QUALITY_TEXT.archived}</Badge></> : null}</td>
                <td>{SPACE_KIND_TITLES[x.kind] ?? REPORT_QUALITY_TEXT.spaceFallback}</td>
                <td className="num">{formatCount(x.notes)}</td>
                <td className="num">{formatCount(x.new_week)}</td>
              </tr>
            ))}
            <tr>
              <td className="cell-main">{REPORT_QUALITY_TEXT.totalNotes}</td><td />
              <td className="num cell-main">{formatCount(notesTotal)}</td>
              <td className="num cell-main">{formatCount(newTotal)}</td>
            </tr>
          </tbody>
        </table>
      </TableWrap>
      <LocalPager path="/admin/report" params={keep} pageName="rsp" page={spaces} anchor="rollout-spaces" label={REPORT_QUALITY_TEXT.individualSpaces} />
      <p className="hint">{REPORT_QUALITY_TEXT.privacyHint}</p>

      <h3>{REPORT_QUALITY_TEXT.adoptionHeading}</h3>
      <p>{rich(REPORT_QUALITY_TEXT.catalogCount, null, { value1: formatCount(ro.funnel.catalog) })}</p>
      {!ro.funnel.catalog ? <p className="hint">{REPORT_TOC_TEXT.funnelEmptyCatalog}</p> : null}
      <TableWrap>
        <table className="board">
          <thead><tr><th>{REPORT_QUALITY_TEXT.step}</th><th className="num">{REPORT_QUALITY_TEXT.people}</th></tr></thead>
          <tbody>{steps.map((x) => <tr key={x.step}><td>{x.step}. {ROLLOUT_STEP_TITLES[x.step] ?? "—"}</td><td className="num">{formatCount(x.people)}</td></tr>)}</tbody>
        </table>
      </TableWrap>
      <p>{rich(REPORT_QUALITY_TEXT.firstRead, null, { value1: median === null ? REPORT_QUALITY_TEXT.insufficientData : REPORT_QUALITY_TEXT.usualDays(formatDecimal(median)) })}</p>
      <p className="hint">{REPORT_QUALITY_TEXT.funnelHint}</p>
    </Section>
  );
}

