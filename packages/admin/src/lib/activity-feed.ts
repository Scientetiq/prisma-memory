import { text as M } from "../messages/activity-feed";
import { derivedList, derived } from "../i18n/runtime";
import { AUDIT_ACTION_TITLES, CLAIMED_KIND_TITLES, MY_AUDIT_TITLES, OPEN_REFUSED_TITLES, RECORD_TYPE_TITLES } from "./labels";
import { capitalize } from "./plain";
import type { MyAuditEvent } from "./types";

export type FeedView = "main" | "agents" | "me" | "all";
export const FEED_VIEWS: ReadonlyArray<{ id: FeedView; title: string }> = derivedList(() => ([
  { id: "main", title: M.highlights }, { id: "agents", title: M.agents }, { id: "me", title: M.me }, { id: "all", title: M.all },
]));
export const DEFAULT_FEED_VIEW: FeedView = "main";
export const FEED_TYPES: ReadonlyArray<{ id: string; title: string }> = derivedList(() => ([
  { id: "write", title: M.records }, { id: "search", title: M.search }, { id: "forget", title: M.deletions }, { id: "rate_limited,auth_failure", title: M.errors },
]));

export function feedView(view: string, auto = ""): FeedView {
  if (FEED_VIEWS.some((v) => v.id === view)) return view as FeedView;
  return auto === "1" ? "all" : DEFAULT_FEED_VIEW;
}
export function feedType(type: string, known: readonly string[]): string {
  if (FEED_TYPES.some((t) => t.id === type)) return type;
  return known.includes(type) ? type : "";
}

/** The gateway's `actor` label of the caller themself. */
const SELF_ACTOR = "me";
const ON_MY_BEHALF = / on my behalf$/u;
/** The gateway's fixed `actor` labels → the interface language. */
const ACTOR_TEXT: Readonly<Record<string, () => string>> = {
  memory: () => M.actorMemory, administrator: () => M.actorAdministrator, "“Company knowledge” curator": () => M.actorOrgCurator,
  "a colleague": () => M.actorColleague, "a meeting participant": () => M.actorMeetingParticipant, "the space owner": () => M.actorSpaceOwner,
  "a space member": () => M.actorSpaceMember, "colleague (suggestion)": () => M.actorColleagueProposal,
};

/** Who acted, in the interface language: a service — "<name> on your behalf"; a fixed label — from the catalogue; else as sent. */
function actorText(actor: string): string {
  if (ON_MY_BEHALF.test(actor)) {
    const name = actor.replace(ON_MY_BEHALF, "").trim();
    return `${name && name !== "service" ? capitalize(name) : M.actorService} ${M.onYourBehalf}`;
  }
  return ACTOR_TEXT[actor]?.() ?? capitalize(actor);
}

/** Who acted, in words with a capital letter: the agent key's label instead of "me". */
export function feedWho(a: Pick<MyAuditEvent, "via" | "actor" | "client_label" | "client">): string {
  const agent = (): string => a.client_label?.trim() || (a.client?.kind && a.client.kind !== "transport" && a.client.kind !== "internal" ? CLAIMED_KIND_TITLES[a.client.kind] : "") || M.yourAgent;
  switch (a.via) {
    case "workplace": return M.you;
    case "agent": return agent();
    case "service": return actorText(a.actor);
    // a "View as" preview is the administrator, although the key is yours
    case "system": return a.actor === SELF_ACTOR ? M.administratorInViewAsMode : actorText(a.actor);
    case "other_person": return actorText(a.actor);
    default:
      return a.actor === SELF_ACTOR ? (a.client_label?.trim() || M.you) : actorText(a.actor);
  }
}

import { FEED_EVENT } from "../messages/activity-feed";

const joinReasons = (r: readonly string[]): string => (r.length > 1 ? M.and(r.slice(0, -1).join(", "), r[r.length - 1]) : r[0] ?? "");

