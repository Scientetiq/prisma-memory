// How much the structured answers of MCP tools carry. The setting access.mcp_response_detail picks it:
//   lean — the fields listed in the contract (server.response_detail.lean) are left out of structuredContent: service fields
//          that an agent rarely needs and that stay reachable elsewhere (memory_read with `include`, REST, the workplace);
//          the default of a new installation and the reading of an unknown value;
//   full — structuredContent as the gateway functions return it (an installation that existed before this setting keeps it).
// The list is contract data, read here by the gateway (the answers) and by the served view of the output schemas (a lean
// field leaves `required` in what tools/list serves); the canonical schemas of the contract stay as they are.
// An entry is a JSON pointer (RFC 6901) into the answer; the segment `*` stands for every item of an array. `kept_when` —
// conditions under which the field stays in a lean answer too: `truncated` (the answer was cut), `range` (the call chose a
// range), `include:<name>` (the call asked for it with `include`), `restricted_by_source` (the value has
// restricted_by_source: true), `unfinished` (the value is a conversion state whose status is not done).
// an entry with `max_items` does not leave its array out — it keeps at most that many first items (memory_me keeps
// its 5 latest actions); `kept_when` keeps the whole array.
// No I/O here: settings.ts validates the value with MCP_RESPONSE_DETAILS, the gateway reads it per request.
import type { McpContract } from "./contracts.ts";

/** Values of the setting access.mcp_response_detail. */
export const MCP_RESPONSE_DETAILS = ["lean", "full"] as const;
export type McpResponseDetail = (typeof MCP_RESPONSE_DETAILS)[number];
export const MCP_RESPONSE_DETAIL_SETTING = "access.mcp_response_detail";
/** The detail for a setting value: a known value as is, anything else (no row, empty, a typo, another type) — `lean`. */
export const mcpResponseDetail = (value: unknown): McpResponseDetail =>
  (MCP_RESPONSE_DETAILS as readonly unknown[]).includes(value) ? value as McpResponseDetail : "lean";

/** The conditions of `kept_when` (the validator of the contract checks every entry against this list). */
export const LEAN_CONDITIONS = ["truncated", "range", "include:toc", "include:details", "restricted_by_source", "unfinished"] as const;
export type LeanCondition = (typeof LEAN_CONDITIONS)[number];
/** Values of `include` of memory_read: what a lean answer leaves out and the call asks back. */
export const READ_INCLUDES = ["toc", "details"] as const;

/** One field of a lean answer: where it is, and when it stays; `max_items` — an array cut to its first items instead. */
export interface LeanEntry { pointer: string; kept_when?: LeanCondition[]; max_items?: number }
/** server.response_detail of the contract. */
export interface McpResponseDetailContract { $comment?: string; lean: Record<string, LeanEntry[]> }

/** The fields a lean answer of `tool` leaves out (none — an empty list). */
export function leanEntries(contract: Pick<McpContract, "server">, tool: string): readonly LeanEntry[] {
  const lean = (contract.server.response_detail as McpResponseDetailContract | undefined)?.lean;
  return lean && Object.hasOwn(lean, tool) ? lean[tool]! : [];
}

