"use client";
import { startTransition, useActionState, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { ActionState } from "@/lib/action-state";
import { webhookAddress } from "@/lib/connectors";
import { connectors as M } from "@/messages/connectors";

/** No draft persistence: secret fields and one-time replies live only in this form's current action result. */
export function ConnectorForm({ action, label, children, danger = false }: {
  action: (prev: ActionState, data: FormData) => Promise<ActionState>; label: string; children: ReactNode; danger?: boolean;
}) {
  const [state, send, pending] = useActionState(action, null);
  const [hiddenAt, setHiddenAt] = useState<number | null>(null);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state) ref.current?.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach((el) => { el.value = ""; });
  }, [state]);
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    // A later action replaces any previously displayed one-time secret immediately.
    setHiddenAt(state?.at ?? null);
    startTransition(() => send(form));
  }
  return <form ref={ref} action={send} onSubmit={submit} className="form full" autoComplete="off">
    {children}
    <button type="submit" className={`btn ${danger ? "danger" : "primary"}`} disabled={pending}>{pending ? M.working : label}</button>
    {state ? <div role={state.ok ? "status" : "alert"} className={`notice ${state.ok ? "ok" : "danger"}`}>
      <p>{state.message}</p>{state.lines?.map((line, i) => <p key={i}>{line}</p>)}
      {state.link ? <a href={state.link.href}>{state.link.label}</a> : null}
    </div> : null}
    {state?.secret && state.at !== hiddenAt ? <section role="status" data-once-secret>
      <h3>{state.secret.label}</h3><p>{state.secret.warning}</p><pre>{state.secret.value}</pre>
      <button type="button" className="btn" onClick={() => setHiddenAt(state.at)}>{M.hideSecret}</button>
    </section> : null}
  </form>;
}

export function WebhookPreview({ path, base }: { path: string; base: string | null }) {
  const [origin, setOrigin] = useState(base ?? "");
  const url = webhookAddress(origin, path);
  return <section><h3>{M.webhook}</h3><code>{url ?? path}</code>
    <label>{M.publicBase}<input type="url" value={origin} onChange={(e) => setOrigin(e.target.value)} autoComplete="off" /></label>
    <p className="muted">{M.publicHint}</p>
  </section>;
}
