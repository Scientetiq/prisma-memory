"use client";
import { CONFIRM_DIALOG_TEXT } from "../messages/components";

import { useEffect, useId, useRef, useState } from "react";

export interface ConfirmSpec {
  question: string;
  change?: string;
  who?: string;
  undo?: string;
  verb?: string;
  danger?: boolean;
  ack?: { name: string; label: string };
  fill?: string;
  cancel?: string;
}

export function confirmSpec(c: string | ConfirmSpec | undefined, verb: string, data?: FormData, danger = false): ConfirmSpec | null {
  if (!c) return null;
  if (typeof c === "string") return danger ? { question: c, verb, danger } : { question: c, verb };
  const v = c.fill ? (c.fill.split("|").map((n) => String(data?.get(n) ?? "").trim()).find(Boolean) ?? "").slice(0, 200) : "";
  return { ...c, question: c.fill ? c.question.replace("{}", v || "…") : c.question, verb: c.verb ?? verb, ...(c.danger === undefined && danger ? { danger } : {}) };
}

export function ConfirmDialog({ spec, onCancel, onConfirm }: { spec: ConfirmSpec | null; onCancel: () => void; onConfirm: (acked: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [acked, setAcked] = useState(false);
  const id = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (spec && !d.open) { setAcked(false); d.showModal(); cancelRef.current?.focus(); }
    if (!spec && d.open) d.close();
  }, [spec]);

  if (!spec) return <dialog ref={ref} className="confirm-dialog" />;
  const lines: Array<[string, string]> = [[CONFIRM_DIALOG_TEXT.change, spec.change ?? ""], [CONFIRM_DIALOG_TEXT.who, spec.who ?? ""], [CONFIRM_DIALOG_TEXT.undo, spec.undo ?? ""]];
  return (
    <dialog ref={ref} className="confirm-dialog" aria-labelledby={`${id}-q`} aria-describedby={`${id}-d`}
      onCancel={(e) => { e.preventDefault(); onCancel(); }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="confirm-body">
        <h2 id={`${id}-q`}>{spec.question}</h2>
        <dl id={`${id}-d`}>
          {lines.filter(([, v]) => v).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>
        {spec.ack ? <label className="check"><input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} /> {spec.ack.label}</label> : null}
        <div className="confirm-actions">
          <button type="button" className="btn" ref={cancelRef} onClick={onCancel}>{spec.cancel ?? CONFIRM_DIALOG_TEXT.cancel}</button>
          <button type="button" className={spec.danger ? "btn danger" : "btn primary"} disabled={Boolean(spec.ack) && !acked} onClick={() => onConfirm(acked)}>{spec.verb}</button>
        </div>
      </div>
    </dialog>
  );
}
