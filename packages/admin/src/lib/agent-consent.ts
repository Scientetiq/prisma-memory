import { currentLocale } from "../i18n/runtime";
// Agent consent screen of the built-in sign-in server: pure functions shared by the page
// /connect/authorize, its route handlers (decide, signout) and the tests. The workplace does not import @memory/shared
// (its image is built from packages/admin alone), so everything it needs about the request lives here.
//
// What the module decides:
//  * the shape of `GET /api/v1/me/oauth/tx/:id` — anything else is "failed", never a half-drawn consent screen;
//  * which lines the screen shows (known / unknown app, auto-registered, loopback, custom scheme, stale request);
//  * whether the `continue_url` the gateway returned may become a 303 — https (or loopback development), exactly
//    `/oauth/authorize/continue`, the origin equal to the issuer that the handler itself read from the server, the same
//    `tx`, one `c`. Anything else is a 502 without a redirect;
//  * the small HTML page of the route handlers' refusals, with every value escaped.
import { consentAge, consentText, type ConsentTextKey, type ConsentVars } from "./agent-consent-text";

/** Request id: `randomSecret()` of the gateway — 32 bytes in base64url, 43 characters. */
export const isTxId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);
/** CSRF value of a request (base64url); the gateway compares it in constant time, here only the form is checked. */
export const isCsrf = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(v);
/** Continuation key `c` (base64url, single use). */
const isContinueKey = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(v);

/** The consent page of a request: the return path after signing in and after "Not you? Sign out". */
export const consentPath = (tx: string): string => `/connect/authorize?tx=${encodeURIComponent(tx)}`;

/** A request older than this gets the stale warning (consent phishing). */
export const STALE_AFTER_SECONDS = 180;
export const isStale = (startedSecondsAgo: number): boolean => startedSecondsAgo > STALE_AFTER_SECONDS;

/** Gateway path of the request and of the decision; not reachable from the agent address. */
export const txApiPath = (tx: string): string => `/api/v1/me/oauth/tx/${encodeURIComponent(tx)}`;
export const CONSENT_API_PATH = "/api/v1/me/oauth/consent";
/** Where the decision handler reads the issuer: `agent_auth.issuer` of the connection settings. */
export const CONNECT_CONFIG_PATH = "/api/v1/me/connections/config";
export const CONTINUE_PATH = "/oauth/authorize/continue";

const LOOPBACK_DEV_HOSTS = new Set(["localhost", "127.0.0.1"]);
/** `http://localhost` and `http://127.0.0.1`, any port — the only non-HTTPS issuers (development). */
export function isLoopbackDev(u: URL): boolean {
  return u.protocol === "http:" && LOOPBACK_DEV_HOSTS.has(u.hostname);
}

/** The issuer as an origin (`https://host[:port]`), or null if it is not a valid issuer (path, query, credentials, HTTP). */
export function issuerOrigin(issuer: unknown): string | null {
  if (typeof issuer !== "string" || !issuer || issuer.length > 2048) return null;
  let u: URL;
  try { u = new URL(issuer); } catch { return null; }
  if (u.protocol !== "https:" && !isLoopbackDev(u)) return null;
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return null;
  return u.origin;
}

/**
 * The continuation address the gateway answered with, if it is safe to send the browser there:
 * absolute, https (or loopback development), no credentials and no fragment, origin equal to `issuer`, path exactly
 * `/oauth/authorize/continue`, and the query exactly `tx` (the request being decided) and `c`, once each. Returns the
 * normalised address, otherwise null. `issuer` must come from the server side — never from the form or request headers.
 */
export function checkContinueUrl(raw: unknown, issuer: unknown, tx: string): string | null {
  const origin = issuerOrigin(issuer);
  if (!origin || typeof raw !== "string" || !raw || raw.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(raw) || raw.includes("#")) return null;
  if (raw.includes("\\") || !raw.startsWith(`${origin}${CONTINUE_PATH}?`)) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" && !isLoopbackDev(u)) return null;
  if (u.username || u.password || u.origin !== origin || u.pathname !== CONTINUE_PATH) return null;
  const keys = [...u.searchParams.keys()];
  if (keys.length !== 2 || keys.filter((k) => k === "tx").length !== 1 || keys.filter((k) => k === "c").length !== 1) return null;
  if (u.searchParams.get("tx") !== tx || !isContinueKey(u.searchParams.get("c"))) return null;
  return u.href;
}

