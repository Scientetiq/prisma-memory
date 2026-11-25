import { SSO_ERROR_TEXT, TEXT } from "../messages/workplace-login";

const IP_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]{2,39}(?:%[\w.-]+)?)$/;

const bareIp = (v: string): string | null => {
  const bare = v.trim().replace(/^\[(.*)\](?::\d+)?$/, "$1").replace(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/, "$1").replace(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i, "$1");
  return bare && bare.length <= 45 && IP_RE.test(bare) ? bare : null;
};

export function clientIpFrom(forwardedFor: string | null, realIp: string | null = null): string | null {
  return bareIp((forwardedFor ?? "").split(",").at(-1)?.trim() || (realIp ?? "").trim());
}

export const PEER_HEADER = "x-memory-peer";
const FORWARDED_MAX = 1000;

export function clientHeaders(h: { get(name: string): string | null }): Record<string, string> {
  const out: Record<string, string> = { "X-Memory-Client-Ua": clientUa(h.get("user-agent")) };
  const ip = clientIpFrom(h.get("x-forwarded-for"), h.get("x-real-ip"));
  if (ip) out["X-Memory-Client-Ip"] = ip;
  const peer = (globalThis as { __memoryClientPeer?: boolean }).__memoryClientPeer === true ? bareIp(h.get(PEER_HEADER) ?? "") : null;
  if (peer) {
    out["X-Memory-Client-Peer"] = peer;
    const fwd = (h.get("x-forwarded-for") ?? "").replace(/[^\x20-\x7e]/g, "");
    const tail = fwd.length > FORWARDED_MAX ? fwd.slice(-FORWARDED_MAX).replace(/^[^,]*,/, "") : fwd;
    if (tail.trim()) out["X-Memory-Client-Forwarded"] = tail;
  }
  return out;
}

export function clientUa(ua: string | null): string {
  return (ua ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 300);
}



export const OIDC_STATE_COOKIE = "memory_oidc_state";
export const OIDC_COOKIE_PATH = "/auth/oidc";


export function isHttpsRequest(req: { url?: string; headers: { get(name: string): string | null } }): boolean {
  let proto = "";
  try { proto = req.url ? new URL(req.url).protocol : ""; } catch { }
  return proto === "https:" || (req.headers.get("x-forwarded-proto") ?? "").split(",")[0]!.trim().toLowerCase() === "https";
}

/** Values of MEMORY_PUBLIC_URL already reported as malformed: one warning line per value and process, not one per request. */
const reportedPublicUrls = new Set<string>();

/**
 * Origin of the public address MEMORY_PUBLIC_URL when it is an https URL; otherwise null. The variable is set by a
 * deployment that publishes the web service over https (the Compose installer of this repository does not pass it to the
 * web service: its cookies follow the request scheme and X-Forwarded-Proto); absent or not https — nothing changes. One pair of matching
 * surrounding quotes is dropped first: the list form of compose `environment: - KEY="value"` keeps them in the value. A set
 * value that is still not an http(s) URL would silently leave the cookies without `Secure`, so it writes one warning line
 * (code memory_public_url_invalid, without the value) per value and process.
 */
export function publicHttpsOrigin(raw: string | undefined = process.env.MEMORY_PUBLIC_URL): string | null {
  let v = (raw ?? "").trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1).trim();
  if (!v) return null;
  let u: URL | null = null;
  try { u = new URL(v); } catch { u = null; }
  if (u && (u.protocol === "https:" || u.protocol === "http:") && u.hostname) return u.protocol === "https:" ? u.origin : null;
  if (!reportedPublicUrls.has(v)) {
    reportedPublicUrls.add(v);
    console.warn(`memory_public_url_invalid: MEMORY_PUBLIC_URL is set but is not an http(s) URL (${v.length} characters); session cookies get Secure only from the request scheme or X-Forwarded-Proto`);
  }
  return null;
}

