"use client";
import { copyLinkText as M } from "@/messages/ws-records";
import { rich } from "@/i18n/rich";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { copyText } from "@/components/secret-box";

export function CopyLink() {
  const [href, setHref] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setHref(`${window.location.origin}${window.location.pathname}`), []);
  if (!href) return null;
  return (
    <span className="copy-link">
      <button type="button" className="btn sm"
        onClick={async () => { setState((await copyText(href, field.current)) ? "done" : "failed"); setTimeout(() => setState("idle"), 2500); }}>
        <Icon name={state === "done" ? "check" : "copy"} />{state === "done" ? M.copied : M.copyLink}
      </button>
      <textarea ref={field} className="vis-hidden" readOnly value={href} tabIndex={-1} aria-hidden="true" />
      <span className="vis-hidden" role="status">{state === "done" ? M.recordLinkCopied : ""}</span>
      {state === "failed" ? <span className="danger-text">{rich(M.couldNotCopyTheLinkCopy, null)}</span> : null}
    </span>
  );
}
