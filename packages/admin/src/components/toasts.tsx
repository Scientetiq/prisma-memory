"use client";
import { TOASTS_TEXT } from "../messages/components";

import { createContext, startTransition, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { ActionState } from "@/lib/action-state";
import { browserPath, isLoginLink, resultLink } from "@/lib/login-return";

export type ToastAction = (prev: ActionState, formData: FormData) => Promise<ActionState>;

export interface Toast {
  id: number;
  ok: boolean;
  message: string;
  link?: { href: string; label: string };
  undo?: { label: string; action: ToastAction; fields: Record<string, string> };
}

type Push = (t: Omit<Toast, "id">) => void;

export const toastFrom = (res: NonNullable<ActionState>, action: ToastAction): Omit<Toast, "id"> => ({
  ok: res.ok, message: res.message, link: resultLink(res, browserPath()), undo: res.undo ? { label: res.undo.label, action, fields: res.undo.fields } : undefined,
});
const ToastContext = createContext<Push | null>(null);

export const useToasts = (): Push | null => useContext(ToastContext);

const TTL = 6_000, TTL_UNDO = 12_000, MAX = 4;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(0);
  const drop = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback<Push>((t) => {
    const id = ++seq.current;
    setItems((xs) => [...xs.slice(-(MAX - 1)), { ...t, id }]);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => <ToastItem key={t.id} t={t} drop={drop} push={push} />)}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ t, drop, push }: { t: Toast; drop: (id: number) => void; push: Push }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => drop(t.id), t.undo ? TTL_UNDO : TTL);
    return () => clearTimeout(timer);
  }, [t, drop]);
  function undo() {
    if (!t.undo || busy) return;
    const fd = new FormData();
    for (const [k, v] of Object.entries(t.undo.fields)) fd.set(k, v);
    setBusy(true);
    const { action } = t.undo;
    startTransition(async () => {
      const res = await action(null, fd).catch(() => null);
      drop(t.id);
      push(res ? toastFrom(res, action) : { ok: false, message: TOASTS_TEXT.failed });
    });
  }
  return (
    <div className={`toast ${t.ok ? "ok" : "err"}`}>
      <span>{t.message}</span>
      {t.link ? <a className="toast-act" href={t.link.href} {...(isLoginLink(t.link.href) ? { target: "_blank", rel: "noopener" } : {})}>{t.link.label}</a> : null}
      {t.undo ? <button type="button" className="toast-act" onClick={undo} disabled={busy}>{busy ? "…" : t.undo.label}</button> : null}
      <button type="button" className="toast-x" onClick={() => drop(t.id)} aria-label={TOASTS_TEXT.close}>×</button>
    </div>
  );
}
