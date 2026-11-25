"use client";
import { snippetsText as M } from "@/messages/ws-keys";
import { rich } from "@/i18n/rich";
import { SERVER_PARAM } from "@/lib/mcp-server-name";

import { useState } from "react";
import { Icon } from "@/components/icons";
import { SNIPPET_KINDS, type SnippetKind } from "@/lib/snippets";

export function Snippets({ mcpUrl, secret }: { mcpUrl: string; secret?: string }) {
  const [kind, setKind] = useState<SnippetKind>("claude");
  const [copied, setCopied] = useState(false);
  const current = SNIPPET_KINDS.find((k) => k.id === kind) ?? SNIPPET_KINDS[0];
  const text = current.make(mcpUrl, secret);

  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { }
  }

  return (
    <div className="snippets">
      <div className="snippet-tabs" role="tablist">
        {SNIPPET_KINDS.map((k) => <button key={k.id} type="button" role="tab" aria-selected={k.id === kind} className={k.id === kind ? "on" : undefined} onClick={() => setKind(k.id)}>{k.title}</button>)}
      </div>
      <div className="snippet-wrap">
        <pre className="snippet"><code>{text}</code></pre>
        <button type="button" className="btn sm copy" onClick={copy}><Icon name={copied ? "check" : "copy"} />{copied ? M.copied : M.copy}</button>
      </div>
      <p className="snippet-note">
        {kind === "claude" ? rich(M.theCommandAddsTheMemoryServer, null, SERVER_PARAM) : kind === "codex" ? M.codexReadsTheKeyFromThe : kind === "cursor" ? rich(M.pasteIntoCursorMcpJsonCursor, null, SERVER_PARAM) : M.aTestMemoryMeCallIf}
        {secret ? "" : M.replaceThePlaceholderWithAKey}
      </p>
    </div>
  );
}
