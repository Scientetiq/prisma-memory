"use server";
import { actions as M } from "@/messages/ws-projects";
import { refresh } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { endedState } from "@/lib/action-ended";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { CLOSED_CLASS_TEXT } from "@/lib/closed-class";
import { isId, isLogin, isReservedSlug, isSlug, logins, FORM_TEXT, PROJECT_DESCRIPTION_MAX, PROJECT_MEMBERS_MAX, PROJECT_NAME_MAX, PROJECT_README_MAX, text, textLines } from "@/lib/form";
import { ADDABLE_PLAIN, GUIDE_PLAIN, SPACE_README } from "@/lib/plain";
import { callTool, toolErrorMessage } from "@/lib/mcp";
import { PLAN_REASON_TITLES } from "@/lib/plans";
import { ADDABLE_MAX, pickedIds } from "@/lib/space-addable";
import { formSections, guideHref, isProposalId, saveFailText, savedText, tooLongSection } from "@/lib/space-guide";
import { meGw, type MeResult } from "@/lib/me-api";
import { PREVIEW_TEXT } from "@/lib/preview";
import { PICK_ROLE_TITLES } from "@/lib/project-people";
import { CALLED_COOKIE, CREATE_INVITES_MAX } from "@/lib/project-flash";
import type { GroupSyncRun, MySpace, MySpaceCreated, PlanCompose, SpaceCallResult, SpaceGroup, SpaceGroupUnbound, SpaceGuideSaved } from "@/lib/types";
import { actionSession, requestIsHttps, type UserSession } from "@/lib/user-session";

const denyPreview = (s: UserSession): ActionState | null => (s.preview ? failState(PREVIEW_TEXT.previewDenied, { lines: [PREVIEW_TEXT.previewDeniedHint] }) : null);

const refused = (prefix: string, res: Extract<MeResult<unknown>, { ok: false }>): ActionState | Promise<ActionState> =>
  endedState(res) ?? (res.code === "open_check" ? failState(res.message, res.hint ? { lines: [res.hint] } : {}) : failState(`${prefix}: ${res.message}`));

const spacePath = (slug: string): string => `/api/v1/me/spaces/${encodeURIComponent(slug)}`;

function metaProblem(name: string, description: string): string | null {
  if (!name) return M.enterAProjectName;
  if (name.length > PROJECT_NAME_MAX) return M.nameMustBeNoLongerThanCharacters(PROJECT_NAME_MAX);
  if (description.length > PROJECT_DESCRIPTION_MAX) return M.whatToSaveHereMustBeNo(PROJECT_DESCRIPTION_MAX);
  return null;
}

export async function createProjectAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const name = text(formData, "name"), slug = text(formData, "slug").toLowerCase(), description = text(formData, "description");
  const readme = formData.has("readme") ? textLines(formData, "readme") : "";
  const cls = text(formData, "default_class") || "open";
  const members = logins(formData, "members");
  const bad = metaProblem(name, description);
  if (bad) return failState(bad);
  if (readme.length > PROJECT_README_MAX) return failState(SPACE_README.tooLong(PROJECT_README_MAX));
  if (slug && !isSlug(slug)) return failState(M.spaceAddress263LowercaseLatinLetters);
  if (slug && isReservedSlug(slug)) return failState(M.addressIsReservedMeOrgAndAddresses(slug));
  if (cls !== "open" && cls !== "closed") return failState(M.chooseWhetherNewRecordsWillBeOpen);
  if (cls === "open" && formData.get("open_ack") !== "on") return failState(FORM_TEXT.openAckMissing, { lines: [CLOSED_CLASS_TEXT.openSpaceWarning] });
  if (members.length > PROJECT_MEMBERS_MAX) return failState(M.inviteNoMoreThanPeopleWhenCreating(PROJECT_MEMBERS_MAX));
  const notLogins = members.filter((m) => !isLogin(m));
  if (notLogins.length) return failState(M.inviteesContainInvalidEmailAddresses(notLogins.slice(0, 5).join(", ")));

  const res = await meGw<MySpaceCreated>(session.key, "/api/v1/me/spaces", {
    method: "POST",
    body: { name, ...(slug ? { slug } : {}), ...(description ? { description } : {}), ...(readme ? { readme } : {}), default_class: cls, ...(cls === "open" ? { open_ack: true } : {}), ...(members.length ? { members } : {}) },
  });
  if (!res.ok) return refused(M.spaceNotCreated, res);
  const slugOf = res.data.slug, invited: string[] = [], missed: string[] = [];
  for (const login of res.data.members_unknown) {
    if (invited.length + missed.length >= CREATE_INVITES_MAX) { missed.push(login); continue; }
    const r = await meGw<SpaceCallResult>(session.key, `${spacePath(slugOf)}/members`, { method: "POST", body: { login, role: "member" } });
    if (r.ok && r.data.status === "invited") invited.push(login);
    else if (r.ok) res.data.members_added.push(login);
    else missed.push(login);
  }
  const q = new URLSearchParams({ created: "1" });
  if (res.data.members_added.length) q.set("called", String(res.data.members_added.length));
  if (invited.length) q.set("invited", String(invited.length));
  if (missed.length) {
    q.set("missed", String(missed.length));
    (await cookies()).set(CALLED_COOKIE, JSON.stringify({ missed: missed.slice(0, 50) }),
      { httpOnly: true, sameSite: "lax", secure: await requestIsHttps(), path: `/projects/${encodeURIComponent(slugOf)}`, maxAge: 120 });
  }
  redirect(`/projects/${encodeURIComponent(slugOf)}?${q}`);
}

