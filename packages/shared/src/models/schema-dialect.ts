// Schema dialects: one contract schema of a pipeline stage (contracts/pipeline/schemas/*.json), several wire
// schemas — one per family of structured-output engines. A dialect only changes what is SENT to the model; the answer
// is always checked by Ajv against the FULL contract schema, and nothing in an answer is ever trimmed (quotes and
// statements are evidence): a violated limit goes to the repair loop or fails with `schema_error`.
//
//   passthrough    today's wire byte for byte: `wireSchema` with the configured keyword list
//                  (`models.schema_unsupported_keywords`) — the legacy gateway profile;
//   openai_strict  OpenAI `strict: true`: every property required, formerly optional ones nullable, every object
//                  closed; drops `$schema`, `$id`, `$comment`, `uniqueItems`, `minLength`, `maxLength`, `default`,
//                  `examples` and formats outside the vendor's list; `restore` deletes the nulls of optional properties;
//   anthropic      Anthropic `output_config.format`: drops `minLength`, `maxLength`, numeric limits, `maxItems`,
//                  `minItems` > 1, `uniqueItems`, patterns outside the documented regex subset, `$schema`, `$id`,
//                  `$comment`, `examples`; asserts `additionalProperties: false` on every object (a contract schema
//                  without it is a compile error, not something patched silently), no recursion (direct or through
//                  `$defs`), ≤ 24 optional properties, ≤ 16 properties with union types (`anyOf` or a type array);
//   gemini         drops `$schema`, `$id`, `$comment`, `pattern`, `uniqueItems`; keeps the rest (the API strips what it
//                  does not enforce);
//   minimal        types, `properties`, `required`, `enum`, `items`, `description` and a closed `additionalProperties`
//                  only — for servers with weak grammars and for schemas given as text in the prompt; a contract with
//                  `$ref`, `anyOf`, `oneOf`, `allOf`, a tuple, `not`, `if`/`then`/`else`, `contains`, `patternProperties`,
//                  `propertyNames`, `dependentSchemas`, `dependentRequired` or `unevaluated…` is a compile error (it cannot
//                  be said in this dialect, and dropping it would change what the wire allows without a word).
//
// Every limit a non-passthrough dialect drops is kept as words in the node's `description` ("Constraints: at most 400
// characters."), so the model still sees it. Vocabularies (`describe`'s domain list) are enums of the wire only
// (`wireEnums`): a tag outside the vocabulary does not fail the stage, code drops it.
//
// Vendor facts checked against the vendors' structured-output guides (OpenAI "Supported schemas",
// Anthropic "Structured outputs", Google AI Studio "Structured output"); unverified details need live checks.


export type SchemaDialect = "passthrough" | "openai_strict" | "anthropic" | "gemini" | "minimal";
export const SCHEMA_DIALECTS: readonly SchemaDialect[] = Object.freeze(["passthrough", "openai_strict", "anthropic", "gemini", "minimal"]);
export const isSchemaDialect = (x: unknown): x is SchemaDialect => typeof x === "string" && (SCHEMA_DIALECTS as readonly string[]).includes(x);

export interface CompileOptions {
  /** `passthrough` only: keywords stripped everywhere (`models.schema_unsupported_keywords`; default — its seed value). */
  unsupportedKeywords?: Iterable<string>;
  /**
   * Closed vocabularies of the wire only: JSON Pointer (RFC 6901) into the contract schema → allowed strings. The node
   * becomes `{type: "string", enum}` in the wire; the contract the answer is checked against keeps its own node. An
   * empty list leaves the node as it is (no vocabulary configured).
   */
  wireEnums?: Readonly<Record<string, readonly string[]>>;
}

export interface CompiledSchema {
  dialect: SchemaDialect;
  /** What goes to the model. */
  wire: Record<string, unknown>;
  /** Keywords the dialect removed (sorted, unique) — for the call log, never for validation. */
  dropped: readonly string[];
  /** The answer of the model in the contract's shape (before `dedupeUnique` and Ajv). Never trims or rewrites values. */
  restore(answer: unknown): unknown;
}

