import type { ConfirmSpec } from "../components/confirm-dialog";
import type { IconName } from "../components/icons";
import type { MeSpace } from "./types";
import { formatCount } from "../i18n/format";
import { dates } from "../messages/common";
import { spaceWords, roles, emptySpace, returnResult, handoverText, promote, participants, names as namesText,
  RETURN_PERSONAL, PROMOTE_PLAIN, PERSON_ACCESS_PLAIN, EXTENDED_OPEN_PLAIN } from "../messages/plain";

export { PROCESS_STATE } from "./process-state";
export { STAGES_TEXT, CONVERTER_WAIT_TEXT, converterWaitLine } from "./stages";

/** A count with digit grouping in the current locale (2895: "2 895" in Russian, "2,895" in English). */
export { formatCount };

export function formatDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const month = Number(m[2]);
  // a month outside 1–12 keeps its digits, as before (the date pack has no word for it)
  return month >= 1 && month <= 12 ? dates.dayMonthYear(Number(m[3]), month, m[1]) : `${Number(m[3])} ${m[2]} ${m[1]}`;
}

export function stripPlanRefs(text: string): string {
  const REF = String.raw`(?:D\d+\.\d+(?:[–-]D?\d+\.\d+)?)`;
  const lead = new RegExp(String.raw`^(?:${REF})(?:\s*,\s*${REF})*\s*[;:,.]\s*`);
  const out = text.replace(new RegExp(String.raw`\s*\((?:${REF})(?:\s*,\s*${REF})*\)`, "g"), "");
  return (lead.test(out) ? out.replace(lead, "").replace(/^\p{Ll}/u, (c) => c.toUpperCase()) : out).trim();
}

export function isoWeekDates(code: string): string | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(code.trim());
  if (!m) return null;
  const year = Number(m[1]), week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  const jan4 = Date.UTC(year, 0, 4), dow = (new Date(jan4).getUTCDay() + 6) % 7;
  const monday = new Date(jan4 + ((week - 1) * 7 - dow) * 86_400_000), sunday = new Date(monday.getTime() + 6 * 86_400_000);
  const d1 = monday.getUTCDate(), d2 = sunday.getUTCDate(), m1 = monday.getUTCMonth() + 1, m2 = sunday.getUTCMonth() + 1;
  return m1 === m2 ? dates.dayRange(d1, d2, m2) : dates.spanRange(dates.dayMonth(d1, m1), dates.dayMonth(d2, m2));
}

export { SECTION_TITLES } from "../messages/sections";
export { SECTION_GROUPS } from "../messages/plain";
export { SECTION_HINTS } from "../messages/plain";
export const kindInName = (kind: string, name: string): boolean => {
  const k = kind.trim().toLowerCase(), n = name.trim().toLowerCase();
  return n === k || (n.startsWith(k) && /^[\s·:,—–-]/.test(n.slice(k.length)));
};
export { OVERVIEW_WHAT } from "../messages/plain";

export type SpaceTone = "brand" | "blue" | "violet" | "gray";
export interface SpaceLook { icon: IconName; tone: SpaceTone; kind: string; audience: string }

export function spaceLook(s: Pick<MeSpace, "kind" | "org_unit">): SpaceLook {
  switch (s.kind) {
    case "personal": return { icon: "user", tone: "brand", ...spaceWords.personal };
    case "project": return { icon: "layers", tone: "violet", ...spaceWords.project };
    case "org": return { icon: "globe", tone: "gray", ...spaceWords.org };
    default: return s.org_unit ? { icon: "building", tone: "blue", ...spaceWords.department } : { icon: "users", tone: "blue", ...spaceWords.team };
  }
}

export const SPACE_ORDER: Record<MeSpace["kind"], number> = { personal: 0, team: 1, project: 2, org: 3 };

export const canAdd = (s: Pick<MeSpace, "role">): boolean => s.role === "owner" || s.role === "member";

export function promoteTargetSpaces<S extends Pick<MeSpace, "kind" | "role" | "slug">>(spaces: readonly S[], from: string): S[] {
  return spaces.filter((s) => s.kind !== "personal" && s.slug !== from && (s.kind === "org" || canAdd(s)))
    .sort((a, b) => SPACE_ORDER[a.kind] - SPACE_ORDER[b.kind]);
}

