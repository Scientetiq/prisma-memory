// The `mcp_source` kind: any MCP server as a live entity lookup. The entities stage asks it for a company, a deal or
// another kind by name; an answer of exactly one hit links the mention. The tool names, their argument names and where
// the hits lie in the answer are configuration, so one kind serves any CRM or registry that offers a search tool over
// MCP. Lookup only: no pull or sync in this release (a follow-up task; the config schema refuses a `sync` key).
//
// What a hostile server can do is bounded here: at most `limit` hits are read, an id must be one the connectors contract
// allows (1–128 characters, no control characters), a title becomes one line of at most 300 characters, anything else
// in the answer (texts, descriptions, `_meta`, URLs) is never read, and the only address called is the configured URL.
import { isRawExternalId } from "../../sdk/entity-key.ts";
import { ENTITY_KINDS, type Connector, type ConnectorManifest, type EntityHit, type EntityKind, type Problem } from "../../sdk/types.ts";
import { httpToolCaller, isVendorAnswerError, vendorAnswerError, type McpAuth, type McpToolCaller } from "./caller.ts";
import { markCore, runFailureCode } from "../../failure.ts";

export { httpToolCaller, MCP_CALL_MAX_BYTES, MCP_CALL_TIMEOUT_MS, MCP_PROTOCOL_VERSION, type McpAuth, type McpCallerCtx, type McpToolCaller } from "./caller.ts";

/** How one entity kind is looked up. */
export interface McpLookupTool {
  tool: string;
  query_arg: string;
  limit_arg: string;
  /** JSON pointer into the tool's structured content; "" — the content itself is the list. */
  items_path: string;
  id_field: string;
  title_field: string;
}

export interface McpSourceConfig {
  url: string;
  auth: McpAuth;
  /** System code of the entities (`ext:<system>:<kind>:<id>`). */
  system: string;
  lookup: Partial<Record<EntityKind, McpLookupTool>>;
}

/** Longest query sent: the mention as one line. */
export const LOOKUP_QUERY_MAX = 200;
/** Longest title kept from a hit. */
export const LOOKUP_TITLE_MAX = 300;
/** Most hits one lookup asks for and reads. */
export const LOOKUP_LIMIT_MAX = 20;

const CTL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** A text as one line: control, line-separator and direction characters become spaces, runs of spaces one, cut by code
 * points. */
export function oneLine(text: unknown, max: number): string {
  if (typeof text !== "string") return "";
  const flat = text.replace(LONE_SURROGATE, "").replace(CTL, " ").replace(/\s+/gu, " ").trim();
  const chars = [...flat];
  return chars.length <= max ? flat : chars.slice(0, max).join("").trimEnd();
}

/** The query of a lookup: the mention as one line of at most 200 characters. */
export const lookupQuery = (name: unknown): string => oneLine(name, LOOKUP_QUERY_MAX);

const NAME = "^[A-Za-z0-9_.:/-]{1,128}$";
const ARG = "^[A-Za-z_][A-Za-z0-9_]{0,63}$";
const FIELD = "^[A-Za-z0-9_.-]{1,64}$";
const POINTER = "^(/[A-Za-z0-9_.~-]{1,64}){0,4}$";
/** Header names of the `header` mode: an HTTP token that is none of the headers the egress client sets itself. */
const HEADER = "^(?!(?:host|content-length|content-type|transfer-encoding|connection|upgrade|te|trailer|expect|accept|accept-encoding|"
  + "proxy-authorization|proxy-connection|user-agent|mcp-[a-z-]*)$)[a-z][a-z0-9-]{0,63}$";

const toolSchema = (kind: string) => ({
  type: "object",
  additionalProperties: false,
  required: ["tool"],
  title: `Lookup of ${kind}`,
  properties: {
    tool: { type: "string", pattern: NAME, title: "Tool", description: "Name of the MCP tool that searches this kind by name." },
    query_arg: { type: "string", pattern: ARG, default: "query", title: "Query argument", description: "Argument of the tool that takes the name." },
    limit_arg: { type: "string", pattern: ARG, default: "limit", title: "Limit argument", description: "Argument of the tool that takes the number of hits." },
    items_path: { type: "string", pattern: POINTER, default: "/items", title: "Hits path", description: "JSON pointer to the list of hits in the tool's structured content." },
    id_field: { type: "string", pattern: FIELD, default: "id", title: "Id field", description: "Field of a hit that holds its id in the source." },
    title_field: { type: "string", pattern: FIELD, default: "title", title: "Title field", description: "Field of a hit that holds its name." },
  },
});

export const mcpSourceManifest: ConnectorManifest = {
  kind: "mcp_source",
  sdk: 1,
  version: "1.0.0",
  title: "MCP source",
  description: "Looks up companies, deals and other entities by name in any MCP server that offers a search tool: tool names, arguments and result fields are configuration.",
  // checked against our own MCP mock server only
  verified: "mock_only",
  scopes: ["instance"],
  produces: ["entity"],
  capabilities: { entity_lookup: [...ENTITY_KINDS] },
  config: {
    type: "object",
    additionalProperties: false,
    required: ["url", "system"],
    properties: {
      url: { type: "string", format: "uri", maxLength: 2048, title: "Server URL", description: "The MCP endpoint of the server (HTTP POST, stateless tools/call). It is the only address the connector calls." },
      auth: {
        type: "object",
        additionalProperties: false,
        title: "Authentication",
        properties: {
          type: { type: "string", enum: ["none", "bearer", "header"], default: "none", title: "Mode", description: "none, a bearer token, or the token in a named header." },
          header: { type: "string", pattern: HEADER, title: "Header name", description: "Lowercase name of the header that carries the token (mode header)." },
        },
      },
      system: { type: "string", pattern: "^[a-z][a-z0-9_]{1,31}$", title: "System code", description: "Code of the source system in entity keys (ext:<system>:<kind>:<id>)." },
      lookup: {
        type: "object",
        additionalProperties: false,
        title: "Lookups",
        description: "The tool of each entity kind this server can look up; kinds left out are not looked up here.",
        properties: Object.fromEntries(ENTITY_KINDS.map((k) => [k, toolSchema(k)])),
      },
    },
  },
  secrets: [{ name: "token", title: "Access token", required: false }],
  egress: { hostFromConfig: "url" },
  limits: { minIntervalSec: 60, maxItemsPerRun: 1000, maxBytesPerItem: 1_048_576 },
};

