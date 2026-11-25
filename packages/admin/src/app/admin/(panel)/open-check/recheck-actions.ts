"use server";
import { TEXT } from "@/messages/panel-open-check";
import { refresh } from "next/cache";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { denyAuditor } from "@/lib/admin-guard";
import { gw } from "@/lib/api";
import { text } from "@/lib/form";
import { GatewayError } from "@/lib/gateway";
import { RECHECK_BATCH_RANGE } from "./recheck-view";

async function putSetting(key: "recheck_on_nda_change" | "recheck_batch", value: unknown): Promise<void> {
  await gw("/api/v1/admin/settings", { method: "PUT", body: { items: [{ category: "open_check", key, value }] } });
}

export async function setRecheckOnChangeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const on = text(formData, "value") === "true";
  try { await putSetting("recheck_on_nda_change", on); } catch (e) {
    if (e instanceof GatewayError) return failState(TEXT.notSaved(String(e.message)));
    throw e;
  }
  refresh();
  return on
    ? okState(TEXT.recheckingWhenTheListGrowsIsOn, { lines: [TEXT.newNDAListNamesWillBeCheckedAgainst] })
    : okState(TEXT.recheckingWhenTheListGrowsIsOff, { lines: [TEXT.newNamesAreCheckedOnlyInNewRecords] });
}

export async function setRecheckBatchAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const n = Number(text(formData, "batch"));
  const [lo, hi] = RECHECK_BATCH_RANGE;
  if (!Number.isInteger(n) || n < lo || n > hi) return failState(TEXT.recordsPerStepMustBeAnIntegerFrom(String(lo), String(hi)), { fieldErrors: { batch: TEXT.fromTo(String(lo), String(hi)) } });
  try { await putSetting("recheck_batch", n); } catch (e) {
    if (e instanceof GatewayError) return failState(TEXT.notSaved(String(e.message)));
    throw e;
  }
  refresh();
  return okState(TEXT.recordsPerStep(String(n)), { lines: [TEXT.workersWillPickUpTheSettingWithinA] });
}

export async function startRecheckAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const action = text(formData, "action");
  if (action !== "held" && action !== "all") return failState(TEXT.actionIsMissing);
  try {
    await gw("/api/v1/admin/open-check/recheck", { method: "POST", body: { action } });
  } catch (e) {
    if (e instanceof GatewayError) return failState(TEXT.notStarted(String(e.message)));
    throw e;
  }
  refresh();
  return okState(action === "held" ? TEXT.recheckOfHiddenRecordsStarted : TEXT.checkOfAllOpenRecordsStarted, {
    lines: [action === "held"
      ? TEXT.recordsThatNoLongerViolateAnyRulesWill
      : TEXT.resultsWillAppearOnThisPageIfEmail] });
}
