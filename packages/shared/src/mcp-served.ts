// Output schemas as tools/list serves them. The contract (contracts/mcp-tools.json) keeps strict output schemas:
// server tests validate every answer against them, so an unplanned field cannot leak unnoticed. A client, though, validates
// the answers of a newer server against the schemas it listed earlier — a strict schema turns every additive change (a new
// field, a new enum value) into a broken session until the agent restarts, and the schemas with their descriptions are most
// of the tools/list bytes. The setting access.mcp_output_schemas picks what tools/list serves:
//   open   — a derived view that accepts everything the strict schema accepts and the additive changes of later versions
//            (default of a new installation and the reading of an unknown value);
//   strict — the contract schemas as they are (an installation that existed before this setting keeps them);
//   none   — no outputSchema at all (structuredContent is still returned).
// No I/O here: settings.ts validates the value with MCP_OUTPUT_SCHEMA_MODES, the gateway applies servedOutputSchema in its
// tools/list handler only.

import { leanRequiredSchema, type LeanEntry } from "./mcp-detail.ts";

/** Values of the setting access.mcp_output_schemas. */
export const MCP_OUTPUT_SCHEMA_MODES = ["open", "strict", "none"] as const;
export type McpOutputSchemaMode = (typeof MCP_OUTPUT_SCHEMA_MODES)[number];
export const MCP_OUTPUT_SCHEMAS_SETTING = "access.mcp_output_schemas";
/** The mode for a setting value: a known mode as is, anything else (no row, empty, a typo, another type) — `open`. */
export const mcpOutputSchemaMode = (value: unknown): McpOutputSchemaMode =>
  (MCP_OUTPUT_SCHEMA_MODES as readonly unknown[]).includes(value) ? value as McpOutputSchemaMode : "open";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Schema = Record<string, unknown>;

// Keywords whose value is one subschema, a map of subschemas, a list of subschemas (JSON Schema 2020-12 and the older
// spellings): the open view walks into them. Every other keyword is data (required, enum values, bounds) and is copied.
const ONE = new Set(["additionalProperties", "unevaluatedProperties", "items", "unevaluatedItems", "contains", "propertyNames",
  "additionalItems"]);
const MAP = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const LIST = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
// Dropped in the open view: texts (they stay in the contract file) and the keywords whose subschema narrows by matching —
// a failed if/then of a newer server, or a `not` whose inner schema the view would widen (a wider `not` accepts less).
const DROP = new Set(["description", "$comment", "if", "then", "else", "not"]);
// `false` here closes an object or an array to what the schema names: the open view leaves them open.
const CLOSERS = new Set(["additionalProperties", "unevaluatedProperties", "unevaluatedItems", "additionalItems"]);

const plain = (v: unknown): v is Schema => v !== null && typeof v === "object" && !Array.isArray(v);
const jsonType = (v: unknown): string => v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? "object"
  : typeof v === "number" ? "number" : typeof v;

/**
 * The open view of a schema (a new object; the argument is not changed): no `additionalProperties: false` /
 * `unevaluatedProperties: false`, `oneOf` → `anyOf`, no `if` / `then` / `else` / `not`, `enum` and `const` widened to their
 * JSON type with the values kept as `examples`, a `false` subschema → `true`, no `description` / `$comment`. Every keyword it
 * keeps or changes only widens what is valid, so every document valid under the schema is valid under the view.
 */
export function openOutputSchema(schema: unknown): unknown {
  if (typeof schema === "boolean") return true;                     // a false subschema forbids a value: the view allows it
  if (!plain(schema)) return structuredClone(schema);
  const out: Schema = {};
  let known: Json[] | null = null, nested: Schema | null = null;
  for (const [k, v] of Object.entries(schema)) {
    if (DROP.has(k) || (CLOSERS.has(k) && v === false)) continue;
    if (k === "enum" && Array.isArray(v)) { known = [...(known ?? []), ...structuredClone(v as Json[])]; continue; }
    if (k === "const") { known = [...(known ?? []), structuredClone(v as Json)]; continue; }
    if (ONE.has(k)) out[k] = openOutputSchema(v);
    else if (MAP.has(k) && plain(v)) out[k] = Object.fromEntries(Object.entries(v).map(([n, s]) => [n, openOutputSchema(s)]));
    else if (LIST.has(k) && Array.isArray(v)) {
      const branches = v.map(openOutputSchema);
      if (k !== "oneOf") out[k] = branches;
      // exactly one branch → at least one; beside an anyOf of its own the branches go into allOf, so both still apply
      else if (Object.hasOwn(schema, "anyOf")) nested = { anyOf: branches };
      else out.anyOf = branches;
    } else out[k] = structuredClone(v);
  }
  if (nested) out.allOf = [...(Array.isArray(out.allOf) ? out.allOf : []), nested];
  if (known) {
    if (!Object.hasOwn(out, "type")) {
      const types = [...new Set(known.map(jsonType))];
      out.type = types.length === 1 ? types[0] : types;
    }
    const before = Array.isArray(out.examples) ? out.examples as Json[] : [];
    out.examples = [...before, ...known.filter((x) => !before.some((y) => JSON.stringify(y) === JSON.stringify(x)))];
  }
  return out;
}

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as object)) deepFreeze(x);
  }
  return v;
}

// one open view per contract schema object (mcpContract caches one contract per language, so per language and mode)
const openViews = new WeakMap<object, Schema>();
// one lean view per contract schema object and lean list (its lean fields out of `required`) — the list of a tool is
// the contract's own array, the same for every request of a language
const leanViews = new WeakMap<object, WeakMap<object, Schema>>();

/**
 * The output schema tools/list serves for a tool in a mode: `strict` — the contract schema itself (the same object, so the
 * listing stays byte for byte as before); `open` — its open view, built once and frozen; `none` — undefined (no outputSchema).
 * `lean` (access.mcp_response_detail = lean) — the fields a lean answer of the tool leaves out
 * (server.response_detail.lean): they are no longer in `required` of the served schema, in strict and open alike; an empty
 * list (no lean field, or the detail full) — the views above unchanged.
 */
export function servedOutputSchema(schema: Schema, mode: McpOutputSchemaMode, lean: readonly LeanEntry[] = []): Schema | undefined {
  if (mode === "none") return undefined;
  let base = schema;
  if (lean.length) {
    let byList = leanViews.get(schema);
    if (!byList) { byList = new WeakMap(); leanViews.set(schema, byList); }
    let l = byList.get(lean);
    if (!l) { l = deepFreeze(leanRequiredSchema(schema, lean)); byList.set(lean, l); }
    base = l;
  }
  if (mode === "strict") return base;
  let view = openViews.get(base);
  if (!view) { view = deepFreeze(openOutputSchema(base) as Schema); openViews.set(base, view); }
  return view;
}