export interface RoleLine { label: string; hint: string }
export function roleLine(s: Pick<MeSpace, "kind" | "role" | "org_unit">): RoleLine {
  if (s.kind === "personal") return { ...roles.personal };
  if (s.kind === "org") return { ...(s.role === "owner" ? roles.curator : s.role === "member" ? roles.orgMember : roles.orgReader) };
  if (s.role === "owner") return { ...(s.org_unit ? roles.departmentOwner : roles.owner) };
  return { ...(s.role === "member" ? roles.member : roles.reader) };
}

export function emptySpaceText(s: Pick<MeSpace, "kind" | "role" | "org_unit" | "default_class">, o: { preview?: boolean } = {}): string { return emptySpace.text(s.kind, canAdd(s), s.default_class === "open", o.preview === true); }

/** Texts of this module that other sections read; one dictionary, so that it can follow the interface language. */
export { PLAIN } from "../messages/plain";

export { RECORD_TYPE_FOLDERS } from "../messages/plain";

export { EVENT_KIND_FOLDERS } from "../messages/plain";

export const spaceName = (spaces: ReadonlyArray<Pick<MeSpace, "slug" | "name">>, slug: string): string =>
  spaces.find((s) => s.slug === slug)?.name ?? slug;



export type Visibility = "open" | "closed" | "unknown";
export const visibilityOf = (cls: string | null | undefined): Visibility => (cls === "open" || cls === "closed" ? cls : "unknown");

export { ACCESS_PLAIN } from "../messages/plain";
export { NEW_RECORDS_TAG } from "../messages/plain";
export { CLASS_CHOICE } from "../messages/plain";
export { CLASS_PLAIN } from "../messages/plain";
export { ACCESS_PAST_PLAIN } from "../messages/plain";
export { MOVING_PLAIN } from "../messages/plain";
export { NOTEBOOK_PLAIN } from "../messages/plain";
export { ACCESS_EXPLAIN } from "../messages/plain";

export { CONNECT_PLAIN } from "../messages/plain";

export { KEYS_PLAIN } from "../messages/plain";

export const capitalize = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

export { RETURN_PERSONAL } from "../messages/plain";

export function returnLines(r: { path: string; class: "open" | "closed"; derived_moved?: number; placements_left?: number; parent_left?: string }, listed = 0): string[] {
  const file = r.path.split("/")[3] === "document";
  const placed = r.placements_left ?? 0;
  return [
    returnResult.visible(listed, file), returnResult.noLonger(file),
    ...(r.class === "open" ? [returnResult.agents] : []),
    ...(r.derived_moved ? [returnResult.derived(r.derived_moved)] : []),
    ...(placed > 0 ? [returnResult.placements(placed)] : []),
    ...(r.parent_left ? [RETURN_PERSONAL.parentLeft] : []),
  ];
}

export { DERIVED_PLAIN } from "../messages/plain";

export { BASED_ON_PLAIN } from "../messages/plain";

export { HANDOVER_PLAIN } from "../messages/plain";

export function handoverDefaultText(statement: string | null, due: string | null): string { return handoverText.defaultText(statement, due); }

export { EXTENDED_OPEN_PLAIN } from "../messages/plain";

export function myKeyOpenWrite(k: { kind: string; open_write?: boolean; revoked_at: string | null; expires_at?: string | null; preview?: boolean }): { line: string; canNarrow: boolean } | null {
  if (k.kind !== "extended") return null;
  const on = k.open_write === true;
  const live = !k.revoked_at && !(k.expires_at && Date.parse(k.expires_at) <= Date.now()) && !k.preview;
  return { line: on ? EXTENDED_OPEN_PLAIN.keyMarked : EXTENDED_OPEN_PLAIN.keyDenied, canNarrow: on && live };
}

const ymd = (d: string): [number, number, number] | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

export function dayMonth(date: string): string {
  const p = ymd(date);
  return p ? dates.dayMonth(p[2], p[1]) : date;
}

