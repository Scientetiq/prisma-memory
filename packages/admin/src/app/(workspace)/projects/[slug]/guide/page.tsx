import { guidePage as M } from "@/messages/ws-projects";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ActionForm } from "@/components/action-form";
import { Block } from "@/components/block";
import { LocalTime } from "@/components/local-time";
import { CursorPager, LocalPager } from "@/components/pager";
import { Badge, Empty, Field, LoadError, Notice, PageHead } from "@/components/ui";
import { isSlug } from "@/lib/form";
import { requireWorkspace } from "@/lib/me";
import { meGw } from "@/lib/me-api";
import { param, slicePage, type SearchParams } from "@/lib/paging";
import { GUIDE_PLAIN } from "@/lib/plain";
import { PREVIEW_TEXT } from "@/lib/preview";
import { changedSections, formValues, GUIDE_HISTORY_PAGE, GUIDE_SECTION_MAX, GUIDE_SECTION_ORDER, guideApplyHref, guideHref, guideLoad, guideQuery, isGuideCursor,
         pickProposal, proposalMeta, sectionTitles } from "@/lib/space-guide";
import type { GuideSections, MySpace, SpaceGuide, SpaceGuideProposal, SpaceGuideVersion } from "@/lib/types";
import { BackLink } from "../../../browse/space-parts";
import { correctionDecisionAction } from "../../../corrections/actions";
import { decidedNotice } from "../../../records/[id]/corrections-block";
import { saveGuideAction } from "../../actions";

export function generateMetadata(): Metadata { return { title: GUIDE_PLAIN.title }; }

function SectionsView({ sections, unplaced }: { sections: GuideSections; unplaced?: string | null }) {
  const shown = GUIDE_SECTION_ORDER.filter((k) => sections[k]);
  return (
    <dl className="guide-view">
      {shown.map((k) => <div key={k}><dt>{GUIDE_PLAIN.sections[k].title}</dt><dd className="pre-line">{sections[k]}</dd></div>)}
      {unplaced ? <div><dt>{GUIDE_PLAIN.unplacedTitle}</dt><dd className="pre-line">{unplaced}</dd></div> : null}
    </dl>
  );
}

function Decide({ id, op, label, back }: { id: string; op: "reject" | "withdraw"; label: string; back: string }) {
  return (
    <ActionForm action={correctionDecisionAction} submitLabel={label} pendingLabel="…" compact quiet>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="op" value={op} />
      <input type="hidden" name="back" value={back} />
    </ActionForm>
  );
}

function ProposalRow({ p, guide, back }: { p: SpaceGuideProposal; guide: SpaceGuide; back: string }) {
  const changed = changedSections(guide.sections, p.sections);
  const acts: ReactNode[] = [];
  if (p.can.apply) acts.push(<Link key="apply" href={guideApplyHref(guide.space, p.id)} prefetch={false} className="btn sm primary">{GUIDE_PLAIN.apply}</Link>);
  if (p.can.reject) acts.push(<Decide key="reject" id={p.id} op="reject" label={GUIDE_PLAIN.reject} back={back} />);
  else if (p.can.withdraw) acts.push(<Decide key="withdraw" id={p.id} op="withdraw" label={GUIDE_PLAIN.withdraw} back={back} />);
  return (
    <li className="corr-row">
      <div className="corr-line"><b>{GUIDE_PLAIN.proposalTitle}</b> · {proposalMeta(p).join(" · ")} · <LocalTime iso={p.at} short /></div>
      <ul className="corr-what">
        <li>{changed.length ? GUIDE_PLAIN.changes(sectionTitles(changed)) : GUIDE_PLAIN.noChanges}</li>
        {p.unplaced ? <li>{GUIDE_PLAIN.unplacedTitle}: {GUIDE_PLAIN.unplacedText.charAt(0).toLowerCase() + GUIDE_PLAIN.unplacedText.slice(1)}</li> : null}
        {p.stale ? <li>{GUIDE_PLAIN.stale}</li> : null}
      </ul>
      <details className="sp-more-info">
        <summary>{GUIDE_PLAIN.showText}</summary>
        <SectionsView sections={p.sections} unplaced={p.unplaced} />
      </details>
      {acts.length ? <div className="corr-acts">{acts}</div> : null}
    </li>
  );
}

