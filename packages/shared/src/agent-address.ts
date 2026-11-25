import type { OAuthConfig } from "./oauth.ts";
import { SKILL_ARCHIVE_PATH, validSkillBase } from "./skill-phrase.ts";

export const CLOUD_AGENT_BASE_SETTING = "access.cloud_agent_base_url";

export const trimBase = (value: unknown): string => (typeof value === "string" ? value.trim().replace(/\/+$/, "") : "");

export const mcpUrlOf = (base: string): string => `${trimBase(base)}/mcp`;

const LOOPBACK = new Set(["localhost", "127.0.0.1"]);
const MAX_CHARS = 200;

export function cloudAgentBaseProblem(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return "address must be a string";
  const v = value.trim();
  if (!v) return null;
  let u: URL | null = null;
  try { u = new URL(v); } catch { }
  const loopbackHttp = u?.protocol === "http:" && LOOPBACK.has(u.hostname);
  if (!u || v.length > MAX_CHARS || (u.protocol !== "https:" && !loopbackHttp) || u.username || u.password || u.search || u.hash
      || /[?#@\s]/.test(v) || u.pathname !== "/" || !validSkillBase(`${trimBase(v)}${SKILL_ARCHIVE_PATH}`))
    return "address: use https://host with a port if needed, without a path, query or username. Example: https://memory-mcp.corp.test; "
      + "http is for localhost or 127.0.0.1 on a test installation only";
  if (u.origin !== trimBase(v))
    return `enter the address as ${u.origin} — lowercase hostname, without the default port (:443 for https). This address determines `
      + "oauth.resource_url and is matched exactly when agents sign in with a company account";
  return null;
}

export function cloudOAuthMismatch(cloud: unknown, oauth: Pick<OAuthConfig, "enabled" | "resource_url">): string | null {
  const base = trimBase(cloud);
  if (!base || !oauth.enabled) return null;
  const want = mcpUrlOf(base);
  if (oauth.resource_url === want) return null;
  return `the resource address oauth.resource_url must be exactly ${want}: cloud agents sign in with their accounts at the same `
    + `address as the one set in ${CLOUD_AGENT_BASE_SETTING}. Save both settings together, or use this order in the admin panel: `
    + `clear ${CLOUD_AGENT_BASE_SETTING}, change oauth.resource_url, then set ${CLOUD_AGENT_BASE_SETTING} again`;
}
