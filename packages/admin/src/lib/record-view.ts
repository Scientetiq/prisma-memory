import { text as M } from "../messages/record-view";
import { recordKind } from "./home";
import { formatDay } from "./plain";
import { formatDate, zonedParts } from "../i18n/format";
import { instanceTz } from "../i18n/runtime";
import type { RecordCore, RecordReaders } from "./types";

export interface ParentRef { id: string; type: string; title: string | null; occurred_at: string | null }

export function originText(m: Pick<RecordCore, "source_kind" | "source_ref" | "origin" | "type" | "parent_id">, parent: ParentRef | null): string {
  const fromMeeting = parent ? parent.type === "transcript" : m.type === "summary" || (m.type === "event" && Boolean(m.parent_id));
  switch (m.source_kind) {
    case "pipeline":
      if (m.source_ref?.startsWith("people:")) return M.fromTheColleagueDirectory;
      return fromMeeting ? M.generatedAutomaticallyFromAMeetingPlease : M.generatedAutomaticallyFromADocumentPlease;
    case "transcriber": return M.meetingTranscript;
    case "upload": return M.uploadedAsAFile;
    case "folder": return M.fromADocumentFolder;
    case "export": return M.fromTheSourceSystem;
    case "correction": return m.origin === "human" ? M.correctionBasedOnAPersonS : M.aiAgentCorrection;
    case "agent":
      return m.origin === "human" ? M.writtenByAPerson : m.origin === "model" ? M.generatedAutomaticallyPleaseCheck
        : m.origin === "document" ? M.uploadedByAnAiAgent : M.writtenByAnAiAgent;
    default:
      return m.origin === "model" ? M.generatedAutomaticallyFallback : m.origin === "human" ? M.writtenByAPersonFallback : "—";
  }
}

export function parentLabel(p: ParentRef): string {
  const name = p.title?.trim() || null;
  const day = p.type === "transcript" && p.occurred_at ? dayWords(p.occurred_at) : null;
  return M.parentCaption(p.type, name, day);
}

/** Day and month in words (another year on the same clock: with the year, as Intl writes it), on the clock of the installation or of tz, like meeting deadlines. */
export function dayWords(iso: string, now: Date = new Date(), tz: string = instanceTz()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return formatDay(iso);
  return formatDate(d, zonedParts(d, tz).y === zonedParts(now, tz).y ? { timeZone: tz, day: "numeric", month: "long" } : { timeZone: tz, day: "numeric", month: "long", year: "numeric" });
}

export function recordBack(m: Pick<RecordCore, "type">, parent: ParentRef | null): { href: string; label: string } {
  if (parent && parent.type === "transcript") return { href: `/records/${parent.id}`, label: M.meetingBack(parent.title?.trim() || null) };
  if (m.type === "transcript") return { href: "/meetings", label: M.meetingsWithMe };
  return { href: "/materials", label: M.materialsBack };
}

export function recordTabTitle(m: Pick<RecordCore, "class" | "title" | "type" | "event_kind"> | null, o: { hidden?: boolean } = {}): string {
  if (!m) return M.record;
  if (o.hidden) return M.closedRecord;
  if (m.class !== "open" || m.type === "transcript") return recordKind(m.type, m.event_kind);
  return m.title?.trim().slice(0, 120) || recordKind(m.type, m.event_kind);
}

export function ownerName(owner: string, o: { me: { login: string; display_name?: string | null }; readers?: RecordReaders | null; meetingOwner?: { login: string; display_name: string | null } | null }): string {
  if (owner === o.me.login) return M.you(o.me.display_name?.trim() || owner);
  const known = (o.meetingOwner?.login === owner ? o.meetingOwner.display_name : null) ?? o.readers?.people.find((p) => p.login === owner)?.display_name ?? null;
  return known?.trim() || owner;
}

export function peopleNames(logins: readonly string[] | null | undefined, known: ReadonlyMap<string, string>): { names: string[]; more: number } {
  const names: string[] = [];
  let more = 0;
  for (const l of logins ?? []) {
    const n = known.get(l)?.trim();
    if (n) names.push(n); else more++;
  }
  return { names, more };
}

export const ingestedDiffers = (occurred: string | null | undefined, ingested: string | null | undefined): boolean => {
  const a = Date.parse(occurred ?? ""), b = Date.parse(ingested ?? "");
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) > 60_000;
};

const plainStart = (s: string): string => s.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/^#{1,6}\s.*$/gm, "").replace(/[*_>`#|-]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

export function summaryLineShown(line: string | null | undefined, content: string | null | undefined): string | null {
  const s = line?.trim();
  if (!s) return null;
  const head = s.replace(/[.…]+$/, "").replace(/\s+/g, " ").toLowerCase();
  if (content && plainStart(content.slice(0, 4000)).startsWith(head.slice(0, 120))) return null;
  if (s.length < 159) return s;
  const cut = s.slice(0, s.lastIndexOf(" ") > 80 ? s.lastIndexOf(" ") : s.length).replace(/[,;:.\s—-]+$/, "");
  return `${cut}…`;
}

const FIELD = /^[^:·\n]{1,40}:\s/;
export function profileShown(content: string): string {
  const out: string[] = [];
  for (const line of content.split("\n")) {
    const parts = line.split(" · ");
    if (!parts.every((p) => FIELD.test(p.trim()))) { out.push(line); continue; }
    const kept = parts.filter((p) => !/^[^:]+:\s*—\s*$/.test(p.trim()));
    if (kept.length) out.push(kept.join(" · "));
  }
  return out.join("\n");
}
