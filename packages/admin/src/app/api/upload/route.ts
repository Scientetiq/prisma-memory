import { UPLOAD_TEXT } from "../../../messages/api-upload";
import { NextResponse } from "next/server";
import { isSpaceRef } from "@/lib/form";
import { acceptedFormats, callTool, toolErrorMessage } from "@/lib/mcp";
import { archivedOf, derivedDenial } from "@/lib/mcp-parse";
import { getMe, uploadLimits, writableSpaces } from "@/lib/me";
import { PREVIEW_TEXT } from "@/lib/preview";
import type { WriteResult } from "@/lib/types";
import { readUserSession } from "@/lib/user-session";
import { isRecordId } from "@/lib/versions";
import { uploadVersionRest } from "@/lib/versions-api";
import { VERSIONS_TEXT } from "@/lib/versions.messages";
import { fromOwnPages } from "@/lib/workplace-login";

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const bodyLimit = (maxBytes: number): number => Math.floor(maxBytes * 1.4);

const tooLarge = (maxBytes: number) => NextResponse.json({ ok: false, code: "too_large", message: UPLOAD_TEXT.tooLarge(Math.floor(maxBytes / 1048576)) }, { status: 413 });

async function readForm(req: Request, declared: number, maxBodyBytes: number): Promise<FormData | "too_large" | "invalid"> {
  if (Number.isFinite(declared)) {
    try { return await req.formData(); } catch { return "invalid"; }
  }
  if (!req.body) return "invalid";
  let seen = 0, over = false;
  const counted = req.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      seen += chunk.byteLength;
      if (seen > maxBodyBytes) { over = true; ctl.error(new Error("too_large")); return; }
      ctl.enqueue(chunk);
    },
  }));
  try { return await new Response(counted, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData(); }
  catch { return over ? "too_large" : "invalid"; }
}

