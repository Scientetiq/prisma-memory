// "What my agent sees": the answer of GET /api/v1/me/agent-view and the
// pure rules of the page — how the hidden records split into what can be done about them, what the bulk button offers, the
// words of a space and of a default. No gateway calls here: the page and the actions call meGw.
import { avText, countOf, type AgentViewMessage } from "./agent-view.messages";

export const AGENT_VIEW_PATH = "/api/v1/me/agent-view";
export const UPLOAD_DEFAULT_PATH = "/api/v1/me/upload-default";
export const OPEN_PLAN_PATH = "/api/v1/me/agent-view/open-plan";
export const AGENT_VIEW_HREF = "/agent-view";

export type AgentViewPart = "visible" | "hidden" | "held_by_check" | "meetings" | "bulk_open";
export interface AgentViewSpace { slug: string; name: string; kind: string; default_class: "open" | "closed"; archived: boolean; open: number | null; hidden_mine: number | null }
export interface UploadDefault { value: "open" | "closed"; personal: "open" | "closed" | null; instance_default: "open" | "closed"; choice_allowed: boolean; open_check_enabled: boolean }
export interface AgentView {
  visible: number | null; hidden_mine: number | null; meetings_with_me: number | null;
  spaces: AgentViewSpace[];
  hidden_mine_by_type: Record<string, number>;
  hidden_mine_by_state: { can_open_in_bulk: number | null; held_by_check: number | null; meetings: number | null };
  upload_default: UploadDefault;
  bulk_open: { enabled: boolean; eligible: number | null; max_items: number };
  incomplete: AgentViewPart[];
}
/** POST open-plan: status pending — the plan is made (plan_id); empty — nothing to plan. */
export interface OpenPlanCreated { status: "pending" | "empty"; eligible_total: number; plan_id?: string }

/**
 * The person's hidden records split by what can be done: shown in bulk, kept hidden by the check, meetings (they stay with their
 * participants) and the rest — one by one. The parts come from different reads; "other" is what is left and never negative.
 */
export function hiddenGroups(v: AgentView): { bulk: number; held: number; meetings: number; other: number } {
  const bulk = v.hidden_mine_by_state.can_open_in_bulk ?? 0, held = v.hidden_mine_by_state.held_by_check ?? 0, meetings = v.hidden_mine_by_state.meetings ?? 0;
  return { bulk, held, meetings, other: v.hidden_mine === null ? 0 : Math.max(0, v.hidden_mine - bulk - held - meetings) };
}

/** The bulk button: shown when the gateway allows bulk open and something is eligible; one plan takes at most max_items. */
export function bulkOffer(v: AgentView): { show: boolean; count: number; more: boolean; off: null | "admin" | "check" } {
  const eligible = v.bulk_open.eligible ?? 0;
  const off = v.bulk_open.enabled ? null : v.upload_default.open_check_enabled ? "admin" : "check";
  return { show: !off && eligible > 0, count: Math.min(eligible, v.bulk_open.max_items), more: eligible > v.bulk_open.max_items, off };
}

/** The overview step: the agent sees nothing while the person has hidden records (unknown numbers change nothing). */
export const zeroForAgent = (v: Pick<AgentView, "visible" | "hidden_mine">): boolean => v.visible === 0 && (v.hidden_mine ?? 0) > 0;

const KIND: Record<string, AgentViewMessage> = { personal: "kind_personal", team: "kind_team", project: "kind_project", org: "kind_org" };
/** The kind of a space in words; an unknown kind — as the gateway sent it. */
export const spaceKindTitle = (kind: string): string => (Object.hasOwn(KIND, kind) ? avText(KIND[kind]!) : kind);
/** A class in words: hidden from agents / visible to agents. */
export const classTitle = (cls: "open" | "closed"): string => avText(cls === "open" ? "class_open" : "class_closed");
/** A default for new records in words, as the radio says it. */
export const defaultTitle = (value: "open" | "closed"): string => value === "open" ? avText("default_visible").toLowerCase() : avText("default_hidden").toLowerCase();

/** Form value of the radio → the PUT value; undefined — not one of the options. */
export function parseDefaultChoice(raw: FormDataEntryValue | null): "open" | "closed" | null | undefined {
  if (raw === "open" || raw === "closed") return raw;
  if (raw === "default") return null;
  return undefined;
}
/** The checked radio: a stored choice, otherwise "the administrator's default". */
export const checkedChoice = (d: UploadDefault): "open" | "closed" | "default" => d.personal ?? "default";

const PART: Record<AgentViewPart, AgentViewMessage> = {
  visible: "part_visible", hidden: "part_hidden", held_by_check: "part_held_by_check", meetings: "part_meetings", bulk_open: "part_bulk_open",
};
/** The incomplete parts in words, in the order of the answer; an unknown part is skipped. */
export const incompleteText = (parts: readonly string[]): string | null => {
  const words = parts.filter((p): p is AgentViewPart => Object.hasOwn(PART, p)).map((p) => avText(PART[p]));
  return words.length ? avText("incomplete", { parts: words.join(", ") }) : null;
};

/** "1 record" / "3 records". */
export const records = (n: number): string => countOf(n, "record");
/** One line of the plan preview: who will be able to read the plan's records in this space. */
export function readersLine(s: { name: string; kind: string; records: number; readers: { kind: "self" | "list" | "all"; count: number | null } }): string {
  const base = { space: s.kind === "personal" ? avText("kind_personal") : s.name, records: records(s.records) };
  if (s.readers.kind === "self") return avText("plan_readers_self", base);
  if (s.readers.kind === "all" || s.readers.count === null) return avText("plan_readers_all", base);
  return avText("plan_readers_list", { ...base, people: countOf(s.readers.count, "person") });
}
