import { SETTINGS_SECTION_TEXT as m } from "../messages/settings-section";
import "server-only";
import { refresh } from "next/cache";
import { failState, okState, type ActionState } from "./action-state";
import { approvalPendingOf, approvalPendingState } from "./admin-form";
import { gw } from "./api";
import { GatewayError } from "./gateway";
import { fieldCategory, ldapFieldText, parseLdapField, problemsToFieldErrors, type LdapField } from "./ldap-form";
import { anchorText, SECRET_ANCHORS } from "./secret-anchors";
import { SETTINGS_VALUES_TEXT, fieldDecision, fieldOrig, sameValue, secretInput } from "./settings-values";
import type { SettingsResponse } from "./types";

export interface SettingsSection {
  category: "ldap" | "oidc" | "smtp";
  fields: LdapField[];
  input: (key: string) => string;
  clearSecret: string;
  endedKey?: "ldap_sessions_ended" | "oidc_sessions_ended";
  endedText?: string;
}

type Saved = { updated: number; missing_required?: string[] } & Partial<Record<NonNullable<SettingsSection["endedKey"]>, number>>;

export { SECRET_ANCHORS };

export function secretAnchorError(category: SettingsSection["category"], saved: (key: string) => { value: unknown; isSet: boolean } | undefined,
                                  changes: ReadonlyArray<{ category: string; key: string; value: unknown }>): Record<string, string> | null {
  const a = SECRET_ANCHORS[category];
  if (!a || !saved(a.secret)?.isSet) return null;
  const own = changes.filter((c) => c.category === category);
  if (own.some((c) => c.key === a.secret)) return null;
  return own.some((c) => a.anchors.includes(c.key) && anchorText(c.key, c.value) !== anchorText(c.key, saved(c.key)?.value)) ? { [a.secret]: a.message } : null;
}

export async function saveSettingsSection(spec: SettingsSection, formData: FormData): Promise<ActionState> {
  const labels: Record<string, string> = Object.fromEntries(spec.fields.map((f) => [f.key, f.label]));
  const changes: Array<{ category: string; key: string; value: unknown }> = [];
  const fieldErrors: Record<string, string> = {};
  let saved: Saved;
  try {
    const all = (await gw<SettingsResponse>("/api/v1/admin/settings")).items;
    if (!all.some((i) => i.category === spec.category)) return failState(m.unknownSection(spec.category));
    const current = new Map(all.map((i) => [`${i.category}.${i.key}`, i]));
    const shown = new Set(formData.getAll("fields").map(String));
    for (const f of spec.fields) {
      const category = fieldCategory(f), item = current.get(`${category}.${f.key}`);
      if (!item || !shown.has(f.key)) continue;
      const raw = formData.get(spec.input(f.key));
      if (f.kind === "secret") {
        if (formData.get(spec.clearSecret) === "on") { if (item.isSet) changes.push({ category, key: f.key, value: null }); }
        else { const typed = secretInput(raw); if (typed !== null) changes.push({ category, key: f.key, value: typed }); }
        continue;
      }
      const parsed = parseLdapField(f.kind, typeof raw === "string" ? raw : null);
      if (!parsed.ok) { fieldErrors[f.key] = parsed.error; continue; }
      const origRaw = formData.get(fieldOrig(spec.input(f.key)));
      const orig = typeof origRaw === "string" ? parseLdapField(f.kind, origRaw) : null;
      const asShown = parseLdapField(f.kind, ldapFieldText(f.kind, item.value));
      const decision = fieldDecision(parsed.value, orig?.ok ? orig : null, asShown.ok ? asShown.value : item.value, sameValue);
      if (decision === "conflict") fieldErrors[f.key] = SETTINGS_VALUES_TEXT.changedInOtherWindow;
      else if (decision === "send") changes.push({ category, key: f.key, value: parsed.value });
    }
    if (Object.keys(fieldErrors).length) {
      const stale = Object.entries(fieldErrors).filter(([, m]) => m === SETTINGS_VALUES_TEXT.changedInOtherWindow).map(([k]) => labels[k] ?? k);
      return stale.length
        ? failState(m.stale, { fieldErrors, lines: [m.staleFields(stale.join(", "))] })
        : failState(m.fixFields, { fieldErrors });
    }
    const anchor = secretAnchorError(spec.category, (key) => current.get(`${spec.category}.${key}`), changes);
    if (anchor) return failState(m.fixFields, { fieldErrors: anchor });
    if (!changes.length) return okState(m.noChanges);
    saved = await gw<Saved>("/api/v1/admin/settings", { method: "PUT", body: { items: changes } });
  } catch (e) {
    if (e instanceof GatewayError) {
      const errs = problemsToFieldErrors(e.details);
      return Object.keys(errs).length
        ? failState(m.notSavedFields, { fieldErrors: errs, lines: Object.entries(errs).map(([k, m]) => `${labels[k] ?? k}: ${m}`) })
        : failState(m.notSaved(e.message));
    }
    throw e;
  }
  const pending = approvalPendingOf(saved);
  if (pending) return approvalPendingState(pending);
  refresh();
  const lines = [m.changed(changes.map((c) => labels[c.key] ?? `${c.category}.${c.key}`).join(", "))];
  const ended = spec.endedKey ? saved[spec.endedKey] : 0;
  if (ended) lines.push(m.sessionsEnded(String(spec.endedText), ended));
  return okState(m.saved(changes.length), { lines });
}
