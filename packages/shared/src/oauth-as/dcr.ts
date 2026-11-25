// Dynamic Client Registration ("Register automatically", RFC 7591): the pure part. Validation of a
// registration request, the registered result, the client id, labels and audit details. The route, limits, storage and
// expiry live in the gateway (packages/gateway/src/agent-auth/dcr.ts); nothing here does I/O. DCR is off by default
// (agent_auth.dcr_enabled = false).
//
// Rules:
// - public clients only: token_endpoint_auth_method absent, "none", "client_secret_basic" or "client_secret_post" is
//   registered as "none" (RFC 7591 §3.2.1: the server may replace a requested value, the response is final; no secret is
//   issued, so the client will not send one); any other method, jwks, jwks_uri or client_secret — invalid_client_metadata;
// - redirect_uris are required, 1–10, loopback http (any port) or exact https in canonical form (what the browser visits
//   is what is registered); another scheme is refused, not skipped (the client writes the registration itself and can be
//   told at once); all non-loopback addresses on one origin; an unverified forwarder (https://vscode.dev/redirect in any
//   spelling) — invalid_redirect_uri;
// - grant_types: the intersection with {authorization_code, refresh_token}, refused only without authorization_code
//   (Claude also declares urn:ietf:params:oauth:grant-type:jwt-bearer); response_types: the intersection with {code};
// - client_name is only an unverified label ("It calls itself …"); scope is ignored; unknown fields are ignored;
// - JSON null counts as an absent field.
import { randomBytes } from "node:crypto";
import { charLength, cleanClientName, CLIENT_LABEL_MAX, CLIENT_NAME_MAX, hostLabel, isJsonContentType, kindByRedirects, usableRedirect, type UsableRedirect } from "./cimd.ts";
import type { RegistrationErrorCode } from "./errors.ts";
import { parseRedirect, REDIRECT_MAX, type AnchorsRedirect } from "./redirect.ts";

export const DCR_PREFIX = "dcr_";
/** Same as the CHECK of agent_oauth_dcr_clients.client_id. */
export const DCR_ID_RE = /^dcr_[a-z2-7]{26}$/;
/** Request body limit (bytes). */
export const DCR_BODY_MAX = 8192;
export const DCR_REDIRECTS_MAX = 10;
export const DCR_SOFTWARE_MAX = 255;
export const DCR_GRANT_TYPES = ["authorization_code", "refresh_token"] as const;
export type DcrGrantType = (typeof DCR_GRANT_TYPES)[number];
export const DCR_LABEL_SUFFIX = " (auto-registered)";
/** Methods accepted in a request; all are registered as "none". */
const ACCEPTED_METHODS = new Set(["none", "client_secret_basic", "client_secret_post"]);
/** Fields that mean a confidential client. */
const FORBIDDEN_FIELDS = ["jwks", "jwks_uri", "client_secret"] as const;

/** The id is a DCR client id of the registered shape. */
export const isDcrClientId = (v: unknown): v is string => typeof v === "string" && DCR_ID_RE.test(v);

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** New client id: "dcr_" + base32 (RFC 4648 alphabet, lower case, no padding) of 16 random bytes — 26 characters. */
export function newDcrClientId(random: (n: number) => Uint8Array = randomBytes): string {
  let out = "", acc = 0, bits = 0;
  for (const b of random(16)) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return DCR_PREFIX + out;
}

/** Content-Type of a registration request: application/json, parameters allowed. */
export const dcrContentTypeOk = (contentType: unknown): boolean => isJsonContentType(contentType);

/** Body of a registration request: at most 8 KiB and a JSON object. */
export function parseDcrBody(text: unknown): { ok: true; json: Record<string, unknown> } | { ok: false; error: "invalid_client_metadata"; detail: string } {
  if (typeof text !== "string") return { ok: false, error: "invalid_client_metadata", detail: "the body is not text" };
  if (Buffer.byteLength(text, "utf8") > DCR_BODY_MAX) return { ok: false, error: "invalid_client_metadata", detail: `the body is larger than ${DCR_BODY_MAX} bytes` };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid_client_metadata", detail: "the body is not JSON" };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "invalid_client_metadata", detail: "the body is not a JSON object" };
  return { ok: true, json: v as Record<string, unknown> };
}

export interface DcrRegistration {
  readonly redirectUris: readonly string[];
  readonly lines: readonly UsableRedirect[];
  /** rows for matchRedirect */
  readonly redirects: readonly AnchorsRedirect[];
  readonly clientName: string | null;
  readonly grantTypes: readonly DcrGrantType[];
  readonly responseTypes: readonly ["code"];
  readonly tokenEndpointAuthMethod: "none";
  readonly softwareId: string | null;
  readonly softwareVersion: string | null;
  /** all return addresses loopback — local_other, otherwise cloud_other */
  readonly kind: "local_other" | "cloud_other";
}
export type DcrCheck = { ok: true; reg: DcrRegistration } | { ok: false; error: RegistrationErrorCode; detail: string };

