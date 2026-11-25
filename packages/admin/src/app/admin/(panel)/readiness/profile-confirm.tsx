import { PROFILE_CONFIRM_TEXT } from "../../../../messages/panel-readiness";
import { rich } from "../../../../i18n/rich";
import { ActionForm } from "@/components/action-form";
import { LocalTime } from "@/components/local-time";
import { Badge } from "@/components/ui";
import { confirmProfileAction } from "./actions";
import { profileConfirmText, profileView, type ProfileKey } from "./view";

export function ProfileConfirm({ keys, canConfirm, label }: { keys: readonly ProfileKey[]; canConfirm: boolean; label: string }) {
  return (
    <ul className="plain" aria-label={label}>
      {keys.map((k) => {
        const v = profileView(k);
        const t = profileConfirmText(k);
        return (
          <li key={k.key} id={`profile-${k.key}`}>
            <code className="code">{k.key}</code>
            <div className="cell-sub">{rich(PROFILE_CONFIRM_TEXT.currentTag1Value2Tag1Value3Value4, { tag1: (children) => <strong>{children}</strong> }, { value2: v.now, value3: v.cut ? PROFILE_CONFIRM_TEXT.longerValuesAreShownInFullInSettings : null, value4: v.seed !== null ? <>{rich(PROFILE_CONFIRM_TEXT.defaultValue1, null, { value1: v.seed })}</> : null })}</div>
            {k.risk ? <div className="cell-sub"><Badge tone="warn">{PROFILE_CONFIRM_TEXT.risk}</Badge> {k.risk}</div> : null}
            <div className="cell-sub">
              {k.changed_at ? <><LocalTime iso={k.changed_at} /> · </> : null}{v.who}
              {v.machine ? <> <Badge tone="warn">{k.changed_by_human === false ? PROFILE_CONFIRM_TEXT.notAPersonalSession : PROFILE_CONFIRM_TEXT.lastEditorUnknown}</Badge></> : null}
            </div>
            {canConfirm ? (
              <ActionForm action={confirmProfileAction} submitLabel={PROFILE_CONFIRM_TEXT.confirm} pendingLabel={PROFILE_CONFIRM_TEXT.confirming} compact
                confirm={{ question: t.question, change: t.change, undo: t.undo, verb: PROFILE_CONFIRM_TEXT.confirm2 }}>
                <input type="hidden" name="key" value={k.key} />
                <input type="hidden" name="digest" value={k.digest} />
              </ActionForm>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
