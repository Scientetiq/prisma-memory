export const text = {
  invalidLineBreakInConnectionParameters: "Invalid line break in connection parameters",
};


export const builtinConnectCopy = {
  heading: "Connect with sign-in",
  lead: "Add the memory address to your app. The app opens the sign-in page of this memory: sign in as usual and choose Allow. No key is needed.",
  address: "Memory address (MCP)",
  copy_address: "Copy address",
  claude_ai: "Claude (claude.ai)",
  claude_ai_steps: "Settings → Connectors → Add custom connector → paste the URL. Leave OAuth Client ID empty.",
  claude_ai_fallback: (clientId: string): string => `If signing in fails because the memory cannot download Claude's app document: create the connector again and set Advanced settings → OAuth Client ID to ${clientId}.`,
  chatgpt: "ChatGPT",
  chatgpt_fallback: (clientId: string): string => `ChatGPT presents its own app document, there is no Client ID to type. A manual Client ID (${clientId}) works only if your administrator has turned it on.`,
  chatgpt_domain: "ChatGPT Business and Enterprise workspaces that allow connectors only for a company domain require OpenID Connect sign-in. The built-in sign-in of this memory does not provide it, so such a workspace cannot connect this way yet; ask your administrator.",
  claude_code: "Claude Code",
  claude_code_steps: "Run in a terminal; the second line opens the sign-in page in your browser:",
  codex: "Codex",
  codex_steps: "Run in a terminal:",
  codex_login: "Codex starts signing in by itself; if it does not, run:",
  cursor: "Cursor",
  cursor_steps: "Press the button — Cursor opens and asks to install the server. Or add this to ~/.cursor/mcp.json:",
  cursor_button: "Add to Cursor",
  vscode: "VS Code",
  vscode_steps: (clientId: string): string => `Add the URL as an HTTP MCP server; VS Code presents its own app document. If it asks for a Client ID, use ${clientId}.`,
  other: "Other apps",
  other_steps: "Add the URL as an MCP server with OAuth sign-in in the browser; no other parameters are needed.",
  needs_egress: "The memory cannot download app documents right now: claude.ai and ChatGPT will not connect without a Client ID. Apps with a Client ID — Claude Code, Codex, Cursor, VS Code and claude.ai with the Client ID above — connect as usual.",
  duration: "A connection is not extended: when it expires, connect the app again. The memory asks for your consent every time an app connects.",
};
