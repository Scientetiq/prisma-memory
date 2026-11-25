// Validation of connector manifests and configs. A manifest must fit the contract schema
// (contracts/connectors/schemas/manifest.schema.json) and the SDK rules below; a config must fit the config schema of
// its kind. Problems carry stable codes and English messages; values are never echoed (a config may hold anything).
import type { ValidateFunction } from "ajv/dist/2020.js";
import { ajvProblems, contractSchema, strictAjv } from "./contract.ts";
import type { Connector, ConnectorManifest, JsonSchema, Problem } from "./types.ts";

/** The only egress host of a kind that makes no outbound requests: `.invalid` never resolves (RFC 6761), so the egress
 * client has nothing it may reach. The contract wants at least one host in `egress.hosts`. */
export const NO_EGRESS_HOST = "egress.invalid";

/** SDK bounds of manifest limits. */
export const LIMITS_MAX = { minIntervalSec: 604_800, maxItemsPerRun: 100_000, maxBytesPerItem: 33_554_432 } as const;

/** Nesting of config objects: the top object plus two levels below it. */
const MAX_CONFIG_DEPTH = 3;

/** Config fields whose names say they hold a secret; secrets are declared in `secrets` and read by ctx.secret(). The
 * usual words match anywhere in the name (`apitoken`, `secretkey`, `auth_header_password`); `pwd` as a whole word. */
const SECRET_NAME =
  /password|passwd|passphrase|secret|token|credential|api_?key|private_?key|signing_?key|access_?key|authorization|bearer|(^|_)pwd(_|$)/;

const SCALAR_KEYWORDS: Record<string, readonly string[]> = {
  string: ["minLength", "maxLength", "pattern", "format", "enum"],
  number: ["minimum", "maximum", "enum"],
  integer: ["minimum", "maximum", "enum"],
  boolean: [],
};
const ANNOTATIONS = ["title", "description", "default", "examples"];
const FORMATS = new Set(["uri", "email", "hostname", "date-time"]);
const LOCAL_SUFFIXES = [".local", ".localhost", ".internal", ".home.arpa", ".lan"];

const problem = (code: string, path: string, message: string): Problem => ({ code, path, message });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Problems of a config schema node (`path` — JSON pointer inside the manifest). */
function configNodeProblems(node: unknown, path: string, depth: number, out: Problem[]): void {
  if (!isObject(node)) {
    out.push(problem("config_schema", path, `${path} is not a schema object`));
    return;
  }
  const type = node.type;
  if (type === "object") {
    if (depth > MAX_CONFIG_DEPTH) {
      out.push(problem("config_schema", path, `${path}: config objects nest at most ${MAX_CONFIG_DEPTH} levels`));
      return;
    }
    for (const k of Object.keys(node)) {
      if (!["type", "properties", "required", "additionalProperties", ...ANNOTATIONS].includes(k))
        out.push(problem("config_schema", `${path}/${k}`, `${path}: keyword "${k}" is outside the supported config subset`));
    }
    if (node.additionalProperties !== false)
      out.push(problem("config_open", path, `${path} must set additionalProperties to false: a config takes only the fields it names`));
    const props = node.properties ?? {};
    if (!isObject(props)) {
      out.push(problem("config_schema", `${path}/properties`, `${path}/properties is not an object`));
      return;
    }
    if (node.required !== undefined) {
      const req = node.required;
      if (!Array.isArray(req) || req.some((r) => typeof r !== "string" || !Object.hasOwn(props, r)))
        out.push(problem("config_schema", `${path}/required`, `${path}/required must list fields of properties`));
    }
    for (const [name, child] of Object.entries(props)) {
      const p = `${path}/properties/${name}`;
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(name))
        out.push(problem("config_schema", p, `${p}: field names are lowercase letters, digits and _`));
      if (SECRET_NAME.test(name))
        out.push(problem("config_secret_name", p, `${p}: a field named like a secret belongs in "secrets", not in the config`));
      configNodeProblems(child, p, depth + 1, out);
    }
    return;
  }
  if (type === "array") {
    for (const k of Object.keys(node)) {
      if (!["type", "items", "minItems", "maxItems", "uniqueItems", ...ANNOTATIONS].includes(k))
        out.push(problem("config_schema", `${path}/${k}`, `${path}: keyword "${k}" is outside the supported config subset`));
    }
    const items = node.items;
    if (!isObject(items) || items.type !== "string") {
      out.push(problem("config_schema", `${path}/items`, `${path}: config arrays hold strings only`));
      return;
    }
    configNodeProblems(items, `${path}/items`, depth, out);
    return;
  }
  if (typeof type !== "string" || !Object.hasOwn(SCALAR_KEYWORDS, type)) {
    out.push(problem("config_schema", path, `${path}: the type must be object, array, string, number, integer or boolean`));
    return;
  }
  for (const k of Object.keys(node)) {
    if (k !== "type" && !ANNOTATIONS.includes(k) && !SCALAR_KEYWORDS[type]!.includes(k))
      out.push(problem("config_schema", `${path}/${k}`, `${path}: keyword "${k}" is outside the supported config subset`));
  }
  if (node.format !== undefined && !FORMATS.has(node.format as string))
    out.push(problem("config_schema", `${path}/format`, `${path}: format must be one of ${[...FORMATS].join(", ")}`));
  if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length === 0))
    out.push(problem("config_schema", `${path}/enum`, `${path}: enum must be a non-empty list`));
}