// ---------------------------------------------------------------- the request as the gateway returns it

export type ClientSource = "registry" | "cimd" | "dcr";
export interface ConsentClient { id: string; title: string; kind: string; source: ClientSource; known: boolean; host: string; name: string | null }
export interface ConsentTx {
  issuer: string;
  client: ConsentClient;
  redirect_host: string;
  loopback: boolean;
  custom_scheme: boolean;
  connection_days: number;
  person: { display_name: string; login: string };
  csrf: string;
  fresh_login_required: boolean;
  started_seconds_ago: number;
  expires_at: string;
  consent_version: number;
  decided: "allow" | "deny" | null;
}

/** Text from outside (client title, self-name, host): no control or format characters (bidi overrides), trimmed, capped. */
export function cleanLabel(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  return s ? s.slice(0, max) : null;
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);
const SOURCES: readonly ClientSource[] = ["registry", "cimd", "dcr"];

/**
 * The host of an app document address (CIMD `client_id`): an https URL without credentials. The consent screen
 * names an unknown app by this host, so it is taken from the address itself, never from a separate field of
 * the answer. Not such an address — null (the answer is malformed).
 */
export function cimdDocumentHost(id: string): string | null {
  let u: URL;
  try { u = new URL(id); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || !u.host) return null;
  return u.host;
}

/**
 * The request from `GET /api/v1/me/oauth/tx/:id`, or null when the answer does not have the expected shape — then the
 * page says "Something went wrong" instead of drawing a consent screen from guesses. Text fields are cleaned.
 */
export function parseConsentTx(data: unknown): ConsentTx | null {
  const d = obj(data), c = obj(d?.client), p = obj(d?.person);
  if (!d || !c || !p) return null;
  const issuer = issuerOrigin(d.issuer);
  const source = SOURCES.find((s) => s === c.source);
  const id = cleanLabel(c.id, 255), title = cleanLabel(c.title, 80) ?? "", kind = cleanLabel(c.kind, 40) ?? "cloud_other";
  // an app document is named by the host of its own address, whatever `client.host` says
  const host = source === "cimd" ? (id ? cimdDocumentHost(id) : null) : (cleanLabel(c.host, 255) ?? ""), name = cleanLabel(c.name, 100);
  if (host === null) return null;
  // the return host is required, except for a private-use scheme (RFC 8252 §7.1): `com.example.app:/oauth/cb` is a valid
  // registry address (`{uri}`) and has no host, so the gateway's redirect_host is empty for it
  const loopback = d.loopback === true, customScheme = d.custom_scheme === true;
  const hostless = !loopback && customScheme && d.redirect_host === "";
  const redirectHost = hostless ? "" : cleanLabel(d.redirect_host, 255);
  const days = d.connection_days, ago = d.started_seconds_ago;
  const decided = d.decided === "allow" || d.decided === "deny" ? d.decided : d.decided === null || d.decided === undefined ? null : undefined;
  if (!issuer || !source || !id || typeof c.known !== "boolean" || (!redirectHost && !hostless) || !isCsrf(d.csrf) || decided === undefined) return null;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 3650) return null;
  if (typeof ago !== "number" || !Number.isFinite(ago) || ago < 0) return null;
  const displayName = cleanLabel(p.display_name, 200), login = cleanLabel(p.login, 200);
  if (!displayName || !login) return null;
  // an automatically registered client is never "known", whatever the answer says (consent screen)
  const known = source === "dcr" ? false : c.known;
  // a known app is named by its title; without a title it is not presentable as known
  if (known && !title) return null;
  // an unknown app is named by a host (its own, or the return host); with neither there is nothing honest to show
  if (!known && !host && !redirectHost) return null;
  return {
    issuer, redirect_host: redirectHost ?? "", connection_days: days, csrf: d.csrf as string,
    client: { id, title, kind, source, known, host, name },
    loopback, custom_scheme: customScheme,
    person: { display_name: displayName, login },
    fresh_login_required: d.fresh_login_required === true,
    started_seconds_ago: Math.floor(ago),
    expires_at: typeof d.expires_at === "string" ? d.expires_at : "",
    consent_version: typeof d.consent_version === "number" ? d.consent_version : 1,
    decided,
  };
}