/** Segments of a JSON pointer (RFC 6901: ~1 is /, ~0 is ~); "" — the whole document (no segments). */
export function pointerSegments(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new TypeError(`not a JSON pointer: ${JSON.stringify(pointer)}`);
  return pointer.slice(1).split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

type Obj = Record<string, unknown>;
const plain = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/** What the call asked and what the answer says — the inputs of the conditions that do not look at the value itself. */
export interface LeanCall { truncated: boolean; range: boolean; include: ReadonlySet<string> }

/** The call side of the conditions: `args` of tools/call and the answer (truncated). */
export function leanCall(args: unknown, result: unknown): LeanCall {
  const a = plain(args) ? args : {};
  const include = new Set(Array.isArray(a.include) ? a.include.filter((x): x is string => typeof x === "string") : []);
  return { truncated: plain(result) && result.truncated === true, range: plain(a.range) && Object.keys(a.range).length > 0, include };
}

function kept(conds: readonly LeanCondition[] | undefined, value: unknown, call: LeanCall): boolean {
  for (const c of conds ?? []) {
    if (c === "truncated" && call.truncated) return true;
    if (c === "range" && call.range) return true;
    if (c.startsWith("include:") && call.include.has(c.slice("include:".length))) return true;
    if (c === "restricted_by_source" && plain(value) && value.restricted_by_source === true) return true;
    if (c === "unfinished" && plain(value) && value.status !== "done") return true;
  }
  return false;
}

/**
 * `node` without the field at `segs` (copied along the path; `node` itself is not changed) — or, with `max_items`, with that
 * array cut to its first items. Absent, or nothing to cut — the same reference.
 */
function without(node: unknown, segs: readonly string[], entry: LeanEntry, call: LeanCall): unknown {
  const [head, ...rest] = segs;
  if (head === undefined) return node;
  if (head === "*") {
    if (!Array.isArray(node)) return node;
    let changed = false;
    const out = node.map((x) => { const y = without(x, rest, entry, call); if (y !== x) changed = true; return y; });
    return changed ? out : node;
  }
  if (!plain(node) || !Object.hasOwn(node, head)) return node;
  if (!rest.length) {
    if (kept(entry.kept_when, node[head], call)) return node;
    if (entry.max_items !== undefined) {
      const v = node[head];
      return Array.isArray(v) && v.length > entry.max_items ? { ...node, [head]: v.slice(0, entry.max_items) } : node;
    }
    const { [head]: _drop, ...others } = node;
    return others;
  }
  const inner = without(node[head], rest, entry, call);
  return inner === node[head] ? node : { ...node, [head]: inner };
}

/**
 * The lean answer of a tool: the fields of `entries` left out unless their condition keeps them. A new object along every
 * changed path, the order of the other keys kept; the input is never changed (the text renderer and the audit hold it).
 * Nothing to leave out — the same reference.
 */
export function leanResult(result: unknown, entries: readonly LeanEntry[], call: LeanCall): unknown {
  let out = result;
  for (const e of entries) out = without(out, pointerSegments(e.pointer), e, call);
  return out;
}

type Schema = Record<string, unknown>;
const REF = /^#\/\$defs\/([^/]+)$/;

/**
 * The output schema with every field of `entries` out of `required` (a new object; the argument is not changed): the field
 * may be absent in a lean answer. The walk follows the pointer through `properties`, `items` (for `*`), the branches of
 * `oneOf` / `anyOf` / `allOf` and local `$ref`s into `$defs` of the same schema (a definition reached this way is changed for
 * every user of it — in the served view only, where a lean answer may leave the field out anywhere). An entry with
 * `max_items` keeps its field, so it stays required.
 */
export function leanRequiredSchema(schema: Schema, entries: readonly LeanEntry[]): Schema {
  const out = structuredClone(schema);
  const defs = plain(out.$defs) ? (out.$defs as Record<string, Schema>) : {};
  const visit = (s: unknown, segs: readonly string[], seen: ReadonlySet<string>): void => {
    if (!plain(s)) return;
    const ref = typeof s.$ref === "string" ? REF.exec(s.$ref) : null;
    if (ref && !seen.has(ref[1]!)) visit(defs[ref[1]!], segs, new Set([...seen, ref[1]!]));
    for (const k of ["oneOf", "anyOf", "allOf"]) if (Array.isArray(s[k])) for (const b of s[k] as unknown[]) visit(b, segs, seen);
    const [head, ...rest] = segs;
    if (head === undefined) return;
    if (head === "*") { visit(s.items, rest, seen); return; }
    if (!rest.length && Array.isArray(s.required)) s.required = (s.required as unknown[]).filter((r) => r !== head);
    if (rest.length && plain(s.properties)) visit((s.properties as Schema)[head], rest, seen);
  };
  for (const e of entries) if (e.max_items === undefined) visit(out, pointerSegments(e.pointer), new Set());
  return out;
}
