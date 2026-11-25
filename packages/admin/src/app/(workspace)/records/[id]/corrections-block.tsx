import { correctionsBlockText as M } from "@/messages/ws-records";
import Link from "next/link";
import type { ReactNode } from "react";
import { ActionForm } from "@/components/action-form";
import { LocalPager } from "@/components/pager";
import { Notice, Section } from "@/components/ui";
import { DECISION_DONE, correctionLine, correctionLink, correctionProposal, guideApplyLink, type CorrectionDecision, CORRECTIONS_COPY } from "@/lib/corrections";
import { slicePage } from "@/lib/paging";
import type { CorrectionView } from "@/lib/types";
import { correctionDecisionAction } from "../../corrections/actions";

export function DecisionButtons({ v, back }: { v: CorrectionView; back?: string }) {
  const forms: ReactNode[] = [];
  const decide = (op: CorrectionDecision, label: string, confirm?: string) => (
    <ActionForm key={op} action={correctionDecisionAction} submitLabel={label} pendingLabel="…" compact quiet confirm={confirm}>
      <input type="hidden" name="id" value={v.id} />
      <input type="hidden" name="op" value={op} />
      {back ? <input type="hidden" name="back" value={back} /> : null}
    </ActionForm>
  );
  const apply = guideApplyLink(v);
  if (apply) forms.push(<Link key="apply" href={apply.href} prefetch={false} className="btn sm">{apply.label}</Link>);
  if (v.can.confirm && v.status === "proposed") forms.push(decide("confirm", M.confirm, CORRECTIONS_COPY.confirmProposed));
  if (v.can.confirm && v.status === "applied") forms.push(decide("confirm", M.confirm, CORRECTIONS_COPY.confirmApplied));
  if (v.can.reject && v.status === "proposed") forms.push(decide("reject", M.reject));
  if (v.can.reject && v.status === "applied") forms.push(decide("reject", M.thisIsIncorrect, CORRECTIONS_COPY.confirmUndo));
  if (v.can.withdraw) forms.push(decide("withdraw", M.withdraw, v.status === "applied" ? CORRECTIONS_COPY.confirmUndo : undefined));
  return forms.length ? <div className="corr-acts">{forms}</div> : null;
}

export const decidedNotice = (decided: string): ReactNode =>
  Object.hasOwn(DECISION_DONE, decided) ? <Notice tone="ok">{DECISION_DONE[decided as CorrectionDecision]}</Notice> : null;

export function CorrectionRow({ v, back }: { v: CorrectionView; back?: string }) {
  const link = correctionLink(v);
  const what = v.status === "proposed" ? correctionProposal(v) : [];
  return (
    <li className="corr-row">
      <div className="corr-line">{correctionLine(v)}{link ? <> · <Link href={link.href} prefetch={false}>{link.label}</Link></> : null}</div>
      {what.length ? <ul className="corr-what">{what.map((w, i) => <li key={i}>{w}</li>)}</ul> : null}
      <DecisionButtons v={v} back={back} />
    </li>
  );
}

export function CorrectionsBlock({ recordId, items, page, params, decided }: { recordId: string; items: CorrectionView[]; page: string; params: Record<string, string>; decided: string }) {
  const pg = slicePage(items, page, 10);
  const back = `/records/${recordId}`;
  return (
    <Section title={M.correctionsToThisRecord} id="corrections" icon="pencil" hint={M.whoCorrectedTheRecordAndHow}>
      {decidedNotice(decided)}
      <ul className="corr-list">{pg.items.map((v) => <CorrectionRow key={v.id} v={v} back={back} />)}</ul>
      <LocalPager path={back} params={params} pageName="cp" page={pg} anchor="corrections" count={items.length} />
    </Section>
  );
}
