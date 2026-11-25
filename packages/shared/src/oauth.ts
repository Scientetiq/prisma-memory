import type { ClientKind } from "./client-kind.ts";
import { parseCaCerts } from "./ldap.ts";
import { issuerSlashHint, MAX_JWS_CHARS, OIDC_CLOCK_SKEW_SEC, OidcFailure, oidcPrivateNetworks, ProviderCache, verifyJws, type OidcDiscovery, type OidcProviderConfig } from "./oidc.ts";
import type { Settings } from "./settings.ts";

export type CloudClientKind = Exclude<ClientKind, "script">;
export interface OAuthConfig {
  enabled: boolean; issuer: string; resource_url: string; ca_cert: string;
  allowed_clients: Record<string, CloudClientKind>; scope: string; timeout_sec: number; connection_days: number;
  private_networks?: string[];
}
export interface OAuthClaims {
  issuer: string; subject: string; clientId: string; sessionId: string; clientKind: CloudClientKind;
  ldapId: string | null; username: string | null; issuedAt: number; expiresAt: number;
}
export const OAUTH_SCOPE = "mcp:memory";
export const OAUTH_DEFAULT_CLIENTS: Record<string, CloudClientKind> = { "memory-codex": "codex", "memory-claude-code": "claude_code", "memory-cursor": "cursor" };
export const OAUTH_MAX_ACCESS_LIFETIME_SEC = 3600;
const CLOUD_KINDS = new Set<unknown>(["codex", "claude_code", "cursor", "cloud_other"]);
const MAX_TOKEN_BYTES = MAX_JWS_CHARS;
const SKEW_SEC = OIDC_CLOCK_SKEW_SEC;
export const OAUTH_EXP_SKEW_SEC = 60;
const CLIENT_RE = /^[\x21-\x7e]{1,255}$/;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const asUrl = (s: string): URL | null => { try { return new URL(s); } catch { return null; } };
const loopback = (u: URL): boolean => ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function oauthConfig(s: Pick<Settings, "get">): OAuthConfig {
  const str = (key: string, fallback = "") => { const v = s.get<unknown>(`oauth.${key}`, fallback); return typeof v === "string" ? v.trim() : ""; };
  const num = (key: string, fallback: number) => { const v = s.get<unknown>(`oauth.${key}`, fallback); return typeof v === "number" ? v : NaN; };
  return {
    enabled: s.get<unknown>("oauth.enabled", false) === true, issuer: str("issuer"), resource_url: str("resource_url"), ca_cert: str("ca_cert"),
    allowed_clients: s.get("oauth.allowed_clients", OAUTH_DEFAULT_CLIENTS), scope: str("scope", OAUTH_SCOPE),
    timeout_sec: num("timeout_sec", 10), connection_days: num("connection_days", 90), private_networks: oidcPrivateNetworks(s),
  };
}

export function oauthProblems(cfg: OAuthConfig): Array<{ key: string; message: string }> {
  const out: Array<{ key: string; message: string }> = [];
  const bad = (key: string, message: string) => out.push({ key, message });
  if (cfg.issuer) {
    const u = asUrl(cfg.issuer);
    if (!u || u.protocol !== "https:" || u.search || u.hash || u.username || u.password || cfg.issuer.length > 500)
      bad("issuer", "issuer must be an exact HTTPS URL without a username, password, query or fragment");
  } else if (cfg.enabled) bad("issuer", "an HTTPS issuer of the identity provider is required");
  if (cfg.resource_url) {
    const u = asUrl(cfg.resource_url);
    if (!u || (u.protocol !== "https:" && !(u.protocol === "http:" && loopback(u))) || u.pathname !== "/mcp" || u.search || u.hash || u.username || u.password || cfg.resource_url.length > 500)
      bad("resource_url", "resource must be a canonical HTTPS URL with the /mcp path. HTTP is allowed only for loopback tests");
  } else if (cfg.enabled) bad("resource_url", "an HTTPS resource URL for /mcp is required");
  if (!object(cfg.allowed_clients) || Object.keys(cfg.allowed_clients).length > 100 || (cfg.enabled && !Object.keys(cfg.allowed_clients).length))
    bad("allowed_clients", "client ID → program mapping: 1–100 allowed clients when OAuth is enabled");
  else for (const [id, kind] of Object.entries(cfg.allowed_clients)) {
    if (!CLIENT_RE.test(id) || ["__proto__", "constructor", "prototype"].includes(id) || !CLOUD_KINDS.has(kind)) {
      bad("allowed_clients", "client ID — up to 255 ASCII characters with no spaces. Program: codex, claude_code, cursor or cloud_other"); break;
    }
  }
  if (cfg.scope !== OAUTH_SCOPE) bad("scope", `scope: ${OAUTH_SCOPE}`);
  if (!Number.isInteger(cfg.timeout_sec) || cfg.timeout_sec < 1 || cfg.timeout_sec > 60) bad("timeout_sec", "timeout: an integer from 1–60 seconds");
  if (!Number.isInteger(cfg.connection_days) || cfg.connection_days < 1 || cfg.connection_days > 90) bad("connection_days", "connection duration: a whole number of days from 1–90");
  if (cfg.ca_cert) { try { parseCaCerts(cfg.ca_cert); } catch { bad("ca_cert", "root certificate must be valid PEM"); } }
  return out;
}

