// Gateway calls of document versions in the workspace, with the person's session key. The history is the REST
// route GET /api/v1/records/{id}/versions. A new version goes to REST POST /api/v1/ingest/documents as
// multipart/form-data with the field `replaces`, not to memory_upload: the strict input schema of the MCP tool does not
// know the argument; once the contract adds it, the upload route may switch to the tool.
import "server-only";
import { call, GatewayError, toGatewayError } from "./gateway";
import { meGw, type MeResult } from "./me-api";
import type { RecordVersions, VersionUploadResult } from "./types";

/** The version chain of a record the person reads, newest first; an old gateway without the route answers 404. */
export const recordVersions = (key: string, id: string): Promise<MeResult<RecordVersions>> =>
  meGw<RecordVersions>(key, `/api/v1/records/${encodeURIComponent(id)}/versions`);

export type VersionUpload =
  | { ok: true; status: number; data: VersionUploadResult }
  | { ok: false; status: number; code: string; message: string; retryAfter?: number; hint?: string; details?: unknown;
      /** The gateway's reason of a refusal (`not_current`, `version_denied`, `upload_daily`…): top level or in details. */
      reason?: string };

/** A new version of document `replaces`: the file (and an optional title) as multipart to the REST ingest route. */
export async function uploadVersionRest(key: string, file: Blob, filename: string, replaces: string, title?: string, timeoutMs = 180_000): Promise<VersionUpload> {
  const form = new FormData();
  form.set("file", file, filename);
  form.set("replaces", replaces);
  if (title) form.set("title", title);
  // the body is encoded once here: the transport writes bytes with a length (an http origin or a unix socket alike)
  const encoded = new Response(form);
  const bytes = new Uint8Array(await encoded.arrayBuffer());
  const contentType = encoded.headers.get("content-type") ?? "multipart/form-data";
  let res;
  try {
    res = await call("/api/v1/ingest/documents", { method: "POST", token: key, raw: { bytes, contentType }, timeoutMs });
  } catch (e) {
    if (e instanceof GatewayError) return { ok: false, status: e.status, code: e.code, message: e.message };
    throw e;
  }
  if (res.status >= 400) {
    const err = toGatewayError(res.status, res.data);
    const body = res.data as { retry_after?: unknown; reason?: unknown } | null;
    const inDetails = (err.details as { reason?: unknown } | undefined)?.reason;
    const reason = typeof body?.reason === "string" ? body.reason : typeof inDetails === "string" ? inDetails : undefined;
    const retryAfter = res.retryAfter ?? (typeof body?.retry_after === "number" ? body.retry_after : undefined);
    return { ok: false, status: res.status, code: res.status === 429 ? "rate_limited" : err.code, message: err.message,
             ...(retryAfter !== undefined ? { retryAfter } : {}), ...(err.hint ? { hint: err.hint } : {}),
             ...(err.details !== undefined && err.details !== null ? { details: err.details } : {}), ...(reason ? { reason } : {}) };
  }
  return { ok: true, status: res.status, data: res.data as VersionUploadResult };
}
