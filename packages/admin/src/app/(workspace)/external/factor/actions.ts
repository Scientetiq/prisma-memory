"use server";
import { headers } from "next/headers";
import { endedState } from "@/lib/action-ended";
import { failState, okState, type ActionResult } from "@/lib/action-state";
import { meGw } from "@/lib/me-api";
import { PREVIEW_TEXT } from "@/lib/preview";
import { actionSession } from "@/lib/user-session";
import { clientHeaders } from "@/lib/workplace-login";
import { factorRefusal, qrImageSrc } from "./texts";
import { WS_EXTERNAL_MESSAGES } from "@/messages/ws-external";

export interface FactorFlowState extends ActionResult {
  pending?: { id: string; qrSrc: string; secretText: string; expiresAt: string };
  codes?: string[];
}
export type FactorFlow = FactorFlowState | null;

type Extra = Partial<Omit<FactorFlowState, "ok" | "message" | "at">>;
const fail = (message: string, extra: Extra = {}): FactorFlowState => failState(message, extra);
const ok = (message: string, extra: Extra = {}): FactorFlowState => okState(message, extra);

async function human(): Promise<{ key: string } | FactorFlowState> {
  const session = await actionSession();
  if ("ok" in session) return session;
  if (session.preview) return fail(PREVIEW_TEXT.previewDenied, { lines: [PREVIEW_TEXT.previewDeniedHint] });
  return { key: session.key };
}

async function refused(res: { status: number; code: string; message: string; details?: unknown }): Promise<FactorFlowState> {
  const ended = await endedState(res);
  if (ended) return ended;
  const r = factorRefusal(res);
  return fail(r.message, { lines: r.lines, ...(r.link ? { link: r.link } : {}) });
}

const field = (fd: FormData, name: string): string => String(fd.get(name) ?? "").trim();
const codeField = (fd: FormData, name: string): string => field(fd, name).replace(/\s+/g, "");

interface Pending { pending_id: string; qr_svg: string; secret_text: string; expires_at: string }
const pendingState = (d: Pending, message: string): FactorFlowState =>
  ok(message, { pending: { id: d.pending_id, qrSrc: qrImageSrc(d.qr_svg), secretText: d.secret_text, expiresAt: d.expires_at } });

export async function startFactorAction(_prev: FactorFlow, fd: FormData): Promise<FactorFlowState> {
  const s = await human(); if ("message" in s) return s;
  const label = field(fd, "label").slice(0, 40);
  const res = await meGw<Pending>(s.key, "/api/v1/me/external/factor/enroll",
    { method: "POST", body: label ? { label } : {}, headers: clientHeaders(await headers()) });
  if (!res.ok) return refused(res);
  return pendingState(res.data, WS_EXTERNAL_MESSAGES.scanTheQrCodeWith);
}

export async function replaceFactorAction(_prev: FactorFlow, fd: FormData): Promise<FactorFlowState> {
  const s = await human(); if ("message" in s) return s;
  const proof = codeField(fd, "proof");
  if (!/^[0-9A-Za-z-]{6,32}$/.test(proof)) return fail(WS_EXTERNAL_MESSAGES.enterACode, { lines: [WS_EXTERNAL_MESSAGES.aCodeFromTheApp] });
  const label = field(fd, "label").slice(0, 40);
  const res = await meGw<Pending>(s.key, "/api/v1/me/external/factor/replace",
    { method: "POST", body: { proof: { code: proof }, ...(label ? { label } : {}) }, headers: clientHeaders(await headers()) });
  if (!res.ok) return refused(res);
  return pendingState(res.data, WS_EXTERNAL_MESSAGES.scanTheQrCodeWith2);
}

export async function confirmFactorAction(_prev: FactorFlow, fd: FormData): Promise<FactorFlowState> {
  const s = await human(); if ("message" in s) return s;
  const pending = field(fd, "pending_id"), code = codeField(fd, "code");
  if (!/^[0-9a-f-]{36}$/i.test(pending)) return fail(WS_EXTERNAL_MESSAGES.startSetupAgain);
  if (!/^[0-9]{6}$/.test(code)) return fail(WS_EXTERNAL_MESSAGES.enterTheSixDigitsFrom);
  const res = await meGw<{ recovery_codes: string[] }>(s.key, "/api/v1/me/external/factor/confirm", { method: "POST", body: { pending_id: pending, code } });
  if (!res.ok) return refused(res);
  return ok(WS_EXTERNAL_MESSAGES.secondFactorSetUp, { codes: res.data.recovery_codes, lines: [WS_EXTERNAL_MESSAGES.aNotificationHasBeenSent] });
}

export async function reissueCodesAction(_prev: FactorFlow, fd: FormData): Promise<FactorFlowState> {
  const s = await human(); if ("message" in s) return s;
  const proof = codeField(fd, "proof");
  if (!/^[0-9A-Za-z-]{6,32}$/.test(proof)) return fail(WS_EXTERNAL_MESSAGES.enterACode2, { lines: [WS_EXTERNAL_MESSAGES.aCodeFromTheApp2] });
  const res = await meGw<{ recovery_codes: string[] }>(s.key, "/api/v1/me/external/factor/recovery-codes", { method: "POST", body: { proof: { code: proof } } });
  if (!res.ok) return refused(res);
  return ok(WS_EXTERNAL_MESSAGES.newRecoveryCodes, { codes: res.data.recovery_codes, lines: [WS_EXTERNAL_MESSAGES.thePreviousCodesNoLonger] });
}