function oauthDiscoveryProblems(cfg: OidcProviderConfig, d: OidcDiscovery): string[] {
  const out: string[] = [];
  if (d.issuer !== cfg.issuer) out.push(`issuer from discovery does not match the configured issuer${issuerSlashHint(cfg.issuer, d.issuer)}`);
  const host = asUrl(cfg.issuer)?.host ?? "";
  for (const endpoint of [d.authorization_endpoint, d.token_endpoint, d.jwks_uri]) {
    const u = asUrl(endpoint);
    if (!u || u.protocol !== "https:" || u.username || u.password || u.hash) out.push("the OAuth endpoint must be an HTTPS URL without credentials or a fragment");
    else if (u.host !== host) out.push(`the OAuth endpoint is on “${u.host.slice(0, 100)}” and the issuer is on “${host}”. Provider addresses must be on the issuer’s server`);
  }
  if (!d.code_challenge_methods?.includes("S256")) out.push("discovery does not advertise PKCE S256");
  return out;
}

const defaultCache = new ProviderCache();
export const clearOAuthProviders = (): void => defaultCache.clear();
const badToken = (detail: string): never => { throw new OidcFailure("oidc_token_invalid", detail); };
function parsePart(value: string): Record<string, unknown> {
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) return badToken("noncanonical JWT encoding");
    const parsed: unknown = JSON.parse(decoded.toString("utf8"));
    if (object(parsed)) return parsed;
  } catch { }
  return badToken("a JWT part is not a JSON object");
}
const tokenText = (value: unknown, max = 255): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u0020\u007f]/.test(value);
const numericDate = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export async function verifyOAuthAccessToken(cfg: OAuthConfig, rawToken: string, cache = defaultCache, nowSec = Math.floor(Date.now() / 1000)): Promise<OAuthClaims> {
  if (!cfg.enabled) throw new OidcFailure("oidc_disabled", "MCP OAuth is disabled");
  if (oauthProblems(cfg).length) throw new OidcFailure("oidc_not_configured", "MCP OAuth is misconfigured");
  if (typeof rawToken !== "string" || rawToken.length > MAX_TOKEN_BYTES) return badToken("JWT exceeds the size limit");
  const parts = rawToken.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return badToken("expected a compact signed JWT");
  if (Buffer.from(parts[2]!, "base64url").toString("base64url") !== parts[2]) return badToken("noncanonical JWT signature");
  const header = parsePart(parts[0]!);
  const preliminary = parsePart(parts[1]!);
  if (header.alg !== "RS256" || header.crit !== undefined || !tokenText(header.kid)) return badToken("RS256 and kid are required. crit is unsupported");
  if (typeof preliminary.azp !== "string" || !Object.hasOwn(cfg.allowed_clients, preliminary.azp)) return badToken("client ID is not allowed");
  const d = await cache.discovery(cfg, false, oauthDiscoveryProblems);
  const keys = async (fresh = false) => {
    const jwks = await cache.jwks(cfg, d, fresh);
    if (jwks.length > 100) throw new OidcFailure("oidc_bad_response", "JWKS contains too many keys");
    return jwks.filter((key) => !key.key_ops || (Array.isArray(key.key_ops) && key.key_ops.includes("verify")));
  };
  const { payload: c } = await verifyJws(rawToken, () => keys(), () => keys(true));
  if (c.iss !== cfg.issuer || c.typ !== "Bearer") return badToken("the access token is not from the configured issuer");
  const audiences = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!audiences.length || audiences.length > 20 || !audiences.every((a) => typeof a === "string") || !audiences.includes(cfg.resource_url)) return badToken("invalid access token audience");
  if (!tokenText(c.azp) || !Object.hasOwn(cfg.allowed_clients, c.azp) || !tokenText(c.sub) || !tokenText(c.sid)) return badToken("missing valid azp/sub/sid");
  if (typeof c.scope !== "string" || c.scope.length > 2048 || !c.scope.split(" ").includes(cfg.scope)) return badToken("the access token lacks the required scope");
  if (!numericDate(c.iat) || !numericDate(c.exp) || c.exp <= c.iat || c.exp - c.iat > OAUTH_MAX_ACCESS_LIFETIME_SEC || c.iat > nowSec + SKEW_SEC || c.exp <= nowSec - OAUTH_EXP_SKEW_SEC)
    return badToken("invalid access token expiration");
  if (c.nbf !== undefined && (!numericDate(c.nbf) || c.nbf > nowSec + SKEW_SEC || c.nbf >= c.exp || c.nbf < c.iat - SKEW_SEC)) return badToken("the access token is not yet valid or nbf is invalid");
  let ldapId: string | null = null, username: string | null = null;
  if (c.LDAP_ID !== undefined) {
    if (typeof c.LDAP_ID !== "string" || !GUID_RE.test(c.LDAP_ID)) return badToken("LDAP_ID has an invalid format");
    ldapId = c.LDAP_ID.toLowerCase();
  }
  if (c.preferred_username !== undefined) {
    if (typeof c.preferred_username !== "string" || !tokenText(c.preferred_username.trim())) return badToken("preferred_username has an invalid format");
    username = c.preferred_username.trim().toLowerCase();
  }
  return { issuer: cfg.issuer, subject: c.sub, clientId: c.azp, sessionId: c.sid, clientKind: cfg.allowed_clients[c.azp]!, ldapId, username, issuedAt: c.iat, expiresAt: c.exp };
}