export function feedWhat(a: Pick<MyAuditEvent, "event_type" | "action" | "refusal" | "reasons">): string {
  if (a.action === "open_refused" && a.refusal && OPEN_REFUSED_TITLES[a.refusal]) return OPEN_REFUSED_TITLES[a.refusal]!;
  if (a.action === "open_check_fallback" && a.reasons?.length) return M.fileSavedAgentsCannotSeeIt(joinReasons(a.reasons));
  if (a.action && AUDIT_ACTION_TITLES[a.action]) return AUDIT_ACTION_TITLES[a.action]!;
  return FEED_EVENT[a.event_type] ?? MY_AUDIT_TITLES[a.event_type] ?? a.event_type;
}

export const feedFailed = (a: Pick<MyAuditEvent, "event_type">): boolean => a.event_type === "auth_failure" || a.event_type === "rate_limited";

export const TITLES_SHOWN = 5;
export interface FeedRecords {
  shown: Array<{ id: string; kind: string; title: string }>;
  gone: number;
  more: number;
  count: number | null;
}

export function feedRecords(a: Pick<MyAuditEvent, "record_ids" | "records">): FeedRecords | null {
  const ids = a.record_ids ?? [];
  if (!ids.length) return null;
  if (!a.records) return { shown: [], gone: 0, more: 0, count: ids.length };
  const first = ids.slice(0, TITLES_SHOWN);
  const byId = new Map(a.records.map((r) => [r.id, r]));
  const shown = first.flatMap((id) => {
    const r = byId.get(id);
    return r ? [{ id: r.id, kind: RECORD_TYPE_TITLES[r.type] ?? M.record, title: r.title?.trim() || M.untitled }] : [];
  });
  return { shown, gone: first.length - shown.length, more: Math.max(0, ids.length - TITLES_SHOWN), count: null };
}

export function moreText(n: number): string { return M.moreRecords(n); }

export function goneText(n: number): string { return M.goneRecords(n); }

export { REFUSED_TOOL_PLAIN };
import { REFUSED_TOOL_PLAIN } from "../messages/activity-feed";

export function refusedWhat(a: Pick<MyAuditEvent, "tool" | "via">): string {
  if (a.tool) return REFUSED_TOOL_PLAIN[a.tool] ?? M.agentRequest;
  return a.via === "workplace" ? M.workspaceAction : a.via === "service" ? M.serviceRequest : M.agentRequest;
}

export interface FeedEntry { a: MyAuditEvent; repeat: number; since: string }

const repeatKey = (a: MyAuditEvent): string | null =>
  a.event_type === "rate_limited" ? JSON.stringify([a.via ?? "", a.actor, a.client_label ?? "", a.tool ?? "", a.action ?? "", a.auto ? 1 : 0]) : null;

export function groupRepeats(items: readonly MyAuditEvent[]): FeedEntry[] {
  const out: FeedEntry[] = [];
  let lastKey: string | null = null;
  for (const a of items) {
    const key = repeatKey(a), prev = out[out.length - 1];
    if (key !== null && key === lastKey && prev) { prev.repeat += 1; prev.since = a.at; continue; }
    out.push({ a, repeat: 1, since: a.at });
    lastKey = key;
  }
  return out;
}

export function feedEntries(items: readonly MyAuditEvent[], view: FeedView): FeedEntry[] {
  return view === "main" ? groupRepeats(items) : items.map((a) => ({ a, repeat: 1, since: a.at }));
}

export function shownText(rows: number, actions: number): string {
  return rows === actions ? M.shown(actions) : M.actionsRows(actions, rows);
}

export function spanText(fromIso: string, toIso: string): string {
  const sec = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000));
  if (!Number.isFinite(sec) || sec < 60) return M.inOneMinute;
  const min = Math.round(sec / 60);
  if (min < 60) return M.minutesSpan(min);
  const h = Math.round(min / 60);
  if (h < 48) return M.hoursSpan(h);
  const d = Math.round(h / 24);
  return M.daysSpan(d);
}

export function repeatText(e: Pick<FeedEntry, "repeat" | "since" | "a">): string { return M.repeats(e.repeat, spanText(e.since, e.a.at)); }
