"use server";
import { ACTIONS_TEXT } from "../../../../messages/panel-alerts";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { denyAuditor } from "@/lib/admin-guard";
import { call } from "@/lib/gateway";
import { clearSessionCookie, requireSession } from "@/lib/session";
import { digestResultText, TEST_LEVELS, testResultText } from "./view";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function ackAlertAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const id = String(formData.get("id") ?? "");
  if (!UUID_RE.test(id)) return failState(ACTIONS_TEXT.noAlertID);
  const session = await requireSession();
  const { status, data } = await call(`/api/v1/admin/alerts/${id}/ack`, { method: "POST", body: {}, token: session.token });
  if (status === 401) { await clearSessionCookie(); redirect("/admin/login?expired=1"); }
  refresh();
  if (status === 200) return okState(ACTIONS_TEXT.markedAsAcknowledged);
  const body = (data ?? {}) as { message?: string };
  return failState(status === 404 ? ACTIONS_TEXT.alertNotFoundItMayHaveExpired : body.message ?? ACTIONS_TEXT.notAcknowledgedResponseValue1(status));
}

export async function testAlertsAction(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const session = await requireSession();
  const results: Array<{ level: string; status: number }> = [];
  for (const level of TEST_LEVELS) {
    const { status } = await call("/api/v1/admin/alerts/test", { method: "POST", body: { level }, token: session.token });
    if (status === 401) { await clearSessionCookie(); redirect("/admin/login?expired=1"); }
    results.push({ level, status });
  }
  refresh();
  const r = testResultText(results);
  return r.ok ? okState(r.text, { lines: [ACTIONS_TEXT.alertsWillAppearInAMinuteRefreshThePage] }) : failState(r.text);
}

export async function digestNowAction(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const session = await requireSession();
  const { status, data } = await call("/api/v1/admin/alerts/digest-now", { method: "POST", body: {}, token: session.token });
  if (status === 401) { await clearSessionCookie(); redirect("/admin/login?expired=1"); }
  refresh();
  const body = (data ?? {}) as { queued?: number; message?: string };
  const r = digestResultText(status, typeof body.queued === "number" ? body.queued : null, body.message);
  return r.ok ? okState(r.text) : failState(r.text);
}
