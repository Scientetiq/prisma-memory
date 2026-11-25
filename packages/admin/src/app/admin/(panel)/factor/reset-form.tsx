import { RESET_FORM_TEXT } from "../../../../messages/panel-factor";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/ui";
import { resetFactorAction } from "./actions";
import { RESET_REASON_MAX, RESET_REASON_MIN, VIEW_TEXT } from "./view";

export function ResetForm({ personId, name }: { personId: string; name: string }) {
  return (
    <ActionForm action={resetFactorAction} submitLabel={RESET_FORM_TEXT.resetSecondFactor} pendingLabel={RESET_FORM_TEXT.resetting} danger resetOnSuccess
      confirm={{ question: VIEW_TEXT.resetConfirm, change: RESET_FORM_TEXT.value1WillLoseExternalCodeSignInTheirExternal(name),
        who: RESET_FORM_TEXT.theColleagueWillReceiveAnEmailAdministratorsAndSecurity, undo: RESET_FORM_TEXT.thisCannotBeUndoneTheColleagueWillSetUp,
        verb: RESET_FORM_TEXT.reset, danger: true }}>
      <input type="hidden" name="person_id" value={personId} />
      <Field label={RESET_FORM_TEXT.reason} hint={RESET_FORM_TEXT.whyAreYouResettingItUseValue1Value2Characters(RESET_REASON_MIN, RESET_REASON_MAX)} wide>
        <textarea name="reason" rows={2} minLength={RESET_REASON_MIN} maxLength={RESET_REASON_MAX} required placeholder={RESET_FORM_TEXT.forExamplePhoneLostNoRecoveryCodes} />
      </Field>
      <label className="check"><input type="checkbox" name="identity_confirmed" required /> {VIEW_TEXT.identityLabel}</label>
      <label className="check"><input type="checkbox" name="manager_confirmed" required /> {VIEW_TEXT.managerLabel}</label>
    </ActionForm>
  );
}
