// The choice of the default for new records in the personal space: hidden from agents,
// visible to agents after the secrets check (with the honest line under it), or the administrator's default. When people may
// not choose, the administrator's default is stated in words and there is no form. Fields are rendered on the server inside
// ActionForm, so the form also works without JavaScript.
import { ActionForm } from "@/components/action-form";
import { Notice } from "@/components/ui";
import { checkedChoice, defaultTitle, type UploadDefault } from "@/lib/agent-view";
import { avText } from "@/lib/agent-view.messages";
import { setUploadDefaultAction } from "./actions";

export function DefaultForm({ value }: { value: UploadDefault }) {
  const checkOff = value.open_check_enabled ? null : <Notice tone="warn">{avText("default_check_off")}</Notice>;
  if (!value.choice_allowed) {
    return <>{checkOff}<p>{avText("default_fixed", { value: defaultTitle(value.instance_default) })}</p></>;
  }
  const checked = checkedChoice(value);
  const option = (v: "closed" | "open" | "default", label: string, note?: string) => (
    <label className="check agent-view-choice">
      <input type="radio" name="value" value={v} defaultChecked={checked === v} />
      <span>{label}{note ? <span className="hint">{note}</span> : null}</span>
    </label>
  );
  return (
    <>
      {checkOff}
      <ActionForm action={setUploadDefaultAction} submitLabel={avText("default_save")} pendingLabel={avText("default_saving")} quiet>
        <fieldset className="agent-view-choices">
          <legend className="vis-hidden">{avText("default_title")}</legend>
          {option("closed", avText("default_hidden"))}
          {option("open", avText("default_visible"), avText("default_visible_note"))}
          {option("default", avText("default_admin", { value: defaultTitle(value.instance_default) }))}
        </fieldset>
      </ActionForm>
    </>
  );
}
