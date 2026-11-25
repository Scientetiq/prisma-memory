// Save-time checks of the ten embeddings connection keys. Settings.validate calls them
// for every write path; the frozen slot of the current model (registry.ts, embeddingsSlotChangeProblem) is checked by
// the settings save of the gateway, which knows the registry.
import { baseUrlProblem } from "../address.ts";
import { modelParamsProblems } from "../capabilities.ts";
import { embeddingsParamsProblems, profileParams } from "./presets.ts";
import { EMBEDDING_PROVIDERS, modelNameProblems } from "./profile.ts";

/** `models.embeddings_<field>` or `models.embeddings_b_<field>` → the field; anything else → null. */
export function embeddingsConnectionField(path: string): string | null {
  const m = /^models\.embeddings_(?:b_)?(provider|base_url|api_key|model|params)$/.exec(path);
  return m ? m[1]! : null;
}

/** Longest base address accepted. */
export const BASE_URL_MAX = 2048;

/** Problems of one value (English; never echoes the value). Empty — fine. The key itself is checked as a secret. */
export function embeddingsConnectionProblems(path: string, value: unknown): string[] {
  const field = embeddingsConnectionField(path);
  if (!field || value === null) return [];
  switch (field) {
    case "provider":
      return typeof value === "string" && (value === "" || value === "none" || (EMBEDDING_PROVIDERS as readonly string[]).includes(value)) ? []
        : [`one of ${EMBEDDING_PROVIDERS.join(", ")}; none — switched off; empty — not chosen`];
    case "base_url":
      if (typeof value !== "string") return ["an address of the form http(s)://host[:port][/path]"];
      if (value === "") return [];
      if (value !== value.trim() || value.length > BASE_URL_MAX) return [`an address without spaces, at most ${BASE_URL_MAX} characters`];
      // the address rules, the same the connection resolves by: a stored address that does not parse would never connect
      return baseUrlProblem(value) === null ? [] : ["an address of the form http(s)://host[:port][/path], without a user name, password, query or fragment"];
    case "model":
      if (typeof value !== "string") return ["a model name"];
      return value === "" ? [] : modelNameProblems(value);
    case "params":
      return typeof value === "object" && !Array.isArray(value)
        ? [...embeddingsParamsProblems(profileParams(value)), ...modelParamsProblems("embeddings", "", value)]
        : embeddingsParamsProblems(value);
    default:
      return [];
  }
}