const refuse = (error: RegistrationErrorCode, detail: string): DcrCheck => ({ ok: false, error, detail });
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Optional short text field: absent or null — null; a string — cleaned and at most `max` characters; otherwise a problem. */
function optionalText(v: unknown, max: number, name: string): { ok: true; value: string | null } | { ok: false; detail: string } {
  if (v == null) return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false, detail: `${name} must be a string` };
  const value = cleanClientName(v);
  if (value !== null && charLength(value) > max) return { ok: false, detail: `${name} is longer than ${max} characters` };
  return { ok: true, value };
}

/** Validate a registration request (a parsed JSON object) and return what is actually registered. */
export function checkDcrRequest(body: unknown): DcrCheck {
  if (!body || typeof body !== "object" || Array.isArray(body)) return refuse("invalid_client_metadata", "the body is not a JSON object");
  const b = body as Record<string, unknown>;
  // confidential clients are not supported
  for (const f of FORBIDDEN_FIELDS) if (b[f] != null) return refuse("invalid_client_metadata", `${f} is not supported: only public clients can register`);
  const method = b.token_endpoint_auth_method;
  if (method != null && !(typeof method === "string" && ACCEPTED_METHODS.has(method))) {
    return refuse("invalid_client_metadata", "token_endpoint_auth_method must be none (client_secret_basic and client_secret_post are registered as none)");
  }
  // return addresses
  const uris = b.redirect_uris;
  if (!isStringArray(uris) || uris.length < 1 || uris.length > DCR_REDIRECTS_MAX || uris.some((u) => u.length > REDIRECT_MAX)) {
    return refuse("invalid_redirect_uri", `redirect_uris must be 1-${DCR_REDIRECTS_MAX} strings of at most ${REDIRECT_MAX} characters`);
  }
  // A line of an unverified forwarder (https://vscode.dev/redirect sends the code wherever state says) is dropped, not
  // refused, while a usable line remains: VS Code lists two of them before its loopback lines, and refusing the whole request
  // left VS Code without "Register automatically" (RFC 7591 §3.2.1 — the 201 names what is registered;
  // a deliberate deviation). Any other unusable line refuses the request: the client is told at once.
  const lines: UsableRedirect[] = [];
  let forwarders = 0;
  for (const u of uris) {
    const r = usableRedirect(u, null);
    if (!r.ok && r.reason === "unverified_forwarder") { forwarders++; continue; }
    if (!r.ok) {
      return refuse("invalid_redirect_uri", `a return address is not accepted (${r.reason}): only loopback http or https addresses in canonical form (path of A-Z a-z 0-9 . _ ~ / - without . or .. segments and //)`);
    }
    lines.push(r.line);
  }
  if (lines.length === 0) {
    return refuse("invalid_redirect_uri", `${forwarders > 0 ? "every return address is an unverified forwarder (unverified_forwarder)" : "no return address"}: only loopback http or https addresses in canonical form`);
  }
  const origins = new Set(lines.filter((l) => !l.loopback).map((l) => new URL(l.uri).origin));
  if (origins.size > 1) return refuse("invalid_redirect_uri", "all non-loopback return addresses must be on one origin");
  // grant and response types: intersections
  let grantTypes: DcrGrantType[] = [...DCR_GRANT_TYPES];
  if (b.grant_types != null) {
    if (!isStringArray(b.grant_types)) return refuse("invalid_client_metadata", "grant_types must be an array of strings");
    const asked = b.grant_types;
    grantTypes = DCR_GRANT_TYPES.filter((g) => asked.includes(g));
    if (!grantTypes.includes("authorization_code")) return refuse("invalid_client_metadata", "grant_types must contain authorization_code");
  }
  if (b.response_types != null) {
    if (!isStringArray(b.response_types)) return refuse("invalid_client_metadata", "response_types must be an array of strings");
    if (!b.response_types.includes("code")) return refuse("invalid_client_metadata", "response_types must contain code");
  }
  const name = optionalText(b.client_name, CLIENT_NAME_MAX, "client_name");
  if (!name.ok) return refuse("invalid_client_metadata", name.detail);
  const softwareId = optionalText(b.software_id, DCR_SOFTWARE_MAX, "software_id");
  if (!softwareId.ok) return refuse("invalid_client_metadata", softwareId.detail);
  const softwareVersion = optionalText(b.software_version, DCR_SOFTWARE_MAX, "software_version");
  if (!softwareVersion.ok) return refuse("invalid_client_metadata", softwareVersion.detail);
  return {
    ok: true,
    reg: {
      redirectUris: lines.map((l) => l.uri), lines, redirects: lines.map((l) => l.row), clientName: name.value, grantTypes, responseTypes: ["code"],
      tokenEndpointAuthMethod: "none", softwareId: softwareId.value, softwareVersion: softwareVersion.value, kind: kindByRedirects(lines),
    },
  };
}

