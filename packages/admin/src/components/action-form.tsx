"use client";
import { ACTION_FORM_TEXT } from "../messages/components";
import { rich } from "../i18n/rich";

import { startTransition, useActionState, useEffect, useId, useRef, useState, useSyncExternalStore, useTransition, type FormEvent, type ReactNode } from "react";
import type { ActionState } from "@/lib/action-state";
import { ACCESS_ACTION } from "@/lib/closed-class";
import { applyDraft, clearDraft, collectDraft, readDraft, sessionStore, writeDraft, type DraftField } from "@/lib/draft";
import { browserPath, isLoginLink, resultLink } from "@/lib/login-return";
import { ConfirmDialog, confirmSpec, type ConfirmSpec } from "./confirm-dialog";
import { Icon, type IconName } from "./icons";
import { withClientTz } from "@/lib/local-datetime";
import { SecretBox } from "./secret-box";
import { toastFrom, useToasts } from "./toasts";

const STEP_MARK = { ok: "✓", fail: "✕", warn: "!", skip: "–" } as const;
import { STEP_LABEL } from "../messages/components";

export type FormAction = (prev: ActionState, formData: FormData) => Promise<ActionState>;

export interface AskSpec { name: string; label: string }

export function AskField({ ask, state }: { ask?: AskSpec | readonly AskSpec[]; state: ActionState }) {
  const spec = (Array.isArray(ask) ? ask : ask ? [ask] : []).find((a: AskSpec) => a.name === state?.ask);
  if (!spec || !state) return null;
  return (
    <>
      {Object.entries(state.askKeep ?? {}).map(([name, value]) => <input key={`${state.at}-${name}`} type="hidden" name={name} value={value} />)}
      <label className="check"><input key={state.at} type="checkbox" name={spec.name} {...(state.askValue !== undefined ? { value: state.askValue } : {})} /> {state.askLabel ?? spec.label}</label>
    </>
  );
}

const noSubscribe = () => () => undefined;

export function ResultLink({ state, inline }: { state: Pick<NonNullable<ActionState>, "ok" | "message" | "link">; inline?: boolean }) {
  const here = useSyncExternalStore(noSubscribe, browserPath, () => null);
  const link = resultLink(state, here);
  if (!link) return null;
  const a = <a href={link.href} {...(isLoginLink(link.href) ? { target: "_blank", rel: "noopener" } : {})}>{link.label}</a>;
  return inline ? <> {a}</> : <p className="result-link">{a}</p>;
}

export function ResultBox({ state, compact, children }: { state: ActionState; compact?: boolean; children?: (state: NonNullable<ActionState>) => ReactNode }) {
  if (!state) return null;
  if (compact) return <span className={state.ok ? "ok-text" : "danger-text"} role="status">{state.message}<ResultLink state={state} inline /></span>;
  return (
    <div className="result">
      <div className={`notice ${state.ok ? "ok" : "danger"}`} role={state.ok ? "status" : "alert"}>
        <strong>{state.message}</strong>
        {state.steps?.length ? (
          <ol className="steps">
            {state.steps.map((st, i) => (
              <li key={i} className={`step ${st.status}`}>
                <span className="step-mark" aria-label={STEP_LABEL[st.status]}>{STEP_MARK[st.status]}</span>
                <strong>{st.title}</strong> <span>{st.message}</span>
              </li>
            ))}
          </ol>
        ) : null}
        {state.lines?.length ? <ul className="lines">{state.lines.map((l, i) => <li key={i}>{l}</li>)}</ul> : null}
        <ResultLink state={state} />
        {state.record ? (
          <p className="result-record">
            <a href={`/records/${state.record.id}`}>{ACTION_FORM_TEXT.openRecord}</a>
            <code className="code">{state.record.path}</code>
            <span className="muted small">{rich(ACTION_FORM_TEXT.recordActions, null, { value1: ACCESS_ACTION.show })}</span>
          </p>
        ) : null}
      </div>
      {state.secret ? <SecretBox secret={state.secret} /> : null}
      {children ? children(state) : null}
    </div>
  );
}

