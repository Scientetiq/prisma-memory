// Space export in the workplace: who sees the button, the page "what goes into the archive",
// the gateway's refusals in plain words and the streamed call of POST /api/v1/me/spaces/:slug/export. The archive itself
// is built by the gateway; the workplace never holds it: the download route (app/api/export/route.ts) hands the
// gateway's body to the browser as a stream. The gateway decides who may export; the button only spares a person a
// refusal: with the default `access.export_space_role = owner` it is shown to the owner of the space (the personal space
// is owned by its person), never in a preview ("view as") session.
import { request } from "node:http";
import { Readable } from "node:stream";
import { exportText, type ExportMessageId } from "./export.messages";
import { gatewayBase, gatewayFetch, planeOfPath } from "./gateway-transport";
import { browseHref } from "./spaces";

/** The download route of the workplace (POST only). */
export const EXPORT_ROUTE = "/api/export";
/** The page "what goes into the archive" of one space. */
export const EXPORT_PAGE = "/export";

/** A space slug as the gateway writes it (spaces.slug): lower-case letters, digits and hyphens, 2–63 characters. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
export const isExportSlug = (v: unknown): v is string => typeof v === "string" && SLUG_RE.test(v);

/** The page of the export of a space. */
export const exportPageHref = (slug: string): string => `${EXPORT_PAGE}?space=${encodeURIComponent(slug)}`;

/** Where "back" leads from the export page: a project or team — its page; another space — its records; unknown — the hub. */
export function exportBackHref(slug: string, kind: string | null | undefined): string {
  if (kind === "project" || kind === "team") return `/projects/${encodeURIComponent(slug)}`;
  return kind ? browseHref(`/spaces/${slug}`) : "/browse";
}

/** The button "Export this space": the owner of the space, not in a preview session. */
export const canExportSpace = (s: { role: string }, preview: boolean): boolean => !preview && s.role === "owner";

/** Download file name: prisma-memory-<slug>-<YYYY-MM-DD>.tar.gz — from the checked slug and the UTC date only. */
export function exportFileName(slug: string, at: Date = new Date()): string {
  return `prisma-memory-${isExportSlug(slug) ? slug : "space"}-${at.toISOString().slice(0, 10)}.tar.gz`;
}

/** Why an export did not start, in the workplace's own words (a fixed list: the code travels in the page address). */
export const EXPORT_PROBLEMS = ["forbidden_origin", "session", "preview", "bad_request", "disabled", "denied", "not_found", "running", "busy",
  "daily_limit", "rate_limited", "unavailable", "unreachable"] as const;
export type ExportProblem = (typeof EXPORT_PROBLEMS)[number];
export const isExportProblem = (v: unknown): v is ExportProblem => typeof v === "string" && (EXPORT_PROBLEMS as readonly string[]).includes(v);

/** The text of a problem. */
export const exportProblemText = (p: ExportProblem): string => exportText(`error.${p}` as ExportMessageId);

/**
 * A refusal of the gateway (status and its JSON body `{code, message, details: {reason}}`) → a problem. The gateway's
 * own reasons (export routes): 403 export_disabled / human_session_required / export_denied, 404, 409
 * export_running, 429 exports_busy / export_daily_limit (or the rate limit of the bucket), 503 when the audit log is down.
 */
export function exportProblemOf(status: number, body: unknown): ExportProblem {
  const b = (body ?? {}) as { code?: unknown; details?: { reason?: unknown } | null };
  const reason = typeof b.details?.reason === "string" ? b.details.reason : null;
  if (status === 401) return "session";
  if (status === 403) return reason === "export_disabled" ? "disabled" : reason === "human_session_required" ? "preview" : "denied";
  if (status === 404) return "not_found";
  if (status === 409 || reason === "export_running" || b.code === "in_progress") return "running";
  if (status === 429) return reason === "exports_busy" ? "busy" : reason === "export_daily_limit" ? "daily_limit" : "rate_limited";
  if (status === 400) return "bad_request";
  return "unavailable";
}

