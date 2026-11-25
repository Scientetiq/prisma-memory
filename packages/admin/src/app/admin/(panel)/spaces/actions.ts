"use server";
import { spacesActions } from "@/messages/panel-spaces";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { denyAuditor } from "@/lib/admin-guard";
import { approvalPendingOf, approvalPendingState } from "@/lib/admin-form";
import { gw } from "@/lib/api";
import { GatewayError } from "@/lib/gateway";
import { isId, isLogin, isSlug, logins as loginList, PROJECT_DESCRIPTION_MAX, PROJECT_NAME_MAX, text } from "@/lib/form";
import { SPACE_ROLE_TITLES } from "@/lib/labels";
import { CLASS_PLAIN } from "@/lib/plain";
import { counts } from "@/messages/plain";
import type { Space, SpaceGroupUnbound } from "@/lib/types";

const SPACE_KINDS = ["team", "project", "org"] as const;

export async function createSpaceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const kind = text(formData, "kind"), name = text(formData, "name"), slug = text(formData, "slug").toLowerCase();
  const description = text(formData, "description"), owner = text(formData, "owner").toLowerCase(), cls = text(formData, "default_class");
  const members = loginList(formData, "members");

  if (!(SPACE_KINDS as readonly string[]).includes(kind)) return failState(spacesActions.spaceKindTeamProjectOrCompanyKnowledge);
  if (!name) return failState(spacesActions.enterASpaceName);
  if (!owner) return failState(spacesActions.enterTheOwnerSLogin);
  if (slug && !isSlug(slug)) return failState(spacesActions.slugLowercaseLatinLettersDigitsAndHyphens);
  if (cls && cls !== "open" && cls !== "closed") return failState(spacesActions.newRecordsDataClassOpenOrClosed);
  const bad = members.filter((m) => !isLogin(m));
  if (bad.length) return failState(spacesActions.membersTheseAreNotLogins(bad.slice(0, 5).join(", ")));

  let out: Space;
  try {
    out = await gw<Space>("/api/v1/admin/spaces", {
      method: "POST",
      body: { kind, name, owner, ...(slug ? { slug } : {}), ...(description ? { description } : {}), ...(members.length ? { members } : {}), ...(cls ? { default_class: cls } : {}) },
    });
  } catch (e) {
    if (e instanceof GatewayError) return e.code === "open_check" ? failState(e.message, e.hint ? { lines: [e.hint] } : {}) : failState(spacesActions.couldNotCreateSpace(e.message));
    throw e;
  }
  refresh();
  const asked = members.filter((m) => m !== owner).length, added = Math.max(0, (out.members_count ?? 0) - 1);
  return okState(spacesActions.spaceCreated(out.slug), {
    lines: [
      spacesActions.newRecordsDataClassMembersIncludingOwner(CLASS_PLAIN[out.default_class as "open" | "closed"] ?? out.default_class, out.members_count),
      ...(out.default_class === "open" ? [spacesActions.membersCloudAgentsCanReadOpenSpace] : []),
      ...(asked > added ? [spacesActions.someMembersWereNotAddedTheseActive(asked - added)] : []),
    ],
  });
}

export async function setSpaceOwnerAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const slug = text(formData, "slug").toLowerCase(), owner = text(formData, "owner_login").toLowerCase();
  if (!isSlug(slug)) return failState(spacesActions.slugLowercaseLatinLettersDigitsAndHyphensLabel);
  if (!isLogin(owner)) return failState(spacesActions.ownerTheLoginEmailOfAnActive);
  let out: Space;
  try { out = await gw<Space>(`/api/v1/admin/spaces/${encodeURIComponent(slug)}`, { method: "PUT", body: { owner_login: owner } }); }
  catch (e) { if (e instanceof GatewayError) return failState(spacesActions.couldNotAssignOwner(e.message)); throw e; }
  refresh();
  { const pending = approvalPendingOf(out); if (pending) return approvalPendingState(pending); }
  return okState(spacesActions.ownerOf(out.slug, out.owner), { lines: [spacesActions.membersIncludingOwner(out.members_count)] });
}

export async function updateSpaceMembersAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const slug = text(formData, "slug").toLowerCase(), role = text(formData, "role") || "member";
  const add = loginList(formData, "add"), remove = loginList(formData, "remove");
  if (!isSlug(slug)) return failState(spacesActions.slugLowercaseLatinLettersDigitsAndHyphensLabel);
  if (role !== "member" && role !== "reader") return failState(spacesActions.roleOr(SPACE_ROLE_TITLES.member, SPACE_ROLE_TITLES.reader));
  if (!add.length && !remove.length) return failState(spacesActions.enterPeopleToAddOrRemove);
  const bad = [...add, ...remove].filter((m) => !isLogin(m));
  if (bad.length) return failState(spacesActions.theseAreNotLogins(bad.slice(0, 5).join(", ")));
  let out: { space: string; added: number; removed: number };
  try { out = await gw(`/api/v1/admin/spaces/${encodeURIComponent(slug)}/members`, { method: "PUT", body: { add: add.map((login) => ({ login, role })), remove } }); }
  catch (e) { if (e instanceof GatewayError) return failState(spacesActions.couldNotChangeMembership(e.message)); throw e; }
  refresh();
  { const pending = approvalPendingOf(out); if (pending) return approvalPendingState(pending); }
  return okState(spacesActions.membershipInUpdated(out.space), { lines: [spacesActions.addedRemoved(out.added, out.removed)] });
}

