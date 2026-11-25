"use server";
import { derived } from "@/i18n/runtime";
import { rolesActions } from "@/messages/panel-roles";
import { refresh } from "next/cache";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { denyAuditor } from "@/lib/admin-guard";
import { approvalPendingOf, approvalPendingState } from "@/lib/admin-form";
import { gw } from "@/lib/api";
import { endOfDayIso } from "@/lib/format";
import { GatewayError } from "@/lib/gateway";
import { BASIS_SOURCES, EFFECT_TITLES, GRANT_ACTIONS, SCOPE_KINDS, SCOPE_NEEDS_REF, SCOPE_TITLES } from "@/lib/labels";
import type { GrantCreateResponse } from "@/lib/types";

const text = (fd: FormData, name: string): string => String(fd.get(name) ?? "").trim();

export async function createGrantAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const login = text(formData, "login").toLowerCase(), role_code = text(formData, "role_code");
  const scope_kind = text(formData, "scope_kind"), scope_ref = text(formData, "scope_ref");
  const basis_source = text(formData, "basis_source"), basis_ref = text(formData, "basis_ref");
  const approved_by = text(formData, "approved_by"), validTo = text(formData, "valid_to");
  const actions = formData.getAll("actions").map(String).filter((a) => (GRANT_ACTIONS as readonly string[]).includes(a));

  if (!login) return failState(rolesActions.enterTheRecipientSLogin);
  if (!role_code) return failState(rolesActions.chooseARole);
  if (!(BASIS_SOURCES as readonly string[]).includes(basis_source)) return failState(rolesActions.aGrantRequiresABasisChooseIts);
  if (!(SCOPE_KINDS as readonly string[]).includes(scope_kind)) return failState(rolesActions.chooseAScope);
  if (SCOPE_NEEDS_REF.has(scope_kind) && !scope_ref) return failState(rolesActions.scopeRequiresAScopeIdentifierScopeRef(SCOPE_TITLES[scope_kind]));
  if (!SCOPE_NEEDS_REF.has(scope_kind) && scope_ref) return failState(rolesActions.scopeDoesNotUseAScopeIdentifier(SCOPE_TITLES[scope_kind]));
  if (!actions.length) return failState(rolesActions.selectAtLeastOneAction);
  const valid_to = validTo ? endOfDayIso(validTo) : null;
  if (validTo && !valid_to) return failState(rolesActions.validUntilEnterADate);
  if (valid_to && Date.parse(valid_to) <= Date.now()) return failState(rolesActions.theExpiryDateHasPassed);

  let out: GrantCreateResponse;
  try {
    out = await gw<GrantCreateResponse>("/api/v1/admin/grants", {
      method: "POST",
      body: { login, role_code, actions, scope_kind, scope_ref: scope_ref || null, basis_source, basis_ref: basis_ref || null, approved_by: approved_by || null, valid_to },
    });
  } catch (e) {
    if (e instanceof GatewayError) return failState(rolesActions.couldNotCreateGrant(e.message));
    throw e;
  }
  refresh();
  { const pending = approvalPendingOf(out); if (pending) return approvalPendingState(pending); }
  return okState(rolesActions.grantCreated(role_code, login), {
    lines: [
      out.memory_effect === "none"
        ? rolesActions.memoryEffectNoneTheRoleIsKept
        : rolesActions.memoryEffect(EFFECT_TITLES[out.memory_effect] ?? out.memory_effect),
      rolesActions.accessRecalculatedMembershipsAddedRemoved(out.access?.added ?? 0, out.access?.removed ?? 0),
    ],
  });
}

const SPECIAL: Record<string, { actions: string[]; title: string }> = derived(() => ({
  security_auditor: { actions: ["view"], title: rolesActions.securityAuditor },
  org_curator: { actions: ["review", "moderate", "delete"], title: rolesActions.companyKnowledgeCurator },
}));

