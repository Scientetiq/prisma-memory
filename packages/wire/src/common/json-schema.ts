// Strict JSON and a subset of JSON Schema 2020-12, to check signed documents (the anchors) inside the process,
// without third-party packages: the leaf @memory/wire pulls no dependencies. The schemas come generated from
// contracts/ (anchors-schema.gen.ts); the generator stops on a keyword
// not supported here, so a schema with a new keyword does not pass silently.
//
// Supported: type, const, enum, required, properties, additionalProperties, propertyNames, items, minItems, maxItems,
// uniqueItems, minimum, maximum, minLength, maxLength, pattern, format (date-time, uri), $ref (#/$defs/…), oneOf, anyOf,
// allOf, if/then/else; schemas true/false. Annotations (description, examples, x-stage…) are cut by the generator.

export type JsonSchema = boolean | { readonly [keyword: string]: unknown };

/** Keywords that validateSchema understands. */
export const SCHEMA_KEYWORDS = [
  "type", "const", "enum", "required", "properties", "additionalProperties", "propertyNames", "items", "minItems", "maxItems",
  "uniqueItems", "minimum", "maximum", "minLength", "maxLength", "pattern", "format", "$ref", "$defs", "oneOf", "anyOf",
  "allOf", "if", "then", "else",
] as const;
/** Values of format that validateSchema understands. */
export const SCHEMA_FORMATS = ["date-time", "uri"] as const;