/** The configured public address is https. */
export const publicUrlIsHttps = (raw: string | undefined = process.env.MEMORY_PUBLIC_URL): boolean => publicHttpsOrigin(raw) !== null;

/**
 * `Secure` flag of a session cookie: the request came over HTTPS (isHttpsRequest) OR the public address is https.
 * Behind a TLS proxy that does not send X-Forwarded-Proto the cookies stay `Secure`; without the variable the flag is
 * decided exactly as before, so plain-HTTP installs (http://IP:port) keep working. isHttpsRequest itself is not changed: it
 * also builds the workplace origin (requestOrigin).
 */
export function cookieSecure(req: { url?: string; headers: { get(name: string): string | null } }): boolean {
  return isHttpsRequest(req) || publicUrlIsHttps();
}

/**
 * Hint of a sign-in page (the workplace's `/login`, the panel's `/admin/login`) for a browser that opened it over plain HTTP
 * while the public address is https: the `Secure` session cookie never comes back over HTTP, so signing in here
 * cannot work.
 */
export function plainHttpHint(httpsOrigin: string, path: "/login" | "/admin/login" = "/login"): { text: string; href: string } {
  return { text: TEXT.plainHttpHint, href: `${httpsOrigin}${path}` };
}

const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?|\[[0-9a-f:.]{2,45}\])(?::\d{1,5})?$/i;

export function requestOrigin(req: { url?: string; headers: { get(name: string): string | null } }): string | null {
  const host = (req.headers.get("x-forwarded-host") ?? "").split(",")[0]!.trim() || (req.headers.get("host") ?? "").trim();
  if (!HOST_RE.test(host)) return null;
  try { return new URL(`${isHttpsRequest(req) ? "https" : "http"}://${host}`).origin; } catch { return null; }
}

export function fromOwnPages(req: { url?: string; headers: { get(name: string): string | null } }): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) return site.trim().toLowerCase() === "same-origin";
  const origin = req.headers.get("origin"), own = requestOrigin(req);
  return Boolean(origin && own && origin.trim().toLowerCase() === own.toLowerCase());
}

export function startHostRedirect(authorizationUrl: string, req: { url?: string; headers: { get(name: string): string | null } }, next: string | null = null): string | null {
  let target: URL;
  try { target = new URL(new URL(authorizationUrl).searchParams.get("redirect_uri") ?? ""); } catch { return null; }
  if (target.protocol !== "http:" && target.protocol !== "https:") return null;
  const here = requestOrigin(req);
  return here && here !== target.origin ? `${target.origin}${OIDC_COOKIE_PATH}/start?h=1${next ? `&next=${encodeURIComponent(next)}` : ""}` : null;
}

