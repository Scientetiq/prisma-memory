import { CLIENT_KINDS, type ClientKind } from "./client-kind.ts";

export type ClaimedSource = "meta" | "initialize" | "user_agent";
export interface ClaimedClient { name: string; version?: string; source: ClaimedSource; ua?: string; rev?: string }
export const CLAIMED_KINDS = [...CLIENT_KINDS, "transport", "internal"] as const;
export type ClaimedKind = (typeof CLAIMED_KINDS)[number];

const RAW_MAX = 256, NAME_MAX = 64, VERSION_MAX = 32;
const UNSAFE = /[^A-Za-z0-9._ \-/@+]/g;
const REVISION = /^\d{4}-\d{2}-\d{2}$/;

const clean = (v: unknown, max: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  const s = v.slice(0, RAW_MAX).replace(UNSAFE, "").trim().slice(0, max).trim();
  return s || undefined;
};
export const sanitizeClientName = (v: unknown): string | undefined => clean(v, NAME_MAX);
export const sanitizeClientVersion = (v: unknown): string | undefined => clean(v, VERSION_MAX);
export const sanitizeRevision = (v: unknown): string | undefined => (typeof v === "string" && REVISION.test(v.trim()) ? v.trim() : undefined);

const POWERSHELL = /\s((?:Windows)?PowerShell)\/([^\s()]+)\s*$/i;

export function uaToken(ua: string | null | undefined): { name: string; version?: string } | undefined {
  if (typeof ua !== "string") return undefined;
  const raw = ua.slice(0, RAW_MAX).trim();
  let first = raw.split(/\s+/)[0] ?? "";
  if (/^mozilla\//i.test(first)) {
    const ps = POWERSHELL.exec(raw);
    if (ps) first = `${ps[1]}/${ps[2]}`;
  }
  const slash = first.indexOf("/");
  const name = clean(slash < 0 ? first : first.slice(0, slash), NAME_MAX)?.replace(/ /g, "");
  if (!name) return undefined;
  const version = slash < 0 ? undefined : clean(first.slice(slash + 1), VERSION_MAX)?.replace(/ /g, "");
  return version ? { name, version } : { name };
}
export const uaString = (t: { name: string; version?: string } | undefined): string | undefined => (t ? (t.version ? `${t.name}/${t.version}` : t.name) : undefined);

export function clientFromInfo(info: unknown, source: "meta" | "initialize", req: { ua?: string; rev?: string }): ClaimedClient | undefined {
  if (!info || typeof info !== "object" || Array.isArray(info)) return undefined;
  const name = sanitizeClientName((info as Record<string, unknown>).name);
  if (!name) return undefined;
  const version = sanitizeClientVersion((info as Record<string, unknown>).version);
  return { name, ...(version ? { version } : {}), source, ...(req.ua ? { ua: req.ua } : {}), ...(req.rev ? { rev: req.rev } : {}) };
}

export function clientFromUa(ua: string | null | undefined, rev?: string | null): ClaimedClient | undefined {
  const t = uaToken(ua);
  if (!t) return undefined;
  const r = sanitizeRevision(rev);
  return { name: t.name, ...(t.version ? { version: t.version } : {}), source: "user_agent", ua: uaString(t)!, ...(r ? { rev: r } : {}) };
}

export const KNOWN_CLIENTS: ReadonlyArray<{ name: string; kind: ClaimedKind; prefix?: true }> = [
  { name: "claude-code", kind: "claude_code", prefix: true },
  { name: "codex-mcp-client", kind: "codex" }, { name: "codex", kind: "codex", prefix: true },
  { name: "cursor", kind: "cursor", prefix: true },
  ...["gemini-cli", "claude-ai", "vscode", "visual-studio-code", "code-oss", "vscodium", "github-copilot", "windsurf", "zed", "cline", "roo", "continue",
      "opencode", "goose", "openai", "chatgpt", "jetbrains"].map((name) => ({ name, kind: "cloud_other" as const, prefix: true as const })),
  { name: "mcp", kind: "script" }, { name: "python", kind: "script" },
  ...["python-httpx", "python-requests", "python-urllib", "aiohttp", "curl", "wget", "httpie", "postmanruntime", "insomnia", "powershell",
      "windowspowershell", "go-http-client"]
    .map((name) => ({ name, kind: "script" as const, prefix: true as const })),
  ...["node", "undici", "node-fetch", "axios", "got", "reqwest", "okhttp", "java"].map((name) => ({ name, kind: "transport" as const, prefix: true as const })),
  { name: "memory-acceptance", kind: "internal" }, { name: "memory-workspace", kind: "internal" },
];

const BOUNDARY = new Set(["-", "_", "/", "."]);
export function clientKindOf(name: string | null | undefined): ClaimedKind | null {
  if (typeof name !== "string" || !name) return null;
  const n = name.trim().toLowerCase().replace(/\s*-\s*/g, "-").replace(/\s+/g, "-");
  const exact = KNOWN_CLIENTS.find((k) => k.name === n);
  if (exact) return exact.kind;
  let best: { name: string; kind: ClaimedKind } | undefined;
  for (const k of KNOWN_CLIENTS) {
    if (k.prefix && n.startsWith(k.name) && BOUNDARY.has(n[k.name.length] ?? "") && (!best || k.name.length > best.name.length)) best = k;
  }
  return best?.kind ?? null;
}

export function mismatchOf(key: ClientKind | null, sent: ClaimedKind | null, name: string): "warn" | "info" | null {
  if (sent === null || sent === "transport") return null;
  if (sent === "internal") return name.toLowerCase() === "memory-workspace" ? "info" : null;
  const k = key ?? "cloud_other";
  if (sent === "script") return k === "script" ? null : "warn";
  if (k === "script") return "info";
  if (k === "cloud_other") return null;
  return sent === k ? null : "info";
}