/** The value at a JSON pointer (RFC 6901, own keys only); undefined when the path is not there. */
function atPointer(root: unknown, pointer: string): unknown {
  if (pointer === "") return root;
  let cur: unknown = root;
  for (const raw of pointer.slice(1).split("/")) {
    const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(cur) && /^(0|[1-9][0-9]{0,5})$/.test(part) && Object.hasOwn(cur, part)) cur = cur[Number(part)];
    else if (typeof cur === "object" && cur !== null && !Array.isArray(cur) && Object.hasOwn(cur, part)) cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

/** The hits of one answer: at most `limit` entries read; an entry without a valid id or a non-empty title is dropped. */
export function hitsOf(content: unknown, t: McpLookupTool, kind: EntityKind, limit: number): EntityHit[] {
  const list = atPointer(content, t.items_path);
  if (!Array.isArray(list)) throw vendorAnswerError("bad_response");
  const out: EntityHit[] = [];
  for (const x of list.slice(0, limit)) {
    if (typeof x !== "object" || x === null || Array.isArray(x)) continue;
    const rawId = Object.hasOwn(x, t.id_field) ? (x as Record<string, unknown>)[t.id_field] : undefined;
    const id = typeof rawId === "number" && Number.isSafeInteger(rawId) ? String(rawId) : rawId;
    if (!isRawExternalId(id)) continue;
    const name = oneLine(Object.hasOwn(x, t.title_field) ? (x as Record<string, unknown>)[t.title_field] : undefined, LOOKUP_TITLE_MAX);
    if (name === "") continue;
    out.push({ kind, id, name });
  }
  return out;
}

/** The lookup tool of a kind with the manifest's defaults filled in; null when the kind is not configured. */
export function lookupTool(config: McpSourceConfig, kind: string): McpLookupTool | null {
  const t = (config.lookup as Record<string, Partial<McpLookupTool> | undefined> | undefined)?.[kind];
  if (!t || typeof t.tool !== "string") return null;
  return {
    tool: t.tool, query_arg: t.query_arg ?? "query", limit_arg: t.limit_arg ?? "limit", items_path: t.items_path ?? "/items",
    id_field: t.id_field ?? "id", title_field: t.title_field ?? "title",
  };
}

function configProblems(config: McpSourceConfig): Problem[] {
  const out: Problem[] = [];
  let url: URL | null = null;
  try { url = new URL(config.url); } catch { /* reported below */ }
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.port === "0" || !url.hostname)
    out.push({ code: "config_invalid:url", path: "/url", message: "the server URL is an http or https URL without user information" });
  if (config.auth?.type === "header" && !config.auth.header)
    out.push({ code: "config_invalid:auth_header", path: "/auth/header", message: "the header mode needs the name of the header" });
  return out;
}

/** One lookup through a caller (the connector's own, or a test's). */
export async function lookupWith(caller: McpToolCaller, config: McpSourceConfig, kind: EntityKind, name: string, limit: number): Promise<EntityHit[]> {
  const t = lookupTool(config, kind);
  if (!t) return [];
  const query = lookupQuery(name);
  if (query === "") return [];
  const n = Math.max(1, Math.min(LOOKUP_LIMIT_MAX, Number.isSafeInteger(limit) ? limit : 5));
  const content = await caller.call(t.tool, { [t.query_arg]: query, [t.limit_arg]: n });
  return hitsOf(content, t, kind, n);
}

export const mcpSourceConnector: Connector<McpSourceConfig> = {
  manifest: mcpSourceManifest,
  validate: configProblems,
  // reachability and the key: one lookup of the first configured kind with a fixed query; any answer of the tool is ok
  async test(ctx) {
    const kind = ENTITY_KINDS.find((k) => lookupTool(ctx.config, k) !== null);
    // the answer is marked with the code our branch chose for the runner (config_invalid of the run table)
    if (!kind) return markCore({ ok: false, code: "config_invalid:lookup", message: "no entity kind has a lookup tool" }, "config_invalid");
    const t0 = Date.now();
    try {
      await lookupWith(httpToolCaller(ctx), ctx.config, kind, "connection test", 1);
      return { ok: true, code: "ok", latencyMs: Date.now() - t0 };
    } catch (e) {
      const code = typeof (e as { code?: unknown })?.code === "string" ? (e as { code: string }).code : "internal";
      // what the runner stores is chosen by our branch — an own or egress failure keeps its code (marked), a
      // declarable code of the SDK stays, a failure read from the vendor's answer is vendor_refused, anything else internal
      return markCore({ ok: false, code, latencyMs: Date.now() - t0 }, isVendorAnswerError(e) ? "vendor_refused" : runFailureCode(e));
    }
  },
  lookup: (ctx, kind, name, limit) => lookupWith(httpToolCaller(ctx), ctx.config, kind, name, limit),
};
