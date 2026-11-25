"use client";
import { copyButtonText as M } from "@/messages/ws-connect";
import { rich } from "@/i18n/rich";

import { useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/icons";
import { copyText } from "@/components/secret-box";

export function CopyButton({ text, label, children, quiet = false }: { text: string; label: string; children: ReactNode; quiet?: boolean }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <span className={`cn-copy${quiet ? " quiet" : ""}`}>
      <button type="button" className={quiet ? "btn" : "btn primary cn-big"}
        onClick={async () => { setState((await copyText(text, ref.current)) ? "done" : "failed"); setTimeout(() => setState("idle"), 2500); }}>
        <Icon name={state === "done" ? "check" : "copy"} />{state === "done" ? M.copied : children}
      </button>
      <textarea ref={ref} className="vis-hidden" readOnly value={text} tabIndex={-1} aria-hidden="true" />
      <span className="vis-hidden" role="status">{state === "done" ? M.copied2(label) : ""}</span>
      {state === "failed" ? <span className="danger-text cn-copy-fail">{rich(M.couldNotCopySelectTheText, null)}</span> : null}
    </span>
  );
}