export function weekSpan(start: string, end: string): string {
  const a = ymd(start), b = ymd(end);
  if (!a || !b) return `${start} – ${end}`;
  if (a[0] !== b[0]) return dates.spanRange(dates.dayMonthYear(a[2], a[1], a[0]), dates.dayMonthYear(b[2], b[1], b[0]));
  if (a[1] !== b[1]) return dates.spanRange(dayMonth(start), dayMonth(end));
  return dates.dayRange(a[2], b[2], b[1]);
}

export function plusDays(date: string, n: number): string {
  const p = ymd(date);
  if (!p) return date;
  return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10);
}

export { PERSON_ACCESS_PLAIN } from "../messages/plain";

export interface PersonAccessLines { self: string; agents: string; viaNone: string | null }

export function personAccessLines(a: { person: { active: boolean }; classes_readable: readonly string[]; closed_via?: readonly unknown[] | null }): PersonAccessLines {
  const P = PERSON_ACCESS_PLAIN;
  if (!a.person.active) return { self: P.inactive, agents: P.inactive, viaNone: (a.closed_via ?? []).length ? null : P.viaNone };
  const closed = a.classes_readable.includes("closed") || (a.closed_via ?? []).length > 0;
  return { self: P.self, agents: closed ? P.agentsClosed : P.agentsOpen, viaNone: (a.closed_via ?? []).length ? null : P.viaNone };
}

export { MEETING_PROMOTE } from "../messages/plain";

export { PROMOTE_PLAIN } from "../messages/plain";

export function promoteAudienceLine(target: Pick<MeSpace, "kind" | "name" | "org_unit"> | null, cls: "open" | "closed"): string { return target ? promote.line(promote.audience(target.kind, target.name, !!target.org_unit, cls)) : promote.empty; }

export function promoteConfirm(target: Pick<MeSpace, "kind" | "name" | "org_unit">, cls: "open" | "closed", meeting = false): ConfirmSpec {
  return {
    question: promote.question(target.name), change: promote.change(meeting),
    who: promote.audience(target.kind, target.name, !!target.org_unit, cls),
    undo: PROMOTE_PLAIN.undo, verb: promote.verb(target.name),
    ...(target.kind === "org" ? { ack: { name: "confirm_org", label: PROMOTE_PLAIN.orgAck } } : {}),
  };
}

export { MEMBER_UNDO_PLAIN } from "../messages/plain";

export function addParticipantConfirm(who: string | null, o: { waiting?: boolean; notify?: boolean } = {}): ConfirmSpec {
  return {
    question: participants.addQuestion(who), who: participants.addWho(o.waiting === true, o.notify === true, who === null),
    undo: participants.addUndo, verb: participants.addVerb, ...(who === null ? { fill: "who" } : {}),
  };
}

export const COMPOSITION_NAMES = 3;

export { MEETING_PEOPLE_PLAIN } from "../messages/plain";

export function leaveMeetingConfirm(versions = false): ConfirmSpec {
  return { question: participants.leaveQuestion, change: participants.leaveChange(versions), who: participants.leaveWho,
    undo: participants.leaveUndo, verb: participants.leaveVerb, danger: true };
}

export function removePendingConfirm(name: string): ConfirmSpec {
  return { question: participants.removeQuestion(name), change: participants.pendingChange, undo: participants.removeUndo, verb: participants.removeVerb };
}

export function removeAskerConfirm(name: string): ConfirmSpec {
  return { question: participants.askerQuestion(name), change: participants.askerChange, undo: participants.askerUndo, verb: participants.askerVerb, danger: true };
}

export { MEETINGS_PLAIN } from "../messages/plain";

export function namesLine(names: string[], others: number): string { return namesText.line(names, others); }

export { mimePlain } from "./mime-plain";

export { CUSTODY_PLAIN } from "../messages/plain";

export { SPACE_README } from "../messages/plain";

export { ADDABLE_PLAIN } from "../messages/plain";

export { PROFILE_PLAIN } from "../messages/plain";


export { OVERVIEW_PLAIN } from "../messages/plain";

export { ENTITY_KIND_WORD } from "../messages/plain";

export { GUIDE_PLAIN } from "../messages/plain";