export async function POST(req: Request): Promise<Response> {
  if (!fromOwnPages(req)) return NextResponse.json({ ok: false, code: "forbidden", message: UPLOAD_TEXT.origin }, { status: 403 });
  const session = await readUserSession();
  if (!session) return NextResponse.json({ ok: false, code: "unauthorized", message: UPLOAD_TEXT.expired }, { status: 401 });
  if (session.preview) return NextResponse.json({ ok: false, code: "forbidden", message: `${PREVIEW_TEXT.previewDenied}. ${PREVIEW_TEXT.previewDeniedHint}` }, { status: 403 });

  const me = await getMe(session.key);
  if (!me.ok && me.status === 401) return NextResponse.json({ ok: false, code: "unauthorized", message: UPLOAD_TEXT.expired }, { status: 401 });
  const maxBytes = me.ok ? uploadLimits(me.data).maxBytes : DEFAULT_MAX_BYTES;
  const declared = Number.parseInt(req.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > bodyLimit(maxBytes)) return tooLarge(maxBytes);

  const fd = await readForm(req, declared, bodyLimit(maxBytes));
  if (fd === "too_large") return tooLarge(maxBytes);
  if (fd === "invalid") return NextResponse.json({ ok: false, code: "invalid_argument", message: UPLOAD_TEXT.formRequired }, { status: 400 });
  const file = fd.get("file");
  if (!(file instanceof File)) return NextResponse.json({ ok: false, code: "invalid_argument", message: UPLOAD_TEXT.fileRequired }, { status: 400 });
  if (file.size > maxBytes) return tooLarge(maxBytes);
  // a new version of a document (field `replaces`) — after the same Origin, session, preview and size checks
  const replaces = fd.get("replaces");
  if (replaces !== null) return uploadVersion(session.key, file, replaces, String(fd.get("title") ?? "").trim());
  const space = String(fd.get("space") ?? "me").trim() || "me";
  if (!isSpaceRef(space)) return NextResponse.json({ ok: false, code: "invalid_argument", message: UPLOAD_TEXT.invalidSpace }, { status: 400 });
  const title = String(fd.get("title") ?? "").trim();

  if (me.ok && space !== "me" && !writableSpaces(me.data).some((s) => s.slug === space)) {
    return NextResponse.json({ ok: false, code: "forbidden", message: UPLOAD_TEXT.cannotWrite }, { status: 403 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const args: Record<string, unknown> = { filename: file.name || "file", mime: file.type || "application/octet-stream", content_base64: bytes.toString("base64"), space };
  if (title) args.title = title.slice(0, 200);
  const res = await callTool<WriteResult>(session.key, "memory_upload", args, 180_000);
  if (!res.ok) {
    if (res.code === "rate_limited") {
      const reason = (res.details as { reason?: unknown } | undefined)?.reason;
      const stop = reason === "upload_daily" || reason === "disk_low";
      const wait = Math.max(1, Math.ceil(res.retryAfter ?? 5));
      return NextResponse.json({ ok: false, code: res.code, reason: typeof reason === "string" ? reason : null, message: stop ? res.message : toolErrorMessage(res), hint: null, accepted: null, retryAfter: wait },
                               { status: 429, headers: { "retry-after": String(wait) } });
    }
    return NextResponse.json({ ok: false, code: res.code, message: toolErrorMessage(res), hint: res.code === "open_check" ? res.hint ?? null : null, accepted: acceptedFormats(res), retryAfter: res.retryAfter ?? null }, { status: res.status >= 400 && res.status < 600 ? res.status : 400 });
  }
  const d = res.data;
  return NextResponse.json({ ok: true, id: d.id, path: d.path, type: d.type, space: d.space, class: d.class, stages: d.stages ?? [], already_known: d.already_known === true, queue: d.queue ?? null,
                             open_check: d.open_check ?? null });
}

/**
 * "Upload new version" on the record page. The file goes to REST POST /api/v1/ingest/documents as multipart with
 * `replaces` and the session key — memory_upload does not take the argument, the MCP contract does not define
 * it. The version stays in the space and class of the current version, so the form sends no space; the
 * gateway checks who may replace the document. The answer keeps the shape of an ordinary upload and adds `version`,
 * `version_pending` (a PDF or office file replaces the current version after processing) and, for a stale page,
 * `current_id`.
 */
async function uploadVersion(key: string, file: File, replaces: FormDataEntryValue, title: string): Promise<Response> {
  if (!isRecordId(replaces)) return NextResponse.json({ ok: false, code: "invalid_argument", message: VERSIONS_TEXT.badId }, { status: 400 });
  const res = await uploadVersionRest(key, file, file.name || "file", replaces, title ? title.slice(0, 200) : undefined);
  if (!res.ok) {
    if (res.code === "rate_limited") {
      const stop = res.reason === "upload_daily" || res.reason === "disk_low";
      const wait = Math.max(1, Math.ceil(res.retryAfter ?? 5));
      return NextResponse.json({ ok: false, code: res.code, reason: res.reason ?? null, message: stop ? res.message : toolErrorMessage(res), hint: null, accepted: null, retryAfter: wait },
                               { status: 429, headers: { "retry-after": String(wait) } });
    }
    const currentId = (res.details as { current_id?: unknown } | undefined)?.current_id;
    const stale = res.reason === "not_current";
    // the gateway's own texts of versions are written for the person (doc-versions.messages.ts); "not current" names the
    // agents' field — the page says it in its own words and links the current version. A read-only space is class_denied
    // without an archive mark: its text is the gateway's, not the general words of a closed record
    const ownText = res.code === "class_denied" && !archivedOf(res.details) && !derivedDenial(res.details) && Boolean(res.message);
    return NextResponse.json({ ok: false, code: res.code, reason: res.reason ?? null, message: stale ? VERSIONS_TEXT.upload.notCurrent : ownText ? res.message : toolErrorMessage(res),
                               hint: res.code === "open_check" ? res.hint ?? null : null,
                               current_id: stale && isRecordId(currentId) ? currentId : null, accepted: acceptedFormats(res), retryAfter: res.retryAfter ?? null },
                             { status: res.status >= 400 && res.status < 600 ? res.status : 400 });
  }
  const d = res.data;
  return NextResponse.json({ ok: true, id: d.id, path: d.path, type: d.type, space: d.space, class: d.class, stages: d.stages ?? [], already_known: d.already_known === true, queue: d.queue ?? null,
                             open_check: d.open_check ?? null, version: typeof d.version === "number" ? d.version : 1, version_pending: d.version_pending === true,
                             // the gateway's word on the same file sent again ("already being processed as new version 3")
                             note: typeof d.note === "string" ? d.note : null });
}
