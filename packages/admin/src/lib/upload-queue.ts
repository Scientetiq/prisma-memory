import { uploadQueue as M } from "../messages/upload-queue";

export interface UploadReply {
  status: number;
  body: { ok?: boolean; code?: string; reason?: string | null; message?: string; retryAfter?: number | null; already_known?: boolean } | null;
}

export const UPLOAD_STOP_REASONS: ReadonlySet<string> = new Set(["upload_daily", "disk_low"]);
export const UPLOAD_MAX_WAITS = 10;
export const UPLOAD_WAIT_DEFAULT_SEC = 5;
export const UPLOAD_WAIT_MAX_SEC = 300;

export type UploadVerdict =
  | { kind: "uploaded" } | { kind: "known" }
  | { kind: "wait"; sec: number }
  | { kind: "stop"; message: string }
  | { kind: "failed" };

export function uploadVerdict(r: UploadReply): UploadVerdict {
  if (r.status >= 200 && r.status < 300 && r.body?.ok) return r.body.already_known ? { kind: "known" } : { kind: "uploaded" };
  if (r.status === 429 || r.body?.code === "rate_limited") {
    if (r.body?.reason && UPLOAD_STOP_REASONS.has(r.body.reason)) return { kind: "stop", message: r.body.message ?? M.memoryIsNotAcceptingFiles };
    const asked = typeof r.body?.retryAfter === "number" && Number.isFinite(r.body.retryAfter) ? r.body.retryAfter : UPLOAD_WAIT_DEFAULT_SEC;
    return { kind: "wait", sec: Math.min(UPLOAD_WAIT_MAX_SEC, Math.max(1, Math.ceil(asked))) };
  }
  return { kind: "failed" };
}

export interface UploadTally { uploaded: number; known: number; failed: number }

export const uploadSummary = (t: UploadTally): string => M.uploadedAlreadySavedFailed(t.uploaded, t.known, t.failed);

export const uploadWaitLine = (sec: number): string => M.memoryAsksYouToWaitSUploading(sec);

export interface UploadQueueDeps<F> {
  precheck(file: F): string | null;
  send(file: F): Promise<UploadReply>;
  sleep(ms: number): Promise<void>;
  onSending(index: number): void;
  onWait(index: number, sec: number): void;
  onDone(index: number, verdict: "uploaded" | "known" | "failed", reply: UploadReply | null, note?: string): void;
  onSkipped(index: number, message: string): void;
}

export async function runUploadQueue<F>(files: readonly F[], deps: UploadQueueDeps<F>): Promise<UploadTally> {
  const tally: UploadTally = { uploaded: 0, known: 0, failed: 0 };
  let stopped: string | null = null;
  for (let i = 0; i < files.length; i++) {
    if (stopped !== null) { deps.onSkipped(i, stopped); tally.failed++; continue; }
    const file = files[i]!;
    const early = deps.precheck(file);
    if (early !== null) { deps.onDone(i, "failed", null, early); tally.failed++; continue; }
    for (let waits = 0; ; waits++) {
      deps.onSending(i);
      let reply: UploadReply;
      try { reply = await deps.send(file); }
      catch { deps.onDone(i, "failed", null, M.noConnectionFileWasNotSent); tally.failed++; break; }
      const v = uploadVerdict(reply);
      if (v.kind === "wait" && waits < UPLOAD_MAX_WAITS) { deps.onWait(i, v.sec); await deps.sleep(v.sec * 1000); continue; }
      if (v.kind === "uploaded" || v.kind === "known") { deps.onDone(i, v.kind, reply); tally[v.kind]++; break; }
      if (v.kind === "stop") stopped = v.message;
      deps.onDone(i, "failed", reply, v.kind === "wait" ? M.memoryIsStillAskingYouToWait : undefined);
      tally.failed++;
      break;
    }
  }
  return tally;
}
