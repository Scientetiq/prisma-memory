import { bulkActorFormText as M } from "@/messages/ws-records";
import { rich } from "@/i18n/rich";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/ui";
import { LIMITS, CORRECTIONS_COPY } from "@/lib/corrections";
import { bulkActorAction } from "../../corrections/actions";

export function BulkActorForm({ meetingId }: { meetingId: string }) {
  return (
    <details className="correct-block bulk-actor" id="bulk-actor">
      <summary>{rich(M.replaceAnAssigneeInAllDecisions, null)}</summary>
      <p className="hint">{CORRECTIONS_COPY.bulkLead}</p>
      <p className="hint corr-warn">{CORRECTIONS_COPY.meetingResetNotice}</p>
      <ActionForm action={bulkActorAction} submitLabel={M.createChangePlan} pendingLabel={M.creating} quiet>
        <input type="hidden" name="meeting_id" value={meetingId} />
        <div className="form-grid">
          <Field label={M.whoToReplaceAsRecordedIn}><input name="from" required maxLength={LIMITS.actor} autoComplete="off" /></Field>
          <Field label={M.replaceWith}><input name="to" required maxLength={LIMITS.actor} autoComplete="off" /></Field>
        </div>
      </ActionForm>
    </details>
  );
}
