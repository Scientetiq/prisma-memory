// HTML pages of the built-in authorization server for agents: the refusals of
// GET /oauth/authorize that must not redirect (malformed request, wrong host, unknown app, return address not allowed),
// the 405 of HEAD, the 429 of the rate limits, the refusals of GET /oauth/authorize/continue ("started in another browser
// or expired") and the "Return to the app" page of the return modes link ([::1]) and custom (cursor://…). English first;
// the texts are the table of packages/shared/src/oauth-as/errors.ts (asText), placeholders filled by the caller.
//
// One rule for every page: whatever came from outside (a client title or self-chosen name, a host, a return address in a
// link) passes cleanText (no control or format characters — bidi overrides such as U+202E would flip "calls itself …") and
// then escapeHtml, in text and in attributes alike; nothing is inserted without it. The headers are the same on every
// page: a CSP that allows nothing but inline style and forbids forms, <base> and framing, no referrer, no sniffing,
// never cached.
import { AS_TEXT, asText, cimdReasonText, type AsTextCode, type CimdReason } from "@memory/shared/oauth-as";

/** Headers of every AS page. X-Frame-Options repeats frame-ancestors for old browsers. */
export const AS_PAGE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
});

const HTML_ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };

/** The one escaping function of the AS pages: & < > " ' ` — safe in text and in quoted attributes. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"'`]/g, (ch) => HTML_ESCAPES[ch]!);
}

// control and format characters (bidi marks such as U+202E), lone surrogates, line and paragraph separators
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

/** Text from outside without control and format characters, white space collapsed, at most `max` characters. */
export function cleanText(v: unknown, max = 200): string {
  if (max <= 0) return "";
  const s = (typeof v === "string" ? v : String(v ?? "")).replace(UNSAFE, "").replace(/\s+/g, " ").trim();
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join("")}…`;
}

/** cleanText, then escapeHtml: how every outside value enters a page. */
export const safe = (v: unknown, max?: number): string => escapeHtml(cleanText(v, max));

function document(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>`
    + "<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#f6f7f9;color:#1d2330}"
    + "main{max-width:520px;margin:12vh auto;padding:24px;background:#fff;border:1px solid #e3e6eb;border-radius:12px}"
    + "h1{font-size:18px;margin:0 0 12px}p{margin:8px 0}a{color:#1b55c9}.detail{color:#4a5262;font-size:14px}</style>"
    + `</head><body><main>${body}</main></body></html>`;
}

const page = (status: number, html: string, extra: Record<string, string> = {}): Response =>
  new Response(html, { status, headers: { ...AS_PAGE_HEADERS, ...extra } });

/** Reason of a refused app document for the line «App document: {host} — {reason}». */
export interface CimdRefusal { host: string | null; reason: CimdReason; status?: number; rule?: number }

/**
 * An error page without a redirect: the English text of `code` with `vars` filled
 * (every value cleaned and escaped), and for an app document the line with its host and the reason.
 */
export function errorPage(status: number, code: AsTextCode, o: { vars?: Record<string, string>; cimd?: CimdRefusal; headers?: Record<string, string> } = {}): Response {
  const vars = Object.fromEntries(Object.entries(o.vars ?? {}).map(([k, v]) => [k, cleanText(v, 300)]));
  let body = `<h1>${escapeHtml("Sign-in to memory")}</h1><p>${escapeHtml(asText(code, vars))}</p>`;
  if (o.cimd) {
    const reason = cimdReasonText(o.cimd.reason, { status: o.cimd.status, rule: o.cimd.rule });
    body += `<p class="detail">${escapeHtml("App document: ")}${safe(o.cimd.host ?? "unknown host", 253)} — ${safe(reason, 300)}</p>`;
  }
  return page(status, document("Sign-in to memory", body), o.headers);
}

/** HEAD /oauth/authorize (and /continue): 405 with Allow: GET, before anything else (no transaction, no cookie). */
export const methodNotAllowedPage = (): Response => errorPage(405, "method_not_allowed", { headers: { allow: "GET" } });

/** Rate limit of GET /oauth/authorize: 429 with Retry-After. */
export const rateLimitedPage = (retryAfter: number): Response =>
  errorPage(429, "temporarily_unavailable", { headers: { "retry-after": String(Math.max(1, Math.ceil(retryAfter))) } });

/**
 * "Return to {app}" (modes link and custom; link_mode): the code — or the error of the request — goes
 * to the app by a link the person follows, not by a redirect ([::1] is not a redirect target, a custom scheme opens an
 * installed app). `href` is the return address with the authorization response parameters; it is escaped like every
 * other value. With `error`, the page says what went wrong instead of "Sign-in is complete".
 */
export function returnPage(app: string, href: string, o: { error?: AsTextCode; headers?: Record<string, string> } = {}): Response {
  const name = cleanText(app, 80) || "the app";
  // the template is split before the name goes in: a name with " — " in it must not move text from the heading to the message
  const [labelTemplate = "Return to {app}", rest = ""] = AS_TEXT.link_mode.split(" — ");
  const label = labelTemplate.replace("{app}", () => name);
  const message = o.error ? asText(o.error) : rest;
  const body = `<h1>${escapeHtml(label)}</h1><p>${escapeHtml(message)}</p>`
    + `<p><a href="${escapeHtml(href)}" rel="noreferrer">${escapeHtml(label)}</a></p>`;
  return page(200, document(label, body), o.headers);
}