interface Props {
  action: FormAction;
  children: ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  resetOnSuccess?: boolean;
  compact?: boolean;
  danger?: boolean;
  quiet?: boolean;
  confirm?: string | ConfirmSpec;
  className?: string;
  extra?: (state: NonNullable<ActionState>) => ReactNode;
  disabled?: boolean;
  ask?: AskSpec | readonly AskSpec[];
  icon?: IconName;
  note?: ReactNode;
  draft?: string;
  askEpoch?: number;
  notify?: boolean;
}

export function ActionForm({ action, children, submitLabel, pendingLabel, resetOnSuccess = false, compact = false, danger = false, quiet = false, confirm, className, extra, disabled, ask, icon, note, draft, notify = false, askEpoch }: Props) {
  const [ssrState, formAction, ssrPending] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  const toast = useToasts();
  const viaToast = (compact || notify) && toast !== null;
  const [jsState, setJsState] = useState<ActionState>(null);
  const [jsPending, startJs] = useTransition();
  const state = jsState ?? ssrState;
  const pending = ssrPending || jsPending;
  const latest = useRef<ActionState>(state);
  latest.current = state;
  const [askFor, setAskFor] = useState<{ state: ActionState; epoch: number | undefined }>({ state, epoch: askEpoch });
  if (askFor.state !== state) setAskFor({ state, epoch: askEpoch });
  const askLive = askFor.state !== state || askFor.epoch === askEpoch;
  const [asking, setAsking] = useState<{ spec: ConfirmSpec; data: FormData } | null>(null);
  const [live, setLive] = useState(false);
  useEffect(() => setLive(true), []);
  const noteId = useId();

  useEffect(() => {
    if (state?.ok && resetOnSuccess) ref.current?.reset();
  }, [state, resetOnSuccess]);

  useEffect(() => {
    const form = ref.current;
    if (!draft || !form) return;
    const store = sessionStore();
    const fields = () => Array.from(form.elements) as unknown as DraftField[];
    applyDraft(fields(), readDraft(store, draft));
    const save = () => writeDraft(store, draft, collectDraft(fields()));
    form.addEventListener("input", save);
    form.addEventListener("change", save);
    return () => { form.removeEventListener("input", save); form.removeEventListener("change", save); };
  }, [draft]);
  useEffect(() => {
    if (draft && state?.ok) clearDraft(sessionStore(), draft);
  }, [state, draft]);

  function send(data: FormData) {
    if (!viaToast) return startTransition(() => formAction(data));
    startJs(async () => {
      const res = await action(latest.current, data);
      startTransition(() => setJsState(res));
      if (res && (compact || res.ok)) toast?.(toastFrom(res, action));
    });
  }
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const submitter = (e.nativeEvent as SubmitEvent).submitter;
    const data = withClientTz(new FormData(e.currentTarget, submitter));
    const spec = confirmSpec(confirm, submitLabel, data, danger);
    if (spec) return setAsking({ spec, data });
    send(data);
  }
  function onConfirm(acked: boolean) {
    if (!asking) return;
    const { spec, data } = asking;
    if (spec.ack && acked) data.set(spec.ack.name, "on");
    setAsking(null);
    send(data);
  }

  const inline = compact && (!viaToast || !live || (ssrState !== null && jsState === null));
  const btnClass = danger ? "btn danger" : quiet ? "btn" : "btn primary";
  return (
    <form ref={ref} action={formAction} onSubmit={onSubmit} className={className ?? (compact ? "form-inline" : "form full")} data-js={live ? "" : undefined}>
      {children}
      {askLive ? <AskField ask={ask} state={state} /> : null}
      <div className={compact ? "form-inline-actions" : "form-actions"}>
        <button type="submit" className={compact && !danger ? `${btnClass} sm` : btnClass} disabled={pending || disabled} aria-describedby={note ? noteId : undefined}>
          {icon && !pending ? <Icon name={icon} /> : null}{pending ? pendingLabel ?? ACTION_FORM_TEXT.sending : submitLabel}
        </button>
        {note ? <span className="form-note" id={noteId}>{note}</span> : null}
        {inline ? <ResultBox state={state} compact /> : null}
      </div>
      {compact ? null : <ResultBox state={notify && viaToast && jsState?.ok ? null : state}>{extra}</ResultBox>}
      {confirm ? <ConfirmDialog spec={asking?.spec ?? null} onCancel={() => setAsking(null)} onConfirm={onConfirm} /> : null}
    </form>
  );
}
