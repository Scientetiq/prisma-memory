"use server";
import { derived } from "@/i18n/runtime";
import { TEXT } from "@/messages/panel-open-check";
import { refresh } from "next/cache";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { denyAuditor } from "@/lib/admin-guard";
import { gw } from "@/lib/api";
import { text } from "@/lib/form";
import { formatCount } from "@/i18n/format";
import { GatewayError } from "@/lib/gateway";
import { effectivePacks, findingLine, parseExtraRule, parseNdaLines, parsePacks, TEST_TEXT_MAX } from "@/lib/open-check-form";
import { DESPITE_SETTING_KEYS, type DespiteToggle } from "@/lib/show-anyway";
import type { DespiteHideResult, OpenCheckExtraRule, OpenCheckTestResult, SettingsResponse } from "@/lib/types";

type Key = "enabled" | "disabled_rules" | "packs" | "extra_rules" | "nda_customers" | "timeout_sec" | (typeof DESPITE_SETTING_KEYS)[DespiteToggle];

async function current<T>(key: Key): Promise<{ value: T } | null> {
  const item = (await gw<SettingsResponse>("/api/v1/admin/settings")).items.find((i) => i.category === "open_check" && i.key === key);
  return item ? { value: item.value as T } : null;
}



async function put(key: Key, value: unknown): Promise<void> {
  await gw("/api/v1/admin/settings", { method: "PUT", body: { items: [{ category: "open_check", key, value }] } });
}

export async function setOpenCheckEnabledAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const enabled = text(formData, "enabled") === "true";
  try {
    if (!(await current<boolean>("enabled"))) return failState(TEXT.theGatewayDoesNotKnowTheOpenCheck);
    await put("enabled", enabled);
  } catch (e) {
    if (e instanceof GatewayError) return failState(TEXT.notSaved(String(e.message)));
    throw e;
  }
  refresh();
  return enabled
    ? okState(TEXT.openCheckIsOn, { lines: [TEXT.everyRecordEnteringOpenDataIsCheckedAgain] })
    : okState(TEXT.openCheckIsOff, { lines: [TEXT.recordsEnterOpenDataWithoutACheckTurn] });
}

export async function setOpenCheckTimeoutAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const raw = text(formData, "timeout_sec").replace(",", ".");
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n < 1 || n > 120) return failState(TEXT.checkTimeoutMustBeANumberOfSeconds, { fieldErrors: { timeout_sec: TEXT.from1To120Seconds } });
  let changed = false;
  try {
    const cur = await current<number>("timeout_sec");
    if (!cur) return failState(TEXT.theGatewayDoesNotKnowTheOpenCheck);
    changed = cur.value !== n;
    if (changed) await put("timeout_sec", n);
  } catch (e) {
    if (e instanceof GatewayError) return failState(TEXT.notSaved(String(e.message)));
    throw e;
  }
  refresh();
  if (!changed) return okState(TEXT.noChangesNothingToSave);
  return okState(TEXT.checkTimeoutPerRecordS(String(n)), { lines: [TEXT.theGatewayAndWorkersWillPickUpThe] });
}

/**
 * Rule packs (open_check.packs): core always stays; removing a pack weakens the check — the gateway applies its
 * policy for that (a second signature where it is required) and answers with the reason when the change is not saved.
 */
export async function setOpenCheckPacksAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const parsed = parsePacks(formData);
  if (!parsed.ok) return failState(parsed.error);
  let changed = false;
  try {
    const cur = await current<unknown>("packs");
    if (!cur) return failState(/* i18n */ TEXT.theGatewayDoesNotKnowTheSettingOpen);
    const before = effectivePacks(cur.value);
    changed = before.join(",") !== parsed.value.join(",") || !Array.isArray(cur.value);
    if (changed) await put("packs", parsed.value);
  } catch (e) {
    if (e instanceof GatewayError) return failState(/* i18n */ TEXT.packsNotSaved(e.message));
    throw e;
  }
  refresh();
  if (!changed) return okState(/* i18n */ TEXT.noChangesNothingToSave2);
  return okState(/* i18n */ TEXT.rulePacksSaved(TEXT.rulePacksList(parsed.value)), { lines: [/* i18n */ TEXT.theGatewayAndTheWorkersPickTheSetting] });
}

