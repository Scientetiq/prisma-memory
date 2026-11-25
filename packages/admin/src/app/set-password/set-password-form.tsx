"use client";

import { startTransition, useActionState, useEffect, useRef, useState, type FormEvent } from "react";
import type { FormAction } from "@/components/action-form";
import { Notice } from "@/components/ui";
import { linkFromHash } from "@/lib/local-link";
import { LOCAL_SETUP } from "@/messages/local-setup";

export function SetPasswordForm({ action }: { action: FormAction }) {
  const [state, formAction, pending] = useActionState(action, null);
  const [link, setLink] = useState<string | null>(null);
  const readHash = useRef(false);
  const password = useRef<HTMLInputElement>(null);
  const repeat = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (readHash.current) return;
    readHash.current = true;
    const hash = window.location.hash;
    const setupLink = linkFromHash(hash);
    if (hash) history.replaceState(null, "", window.location.pathname);
    setLink(setupLink);
  }, []);

  useEffect(() => {
    if (!state) return;
    if (state.ok) {
      setLink(null);
      return;
    }
    if (repeat.current) repeat.current.value = "";
    if (password.current) {
      password.current.value = "";
      password.current.focus();
    }
  }, [state]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(() => formAction(data));
  }

  if (state?.ok) {
    return (
      <>
        <Notice tone="ok">{state.message}</Notice>
        <a href="/login">{LOCAL_SETUP.toSignIn}</a>
      </>
    );
  }
  if (!link) return <Notice tone="info">{LOCAL_SETUP.needsLink}</Notice>;

  return (
    <form action={formAction} onSubmit={onSubmit} className="form">
      <input type="hidden" name="link" value={link} />
      <label className="field">
        <span className="field-label">{LOCAL_SETUP.newPassword}</span>
        <input ref={password} type="password" name="password" autoComplete="new-password" maxLength={1024} required autoFocus />
        <span className="field-hint">{LOCAL_SETUP.rules}</span>
      </label>
      <label className="field">
        <span className="field-label">{LOCAL_SETUP.repeatPassword}</span>
        <input ref={repeat} type="password" name="repeat" autoComplete="new-password" maxLength={1024} required />
      </label>
      {state && !state.ok ? (
        <div className="notice danger" role="alert">
          {state.message}
          {state.lines?.length ? (
            <details className="it-details">
              <summary>{LOCAL_SETUP.details}</summary>
              <span className="muted small">{state.lines.join(" · ")}</span>
            </details>
          ) : null}
        </div>
      ) : null}
      <button type="submit" className="btn primary" disabled={pending}>{pending ? LOCAL_SETUP.saving : LOCAL_SETUP.save}</button>
    </form>
  );
}
