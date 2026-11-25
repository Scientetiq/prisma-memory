import { productName } from "../i18n/brand";
import { MEMBER_ROLE_PLAIN, PICK_ROLE_TITLES } from "../messages/project-people";
import { projectPeople as M } from "../messages/project-people";
import type { ConfirmSpec } from "@/components/confirm-dialog";
import { formatDay } from "./plain";
import type { MeSpace, MySpace, MySpaceMember } from "./types";

export { MEMBER_ROLE_PLAIN } from "../messages/project-people";

export type PickRole = "member" | "reader";
export { PICK_ROLE_TITLES } from "../messages/project-people";


export const peopleCount = (n: number): string => M.people(n);


export function whoSees(s: Pick<MySpace, "kind" | "default_class" | "org_unit"> & { members_count?: number | null }, fallback: string): string {
  const n = s.members_count;
  if (s.kind === "personal" || s.kind === "org") return fallback;
  if (s.org_unit) return n ? M.departmentPeople(n) : fallback;
  if (!n) return fallback;
  return M.visiblePeople(n, s.default_class === "open");
}

export function placeOf(kind: string | null | undefined, name: string): string {
  return kind === "project" ? M.inProject(name) : kind === "team" ? M.inTeam(name) : M.in(name);
}
export function placeTo(kind: string | null | undefined, name: string): string {
  return kind === "project" ? M.toProject(name) : kind === "team" ? M.toTeam(name) : M.to(name);
}

export function memberBasis(m: Pick<MySpaceMember, "source" | "groups" | "expires_at">): string {
  const groups = (m.groups ?? []).map((g) => M.quote(g)).join(", ");
  const base = m.source === "group" ? (groups ? M.throughGroup(groups) : M.throughAColleagueGroup)
    : m.source === "org" ? M.throughTheDepartment
    : m.source === "grant" ? M.assignedByAnAdministrator
    : groups ? M.invitedByYouAlsoInGroupLeaving(groups) : M.invitedByYou;
  return m.expires_at ? M.until(base, formatDay(m.expires_at)) : base;
}

export const removable = (m: Pick<MySpaceMember, "source" | "role">, self: boolean): boolean => m.source === "manual" && m.role !== "owner" && !self;

export const roleSwitchable = (m: Pick<MySpaceMember, "source" | "role">, self: boolean): boolean => removable(m, self);


export function roleChangeConfirm(name: string, to: PickRole, kind: string | null | undefined, archived = false): ConfirmSpec {
  const of = kind === "project" ? M.ofTheProject : kind === "team" ? M.ofTheTeam : M.ofTheSpace;
  const into = kind === "project" ? M.toTheProject : kind === "team" ? M.toTheTeam : M.toTheSpace;
  const noun = kind === "project" ? M.project : kind === "team" ? M.team : M.space;
  const undo = archived && to === "reader"
    ? M.whileTheIsArchivedNoAddingRecords(noun)
    : M.yesUseChangeRoleAgainInThis;
  return to === "reader"
    ? { question: M.changeRoleReadOnly(name), verb: M.changeRole2, undo,
        change: M.canCurrentlyAddRecordsTheirNewRole(name, of),
        who: M.membersWillSeeTheNewRoleOn(of) }
    : { question: M.changeRoleCanAddRecords(name), verb: M.changeRole3, undo,
        change: M.currentlyHasReadOnlyAccessTheirNew(name, into),
        who: M.membersWillSeeEverythingAddsAndThe(name, of) };
}


export function callResult(r: { status: "added" | "already" | "invited"; role: string; expires_at?: string }, who: string, kind: string | null | undefined, name: string): { message: string; lines: string[] } {
  const rights = r.role === "reader" ? M.readOnlyCanReadRecordsButCannot : r.role === "owner" ? M.thisPersonIsTheOwner : M.canAddRecordsCanReadAndAdd;
  if (r.status === "invited")
    return { message: M.willJoinOnTheirFirstSignIn(who, placeTo(kind, name), productName()), lines: [rights, M.theInvitationWaitsItExpiresAutomaticallyIf(r.expires_at ? M.until2(formatDay(r.expires_at)) : M.count3Months)] };
  if (r.status === "already") return { message: M.isAlready(who, placeOf(kind, name)), lines: [rights] };
  return { message: M.isNow(who, placeOf(kind, name)), lines: [rights] };
}

export function faces<T>(xs: readonly T[], max = 8): { shown: T[]; more: number } {
  return { shown: xs.slice(0, max), more: Math.max(0, xs.length - max) };
}

export const membersVisible = (s: Pick<MeSpace, "kind">): boolean => s.kind === "project" || s.kind === "team";

export { projectPeople as PROJECT_PEOPLE_MESSAGES } from "../messages/project-people";