export async function toggleRuleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const name = text(formData, "name"), off = text(formData, "off") === "true";
  if (!/^[A-Za-z0-9_]{2,64}$/.test(name)) return failState(TEXT.ruleNameIsMissing);
  let changed = false;
  try {
    const cur = await current<string[]>("disabled_rules");
    if (!cur) return failState(TEXT.theGatewayDoesNotKnowTheOpenCheck);
    const list = Array.isArray(cur.value) ? cur.value.map(String)
      : (await gw<{ disabled_rules: string[] }>("/api/v1/admin/open-check")).disabled_rules.map(String);
    const next = off ? (list.includes(name) ? list : [...list, name]) : list.filter((n) => n !== name);
    changed = next.length !== list.length;
    if (changed) await put("disabled_rules", next);
  } catch (e) {
    if (e instanceof GatewayError) return failState(TEXT.notSaved(String(e.message)));
    throw e;
  }
  refresh();
  if (!changed) return okState(off ? TEXT.ruleIsAlreadyOff(String(name)) : TEXT.ruleIsAlreadyActive(String(name)));
  return okState(off ? TEXT.ruleIsOff(String(name)) : TEXT.ruleIsOn(String(name)));
}

export async function addRuleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const input = { name: text(formData, "name"), kind: text(formData, "kind"), pattern: String(formData.get("pattern") ?? ""), reason: text(formData, "reason") };
  let rule: OpenCheckExtraRule;
  try {
    const cur = await current<OpenCheckExtraRule[]>("extra_rules");
    if (!cur) return failState(TEXT.theGatewayDoesNotKnowTheOpenCheck);
    const list = Array.isArray(cur.value) ? cur.value : [];
    const parsed = parseExtraRule(input, list);
    if (!parsed.ok) return failState(TEXT.ruleWasNotAdded(String(parsed.error)));
    rule = parsed.value;
    await put("extra_rules", [...list, rule]);
  } catch (e) {
    if (e instanceof GatewayError) return failState(TEXT.ruleWasNotAdded(String(e.message)));
    throw e;
  }
  refresh();
  return okState(TEXT.ruleWasAdded(String(rule.name)), { lines: [TEXT.tryItWithAnExampleInTestText] });
}

export async function deleteRuleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const name = text(formData, "name");
  if (!/^[A-Za-z0-9_]{2,64}$/.test(name)) return failState(TEXT.ruleNameIsMissing);
  let found = false;
  try {
    const cur = await current<OpenCheckExtraRule[]>("extra_rules");
    if (!cur) return failState(TEXT.theGatewayDoesNotKnowTheOpenCheck);
    const list = Array.isArray(cur.value) ? cur.value : [];
    found = list.some((r) => r?.name === name);
    if (found) await put("extra_rules", list.filter((r) => r?.name !== name));
  } catch (e) {
    if (e instanceof GatewayError) return failState(TEXT.notDeleted(String(e.message)));
    throw e;
  }
  refresh();
  return okState(found ? TEXT.ruleWasDeleted(String(name)) : TEXT.ruleNoLongerExists(String(name)));
}

export async function saveNdaAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const parsed = parseNdaLines(String(formData.get("nda") ?? ""));
  if (!parsed.ok) return failState(TEXT.listWasNotSaved(String(parsed.error)));
  try {
    if (!(await current<string[]>("nda_customers"))) return failState(TEXT.theGatewayDoesNotKnowTheOpenCheck);
    await put("nda_customers", parsed.value);
  } catch (e) {
    if (e instanceof GatewayError) return failState(TEXT.listWasNotSaved(String(e.message)));
    throw e;
  }
  refresh();
  const n = parsed.value.length;
  return okState(n ? TEXT.listSavedCustomers(n) : TEXT.listClearedNoCustomersWithAStrictNDA, n ? { lines: [TEXT.blankLinesAndExactDuplicatesWereRemovedNames,
    TEXT.ifNamesWereAddedMemoryWillCheckExisting] } : {});
}

type TestResult = OpenCheckTestResult & { busy?: boolean; why?: string };
const BUSY_WHY: Record<string, string> = derived(() => ({
  queue_full: TEXT.theTestTextQueueIsFullOtherPanel,
  queued: TEXT.theCheckDidNotLeaveItsQueueWithin,
  thread_unavailable: TEXT.theTestTextWorkerCannotStartRightNow,
}));

