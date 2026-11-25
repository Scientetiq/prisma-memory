// Hints of tool refusals. Since 0.25.0 a tool description says what an agent needs in every session; the refusal
// rules it carried before stay word for word in server.help.<tool> and move to where they fire — the error itself. Most
// refusals already say what to do (their own `hint` or message); this table gives one to those that do not, by
// (tool, code, details.gate | details.reason). It is applied to MCP tool answers only (toolErrorResult): REST and the
// workplace keep the error bodies as the handlers build them, and an error that has a hint of its own keeps it.
import type { ErrorBody, ErrorCode, TextLanguage } from "@memory/mcp-core";
import { TOOL_HINTS_RU } from "./mcp-hints/ru.ts";

export interface ToolHint {
  /** The tool whose refusal gets the hint (the real tool: a dispatcher action runs under it). */
  readonly tool: string;
  readonly code: ErrorCode;
  /** details.gate / details.reason the refusal must carry; none — every refusal of this code and tool without a hint. */
  readonly when?: { readonly gate?: string; readonly reason?: string };
  /** The sentence of server.help.<tool> (English) that the short description no longer says: the rule this row carries. */
  readonly removed: string;
  readonly hint: Readonly<Record<TextLanguage, string>>;
  /**
   * A hint that names a link of the refusal: `field` of details carries it, `without` is said instead when the refusal has
   * no link there (access.workplace_url is empty — the seed default — and the handler gives null), so the hint never
   * promises a link the answer does not carry.
   */
  readonly link?: { readonly field: string; readonly without: Readonly<Record<TextLanguage, string>> };
}

export const TOOL_HINTS: readonly ToolHint[] = [
  {
    tool: "memory_remember", code: "forbidden", when: { reason: "profile_disabled" },
    removed: "The profile is turned off by an administrator — `forbidden`, `details.reason: profile_disabled`",
    hint: { en: "Tell the person: the memory administrator has turned the work profile off, so it cannot be written now.",
            ru: TOOL_HINTS_RU.profile_disabled },
  },
  {
    tool: "memory_remember", code: "forbidden", when: { reason: "profile_hidden" },
    removed: "hidden from agents by the person — `forbidden`, `profile_hidden`: it can be changed only in the workplace",
    hint: { en: "Tell the person: the profile is hidden from agents, only they can change it, in the workplace.",
            ru: TOOL_HINTS_RU.profile_hidden },
  },
  {
    tool: "memory_remember", code: "invalid_argument", when: { reason: "profile_private_content" },
    removed: "refusal `profile_private_content` with the section and the word: restate it to the person",
    hint: { en: "Restate this refusal to the person: such text is not written to the work profile.",
            ru: TOOL_HINTS_RU.profile_private_content },
  },
  {
    tool: "memory_open", code: "in_progress",
    removed: "`in_progress` with `retry_after` and no move: repeat later",
    hint: { en: "Nothing was opened: repeat the same call after retry_after seconds.",
            ru: TOOL_HINTS_RU.open_in_progress },
  },
  {
    tool: "memory_apply", code: "forbidden", when: { reason: "workplace_only" },
    removed: "forbidden with details.reason: workplace_only and workplace_url: pass the link to the person",
    hint: { en: "Give the person the link (workplace_url): only they apply this plan, in the workplace.",
            ru: TOOL_HINTS_RU.apply_workplace_only },
    link: { field: "workplace_url",
            without: { en: "Tell the person: only they apply this plan, in the workplace (the memory administrator knows its address).",
                       ru: TOOL_HINTS_RU.apply_workplace_only_without_link } },
  },
];

const field = (body: ErrorBody, key: string): unknown => (body.details as Record<string, unknown> | undefined)?.[key];

/** The row of `rows` (the table) for this refusal of `tool`, or null. */
export function toolHintRow(tool: string, body: ErrorBody, rows: readonly ToolHint[] = TOOL_HINTS): ToolHint | null {
  return rows.find((r) => r.tool === tool && r.code === body.code
    && (r.when?.gate === undefined || field(body, "gate") === r.when.gate)
    && (r.when?.reason === undefined || field(body, "reason") === r.when.reason)) ?? null;
}

/**
 * The body an MCP answer carries for a refusal of `tool`: the error's own body; with the table's hint in `language` when
 * the error has none of its own and a row matches. No tool (a refusal of a dispatcher itself) — the body as it is.
 */
export function withToolHint(tool: string | undefined, body: ErrorBody, language: TextLanguage): ErrorBody {
  if (!tool || body.hint) return body;
  const row = toolHintRow(tool, body);
  if (!row) return body;
  const link = row.link ? field(body, row.link.field) : undefined;
  const hint = row.link && !(typeof link === "string" && link.trim()) ? row.link.without : row.hint;
  return { ...body, hint: hint[language] };
}