export async function archiveSpaceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const slug = text(formData, "slug").toLowerCase();
  if (!isSlug(slug)) return failState(spacesActions.spaceIsMissing);
  if (text(formData, "confirm_slug").toLowerCase() !== slug) return failState(spacesActions.confirmEnterTheSpaceSlugInThe(slug));
  const withRecords = formData.get("with_records") === "on";
  try {
    await gw(`/api/v1/admin/spaces/${encodeURIComponent(slug)}`, { method: "DELETE", query: withRecords ? { with_records: "true" } : undefined });
  } catch (e) {
    if (e instanceof GatewayError) {
      if (e.code === "not_empty") {
        const n = (e.details as { records?: unknown } | undefined)?.records;
        return failState(spacesActions.space(slug, typeof n === "number" ? `${n} ${counts.records(n)}` : spacesActions.hasLiveRecords), { lines: [spacesActions.selectArchiveWithRecordsOrAskThe] });
      }
      if (e.code === "invalid_argument") return failState(spacesActions.spaceCannotBeArchived(slug), { lines: [e.message || spacesActions.companyKnowledgeOrgIsUniqueToThe] });
      return failState(spacesActions.couldNotArchive(e.message));
    }
    throw e;
  }
  redirect(`/admin/spaces/${encodeURIComponent(slug)}?tab=archive&archived=1#archive`);
}

export async function unarchiveSpaceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const slug = text(formData, "slug").toLowerCase();
  if (!isSlug(slug)) return failState(spacesActions.spaceIsMissing);
  try {
    await gw(`/api/v1/admin/spaces/${encodeURIComponent(slug)}/unarchive`, { method: "POST" });
  } catch (e) {
    if (e instanceof GatewayError) return failState(spacesActions.couldNotRestoreFromArchive(e.message));
    throw e;
  }
  redirect(`/admin/spaces/${encodeURIComponent(slug)}?tab=archive&unarchived=1#archive`);
}

export async function updateSpaceMetaAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const slug = text(formData, "slug").toLowerCase(), name = text(formData, "name"), description = text(formData, "description");
  if (!isSlug(slug)) return failState(spacesActions.spaceIsMissing);
  if (!name || name.length > PROJECT_NAME_MAX) return failState(spacesActions.nameCharacters(PROJECT_NAME_MAX));
  if (description.length > PROJECT_DESCRIPTION_MAX) return failState(spacesActions.descriptionUpToCharacters(PROJECT_DESCRIPTION_MAX));
  try { await gw<Space>(`/api/v1/admin/spaces/${encodeURIComponent(slug)}`, { method: "PUT", body: { name, description: description || null } }); }
  catch (e) {
    if (e instanceof GatewayError) return e.code === "open_check" ? failState(e.message, e.hint ? { lines: [e.hint] } : {}) : failState(spacesActions.couldNotSave(e.message));
    throw e;
  }
  refresh();
  return okState(spacesActions.nameAndDescriptionSaved, { lines: [spacesActions.membersAgentsSeeThemAtTheStart] });
}

export async function makeProjectAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const slug = text(formData, "slug").toLowerCase();
  if (!isSlug(slug)) return failState(spacesActions.spaceIsMissing);
  try { await gw<Space>(`/api/v1/admin/spaces/${encodeURIComponent(slug)}`, { method: "PUT", body: { kind: "project" } }); }
  catch (e) { if (e instanceof GatewayError) return failState(spacesActions.couldNotConvert(e.message)); throw e; }
  refresh();
  return okState(spacesActions.isNowAProjectSpace(slug), { lines: [spacesActions.theOwnerCanSeeItInSpaces] });
}

export async function unbindGroupAdminAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const slug = text(formData, "slug").toLowerCase(), id = text(formData, "id");
  if (!isSlug(slug)) return failState(spacesActions.spaceIsMissing);
  if (!isId(id)) return failState(spacesActions.groupBindingIsMissing);
  let out: SpaceGroupUnbound;
  try { out = await gw<SpaceGroupUnbound>(`/api/v1/admin/spaces/${encodeURIComponent(slug)}/groups/${encodeURIComponent(id)}`, { method: "DELETE" }); }
  catch (e) { if (e instanceof GatewayError) return failState(e.status === 404 ? spacesActions.thisBindingNoLongerExists : spacesActions.couldNotUnbind(e.message)); throw e; }
  redirect(`/admin/spaces/${encodeURIComponent(slug)}?unbound=${Math.max(0, Math.trunc(Number(out.members_removed) || 0))}#groups`);
}
