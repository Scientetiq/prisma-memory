"use client";

import { startTransition, useActionState, useEffect, useRef, type FormEvent } from "react";
import type { FormAction } from "@/components/action-form";
import { LOCAL_SIGNIN } from "../../messages/local-signin";
import { TEXT } from "../../messages/ws-login";

export function LocalLoginForm({ action, next = null, autoFocus = false }: { action: FormAction; next?: string | null; autoFocus?: boolean }) {
  const [state, formAction, pending] = useActionState(action, null);
  const password = useRef<HTMLInputElement>(null);
  // After a successful sign-in the next page is loaded as a new document, so that it is served with its own response
  // headers (the agent consent page with its own policy) and is never shown inside the document of /login.
  const leaving = Boolean(state?.ok && state.fullLoadTo);
  useEffect(() => {
    if (state?.ok && state.fullLoadTo) window.location.assign(state.fullLoadTo);
    if (state && !state.ok && password.current) {
      password.current.value = "";
      password.current.focus();
    }
  }, [state]);
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    startTransition(() => formAction(data));
  }
  return (
    <form action={formAction} onSubmit={onSubmit} className="form">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <label className="field">
        <span className="field-label">{LOCAL_SIGNIN.email}</span>
        <input type="email" name="login" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={200} required autoFocus={autoFocus} />
      </label>
      <label className="field">
        <span className="field-label">{LOCAL_SIGNIN.password}</span>
        <input ref={password} type="password" name="password" autoComplete="current-password" maxLength={1024} required />
      </label>
      {state && !state.ok ? (
        <div className="notice danger" role="alert">
          {state.message}
          {state.lines?.length ? (
            <details className="it-details"><summary>{TEXT.detailsForAdministrators}</summary><span className="muted small">{state.lines.join(" · ")}</span></details>
          ) : null}
        </div>
      ) : null}
      <button type="submit" className="btn primary" disabled={pending || leaving}>{pending || leaving ? LOCAL_SIGNIN.signingIn : LOCAL_SIGNIN.signIn}</button>
    </form>
  );
}
