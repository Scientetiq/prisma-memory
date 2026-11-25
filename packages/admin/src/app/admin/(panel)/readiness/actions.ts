"use server";
import { ACTIONS_TEXT } from "../../../../messages/panel-readiness";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { denyAuditor } from "@/lib/admin-guard";
import { call } from "@/lib/gateway";
import { clearSessionCookie, requireSession } from "@/lib/session";
import { SM_ERROR_TEXTS } from "../security-mode/view";

export async function enableAdvancedAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  if (formData.get("ack") !== "on") return failState(ACTIONS_TEXT.confirmThatYouUnderstandSystemKeysAndOtherSessions);
  const reason = String(formData.get("reason") ?? "").trim().slice(0, 500);
  const session = await requireSession();
  const { status, data } = await call("/api/v1/admin/security-mode", { method: "POST", body: reason ? { reason } : {}, token: session.token, timeoutMs: 60_000 });
  if (status === 401) { await clearSessionCookie(); redirect("/admin/login?expired=1"); }
  refresh();
  const d = (data ?? {}) as { keys_revoked?: number; sessions_revoked?: number; code?: string; reason?: string; message?: string;
                              details?: { failed?: Array<{ title: string; detail?: string }> } };
  if (status === 200)
    return okState(ACTIONS_TEXT.advancedModeEnabled, { lines: [ACTIONS_TEXT.systemKeysRevokedValue1SessionsValue2(d.keys_revoked ?? 0, d.sessions_revoked ?? 0),
      ACTIONS_TEXT.panelSignInRequiresASecurityKeyDangerousActions, ACTIONS_TEXT.completeTheRemainingStepsAdvancedModeFloorInAnchors] });
  if (d.code === "readiness_failed")
    return failState(SM_ERROR_TEXTS.readiness_failed!, { lines: (d.details?.failed ?? []).map((f) => `${f.title}${f.detail ? ` — ${f.detail}` : ""}`) });
  // Advanced closed until the role split is ported — the panel's own text, by the reason
  if (d.reason === "roles_not_split") return failState(SM_ERROR_TEXTS.roles_not_split!);
  return failState(SM_ERROR_TEXTS[d.code ?? ""] ?? d.message ?? ACTIONS_TEXT.notEnabledResponseValue1(status));
}

const KEY_RE = /^[a-z0-9_]+\.[a-z0-9_.]+$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;

export async function confirmProfileAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const key = String(formData.get("key") ?? ""), digest = String(formData.get("digest") ?? "").toLowerCase();
  if (!KEY_RE.test(key) || !DIGEST_RE.test(digest)) return failState(ACTIONS_TEXT.missingSettingKeyOrValueFingerprintRefreshThePage);
  const session = await requireSession();
  const { status, data } = await call("/api/v1/admin/security-attestations", { method: "POST", body: { kind: "profile_weakening", subjects: [key], digests: { [key]: digest } },
                                                                              token: session.token, timeoutMs: 60_000 });
  if (status === 401) { await clearSessionCookie(); redirect("/admin/login?expired=1"); }
  refresh();
  const d = (data ?? {}) as { code?: string; message?: string };
  if (status === 201) return okState(ACTIONS_TEXT.deviationFromTheDefaultConfirmedValue1(key));
  return failState(SM_ERROR_TEXTS[d.code ?? ""] ?? d.message ?? ACTIONS_TEXT.notConfirmedResponseValue1(status));
}
