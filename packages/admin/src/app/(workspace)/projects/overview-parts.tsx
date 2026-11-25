import type { ReactNode } from "react";
import Link from "next/link";
import { Block } from "@/components/block";
import { LocalTime } from "@/components/local-time";
import { CursorPager } from "@/components/pager";
import { RecordRow } from "@/components/record-row";
import { formatCount, OVERVIEW_PLAIN } from "@/lib/plain";
import { projectRecordsHref } from "@/lib/spaces";
import { blockShown, countHref, countsFrom, entityKindOf, OVERVIEW_ANCHOR, OVERVIEW_CURSOR, overviewEmpty, pageUsable, type OverviewBlockCode, type OverviewView } from "@/lib/space-overview";
import type { SpaceOverview, SpaceOverviewCount, SpaceOverviewPage, SpaceOverviewRow, SpaceOverviewWeekGroup } from "@/lib/types";
import type { MeResult } from "@/lib/me-api";

const recordHref = (id: string): string => `/records/${encodeURIComponent(id)}`;

function EventRows({ rows, kind }: { rows: readonly SpaceOverviewRow[]; kind: "decision" | "question_risk" }) {
  return (
    <ul className="mt-list sp-rows">
      {rows.map((r) => <RecordRow key={r.id} recordId={r.id} href={recordHref(r.id)} type="event" eventKind={kind} kind={false} title={r.title} date={r.occurred_at} />)}
    </ul>
  );
}

function DueRows({ rows }: { rows: readonly SpaceOverviewRow[] }) {
  return (
    <ul className="mt-list sp-rows">
      {rows.map((r) => (
        <RecordRow key={r.id} recordId={r.id} href={recordHref(r.id)} type="event" eventKind="action" kind={false} title={r.title}
          meta={<>{r.due ? <span className={r.overdue ? "ov-overdue" : "ov-due"}>{OVERVIEW_PLAIN.dueText(r.due, r.overdue === true)}</span> : null}
            {r.due ? " · " : null}{OVERVIEW_PLAIN.dueFrom} <LocalTime iso={r.occurred_at} short relative={false} /></>} />
      ))}
    </ul>
  );
}

function CountRows({ rows, entity }: { rows: readonly SpaceOverviewCount[]; entity: boolean }) {
  return (
    <ul className="ov-counts">
      {rows.map((c) => {
        const line = OVERVIEW_PLAIN.countLine(c.title, c.count, entity ? entityKindOf(c.key) : null);
        const href = countHref(c, entity);
        return <li key={c.key}>{href ? <Link href={href} prefetch={false}>{line}</Link> : <span>{line}</span>}</li>;
      })}
    </ul>
  );
}

type WeekKey = "meetings" | "documents" | "notes";
const WEEK_TYPE: Record<WeekKey, string> = { meetings: "transcript", documents: "document", notes: "note" };

function WeekGroup({ k, g, slug }: { k: WeekKey; g: SpaceOverviewWeekGroup; slug: string }) {
  if (!g.count) return null;
  const more = g.count - g.items.length;
  return (
    <div className="ov-week" id={`ov-week-${k}`}>
      <h3 className="sp-sub">{OVERVIEW_PLAIN.weekGroup[k]}<span className="sp-n">{formatCount(g.count)}</span></h3>
      <ul className="mt-list sp-rows">
        {g.items.map((r) => <RecordRow key={r.id} recordId={r.id} href={recordHref(r.id)} type={WEEK_TYPE[k]} kind={false} title={r.title} date={r.occurred_at} />)}
      </ul>
      {more > 0 ? (
        <p className="sp-line ov-more">{OVERVIEW_PLAIN.weekMore(more)} ·{" "}
          <Link href={projectRecordsHref(slug, `/spaces/${slug}/${WEEK_TYPE[k]}`)} prefetch={false} className="sp-link">{OVERVIEW_PLAIN.weekAll[k]}</Link>
        </p>
      ) : null}
    </div>
  );
}