function VersionRow({ v }: { v: SpaceGuideVersion }) {
  const notes = [
    ...(v.changed.length ? [GUIDE_PLAIN.changed(sectionTitles(v.changed))] : []),
    ...(v.proposal === "agent" ? [GUIDE_PLAIN.fromAgentProposal] : v.proposal === "human" ? [GUIDE_PLAIN.fromHumanProposal] : []),
  ];
  return (
    <li className="corr-row">
      <div className="corr-line">
        <Link href={`/records/${v.id}`} prefetch={false}>{GUIDE_PLAIN.version(v.version)}</Link>
        {v.current ? <> <Badge tone="ok">{GUIDE_PLAIN.current}</Badge></> : null}
        {" · "}<LocalTime iso={v.at} short />{v.by ? ` · ${v.by.display_name || v.by.login}` : ""}
      </div>
      {notes.length ? <div className="muted small">{notes.join(" · ")}</div> : null}
    </li>
  );
}

export default async function GuidePage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> }) {
  const { session } = await requireWorkspace();
  const slug = decodeURIComponent((await params).slug).toLowerCase();
  const sp = await searchParams;
  const head = <PageHead title={GUIDE_PLAIN.title} lead={GUIDE_PLAIN.lead} />;
  if (!isSlug(slug)) return <><BackLink href="/browse">{M.spacesAndProjects}</BackLink>{head}<Empty>{M.invalidSpaceAddress}</Empty></>;
  const project = `/projects/${encodeURIComponent(slug)}`;
  if (session.preview) return <><BackLink href={project}>{GUIDE_PLAIN.back}</BackLink>{head}<Notice tone="info">{PREVIEW_TEXT.previewDeniedHint}</Notice></>;

  const here = guideHref(slug);
  const asked = param(sp, "proposal");
  const pc = isGuideCursor(param(sp, "pc")) ? param(sp, "pc") : "";
  const [card, res] = await Promise.all([
    meGw<MySpace>(session.key, `/api/v1/me/spaces/${encodeURIComponent(slug)}`),
    meGw<SpaceGuide>(session.key, `/api/v1/me/spaces/${encodeURIComponent(slug)}/guide`, { query: guideQuery(asked, pc) }),
  ]);
  if (!card.ok) {
    return (
      <>
        <BackLink href="/browse">{M.spacesAndProjects2}</BackLink>{head}
        {card.code === "not_found"
          ? <Empty>{M.thisSpaceDoesNotExistOrIs}</Empty>
          : <LoadError result={card} what={M.space} />}
      </>
    );
  }
  const s = card.data;
  const back = <BackLink href={project}>{s.name}</BackLink>;
  if (s.kind === "personal") return <>{back}{head}<Notice tone="info">{GUIDE_PLAIN.personal}</Notice></>;
  const load = guideLoad(res);
  if (load.kind === "disabled") return <>{back}{head}<Notice tone="info">{GUIDE_PLAIN.disabled}</Notice></>;
  if (load.kind === "not_found") return <>{back}{head}<Empty>{M.thisSpaceDoesNotExistOrIs2}</Empty></>;
  if (load.kind === "error") return <>{back}{head}<LoadError result={load.result} what={M.guide} /></>;

  const g = load.guide;
  const archived = Boolean(s.archived_at);
  const proposal = pickProposal(g, asked);
  const gone = Boolean(asked) && !proposal && g.can_edit;
  const applied = param(sp, "applied");
  const proposals = g.proposals ?? [];
  const hp = param(sp, "hp");
  const history = slicePage(g.history ?? [], hp, GUIDE_HISTORY_PAGE);
  const values = formValues(g, proposal);
  const hasGuide = g.id !== null;
  const keep: Record<string, string> = { ...(proposal ? { proposal: proposal.id } : {}), ...(pc ? { pc } : {}) };
  const keepP: Record<string, string> = { ...(proposal ? { proposal: proposal.id } : {}), ...(/^\d{1,4}$/.test(hp) ? { hp } : {}) };

  return (
    <>
      {back}
      {head}
      {archived ? <Notice tone="warn">{GUIDE_PLAIN.archived}</Notice> : null}
      {hasGuide && g.class === "closed" ? <Notice tone="info">{GUIDE_PLAIN.closed}</Notice> : null}
      {applied === "same" ? <Notice tone="ok">{GUIDE_PLAIN.appliedSame}</Notice>
        : /^\d{1,6}$/.test(applied) ? <Notice tone="ok">{GUIDE_PLAIN.applied(Number(applied))}</Notice> : null}
      {decidedNotice(param(sp, "decided"))}

      <Block id="form" icon="text" title={proposal ? GUIDE_PLAIN.proposalTitle : GUIDE_PLAIN.formTitle} hint={g.can_edit ? GUIDE_PLAIN.formHint : undefined}>
        {g.can_edit ? (
          <>
            {gone ? <Notice tone="warn">{GUIDE_PLAIN.proposalGone}</Notice> : null}
            {!hasGuide && !proposal ? <Notice tone="info">{GUIDE_PLAIN.empty} {GUIDE_PLAIN.emptyOwner}</Notice> : null}
            {proposal ? <Notice tone="info"><strong>{GUIDE_PLAIN.fromProposal}</strong>{proposal.stale ? ` ${GUIDE_PLAIN.stale}` : ""}</Notice> : null}
            {proposal?.unplaced ? (
              <div className="guide-unplaced">
                <h3 className="sp-sub">{GUIDE_PLAIN.unplacedTitle}</h3>
                <p className="sp-line">{GUIDE_PLAIN.unplacedText}</p>
                <p className="pre-line">{proposal.unplaced}</p>
              </div>
            ) : null}
            <ActionForm key={proposal?.id ?? "guide"} action={saveGuideAction} submitLabel={GUIDE_PLAIN.save} pendingLabel={GUIDE_PLAIN.saving}>
              <input type="hidden" name="space" value={g.space} />
              {proposal ? <input type="hidden" name="from_proposal" value={proposal.id} /> : null}
              <div className="form-grid">
                {GUIDE_SECTION_ORDER.map((k) => (
                  <Field key={k} label={GUIDE_PLAIN.sections[k].title} hint={GUIDE_PLAIN.sections[k].hint} wide>
                    <textarea name={k} rows={3} defaultValue={values[k]} maxLength={GUIDE_SECTION_MAX} />
                  </Field>
                ))}
              </div>
            </ActionForm>
            {proposal ? <p className="sp-line"><Link href={here} prefetch={false}>{GUIDE_PLAIN.cancelProposal}</Link></p> : null}
            <p className="sp-line muted">{GUIDE_PLAIN.size(g.tokens, g.max_tokens)}</p>
          </>
        ) : (
          <>
            {hasGuide && GUIDE_SECTION_ORDER.some((k) => g.sections[k]) ? <SectionsView sections={g.sections} />
              : <Empty icon="text">{GUIDE_PLAIN.empty}{archived ? "" : ` ${GUIDE_PLAIN.emptyReader}`}</Empty>}
            {archived || !hasGuide ? null : <p className="sp-line">{s.kind === "org" ? GUIDE_PLAIN.readOnlyOrg : GUIDE_PLAIN.readOnly}</p>}
          </>
        )}
      </Block>

      {g.can_edit || proposals.length || pc ? (
        <Block id="proposals" icon="bot" hint={g.can_edit ? GUIDE_PLAIN.proposalsHint : GUIDE_PLAIN.proposalsMineHint}
          title={<>{GUIDE_PLAIN.proposalsTitle}{proposals.length ? <span className="sp-n">{proposals.length}{g.proposals_more ? "+" : ""}</span> : null}</>}>
          {!proposals.length ? <p className="sp-none">{GUIDE_PLAIN.proposalsEmpty}</p>
            : <ul className="corr-list">{proposals.map((p) => <ProposalRow key={p.id} p={p} guide={g} back={here} />)}</ul>}
          {pc || g.proposals_next
            ? <CursorPager path={here} params={keepP} cursorName="pc" cursor={pc} nextCursor={g.proposals_next ?? null} shown={proposals.length} anchor="proposals" noun={M.proposals} />
            : null}
        </Block>
      ) : null}

      {history.total ? (
        <Block id="history" icon="history" hint={GUIDE_PLAIN.historyHint}
          title={<>{GUIDE_PLAIN.historyTitle}<span className="sp-n">{history.total}{g.history_more ? "+" : ""}</span></>}>
          <ul className="corr-list">{history.items.map((v) => <VersionRow key={v.id} v={v} />)}</ul>
          {history.pages > 1 ? <LocalPager path={here} params={keep} pageName="hp" page={history} anchor="history" /> : null}
          {g.history_more ? <p className="sp-line">{GUIDE_PLAIN.historyMore}</p> : null}
        </Block>
      ) : null}
    </>
  );
}
