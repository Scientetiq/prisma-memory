export { text as SNIPPET_TEXT } from "../messages/snippets";
import { text as M } from "../messages/snippets";
import { sentinel } from "./mcp-parse";
import { MCP_SERVER_NAME } from "./mcp-server-name";
import { formatProjectLine } from "./project-line";


export function claudeCodeSnippet(mcpUrl: string, key: string = M.keyPlaceholder): string {
  return `claude mcp add --transport http --scope user ${MCP_SERVER_NAME} ${mcpUrl} --header "Authorization: Bearer ${key}"`;
}

export function codexSnippet(mcpUrl: string, key: string = M.keyPlaceholder): string {
  return [
    `# ~/.codex/config.toml`,
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `url = "${mcpUrl}"`,
    `bearer_token_env_var = "MEMORY_KEY"`,
    ``,
    M.beforeStartingCodex,
    `export MEMORY_KEY="${key}"`,
  ].join("\n");
}

export function curlSnippet(mcpUrl: string, key: string = M.keyPlaceholder): string {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_me", arguments: {},
    _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } } });
  return [
    `curl -sS ${mcpUrl} \\`,
    `  -H "Authorization: Bearer ${key}" \\`,
    `  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \\`,
    `  -H "MCP-Protocol-Version: 2026-07-28" -H "Mcp-Method: tools/call" -H "Mcp-Name: ${sentinel("memory_me")}" \\`,
    `  -d '${body}'`,
  ].join("\n");
}

export function cursorSnippet(mcpUrl: string, key: string = M.keyPlaceholder): string {
  return JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { url: mcpUrl, headers: { Authorization: `Bearer ${key}` } } } }, null, 2);
}

export function codexConfigBlock(mcpUrl: string): string {
  return [`[mcp_servers.${MCP_SERVER_NAME}]`, `url = "${mcpUrl}"`, `bearer_token_env_var = "MEMORY_KEY"`].join("\n");
}

export const SNIPPET_KINDS = [
  { id: "claude", title: "Claude Code", make: claudeCodeSnippet },
  { id: "codex", title: "Codex", make: codexSnippet },
  { id: "cursor", title: "Cursor", make: cursorSnippet },
  { id: "curl", title: "curl", make: curlSnippet },
] as const;
export type SnippetKind = (typeof SNIPPET_KINDS)[number]["id"];

export const GATEWAY_PORT = 8080;

export interface PublicOrigin {
  host?: string | null;
  proto?: string | null;
  publicBaseUrl?: string | null;
  cloudBaseUrl?: string | null;
}

const scheme = (proto: string | null | undefined): "http" | "https" => (String(proto ?? "").split(",")[0]!.trim() === "https" ? "https" : "http");

export function publicBase(o: PublicOrigin): string {
  const configured = (o.publicBaseUrl ?? "").trim();
  if (configured) return configured.replace(/\/+$/, "");
  const hostHeader = o.host ?? "";
  const bracketedHost = /^(\[[0-9a-f:.]+\])(?::\d+)?$/i.exec(hostHeader)?.[1];
  const host = (bracketedHost ?? hostHeader.split(":")[0]) || "localhost";
  return `${scheme(o.proto)}://${host}:${GATEWAY_PORT}`;
}

export function publicMcpUrl(o: PublicOrigin): string {
  return `${publicBase(o)}/mcp`;
}

export function cloudBase(o: PublicOrigin): string {
  const configured = (o.cloudBaseUrl ?? "").trim();
  return configured ? configured.replace(/\/+$/, "") : publicBase(o);
}

export function cloudMcpUrl(o: PublicOrigin): string {
  return `${cloudBase(o)}/mcp`;
}

export interface McpUrls { cloud: string; internal: string }
export const mcpUrls = (o: PublicOrigin): McpUrls => ({ cloud: cloudMcpUrl(o), internal: publicMcpUrl(o) });

export function mcpUrlByKind(urls: McpUrls, clientKind: string | null | undefined): string {
  return clientKind === "script" ? urls.internal : urls.cloud;
}

export function publicGatewayUrl(o: PublicOrigin, urlOrPath: string): string {
  const base = publicBase(o);
  try {
    const u = new URL(urlOrPath, base);
    return `${base}${u.pathname}${u.search}`;
  } catch {
    return `${base}/${urlOrPath.replace(/^\/+/, "")}`;
  }
}

const REPO_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

/**
 * The line for the repository: «Project memory: space <slug>» (the server instructions name the same line). The legacy
 * line of earlier versions stays recognised forever — the instructions name it as a literal; the workplace offers only this one.
 * An invalid slug throws instead of giving a broken line.
 */
export function repoLine(slug: string): string {
  if (!REPO_SLUG_RE.test(slug)) throw new Error(`repoLine: invalid space slug “${slug.slice(0, 80)}”`);
  return formatProjectLine(slug);
}
