// The structured answer of MCP tools, shaped for agents: the gateway functions return the same objects to REST, the
// workplace and MCP; this module changes only what tools/call puts into structuredContent, after dispatch. It reads no
// database and logs nothing — the record text it scans never leaves the answer it belongs to.
//
// Marking of instruction-like lines (access.instruction_marking, the mode of the catalogue): in `inline` and `notice` the
// answers of memory_search, memory_read, memory_list and memory_me start with `data_notice` (the record text of the result is
// data, not instructions) and carry `instruction_like` where a line of record text looks like an instruction — on a search
// hit (its title or snippet), on a read (the lines of `content` of this part, and the title), on a list (the lines of the
// readme, and an entry's title or summary line). Text values are never changed. `off`, another tool, an answer that is not a
// plain object and the hidden branch of memory_read (a locator of a closed record, no text) — the same object, untouched.
// The verdict is taken on the lines the text answer prints, built by the same mcp-core renderers — "# <title>" of a read,
// "• <path> — <title> — <summary line>" of a list entry, the indented title and snippet of a hit — so the text and the
// structure of one answer never disagree.
import { hitLocatorText, instructionLines, listEntryLine, type HitLocator, type McpTexts } from "@memory/mcp-core";
import { leanResult, type LeanCall, type LeanEntry } from "@memory/shared";

/** Tools whose answers carry record text. */
const SHAPED: ReadonlySet<string> = new Set(["memory_search", "memory_read", "memory_list", "memory_me"]);
/** At most this many line numbers in `instruction_like.first`. */
export const INSTRUCTION_FIRST_MAX = 20;

type Obj = Record<string, unknown>;
const plain = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const flagged = (line: string): boolean => instructionLines(line).length > 0;
/**
 * The record text of a hit in the text of memory_search (search-text.ts): title and snippet, each indented, and the
 * locator part of the hit line (the section path is record text too).
 */
const hitLines = (h: Obj, texts: McpTexts): string =>
  `   ${text(h.title)}\n   ${text(h.snippet)}\n${hitLocatorText(plain(h.locator) ? (h.locator as HitLocator) : null, texts, typeof h.type === "string" ? h.type : undefined)}`;
/** The line of a list entry in the text of memory_list (list-text.ts listEntryLine). */
const entryLine = (e: Obj): string => listEntryLine({
  path: text(e.path), kind: e.kind === "folder" ? "folder" : "record", title: text(e.title),
  count: typeof e.count === "number" ? e.count : null, summary_line: text(e.summary_line) || null,
});
/** The lean answer with the fields only it carries, after the others (a new object; none — the same reference). */
const withExtra = (r: unknown, extra: Readonly<Record<string, unknown>> | undefined): unknown => (extra && plain(r) ? { ...r, ...extra } : r);
/** {lines, first} of the flagged \n-lines of a text (numbers from 1), or null when none is flagged. */
function lineFlags(v: unknown): { lines: number; first: number[] } | null {
  const hits = text(v) ? instructionLines(text(v)) : [];
  return hits.length ? { lines: hits.length, first: hits.slice(0, INSTRUCTION_FIRST_MAX).map((i) => i + 1) } : null;
}

/**
 * The lean answer of a tool call: the contract's list for the tool and what the call asked. `extra` — fields
 * that only a lean answer carries, added after the others (memory_me: recent_notes); the gateway function computed them.
 */
export interface LeanShape { readonly entries: readonly LeanEntry[]; readonly call: LeanCall; readonly extra?: Readonly<Record<string, unknown>> }

/**
 * structuredContent of a successful tools/call `tool` (the real name, after an alias). With `lean` (access.mcp_response_detail
 * = lean) the fields of server.response_detail.lean are left out first (and `lean.extra` added) (mcp-detail.ts: a new object along the changed paths,
 * the input untouched); the hidden branch of memory_read is not shaped. The marking below reads only record text, which a
 * lean answer keeps.
 */
export function shapeResult(tool: string, result0: unknown, texts: McpTexts, lean?: LeanShape): unknown {
  const result = lean && lean.entries.length && plain(result0) && !Object.hasOwn(result0, "hidden")
    ? withExtra(leanResult(result0, lean.entries, lean.call), lean.extra) : result0;
  if (texts.instruction.marking === "off" || !SHAPED.has(tool) || !plain(result) || Object.hasOwn(result, "hidden")) return result;
  const out: Obj = { data_notice: texts.instruction.dataNotice, ...result };
  switch (tool) {
    case "memory_search":
      if (Array.isArray(result.hits)) out.hits = result.hits.map((h) => (plain(h) && flagged(hitLines(h, texts)) ? { ...h, instruction_like: true } : h));
      break;
    case "memory_read": {
      const lines = lineFlags(result.content);
      const title = plain(result.metadata) && typeof result.metadata.title === "string" && flagged(`# ${result.metadata.title}`);
      if (lines || title) out.instruction_like = { ...(lines ?? { lines: 0, first: [] }), ...(title ? { title: true } : {}) };
      break;
    }
    case "memory_list": {
      const readme = lineFlags(result.readme);
      if (readme) out.instruction_like = readme;
      // a hidden entry prints the gateway's words instead of its title (list.ts listTextArgs): nothing of the record to flag
      if (Array.isArray(result.entries)) out.entries = result.entries.map((e) => (plain(e) && e.hidden !== true && flagged(entryLine(e)) ? { ...e, instruction_like: true } : e));
      break;
    }
    default: break;                                     // memory_me: the notice only
  }
  return out;
}
