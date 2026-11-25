"use server";
import { TEXT } from "../../../../messages/panel-smtp";
import { refresh } from "next/cache";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { denyAuditor } from "@/lib/admin-guard";
import { gw } from "@/lib/api";
import { GatewayError } from "@/lib/gateway";
import { saveSettingsSection } from "@/lib/settings-section";
import { SMTP_CLEAR_SECRET, SMTP_ERROR_TITLES, SMTP_FIELDS, smtpInput } from "@/lib/smtp-form";

const MAIL_RE = /^[^\s@<>()",;:\\[\]]{1,64}@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function saveSmtpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  return saveSettingsSection({ category: "smtp", fields: SMTP_FIELDS, input: smtpInput, clearSecret: SMTP_CLEAR_SECRET }, formData);
}

interface TestDirect { ok: boolean; to: string; host: string; port: number; security: string; code?: string; message?: string; detail?: string; latency_ms: number; message_id?: string }
interface TestQueued { queued: true; id: string; enabled: boolean; note: string }

export async function testSmtpAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const to = String(formData.get("to") ?? "").trim().toLowerCase();
  if (!MAIL_RE.test(to)) return failState(TEXT.enterTheRecipientSEmailAddress, { fieldErrors: { to: TEXT.emailAddressForExampleAdminExampleCom } });
  const via = formData.get("via") === "queue" ? "queue" : "direct";
  try {
    if (via === "queue") {
      const q = await gw<TestQueued>("/api/v1/admin/smtp/test", { method: "POST", body: { to, via }, timeoutMs: 30_000 });
      refresh();
      return q.enabled ? okState(TEXT.messageQueuedFor(to), { lines: [q.note, TEXT.seeTheMailLogBelowForIts] })
                       : okState(TEXT.theMessageIsQueuedMailSendingIs, { lines: [q.note] });
    }
    const r = await gw<TestDirect>("/api/v1/admin/smtp/test", { method: "POST", body: { to, via }, timeoutMs: 180_000 });
    const where = TEXT.text(r.host, r.port, r.security === "starttls" ? "STARTTLS" : r.security === "tls" ? "TLS" : TEXT.noEncryption);
    return r.ok
      ? okState(TEXT.testMessageSentTo(to), { lines: [TEXT.serverAcceptedTheMessageInMsCheck(where, r.latency_ms)] })
      : failState(r.message ?? TEXT.mailWasNotSent2, { lines: [TEXT.code(r.code, r.code && SMTP_ERROR_TITLES[r.code] ? ` — ${SMTP_ERROR_TITLES[r.code]}` : ""), TEXT.server(where), ...(r.detail ? [TEXT.response(r.detail)] : [])] });
  } catch (e) {
    if (e instanceof GatewayError) return failState(TEXT.mailWasNotSent(e.message));
    throw e;
  }
}

async function mailOp(formData: FormData, op: "retry" | "cancel"): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const id = String(formData.get("id") ?? "");
  if (!UUID_RE.test(id)) return failState(TEXT.messageIDIsMissing);
  try {
    await gw(`/api/v1/admin/mail/${id}/${op}`, { method: "POST", body: {} });
    refresh();
    return okState(op === "retry" ? TEXT.messageQueuedAgain : TEXT.messageCancelledItWillNotBeSent);
  } catch (e) {
    if (e instanceof GatewayError) return failState(e.message);
    throw e;
  }
}

export async function retryMailAction(_prev: ActionState, formData: FormData): Promise<ActionState> { return mailOp(formData, "retry"); }
export async function cancelMailAction(_prev: ActionState, formData: FormData): Promise<ActionState> { return mailOp(formData, "cancel"); }
