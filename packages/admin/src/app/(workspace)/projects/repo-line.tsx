"use client";
import { repoLine as M } from "@/messages/ws-projects";
import { useRef, useState } from "react";
import { Icon } from "@/components/icons";
import { copyText } from "@/components/secret-box";

export function RepoLine({ line }: { line: string }) {
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const field = useRef<HTMLTextAreaElement>(null);
  return (
    <div className="repo-line">
      <textarea ref={field} className="repo-line-value" rows={1} readOnly value={line} spellCheck={false} aria-label={M.lineForClaudeMdOrAgentsMd} onFocus={(e) => e.currentTarget.select()} />
      <button type="button" className="btn sm" onClick={async () => setCopied((await copyText(line, field.current)) ? "done" : "failed")}>
        <Icon name={copied === "done" ? "check" : "copy"} />{copied === "done" ? M.copied : M.copy}
      </button>
      {copied === "failed" ? <span className="danger-text">{M.couldNotCopySelectTheLineAnd}</span> : null}
    </div>
  );
}
