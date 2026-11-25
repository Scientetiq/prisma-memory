import { derived } from "../i18n/runtime";
import { builtinConnectCopy } from "../messages/oauth-connect";
import { text as M } from "../messages/oauth-connect";
import { MCP_SERVER_NAME } from "./mcp-server-name";
import type { ClientKind, Page } from "./types";

export type OAuthClientKind = Exclude<ClientKind, "script">;
export interface AgentAuthConnect { mode: "external" | "builtin" | "off"; ready: boolean; issuer: string; mcp_url: string; cimd_needs_egress?: boolean }
export interface OAuthConnectConfig { enabled: boolean; issuer: string; resource_url: string; scope: string; allowed_clients: Record<string, OAuthClientKind>; connection_days: number; agent_auth?: AgentAuthConnect }
export interface OAuthConnection { id: string; client_id: string; client_kind: OAuthClientKind; created_at: string; last_used_at: string | null; expires_at: string; revoked_at: string | null; expires_warning: string | null; status: "active" | "expired" | "revoked"; origin?: "keycloak" | "edge" | "builtin" }
export type OAuthConnectionsPage = Page<OAuthConnection>;
export type OAuthShell = "posix" | "powershell";
export type ConnectVia = "oauth" | "key";

export function connectVia(oauthOn: boolean, via: string): ConnectVia { return oauthOn && via !== "key" ? "oauth" : "key"; }

/** Shell quoting applies even to administrator-controlled URLs and client IDs. No secret enters the command. */
export function shellQuote(value: string, shell: OAuthShell): string {
  if (/[\r\n\0]/.test(value)) throw new Error(M.invalidLineBreakInConnectionParameters);
  return shell === "powershell" ? "'" + value.replaceAll("'", "''") + "'" : "'" + value.replaceAll("'", "'\"'\"'") + "'";
}
export function oauthCommands(cfg: OAuthConnectConfig, clientId: string, shell: OAuthShell): string | null {
  if (!Object.hasOwn(cfg.allowed_clients, clientId)) return null;
  const q = (value: string) => shellQuote(value, shell), kind = cfg.allowed_clients[clientId];
  if (kind === "codex") return `codex mcp add ${MCP_SERVER_NAME} --url ${q(cfg.resource_url)} --oauth-client-id ${q(clientId)} --oauth-resource ${q(cfg.resource_url)}\ncodex mcp login ${MCP_SERVER_NAME} --scopes ${q(cfg.scope)}`;
  if (kind === "claude_code") return `claude mcp add --transport http --scope user --client-id ${q(clientId)} --callback-port 8766 ${MCP_SERVER_NAME} ${q(cfg.resource_url)}\nclaude mcp login ${MCP_SERVER_NAME}`;
  return null;
}

export function clientIdFor(cfg: Pick<OAuthConnectConfig, "allowed_clients">, kind: OAuthClientKind): string | null {
  for (const [id, k] of Object.entries(cfg.allowed_clients)) if (k === kind) return id;
  return null;
}

/** A key-based prisma-memory connection blocks the new one (`mcp add` refuses an existing name): the command that removes it, per program. */
export function removeCommand(kind: OAuthClientKind): string | null {
  return kind === "claude_code" ? `claude mcp remove ${MCP_SERVER_NAME} --scope user` : kind === "codex" ? `codex mcp remove ${MCP_SERVER_NAME}` : null;
}

const scopesOf = (scope: string): string[] => scope.split(/\s+/).filter(Boolean);

/** The prisma-memory server for Cursor: the address and a public client without a secret (static OAuth in mcp.json). */
export function cursorServerConfig(cfg: OAuthConnectConfig, clientId: string): { url: string; auth: { CLIENT_ID: string; scopes: string[] } } {
  return { url: cfg.resource_url, auth: { CLIENT_ID: clientId, scopes: scopesOf(cfg.scope) } };
}

export function cursorMcpJson(cfg: OAuthConnectConfig, clientId: string): string {
  return JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: cursorServerConfig(cfg, clientId) } }, null, 2);
}

