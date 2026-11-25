"use client";
// Sign-in form of admin@local: login and password, and — after the gateway answers `otp_required` — the code
// field of the second factor in the same form; the next submit sends all three. "Use a recovery code" switches the field
// between the six digits of the app and a recovery code (the gateway takes both in `otp`). The form is sent by hand, like
// ActionForm: React does not reset the typed login and password after a refusal. Without JavaScript the form posts as
// usual and the page re-renders with the code step: the login is filled in from the state, the password never is.
// The switch needs JavaScript, so the app's field has no `pattern`: without it a recovery code goes in the same field
// (the action and the gateway check the code).
import { startTransition, useActionState, useState, type FormEvent } from "react";
import { Field } from "@/components/ui";
import { loginForm } from "@/messages/login";
import { loginAction } from "./actions";
import { OTP_INPUT_MAX, OTP_TEXT, type LocalLoginState } from "./second-factor";

/** The fields of the form for a state; pure — the page test renders it for each step. */
export function LocalLoginFields({ state, recovery, onRecovery, autoFocus }: { state: LocalLoginState | null; recovery: boolean; onRecovery: () => void; autoFocus: boolean }) {
  const codeStep = state?.otp === "required" || state?.otp === "retry";
  return (
    <>
      <Field label={loginForm.login}>
        <input type="text" name="login" autoComplete="username" autoCapitalize="none" spellCheck={false} required autoFocus={autoFocus && !codeStep}
          {...(state?.login ? { defaultValue: state.login } : {})} />
      </Field>
      <Field label={loginForm.password}>
        <input type="password" name="password" autoComplete="current-password" required />
      </Field>
      {codeStep ? (
        <Field label={recovery ? OTP_TEXT.recoveryLabel : OTP_TEXT.codeLabel} hint={recovery ? OTP_TEXT.recoveryHint : OTP_TEXT.codeHint}>
          {recovery
            ? <input key="recovery" type="text" name="otp" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={OTP_INPUT_MAX} required autoFocus />
            : <input key="app" type="text" name="otp" inputMode="numeric" autoComplete="one-time-code" maxLength={OTP_INPUT_MAX} required autoFocus />}
        </Field>
      ) : null}
      {codeStep ? <p className="foot"><button type="button" className="btn quiet sm" onClick={onRecovery}>{recovery ? OTP_TEXT.useApp : OTP_TEXT.useRecovery}</button></p> : null}
    </>
  );
}

export function LocalLoginForm({ autoFocus }: { autoFocus: boolean }) {
  const [state, formAction, pending] = useActionState(loginAction, null as LocalLoginState | null);
  const [recovery, setRecovery] = useState(false);
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    startTransition(() => formAction(data));
  }
  return (
    <form action={formAction} onSubmit={onSubmit} className="form full">
      <LocalLoginFields state={state} recovery={recovery} onRecovery={() => setRecovery((r) => !r)} autoFocus={autoFocus} />
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={pending}>{pending ? loginForm.pending : loginForm.submit}</button>
      </div>
      {state && !state.ok ? (
        <div className="result">
          {/* the first ask for the code is a step, not a refusal */}
          <div className={state.otp === "required" ? "notice info" : "notice danger"} role={state.otp === "required" ? "status" : "alert"}>
            <strong>{state.message}</strong>
            {state.lines?.length ? <ul className="lines">{state.lines.map((l, i) => <li key={i}>{l}</li>)}</ul> : null}
          </div>
        </div>
      ) : null}
    </form>
  );
}
