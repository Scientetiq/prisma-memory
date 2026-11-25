// Internal read shapes, not yet in the OpenAPI contract. No credentials enter form snapshots.
export const ROLES = ["chat", "embeddings", "rerank"] as const;
export type Role = typeof ROLES[number];
export type Policy = "none" | "open" | "closed";
export interface ModelRoleView {
  role: Role; state: "ready" | "off" | "misconfigured";
  slot?: "a" | "b"; legacy?: boolean;
  settings_keys?: Record<"provider" | "base_url" | "api_key" | "model" | "params", string>;
  connection: { provider: string; base_url: string; api_key: string | null; model: string; preset: string | null; legacy: boolean } | null;
  capabilities?: Record<string, unknown> | null;
  data_policy: { open: boolean; closed: boolean; reason: string }; suggested_policy: "open" | "closed";
}
export interface Preset { id: string; role: Role; provider: string; base_url: string | null; model_list: boolean }
export interface ProbeCheck { id: string; ok: boolean | null; code: string; latency_ms?: number }
export interface ModelResult {
  ok: boolean; message: string; code?: string; checks?: ProbeCheck[]; suggested_policy?: "open" | "closed";
  tested?: string; approval?: string; saved?: true;
}
export interface UsageRow {
  group_key: string; calls: string; input_tokens: string; cached_input_tokens: string; output_tokens: string;
  search_units: string; cost_micros: string; unpriced_calls: string; estimated_calls: string;
}
export interface UsageResponse {
  rows: UsageRow[];
  budget: { enforced: boolean; unenforced?: "table_missing" | "read_failed"; exhausted: "daily" | "monthly" | null;
    warning: "daily" | "monthly" | null; currency: string; daily: number | null; monthly: number | null;
    spent_day: number; spent_month: number; day: string; read_at: string | null } | null;
}

export function initialPolicy(r: ModelRoleView): Policy {
  return r.data_policy.closed ? "closed" : r.data_policy.open ? "open" : r.suggested_policy;
}

export function roleSnapshot(r: ModelRoleView): string {
  const c = r.connection;
  return JSON.stringify([r.role, r.state, r.slot ?? null, r.legacy ?? null, r.settings_keys ?? null,
    c ? [c.provider, c.base_url, c.model, c.preset, c.legacy, c.api_key !== null] : null, r.capabilities ?? null, r.data_policy]);
}

export function candidateId(preset: string, base: string, model: string): string {
  return JSON.stringify([preset, base.trim(), model.trim()]);
}

export function machineCode(code: unknown): string {
  return typeof code === "string" && /^[a-z][a-z0-9_]*(?::[a-z][a-z0-9_]*)?$/.test(code) && code.length <= 80 ? code : "not_available";
}