export async function updateProjectAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const space = text(formData, "space"), name = text(formData, "name"), description = text(formData, "description");
  if (!isSlug(space)) return failState(M.noSpace);
  const bad = metaProblem(name, description);
  if (bad) return failState(bad);
  const res = await meGw<MySpace>(session.key, spacePath(space), { method: "PATCH", body: { name, description: description || null } });
  if (!res.ok) return refused(M.notSaved, res);
  refresh();
  return okState(M.nameAndDescriptionSaved, { lines: [M.membersAiAgentsSeeThemWhenStarting] });
}

export async function updateReadmeAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const space = text(formData, "space"), readme = textLines(formData, "readme");
  if (!isSlug(space)) return failState(M.noSpace2);
  if (readme.length > PROJECT_README_MAX) return failState(SPACE_README.tooLong(PROJECT_README_MAX));
  const res = await meGw<MySpace>(session.key, spacePath(space), { method: "PATCH", body: { readme: readme || null } });
  if (!res.ok) return refused(M.descriptionNotSaved, res);
  refresh();
  if (readme && !res.data.readme) return failState(SPACE_README.templateOnly, { lines: [SPACE_README.templateOnlyLine] });
  return okState(res.data.readme ? SPACE_README.saved : SPACE_README.cleared, res.data.readme ? { lines: [SPACE_README.savedLine] } : {});
}

export async function saveGuideAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const space = text(formData, "space"), from = text(formData, "from_proposal").toLowerCase();
  if (!isSlug(space)) return failState(M.noSpace3);
  if (from && !isProposalId(from)) return failState(GUIDE_PLAIN.proposalGone);
  const sections = formSections(formData);
  const long = tooLongSection(sections);
  if (long) return failState(GUIDE_PLAIN.sectionTooLong(GUIDE_PLAIN.sections[long].title), { lines: [GUIDE_PLAIN.keepShort] });
  const res = await meGw<SpaceGuideSaved>(session.key, `${spacePath(space)}/guide`, { method: "PUT", body: { sections, ...(from ? { from_proposal: from } : {}) } });
  if (!res.ok) {
    const ended = endedState(res); if (ended) return ended;
    const t = saveFailText(res);
    return failState(t.message, t.lines.length ? { lines: t.lines } : {});
  }
  const out = savedText(res.data, Boolean(from));
  if (from) redirect(`${guideHref(space)}?applied=${res.data.already_known ? "same" : String(res.data.guide.version ?? "")}#form`);
  refresh();
  return okState(out.message, out.lines.length ? { lines: out.lines } : {});
}

export async function transferOwnerAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const space = text(formData, "space"), login = text(formData, "login").toLowerCase();
  if (!isSlug(space)) return failState(M.noSpace4);
  if (!isLogin(login)) return failState(M.chooseANewOwnerStartTypingTheir);
  if (formData.get("confirm") !== "on") return failState(M.confirmTheOwnershipTransferBySelectingThe);
  const res = await meGw<MySpace>(session.key, `${spacePath(space)}/owner`, { method: "POST", body: { login } });
  if (!res.ok) return refused(M.ownershipNotTransferred, res);
  redirect(`/projects/${encodeURIComponent(space)}?transferred=1`);
}

export async function bindGroupAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const space = text(formData, "space"), dn = text(formData, "group_dn"), role = text(formData, "role") || "member";
  if (!isSlug(space)) return failState(M.noSpace5);
  if (dn.length < 3 || dn.length > 1024 || !dn.includes("=") || /[\r\n]/.test(dn)) return failState(M.findAndSelectAGroupInThe);
  if (role !== "member" && role !== "reader") return failState(M.groupMembersRoleOr(PICK_ROLE_TITLES.member, PICK_ROLE_TITLES.reader));
  const res = await meGw<SpaceGroup | null>(session.key, `${spacePath(space)}/groups`, { method: "POST", body: { group_dn: dn, role } });
  if (!res.ok) return refused(M.groupNotLinked, res);
  const g = res.data;
  if (!g || !isId(g.id)) { refresh(); return okState(M.groupLinked, { lines: [M.itsMembersAreListedUnderMembers] }); }
  redirect(`/projects/${encodeURIComponent(space)}?tab=members&bound=${encodeURIComponent(g.id)}${res.status === 200 ? "&again=1" : ""}#groups`);
}

