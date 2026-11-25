"use server";
import { ACTION_TEXT } from "@/messages/settings-actions";
import { refresh } from "next/cache";
import { refreshInstanceNow } from "@/i18n/instance.server";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { approvalPendingOf, approvalPendingState } from "@/lib/admin-form";
import { denyAuditor } from "@/lib/admin-guard";
import { gw } from "@/lib/api";
import { GatewayError } from "@/lib/gateway";
import { CATEGORY_TITLES } from "@/lib/labels";
import { OWNED_ELSEWHERE, settingLabel } from "@/lib/setting-labels";
import { SETTINGS_VALUES_TEXT, clearControl, editorKind, fieldClear, fieldConfirmClear, fieldDecision, fieldMode, fieldOrig, fieldValue, isUnconfirmedClear,
         parseEditorValue, sameValue, secretInput, toEditorText } from "@/lib/settings-values";
import type { Category, ConverterCheck, SettingsResponse, SettingsUpdateResponse } from "@/lib/types";

const pathLabel = (path: string): string => { const dot = path.indexOf("."); return dot > 0 ? settingLabel(path.slice(0, dot), path.slice(dot + 1)) : path; };

const gatewayProblem = (e: GatewayError): string => (isUnconfirmedClear(e.code, e.details) ? SETTINGS_VALUES_TEXT.changedElsewhere : e.message);

export async function saveCategoryAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const category = String(formData.get("category") ?? "").trim() as Category;
  if (!/^[a-z0-9_]{1,40}$/.test(category)) return failState(ACTION_TEXT.unknownCategory);

  const changes: Array<{ category: Category; key: string; value: unknown; confirm_clear?: true }> = [];
  const fieldErrors: Record<string, string> = {};
  let missing: string[] = [];
  try {
    const current = await gw<SettingsResponse>("/api/v1/admin/settings");
    const own = current.items.filter((i) => i.category === category);
    if (!own.length) return failState(ACTION_TEXT.noCategory(category));
    for (const item of own) {
      const raw = formData.get(fieldValue(item.key));
      if (typeof raw !== "string") continue;
      if (OWNED_ELSEWHERE.has(`${category}.${item.key}`)) continue;
      if (item.secret) {
        if (formData.get(fieldClear(item.key)) === "on") {
          const how = clearControl(`${category}.${item.key}`, item);
          if (how === "checkbox") changes.push({ category, key: item.key, value: null });
          else if (how === "button") fieldErrors[item.key] = ACTION_TEXT.requiredKeyButton;
          else if (item.isSet) fieldErrors[item.key] = ACTION_TEXT.immutableKey;
        } else {
          const typed = secretInput(raw);
          if (typed !== null) changes.push({ category, key: item.key, value: typed });
        }
        continue;
      }
      const kind = editorKind(item);
      if (kind === "secret") continue;
      const asJson = item.value === null && formData.get(fieldMode(item.key)) === "json";
      const parsed = parseEditorValue(asJson ? "json" : kind, raw, item.value);
      if (!parsed.ok) { fieldErrors[item.key] = parsed.error; continue; }
      const origRaw = formData.get(fieldOrig(fieldValue(item.key)));
      const orig = typeof origRaw === "string" ? parseEditorValue(asJson ? "json" : kind, origRaw, item.value) : null;
      const server = parseEditorValue(asJson ? "json" : kind, toEditorText(kind, item.value), item.value);
      const decision = fieldDecision(parsed.value, orig?.ok ? orig : null, server.ok ? server.value : item.value, sameValue);
      if (decision === "skip") continue;
      if (decision === "conflict") { fieldErrors[item.key] = SETTINGS_VALUES_TEXT.changedInOtherWindow; continue; }
      if (parsed.value === null && item.required && item.isSet) {
        if (formData.get(fieldConfirmClear(item.key)) !== "on") { fieldErrors[item.key] = SETTINGS_VALUES_TEXT.requiredEmptyError; continue; }
        changes.push({ category, key: item.key, value: null, confirm_clear: true });
        continue;
      }
      changes.push({ category, key: item.key, value: parsed.value });
    }
    if (Object.keys(fieldErrors).length) {
      const stale = Object.entries(fieldErrors).filter(([, m]) => m === SETTINGS_VALUES_TEXT.changedInOtherWindow).map(([k]) => settingLabel(category, k));
      return stale.length
        ? failState(ACTION_TEXT.stale, { fieldErrors, lines: [ACTION_TEXT.staleFields(stale.join(", "))] })
        : failState(ACTION_TEXT.fixFields, { fieldErrors });
    }
    if (!changes.length) return okState(ACTION_TEXT.noChanges);
    const saved = await gw<SettingsUpdateResponse>("/api/v1/admin/settings", { method: "PUT", body: { items: changes } });
    const pending = approvalPendingOf(saved);
    if (pending) { refresh(); return approvalPendingState(pending); }
    missing = saved.missing_required ?? [];
  } catch (e) {
    if (e instanceof GatewayError) return failState(ACTION_TEXT.notSaved(gatewayProblem(e)));
    throw e;
  }

  // the interface language and time zone of the installation changed: read them again before the page re-renders
  if (category === "locale") await refreshInstanceNow();
  refresh();
  return okState(ACTION_TEXT.saved(CATEGORY_TITLES[category] ?? category, changes.length), {
    lines: [
      ACTION_TEXT.changed(changes.map((c) => settingLabel(category, c.key)).join(", ")),
      missing.length ? ACTION_TEXT.missing(missing.map(pathLabel).join(", ")) : ACTION_TEXT.complete,
    ],
  });
}

