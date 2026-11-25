import { ACCESS_EXPLAIN } from "./plain";
import { VISIBILITY_TEXT as m } from "../messages/visibility";
import type { ReaderSpace, RecordReaders } from "./types";

const people = (n: number): string => m.people(n);
const nameOf = (p: { login: string; display_name: string | null }): string => p.display_name || p.login;
const names = (ps: ReadonlyArray<{ login: string; display_name: string | null }>, more = 0): string =>
  m.moreNames(ps.map(nameOf).join(", "), more);
const cap = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

export function spaceWho(s: ReaderSpace, placement = false): string {
  if (s.kind === "org") return m.company;
  if (s.kind === "personal") return s.name ? m.you : m.personalOther(placement);
  const n = s.members !== null ? ` (${people(s.members)})` : "";
  if (s.kind === "project") return s.name ? m.project(s.name, n) : m.hiddenProject(placement, n);
  return s.name ? m.space(s.name, n) : m.hiddenSpace(placement, n);
}

export interface WhoSees {
  line: string;
  details: string[];
}

export function whoSees(r: RecordReaders, me: string): WhoSees {
  const owner = r.people.find((p) => p.owner) ?? null;
  const iAmOwner = owner?.login === me;
  const others = r.people.filter((p) => p.login !== me);
  const listedOthers = r.people.filter((p) => !p.owner && p.login !== me);
  const personalHome = r.home.kind === "personal";
  const homeGroup = r.audience === "space" && !personalHome ? [r.home] : [];
  const placed = r.audience === "space" ? r.placements : [];
  const group = (s: ReaderSpace, placement = false) => ({ text: spaceWho(s, placement), me: s.kind === "personal" && !!s.name });
  const groups = [...homeGroup.map((s) => group(s)), ...placed.map((s) => group(s, true))];
  const alone = !groups.length && !others.length && !r.people_more;

  let who: string;
  let whyMe: string | null = null;
  if (groups.length) {
    const extra = listedOthers.length || r.people_more
      ? m.extraPeople(r.meeting, names(listedOthers, r.people_more)) : "";
    const meInGroup = [...homeGroup, ...placed].some((s) => s.kind === "org" || s.name !== null);
    const lead: Array<{ text: string; me: boolean }> = [];
    const leadMe = iAmOwner ? personalHome || !meInGroup : !meInGroup;
    if (leadMe) lead.push({ text: m.you, me: true });
    if (!meInGroup && !(iAmOwner && personalHome)) whyMe = iAmOwner
      ? m.whyOwner
      : m.whyListed(r.meeting);
    if (owner && !iAmOwner && (personalHome || r.owner_in_spaces === false)) lead.push({ text: m.owner(nameOf(owner), r.meeting), me: false });
    const all = [...lead, ...groups.filter((g) => !(g.me && leadMe))];
    const parts = all.some((g) => g.me) ? [{ text: m.you, me: true }, ...all.filter((g) => !g.me)] : all;
    who = m.groups(cap(parts.map((g) => g.text).join(", ")), extra);
  } else if (alone) {
    who = m.onlyYou;
  } else if (r.meeting) {
    const rest = listedOthers.length || r.people_more ? names(listedOthers, r.people_more) : "";
    who = iAmOwner || !owner ? m.meetingPeople(iAmOwner, rest)
      : m.meetingOwner(nameOf(owner), rest);
  } else {
    const list = others.map((p) => (p.owner ? m.author(nameOf(p)) : nameOf(p)));
    who = m.listed(list.join(", "), r.people_more);
  }

  const details: string[] = [ACCESS_EXPLAIN[r.class]];
  if (r.meeting) details.push(m.meetingDetail);
  else if (r.audience === "people") details.push(m.peopleDetail);
  else if (r.home.kind === "personal" && !r.placements.length) details.push(m.personalDetail(iAmOwner));
  if (whyMe) details.push(whyMe);
  if (r.pending) details.push(m.pending(r.pending));
  if (r.placements.some((p) => p.name === null && p.kind !== "personal")) details.push(m.placementsDetail);
  if (r.agents === "held") details.push(m.heldDetail(iAmOwner));
  if (r.owner_extended) details.push(m.extendedDetail);
  return { line: m.withAgents(who, r.agents, alone, iAmOwner, !!r.owner_extended), details };
}
