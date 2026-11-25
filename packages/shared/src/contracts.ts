import type { McpResponseDetailContract } from "./mcp-detail.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { McpLanguage } from "./mcp-language.ts";

const addFormats = (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule;
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const CONTRACTS_DIR = process.env.MEMORY_CONTRACTS_DIR ?? resolve(REPO_ROOT, "contracts");

export interface ToolContract {
  name: string; title: string; description: string; group: "read" | "write" | "owner";
  inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>; annotations: Record<string, unknown>;
}
export interface McpInstructions {
  max_chars: number; core_max_chars: number; max_targets: number;
  skill_archive_max_url: number;
  skill_uri: string; core: string;
  sections: Record<"skill" | "skill_archive" | "project" | "live_systems" | "data" | "write_intro" | "write_outro" | "write_outro_core"
    | "personal_open" | "personal_off" | "personal_script" | "extended" | "extended_marked" | "no_open_targets" | "more_prefix" | "more_suffix", string>;
}
export interface McpPromptContract { name: string; title: string; description: string; unavailable: string }
export interface McpSkillsContract { extension: string; settings: Record<string, string | number | boolean | null>; list_ttl_ms: number; list_cache_scope: "private" | "public" }
/**
 * A dispatcher of the tool profile `core` (server.dispatchers): not an item of `tools` — it runs the real tools by
 * `action` (`memory_<action>`) through the same call path. `actions` — the tools it runs, derived from their annotations
 * (memory_manage: the tools outside the core with destructiveHint false; memory_manage_destructive: destructiveHint true).
 */
export interface McpDispatcherContract {
  name: string; title: string; description: string;
  inputSchema: Record<string, unknown>; annotations: Record<string, unknown>; actions: string[];
}
export interface McpContract {
  server: Record<string, any> & {
    instructions: McpInstructions; skills: McpSkillsContract; prompts: { items: McpPromptContract[] };
    /** The tools tools/list shows in the profile `core`. */
    tool_profiles: { core: string[] };
    dispatchers: McpDispatcherContract[];
    /** The long-form text of every tool, served by memory_manage help with a topic. */
    help: Record<string, string>;
    /** The fields a lean structured answer leaves out, by tool (setting access.mcp_response_detail). */
    response_detail: McpResponseDetailContract;
  };
  tools: ToolContract[];
}

/**
 * Locale overlay of the contract (contracts/locales/<lang>/mcp-tools.json, format prisma-mcp-locale/2): texts — JSON
 * pointer (RFC 6901) -> text; sources — the same pointers -> the first 12 hex digits of sha256 of the English text the
 * translation was made from; anchors — the pointer of every array item a text pointer goes through -> that item's identity
 * (its name, or `required:<names>` of a schema without a name). The maintainers' locale check and
 * the edge's tool generator apply the same rules to shared cases.
 */
export interface McpLocale {
  format: string; locale: string; source: string;
  anchors: Record<string, string>; sources: Record<string, string>; texts: Record<string, string>;
}

const LOCALE_FORMAT = "prisma-mcp-locale/2";
const RFC6901_INDEX = /^(0|[1-9][0-9]*)$/;
const sourceFingerprint = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);
/** The identity of an array item: its name, or the required names of a schema without a name; null — none. */
function itemIdentity(item: unknown): string | null {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
  const o = item as Record<string, unknown>;
  if (typeof o.name === "string") return o.name;
  const req = o.required;
  return Array.isArray(req) && req.length > 0 && req.every((r) => typeof r === "string") ? `required:${req.join(",")}` : null;
}
const mapOfStrings = (v: unknown): v is Record<string, string> =>
  v !== null && typeof v === "object" && !Array.isArray(v) && Object.values(v as object).every((x) => typeof x === "string");

/**
 * Puts the texts of a locale over a copy of the canonical contract. Refused, never served half-right: a pointer that does
 * not name a string of the canonical contract; a translation whose source fingerprint is not the current English text (the
 * English changed and the translation did not); an indexed pointer whose array item is not the anchored one (a tool or
 * template inserted, removed or reordered) or whose identity repeats in its array; a text without a source, a source or an
 * anchor without a text.
 */