/** Body of the 201 response: what is actually registered (RFC 7591 §3.2.1). */
export function dcrRegistrationResponse(clientId: string, issuedAtSec: number, reg: DcrRegistration): Record<string, unknown> {
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(issuedAtSec),
    ...(reg.clientName !== null ? { client_name: reg.clientName } : {}),
    redirect_uris: [...reg.redirectUris],
    token_endpoint_auth_method: "none",
    grant_types: [...reg.grantTypes],
    response_types: [...reg.responseTypes],
  };
}

/** Host of a return address for a title or a label; null — not an address. */
export function redirectHost(redirectUri: unknown): string | null {
  return parseRedirect(redirectUri)?.host ?? null;
}

/**
 * Consent title of a DCR client: the host of the return address of this transaction (not of the first registered
 * address).
 */
export function dcrTitle(redirectUri: unknown): string {
  return hostLabel(redirectHost(redirectUri) ?? "unknown app");
}

/**
 * client_label of a DCR connection: "<client_name> (auto-registered)", without a name — "<host of the return
 * address of this code> (auto-registered)"; at most 80 characters.
 */
export function dcrClientLabel(clientName: string | null, redirectUri: unknown): string {
  const room = CLIENT_LABEL_MAX - DCR_LABEL_SUFFIX.length;
  const name = clientName === null ? null : cleanClientName(clientName);
  if (name !== null) {
    const chars = [...name];
    return (chars.length <= room ? name : `${chars.slice(0, room - 1).join("")}…`) + DCR_LABEL_SUFFIX;
  }
  return hostLabel(redirectHost(redirectUri) ?? "unknown app", room) + DCR_LABEL_SUFFIX;
}

/**
 * Host of any address for the audit event, leniently (WHATWG): also of the addresses the registration refuses (with a
 * query, a fragment, userinfo, an upper-case or non-ASCII host), so the admin sees which hosts were asked for.
 * Only the host: no path, query or userinfo; odd characters replaced, at most 253; null — no host.
 */
function auditHost(u: string): string | null {
  let host: string;
  try {
    host = new URL(u).hostname;
  } catch {
    return null;
  }
  const clean = host.replace(/[^A-Za-z0-9.:[\]_~%-]/g, "?").slice(0, 253);
  return clean === "" ? null : clean;
}

const typeTag = (v: unknown): string => `<${v === null ? "null" : Array.isArray(v) ? "array" : typeof v}>`;
const logText = (v: unknown, max: number): string => (typeof v === "string" ? (cleanClientName(v) ?? "").slice(0, max) : typeTag(v));
const logList = (v: unknown, n: number, max: number): string[] | null => (v === undefined ? null : Array.isArray(v) ? v.slice(0, n).map((x) => logText(x, max)) : [typeTag(v)]);

/**
 * details of the audit event {op: "oauth_dcr_register"}: names of the fields sent, values of
 * grant_types, response_types and token_endpoint_auth_method, hosts and schemes of the return addresses — never whole
 * addresses, secrets or other values. All strings are cleaned and cut.
 */
export function dcrRegisterDetails(body: unknown): Record<string, unknown> {
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const fields = Object.keys(b).slice(0, 40).map((k) => k.replace(/[^A-Za-z0-9_.:-]/g, "?").slice(0, 64)).sort();
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.slice(0, DCR_REDIRECTS_MAX) : [];
  const hosts = new Set<string>(), schemes = new Set<string>();
  for (const u of uris) {
    if (typeof u !== "string") continue;
    const scheme = /^([a-z][a-z0-9+.-]{0,31}):/i.exec(u)?.[1];
    if (scheme) schemes.add(scheme.toLowerCase());
    const host = auditHost(u);
    if (host) hosts.add(host);
  }
  return {
    op: "oauth_dcr_register",
    fields,
    grant_types: logList(b.grant_types, 10, 100),
    response_types: logList(b.response_types, 10, 100),
    token_endpoint_auth_method: b.token_endpoint_auth_method === undefined ? null : logText(b.token_endpoint_auth_method, 100),
    redirect_hosts: [...hosts].sort(),
    redirect_schemes: [...schemes].sort(),
  };
}
