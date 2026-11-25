"use server";

import { refresh } from "next/cache";
import { gw } from "@/lib/api";
import { GatewayError } from "@/lib/gateway";
import { denyAuditor } from "@/lib/admin-guard";
import { approvalPendingOf } from "@/lib/admin-form";
import type { SettingsResponse } from "@/lib/types";
import { models as t } from "@/messages/m-models";
import { ROLES, candidateId, machineCode, roleSnapshot, type ModelRoleView, type ModelResult, type Policy, type Preset, type Role } from "./view";

const text = (f: FormData, key: string): string => typeof f.get(key) === "string" ? f.get(key) as string : "";
const secret = (raw: string): string | null => !raw.trim() || /^(?:\*+|•+)$/.test(raw.trim()) ? null : raw;
type Pair = { base_url: string; model: string };
// Editor syntax and spelling only. Destination admission, DNS and transport security stay in the gateway/shared code.
// Importing the shared server graph into Next would also couple its compiler and runtime to the worker package.
function editorAddress(raw: string): { baseUrl: string; origin: string } | null {
  try {
    if (raw.length > 2048 || /[\s\\?#]/.test(raw) || !/^https?:\/\//i.test(raw) || raw.split("/", 3)[2]?.includes("@")) return null;
    const url = new URL(raw);
    if (url.username || url.password || !url.hostname || url.port === "0") return null;
    url.hostname = url.hostname.replace(/\.$/, "");
    return { origin: url.origin, baseUrl: url.origin + url.pathname.replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase()).replace(/\/+$/, "") };
  } catch { return null; }
}
const canonical = (base: string): string | null => editorAddress(base)?.baseUrl ?? null;
const exact = (a: Pair, b: Pair): boolean => canonical(a.base_url) === b.base_url && a.model === b.model;
const wildcard = (a: Pair, b: Pair): boolean => canonical(a.base_url) === b.base_url && a.model === "*";

/** The browser never supplies write targets. The active slot comes from a fresh read, including off states. */
function keysOf(r: ModelRoleView): ModelRoleView["settings_keys"] | null {
  if (r.role === "embeddings" && r.slot !== "a" && r.slot !== "b") return null;
  const prefix = r.role === "embeddings" && r.slot === "b" ? "embeddings_b" : r.role;
  const keys = Object.fromEntries(["provider", "base_url", "api_key", "model", "params"].map((k) => [k, `models.${prefix}_${k}`])) as NonNullable<ModelRoleView["settings_keys"]>;
  if (r.role === "embeddings" && Object.entries(keys).some(([k, v]) => r.settings_keys?.[k as keyof typeof keys] !== v)) return null;
  return keys;
}

export async function modelAction(_previous: ModelResult | null, form: FormData): Promise<ModelResult> {
  if (await denyAuditor()) return { ok: false, message: t.denied };
  const op = text(form, "op"), role = text(form, "role") as Role, policy = text(form, "policy") as Policy;
  const presetId = text(form, "preset"), base = text(form, "base_url").trim(), model = text(form, "model").trim();
  const key = secret(text(form, "api_key"));
  const invalid = (): ModelResult => ({ ok: false, message: t.invalid });
  if (!ROLES.includes(role) || !["test", "save"].includes(op) || !["none", "open", "closed"].includes(policy)
    || !base || !model || model === "*" || model.length > 2048 || key !== null && key.length > 16384) return invalid();
  const parsed = editorAddress(base);
  if (!parsed) return invalid();
  try {
    const [all, catalog] = await Promise.all([
      gw<{ roles: ModelRoleView[] }>("/api/v1/admin/models"), gw<{ presets: Preset[] }>("/api/v1/admin/models/presets"),
    ]);
    const current = all.roles.find((r) => r.role === role);
    if (!current || roleSnapshot(current) !== text(form, "original")) return { ok: false, message: t.stale };
    const preset = presetId ? catalog.presets.find((p) => p.id === presetId && p.role === role) : null;
    if (presetId && !preset || !preset && !current.connection) return invalid();
    const provider = preset?.provider ?? current.connection!.provider;
    // No advanced settings are rebuilt when the preset is kept. Switching templates deliberately resets overrides.
    const changedPreset = preset && (preset.id !== current.connection?.preset || current.connection?.legacy);
    const params = changedPreset ? role === "embeddings" ? {} : { preset: preset.id } : undefined;
    if (op === "test") {
      const result = await gw<{ ok: boolean; checks: Array<{ id: string; ok: boolean | null; code: string; latency_ms?: number }>; suggested_policy?: "open" | "closed" }>(
        "/api/v1/admin/models/test", { method: "POST", timeoutMs: 20_000, body: {
          role, ...(parsed.baseUrl !== current.connection?.base_url ? { base_url: parsed.baseUrl } : {}),
          ...(model !== current.connection?.model ? { model } : {}),
          ...(preset && provider !== current.connection?.provider ? { provider } : {}),
          ...(key !== null ? { api_key: key } : {}), ...(params ? { params } : {}),
        } });
      // Whitelist outcome codes and timings. Never pass through provider bodies, detail or a credential.
      return { ok: result.ok, message: result.ok ? t.testOk : t.testFailed,
        checks: result.checks.map((c) => ({ id: machineCode(c.id), ok: c.ok, code: machineCode(c.code),
          ...(typeof c.latency_ms === "number" && Number.isFinite(c.latency_ms) ? { latency_ms: c.latency_ms } : {}) })),
        ...(result.suggested_policy === "open" || result.suggested_policy === "closed" ? { suggested_policy: result.suggested_policy } : {}),
        tested: candidateId(presetId, base, model) };
    }
    if (policy === "closed" && text(form, "confirm_closed") !== "on") return { ok: false, message: t.confirmRequired };
    const keys = keysOf(current);
    if (!keys) return { ok: false, message: t.stale };
    const settings = await gw<SettingsResponse>("/api/v1/admin/settings");
    const setting = (path: string) => settings.items.find((i) => `${i.category}.${i.key}` === path);
    const oldBase = current.connection?.base_url ?? setting(keys.base_url)?.value;
    const before = typeof oldBase === "string" ? editorAddress(oldBase) : null;
    // An own key survives an address edit in the resolver. Refuse that edit until a replacement is explicit.
    if (key === null && setting(keys.api_key)?.isSet && (!before || before.origin !== parsed.origin))
      return { ok: false, message: t.newKey };
    const pair = { base_url: parsed.baseUrl, model };
    const lists = ["open", "closed"].map((kind) => setting(`models.allow_${kind}`)?.value);
    if (lists.some((v) => !Array.isArray(v))) return { ok: false, message: t.stale };
    const [open, closed] = lists as [Pair[], Pair[]];
    if (policy !== "closed" && closed.some((p) => wildcard(p, pair)) || policy === "none" && open.some((p) => wildcard(p, pair)))
      return { ok: false, message: t.wildcard };
    const changes: Array<{ category: string; key: string; value: unknown }> = [];
    const set = (path: string, value: unknown) => {
      const original = setting(path); if (!original) throw new GatewayError(409, "settings_changed", "");
      if (!original.secret && JSON.stringify(original.value) === JSON.stringify(value)) return;
      changes.push({ category: original.category, key: original.key, value });
    };
    if (preset) set(keys.provider, provider);
    set(keys.base_url, parsed.baseUrl); set(keys.model, model);
    if (params) set(keys.params, params);
    if (key !== null) set(keys.api_key, key);
    for (const [kind, list] of [["open", open], ["closed", closed]] as const) {
      const updated = list.filter((p) => !exact(p, pair));
      if (policy === kind) updated.push(pair);
      // Avoid rewriting an unchanged list just because the selected pair moved within it.
      const same = list.length === updated.length && list.every((p) => updated.some((q) => JSON.stringify(q) === JSON.stringify(p)));
      if (!same) set(`models.allow_${kind}`, updated);
    }
    // Detect a live-slot switch while settings were loading; no local registry or guessed slot in this page.
    const latest = await gw<{ roles: ModelRoleView[] }>("/api/v1/admin/models");
    const live = latest.roles.find((r) => r.role === role);
    if (!live || roleSnapshot(live) !== roleSnapshot(current)) return { ok: false, message: t.stale };
    if (!changes.length) return { ok: true, message: t.noChanges, saved: true };
    const saved = await gw<unknown>("/api/v1/admin/settings", { method: "PUT", body: { items: changes } });
    const pending = approvalPendingOf(saved);
    refresh();
    return pending ? { ok: true, message: t.approvalPending, approval: `/admin/approvals?id=${encodeURIComponent(pending.id)}` }
      : { ok: true, message: t.saved, saved: true };
  } catch (e) {
    if (e instanceof GatewayError) return { ok: false, message: t.requestFailed, code: machineCode(e.code) };
    throw e;
  }
}