export async function unbindGroupAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const space = text(formData, "space"), id = text(formData, "id");
  if (!isSlug(space)) return failState(M.noSpace6);
  if (!isId(id)) return failState(M.noGroupLink);
  const res = await meGw<SpaceGroupUnbound>(session.key, `${spacePath(space)}/groups/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) return refused(M.groupNotUnlinked, res);
  redirect(`/projects/${encodeURIComponent(space)}?tab=members&unbound=${Math.max(0, Math.trunc(Number(res.data.members_removed) || 0))}#groups`);
}

export async function syncGroupsAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const space = text(formData, "space");
  if (!isSlug(space)) return failState(M.noSpace7);
  const res = await meGw<GroupSyncRun>(session.key, `${spacePath(space)}/groups/sync`, { method: "POST" });
  if (!res.ok) return refused(M.membershipNotRefreshed, res);
  refresh();
  const r = res.data;
  if (!r.ok) return failState(M.theCompanyDirectoryDidNotRespondMembership(r.error_code ? ` (${r.error_code})` : ""), { lines: [M.directoryUnavailable] });
  return okState(M.groupMembershipRefreshed, {
    lines: [
      M.groupsCheckedMembershipsAddedRemoved(r.groups, r.members_added, r.members_removed),
      ...(r.missing ? [M.groupsMissingFromTheDirectoryTheirMembership(r.missing)] : []),
      ...(r.too_large ? [M.groupsExceedingTheLimitTheirMembershipIs(r.too_large)] : []),
    ],
  });
}

export async function archiveProjectAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const space = text(formData, "space");
  if (!isSlug(space)) return failState(M.noSpace8);
  if (formData.get("confirm") !== "on") return failState(M.confirmBySelectingTheProjectIsFinished);
  const res = await meGw<MySpace>(session.key, `${spacePath(space)}/archive`, { method: "POST" });
  if (!res.ok) return refused(M.projectNotArchived, res);
  redirect(`/projects/${encodeURIComponent(space)}?tab=settings&archived=1#archive`);
}

export async function unarchiveProjectAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const space = text(formData, "space");
  if (!isSlug(space)) return failState(M.noSpace9);
  const res = await meGw<MySpace>(session.key, `${spacePath(space)}/unarchive`, { method: "POST" });
  if (!res.ok) return refused(M.projectNotRestoredFromArchive, res);
  redirect(`/projects/${encodeURIComponent(space)}?tab=settings&unarchived=1#archive`);
}

export async function changeClassAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const space = text(formData, "space"), cls = text(formData, "default_class");
  if (!isSlug(space)) return failState(M.noSpace10);
  if (cls !== "open" && cls !== "closed") return failState(M.chooseWhoCanSeeNewRecords);
  if (cls === "open" && formData.get("open_ack") !== "on") return failState(FORM_TEXT.openAckMissing, { lines: [CLOSED_CLASS_TEXT.openSpaceWarning] });
  const res = await meGw<MySpace>(session.key, `${spacePath(space)}/class`, { method: "POST", body: { default_class: cls, ...(cls === "open" ? { open_ack: true } : {}) } });
  if (!res.ok) return refused(M.notChanged, res);
  refresh();
  return okState(cls === "open" ? M.membersAiAgentsCanNowSeeNew : M.onlyPeopleCanNowSeeNewRecords, {
    lines: [M.existingRecordsStayAsTheyAreShow],
  });
}

export async function addableMoveAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  const denied = denyPreview(session); if (denied) return denied;
  const space = text(formData, "space");
  if (!isSlug(space)) return failState(M.noSpace11);
  const ids = pickedIds(formData);
  if (!ids.length) return failState(ADDABLE_PLAIN.pickNone);
  if (ids.length > ADDABLE_MAX) return failState(ADDABLE_PLAIN.tooMany(ADDABLE_MAX));
  const res = await callTool<PlanCompose>(session.key, "memory_plan", { op: "promote", ids, to_space: space });
  if (!res.ok) return endedState(res) ?? failState(M.notMoved(toolErrorMessage(res)));
  if (res.data.status === "pending" && res.data.plan_id && isId(res.data.plan_id)) redirect(`/plans/${res.data.plan_id}`);
  const why = (res.data.skipped ?? []).filter((x) => x.count > 0).map((x) => `${PLAN_REASON_TITLES[x.reason] ?? M.notSuitable}: ${x.count}`);
  return failState(ADDABLE_PLAIN.nothing, why.length ? { lines: why } : {});
}
