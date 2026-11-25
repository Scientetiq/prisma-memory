"use client";
import { SECRET_BOX_TEXT } from "../messages/components";

import { useRef, useState } from "react";
import type { OnceSecret } from "@/lib/action-state";

export async function copyText(value: string, field?: HTMLTextAreaElement | HTMLInputElement | null): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard) { await navigator.clipboard.writeText(value); return true; }
  } catch { }
  try {
    if (field) { field.focus(); field.select(); return document.execCommand("copy"); }
  } catch { }
  return false;
}

export function SecretBox({ secret }: { secret: OnceSecret }) {
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const field = useRef<HTMLTextAreaElement>(null);

  return (
    <div className="secret-box" role="alert">
      <div className="secret-title">{secret.label}</div>
      <textarea ref={field} className="secret-value" readOnly rows={2} value={secret.value} onFocus={(e) => e.currentTarget.select()} spellCheck={false} />
      <div className="secret-actions">
        <button type="button" className="btn sm" onClick={async () => setCopied((await copyText(secret.value, field.current)) ? "done" : "failed")}>{SECRET_BOX_TEXT.copy}</button>
        {copied === "done" ? <span className="ok-text">{SECRET_BOX_TEXT.copied}</span> : null}
        {copied === "failed" ? <span className="danger-text">{SECRET_BOX_TEXT.failed}</span> : null}
      </div>
      <p className="secret-warning">{secret.warning}</p>
    </div>
  );
}
