import { pageText as M } from "@/messages/ws-corrections";
import { rich } from "@/i18n/rich";
import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/components/icons";
import { LocalTime } from "@/components/local-time";
import { CursorPager } from "@/components/pager";
import { Badge, Empty, Notice, PageHead, Section, TableWrap } from "@/components/ui";
import { CORRECTION_KIND_TITLES, CORRECTIONS_EMPTY, CORRECTIONS_SECTIONS, correctionDecidedLine, correctionLine, correctionProposal, correctionStateBadge, CORRECTIONS_COPY } from "@/lib/corrections";
import { HOME_TEXT, recordKind } from "@/lib/home";
import { requireWorkspace } from "@/lib/me";
import { meGw, type MeResult } from "@/lib/me-api";
import { param, type SearchParams } from "@/lib/paging";
import { GUIDE_PLAIN, SECTION_TITLES } from "@/lib/plain";
import { PREVIEW_TEXT } from "@/lib/preview";
import type { CorrectionPage, CorrectionView } from "@/lib/types";
import { DecisionButtons, decidedNotice } from "../records/[id]/corrections-block";

export function generateMetadata(): Metadata { return { title: SECTION_TITLES.corrections }; }
const LIMIT = 20;


function Target({ v }: { v: CorrectionView }) {
  if (v.target.space === "") return <span className="muted">{rich(M.youNoLongerHaveAccessTo, null)}</span>;
  return (
    <>
      <Link href={`/records/${v.target.id}`} prefetch={false}>{v.target.title || M.untitled}</Link>
      <div className="muted small">{recordKind(v.target.type, v.target.event_kind)}</div>
    </>
  );
}

const Lines = ({ lines }: { lines: string[] }) => <ul className="corr-what">{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>;

const WhoSees = ({ text }: { text: string }) => <details className="sp-more-info"><summary>{CORRECTIONS_SECTIONS.whoSees}</summary><p>{text}</p></details>;

const EmptyMine = () => (
  <Empty icon="pencil" action={<>
    <Link href="/search" prefetch={false} className="btn"><Icon name="search" />{SECTION_TITLES.search}</Link>
    <Link href="/materials" prefetch={false} className="btn"><Icon name="folder" />{HOME_TEXT.materialsTitle}</Link>
  </>}>{CORRECTIONS_EMPTY.mine}</Empty>
);

function State({ v }: { v: CorrectionView }) {
  const b = correctionStateBadge(v), line = correctionDecidedLine(v);
  return <><Badge tone={b.tone}>{b.label}</Badge>{line ? <div className="muted small">{line}</div> : null}</>;
}

export default async function CorrectionsPageView({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { session } = await requireWorkspace();
  if (session.preview) return <><PageHead title={SECTION_TITLES.corrections} /><Notice tone="info">{PREVIEW_TEXT.previewDeniedHint}</Notice></>;
  const sp = await searchParams, tc = param(sp, "tc"), mc = param(sp, "mc"), decided = param(sp, "decided");
  const list = (role: "to_confirm" | "mine", cursor: string): Promise<MeResult<CorrectionPage>> =>
    meGw<CorrectionPage>(session.key, "/api/v1/me/corrections", { query: { role, limit: LIMIT, cursor: cursor || undefined } });
  const [toConfirm, mine] = await Promise.all([list("to_confirm", tc), list("mine", mc)]);
  return (
    <>
      <PageHead title={SECTION_TITLES.corrections} lead={CORRECTIONS_COPY.correctionsLead} />
      {decidedNotice(decided)}
      <Section title={CORRECTIONS_SECTIONS.toConfirm} id="to-confirm" icon="list-checks">
        <WhoSees text={CORRECTIONS_COPY.toConfirmHint} />
        {!toConfirm.ok ? <Notice tone="warn">{(M.theListCouldNotBeLoaded)}</Notice> : !toConfirm.data.items.length ? (tc ? <Empty>{rich(M.noMoreRecords, null)}</Empty> : <Empty icon="circle-check">{CORRECTIONS_EMPTY.toConfirm}</Empty>) : (
          <>
            <TableWrap>
              <table className="board corr-table">
                <thead><tr><th>{rich(M.record, null)}</th><th>{rich(M.proposedChanges, null)}</th><th>{rich(M.who, null)}</th><th>{rich(M.when, null)}</th><th>{rich(M.decision, null)}</th></tr></thead>
                <tbody>{toConfirm.data.items.map((v) => (
                  <tr key={v.id}>
                    <td data-label={M.record}><Target v={v} /></td>
                    <td data-label={M.proposedChanges}><Lines lines={correctionProposal(v)} /></td>
                    <td data-label={M.who}>{v.by ? v.by.display_name || v.by.login : "—"}</td>
                    <td data-label={M.when}><LocalTime iso={v.created_at} short /></td>
                    <td data-label={M.decision}><DecisionButtons v={v} back="/corrections" /></td>
                  </tr>
                ))}</tbody>
              </table>
            </TableWrap>
            <CursorPager path="/corrections" params={mc ? { mc } : {}} cursorName="tc" cursor={tc} nextCursor={toConfirm.data.next_cursor} shown={toConfirm.data.items.length} anchor="to-confirm" />
          </>
        )}
      </Section>
      <Section title={CORRECTIONS_SECTIONS.mine} id="mine" icon="pencil">
        <WhoSees text={CORRECTIONS_COPY.mineHint} />
        {!mine.ok ? <Notice tone="warn">{(M.theListCouldNotBeLoaded)}</Notice> : !mine.data.items.length ? (mc ? <Empty>{rich(M.noMoreRecords, null)}</Empty> : <EmptyMine />) : (
          <>
            <TableWrap>
              <table className="board corr-table">
                <thead><tr><th>{rich(M.record, null)}</th><th>{rich(M.whatChanged, null)}</th><th>{rich(M.when, null)}</th><th>{rich(M.state, null)}</th><th>{rich(M.action, null)}</th></tr></thead>
                <tbody>{mine.data.items.map((v) => (
                  <tr key={v.id}>
                    <td data-label={M.record}><Target v={v} /></td>
                    <td data-label={M.whatChanged}>{v.status === "proposed" ? <Lines lines={correctionProposal(v)} />
                      : <>{v.space_guide ? GUIDE_PLAIN.correctionKind : CORRECTION_KIND_TITLES[v.kind]}{v.status === "applied" ? <div className="muted small">{correctionLine(v)}</div> : null}</>}</td>
                    <td data-label={M.when}><LocalTime iso={v.created_at} short /></td>
                    <td data-label={M.state}><State v={v} /></td>
                    <td data-label={M.action}>{v.can.withdraw ? <DecisionButtons v={{ ...v, can: { confirm: false, reject: false, withdraw: true } }} back="/corrections" /> : "—"}</td>
                  </tr>
                ))}</tbody>
              </table>
            </TableWrap>
            <CursorPager path="/corrections" params={tc ? { tc } : {}} cursorName="mc" cursor={mc} nextCursor={mine.data.next_cursor} shown={mine.data.items.length} anchor="mine" />
          </>
        )}
      </Section>
    </>
  );
}
