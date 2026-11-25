export { text as CONNECT_AGENT_TEXT } from "../messages/connect-agents";
import { text as M } from "../messages/connect-agents";
import { derived } from "../i18n/runtime";
import type { IconName } from "@/components/icons";
import { OS_TITLE, type ConnectOs } from "./connect-os";
import type { OAuthClientKind, OAuthConnection } from "./oauth-connect";
import { hrefWith } from "./paging";
import type { MyKey } from "./types";

export type ConnectAgent = "claude_code" | "codex" | "cursor" | "other";
export const CONNECT_AGENTS: readonly ConnectAgent[] = ["claude_code", "codex", "cursor", "other"];
export const DEFAULT_AGENT: ConnectAgent = "claude_code";

export interface AgentInfo {
  title: string;
  by: string;
  icon: IconName;
  kind: OAuthClientKind;
  run: string | null;
  install: { posix: string; powershell: string } | { url: string } | null;
}

export const AGENT_INFO: Record<ConnectAgent, AgentInfo> = derived(() => ({
  claude_code: { title: "Claude Code", by: M.byAnthropic, icon: "sparkles", kind: "claude_code", run: "claude",
    install: { posix: "curl -fsSL https://claude.ai/install.sh | bash", powershell: "irm https://claude.ai/install.ps1 | iex" } },
  codex: { title: "Codex", by: M.byOpenai, icon: "code", kind: "codex", run: "codex",
    install: { posix: "curl -fsSL https://chatgpt.com/codex/install.sh | sh", powershell: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"' } },
  cursor: { title: "Cursor", by: M.codeEditor, icon: "mouse-pointer", kind: "cursor", run: null, install: { url: "https://cursor.com/download" } },
  other: { title: M.anotherProgram, by: M.anyAgentWithMcp, icon: "bot", kind: "cloud_other", run: null, install: null },
}));

export const isConnectAgent = (v: unknown): v is ConnectAgent => typeof v === "string" && (CONNECT_AGENTS as readonly string[]).includes(v);
export const parseAgent = (v: string): ConnectAgent => (isConnectAgent(v) ? v : DEFAULT_AGENT);

export function connectHref(s: { agent: ConnectAgent; os: ConnectOs; via?: "key" | null; cursor?: string | null }, hash = ""): string {
  return hrefWith("/connect", { agent: s.agent, os: s.os }, { via: s.via ?? null, cursor: s.cursor ?? null }) + hash;
}

export const isLiveKey = (k: Pick<MyKey, "revoked_at" | "expires_at" | "preview">, now = Date.now()): boolean =>
  !k.revoked_at && !k.preview && !(k.expires_at && Date.parse(k.expires_at) <= now);

export const isAgentKey = (k: Pick<MyKey, "client_kind">): boolean => k.client_kind !== "script";

export interface Connected { kind: OAuthClientKind; at: string; byKey: boolean }

export function connectedKinds(keys: readonly MyKey[], conns: readonly OAuthConnection[], now = Date.now()): Connected[] {
  const by = new Map<OAuthClientKind, Connected>();
  const put = (kind: OAuthClientKind, at: string, byKey: boolean) => { const p = by.get(kind); if (!p || Date.parse(at) > Date.parse(p.at)) by.set(kind, { kind, at, byKey }); };
  for (const c of conns) if (c.status === "active") put(c.client_kind, c.last_used_at ?? c.created_at, false);
  for (const k of keys) {
    const kind = k.client_kind ?? "cloud_other";
    if (kind !== "script" && k.last_used_at && isLiveKey(k, now)) put(kind, k.last_used_at, true);
  }
  return [...by.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export function defaultKeyLabel(title: string, os: ConnectOs | null, taken: Iterable<string | null | undefined>): string {
  const base = (os ? M.on(title, OS_TITLE[os]) : title).slice(0, 52);
  const busy = new Set<string>();
  for (const t of taken) if (t) busy.add(t.trim().toLowerCase());
  if (!busy.has(base.toLowerCase())) return base;
  for (let n = 2; n < 100; n++) {
    const next = `${base} (${n})`;
    if (!busy.has(next.toLowerCase())) return next;
  }
  return base;
}