function base64Utf8(s: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function cursorDeeplink(cfg: OAuthConnectConfig, clientId: string): string | null {
  if (!Object.hasOwn(cfg.allowed_clients, clientId) || cfg.allowed_clients[clientId] !== "cursor") return null;
  const config = base64Utf8(JSON.stringify(cursorServerConfig(cfg, clientId)));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${MCP_SERVER_NAME}&config=${encodeURIComponent(config)}`;
}

export function issuerHost(issuer: string): string | null {
  try { return new URL(issuer).host || null; } catch { return null; }
}

// ---------------------------------------------------------------- built-in agent sign-in

/**
 * Pre-registered client IDs of the built-in sign-in (seed `agent_auth.clients`). The commands keep them even
 * though claude.ai, ChatGPT and VS Code can connect without one (CIMD): a client ID does not depend on the memory reaching
 * the internet. The connection settings do not list the registry, so these are the seed values.
 */
export const BUILTIN_CLIENT_IDS = {
  claude_code: "memory-claude-code",
  codex: "memory-codex",
  cursor: "memory-cursor",
  vscode: "memory-vscode",
  claude_connector: "memory-claude-connector",
  chatgpt: "memory-chatgpt",
} as const;

/**
 * The registry clients in the IT parameters, as seeded, with their titles. memory-chatgpt is off
 * until an administrator turns it on, so it is not offered as a working Client ID.
 */
export const BUILTIN_IT_CLIENTS: ReadonlyArray<{ id: string; title: string; offBySeed?: true }> = [
  { id: BUILTIN_CLIENT_IDS.claude_code, title: "Claude Code" },
  { id: BUILTIN_CLIENT_IDS.codex, title: "Codex" },
  { id: BUILTIN_CLIENT_IDS.cursor, title: "Cursor" },
  { id: BUILTIN_CLIENT_IDS.vscode, title: "VS Code" },
  { id: BUILTIN_CLIENT_IDS.claude_connector, title: "Claude (claude.ai)" },
  { id: BUILTIN_CLIENT_IDS.chatgpt, title: "ChatGPT", offBySeed: true },
];

const isHttpsOrLoopback = (raw: string): boolean => {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"));
  } catch { return false; }
};

/**
 * Agent sign-in through the identity provider (`oauth.*`), if the gateway still accepts it: `oauth.enabled` and the mode `external` — or
 * no `agent_auth` at all (a gateway before, whose only mode is external). In `builtin` (ready or not) and `off` the
 * gateway refuses identity provider tokens and revokes those connections, so a page must not offer them even though
 * `enabled` is still true: the connection would be refused straight away. An unknown mode counts as "not external".
 */
export function keycloakSignIn(cfg: OAuthConnectConfig | null | undefined): OAuthConnectConfig | null {
  if (!cfg || cfg.enabled !== true) return null;
  const a = cfg.agent_auth;
  return a === undefined || a === null || a.mode === "external" ? cfg : null;
}

/** The built-in sign-in, if the connection settings say it is on and ready with a usable address; otherwise null. */
export function builtinSignIn(cfg: Pick<OAuthConnectConfig, "agent_auth"> | null | undefined): AgentAuthConnect | null {
  const a = cfg?.agent_auth;
  if (!a || a.mode !== "builtin" || a.ready !== true) return null;
  if (typeof a.issuer !== "string" || typeof a.mcp_url !== "string" || !isHttpsOrLoopback(a.issuer) || !isHttpsOrLoopback(a.mcp_url)) return null;
  return a;
}

/** Built-in sign-in commands for the terminal: the memory address and the pre-registered client ID, quoted for the shell. */
export function builtinCommands(mcpUrl: string, shell: OAuthShell): { claude_code: string; codex: string; codex_login: string } {
  const q = (value: string) => shellQuote(value, shell);
  return {
    claude_code: `claude mcp add --transport http --scope user --client-id ${q(BUILTIN_CLIENT_IDS.claude_code)} ${MCP_SERVER_NAME} ${q(mcpUrl)}\nclaude mcp login ${MCP_SERVER_NAME}`,
    codex: `codex mcp add ${MCP_SERVER_NAME} --url ${q(mcpUrl)} --oauth-client-id ${q(BUILTIN_CLIENT_IDS.codex)} --oauth-resource ${q(mcpUrl)}`,
    codex_login: `codex mcp login ${MCP_SERVER_NAME}`,
  };
}

/** Cursor with the built-in sign-in: the server entry with the static client ID (Cursor does not use app documents). */
export function builtinCursorServer(mcpUrl: string): { url: string; auth: { CLIENT_ID: string } } {
  return { url: mcpUrl, auth: { CLIENT_ID: BUILTIN_CLIENT_IDS.cursor } };
}
export function builtinCursorMcpJson(mcpUrl: string): string {
  return JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: builtinCursorServer(mcpUrl) } }, null, 2);
}
/** The "Add to Cursor" link for the built-in sign-in (the same deeplink format as `cursorDeeplink`). */
export function builtinCursorDeeplink(mcpUrl: string): string {
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${MCP_SERVER_NAME}&config=${encodeURIComponent(base64Utf8(JSON.stringify(builtinCursorServer(mcpUrl))))}`;
}

/** Texts of the "Connect with sign-in" block (English first, like the consent screen; takes them as they are). */
export const BUILTIN_CONNECT_TEXT = derived(() => ({
  ...builtinConnectCopy,
  // Tool-readable non-SQL instruction anchor; the settings registry pins this exact source fragment.
  chatgpt_steps: "Settings → Apps → Create → paste the URL, authentication OAuth.",
  claude_ai_fallback: builtinConnectCopy.claude_ai_fallback(BUILTIN_CLIENT_IDS.claude_connector),
  chatgpt_fallback: builtinConnectCopy.chatgpt_fallback(BUILTIN_CLIENT_IDS.chatgpt),
  vscode_steps: builtinConnectCopy.vscode_steps(BUILTIN_CLIENT_IDS.vscode),
}));
