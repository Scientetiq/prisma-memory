"use client";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { copyText } from "@/components/secret-box";
import { WS_EXTERNAL_MESSAGES, codesFileText } from "./texts";

export function CodesOnce({ codes, title, lines }: { codes: readonly string[]; title: string; lines?: readonly string[] }) {
  const router = useRouter();
  const [saved, setSaved] = useState(false);
  const [closed, setClosed] = useState(false);
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const field = useRef<HTMLTextAreaElement>(null);
  const text = codes.join("\n");
  if (closed) return <div className="notice ok" role="status"><strong>{title}</strong></div>;

  const download = (): void => {
    const url = URL.createObjectURL(new Blob([codesFileText(codes)], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = WS_EXTERNAL_MESSAGES.recoveryCodesTxt;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="secret-box factor-codes" role="alert">
      <div className="secret-title">{title}</div>
      {lines?.length ? <ul className="lines">{lines.map((l) => <li key={l}>{l}</li>)}</ul> : null}
      <p className="secret-warning">{WS_EXTERNAL_MESSAGES.codesWarning}</p>
      <textarea ref={field} className="secret-value" readOnly rows={Math.min(codes.length, 10)} value={text} onFocus={(e) => e.currentTarget.select()} spellCheck={false} />
      <div className="secret-actions">
        <button type="button" className="btn sm" onClick={async () => setCopied((await copyText(text, field.current)) ? "done" : "failed")}>{WS_EXTERNAL_MESSAGES.copy}</button>
        <button type="button" className="btn sm" onClick={download}>{WS_EXTERNAL_MESSAGES.downloadTxt}</button>
        {copied === "done" ? <span className="ok-text">{WS_EXTERNAL_MESSAGES.copied}</span> : null}
        {copied === "failed" ? <span className="danger-text">{WS_EXTERNAL_MESSAGES.couldNotCopySelectThe}</span> : null}
      </div>
      <label className="check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.currentTarget.checked)} /> {WS_EXTERNAL_MESSAGES.codesSavedLabel}</label>
      <div className="row-actions">
        <button type="button" className="btn primary" disabled={!saved} onClick={() => { setClosed(true); router.refresh(); }}>{WS_EXTERNAL_MESSAGES.done}</button>
      </div>
    </div>
  );
}
