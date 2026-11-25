"use client";
import { TEST_AFTER_SAVE_TEXT } from "../messages/components";
export { TEST_AFTER_SAVE_TEXT } from "../messages/components";

import { startTransition, useActionState, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ResultBox, type FormAction } from "@/components/action-form";
import { sectionFormSelector, SETTINGS_DIRTY_EVENT, SETTINGS_SAVED_EVENT, type SettingsDirtyDetail, type SettingsSavedDetail } from "@/lib/settings-events";

interface Props {
  section: string; action: FormAction; children: ReactNode;
  label: string; saveLabel: string; pendingLabel?: string;
}

export function TestAfterSave({ section, action, children, label, saveLabel, pendingLabel = TEST_AFTER_SAVE_TEXT.sending }: Props) {
  const [state, formAction, pending] = useActionState(action, null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const waiting = useRef<FormData | null>(null);

  useEffect(() => {
    const onDirty = (e: Event) => { const d = (e as CustomEvent<SettingsDirtyDetail>).detail; if (d?.section === section) setDirty(Boolean(d.dirty)); };
    const onSaved = (e: Event) => {
      const d = (e as CustomEvent<SettingsSavedDetail>).detail;
      if (d?.section !== section || !waiting.current) return;
      const data = waiting.current;
      waiting.current = null;
      setSaving(false);
      if (!d.ok) return setNote(TEST_AFTER_SAVE_TEXT.saveFailedText);
      startTransition(() => formAction(data));
    };
    window.addEventListener(SETTINGS_DIRTY_EVENT, onDirty);
    window.addEventListener(SETTINGS_SAVED_EVENT, onSaved);
    return () => { window.removeEventListener(SETTINGS_DIRTY_EVENT, onDirty); window.removeEventListener(SETTINGS_SAVED_EVENT, onSaved); };
  }, [section, formAction]);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setNote(null);
    const data = new FormData(e.currentTarget);
    const settings = dirty ? document.querySelector<HTMLFormElement>(sectionFormSelector(section)) : null;
    if (!settings) return startTransition(() => formAction(data));
    const save = settings.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (save?.disabled) return setNote(TEST_AFTER_SAVE_TEXT.saveFailedText);
    waiting.current = data;
    setSaving(true);
    settings.requestSubmit();
  }

  const busy = pending || saving;
  return (
    <form action={formAction} onSubmit={onSubmit} className="form full" data-inpage="after-save">
      {children}
      <div className="form-actions">
        <button type="submit" className="btn" disabled={busy}>{saving ? TEST_AFTER_SAVE_TEXT.saving : pending ? pendingLabel : dirty ? saveLabel : label}</button>
        {dirty && !busy ? <span className="muted small">{TEST_AFTER_SAVE_TEXT.hint}</span> : null}
      </div>
      {note ? <div className="notice danger" role="alert">{note}</div> : null}
      <ResultBox state={state} />
    </form>
  );
}
