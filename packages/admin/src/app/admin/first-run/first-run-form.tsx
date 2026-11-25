"use client";
import { rich } from "../../../i18n/rich";
import { TEXT } from "../../../messages/panel-first-run";
import Link from "next/link";
import { useEffect, useState, useTransition, type FormEvent } from "react";
import { ResultBox } from "@/components/action-form";
import { SecretBox } from "@/components/secret-box";
import { Field } from "@/components/ui";
import type { ActionResult } from "@/lib/action-state";
import { TEXT as FIRST_RUN_TEXT } from "@/lib/first-run";
import { MIN_ADMIN_PASSWORD } from "@/lib/labels";
import { firstRunAction } from "./actions";

export function FirstRunForm({ codeRequired = false }: { codeRequired?: boolean }) {
  const [state, setState] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const [ready, setReady] = useState(false);
  const [mismatch, setMismatch] = useState(false);
  useEffect(() => setReady(true), []);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    if (data.get("password") !== data.get("confirm")) { setMismatch(true); return; }
    setMismatch(false);
    startTransition(async () => setState(await firstRunAction(data)));
  }

  if (state?.ok && state.secret) {
    return (
      <div>
        <div className="notice ok" role="status">{rich(TEXT.saveTheSystemKeyToFinish, { strong1: (children) => <strong>{children}</strong> }, { value1: state.message })}</div>
        <SecretBox secret={state.secret} />
        <p className="foot">{TEXT.theSystemKeyAutomatesTheAdminAPI}</p>
        <p className="foot"><Link href="/admin/login" className="btn primary">{TEXT.keySavedGoToSignIn}</Link></p>
      </div>
    );
  }

  return (
    <form method="post" onSubmit={onSubmit} className="form">
      {codeRequired ? (
        <Field label={TEXT.setupCode} hint={FIRST_RUN_TEXT.firstRunCodeHint}>
          <input type="text" name="code" autoComplete="off" autoCapitalize="none" spellCheck={false} required autoFocus />
        </Field>
      ) : null}
      <Field label={TEXT.administratorLogin} hint={TEXT.forExampleYourWorkEmailNotCase}>
        <input type="text" name="login" autoComplete="username" autoCapitalize="none" spellCheck={false} required autoFocus={!codeRequired} maxLength={200} />
      </Field>
      <Field label={TEXT.password} hint={TEXT.atLeastCharacters(MIN_ADMIN_PASSWORD)}>
        <input type="password" name="password" autoComplete="new-password" minLength={MIN_ADMIN_PASSWORD} required />
      </Field>
      <Field label={TEXT.repeatPassword}>
        <input type="password" name="confirm" autoComplete="new-password" minLength={MIN_ADMIN_PASSWORD} required aria-invalid={mismatch || undefined} onChange={() => setMismatch(false)} />
      </Field>
      {mismatch ? <div className="field-error" role="alert">{TEXT.thePasswordsDoNotMatch2}</div> : null}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={!ready || pending}>{pending ? TEXT.creating : TEXT.createAdministrator}</button>
      </div>
      <noscript><div className="notice warn">{TEXT.javascriptMustBeEnabledForInitialSetup}</div></noscript>
      <ResultBox state={state} />
    </form>
  );
}