export interface SchemaProblem {
  /** path in the document as a JSON Pointer: /bridge/client_certs/0/calls/0 */
  path: string;
  /** the schema keyword that is not met */
  keyword: string;
}

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;
// RFC 3986 components: WHATWG URL parsing alone also normalizes invalid URI text.
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const URI_AUTHORITY = /^(?:(?:[A-Za-z0-9._~!$&'()*+,;=:-]|%[0-9A-Fa-f]{2})*@)?(?:(?:[A-Za-z0-9._~!$&'()*+,;=-]|%[0-9A-Fa-f]{2})*|\[[0-9A-Fa-f:.]+\])(?::[0-9]*)?$/;
const URI_PATH = /^(?:[A-Za-z0-9._~!$&'()*+,;=:@/-]|%[0-9A-Fa-f]{2})*$/;
const URI_QUERY = /^(?:[A-Za-z0-9._~!$&'()*+,;=:@/?-]|%[0-9A-Fa-f]{2})*$/;
const patterns = new Map<string, RegExp>();

function regex(p: string): RegExp {
  let r = patterns.get(p);
  if (!r) {
    r = new RegExp(p, "u");
    patterns.set(p, r);
  }
  return r;
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

// Root depth is 0; each property or array element adds one edge.
const MAX_JSON_DEPTH = 128;

function inputDepthProblem(value: unknown): SchemaProblem | undefined {
  const pending = [{ value, path: "", depth: 0 }];
  while (pending.length) {
    const current = pending.pop()!;
    if (current.depth > MAX_JSON_DEPTH) return { path: current.path, keyword: "maxDepth" };
    if (!Array.isArray(current.value) && !isObject(current.value)) continue;
    const node = current.value as Record<string, unknown>;
    const keys = Object.keys(node);
    // Reverse insertion preserves document order when popping the work stack.
    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i]!;
      pending.push({ value: node[key], path: `${current.path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
        depth: current.depth + 1 });
    }
  }
  return undefined;
}

/** Canonical form of a value (keys in order), for const, enum and uniqueItems. */
function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(",")}]`;
  if (isObject(x)) return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${canonical(x[k])}`).join(",")}}`;
  return JSON.stringify(x) ?? "undefined";
}

function typeOk(t: string, v: unknown): boolean {
  switch (t) {
    case "object":
      return isObject(v);
    case "array":
      return Array.isArray(v);
    case "string":
      return typeof v === "string";
    case "boolean":
      return typeof v === "boolean";
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "null":
      return v === null;
    default:
      return false;
  }
}

function formatOk(f: string, s: string): boolean {
  if (f === "date-time") {
    const m = DATE_TIME.exec(s);
    if (!m) return false;
    const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    // Date.parse normalizes impossible calendar dates and accepts 24:00:00.
    return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!
      && Number(m[4]) < 24 && Number(m[5]) < 60 && Number(m[6]) < 60
      && Number(m[7] ?? 0) < 24 && Number(m[8] ?? 0) < 60 && !Number.isNaN(Date.parse(s));
  }
  if (f === "uri") {
    const scheme = URI_SCHEME.exec(s);
    if (!scheme || /[^\x21-\x7e]/.test(s)) return false;
    // Split delimiters before checking components: overlapping regex repetitions
    // can backtrack quadratically on a long authority with an invalid fragment.
    let rest = s.slice(scheme[0].length);
    if (rest.startsWith("//")) {
      const tail = rest.slice(2);
      const boundary = tail.search(/[/?#]/);
      const end = boundary < 0 ? tail.length : boundary;
      if (!URI_AUTHORITY.test(tail.slice(0, end))) return false;
      rest = tail.slice(end);
    }
    const hash = rest.indexOf("#");
    const fragment = hash < 0 ? "" : rest.slice(hash + 1);
    if (hash >= 0) rest = rest.slice(0, hash);
    const question = rest.indexOf("?");
    const path = question < 0 ? rest : rest.slice(0, question);
    const query = question < 0 ? "" : rest.slice(question + 1);
    return URI_PATH.test(path) && URI_QUERY.test(query) && URI_QUERY.test(fragment) && URL.canParse(s);
  }
  return false;
}

/**
 * Checks a value against a schema. Returns at most max violations (an empty list means the value is valid).
 * root is the schema root: references #/$defs/<name> resolve against it.
 */
export function validateSchema(root: JsonSchema, value: unknown, max = 20): SchemaProblem[] {
  // Check the whole input before recursive validation or canonical comparisons,
  // including values under unconstrained schemas and unvisited alternatives.
  const depthProblem = inputDepthProblem(value);
  if (depthProblem) return [depthProblem];
  const out: SchemaProblem[] = [];
  // At least one diagnostic must survive: callers use an empty list as acceptance.
  const limit = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : 20;
  const defs = (typeof root === "object" && isObject(root.$defs) ? root.$defs : {}) as Record<string, JsonSchema>;

  function check(schema: JsonSchema, v: unknown, path: string, sink: SchemaProblem[]): boolean {
    if (schema === true) return true;
    let ok = true;
    const fail = (keyword: string, at = path) => {
      ok = false;
      if (sink.length < limit) sink.push({ path: at, keyword });
    };
    if (schema === false) {
      fail("false");
      return false;
    }
    const s = schema as Record<string, unknown>;

    if (typeof s.$ref === "string") {
      const m = /^#\/\$defs\/([A-Za-z0-9_-]+)$/.exec(s.$ref);
      const target = m && own(defs, m[1]!) ? defs[m[1]!] : undefined;
      if (target === undefined) fail("$ref");
      else if (!check(target, v, path, sink)) ok = false;
    }
    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
      if (!types.some((t) => typeOk(t, v))) fail("type");
    }
    if (own(s, "const") && canonical(v) !== canonical(s.const)) fail("const");
    if (Array.isArray(s.enum) && !s.enum.some((e) => canonical(e) === canonical(v))) fail("enum");

    if (typeof v === "string") {
      if (typeof s.minLength === "number" && [...v].length < s.minLength) fail("minLength");
      if (typeof s.maxLength === "number" && [...v].length > s.maxLength) fail("maxLength");
      if (typeof s.pattern === "string" && !regex(s.pattern).test(v)) fail("pattern");
      if (typeof s.format === "string" && !formatOk(s.format, v)) fail("format");
    }
    if (typeof v === "number") {
      if (typeof s.minimum === "number" && v < s.minimum) fail("minimum");
      if (typeof s.maximum === "number" && v > s.maximum) fail("maximum");
    }
    if (Array.isArray(v)) {
      if (typeof s.minItems === "number" && v.length < s.minItems) fail("minItems");
      if (typeof s.maxItems === "number" && v.length > s.maxItems) fail("maxItems");
      if (s.uniqueItems === true && new Set(v.map(canonical)).size !== v.length) fail("uniqueItems");
      if (s.items !== undefined) v.forEach((item, i) => check(s.items as JsonSchema, item, `${path}/${i}`, sink) || (ok = false));
    }
    if (isObject(v)) {
      const props = (isObject(s.properties) ? s.properties : {}) as Record<string, JsonSchema>;
      if (Array.isArray(s.required)) for (const k of s.required as string[]) if (!own(v, k)) fail("required", `${path}/${k}`);
      for (const k of Object.keys(v)) {
        const at = `${path}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`;
        if (s.propertyNames !== undefined && !check(s.propertyNames as JsonSchema, k, at, sink)) ok = false;
        if (own(props, k)) {
          if (!check(props[k]!, v[k], at, sink)) ok = false;
        } else if (s.additionalProperties === false) fail("additionalProperties", at);
        else if (s.additionalProperties !== undefined && !check(s.additionalProperties as JsonSchema, v[k], at, sink)) ok = false;
      }
    }

    if (Array.isArray(s.allOf)) for (const sub of s.allOf as JsonSchema[]) if (!check(sub, v, path, sink)) ok = false;
    if (Array.isArray(s.anyOf) && !(s.anyOf as JsonSchema[]).some((sub) => check(sub, v, path, []))) fail("anyOf");
    if (Array.isArray(s.oneOf) && (s.oneOf as JsonSchema[]).filter((sub) => check(sub, v, path, [])).length !== 1) fail("oneOf");
    if (s.if !== undefined) {
      const branch = check(s.if as JsonSchema, v, path, []) ? s.then : s.else;
      if (branch !== undefined && !check(branch as JsonSchema, v, path, sink)) ok = false;
    }
    return ok;
  }

  check(root, value, "", out);
  return out;
}

/**
 * The first repeated key in an object at any depth (JSON.parse silently takes the last value: the signer could see
 * one value and another would take effect). The text must already parse with JSON.parse. null means no repeats.
 * Keys are compared after escapes are expanded: "a" and "a" are one key.
 */
export function findDuplicateKey(text: string): string | null {
  const stack: ({ keys: Set<string>; expectKey: boolean } | null)[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top && top.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.keys.has(key)) return key;
        top.keys.add(key);
        top.expectKey = false;
      }
      i = j;
    } else if (c === "{") stack.push({ keys: new Set(), expectKey: true });
    else if (c === "[") stack.push(null);
    else if (c === "}" || c === "]") stack.pop();
    else if (c === ",") {
      const top = stack[stack.length - 1];
      if (top) top.expectKey = true;
    }
  }
  return null;
}
