import { pyDivmod, pyRstrip } from "./pytext.ts";

export interface RenderableEvent {
  kind: string;
  title: string;
  statement: string;
  quote: string;
  timeFrom: number | null;
  rationale?: string | null;
  alternatives?: readonly string[] | null;
  due?: string | null;
  actors?: readonly string[] | null;
  actorsRole?: string | null;
}

// The same words as the reference implementation of the renderer.
const EVENT_KINDS: Readonly<Record<string, string>> = Object.freeze({
  decision: "Decision", action: "Action", question_risk: "Question / risk", fact: "Fact",
});

const pad2 = (n: number): string => String(n).padStart(2, "0");

export function eventTimeLabel(sec: number): string {
  const [m, s] = pyDivmod(sec, 60); // int(sec // 60), int(sec % 60)
  const seconds = Math.trunc(s);
  const [hours, minutes] = pyDivmod(Math.trunc(m), 60); // divmod(minutes, 60)
  return hours ? `${hours}:${pad2(minutes)}:${pad2(seconds)}` : `${pad2(minutes)}:${pad2(seconds)}`;
}

/**
 * Label of the people of an event: with `actors_role: assignee` in the prompt header — "Who does it" (action), "Who decided"
 * (decision), "Who said it" (other); without it — "Participants" (the speakers).
 */
export function actorsLabel(kind: string | null | undefined, actorsRole?: string | null): string {
  if (actorsRole !== "assignee") return "Participants";
  return kind === "decision" ? "Who decided" : kind === "action" ? "Who does it" : "Who said it";
}

export function renderEvent(ev: RenderableEvent): string {
  const kindLabel = Object.hasOwn(EVENT_KINDS, ev.kind) ? EVENT_KINDS[ev.kind] : ev.kind;
  const lines: string[] = [`# ${ev.title}`, "", `**${kindLabel}.** ${ev.statement}`, ""];
  const label = ev.timeFrom !== null && ev.timeFrom !== undefined ? ` (${eventTimeLabel(ev.timeFrom)})` : "";
  lines.push(`> ${ev.quote}${label}`, "");
  if (ev.rationale) lines.push(`Rationale: ${ev.rationale}`, "");
  if (ev.alternatives && ev.alternatives.length) lines.push("Rejected alternatives: " + ev.alternatives.join("; "), "");
  if (ev.due) lines.push(`Due date: ${ev.due}`, "");
  if (ev.actors && ev.actors.length) lines.push(`${actorsLabel(ev.kind, ev.actorsRole)}: ` + ev.actors.join(", "), "");
  return pyRstrip(lines.join("\n")) + "\n";
}