/** GET /api/v1/me/spaces/:slug/export/preview: numbers of what an export started now would contain. */
export interface ExportPreview {
  space: string; records: number; originals: number; bytes_estimate: number; classes: Array<"open" | "closed">; skipped_no_access: number;
  skipped_moving?: number;
}

/** "12 KB", "3.4 MB", "1.2 GB" — the size of the archive before compression, roughly. */
export function formatSize(bytes: number): string {
  const b = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (Math.round(b) < 1024) return `${Math.round(b)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  const shown = (x: number): number => (x >= 10 ? Math.round(x) : Math.round(x * 10) / 10);
  // the unit is chosen after rounding: 1023.96 MB reads "1 GB", never "1024 MB"
  let v = b / 1024, i = 0;
  while (shown(v) >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${shown(v)} ${units[i]}`;
}

const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/** The lines of the block "What goes into the archive", in order. */
export function exportPreviewLines(p: ExportPreview): string[] {
  const records = count(p.records), originals = count(p.originals), noAccess = count(p.skipped_no_access), moving = count(p.skipped_moving);
  const lines: string[] = [];
  if (!records) lines.push(exportText("page.records_none"));
  else {
    lines.push(records === 1 ? exportText("page.records_one") : exportText("page.records", { n: records }));
    if (originals) lines.push(originals === 1 ? exportText("page.originals_one") : exportText("page.originals", { n: originals }));
    lines.push(exportText("page.size", { size: formatSize(count(p.bytes_estimate)) }));
    lines.push(exportText(p.classes?.includes("closed") ? "page.classes_both" : "page.classes_open"));
    lines.push(exportText("page.versions"));
  }
  if (noAccess) lines.push(noAccess === 1 ? exportText("page.no_access_one") : exportText("page.no_access", { n: noAccess }));
  if (moving) lines.push(moving === 1 ? exportText("page.moving_one") : exportText("page.moving", { n: moving }));
  return lines;
}

/**
 * Until the gateway's answer is known: the headers of an archive (the audit event and the slot come first) or the whole
 * small body of a refusal. The archive's body itself has no limit here.
 */
export const EXPORT_HEADERS_TIMEOUT_MS = 60_000;

/**
 * POST /api/v1/me/spaces/:slug/export with the workplace session key, the answer as a stream: the body is never read
 * here. `signal` aborts the request at any moment (the browser went away) — the gateway sees the connection close and
 * frees its slot. A unix socket address is served by node:http with the body as a stream (gatewayFetch's unixFetch
 * collects bodies — fine for JSON, not for an archive of gigabytes).
 */
export function gatewayExportStream(key: string, slug: string, signal: AbortSignal): Promise<Response> {
  const path = `/api/v1/me/spaces/${encodeURIComponent(slug)}/export`;
  const base = gatewayBase(planeOfPath(path));
  const headers = { Authorization: `Bearer ${key}`, Accept: "application/gzip, application/json" };
  if (base.kind === "unix") return unixStream(base.socket, path, headers, signal);
  return gatewayFetch(base, path, { method: "POST", headers, signal });
}

/** POST over a unix socket; resolves with the status and headers as soon as they arrive, the body a web stream. */
export function unixStream(socket: string, path: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason ?? new Error("aborted")); return; }
    const req = request({ socketPath: socket, path, method: "POST", headers: { host: "localhost", "content-length": "0", ...headers } }, (res) => {
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (Array.isArray(v)) for (const x of v) h.append(k, x);
        else if (v !== undefined) h.set(k, String(v));
      }
      const status = res.statusCode ?? 502;
      if (status === 204 || status === 304 || status < 200) { res.resume(); resolve(new Response(null, { status, headers: h })); return; }
      resolve(new Response(Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>, { status, headers: h }));
    });
    req.on("error", reject);
    signal.addEventListener("abort", () => req.destroy(signal.reason instanceof Error ? signal.reason : new Error("aborted")), { once: true });
    req.end();
  });
}
