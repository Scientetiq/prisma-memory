"use server";
import { ACTIONS_TEXT, TEXT } from "../../../../messages/panel-webauthn";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { call, GatewayError } from "@/lib/gateway";
import { clearSessionCookie, requireSession } from "@/lib/session";

export type KeyStep = { ok: true; tx: string; options: unknown } | { ok: false; code: string; message: string };
export type KeyDone = { ok: boolean; message: string };


const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function send(path: string, method: "GET" | "POST" | "DELETE", body?: unknown): Promise<{ status: number; data: Record<string, unknown> } | { status: 0; data: { code: string; message: string } }> {
  const s = await requireSession();
  if (!s.token.startsWith("mem_as_")) return { status: 0, data: { code: "not_sso", message: ACTIONS_TEXT.notSso } };
  let r;
  try {
    r = await call(path, { method, body, token: s.token, timeoutMs: 30_000 });
  } catch (e) {
    if (e instanceof GatewayError) return { status: 0, data: { code: e.code, message: e.message } };
    throw e;
  }
  const data = (r.data ?? {}) as Record<string, unknown>;
  if (r.status === 401 && data.code === "session_expired") { await clearSessionCookie(); redirect("/admin/login?expired=1"); }
  return { status: r.status, data };
}
const messageOf = (d: Record<string, unknown>, status: number): string =>
  TEXT[String(d.code ?? "")] ?? (typeof d.message === "string" && d.message ? d.message : ACTIONS_TEXT.notCompletedResponseValue1(status));

async function step(path: string): Promise<KeyStep> {
  const r = await send(path, "POST", {});
  if (r.status === 200 && typeof r.data.tx === "string" && r.data.options) return { ok: true, tx: r.data.tx, options: r.data.options };
  return { ok: false, code: String(r.data.code ?? ""), message: messageOf(r.data, r.status) };
}

export async function registerOptionsAction(): Promise<KeyStep> { return step("/api/v1/admin-auth/webauthn/register/options"); }

export async function registerVerifyAction(tx: string, credential: unknown, label: string): Promise<KeyDone> {
  const r = await send("/api/v1/admin-auth/webauthn/register/verify", "POST", { tx, credential, label: String(label ?? "").trim().slice(0, 61) });
  refresh();
  return r.status === 201 ? { ok: true, message: ACTIONS_TEXT.keyRegistered } : { ok: false, message: messageOf(r.data, r.status) };
}

export async function stepupOptionsAction(): Promise<KeyStep> { return step("/api/v1/admin-auth/stepup/options"); }

export async function stepupVerifyAction(tx: string, credential: unknown): Promise<KeyDone> {
  const r = await send("/api/v1/admin-auth/stepup/verify", "POST", { tx, credential });
  refresh();
  return r.status === 200 ? { ok: true, message: ACTIONS_TEXT.touchAcceptedYouCanRemoveAKeyOrAdd } : { ok: false, message: messageOf(r.data, r.status) };
}

export async function deleteOwnKeyAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = String(formData.get("id") ?? "");
  if (!UUID_RE.test(id)) return failState(ACTIONS_TEXT.noKeyID);
  const r = await send(`/api/v1/admin-auth/webauthn/credentials/${id}`, "DELETE");
  refresh();
  return r.status === 204 ? okState(ACTIONS_TEXT.keyRemovedItCanNoLongerBeUsedTo) : failState(messageOf(r.data, r.status));
}
