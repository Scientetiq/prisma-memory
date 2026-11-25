"use server";
import { searchQualityActions as m } from "@/messages/panel-search-quality";
import { refresh } from "next/cache";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { denyAuditor } from "@/lib/admin-guard";
import { gw } from "@/lib/api";
import { GatewayError } from "@/lib/gateway";

export async function recountSearchQualityAction(): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  try {
    const out = await gw<{ queued: boolean; running?: boolean }>("/api/v1/admin/maintenance/search-outcomes", { method: "POST" });
    refresh();
    if (out.running) return okState(m.calculationIsAlreadyRunningNumbersWillRefreshWhen);
    return out.queued ? okState(m.recalculationStartedRefreshThePageInAMinute) : failState(m.couldNotStartNowCalculationWillRunAutomatically);
  } catch (e) {
    if (e instanceof GatewayError) return failState(m.notStarted(e.message));
    throw e;
  }
}