/** The contract schema cannot be expressed in the dialect: a configuration error, raised before any request. */
export class SchemaDialectError extends Error {
  constructor(readonly dialect: string, readonly path: string, detail: string) {
    super(`schema dialect ${dialect}: ${path}: ${detail}`);
    this.name = "SchemaDialectError";
  }
}

type Rec = Record<string, unknown>;
const isRec = (x: unknown): x is Rec => Boolean(x) && typeof x === "object" && !Array.isArray(x);
/** An own data property, whatever the key: `o["__proto__"] = v` would replace the prototype instead. */
const put = (o: Rec, k: string, v: unknown): void => { Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true }); };

// Keywords whose value is a map "name → schema": the keys are names, not keywords.
const NAMED_SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
// Keywords whose value is data: never walked into.
const DATA_KEYWORDS = new Set(["enum", "const", "default", "examples"]);
const SUBSCHEMA = new Set(["items", "additionalProperties", "contains", "not", "if", "then", "else", "propertyNames", "unevaluatedItems", "unevaluatedProperties"]);
const SUBSCHEMA_LISTS = new Set(["prefixItems", "anyOf", "oneOf", "allOf"]);
const PRIMITIVE_TYPES = new Set(["string", "number", "integer", "boolean"]);

const OPENAI_FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "ipv4", "ipv6", "uuid"]);
const ANTHROPIC_FORMATS = new Set([...OPENAI_FORMATS, "uri"]);
const OPENAI_UNSUPPORTED = ["allOf", "not", "if", "then", "else", "dependentRequired", "dependentSchemas"];
const OPENAI_MAX_ENUM_VALUES = 1000;
const ANTHROPIC_MAX_OPTIONAL = 24;
const ANTHROPIC_MAX_UNION_PARAMS = 16;
const MINIMAL_KEEP = new Set(["type", "properties", "required", "enum", "items", "description", "additionalProperties"]);
const MINIMAL_REFUSED = ["$ref", "anyOf", "oneOf", "allOf", "prefixItems", "not", "if", "then", "else", "contains", "patternProperties", "propertyNames",
  "dependentSchemas", "dependentRequired", "unevaluatedItems", "unevaluatedProperties", "additionalItems"];
/** Work limit of one `restore` call (schema nodes visited): past it the answer is returned as the model sent it. */
const RESTORE_STEPS = 100_000;

/**
 * Anthropic's documented regex subset: no backreferences, no lookaround, no word boundaries, no large `{n,m}` ranges.
 * A pattern outside it is dropped from the wire (its meaning stays in the description); the check errs on the safe side.
 */
