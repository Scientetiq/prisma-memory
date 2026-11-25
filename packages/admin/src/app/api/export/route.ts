// POST /api/export — the download of a space export. The page /export?space=<slug> submits a
// plain form here; the session cookie becomes the session key, the gateway builds the archive (POST
// /api/v1/me/spaces/:slug/export) and its body goes to the browser as a stream: the workplace never collects it,
// so an archive of gigabytes costs this process a few buffers, and a browser that goes away closes the gateway's
// connection (the gateway frees its export slot and writes the closing audit event).
//
// Order of the checks: where the request comes from first — a route outside Server Actions gets no Origin check from
// Next.js, and without it a page of a neighbouring address could spend the person's daily export limit and fill the
// audit log (the same rule as /api/upload, `fromOwnPages`); then the session, a preview session, the small body. POST
// only: the module exports nothing else, so Next.js answers any other method with 405.
//
// A refusal keeps the gateway's status. A form submit (a navigation) is sent back to the export page with a reason code
// from a fixed list (303), so the person reads the reason in words instead of a JSON page; a fetch() gets JSON. The
// export page's form says it is the form (a hidden field `from=page`): browsers send Sec-Fetch-Mode only to HTTPS and
// localhost, and the workplace on a plain-HTTP address (http://<IP>:<port>) must bring a refusal back to the page too.
// The field opens no door: the Origin check runs before the body is read, and a redirect only names the export page.
import { gatewayExportStream, EXPORT_HEADERS_TIMEOUT_MS, EXPORT_PAGE, exportFileName, exportProblemOf, exportProblemText, isExportSlug, type ExportProblem } from "@/lib/export";
import { readUserSession } from "@/lib/user-session";
import { fromOwnPages } from "@/lib/workplace-login";

/** The form carries one slug; anything bigger is not ours. */
const MAX_BODY_BYTES = 2048;
/** A gateway refusal is a small JSON body; read at most this much of it. */
const MAX_ERROR_BYTES = 64 * 1024;

/** The value of the export page's hidden field: the request is that page's form. */
const FROM_PAGE = "page";

const isFormBody = (req: Request): boolean => (req.headers.get("content-type") ?? "").toLowerCase().includes("application/x-www-form-urlencoded");

/**
 * A form submit (the browser navigates) rather than fetch(): refusals then go back to the page. Sec-Fetch-Mode: navigate
 * where the browser sends it (HTTPS, localhost), or the export page's own field `from=page` (any address).
 */
function isNavigation(req: Request, body: string | null): boolean {
  if ((req.headers.get("sec-fetch-mode") ?? "").trim().toLowerCase() === "navigate") return true;
  return body !== null && isFormBody(req) && new URLSearchParams(body).get("from") === FROM_PAGE;
}

function refuse(nav: boolean, status: number, problem: ExportProblem, slug: string | null, retryAfter?: string | null): Response {
  if (nav) {
    const q = new URLSearchParams();
    if (slug) q.set("space", slug);
    q.set("error", problem);
    return new Response(null, { status: 303, headers: { location: `${EXPORT_PAGE}?${q.toString()}`, "cache-control": "no-store" } });
  }
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  const ra = Number(retryAfter);
  if (retryAfter && Number.isFinite(ra) && ra >= 0) headers["retry-after"] = String(Math.ceil(ra));
  return new Response(JSON.stringify({ ok: false, code: problem, message: exportProblemText(problem), retryAfter: headers["retry-after"] ? Number(headers["retry-after"]) : null }),
    { status, headers });
}

/** The body, at most `max` bytes (a declared length above it is refused unread); null — too big. */
async function smallBody(req: Request, max: number): Promise<string | null> {
  const declared = Number.parseInt(req.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.byteLength;
    if (seen > max) { await reader.cancel().catch(() => undefined); return null; }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

/** The space from a form (`space=<slug>`) or a JSON body (`{"space": "<slug>"}`); not a slug — null. */
function spaceOf(req: Request, body: string): string | null {
  let v: unknown = null;
  if ((req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    try { v = (JSON.parse(body) as { space?: unknown } | null)?.space; } catch { v = null; }
  } else v = new URLSearchParams(body).get("space");
  return isExportSlug(v) ? v : null;
}

/** At most `max` bytes of a body as text (a refusal), the rest cancelled. */
async function errorText(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let seen = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); seen += value.byteLength;
      if (seen >= max) break;
    }
  } catch { /* a refusal cut short is still a refusal */ }
  await reader.cancel().catch(() => undefined);
  return Buffer.concat(parts).toString("utf8").slice(0, max);
}

export async function POST(req: Request): Promise<Response> {
  if (!fromOwnPages(req)) {
    return new Response(JSON.stringify({ ok: false, code: "forbidden_origin", message: exportProblemText("forbidden_origin") }),
      { status: 403, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  }
  const body = await smallBody(req, MAX_BODY_BYTES);
  const nav = isNavigation(req, body);
  if (body === null) return refuse(nav, 413, "bad_request", null);
  const slug = spaceOf(req, body);
  const session = await readUserSession();
  if (!session) return refuse(nav, 401, "session", slug);
  // a preview ("view as") session reads as somebody else: it never takes a copy of that person's records
  if (session.preview) return refuse(nav, 403, "preview", slug);
  if (!slug) return refuse(nav, 400, "bad_request", null);

  // the gateway's headers come after its audit event and slot; past the timeout nothing has been sent yet. The timer
  // runs until the answer is known: the headers of an archive, or the small body of a refusal (a refusal whose body
  // never ends must not hold the route either). The same controller aborts the stream later when the browser goes
  // away (its request signal), so the gateway sees the close.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error("export: the gateway did not answer in time")), EXPORT_HEADERS_TIMEOUT_MS);
  const onAbort = () => ctl.abort(req.signal.reason ?? new Error("export: the browser went away"));
  if (req.signal.aborted) onAbort(); else req.signal.addEventListener("abort", onAbort, { once: true });
  const settle = () => { clearTimeout(timer); req.signal.removeEventListener("abort", onAbort); };
  let res: Response;
  try {
    res = await gatewayExportStream(session.key, slug, ctl.signal);
  } catch {
    settle();
    return refuse(nav, 502, "unreachable", slug);
  }

  const type = (res.headers.get("content-type") ?? "").toLowerCase();
  if (res.status === 200 && type.startsWith("application/gzip") && res.body) {
    clearTimeout(timer);   // the archive itself has no time limit here; the browser's abort stays wired to the gateway
    return new Response(res.body, {
      status: 200,
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${exportFileName(slug)}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
  // not an archive: a refusal (its JSON), or a 200 that is not one (an old gateway without the route) — never a download.
  // A body cut short by the timer is still read as far as it came.
  const text = await errorText(res, MAX_ERROR_BYTES);
  settle();
  if (res.status < 400) return refuse(nav, 502, "unavailable", slug);
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  return refuse(nav, res.status, exportProblemOf(res.status, parsed), slug, res.headers.get("retry-after"));
}
