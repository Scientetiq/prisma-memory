"use client";
import { newProjectForm as M } from "@/messages/ws-projects";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { ActionForm, type FormAction } from "@/components/action-form";
import { nextFieldName, FORM_TEXT, openAckMissing } from "@/lib/form";

export function NewProjectForm({ action, children }: { action: FormAction; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [cls, setCls] = useState("open");
  const [ack, setAck] = useState(false);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const root = ref.current;
    const checked = root?.querySelector<HTMLInputElement>('input[name="default_class"]:checked');
    if (checked) setCls(checked.value);
    setAck(Boolean(root?.querySelector<HTMLInputElement>('input[name="open_ack"]')?.checked));
    setLive(true);
  }, []);

  function onChange(e: FormEvent<HTMLDivElement>) {
    const t = e.target as HTMLInputElement;
    if (t.name === "default_class" && t.checked) setCls(t.value);
    else if (t.name === "open_ack") setAck(t.checked);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const t = e.target;
    if (e.key !== "Enter" || e.nativeEvent.isComposing || !(t instanceof HTMLInputElement)) return;
    if (t.type !== "text" || t.getAttribute("role") === "combobox" || !t.form) return;
    e.preventDefault();
    const next = nextFieldName(t.name);
    const el = next ? t.form.elements.namedItem(next) : null;
    if (el instanceof HTMLElement) el.focus();
    else t.form.querySelector<HTMLButtonElement>('button[type="submit"]')?.focus();
  }

  const missing = live && openAckMissing(cls, ack);
  return (
    <div ref={ref} className="np-wrap" onChange={onChange} onKeyDown={onKeyDown}>
      <ActionForm action={action} submitLabel={M.createProject} pendingLabel={M.creating} className="form full np-form" disabled={missing} note={missing ? FORM_TEXT.openAckNote : undefined}>
        {children}
      </ActionForm>
    </div>
  );
}
