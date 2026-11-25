"use server";
import { TEXT } from "../../../../messages/panel-sso";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { denyAuditor } from "@/lib/admin-guard";
import { gw } from "@/lib/api";
import { GatewayError } from "@/lib/gateway";
import { stepViews } from "@/lib/ldap-form";
import { OIDC_CLEAR_SECRET, OIDC_FIELDS, OIDC_STEP_TITLES, oidcInput } from "@/lib/oidc-form";
import { saveSettingsSection } from "@/lib/settings-section";

export async function saveOidcAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  return saveSettingsSection({ category: "oidc", fields: OIDC_FIELDS, input: oidcInput, clearSecret: OIDC_CLEAR_SECRET,
                               endedKey: "oidc_sessions_ended", endedText: TEXT.keycloakSignInSessionsEnded }, formData);
}

interface CheckBody { ok: boolean; enabled: boolean; steps: unknown }

export async function checkOidcAction(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  let res: CheckBody;
  try {
    res = await gw<CheckBody>("/api/v1/admin/oidc/check", { method: "POST", body: {}, timeoutMs: 120_000 });
  } catch (e) {
    if (e instanceof GatewayError) return failState(TEXT.checkFailed(e.message));
    throw e;
  }
  const steps = stepViews(res.steps, OIDC_STEP_TITLES);
  const lines = [...(res.enabled ? [] : [TEXT.keycloakSignInIsStillOffSaved]),
                 TEXT.thisCheckReadsOnlyMetadataAndKeys];
  return res.ok ? okState(TEXT.keycloakIsRespondingMetadataIssuerURLsAnd, { steps, lines })
                : failState(TEXT.theProviderIsNotReadySeeThe, { steps, lines });
}