function PagedBlock({ code, o, paged, page, path, keep, title, icon, hint, children }: {
  code: OverviewBlockCode; o: SpaceOverview; paged: { block: OverviewBlockCode; cursor: string } | null; page: MeResult<SpaceOverviewPage> | null;
  path: string; keep: Record<string, string>; title: string; icon: "gavel" | "alert" | "square-check"; hint?: string;
  children: (rows: readonly SpaceOverviewRow[]) => ReactNode;
}) {
  const b = blockShown(o, code, paged, page);
  return (
    <Block id={OVERVIEW_ANCHOR[code]} icon={icon} title={title} hint={hint}>
      {b.items.length ? children(b.items) : <p className="sp-line">{OVERVIEW_PLAIN.empty[code]}</p>}
      {b.cursor || b.next ? (
        <CursorPager path={path} params={keep} cursorName={OVERVIEW_CURSOR[code]} cursor={b.cursor} nextCursor={b.next}
          shown={b.items.length} anchor={OVERVIEW_ANCHOR[code]} noun={OVERVIEW_PLAIN.noun[code]} />
      ) : null}
    </Block>
  );
}

export function OverviewBlocks({ view, page, paged, slug, kind, path, keep }: {
  view: OverviewView;
  page: MeResult<SpaceOverviewPage> | null;
  paged: { block: OverviewBlockCode; cursor: string } | null;
  slug: string; kind: "project" | "team";
  path: string; keep: Record<string, string>;
}) {
  if (view.kind === "hidden") return null;
  if (view.kind === "failed") {
    return (
      <Block id="ov-failed" icon="grid" title={OVERVIEW_PLAIN.allEmptyTitle(kind)}>
        <p className="sp-line">{OVERVIEW_PLAIN.failed}: {view.message}</p>
      </Block>
    );
  }
  const o = view.data;
  if (overviewEmpty(o) && !pageUsable(paged, page)) {
    return (
      <Block id="ov-empty" icon="grid" title={OVERVIEW_PLAIN.allEmptyTitle(kind)}>
        <p className="sp-line">{OVERVIEW_PLAIN.allEmpty(kind)}</p>
      </Block>
    );
  }
  const counts = o.directions.length + o.entities.length;
  const week = (["meetings", "documents", "notes"] as const).filter((k) => o.week[k].count > 0);
  return (
    <section className="ov" aria-label={OVERVIEW_PLAIN.allEmptyTitle(kind)}>
      <p className="sp-line ov-lead">{OVERVIEW_PLAIN.lead}</p>
      <div className="ov-grid">
        <PagedBlock code="decisions" o={o} paged={paged} page={page} path={path} keep={keep} title={OVERVIEW_PLAIN.decisions} icon="gavel">
          {(rows) => <EventRows rows={rows} kind="decision" />}
        </PagedBlock>
        <PagedBlock code="risks" o={o} paged={paged} page={page} path={path} keep={keep} title={OVERVIEW_PLAIN.risks} icon="alert" hint={OVERVIEW_PLAIN.risksHint}>
          {(rows) => <EventRows rows={rows} kind="question_risk" />}
        </PagedBlock>
        <PagedBlock code="due_this_week" o={o} paged={paged} page={page} path={path} keep={keep} title={OVERVIEW_PLAIN.due} icon="square-check" hint={OVERVIEW_PLAIN.dueHint}>
          {(rows) => <DueRows rows={rows} />}
        </PagedBlock>
        <Block id="ov-week" icon="history" title={OVERVIEW_PLAIN.week} hint={OVERVIEW_PLAIN.weekHint}>
          {week.length ? week.map((k) => <WeekGroup key={k} k={k} g={o.week[k]} slug={slug} />) : <p className="sp-line">{OVERVIEW_PLAIN.empty.week}</p>}
        </Block>
        <Block id="ov-counts" icon="network" title={OVERVIEW_PLAIN.counts} hint={counts ? OVERVIEW_PLAIN.countsHint(countsFrom(o)) : undefined} className="ov-wide">
          {!counts ? <p className="sp-line">{OVERVIEW_PLAIN.empty.counts}</p> : (
            <div className="ov-count-cols">
              {o.directions.length ? (
                <div><h3 className="sp-sub">{OVERVIEW_PLAIN.directions}</h3><CountRows rows={o.directions} entity={false} /></div>
              ) : null}
              {o.entities.length ? (
                <div><h3 className="sp-sub">{OVERVIEW_PLAIN.entities}</h3><CountRows rows={o.entities} entity /></div>
              ) : null}
            </div>
          )}
        </Block>
      </div>
    </section>
  );
}
