"use server";
import { personActions } from "@/messages/panel-people";
import { refresh } from "next/cache";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { denyAuditor } from "@/lib/admin-guard";
import { approvalPendingOf, approvalPendingState } from "@/lib/admin-form";
import { gw, tryGw } from "@/lib/api";
import { instanceTz } from "@/lib/checks";
import { isLogin, text } from "@/lib/form";
import { GatewayError } from "@/lib/gateway";
import { CUSTODY_VIEW_TEXT, CUSTODY_PANEL, custodyBasisTitle, custodyDay, noneLine, REACTIVATION_ACK_FIELD } from "@/lib/custody-view";
import { deactivationEffects } from "@/lib/labels";
import type { Page, PeopleUpsertResponse, Person, PersonAccess, PersonCustody, SettingsResponse } from "@/lib/types";

const PAGE = 500;
const MAX_PAGES = 20;

async function findPerson(login: string): Promise<Person | null> {
  let cursor: number | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await gw<Page<Person>>("/api/v1/admin/people", { query: { q: login, limit: PAGE, cursor } });
    const hit = page.items.find((x) => x.login.toLowerCase() === login);
    if (hit) return hit;
    if (!page.next_cursor) return null;
    cursor = Number(page.next_cursor);
    if (!Number.isFinite(cursor)) return null;
  }
  return null;
}

export async function setActiveAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const login = text(formData, "login").toLowerCase();
  const active = formData.get("active") === "true";
  if (!isLogin(login)) return failState(personActions.loginIsMissing);
  try {
    const card = await gw<PersonAccess>(`/api/v1/admin/people/${encodeURIComponent(login)}/access`);
    const p = await findPerson(login);
    if (!p) return failState(personActions.personExistsInMemoryButTheirOrg(card.person.login));
    const same = active && formData.get(REACTIVATION_ACK_FIELD) === "on";
    const { employee_id: _ownNumber, ...attrs } = (p.attrs ?? {}) as Record<string, unknown>;
    const body = { people: [{ login: p.login, display_name: p.display_name, department: p.department, ...(active ? { manager_login: p.manager_login } : {}),
                              role: p.role, active, attrs }],
                   ...(same ? { confirm_reactivations: [p.login.toLowerCase()] } : {}) };
    const out = await gw<PeopleUpsertResponse>("/api/v1/admin/people", { method: "PUT", body });
    const pending = approvalPendingOf(out);
    if (pending) { refresh(); return approvalPendingState(pending); }
    if (out.errors?.length) {
      const ask = active && !same && out.errors.some((e) => e.reason === "reactivation_confirm");
      const text = out.errors.map((e) => e.message).join("; ");
      return failState(ask ? `${text}. ${CUSTODY_VIEW_TEXT.activateAckHint}` : text);
    }
    refresh();
    return okState(active ? CUSTODY_VIEW_TEXT.activatedText : personActions.personDeactivatedMembershipsRemovedAndKeysPermanently, {
      lines: [
        ...(out.access ? [personActions.membershipsAddedRemoved(out.access.added, out.access.removed)] : []),
        ...(active ? [personActions.previousKeysHaveNotBeenRestoredIssue] : []),
        ...(!active ? [personActions.personSKeysRevoked(out.keys_revoked ?? 0), deactivationEffects(card.custody?.policy)] : []),
        ...(out.warnings ?? []).map((w) => personActions.warning(w)),
      ],
    });
  } catch (e) {
    if (e instanceof GatewayError) return failState(e.status === 404 ? personActions.noPersonWithThisLoginExistsIn : personActions.couldNotSave(e.message));
    throw e;
  }
}

export async function revokePersonConnectionsAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const login = text(form, "login").toLowerCase();
  if (!isLogin(login)) return failState(personActions.loginIsMissing);
  try {
    const person = await findPerson(login);
    if (!person) return failState(personActions.personNotFound);
    const result = await gw<{ revoked: number }>(`/api/v1/admin/people/${person.id}/connections`, { method: "DELETE" });
    refresh();
    return okState(personActions.agentConnectionsDisconnected(result.revoked));
  } catch (error) {
    if (error instanceof GatewayError) return failState(personActions.couldNotDisconnectConnections(error.message));
    throw error;
  }
}

const custodyRefused = (e: GatewayError): boolean => typeof (e.details as { reason?: unknown } | undefined)?.reason === "string";

/**
 * Zone of the installation from the settings (checks.instanceTz) for the day in the result line of Assign. The custodian is
 * already assigned, so a refusal of the gateway does not spoil the result: tryGw returns it as a value, and the zone the
 * gateway sends applies. No try/catch: Next's own exceptions (redirect to sign-in on 401) pass through, as in page.tsx.
 */
async function settingsTz(): Promise<string> {
  const s = await tryGw<SettingsResponse>("/api/v1/admin/settings");
  return instanceTz(s?.ok ? s.data : null);
}

export async function setCustodianAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const login = text(formData, "login").toLowerCase();
  if (!isLogin(login)) return failState(personActions.loginIsMissing);
  const toRule = text(formData, "op") === "rule";
  const custodian = text(formData, "custodian_login").toLowerCase(), reason = text(formData, "reason");
  if (!toRule && !isLogin(custodian)) return failState(personActions.chooseACustodianFindAnActiveColleague);
  if (reason.length > 200) return failState(personActions.theReasonMustBeCharactersLong);
  let out: PersonCustody;
  try {
    out = await gw<PersonCustody>(`/api/v1/admin/people/${encodeURIComponent(login)}/custodian`, { method: "PUT",
      body: toRule ? { custodian: null } : { custodian, ...(reason ? { reason } : {}) } });
  } catch (e) {
    if (e instanceof GatewayError) return failState(custodyRefused(e) ? e.message : personActions.couldNotAssignCustodian(e.message));
    throw e;
  }
  refresh();
  { const pending = approvalPendingOf(out); if (pending) return approvalPendingState(pending); }
  const day = out.custodian && out.since ? custodyDay(out.since, await settingsTz()) : null;
  const line = out.custodian ? CUSTODY_PANEL.custodian(out.custodian.display_name || out.custodian.login, custodyBasisTitle(out), day) : noneLine(out);
  return okState(toRule ? personActions.theCustodianIsDeterminedByTheOrg : personActions.custodianAssigned, { lines: [line] });
}
