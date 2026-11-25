"use server";
import { shipText } from "@/messages/panel-audit-ship";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { denyAuditor } from "@/lib/admin-guard";
import { call } from "@/lib/gateway";
import { clearSessionCookie, requireSession } from "@/lib/session";

export async function reconcileAction(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const session = await requireSession();
  const { status, data } = await call("/api/v1/admin/audit-ship/reconcile", { method: "POST", body: {}, token: session.token });
  if (status === 401) { await clearSessionCookie(); redirect("/admin/login?expired=1"); }
  refresh();
  if (status === 202) return okState(shipText.reconciliationQueued, { lines: [shipText.theResultWillAppearHereInA] });
  const body = (data ?? {}) as { message?: string };
  return failState(body.message ?? shipText.notQueuedResponse(status));
}
