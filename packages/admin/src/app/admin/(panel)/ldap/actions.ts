"use server";
import { TEXT } from "../../../../messages/panel-ldap";
import { refresh } from "next/cache";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { denyAuditor } from "@/lib/admin-guard";
import { gw } from "@/lib/api";
import { GatewayError } from "@/lib/gateway";
import { LDAP_CLEAR_SECRET, LDAP_FIELDS, ldapInput, stepViews, testLoginHeadline, testLoginLines } from "@/lib/ldap-form";
import { saveSettingsSection } from "@/lib/settings-section";
import type { GroupSyncRun } from "@/lib/types";

export async function saveLdapAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  return saveSettingsSection({ category: "ldap", fields: LDAP_FIELDS, input: ldapInput, clearSecret: LDAP_CLEAR_SECRET,
                               endedKey: "ldap_sessions_ended", endedText: TEXT.directorySignInSessionsEnded }, formData);
}

interface CheckBody { ok: boolean; enabled: boolean; mode: string; steps: unknown }

export async function checkLdapAction(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  let res: CheckBody;
  try {
    res = await gw<CheckBody>("/api/v1/admin/ldap/check", { method: "POST", body: {}, timeoutMs: 120_000 });
  } catch (e) {
    if (e instanceof GatewayError) return failState(TEXT.checkFailed(e.message));
    throw e;
  }
  const steps = stepViews(res.steps);
  const lines = res.enabled ? [] : [TEXT.companyAccountSignInIsStillOff];
  return res.ok ? okState(TEXT.theDirectoryIsRespondingTheConnectionCertificate, { steps, lines })
                : failState(TEXT.theDirectoryConnectionIsNotReadySee, { steps, lines });
}

export async function testLoginAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const login = String(formData.get("login") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!login) return failState(TEXT.enterTheTestPersonSLogin, { fieldErrors: { login: TEXT.loginIsRequired } });
  let res: Record<string, unknown>;
  try {
    res = await gw<Record<string, unknown>>("/api/v1/admin/ldap/test-login", { method: "POST", body: { login, password }, timeoutMs: 120_000 });
  } catch (e) {
    if (e instanceof GatewayError) return failState(TEXT.checkFailed2(e.message));
    throw e;
  }
  const extra = { lines: testLoginLines(res), steps: stepViews(res.steps) };
  return res.ok === true ? okState(testLoginHeadline(res), extra) : failState(testLoginHeadline(res), extra);
}

export async function groupSyncAction(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  let r: GroupSyncRun;
  try { r = await gw<GroupSyncRun>("/api/v1/admin/group-sync", { method: "POST", body: {}, timeoutMs: 120_000 }); }
  catch (e) { if (e instanceof GatewayError) return failState(TEXT.groupVerificationFailed(e.message)); throw e; }
  refresh();
  if (!r.ok) return failState(TEXT.theDirectoryDidNotRespondGroupMemberships(r.error_code ? ` (${r.error_code})` : ""), { lines: [/* i18n */ TEXT.whileTheDirectoryDoesNotAnswerMembership] });
  return okState(TEXT.groupsVerified(r.groups), {
    lines: [
      TEXT.membershipsAddedRemoved(r.members_added, r.members_removed),
      ...(r.missing ? [TEXT.groupsMissingFromTheDirectoryTheirMembership(r.missing)] : []),
      ...(r.too_large ? [TEXT.groupsOverTheSizeLimitTheirMembership(r.too_large)] : []),
    ],
  });
}