/** Defaults that do not fit their own field. */
function defaultProblems(node: unknown, path: string, out: Problem[]): void {
  if (!isObject(node)) return;
  if (Object.hasOwn(node, "default")) {
    const own = { ...node };
    delete own.default;
    let ok = false;
    try {
      ok = strictAjv().compile(own)(node.default) === true;
    } catch {
      ok = false;
    }
    if (!ok) out.push(problem("config_default", `${path}/default`, `${path}: the default does not fit the field`));
  }
  if (isObject(node.properties)) for (const [n, c] of Object.entries(node.properties)) defaultProblems(c, `${path}/properties/${n}`, out);
  if (isObject(node.items)) defaultProblems(node.items, `${path}/items`, out);
}

/** What the URL parser makes of a host: the egress client connects to this name, not to the text of the manifest. */
function parsedHost(host: string): string | null {
  try {
    return new URL(`https://${host}/`).hostname;
  } catch {
    return null;
  }
}

function hostLiteralProblem(host: string): string | null {
  if (/^[0-9.]+$/.test(host) || host.includes(":")) return "is an address literal";
  // hexadecimal, octal and short IPv4 forms (0x7f.1, 0177.0.0.1) are addresses to the URL parser
  const parsed = parsedHost(host);
  if (parsed === null || parsed !== host || /^[0-9.]+$/.test(parsed) || parsed.startsWith("[")) return "is an address literal or not a plain host name";
  if (!host.includes(".")) return "is a single-label name";
  if (LOCAL_SUFFIXES.some((s) => host.endsWith(s)) || host === "localhost") return "is a local name";
  return null;
}

let manifestSchema: ValidateFunction | null = null;

/** Problems of a manifest; empty — the manifest is accepted. Never throws. */
export function validateManifest(manifest: unknown): Problem[] {
  const out: Problem[] = [];
  if (isObject(manifest) && isObject(manifest.capabilities) && Object.hasOwn(manifest.capabilities, "actions")) {
    out.push(problem("actions_not_supported", "/capabilities/actions",
      "outbound actions are not executed in this release: a kind that declares capabilities.actions is refused"));
  }
  manifestSchema ??= contractSchema("manifest");
  if (!manifestSchema(manifest)) {
    out.push(...ajvProblems(manifestSchema.errors, "manifest_invalid", 10));
    return out;
  }
  const m = manifest as unknown as ConnectorManifest;

  const caps = m.capabilities;
  if (!caps.pull && !caps.webhook && !caps.entity_lookup)
    out.push(problem("no_capability", "/capabilities", "a kind must pull, receive webhooks or look up entities"));
  if (caps.entity_lookup && !m.produces.includes("entity"))
    out.push(problem("lookup_without_entity", "/capabilities/entity_lookup", "entity lookup needs \"entity\" in produces"));
  if (m.produces.every((t) => t === "entity") && m.scopes.includes("person"))
    out.push(problem("entity_scope", "/scopes", "entities come only from instance-scope connectors: a kind that produces only entities cannot have the person scope"));

  const seen = new Set<string>();
  m.secrets.forEach((s, i) => {
    if (seen.has(s.name)) out.push(problem("duplicate_secret", `/secrets/${i}/name`, `secret "${s.name}" is declared twice`));
    if (s.name === "webhook") out.push(problem("reserved_secret", `/secrets/${i}/name`, `secret name "webhook" is reserved: the framework creates and rotates the signing secret of webhooks`));
    seen.add(s.name);
  });

  for (const [k, max] of Object.entries(LIMITS_MAX)) {
    const v = m.limits[k as keyof typeof LIMITS_MAX];
    if (v > max) out.push(problem("limit_range", `/limits/${k}`, `limits.${k} is at most ${max}`));
  }

  const before = out.length;
  if (m.config.type !== "object") {
    out.push(problem("config_schema", "/config", "the config schema must be an object schema"));
  } else {
    configNodeProblems(m.config, "/config", 1, out);
  }
  if (out.length === before) {
    try {
      strictAjv().compile(m.config);
    } catch (e) {
      out.push(problem("config_schema", "/config", `the config schema does not compile: ${(e as Error).message.slice(0, 200)}`));
    }
    defaultProblems(m.config, "/config", out);
  }
  for (const s of m.secrets) {
    if (isObject(m.config.properties) && Object.hasOwn(m.config.properties, s.name))
      out.push(problem("config_secret_name", `/config/properties/${s.name}`, `config field "${s.name}" has the name of a secret`));
  }

  if ("hostFromConfig" in m.egress) {
    const field = isObject(m.config.properties) ? (m.config.properties as Record<string, unknown>)[m.egress.hostFromConfig] : undefined;
    if (!isObject(field) || field.type !== "string" || field.format !== "uri")
      out.push(problem("egress_host_field", "/egress/hostFromConfig",
        `egress.hostFromConfig must name a top-level config field of type string with format "uri"`));
  } else {
    m.egress.hosts.forEach((h, i) => {
      const why = hostLiteralProblem(h);
      if (why) out.push(problem("egress_host_literal", `/egress/hosts/${i}`, `egress host ${i} ${why}: fixed hosts are public names`));
    });
  }
  return out;
}

