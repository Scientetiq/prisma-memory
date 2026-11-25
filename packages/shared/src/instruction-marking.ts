// Marking of instruction-like lines of record text in MCP answers: the setting and its safe reading. The modes and
// the words are the @memory/mcp-core catalogue (INSTRUCTION_MARKINGS); settings.ts checks a value with this list.
import { INSTRUCTION_MARKINGS, type InstructionMarking } from "@memory/mcp-core";

export { INSTRUCTION_MARKINGS, type InstructionMarking };
export const INSTRUCTION_MARKING_SETTING = "access.instruction_marking";
/** The mode for a setting value: a known mode as is, anything else (no row, empty, a typo, another type) — `inline`. */
export const instructionMarking = (value: unknown): InstructionMarking =>
  (INSTRUCTION_MARKINGS as readonly unknown[]).includes(value) ? value as InstructionMarking : "inline";
