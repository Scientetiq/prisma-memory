import { meetingProjectText as M } from "@/messages/ws-records";
import { rich } from "@/i18n/rich";
import { derived } from "@/i18n/runtime";
import { ActionForm } from "@/components/action-form";
import type { ConfirmSpec } from "@/components/confirm-dialog";
import { Icon } from "@/components/icons";
import { Field, Section } from "@/components/ui";
import { HANDOVER_BATCH_MAX } from "@/lib/form";
import { EVENT_KIND_TITLES } from "@/lib/labels";
import { capitalize } from "@/lib/plain";
import { handoverAllAction, meetingProjectMarkAction } from "../../actions";

export interface MeetingDecision { id: string; title: string | null; event_kind?: string | null }
export interface ProjectChoice { slug: string; name: string }

export const HANDOVER_ALL_SPEC: ConfirmSpec = derived(() => ({
  question: M.handOverTheSelectedDecisionsTo,
  change: M.eachSelectedDecisionWillBecomeA,
  who: M.allProjectMembersIncludingThoseWho,
  undo: M.youCannotTakeBackWhatHas,
  verb: M.handOver,
  ack: { name: "confirm", label: M.iHaveReviewedTheDecisionsAnd },
}));

const decisionTitle = (d: MeetingDecision): string =>
  d.title || (d.event_kind && EVENT_KIND_TITLES[d.event_kind] ? capitalize(EVENT_KIND_TITLES[d.event_kind]!) : M.untitledDecision);

export function MeetingProject({ meetingId, decisions, handTo, markTo, mark }: {
  meetingId: string; decisions: readonly MeetingDecision[]; handTo: readonly ProjectChoice[]; markTo: readonly ProjectChoice[] | null; mark: ProjectChoice | null;
}) {
  const hand = decisions.length > 0 && handTo.length > 0;
  if (!hand && !markTo) return null;
  return (
    <Section title={M.meetingAndProject} id="meeting-project" icon="briefcase"
      hint={M.theMeetingStaysWithItsOrganiser}>
      {markTo ? (
        <div className="mp-mark">
          <p className="hint">{mark ? <>{rich(M.youMarkedThisMeetingAsBelonging, { tag0: (children) => <b>{children}</b> }, { value0: mark.name })}</>
            : M.markWhichProjectThisMeetingBelongs}</p>
          <ActionForm action={meetingProjectMarkAction} submitLabel={mark ? M.changeProjectMark : M.mark} pendingLabel={M.saving} quiet className="form-inline mp-mark-form">
            <input type="hidden" name="id" value={meetingId} />
            <label className="field">
              <span className="field-label">{rich(M.projectMeeting, null)}</span>
              <select name="space" defaultValue={mark?.slug ?? ""}>
                <option value="">{rich(M.notAProjectMeeting, null)}</option>
                {markTo.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
              </select>
            </label>
          </ActionForm>
        </div>
      ) : null}
      {hand ? (
        <details className="mp-all sp-more-info">
          <summary>{rich(M.handOverAllDecisionsToA, { tag0: () => <Icon name="send" /> })}</summary>
          <ActionForm action={handoverAllAction} submitLabel={M.sendToProject} pendingLabel={M.handingOver} danger confirm={HANDOVER_ALL_SPEC}>
            <Field label={M.project}>
              <select name="to_space" required defaultValue={handTo.length === 1 ? handTo[0]!.slug : ""}>
                {handTo.length > 1 ? <option value="">{rich(M.chooseAProject, null)}</option> : null}
                {handTo.map((p) => <option key={p.slug} value={p.slug}>{p.name}</option>)}
              </select>
            </Field>
            <fieldset className="mp-list">
              <legend>{rich(M.decisionsLegend(decisions.length > HANDOVER_BATCH_MAX ? HANDOVER_BATCH_MAX : null), null)}</legend>
              {decisions.map((d, i) => (
                <label key={d.id} className="check">
                  <input type="checkbox" name="decision" value={d.id} defaultChecked={i < HANDOVER_BATCH_MAX} /> {decisionTitle(d)}
                </label>
              ))}
            </fieldset>
            <p className="hint">{rich(M.eachDecisionSTextWillBe, null)}</p>
            <label className="check ack-fallback"><input type="checkbox" name="confirm" /> {HANDOVER_ALL_SPEC.ack!.label}</label>
          </ActionForm>
        </details>
      ) : null}
    </Section>
  );
}