export async function testTextAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const body = String(formData.get("text") ?? "");
  if (!body.trim()) return failState(TEXT.pasteTextToCheck);
  if (body.length > TEST_TEXT_MAX) return failState(TEXT.textIsTooLongUpToCharacters(String(formatCount(TEST_TEXT_MAX))));
  let res: TestResult;
  try {
    res = await gw<TestResult>("/api/v1/admin/open-check/test", { method: "POST", body: { text: body } });
  } catch (e) {
    if (e instanceof GatewayError) return failState(TEXT.checkWasNotCompleted(String(e.message)));
    throw e;
  }
  const off = res.enabled ? [] : [TEXT.theCheckIsOffARecordWithThese];
  if (res.busy) return failState(TEXT.theCheckServerIsBusyTryAgainIn, {
    lines: [BUSY_WHY[res.why ?? ""] ?? TEXT.checkWasNotCompletedTheCheckServerIs, TEXT.theTextWasNotCheckedThisIsNot] });
  if (res.timeout) return failState(TEXT.theCheckExceededItsTimeLimitARecord, {
    lines: [TEXT.aCustomPatternWithNestedRepetitionIsThe, ...off] });
  if (!res.findings.length) return okState(TEXT.checkPassedNoFindings, { lines: off });
  const lines = [...res.findings].sort((a, b) => a.at - b.at).map(findingLine);
  return failState(TEXT.theRecordWouldFailTheOpenCheckFindings(res.findings.length), { lines: [...lines, ...off] });
}

const DESPITE_DONE: Record<DespiteToggle, { on: string; off: string }> = derived(() => ({
  enabled: { on: TEXT.makeAvailableToAgentsIsOn, off: TEXT.makeAvailableToAgentsIsOffTheButton },
  projects: { on: TEXT.showingInTeamsAndProjectsIsOn, off: TEXT.showingInTeamsAndProjectsIsOffOnly },
  scansText: { on: TEXT.agentsSeeScansAsTextOnly, off: TEXT.showingScansAsTextIsOffNewAgent },
}));

export async function setDespiteToggleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const which = text(formData, "toggle") as DespiteToggle, value = text(formData, "value");
  if (!Object.hasOwn(DESPITE_SETTING_KEYS, which) || (value !== "true" && value !== "false")) return failState(TEXT.switchIsMissing);
  const on = value === "true";
  let changed = false;
  try {
    const cur = await current<unknown>(DESPITE_SETTING_KEYS[which]);
    if (!cur) return failState(TEXT.theGatewayDoesNotKnowTheOpenCheck);
    changed = (cur.value ?? true) !== on;
    if (changed) await put(DESPITE_SETTING_KEYS[which], on);
  } catch (e) {
    if (e instanceof GatewayError) return failState(TEXT.notSaved(String(e.message)));
    throw e;
  }
  refresh();
  if (!changed) return okState(TEXT.noChangesNothingToSave);
  const hideShown = which === "scansText" && !on
    ? [TEXT.toHideRecordsAlreadyShownInTeamsAnd] : [];
  return okState(on ? DESPITE_DONE[which].on : DESPITE_DONE[which].off, { lines: [TEXT.theGatewayAndWorkersWillPickUpThe, ...hideShown] });
}

export async function hideShownAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  if (formData.get("confirm") !== "on") return failState(TEXT.confirmBySelectingIUnderstand);
  let res: DespiteHideResult;
  try {
    res = await gw<DespiteHideResult>("/api/v1/admin/despite/hide", { method: "POST", body: { confirm: true } });
  } catch (e) {
    if (e instanceof GatewayError) {
      const reason = (e.details as { reason?: unknown } | undefined)?.reason;
      if (reason !== "despite_projects_on") return failState(TEXT.notHidden(String(e.message)));
      refresh();
      return failState(TEXT.turnOffShowingInTeamsAndProjectsFirst);
    }
    throw e;
  }
  refresh();
  const lines = [
    ...(res.busy.length ? [TEXT.stillMovingAndNotHiddenClickAgainIn(String(res.busy.length))] : []),
    ...(res.left > 0 ? [TEXT.stillShownClickAgain(String(res.left))] : []),
    TEXT.authorsSeeThisInMyActionsAnythingAgents,
  ];
  const head = res.queued ? TEXT.beingHiddenFromAgents(String(res.queued))
    : res.busy.length ? TEXT.nothingToHideYetStillMovingClickAgain(String(res.busy.length))
    : TEXT.nothingToHideNoRecordsAreShownIn;
  return okState(head, { lines });
}
