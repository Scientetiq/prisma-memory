// OAuth authorization-server module of the gateway: protocol errors. Differs from the edge's module: an own English
// table AS_TEXT (error_description and texts of AS pages by code) instead of the edge texts; errorDescription always
// returns a text; codes interaction_required (authorize) and invalid_redirect_uri, invalid_client_metadata (registration,
// RFC 7591 §3.2.2) added; tokenError takes an optional status (429 for rate limits); tables of CIMD reasons and agent
// sign-in problems added; a parity test pins the rest
//
// OAuth errors: /oauth/token, /oauth/revoke and /oauth/register answer JSON per RFC 6749 §5.2 with a short ASCII
// description and Cache-Control: no-store; /oauth/authorize errors after the client and the return address are checked
// go by redirect to redirect_uri with error, state and iss (RFC 9207).
import type { CimdReason } from "./cimd.ts";

export type TokenErrorCode = "invalid_request" | "invalid_client" | "invalid_grant" | "invalid_target" | "unsupported_grant_type" | "temporarily_unavailable";
export type AuthorizeErrorCode = "invalid_request" | "unsupported_response_type" | "invalid_target" | "access_denied" | "interaction_required" | "temporarily_unavailable";
/** Errors of client registration (RFC 7591 §3.2.2). */
export type RegistrationErrorCode = "invalid_redirect_uri" | "invalid_client_metadata";
/** Texts of AS pages that are not OAuth error codes. */
export type PageTextCode = "tx_gone" | "wrong_host" | "method_not_allowed" | "link_mode";
export type AsTextCode = TokenErrorCode | AuthorizeErrorCode | RegistrationErrorCode | PageTextCode;

/** Headers of a token endpoint response (RFC 6749 §5.1). */
export const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" } as const;

const STATUS: Record<TokenErrorCode | RegistrationErrorCode, number> = {
  invalid_request: 400, invalid_client: 401, invalid_grant: 400, invalid_target: 400, unsupported_grant_type: 400, temporarily_unavailable: 503,
  invalid_redirect_uri: 400, invalid_client_metadata: 400,
};

/**
 * English texts by code. Values with placeholders: {issuer}, {app}. Texts of OAuth error
 * codes are also error_description and stay within the RFC 6749 §5.2 character set (no quote, no backslash, ASCII only).
 */
export const AS_TEXT: Readonly<Record<AsTextCode, string>> = {
  invalid_request: "The sign-in request is malformed.",
  invalid_client: "This app is not allowed to sign in to this memory.",
  invalid_redirect_uri: "The app's return address is not allowed.",
  invalid_client_metadata: "The app registration is not supported by this memory.",
  invalid_grant: "The code or refresh token is invalid, expired or already used.",
  invalid_target: "This sign-in is for a different resource.",
  unsupported_grant_type: "Unsupported grant type.",
  unsupported_response_type: "Only the authorization code flow is supported.",
  access_denied: "You denied access.",
  interaction_required: "Sign-in requires your interaction.",
  temporarily_unavailable: "Sign-in is temporarily unavailable. Try again later.",
  tx_gone: "This sign-in was started in another browser or has expired. Start connecting again in your app.",
  wrong_host: "Open this sign-in at {issuer}.",
  method_not_allowed: "Use GET to start signing in.",
  link_mode: "Return to {app} — Sign-in is complete. Return to the app to finish connecting.",
};

/** Text by code with placeholders filled; values are inserted as is (pages escape the result). */
export function asText(code: AsTextCode, vars: Readonly<Record<string, string>> = {}): string {
  return AS_TEXT[code].replace(/\{([a-z_]+)\}/g, (all, name: string) => (Object.hasOwn(vars, name) ? vars[name]! : all));
}

/** error_description of an OAuth error code (ASCII). */
export function errorDescription(code: TokenErrorCode | AuthorizeErrorCode | RegistrationErrorCode): string {
  return AS_TEXT[code];
}

/** Error response of the token, revocation or registration endpoint; status defaults to the code's (429 for rate limits). */
export function tokenError(code: TokenErrorCode | RegistrationErrorCode, extra: Record<string, string> = {}, status: number = STATUS[code]): Response {
  const description = errorDescription(code);
  return new Response(JSON.stringify({ error: code, ...(description ? { error_description: description } : {}) }), {
    status,
    headers: { "content-type": "application/json", ...NO_STORE, ...extra },
  });
}

