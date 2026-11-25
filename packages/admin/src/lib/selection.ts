import { SELECTION_TEXT } from "../messages/selection";


const HEAD = "Records in which the memory tagged “";
const MEETINGS_HEAD = "Meetings involving “";
const TAIL = "” (those you can read)";
const OLD_HEAD = "Everything related to “";
const OLD_TAIL = "” that you can access";

export function selectionTitle(readme: string | null | undefined): string | null {
  if (!readme) return null;
  for (const [head, tail] of [[HEAD, TAIL], [MEETINGS_HEAD, TAIL], [OLD_HEAD, OLD_TAIL]] as const) {
    if (!readme.startsWith(head)) continue;
    const end = readme.lastIndexOf(tail);
    if (end > head.length) return readme.slice(head.length, end);
  }
  return null;
}

export type SelectionIcon = "user" | "building" | "briefcase" | "layers" | "check" | "link" | "mic";
export type SelectionTone = "brand" | "blue" | "violet" | "gray";
export interface SelectionLook { kind: string; icon: SelectionIcon; tone: SelectionTone }

export const isMeetingsPath = (path: string): boolean => {
  const segs = path.split("/").filter(Boolean);
  return segs[0] === "people" && segs.length === 3 && segs[2] === "meetings";
};

export function selectionLook(path: string): SelectionLook {
  const segs = path.split("/").filter(Boolean);
  if (isMeetingsPath(path)) return { kind: SELECTION_TEXT.kinds.meetings, icon: "mic", tone: "brand" };
  if (segs[0] === "people") return { kind: SELECTION_TEXT.kinds.person, icon: "user", tone: "brand" };
  const key = segs[0] === "entities" ? decode(segs[1] ?? "") : "";
  if (key.startsWith("person:")) return { kind: SELECTION_TEXT.kinds.person, icon: "user", tone: "brand" };
  const ext = /^ext:[a-z][a-z0-9_]{1,31}:(company|deal|contact|task):/.exec(key)?.[1];   // ext:<system>:<kind>:<id>
  if (ext === "company") return { kind: SELECTION_TEXT.kinds.company, icon: "building", tone: "blue" };
  if (ext === "deal") return { kind: SELECTION_TEXT.kinds.deal, icon: "briefcase", tone: "blue" };
  if (ext === "contact") return { kind: SELECTION_TEXT.kinds.contact, icon: "user", tone: "blue" };
  if (ext === "task") return { kind: SELECTION_TEXT.kinds.task, icon: "check", tone: "blue" };
  if (key.startsWith("project:")) return { kind: SELECTION_TEXT.kinds.project, icon: "layers", tone: "violet" };
  return { kind: SELECTION_TEXT.kinds.selection, icon: "link", tone: "gray" };
}

function decode(seg: string): string {
  try { return decodeURIComponent(seg); } catch { return seg; }
}

export function selectionFallbackName(path: string): string {
  const segs = path.split("/").filter(Boolean);
  const raw = decode(segs[1] ?? "");
  if (segs[0] === "people") return raw;
  return raw.replace(/^(person|project|ext:[a-z][a-z0-9_]{1,31}:[a-z]+):/, "") || raw;
}

export const selectionCountLine = (name: string, count: number, more: boolean, meetings = false): string =>
  SELECTION_TEXT.count(name, count, more, meetings);

/** Texts of this module that other sections read; one dictionary, so that it can follow the interface language. */
export { SELECTION_TEXT } from "../messages/selection";

export const meetingsBlock = (name: string, count: number): { title: string; line: string; link: string } =>
  ({ title: SELECTION_TEXT.meetingTitle, line: SELECTION_TEXT.meetingLine(name, count), link: SELECTION_TEXT.meetingLink });

export const selectionSearch = (name: string): { href: string; label: string } =>
  ({ href: `/search?q=${encodeURIComponent(name)}`, label: SELECTION_TEXT.search(name) });

export const personSelectionHref = (login: string, from?: string): string =>
  `/browse?path=${encodeURIComponent(`/people/${login}`)}${from ? `&from=${encodeURIComponent(from)}` : ""}`;
