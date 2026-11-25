import { recordActions as M } from "@/messages/ws-projects";
import { ActionForm } from "@/components/action-form";
import { Notice } from "@/components/ui";
import { ACCESS_ACTION, CLOSED_CLASS_TEXT, derivedInList, OPEN_CLASS_SPEC } from "@/lib/closed-class";
import { TRASH_TEXT } from "@/lib/trash";
import type { ListEntry } from "@/lib/types";
import { closeAction, deleteAction, openAction } from "../actions";

export function RecordActions({ e, id, mine }: { e: ListEntry; id: string; mine: boolean }) {
  return (
    <details className="sp-acts">
      <summary>{M.actions}</summary>
      <span className="acts">
        {mine && e.class === "closed" && !derivedInList(e) ? (
          <details>
            <summary>{ACCESS_ACTION.show}</summary>
            <Notice tone="warn"><strong>{CLOSED_CLASS_TEXT.openClassLead}</strong> {CLOSED_CLASS_TEXT.openClassWarning}</Notice>
            <ActionForm action={openAction} submitLabel={ACCESS_ACTION.show} pendingLabel="…" danger confirm={OPEN_CLASS_SPEC}>
              <input type="hidden" name="id" value={id} />
              <label className="check ack-fallback"><input type="checkbox" name="confirm" /> {M.iUnderstandTheConsequences}</label>
            </ActionForm>
          </details>
        ) : null}
        {e.class === "open" && !derivedInList(e) && !e.hidden ? (
          <ActionForm action={closeAction} submitLabel={ACCESS_ACTION.hide} pendingLabel="…" compact danger confirm={CLOSED_CLASS_TEXT.closeClassConfirm}>
            <input type="hidden" name="id" value={id} />
          </ActionForm>
        ) : null}
        <ActionForm action={deleteAction} submitLabel={M.delete} pendingLabel="…" compact danger confirm={TRASH_TEXT.deleteConfirm}>
          <input type="hidden" name="id" value={id} />
        </ActionForm>
      </span>
    </details>
  );
}