/**
 * Return address with authorization response parameters. The address is already checked by the redirect rules and has no
 * query: parameters go after "?". iss always (RFC 9207), state if it was in the request.
 */
export function withParams(redirectUri: string, params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v);
  return `${redirectUri}?${q.toString()}`;
}

// ---------------------------------------------------------------- CIMD reasons

/**
 * Reason of a refused client metadata document, for the line «App document: {host} — {reason}» of the invalid_client page
 * and for the admin probe. Placeholders: {status} (HTTP status), {rule} (number of the rule).
 */
export const CIMD_REASON_TEXT: Readonly<Record<CimdReason, string>> = {
  cimd_bad_url: "the document address is not in the accepted form",
  cimd_host_not_allowed: "this address is not on the memory's list of app documents",
  cimd_fetch_failed: "the memory could not download the document (HTTP {status})",
  cimd_too_large: "the document is larger than 5 KiB",
  cimd_invalid: "the document does not meet the rules (rule {rule})",
  cimd_host_cooling: "the document's site refused recent downloads; try again in a few minutes",
  cimd_rate_limited: "too many document downloads from this site; try again in a minute",
  tls: "secure connection to the document failed",
  dns: "the document's site name could not be resolved",
  timeout: "the document's site did not answer in time",
  network: "the memory could not reach the document's site",
  address_blocked: "the document's site resolves to an address the memory does not connect to",
};

/** Rule 5 (no "none" auth method) has its own text; rule 0 is a reply that is not a JSON object. */
const CIMD_RULE_TEXT: Readonly<Record<number, string>> = {
  0: "the address does not return a JSON document",
  5: "This app requires a client secret, which this memory does not support",
};

/** Reason text with placeholders filled. */
export function cimdReasonText(reason: CimdReason, o: { status?: number; rule?: number } = {}): string {
  if (reason === "cimd_invalid" && o.rule !== undefined && Object.hasOwn(CIMD_RULE_TEXT, o.rule)) return CIMD_RULE_TEXT[o.rule]!;
  return CIMD_REASON_TEXT[reason].replace("{status}", o.status === undefined ? "?" : String(o.status)).replace("{rule}", o.rule === undefined ? "?" : String(o.rule));
}

// ---------------------------------------------------------------- readiness of built-in sign-in

/** Codes of problems that keep agent_auth.mode = builtin from being ready (the panel shows its own Russian labels). */
export type AgentAuthProblemCode =
  | "agent_address_missing" | "agent_address_not_origin" | "agent_address_not_https" | "workplace_url_missing"
  | "workplace_url_not_https" | "no_clients" | "schema_missing" | "routes_missing";
/** Information without refusal (health detail and the panel). */
export type AgentAuthNoticeCode = "cimd_needs_egress" | "cimd_last_failure" | "loopback_development";

export const AGENT_AUTH_PROBLEM_TEXT: Readonly<Record<AgentAuthProblemCode | AgentAuthNoticeCode, string>> = {
  agent_address_missing: "The agent address is not set: fill in access.cloud_agent_base_url or access.public_base_url.",
  agent_address_not_origin: "The agent address must be an origin only (https://host[:port]) without a path, query or fragment.",
  agent_address_not_https: "The agent address must use HTTPS (http://localhost and http://127.0.0.1 are allowed for development).",
  workplace_url_missing: "The workplace address (access.workplace_url) is not set.",
  workplace_url_not_https: "The workplace address must use HTTPS (http://localhost and http://127.0.0.1 are allowed for development).",
  no_clients: "No app can sign in: enable a registered client, list app document hosts or turn on automatic registration.",
  schema_missing: "The database has no tables for built-in sign-in (schema part [AS] of 17-basic-tails.sql).",
  routes_missing: "This gateway version has no built-in sign-in routes yet.",
  cimd_needs_egress:
    "No app document has been downloaded yet: the gateway needs outbound HTTPS (port 443) to the listed hosts. In advanced mode, allow outbound HTTPS in the deployment's firewall rules or remove the host from agent_auth.cimd_hosts. Apps with a pre-registered Client ID work without it.",
  cimd_last_failure: "The last download of an app document from this host failed.",
  loopback_development: "Plain HTTP on localhost or 127.0.0.1 is accepted for development only.",
};
