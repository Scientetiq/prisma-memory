import { MIME_PLAIN, kinds as mimeKinds } from "../messages/mime-plain";
import { text as M } from "../messages/home";
import { derived, derivedList } from "../i18n/runtime";
import type { IconName } from "@/components/icons";
import { ACCESS_ACTION } from "./closed-class";
import type { Connected } from "./connect-agents";
import { EVENT_KIND_TITLES, RECORD_TYPE_TITLES } from "./labels";
import type { OAuthClientKind } from "./oauth-connect";
import { ACCESS_PLAIN, capitalize } from "./plain";
import { PROCESS_STATE, processNowOffer, summarizeStages, type QueueLike, type StageLike } from "./stages";

export const HOME_RECENT_LIMIT = 6;
export const HOME_SPACES_LIMIT = 6;
export const MATERIALS_RECENT_LIMIT = 50;
export const HOME_RECENT_TIMEOUT_MS = 10_000;

export function recentArgs(space: string, limit: number, snippetTokens = 40, o: { types?: readonly string[] } = {}):
  { mode: "recent"; filters: { space: string; types?: string[] }; limit: number; snippet_tokens: number } {
  return { mode: "recent", filters: { space, ...(o.types ? { types: [...o.types] } : {}) }, limit, snippet_tokens: snippetTokens };
}

export const ORG_RECENT_TYPES = ["document", "transcript", "event", "summary", "note"] as const;

export interface RecordState { state: "done" | "busy" | "failed"; label: string; icon: IconName; tone: "green" | "amber" | "red"; detail: string }

export function recordState(stages: readonly StageLike[] | null | undefined, now?: number): RecordState | null {
  const s = summarizeStages(stages, now);
  if (s.state === "empty") return null;
  if (s.state === "done") return { state: "done", label: PROCESS_STATE.done, icon: "circle-check", tone: "green", detail: s.detail };
  if (s.state === "failed") return { state: "failed", label: PROCESS_STATE.failed, icon: "circle-alert", tone: "red", detail: s.detail };
  return { state: "busy", label: PROCESS_STATE.busy, icon: "hourglass", tone: "amber", detail: s.detail };
}

export function canProcessNow(stages: readonly StageLike[] | null | undefined, o: { queue?: QueueLike | null; now?: number } = {}): boolean {
  return processNowOffer(stages, o) !== null;
}

export { ACCESS_PLAIN };
export const accessText = (cls: "open" | "closed"): string => ACCESS_PLAIN[cls];

export const recordKind = (type: string, eventKind?: string | null): string =>
  capitalize((eventKind ? EVENT_KIND_TITLES[eventKind] : null) ?? RECORD_TYPE_TITLES[type] ?? type);

const AGENT_NAMES: Record<OAuthClientKind, string> = derived(() => ({ claude_code: "Claude Code", codex: "Codex", cursor: "Cursor", cloud_other: M.aiAgent }));

export function connectedAgents(connected: readonly Connected[]): string | null {
  const names = [...new Set(connected.map((c) => AGENT_NAMES[c.kind] ?? M.aiAgent))];
  if (!names.length) return null;
  if (names.length === 1) return M.isConnected(names[0]);
  if (names.length === 2) return M.andAreConnected(names[0], names[1]);
  return M.andMoreAreConnected(names[0], names.length - 1);
}

const FORMAT_WORDS: Record<string, string> = derived(() => ({
  [MIME_PLAIN["application/msword"]!]: "Word", [MIME_PLAIN["application/vnd.ms-excel"]!]: "Excel", [MIME_PLAIN["application/vnd.ms-powerpoint"]!]: "PowerPoint", PDF: "PDF",
  [MIME_PLAIN["application/rtf"]!]: "Word", [MIME_PLAIN["application/vnd.oasis.opendocument.text"]!]: "Word", [MIME_PLAIN["application/vnd.oasis.opendocument.presentation"]!]: "PowerPoint", [MIME_PLAIN["application/vnd.oasis.opendocument.spreadsheet"]!]: "Excel", [MIME_PLAIN["text/csv"]!]: "Excel",
  [MIME_PLAIN["text/markdown"]!]: M.text, [mimeKinds.text]: M.text, [mimeKinds.image]: M.images,
}));
const FORMAT_ORDER = derivedList(() => (["Word", "Excel", "PowerPoint", "PDF", M.text, M.images]));
export function formatsLine(accepted: readonly string[], maxBytes: number): string {
  const words = [...new Set(accepted.map((a) => FORMAT_WORDS[a] ?? a))]
    .sort((a, b) => (FORMAT_ORDER.indexOf(a) + 1 || 99) - (FORMAT_ORDER.indexOf(b) + 1 || 99));
  return M.upToMb(words.join(", "), Math.round(maxBytes / 1048576));
}

export interface LeadSpace { name: string; personal: boolean; defaultClass: "open" | "closed"; org?: boolean }

export function materialsLead(t: LeadSpace | null): string { return M.materialsLead(t, ACCESS_ACTION.show); }

export { HOME_TEXT } from "../messages/home";
