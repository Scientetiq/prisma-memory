// Words of the MCP answers in the language of the installation: the @memory/mcp-core catalogue of the setting
// locale.mcp_language, read per call like the tool texts (mcpLanguageOf — English without a row or with an unknown value).
// Every gateway line built with mcp-core (markers, search, read, list, me, error text, refusals of reading by parts) takes
// its words from here, so one answer is in one language and a change of the setting needs no restart.
// The catalogue also carries the marking of instruction-like lines (access.instruction_marking) — read here and only
// here, so the text and the structured answer of one call mark the same way.
import { mcpTexts, type McpTexts } from "@memory/mcp-core";
import { INSTRUCTION_MARKING_SETTING, instructionMarking, type InstructionMarking } from "@memory/shared";
import type { App } from "./context.ts";
import { mcpLanguageOf } from "./instructions.ts";

export type { McpTexts };

/** access.instruction_marking: inline without a row or with an unknown value — the safest reading (never off by a typo). */
export const instructionMarkingOf = (app: Pick<App, "settings">): InstructionMarking =>
  instructionMarking(app.settings.get<unknown>(INSTRUCTION_MARKING_SETTING, "inline"));

/** The catalogue for this installation's answers: English without a row, Russian with locale.mcp_language = ru. */
export const textsOf = (app: Pick<App, "settings">): McpTexts => mcpTexts(mcpLanguageOf(app), instructionMarkingOf(app));
