import { secretsMode, type SecretsMode } from "@memory/shared";
import type { App } from "./context.ts";

export interface SecretsSourceCheck { ok: true; level: "ok" | "info"; detail: string; legacy: string[] }

export function secretsSourceCheck(app: Pick<App, "secretsLegacy">, mode: SecretsMode = secretsMode()): SecretsSourceCheck {
  const legacy = [...(app.secretsLegacy ?? [])].sort();
  if (!app.secretsLegacy) return { ok: true, level: "info", detail: "secrets source not checked", legacy };
  if (mode === "files") return {
    ok: true, level: legacy.length ? "info" : "ok", legacy,
    detail: legacy.length ? `secrets mode files; not from own files yet: ${legacy.join(", ")}` : "secrets mode files: every key comes from its own file",
  };
  return {
    ok: true, level: legacy.length ? "info" : "ok", legacy,
    detail: legacy.length ? `legacy derivation (from the application secret or a setting): ${legacy.join(", ")}` : "every key comes from its own file",
  };
}
