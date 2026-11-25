"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { denyAuditor } from "@/lib/admin-guard";
import { call, GatewayError } from "@/lib/gateway";
import { clearSessionCookie, readSession } from "@/lib/session";
import { adminSessions as m } from "@/messages/admin-sessions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const confirmed = (form: FormData) => form.get("confirm_sessions") === "on";
async function signedOut(): Promise<never> {
  await clearSessionCookie();
  redirect("/admin/login");
}

/** A failed or lost response must never look like a successful global sign-out. */
export async function logoutAllAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  if (!confirmed(form)) return failState(m.confirm);
  const session = await readSession();
  if (!session) return signedOut();
  const legacy = !session.token.startsWith("mem_as_");
  try {
    const res = await call(legacy ? "/api/v1/admin/logout" : "/api/v1/admin-auth/logout-all", { method: "POST", token: session.token, timeoutMs: 10_000 });
    if (res.status === 401) return signedOut();
    const revoked = (res.data as { revoked?: unknown } | null)?.revoked;
    if (legacy ? res.status !== 204 : res.status !== 200 || !Number.isSafeInteger(revoked) || (revoked as number) < 0) return failState(m.failed);
  } catch (e) {
    if (!(e instanceof GatewayError)) throw e;
    return failState(m.failed);
  }
  return signedOut();
}

export async function endSessionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const denied = await denyAuditor();
  if (denied) return denied;
  if (!confirmed(form)) return failState(m.confirm);
  const id = String(form.get("session_id") ?? "");
  if (!UUID.test(id)) return failState(m.invalid);
  const session = await readSession();
  if (!session) return signedOut();
  if (session.role === "security_auditor") return failState(m.denied);
  try {
    const res = await call(`/api/v1/admin/sessions/${id}/revoke`, { method: "POST", token: session.token, timeoutMs: 10_000 });
    if (res.status === 401) return signedOut();
    const revoked = (res.data as { revoked?: unknown } | null)?.revoked;
    if (res.status !== 200 || !Number.isSafeInteger(revoked) || (revoked as number) < 1) return failState(m.failed);
  } catch (e) {
    if (!(e instanceof GatewayError)) throw e;
    return failState(m.failed);
  }
  if (session.sessionId?.toLowerCase() === id.toLowerCase()) return signedOut();
  revalidatePath("/admin/admins");
  return okState(m.ended);
}
