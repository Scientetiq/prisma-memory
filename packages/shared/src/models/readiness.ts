// Pure readiness diagnostics shared by calls, the dispatcher and health. Only setting names and stable codes escape.
import { PlatformError } from "../platform-error.ts";
import { connectionChatCapabilities, connectionRerankCapabilities, modelParamsProblems } from "./capabilities.ts";
import { addressProblems, connectionKeys, resolveConnection } from "./connection.ts";
import { chatAdapter } from "./chat/index.ts";
import { rerankAdapter } from "./rerank/index.ts";
import { CHAT_PRESETS, RERANK_PRESETS } from "./presets.ts";
import { EMBEDDING_PROVIDERS } from "./embeddings/profile.ts";
import { embeddingsParamsProblems } from "./embeddings/presets.ts";
import type { ConnectionSettings, ModelConnection, ModelRole } from "./types.ts";

export interface ModelConfigurationProblem { role: ModelRole; setting: string; code: string }
const issue = (c: ModelConnection, field: "params" | "provider" | "apiKey", code: string): ModelConfigurationProblem =>
  ({ role: c.role, setting: connectionKeys(c.role)[field], code });

/** Legacy profiles deliberately ignore new overrides. Keyless servers stay supported unless auth is explicitly required. */
export function connectionConfigurationProblems(c: ModelConnection): ModelConfigurationProblem[] {
  if (c.legacy) return [];
  const problems: ModelConfigurationProblem[] = [];
  if (c.role === "chat" ? !chatAdapter(c.provider) : c.role === "rerank" ? !rerankAdapter(c.provider) : !(EMBEDDING_PROVIDERS as readonly string[]).includes(c.provider))
    problems.push(issue(c, "provider", "adapter_missing"));
  try {
    if (c.role === "chat") connectionChatCapabilities(c);
    else if (c.role === "rerank") connectionRerankCapabilities(c);
    else {
      const { auth_scheme: _auth, headers: _headers, path: _path, ...profile } = c.params;
      if (embeddingsParamsProblems(profile).length || modelParamsProblems(c.role, c.provider, c.params).length)
        throw new PlatformError("not_configured", "invalid embedding capabilities");
    }
  } catch (e) {
    if (!(e instanceof PlatformError)) throw e;
    problems.push(issue(c, "params", "invalid_capabilities"));
  }
  // An explicit authentication scheme is a requirement. An omitted scheme preserves keyless reverse proxies and local
  // servers; a provider response (401) is diagnosed by the probe. Never infer a key from another origin.
  const cloudPresets = [...Object.values(CHAT_PRESETS), ...Object.values(RERANK_PRESETS)];
  const hosted = cloudPresets.some((p) =>
    p.baseUrl?.startsWith("https://") && new URL(p.baseUrl).hostname === c.endpoint.host);
  const required = c.params.auth_scheme !== undefined || c.role === "chat" && c.params.preset === "azure-openai";
  if (c.apiKey === null && c.params.auth_scheme !== "none" && (required || hosted))
    problems.push(issue(c, "apiKey", "api_key_missing"));
  return problems;
}

export function roleConfigurationProblems(settings: ConnectionSettings, role: ModelRole, opts?: { slot?: "b" }): ModelConfigurationProblem[] {
  const st = resolveConnection(settings, role, opts);
  if (st.state === "ready") return connectionConfigurationProblems(st.connection).map((p) =>
    opts?.slot === "b" ? { ...p, setting: p.setting.replace("embeddings_", "embeddings_b_") } : p);
  const keys = connectionKeys(role, opts?.slot);
  // Unconfigured installs and deliberately disabled roles are healthy no-AI mode. A configured legacy reranker without
  // a model retains its old meaning (disabled); an explicit own provider with an empty model is a broken connection.
  const ownProvider = role === "chat" ? settings.str("models.chat_provider") : role === "rerank" ? settings.str("models.rerank_provider")
    : opts?.slot === "b" ? settings.str("models.embeddings_b_provider") : settings.str("models.embeddings_provider");
  if (st.reason === "disabled" || !st.invalid.length && (st.missing.includes(keys.provider)
    || !ownProvider && st.missing.every((k) => k === keys.model) && role !== "chat")) return [];
  const codes = addressProblems(settings, role, opts);
  return [...st.invalid.map((setting) => ({ role, setting, code: codes[setting] ?? "invalid_value" })),
    ...st.missing.map((setting) => ({ role, setting, code: "missing" }))];
}

export const modelConfigurationText = (problems: readonly ModelConfigurationProblem[]): string =>
  problems.map((p) => `${p.setting} (${p.code})`).join(", ");
