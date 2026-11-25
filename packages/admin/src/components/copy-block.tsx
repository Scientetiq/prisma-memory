"use client";
import { COPY_BLOCK_TEXT } from "../messages/components";

import { useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { copyText } from "@/components/secret-box";

export function CopyBlock({ text, label, wrap = false }: { text: string; label: string; wrap?: boolean }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <div className="copy-block">
      <pre className="snippet" style={wrap ? { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } : undefined}><code>{text}</code></pre>
      <textarea ref={ref} className="vis-hidden" readOnly value={text} tabIndex={-1} aria-hidden="true" />
      <button type="button" className="btn sm copy" aria-label={COPY_BLOCK_TEXT.copyLabel(label)}
        onClick={async () => { setState((await copyText(text, ref.current)) ? "done" : "failed"); setTimeout(() => setState("idle"), 2000); }}>
        <Icon name={state === "done" ? "check" : "copy"} />{state === "done" ? COPY_BLOCK_TEXT.copied : COPY_BLOCK_TEXT.copy}
      </button>
      {state === "failed" ? <p className="danger-text">{COPY_BLOCK_TEXT.failed}</p> : null}
    </div>
  );
}
