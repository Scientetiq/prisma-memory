"use server";
import { ACTIONS_TEXT } from "../../../../messages/panel-operator";
import { refresh } from "next/cache";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { denyAuditor } from "@/lib/admin-guard";
import { approvalPendingOf, approvalPendingState } from "@/lib/admin-form";
import { gw } from "@/lib/api";
import { GatewayError } from "@/lib/gateway";

interface Linked { login: string; person: { login: string; display_name: string | null; directory_linked: boolean } | null; changed: boolean }

async function put(adminLogin: string, person: string | null): Promise<ActionState> {
  if (!/^[^\s/]{1,254}$/.test(adminLogin)) return failState(ACTIONS_TEXT.noAdministratorLogin);
  try {
    const r = await gw<Linked>(`/api/v1/admin/admin-users/${encodeURIComponent(adminLogin)}/person`, { method: "PUT", body: { person } });
    refresh();
    const pending = approvalPendingOf(r);
    if (pending) return approvalPendingState(pending);
    if (!r.changed) return okState(ACTIONS_TEXT.noChangesThisLinkIsAlreadyInPlace);
    if (!r.person) return okState(ACTIONS_TEXT.linkRemovedNobodyIsIdentifiedBehindValue1ExtendedAccess(adminLogin));
    return okState(ACTIONS_TEXT.value2OperatesValue1(adminLogin, r.person.display_name ?? r.person.login), {
      lines: [r.person.directory_linked ? ACTIONS_TEXT.profileLinkedToTheCompanyDirectory : ACTIONS_TEXT.profileNotLinkedToTheDirectoryYetThisPerson,
              ACTIONS_TEXT.changeRecordedInTheAuditLog],
    });
  } catch (e) {
    if (e instanceof GatewayError) return failState(ACTIONS_TEXT.notSavedValue1(e.message), { fieldErrors: e.status === 400 ? { person: e.message } : {} });
    throw e;
  }
}

export async function linkOperatorAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const person = String(formData.get("person") ?? "").trim();
  if (!person) return failState(ACTIONS_TEXT.selectAPerson, { fieldErrors: { person: ACTIONS_TEXT.startTypingASurnameOrEmailAndSelectA } });
  return put(String(formData.get("admin_login") ?? ""), person);
}

export async function unlinkOperatorAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  return put(String(formData.get("admin_login") ?? ""), null);
}