/**
 * How the screen names the app: a known app — by its title; an unknown CIMD app — by the host of its
 * document address (`client.host`, which parseConsentTx takes from the address itself), never by the name it gives itself
 * and never by the return host; an automatically registered one — by the host of this request's return address.
 */
export function consentApp(tx: ConsentTx): { app: string; host: string } {
  if (tx.client.known) return { app: tx.client.title, host: tx.client.host || tx.redirect_host };
  const host = tx.client.source === "cimd" ? tx.client.host : tx.client.source === "dcr" ? tx.redirect_host : tx.client.host || tx.redirect_host;
  return { app: host, host };
}

export interface ConsentLine { key: ConsentTextKey; vars?: ConsentVars; tone?: "warn" | "mark" }

/**
 * The lines of the consent screen in order: who is asking, the unknown and auto-registered marks, "allow only if
 * you started it" and the age — for every client (registry, CIMD, DCR, loopback), the stale warning after 3 minutes, where
 * the code goes, what the app can do, for how long and where to disconnect it.
 */
export function consentLines(tx: ConsentTx): ConsentLine[] {
  const { app, host } = consentApp(tx);
  const out: ConsentLine[] = [];
  out.push(tx.client.known ? { key: "app_known", vars: { app } } : { key: "app_unknown", vars: { host } });
  if (!tx.client.known && tx.client.name) out.push({ key: "calls_itself", vars: { name: tx.client.name } });
  if (!tx.client.known) out.push({ key: "unknown_mark", tone: "mark" });
  if (tx.client.source === "dcr") out.push({ key: "dcr_mark", tone: "mark" });
  out.push({ key: "started_by_you", vars: { app } });
  out.push({ key: "started_ago", vars: { age: consentAge(tx.started_seconds_ago) } });
  if (isStale(tx.started_seconds_ago)) out.push({ key: "stale_warning", tone: "warn" });
  if (tx.loopback) out.push({ key: "loopback_warning" });
  else if (tx.custom_scheme) out.push(tx.redirect_host ? { key: "custom_warning", vars: { host: tx.redirect_host } } : { key: "custom_warning_no_host" });
  else out.push({ key: "redirect", vars: { host: tx.redirect_host } });
  out.push({ key: "scope" });
  out.push({ key: "duration", vars: { days: tx.connection_days } });
  out.push({ key: "revoke_hint" });
  return out;
}

/** The decision from the form: exactly "allow" or "deny". */
export const parseDecision = (v: unknown): "allow" | "deny" | null => (v === "allow" || v === "deny" ? v : null);

// ---------------------------------------------------------------- refusal page of the route handlers

/** One escaping function for every value placed into the page (text and attributes). */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"'`]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" })[ch]!);
}

/** Headers of the handlers' own pages: never cached, never framed, no referrer, nothing but inline style. */
export const CONSENT_PAGE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
};

/** A small localized page with one dictionary text (gone, decided, preview, failed): the refusals of decide and signout. */
export function consentRefusalHtml(key: ConsentTextKey): string {
  const text = escapeHtml(consentText(key)), title = escapeHtml(consentText("document_title")), brand = escapeHtml(consentText("brand"));
  return `<!doctype html><html lang="${currentLocale()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>`
    + `<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#f6f7f9;color:#1d2330}main{max-width:480px;margin:12vh auto;padding:24px;background:#fff;border:1px solid #e3e6eb;border-radius:12px}b{display:block;margin-bottom:8px}</style>`
    + `</head><body><main><b>${brand}</b><p>${text}</p></main></body></html>`;
}

/** The refusal page as a response. */
export function consentRefusal(status: number, key: ConsentTextKey): Response {
  return new Response(consentRefusalHtml(key), { status, headers: { ...CONSENT_PAGE_HEADERS } });
}
