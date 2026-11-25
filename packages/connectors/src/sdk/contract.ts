// The schemas of the versioned contract `connectors` (contracts/connectors/schemas), compiled once by Ajv in strict mode —
// the same settings as the contract test of packages/shared, so the SDK and the receiver read the schemas alike.
// The contracts folder is found the way packages/shared finds it: MEMORY_CONTRACTS_DIR, else <repository>/contracts
// (the gateway and workers images copy contracts/ next to the packages).
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { Problem } from "./types.ts";

const addFormats = (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule;

export const CONNECTORS_SCHEMA_BASE = "https://memory.internal/connectors/schemas/";

export function connectorsContractDir(): string {
  const root = process.env.MEMORY_CONTRACTS_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../../contracts");
  return resolve(root, "connectors");
}

/** A strict Ajv instance. `strictRequired` is off: it refuses the standard "exactly one of" idiom (`oneOf` of
 * `required` branches whose properties the enclosing object defines). */
export function strictAjv(): Ajv2020 {
  const a = new Ajv2020({
    strictSchema: true, strictNumbers: true, strictTypes: true, strictTuples: true, strictRequired: false, allErrors: true,
  });
  addFormats(a);
  return a;
}

let contractAjv: Ajv2020 | null = null;

function loaded(): Ajv2020 {
  if (contractAjv) return contractAjv;
  const a = strictAjv();
  const dir = resolve(connectorsContractDir(), "schemas");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".schema.json")).sort()) {
    a.addSchema(JSON.parse(readFileSync(resolve(dir, f), "utf8")) as object);
  }
  contractAjv = a;
  return a;
}

/** The compiled contract schema `<name>.schema.json` (optionally `#/$defs/<Def>`). */
export function contractSchema(name: string, def?: string): ValidateFunction {
  const uri = `${CONNECTORS_SCHEMA_BASE}${name}.schema.json${def ? `#/$defs/${def}` : ""}`;
  const v = loaded().getSchema(uri);
  if (!v) throw new Error(`connectors contract: no schema ${uri}`);
  return v;
}

/** Ajv errors as problems: one per instance path and keyword, at most `max`, in the order Ajv reports them. */
export function ajvProblems(errors: ErrorObject[] | null | undefined, code: string, max = 5, prefix = ""): Problem[] {
  if (max <= 0) return [];
  const out: Problem[] = [];
  const seen = new Set<string>();
  for (const e of errors ?? []) {
    const path = `${prefix}${e.instancePath}`;
    const key = `${path} ${e.keyword}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ code: `${code}:${e.keyword.toLowerCase().replace(/[^a-z0-9_]/g, "") || "schema"}`, path, message: `${path || "(root)"} ${e.message ?? "is not valid"}` });
    if (out.length >= max) break;
  }
  return out;
}