export async function clearRequiredAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const category = String(formData.get("category") ?? "").trim() as Category;
  const key = String(formData.get("key") ?? "").trim();
  if (!/^[a-z0-9_]{1,40}$/.test(category) || !/^[a-z0-9_]{1,80}$/.test(key)) return failState(ACTION_TEXT.unknownSetting);
  try {
    const current = await gw<SettingsResponse>("/api/v1/admin/settings");
    const item = current.items.find((i) => i.category === category && i.key === key);
    if (!item) return failState(ACTION_TEXT.noSetting);
    const how = clearControl(`${category}.${key}`, item);
    if (how === "none") return failState(!item.secret ? ACTION_TEXT.notSecret
      : !item.isSet ? ACTION_TEXT.keyUnset : ACTION_TEXT.immutableKey);
    if (how === "checkbox") return failState(ACTION_TEXT.optionalKey);
    const pending = approvalPendingOf(await gw<SettingsUpdateResponse>("/api/v1/admin/settings", { method: "PUT", body: { items: [{ category, key, value: null, confirm_clear: true }] } }));
    if (pending) { refresh(); return approvalPendingState(pending); }
  } catch (e) {
    if (e instanceof GatewayError) return failState(ACTION_TEXT.notCleared(gatewayProblem(e)));
    throw e;
  }
  refresh();
  return okState(ACTION_TEXT.cleared(settingLabel(category, key)), {
    lines: [ACTION_TEXT.clearedHint],
  });
}

export async function checkConverterAction(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  let res: ConverterCheck;
  try {
    res = await gw<ConverterCheck>("/api/v1/admin/integrations/converter/check", { method: "POST", body: {} });
  } catch (e) {
    if (e instanceof GatewayError) return failState(ACTION_TEXT.checkFailed(e.message));
    throw e;
  }
  const lines = [
    ACTION_TEXT.address(res.url),
    res.user ? ACTION_TEXT.account(res.user) : ACTION_TEXT.accountUnknown,
    res.roles?.length ? ACTION_TEXT.roles(res.roles.join(", ")) : ACTION_TEXT.noRoles,
    typeof res.latency_ms === "number" ? ACTION_TEXT.latency(res.latency_ms) : "",
  ].filter(Boolean);
  if (res.ok) return okState(ACTION_TEXT.converterReady, { lines });
  if (res.missing_roles?.length)
    return failState(ACTION_TEXT.missingRoles(res.missing_roles.join(", ")), { lines: [...lines, ACTION_TEXT.rolesHint] });
  return failState(ACTION_TEXT.converterUnavailable, { lines: [...lines, res.error ?? ACTION_TEXT.noReason] });
}
