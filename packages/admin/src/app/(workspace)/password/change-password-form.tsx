"use client";

import { useActionState, useEffect, useRef } from "react";
import { ResultLink, type FormAction } from "@/components/action-form";
import { Notice } from "@/components/ui";
import { LOCAL_CHANGE } from "@/messages/local-change";

export function ChangePasswordForm({ action }: { action: FormAction }) {
  const [state, formAction, pending] = useActionState(action, null);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state) form.current?.reset();
  }, [state]);

  return (
    <form ref={form} action={formAction} className="form">
      <label className="field">
        <span className="field-label">{LOCAL_CHANGE.current}</span>
        <input type="password" name="current" autoComplete="current-password" maxLength={1024} required autoFocus />
      </label>
      <label className="field">
        <span className="field-label">{LOCAL_CHANGE.newPassword}</span>
        <input type="password" name="next" autoComplete="new-password" aria-describedby="new-password-rules" maxLength={1024} required />
        <span className="field-hint" id="new-password-rules">{LOCAL_CHANGE.rules}</span>
      </label>
      <label className="field">
        <span className="field-label">{LOCAL_CHANGE.repeatPassword}</span>
        <input type="password" name="repeat" autoComplete="new-password" maxLength={1024} required />
      </label>
      {state ? (
        <Notice tone={state.ok ? "ok" : "danger"}>
          {state.message}
          {state.lines?.length ? (
            <details className="it-details">
              <summary>{LOCAL_CHANGE.details}</summary>
              <span className="muted small">{state.lines.join(" · ")}</span>
            </details>
          ) : null}
          {state.link ? <ResultLink state={state} /> : null}
        </Notice>
      ) : null}
      <button type="submit" className="btn primary" disabled={pending}>{pending ? LOCAL_CHANGE.saving : LOCAL_CHANGE.save}</button>
    </form>
  );
}