export function anthropicPatternSupported(pattern: string): boolean {
  if (/\\[1-9]/.test(pattern) || /\\k</.test(pattern)) return false;
  if (/\(\?(?:[=!]|<[=!])/.test(pattern)) return false;
  if (/\\[bB]/.test(pattern)) return false;
  for (const m of pattern.matchAll(/\{(\d+)(?:,(\d*))?\}/g)) if (Number(m[1]) > 100 || (m[2] && Number(m[2]) > 100)) return false;
  return true;
}

/** Should the dialect drop this keyword of this node? (`passthrough` never comes here.) */
function drops(dialect: Exclude<SchemaDialect, "passthrough">, keyword: string, value: unknown): boolean {
  switch (dialect) {
    case "openai_strict":
      if (["$schema", "$id", "$comment", "uniqueItems", "minLength", "maxLength", "default", "examples"].includes(keyword)) return true;
      return keyword === "format" && !OPENAI_FORMATS.has(String(value));
    case "anthropic":
      if (["$schema", "$id", "$comment", "examples", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
           "multipleOf", "maxItems", "uniqueItems"].includes(keyword)) return true;
      if (keyword === "minItems") return !(value === 0 || value === 1);
      if (keyword === "pattern") return typeof value !== "string" || !anthropicPatternSupported(value);
      return keyword === "format" && !ANTHROPIC_FORMATS.has(String(value));
    case "gemini":
      return ["$schema", "$id", "$comment", "pattern", "uniqueItems"].includes(keyword);
    case "minimal":
      if (keyword === "additionalProperties") return value !== false;
      if (keyword === "items") return !isRec(value);
      return !MINIMAL_KEEP.has(keyword);
  }
}

const plural = (n: unknown, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The dropped limits of one node as English words, in a fixed order. */
function hints(dropped: Rec): string[] {
  const out: string[] = [];
  const has = (k: string) => Object.hasOwn(dropped, k);
  if (has("minLength") && has("maxLength")) out.push(`between ${dropped.minLength} and ${plural(dropped.maxLength, "character", "characters")}`);
  else if (has("minLength")) out.push(`at least ${plural(dropped.minLength, "character", "characters")}`);
  else if (has("maxLength")) out.push(`at most ${plural(dropped.maxLength, "character", "characters")}`);
  if (has("minimum") && has("maximum")) out.push(`a value between ${dropped.minimum} and ${dropped.maximum}`);
  else if (has("minimum")) out.push(`a value of at least ${dropped.minimum}`);
  else if (has("maximum")) out.push(`a value of at most ${dropped.maximum}`);
  if (has("exclusiveMinimum")) out.push(`a value greater than ${dropped.exclusiveMinimum}`);
  if (has("exclusiveMaximum")) out.push(`a value less than ${dropped.exclusiveMaximum}`);
  if (has("multipleOf")) out.push(`a multiple of ${dropped.multipleOf}`);
  if (has("minItems") && has("maxItems")) out.push(`between ${dropped.minItems} and ${plural(dropped.maxItems, "item", "items")}`);
  else if (has("minItems")) out.push(`at least ${plural(dropped.minItems, "item", "items")}`);
  else if (has("maxItems")) out.push(`at most ${plural(dropped.maxItems, "item", "items")}`);
  if (dropped.uniqueItems === true) out.push("no repeated items");
  if (has("pattern")) out.push(`must match the regular expression ${dropped.pattern}`);
  if (has("format")) out.push(`in the ${dropped.format} format`);
  return out;
}

function withHints(description: unknown, words: string[]): string {
  const tail = `Constraints: ${words.join("; ")}.`;
  const base = typeof description === "string" ? description.trim() : "";
  if (!base) return tail;
  return `${base}${/[.!?…]$/.test(base) ? " " : ". "}${tail}`;
}

/**
 * RFC 6901 pointer → path segments. A URI fragment (`#/…`, the form of `$ref`) is percent-decoded first (RFC 6901 §6);
 * a plain string pointer (`/…`, the form of `wireEnums`) is not — a `%` in a property name is just a character there.
 * A malformed percent escape is no pointer (`null`), never a raw `URIError`.
 */
function pointerSegments(pointer: string): string[] | null {
  const fragment = pointer.startsWith("#");
  const p = fragment ? pointer.slice(1) : pointer;
  if (p === "") return [];
  if (!p.startsWith("/")) return null;
  try {
    return p.slice(1).split("/").map((s) => (fragment ? decodeURIComponent(s) : s).replace(/~1/g, "/").replace(/~0/g, "~"));
  } catch { return null; }
}

function resolveLocal(root: unknown, ref: string): unknown {
  const segs = ref.startsWith("#") ? pointerSegments(ref) : null;
  if (!segs) return undefined;
  let cur: unknown = root;
  for (const s of segs) {
    if (Array.isArray(cur)) cur = cur[Number(s)];
    else if (isRec(cur) && Object.hasOwn(cur, s)) cur = cur[s];
    else return undefined;
  }
  return cur;
}

/** Follows local `$ref`s (bounded); a schema that is not a local reference is returned as it is. */
function deref(schema: unknown, root: unknown): unknown {
  let cur = schema;
  for (let i = 0; i < 32 && isRec(cur) && typeof cur.$ref === "string"; i++) {
    const next = resolveLocal(root, cur.$ref);
    if (next === undefined) return cur;
    cur = next;
  }
  return cur;
}

/**
 * The first local `$ref` that leads back into itself, following references (with a set of references being walked) and
 * the structure of each target — mutual recursion through `$defs` included. `null` when there is none.
 */
function refCycle(root: Rec): string | null {
  const state = new Map<string, "open" | "done">([["#", "open"]]);
  const walk = (node: unknown): string | null => {
    if (Array.isArray(node)) {
      for (const x of node) { const hit = walk(x); if (hit) return hit; }
      return null;
    }
    if (!isRec(node)) return null;
    if (typeof node.$ref === "string" && node.$ref.startsWith("#")) {
      const ref = node.$ref === "#/" ? "#" : node.$ref;
      if (state.get(ref) === "open") return ref;
      if (!state.has(ref)) {
        state.set(ref, "open");
        const hit = walk(resolveLocal(root, ref));
        if (hit) return hit;
        state.set(ref, "done");
      }
    }
    for (const [k, v] of Object.entries(node)) {
      // data is not schema; `$defs` are walked too — the wire carries them whether used or not
      if (DATA_KEYWORDS.has(k)) continue;
      const hit = NAMED_SCHEMA_MAPS.has(k) && isRec(v) ? walk(Object.values(v)) : walk(v);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root);
}

/** Does the schema accept `null` as a value? (Unconstrained schemas do.) */
function acceptsNull(schema: unknown, root: unknown, depth = 0): boolean {
  if (schema === true) return true;
  if (depth > 32) return false;
  const s = deref(schema, root);
  if (!isRec(s)) return false;
  if (typeof s.$ref === "string") return false;   // an unresolvable reference: assume not
  let ok = true;
  if ("type" in s) ok &&= s.type === "null" || (Array.isArray(s.type) && s.type.includes("null"));
  if ("enum" in s) ok &&= Array.isArray(s.enum) && s.enum.includes(null);
  if ("const" in s) ok &&= s.const === null;
  if (Array.isArray(s.anyOf)) ok &&= s.anyOf.some((x) => acceptsNull(x, root, depth + 1));
  if (Array.isArray(s.oneOf)) ok &&= s.oneOf.some((x) => acceptsNull(x, root, depth + 1));
  if (Array.isArray(s.allOf)) ok &&= s.allOf.every((x) => acceptsNull(x, root, depth + 1));
  return ok;
}

/** An optional property of the strict dialect: the same schema, plus `null`. */
function nullable(sub: unknown): unknown {
  if (!isRec(sub)) return { anyOf: [sub, { type: "null" }] };
  const simple = !["enum", "const", "anyOf", "oneOf", "allOf", "$ref"].some((k) => k in sub);
  const t = sub.type;
  const types = typeof t === "string" ? [t] : Array.isArray(t) ? t : null;
  if (simple && types && types.length && types.every((x) => PRIMITIVE_TYPES.has(String(x))))
    return Object.fromEntries(Object.entries(sub).map(([k, v]) => [k, k === "type" ? [...types, "null"] : v]));
  return { anyOf: [sub, { type: "null" }] };
}

const isObjectNode = (n: Rec): boolean => n.type === "object" || (Array.isArray(n.type) && n.type.includes("object")) || isRec(n.properties);

interface Ctx { dialect: Exclude<SchemaDialect, "passthrough">; root: Rec; dropped: Set<string>; optional: number; unions: number; enumValues: number }

function transform(node: unknown, path: string, ctx: Ctx): unknown {
  if (!isRec(node)) return node;
  const { dialect } = ctx, strict = dialect === "openai_strict" || dialect === "anthropic";
  const fail = (detail: string): never => { throw new SchemaDialectError(dialect, path, detail); };

  if (strict) {
    if (typeof node.$ref === "string") {
      if (!node.$ref.startsWith("#") || resolveLocal(ctx.root, node.$ref) === undefined) fail(`only local $ref is supported (${node.$ref})`);
      if (dialect === "anthropic") {
        const target = node.$ref === "#" ? "#" : node.$ref;
        if (path === target || path.startsWith(`${target}/`)) fail("recursive schemas are not supported");
      }
    }
    if (isObjectNode(node) && node.additionalProperties !== false) fail("an object must have additionalProperties: false");
  }
  if (dialect === "openai_strict") for (const k of OPENAI_UNSUPPORTED) if (k in node) fail(`keyword ${k} is not supported`);
  if (dialect === "minimal") {
    // minimal has no keyword for a reference, a union, a tuple or a conditional: dropping one would leave `{}` (anything
    // goes) or a closed object that allows nothing, without a word — the contract cannot be expressed, so it fails before
    // any request
    for (const k of MINIMAL_REFUSED) if (k in node) fail(`keyword ${k} cannot be expressed in the minimal dialect`);
    if (Array.isArray(node.items)) fail("tuple-form items cannot be expressed in the minimal dialect");
  }
  if (dialect === "anthropic") {
    if (Array.isArray(node.enum) && node.enum.some((v) => v !== null && typeof v === "object")) fail("enum values must be strings, numbers, booleans or null");
    if (Array.isArray(node.allOf) && node.allOf.some((x) => isRec(x) && "$ref" in x)) fail("allOf with $ref is not supported");
  }

  const out: Rec = {}, removed: Rec = {};
  for (const [k, v] of Object.entries(node)) {
    if (drops(dialect, k, v)) { put(removed, k, v); ctx.dropped.add(k); continue; }
    if (k === "enum" && Array.isArray(v)) ctx.enumValues += v.length;
    if (DATA_KEYWORDS.has(k)) put(out, k, v);
    else if (NAMED_SCHEMA_MAPS.has(k) && isRec(v))
      put(out, k, Object.fromEntries(Object.entries(v).map(([name, sub]) => [name, transform(sub, `${path}/${k}/${name}`, ctx)])));
    // tuple-form `items` (an array of schemas, draft 2019 and older) is walked like `prefixItems`
    else if (SUBSCHEMA.has(k)) put(out, k, Array.isArray(v) ? v.map((sub, i) => transform(sub, `${path}/${k}/${i}`, ctx)) : transform(v, `${path}/${k}`, ctx));
    else if (SUBSCHEMA_LISTS.has(k) && Array.isArray(v)) put(out, k, v.map((sub, i) => transform(sub, `${path}/${k}/${i}`, ctx)));
    else put(out, k, v);
  }
  // minimal: a single allowed value is a one-value vocabulary
  if (dialect === "minimal" && Object.hasOwn(removed, "const") && !Object.hasOwn(out, "enum")) out.enum = [removed.const];

  if (isRec(node.properties)) {
    const props = node.properties, required = new Set(Array.isArray(node.required) ? node.required.map(String) : []);
    const optional = Object.keys(props).filter((name) => !required.has(name));
    if (dialect === "anthropic") {
      ctx.optional += optional.length;
      // "parameters with union types": a property whose schema is an anyOf or has a type array
      if (isRec(out.properties))
        ctx.unions += Object.values(out.properties).filter((p) => isRec(p) && (Array.isArray(p.anyOf) || Array.isArray(p.type))).length;
    }
    if (dialect === "openai_strict" && isRec(out.properties)) {
      const wireProps = out.properties;
      for (const name of optional) if (!acceptsNull(props[name], ctx.root)) put(wireProps, name, nullable(wireProps[name]));
      out.required = Object.keys(props);
    }
  }

  const words = hints(removed);
  if (words.length) out.description = withHints(out.description, words);
  return out;
}

/** The contract with the vocabularies of the wire in place (a copy; the input is never changed). */
function applyWireEnums(schema: Rec, wireEnums: CompileOptions["wireEnums"], dialect: string): Rec {
  const copy = structuredClone(schema);
  for (const [pointer, values] of Object.entries(wireEnums ?? {})) {
    const segs = pointer.startsWith("/") ? pointerSegments(pointer) : null;
    if (!segs || !segs.length) throw new SchemaDialectError(dialect, pointer, "wireEnums: a JSON Pointer such as /properties/<name>/items is expected");
    if (!Array.isArray(values) || values.some((v) => typeof v !== "string")) throw new SchemaDialectError(dialect, pointer, "wireEnums: a list of strings is expected");
    // Walk schema positions only: a name of a `properties`-like map, a subschema keyword, an index of a
    // subschema list (`anyOf/1`) or of tuple-form `items`. A pointer to a map itself (`/properties`) or into data
    // (`/enum/0`) is no schema. Own keys only: `parent.__proto__` would be the prototype, not a schema.
    type At = "schema" | "map" | "list" | "data";
    let parent: unknown = null, cur: unknown = copy, at = "schema" as At;
    for (const s of segs) {
      let next: unknown;
      if (Array.isArray(cur)) next = at === "list" && /^(?:0|[1-9]\d*)$/.test(s) ? cur[Number(s)] : undefined;
      else next = isRec(cur) && Object.hasOwn(cur, s) ? cur[s] : undefined;
      at = at === "map" || at === "list" ? "schema"
        : NAMED_SCHEMA_MAPS.has(s) ? "map"
        : SUBSCHEMA_LISTS.has(s) || (s === "items" && Array.isArray(next)) ? "list"
        : SUBSCHEMA.has(s) ? "schema" : "data";
      parent = cur; cur = next;
      if (next === undefined || at === "data") break;
    }
    const last = segs[segs.length - 1]!;
    if (at !== "schema" || !isRec(cur)) throw new SchemaDialectError(dialect, pointer, "wireEnums: no schema at this pointer");
    if (!values.length) continue;
    const node = { type: "string", enum: [...values] };
    if (Array.isArray(parent)) parent[Number(last)] = node;
    else put(parent as Rec, last, node);
  }
  return copy;
}

/** Keywords `wireSchema` would remove (it walks every non-data value). */
function strippedBy(schema: unknown, unsupported: ReadonlySet<string>, found: Set<string>): void {
  if (Array.isArray(schema)) { schema.forEach((x) => strippedBy(x, unsupported, found)); return; }
  if (!isRec(schema)) return;
  for (const [k, v] of Object.entries(schema)) {
    if (unsupported.has(k)) { found.add(k); continue; }
    if (NAMED_SCHEMA_MAPS.has(k) && isRec(v)) Object.values(v).forEach((sub) => strippedBy(sub, unsupported, found));
    else if (!DATA_KEYWORDS.has(k)) strippedBy(v, unsupported, found);
  }
}

/** The branches of `anyOf` / `oneOf` of a schema node, local references followed and nested unions flattened. */
function unionBranches(s: Rec, root: Rec, depth: number): Rec[] {
  const out: Rec[] = [];
  for (const k of ["anyOf", "oneOf"]) {
    const list = s[k];
    if (!Array.isArray(list)) continue;
    for (const b of list) {
      const d = deref(b, root);
      if (!isRec(d)) continue;
      if (!isRec(d.properties) && (Array.isArray(d.anyOf) || Array.isArray(d.oneOf)) && depth < 64) out.push(...unionBranches(d, root, depth + 1));
      else out.push(d);
    }
  }
  return out;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Could this value be an instance of this branch, as far as `restore` cares? Keys for objects (`items` for arrays), and
 * a property the branch fixes by `const` or `enum` — a discriminator — must hold the answer's value there. The
 * strict wire's `null` of an optional property says "absent" and fits any branch that has the property.
 */
function branchFits(value: unknown, branch: Rec, root: Rec): boolean {
  if (Array.isArray(value)) return isRec(branch.items) || Array.isArray(branch.items) || Array.isArray(branch.prefixItems);
  if (!isRec(value) || !isRec(branch.properties)) return false;
  const props = branch.properties, required = Array.isArray(branch.required) ? branch.required.map(String) : [];
  if (!Object.keys(value).every((k) => Object.hasOwn(props, k)) || !required.every((k) => Object.hasOwn(value, k))) return false;
  return Object.entries(value).every(([k, v]) => {
    if (v === null && !required.includes(k)) return true;
    const p = deref(props[k], root);
    if (!isRec(p)) return true;
    if (Object.hasOwn(p, "const") && !sameJson(p.const, v)) return false;
    return !Array.isArray(p.enum) || p.enum.some((e) => sameJson(e, v));
  });
}

/** One `restore` call: results already computed (answer node × schema node) and the work done so far. */
interface RestoreRun { memo: Map<object, Map<unknown, unknown>>; steps: number }
class RestoreBudgetExceeded extends Error {}

/**
 * `null` of optional properties → no key; everything else as the model sent it. Walks the contract, not the wire.
 * Inside `anyOf` / `oneOf` the branch is chosen by the shape of the answer (its keys, its discriminators, or being an
 * array); when several branches fit and would restore it differently, the answer is left as it is — the contract check
 * decides. Each answer node is restored once per schema node (memo), so a recursive union whose branches
 * both fit at every level costs linear, not exponential, work; past `RESTORE_STEPS` the whole answer is returned as the
 * model sent it, and so is an answer nested deeper than the call stack. Objects are rebuilt with own data
 * properties only, so a key `__proto__` stays a key.
 */
function restoreStrict(value: unknown, schema: unknown, root: Rec, depth: number, run: RestoreRun): unknown {
  if (depth > 64) return value;
  const node = value !== null && typeof value === "object" ? value : null;
  const seen = node ? run.memo.get(node) : undefined;
  if (seen?.has(schema)) return seen.get(schema);
  if (++run.steps > RESTORE_STEPS) throw new RestoreBudgetExceeded();
  const out = restoreNode(value, schema, root, depth, run);
  if (node) {
    if (seen) seen.set(schema, out);
    else run.memo.set(node, new Map([[schema, out]]));
  }
  return out;
}

function restoreNode(value: unknown, schema: unknown, root: Rec, depth: number, run: RestoreRun): unknown {
  const s = deref(schema, root);
  if (!isRec(s)) return value;
  if (Array.isArray(value)) {
    // a tuple: `prefixItems`, or tuple-form `items` (draft 2019) with `additionalItems` for the rest
    const prefix = Array.isArray(s.prefixItems) ? s.prefixItems : Array.isArray(s.items) ? s.items : null;
    const rest = Array.isArray(s.items) ? s.additionalItems : s.items;
    if (prefix || isRec(rest)) {
      const head = prefix ?? [];
      return value.map((v, i) => (i < head.length ? restoreStrict(v, head[i], root, depth + 1, run) : isRec(rest) ? restoreStrict(v, rest, root, depth + 1, run) : v));
    }
    return restoreUnion(value, s, root, depth, run);
  }
  if (!isRec(value)) return value;
  if (!isRec(s.properties)) return restoreUnion(value, s, root, depth, run);
  const props = s.properties, required = new Set(Array.isArray(s.required) ? s.required.map(String) : []);
  const out: Rec = {};
  for (const [k, v] of Object.entries(value)) {
    if (!Object.hasOwn(props, k)) { put(out, k, v); continue; }
    if (v === null && !required.has(k)) continue;
    put(out, k, restoreStrict(v, props[k], root, depth + 1, run));
  }
  return out;
}

/** Compare restored JSON structurally, skipping shared subtrees beyond the depth limit. */
function sameRestored(a: unknown, b: unknown): boolean {
  const pending: [unknown, unknown][] = [[a, b]];
  while (pending.length) {
    const [left, right] = pending.pop()!;
    if (left === right) continue;
    if (Array.isArray(left)) {
      if (!Array.isArray(right) || left.length !== right.length) return false;
      for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) pending.push([left[i], right[i]]);
    } else {
      if (!isRec(left) || !isRec(right)) return false;
      const keys = Object.keys(left);
      if (keys.length !== Object.keys(right).length) return false;
      for (const key of keys) {
        if (!Object.hasOwn(right, key)) return false;
        if (left[key] !== right[key]) pending.push([left[key], right[key]]);
      }
    }
  }
  return true;
}

function restoreUnion(value: unknown, s: Rec, root: Rec, depth: number, run: RestoreRun): unknown {
  const fitting = unionBranches(s, root, depth).filter((b) => branchFits(value, b, root));
  if (!fitting.length) return value;
  const first = restoreStrict(value, fitting[0], root, depth + 1, run);
  for (let i = 1; i < fitting.length; i++)
    if (!sameRestored(first, restoreStrict(value, fitting[i], root, depth + 1, run))) return value;
  return first;
}

/**
 * Compiles a contract schema into the wire schema of a dialect. Throws `SchemaDialectError` when the dialect cannot
 * express the contract (an object without `additionalProperties: false` for the strict dialects, a construct the vendor
 * rejects): the call must fail before any request rather than send a schema the provider answers with 400.
 */
export function compile(contractSchema: object, dialect: SchemaDialect, opts: CompileOptions = {}): CompiledSchema {
  if (!isSchemaDialect(dialect)) throw new SchemaDialectError(String(dialect), "#", "unknown dialect");
  if (!isRec(contractSchema)) throw new SchemaDialectError(dialect, "#", "the contract schema must be an object");
  const contract = applyWireEnums(contractSchema, opts.wireEnums, dialect);

  if (dialect === "passthrough") {
    const unsupported = new Set(opts.unsupportedKeywords ?? ["uniqueItems"]);
    const found = new Set<string>();
    strippedBy(contract, unsupported, found);
    return { dialect, wire: wireSchema(contract, unsupported) as Rec, dropped: [...found].sort(), restore: (answer) => answer };
  }

  if (dialect === "openai_strict" && (contract.type !== "object" || "anyOf" in contract))
    throw new SchemaDialectError(dialect, "#", "the root must be an object schema without anyOf");
  if (dialect === "anthropic") {
    const cycle = refCycle(contract);
    if (cycle) throw new SchemaDialectError(dialect, cycle, "recursive schemas are not supported");
  }
  const ctx: Ctx = { dialect, root: contract, dropped: new Set(), optional: 0, unions: 0, enumValues: 0 };
  const wire = transform(contract, "#", ctx) as Rec;
  if (dialect === "openai_strict" && ctx.enumValues > OPENAI_MAX_ENUM_VALUES)
    throw new SchemaDialectError(dialect, "#", `more than ${OPENAI_MAX_ENUM_VALUES} enum values in one schema (${ctx.enumValues})`);
  if (dialect === "anthropic" && ctx.optional > ANTHROPIC_MAX_OPTIONAL)
    throw new SchemaDialectError(dialect, "#", `more than ${ANTHROPIC_MAX_OPTIONAL} optional properties (${ctx.optional})`);
  if (dialect === "anthropic" && ctx.unions > ANTHROPIC_MAX_UNION_PARAMS)
    throw new SchemaDialectError(dialect, "#", `more than ${ANTHROPIC_MAX_UNION_PARAMS} properties with union types (${ctx.unions})`);

  const original = contractSchema as Rec;
  const restore = dialect === "openai_strict"
    ? (answer: unknown) => {
        try { return restoreStrict(answer, original, original, 0, { memo: new Map(), steps: 0 }); }
        // An answer nested deeper than the call stack is returned as the model sent it, like one past the work limit:
        // `restore` never throws on data.
        catch (e) { if (e instanceof RestoreBudgetExceeded || e instanceof RangeError) return answer; throw e; }
      }
    : (answer: unknown) => answer;
  return { dialect, wire, dropped: [...ctx.dropped].sort(), restore };
}

/** Legacy schema projection, kept byte-compatible and exported by the facade. */
export function wireSchema(schema: unknown, unsupported: ReadonlySet<string>): unknown {
  if (Array.isArray(schema)) return schema.map((x) => wireSchema(x, unsupported));
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (unsupported.has(k)) continue;
    if (NAMED_SCHEMA_MAPS.has(k) && v && typeof v === "object" && !Array.isArray(v))
      out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([name, sub]) => [name, wireSchema(sub, unsupported)]));
    else out[k] = DATA_KEYWORDS.has(k) ? v : wireSchema(v, unsupported);
  }
  return out;
}