const configValidators = new WeakMap<object, ValidateFunction>();

function configValidator(manifest: ConnectorManifest): ValidateFunction {
  let v = configValidators.get(manifest.config);
  if (!v) {
    v = strictAjv().compile(manifest.config as JsonSchema);
    configValidators.set(manifest.config, v);
  }
  return v;
}

/** Problems of a config against the config schema of its kind (the manifest must be valid). */
export function validateConfig(manifest: ConnectorManifest, config: unknown): Problem[] {
  if (!isObject(config)) return [problem("config_invalid:type", "", "the config must be an object")];
  const v = configValidator(manifest);
  return v(config) ? [] : ajvProblems(v.errors, "config_invalid", 20);
}

/** The schema of a preset's defaults: the config schema without `required` (the administrator fills those fields). */
export function partialConfigSchema(schema: JsonSchema): JsonSchema {
  const strip = (node: unknown): unknown => {
    if (!isObject(node)) return node;
    const out: Record<string, unknown> = { ...node };
    delete out.required;
    if (isObject(node.properties))
      out.properties = Object.fromEntries(Object.entries(node.properties).map(([k, c]) => [k, strip(c)]));
    return out;
  };
  return strip(schema) as JsonSchema;
}

/** Problems of partial config values (a preset's defaults) against the config schema of a kind. */
export function validatePartialConfig(manifest: ConnectorManifest, config: unknown): Problem[] {
  if (!isObject(config)) return [problem("config_invalid:type", "", "the config must be an object")];
  const v = strictAjv().compile(partialConfigSchema(manifest.config));
  return v(config) ? [] : ajvProblems(v.errors, "config_invalid", 20);
}

/** True when a field below this object schema has a default. */
function hasNestedDefault(schema: Record<string, unknown>): boolean {
  if (!isObject(schema.properties)) return false;
  return Object.values(schema.properties).some((s) => isObject(s) && (Object.hasOwn(s, "default") || (s.type === "object" && hasNestedDefault(s))));
}

/** True when defaults alone give this object schema every required field (so creating it keeps the config valid). */
function creatable(schema: Record<string, unknown>): boolean {
  const props = isObject(schema.properties) ? schema.properties : {};
  const req = Array.isArray(schema.required) ? schema.required : [];
  return req.every((r) => {
    const s = props[r as string];
    return isObject(s) && (Object.hasOwn(s, "default") || (s.type === "object" && creatable(s)));
  });
}

/** The config with the schema's defaults filled in; the given object is not changed. An absent object field is created
 * when a field below it has a default and defaults give it every required field, so `{}` gets the same defaults as
 * `{lookup: {}}`. */
export function applyConfigDefaults<C extends Record<string, unknown>>(manifest: ConnectorManifest, config: C): C {
  const fill = (schema: unknown, value: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...value };
    if (!isObject(schema) || !isObject(schema.properties)) return out;
    for (const [k, s] of Object.entries(schema.properties)) {
      if (!isObject(s)) continue;
      if (out[k] === undefined && Object.hasOwn(s, "default")) out[k] = structuredClone(s.default);
      else if (s.type === "object" && isObject(out[k])) out[k] = fill(s, out[k] as Record<string, unknown>);
      else if (s.type === "object" && out[k] === undefined && hasNestedDefault(s) && creatable(s)) out[k] = fill(s, {});
    }
    return out;
  };
  return fill(manifest.config, config) as C;
}

/** Problems of a connector object: methods and declared capabilities must agree (a pull without `pull` cannot run, a
 * `pull` without the capability would never be scheduled). */
export function connectorShapeProblems(connector: Connector): Problem[] {
  const out: Problem[] = [];
  const caps = connector.manifest?.capabilities ?? {};
  const has = (f: unknown): boolean => typeof f === "function";
  if (!has(connector.test)) out.push(problem("connector_invalid", "/test", "a connector has a test() method"));
  if (Boolean(caps.pull) !== has(connector.pull))
    out.push(problem("capability_mismatch", "/capabilities/pull", "capabilities.pull and the pull() method go together"));
  if (Boolean(caps.entity_lookup) !== has(connector.lookup))
    out.push(problem("capability_mismatch", "/capabilities/entity_lookup", "capabilities.entity_lookup and the lookup() method go together"));
  if (has(connector.parseWebhook) && !caps.webhook)
    out.push(problem("capability_mismatch", "/capabilities/webhook", "a parseWebhook() method needs capabilities.webhook"));
  return out;
}