export function applyMcpLocale(canonical: McpContract, locale: McpLocale, language: McpLanguage): McpContract {
  function bad(msg: string): never { throw new Error(`mcp locale ${language}: ${msg}`); }
  if (locale === null || typeof locale !== "object" || locale.format !== LOCALE_FORMAT || locale.locale !== language
      || locale.source !== "contracts/mcp-tools.json" || locale.texts === null || typeof locale.texts !== "object" || Array.isArray(locale.texts)
      || !mapOfStrings(locale.sources) || !mapOfStrings(locale.anchors))
    bad(`format ${LOCALE_FORMAT} expected — format, locale ${language}, source contracts/mcp-tools.json, texts, and sources and anchors as objects of strings`);
  const out = structuredClone(canonical) as unknown as Record<string, unknown>;
  const { texts, sources, anchors } = locale, used = new Set<string>();
  for (const [pointer, text] of Object.entries(texts)) {
    if (typeof text !== "string") bad(`${pointer}: the translation is not a string`);
    if (!pointer.startsWith("/")) bad(`${pointer} does not name a text of mcp-tools.json`);
    const segs = pointer.slice(1).split("/");
    let node: unknown = out;
    for (let i = 0; i < segs.length - 1; i++) {
      const part = segs[i]!.replace(/~1/g, "/").replace(/~0/g, "~");
      if (Array.isArray(node)) {
        if (!RFC6901_INDEX.test(part) || Number(part) >= node.length) bad(`${pointer} does not name a text of mcp-tools.json`);
        const prefix = "/" + segs.slice(0, i + 1).join("/"), item: unknown = node[Number(part)], id = itemIdentity(item);
        if (!Object.hasOwn(anchors, prefix)) bad(`${pointer} goes through the array item ${prefix} without an anchor`);
        if (id !== anchors[prefix])
          bad(`${prefix} is anchored to '${anchors[prefix]}' in the overlay, but the item there is ${id === null ? "None" : `'${id}'`}: the array changed order — reindex the Russian overlay`);
        if (node.filter((x) => itemIdentity(x) === id).length > 1)
          bad(`${prefix}: the identity '${id}' is not unique in its array — the anchor cannot tell the items apart`);
        used.add(prefix);
        node = item;
      } else if (node !== null && typeof node === "object" && Object.hasOwn(node, part)) node = (node as Record<string, unknown>)[part];
      else bad(`${pointer} does not name a text of mcp-tools.json`);
    }
    // the last step: a string of an object (an array item itself is not a text)
    const key = segs[segs.length - 1]!.replace(/~1/g, "/").replace(/~0/g, "~");
    if (node === null || typeof node !== "object" || Array.isArray(node) || !Object.hasOwn(node, key)
        || typeof (node as Record<string, unknown>)[key] !== "string")
      bad(`${pointer} does not name a text of mcp-tools.json`);
    const parent = node as Record<string, unknown>, english = parent[key] as string;
    if (!Object.hasOwn(sources, pointer)) bad(`${pointer} has no source fingerprint: confirm ${pointer} in the Russian overlay`);
    const now = sourceFingerprint(english);
    if (sources[pointer] !== now)
      bad(`${pointer} translates another English text (source ${sources[pointer]}, the English text now ${now}): check the translation against it, then confirm ${pointer} in the Russian overlay`);
    parent[key] = text;
  }
  for (const pointer of Object.keys(sources)) if (!Object.hasOwn(texts, pointer)) bad(`${pointer}: source fingerprint without a text`);
  for (const prefix of Object.keys(anchors)) if (!used.has(prefix)) bad(`${prefix}: anchor used by no text`);
  return out as unknown as McpContract;
}

const cached = new Map<McpLanguage, McpContract>();
/** The MCP contract in a language: English — contracts/mcp-tools.json as is; Russian — with contracts/locales/ru/mcp-tools.json. */
export function mcpContract(language: McpLanguage = "en"): McpContract {
  let c = cached.get(language);
  if (!c) {
    const canonical = cached.get("en") ?? JSON.parse(readFileSync(resolve(CONTRACTS_DIR, "mcp-tools.json"), "utf8")) as McpContract;
    cached.set("en", canonical);
    c = language === "en" ? canonical
      : applyMcpLocale(canonical, JSON.parse(readFileSync(resolve(CONTRACTS_DIR, "locales", language, "mcp-tools.json"), "utf8")) as McpLocale, language);
    cached.set(language, c);
  }
  return c;
}

const ajv = new Ajv2020({ strict: false, allErrors: true, useDefaults: true, coerceTypes: false });
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
const inputValidators = new Map<string, ValidateFunction>();

export function validateToolInput(name: string, args: unknown): { ok: true } | { ok: false; message: string } {
  let v = inputValidators.get(name);
  if (!v) {
    const tool = mcpContract().tools.find((t) => t.name === name);
    if (!tool) return { ok: false, message: `unknown tool ${name}` };
    v = ajv.compile(tool.inputSchema);
    inputValidators.set(name, v);
  }
  return checked(v, args);
}

const dispatcherValidators = new Map<string, ValidateFunction>();

/**
 * The input of a dispatcher by its own schema in server.dispatchers — a map apart from the tools: a dispatcher name
 * is not a tool, so validateToolInput keeps refusing it.
 */
export function validateDispatcherInput(name: string, args: unknown): { ok: true } | { ok: false; message: string } {
  let v = dispatcherValidators.get(name);
  if (!v) {
    const d = (mcpContract().server.dispatchers ?? []).find((x) => x.name === name);
    if (!d) return { ok: false, message: `unknown dispatcher ${name}` };
    v = ajv.compile(d.inputSchema);
    dispatcherValidators.set(name, v);
  }
  return checked(v, args);
}

function checked(v: ValidateFunction, args: unknown): { ok: true } | { ok: false; message: string } {
  if (v(args)) return { ok: true };
  const errs = (v.errors ?? []).map((e) => e.keyword === "additionalProperties"
    ? { ...e, message: `${e.message}: ${(e.params as { additionalProperty?: string }).additionalProperty}` } : e);
  return { ok: false, message: ajv.errorsText(errs, { separator: "; " }) };
}

export const opOfTool = (tool: string): string => tool.replace(/^memory_/, "");