export function sameOidcState(fromUrl: string, fromCookie: string | null | undefined): boolean {
  const a = new TextEncoder().encode(fromUrl), b = new TextEncoder().encode(fromCookie ?? "");
  if (!a.length || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export const OIDC_CALLBACK_CAPS = { state: 200, cookie_state: 200, code: 2048, iss: 500, error: 100 } as const;

export function oidcCallbackBody(params: URLSearchParams, cookieState: string | null | undefined): Record<string, string> {
  const cut = (v: string, k: keyof typeof OIDC_CALLBACK_CAPS) => v.slice(0, OIDC_CALLBACK_CAPS[k] + 1);
  const body: Record<string, string> = { state: cut(params.get("state") ?? "", "state"), cookie_state: cut(cookieState ?? "", "cookie_state") };
  for (const k of ["code", "iss", "error"] as const) {
    const v = params.get(k);
    if (v) body[k] = cut(v, k);
  }
  const desc = params.get("error_description");
  if (desc) body.error_description = desc.slice(0, 200);
  return body;
}

export const whereToAsk = (contact: string | null | undefined): string => {
  const c = (contact ?? "").trim().replace(/[.!?…]+$/u, "").trimEnd();
  return c ? TEXT.supportContact(c) : TEXT.supportFallback;
};



export const ssoErrorCode = (code: string | null | undefined): string | null => (code && /^[a-z_]{1,40}$/.test(code) ? code : null);

export function ssoErrorText(code: string | null | undefined, o: { ldapOn?: boolean; contact?: string | null } = {}): string | null {
  if (!code) return null;
  if (code === "oidc_email_unverified")
    return o.ldapOn
      ? TEXT.companySingleSignOnHasNotVerified2
      : TEXT.companySingleSignOnHasNotVerified;
  if (code === "oidc_not_in_group") return TEXT.yourAccountDoesNotHaveAccessTo(whereToAsk(o.contact));
  if (Object.hasOwn(SSO_ERROR_TEXT, code)) return SSO_ERROR_TEXT[code]!;
  return /^oidc_[a-z_]{1,40}$/.test(code)
    ? TEXT.companySingleSignOnIsUnavailableTry
    : TEXT.companySingleSignOnDidNotComplete(TEXT.ask);
}

const NO_FALLBACK = new Set(["oidc_not_in_group", "oidc_no_mail", "oidc_email_unverified", "oidc_claim_invalid", "person_inactive", "person_conflict",
                             "guid_link_unconfirmed", "forbidden", "gateway_unreachable", "contract", "in_progress"]);


export function ssoFallbackHint(code: string | null | undefined, ldapOn: boolean): string | null {
  return code && ldapOn && !NO_FALLBACK.has(code) ? TEXT.ssoFallbackHint : null;
}


interface GatewayFailure { code?: unknown; message?: unknown; retry_after?: unknown; reason?: unknown }

export function loginFailureText(status: number, body: unknown, retryAfter?: number, o: { contact?: string | null } = {}): string {
  const b = (body ?? {}) as GatewayFailure;
  const code = typeof b.code === "string" ? b.code : "";
  if (status === 401) return TEXT.genericLoginFailure;
  if (status === 429) {
    if (b.reason === "in_flight") return TEXT.signInForThisAccountIsAlready;
    if (b.reason === "in_flight_address") return TEXT.tooManySignInsFromThisAddress;
    const sec = typeof b.retry_after === "number" ? b.retry_after : retryAfter ?? 0;
    return TEXT.tooManyFailedSignInAttemptsTry(Math.max(1, Math.ceil(sec / 60)));
  }
  if (status === 400) return TEXT.enterYourLoginAsUserUserExample;
  switch (code) {
    case "ldap_not_in_group": return TEXT.yourAccountDoesNotHaveAccessTo2(whereToAsk(o.contact));
    case "ldap_no_mail": return TEXT.yourCompanyDirectoryAccountHasNoEmail;
    case "person_inactive": return TEXT.yourMemoryAccountIsDisabledContactYour;
    case "person_conflict": return TEXT.twoEmployeeRecordsInMemoryMatchYour(TEXT.ask);
    case "ldap_disabled": return TEXT.passwordSignInIsOff;
    case "login_policy_changed": return TEXT.signInSettingsHaveJustChangedSign;
  }
  if (code === "forbidden" && status === 403) return TEXT.signInIsNotBeingAccepted(TEXT.ask);
  if (status >= 500) return TEXT.signInIsUnavailableTryAgainIn(TEXT.ask);
  return TEXT.signInDidNotCompleteTryAgain;
}

export function loginFailureDetail(status: number, body: unknown): string | null {
  if (status === 401 || status === 429 || status === 400) return null;
  const b = (body ?? {}) as GatewayFailure;
  const code = typeof b.code === "string" && b.code ? b.code : `HTTP ${status}`;
  const message = typeof b.message === "string" ? b.message.slice(0, 300) : "";
  const why = code === "forbidden" && status === 403 ? TEXT.theWorkspaceServerIsNotTrustedBy : message;
  return why ? `${code}: ${why}` : code;
}

export { TEXT } from "../messages/workplace-login";