export async function assignSpecialRoleAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const role_code = text(formData, "role_code"), login = text(formData, "login").toLowerCase();
  const basis_source = text(formData, "basis_source") || "manual", basis_ref = text(formData, "basis_ref"), validTo = text(formData, "valid_to");
  const spec = SPECIAL[role_code];
  if (!spec) return failState(rolesActions.unknownRole);
  if (!/^[^@\s]+@[^@\s]+$/.test(login)) return failState(rolesActions.enterThePersonSLoginWorkEmail, { fieldErrors: { login: rolesActions.loginIsTheWorkEmail } });
  if (!["request", "manual"].includes(basis_source)) return failState(rolesActions.theBasisMustBeARequestOr);
  if (role_code === "security_auditor" && basis_ref.length < 3)
    return failState(rolesActions.securityAuditorIsABroadGrantEnter, { fieldErrors: { basis_ref: rolesActions.requestOrDecisionReference } });
  const valid_to = validTo ? endOfDayIso(validTo) : null;
  if (validTo && !valid_to) return failState(rolesActions.validUntilEnterADate);
  if (valid_to && Date.parse(valid_to) <= Date.now()) return failState(rolesActions.theExpiryDateHasPassed);

  let scope: { scope_kind: string; scope_ref: string | null } = { scope_kind: "own", scope_ref: null };
  if (role_code === "org_curator") {
    const org = await gw<{ items: Array<{ slug: string }> }>("/api/v1/admin/spaces", { query: { kind: "org", limit: 1 } }).catch(() => null);
    const slug = org?.items[0]?.slug;
    if (!slug) return failState(rolesActions.companyKnowledgeDoesNotExistYetIt);
    scope = { scope_kind: "space", scope_ref: slug };
  }
  let out: GrantCreateResponse;
  try {
    out = await gw<GrantCreateResponse>("/api/v1/admin/grants", {
      method: "POST",
      body: { login, role_code, actions: spec.actions, ...scope, basis_source, basis_ref: basis_ref || null, valid_to },
    });
  } catch (e) {
    if (e instanceof GatewayError) return failState(rolesActions.couldNotAssign(e.message));
    throw e;
  }
  refresh();
  { const pending = approvalPendingOf(out); if (pending) return approvalPendingState(pending); }
  return okState(`${spec.title}: ${login}`, {
    lines: role_code === "org_curator"
      ? [rolesActions.companyKnowledgeOwnershipGrantedMembershipsAdded(out.access?.added ?? 0), rolesActions.theGrantIsRecordedInTheAudit]
      : [rolesActions.theGrantIsRecordedInTheAuditLabel],
  });
}

export async function revokeGrantAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const id = text(formData, "id");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return failState(rolesActions.grantIdentifierIsMissing);
  let out: unknown;
  try {
    out = await gw(`/api/v1/admin/grants/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch (e) {
    if (e instanceof GatewayError) return failState(e.status === 404 ? rolesActions.alreadyRevoked : e.message);
    throw e;
  }
  refresh();
  { const pending = approvalPendingOf(out); if (pending) return approvalPendingState(pending); }
  return okState(rolesActions.revoked);
}

export async function sendCuratorDigestAction(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  try {
    const r = await gw<{ queued: number; recipients: number; no_address: number; waiting: number; held: number; repeat: boolean }>("/api/v1/admin/org-review/digest", { method: "POST", body: {} });
    refresh();
    const lines = r.no_address ? [rolesActions.noEmailAddressInTheLoginNo(r.no_address)] : [];
    return r.repeat
      ? okState(rolesActions.thisHourSEmailsAreAlreadyQueued(r.recipients), { lines })
      : okState(rolesActions.emailQueuedCuratorsAwaitingReview(r.queued, r.waiting, r.held), { lines });
  } catch (e) {
    if (e instanceof GatewayError) return failState(rolesActions.couldNotSendEmail(e.message));
    throw e;
  }
}
