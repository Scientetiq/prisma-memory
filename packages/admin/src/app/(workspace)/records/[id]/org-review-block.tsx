import { orgReviewBlockText as M } from "@/messages/ws-records";
import { rich } from "@/i18n/rich";
import type { ReactNode } from "react";
import { ActionForm } from "@/components/action-form";
import { Badge, Notice, Section } from "@/components/ui";
import {
  ORG_REVIEW_TEXT, ORG_DONE, ORG_PARTIAL, VIEW_BADGE, WRONG_REASONS, authorReturnConfirm, isOrgOp, isOrgPartial, myWrongText, recordReviewLines,
  wrongGroups,
} from "@/lib/org-review";
import type { RecordOrgReview } from "@/lib/types";
import { orgReviewAction } from "../../review/actions";

function Op({ id, op, label, confirm, danger, back, children }: { id: string; op: string; label: string; confirm?: string; danger?: boolean; back?: string; children?: ReactNode }) {
  return (
    <ActionForm action={orgReviewAction} submitLabel={label} pendingLabel="…" quiet={!danger} danger={danger} confirm={confirm}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="op" value={op} />
      <input type="hidden" name="back" value={back ?? `/records/${id}`} />
      {children}
    </ActionForm>
  );
}

export function OrgReviewBlock({ id, v, whereName, done, preview, card, old }: { id: string; v: RecordOrgReview; whereName: string | null; done: string; preview: boolean; card?: boolean; old?: boolean }) {
  const lines = recordReviewLines(v, whereName, { card, old });
  const mine = v.marks.mine;
  const acts = !preview && (v.can.useful || mine.useful || v.can.wrong || v.can.confirm || v.can.return || v.can.delete);
  return (
    <Section title={M.companyKnowledge} id="org-review" icon="building"
      actions={v.view ? <Badge tone={VIEW_BADGE[v.view].tone}>{VIEW_BADGE[v.view].text}</Badge> : undefined}>
      {isOrgOp(done) ? <Notice tone="ok">{ORG_DONE[done]}</Notice> : null}
      {isOrgPartial(done) ? <Notice tone="warn">{ORG_PARTIAL[done]}</Notice> : null}
      {lines.map((l, i) => <p key={i} className="hint">{l}</p>)}
      {v.marks.useful ? <p className="hint">{M.usefulCount(v.marks.useful, v.marks.useful_teams ?? 0)}</p> : null}
      {v.curator && v.wrong_marks?.length ? (
        <p className="hint">{M.wrongGroupLines(wrongGroups(v.wrong_marks))}</p>
      ) : null}
      {preview ? <p className="hint">{rich(M.previewIsReadOnly, null)}</p> : null}
      {acts ? (
        <div className="actions-col">
          {mine.useful ? <Op id={id} op="unuseful" label={M.removeUseful} />
            : v.can.useful ? <><Op id={id} op="useful" label={M.useful} /><p className="hint">{ORG_REVIEW_TEXT.usefulHint}</p></> : null}
          {mine.wrong ? <><p className="hint">{myWrongText(mine.wrong)}</p><Op id={id} op="unwrong" label={M.undoAnnotation} /></>
            : v.can.wrong ? (
              <details>
                <summary>{rich(M.wrongNotForEveryone, null)}</summary>
                <p className="hint">{ORG_REVIEW_TEXT.wrongHint}</p>
                <Op id={id} op="wrong" label={M.mark} confirm={ORG_REVIEW_TEXT.wrongConfirm} danger>
                  <fieldset className="field">
                    {WRONG_REASONS.map((r) => <label key={r.value} className="check"><input type="radio" name="reason" value={r.value} required /> {r.label}</label>)}
                  </fieldset>
                  <label className="field"><span className="field-label">{rich(M.whatIsCorrectForWrong, null)}</span>
                    <textarea name="text" rows={3} maxLength={2000} placeholder={M.forExampleApprovalTakes5Working} />
                  </label>
                </Op>
              </details>
            ) : null}
          {v.can.confirm ? <Op id={id} op="confirm" label={M.confirm} confirm={ORG_REVIEW_TEXT.confirmReview} /> : null}
          {v.can.return ? <Op id={id} op="return" label={v.author && !v.curator ? M.returnToSource : M.restore} back={v.curator ? "/review" : undefined}
            confirm={v.author ? authorReturnConfirm(whereName) : M.returnTheRecordToWhereIt} /> : null}
          {v.can.delete ? <Op id={id} op="delete" label={M.delete} danger back="/review"
            confirm={M.deleteTheRecordItWillReturn} /> : null}
        </div>
      ) : null}
    </Section>
  );
}
