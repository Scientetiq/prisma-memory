// The manifest is data: property names and descriptions are never interpreted as markup or executable expressions.
import type { Schema } from "./connectors";

export interface ConfigField {
  name: string; label: string; description: string; type: string; required: boolean; value: string;
  options?: string[]; minimum?: number; maximum?: number; minLength?: number; maxLength?: number; pattern?: string;
}
const object = (v: unknown): v is Schema => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): string => typeof v === "string" ? v : "";
const asText = (v: unknown): string => v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);

export function configFields(schema: Schema, config: Record<string, unknown> = {}): ConfigField[] {
  if (!object(schema.properties)) return [];
  const required = Array.isArray(schema.required) ? schema.required : [];
  return Object.entries(schema.properties).map(([name, raw]) => {
    const s = object(raw) ? raw : {};
    return {
      name, label: text(s.title) || name, description: text(s.description), type: text(s.type) || "string",
      required: required.includes(name), value: asText(Object.hasOwn(config, name) ? config[name] : s.default),
      ...(Array.isArray(s.enum) ? { options: s.enum.map(String) } : {}),
      ...Object.fromEntries(["minimum", "maximum", "minLength", "maxLength"].filter((k) => typeof s[k] === "number").map((k) => [k, s[k]])),
      ...(typeof s.pattern === "string" ? { pattern: s.pattern } : {}),
    };
  });
}

// Lightweight feedback only; the API validates the complete manifest schema again on every mutation.
function valid(s: Schema, v: unknown, depth = 0): boolean {
  if (depth > 20) return false;
  if (Array.isArray(s.enum) && !s.enum.includes(v)) return false;
  if (s.type === "string") {
    if (typeof v !== "string" || /\u0000/.test(v)) return false;
    if (typeof s.minLength === "number" && [...v].length < s.minLength || typeof s.maxLength === "number" && [...v].length > s.maxLength) return false;
    if (typeof s.pattern === "string") { try { if (!new RegExp(s.pattern, "u").test(v)) return false; } catch { return false; } }
  } else if (s.type === "number" || s.type === "integer") {
    if (typeof v !== "number" || !Number.isFinite(v) || s.type === "integer" && !Number.isSafeInteger(v)) return false;
    if (typeof s.minimum === "number" && v < s.minimum || typeof s.maximum === "number" && v > s.maximum) return false;
  } else if (s.type === "boolean" && typeof v !== "boolean") return false;
  else if (s.type === "array") {
    if (!Array.isArray(v)) return false;
    if (typeof s.minItems === "number" && v.length < s.minItems || typeof s.maxItems === "number" && v.length > s.maxItems) return false;
    if (object(s.items) && !v.every((x) => valid(s.items as Schema, x, depth + 1))) return false;
  } else if (s.type === "object") {
    if (!object(v)) return false;
    const props = object(s.properties) ? s.properties : {};
    if (Array.isArray(s.required) && s.required.some((k) => typeof k === "string" && !Object.hasOwn(v, k))) return false;
    for (const [k, x] of Object.entries(v)) {
      if (Object.hasOwn(props, k) && object(props[k])) { if (!valid(props[k] as Schema, x, depth + 1)) return false; }
      else if (s.additionalProperties === false) return false;
    }
  }
  return true;
}

export function parseConnectorConfig(schema: Schema, form: FormData):
  { ok: true; config: Record<string, unknown> } | { ok: false; fields: string[] } {
  const config: Record<string, unknown> = Object.create(null);
  const fields: string[] = [];
  const props = object(schema.properties) ? schema.properties : {};
  for (const f of configFields(schema)) {
    const input = form.get(`config.${f.name}`);
    if (input !== null && typeof input !== "string") { fields.push(f.name); continue; }
    const raw = input ?? f.value;
    if (raw === "" && !f.required) continue;
    if (raw === "" && f.required) { fields.push(f.name); continue; }
    let v: unknown = raw;
    try {
      if (f.type === "integer" || f.type === "number") v = raw.trim() === "" ? NaN : Number(raw);
      else if (f.type === "boolean") v = raw === "true" ? true : raw === "false" ? false : undefined;
      else if (f.type === "array" || f.type === "object") v = JSON.parse(raw);
      if (raw.length > 65_536 || !valid(props[f.name] as Schema, v)) fields.push(f.name);
      else config[f.name] = v;
    } catch { fields.push(f.name); }
  }
  return fields.length ? { ok: false, fields } : { ok: true, config };
}
