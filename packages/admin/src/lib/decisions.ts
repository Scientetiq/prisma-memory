import { text as M } from "../messages/decisions";
import { derivedList } from "../i18n/runtime";
import { formatDay } from "./plain";

export { dueLooksPast, DUE_CHECK_COPY } from "./due-check";

export interface MeetingDecision {
  id: string; event_kind: string | null; title: string | null; due: string | null; actors: string[];
  actors_role: "assignee" | "speaker"; time_from: number | null;
}
export interface MeetingDecisions { items: MeetingDecision[] }

export const DECISION_GROUPS = derivedList(() => ([
  { kind: "decision", title: M.decisions },
  { kind: "action", title: M.tasks },
  { kind: "question_risk", title: M.risksAndQuestions },
  { kind: "fact", title: M.facts },
] as const));
export const DECISIONS_VISIBLE = 5;

export interface DecisionGroup<T> { kind: string; title: string; items: T[]; collapsed: boolean }

export function groupDecisions<T extends { event_kind?: string | null }>(items: readonly T[]): Array<DecisionGroup<T>> {
  const known = new Set<string>(DECISION_GROUPS.map((g) => g.kind));
  const out: Array<DecisionGroup<T>> = DECISION_GROUPS.map((g) => ({ kind: g.kind, title: g.title, items: items.filter((d) => d.event_kind === g.kind), collapsed: g.kind === "fact" }));
  out.push({ kind: "other", title: M.other, items: items.filter((d) => !known.has(d.event_kind ?? "")), collapsed: false });
  return out.filter((g) => g.items.length);
}

export function actorsLabel(kind: string | null | undefined, role: MeetingDecision["actors_role"] | null | undefined): string | null {
  if (role !== "assignee") return null;
  return kind === "decision" ? M.whoDecided : kind === "action" ? M.whoDoesIt : M.whoSaidIt;
}

export const dueText = (due: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(due) ? formatDay(due) : due.trim());

