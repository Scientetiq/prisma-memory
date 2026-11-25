import { instructionParts } from "./instruction-lines.ts";
import { BREAKS, seen } from "./skeleton.ts";
import { ALL_MARKERS, type McpTexts } from "./texts/index.ts";

const MARKS: ReadonlySet<string> = new Set(ALL_MARKERS.map(seen));

function escapeLine(line: string, marked: readonly number[] = [], prefix = ""): string {
  const parts = line.split(BREAKS);
  let hit = false;
  for (let i = 0; i < parts.length; i += 2) {
    if (MARKS.has(seen(parts[i]!))) { parts[i] = `⟂ ${parts[i]}`; hit = true; }
  }
  for (const i of marked) { parts[i] = `${prefix}${parts[i]}`; hit = true; }
  return hit ? parts.join("") : line;
}

export function asData(text: string, o: { readonly texts: McpTexts }): string {
  const { markers, instruction } = o.texts, lines = text.split("\n");
  const flagged = instruction.marking === "off" ? [] : instructionParts(text);
  if (!flagged.length) return `${markers.begin}\n${lines.map((l) => escapeLine(l)).join("\n")}\n${markers.end}`;
  const marked: ReadonlyMap<number, readonly number[]> = instruction.marking === "inline" ? new Map(flagged) : new Map();
  const body = lines.map((l, i) => escapeLine(l, marked.get(i), instruction.prefix));
  return `${instruction.notice(flagged.length)}\n${markers.begin}\n${body.join("\n")}\n${markers.end}`;
}
