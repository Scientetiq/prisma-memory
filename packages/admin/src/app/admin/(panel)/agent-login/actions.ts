"use server";
import { TEXT } from "../../../../messages/panel-agent-login";
import { refresh } from "next/cache";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { denyAuditor } from "@/lib/admin-guard";
import { gw } from "@/lib/api";
import { GatewayError } from "@/lib/gateway";
import { CIMD_URL_MAX, isDcrClientId, isProbeUrl, probeLines, type ProbeAnswer } from "./view";

export async function revokeDcrClientAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const id = formData.get("id");
  if (!isDcrClientId(id)) return failState(TEXT.clientIDIsMissing);
  let res: { connections_revoked?: unknown } | null;
  try {
    res = await gw<{ connections_revoked?: unknown } | null>(`/api/v1/admin/agent-auth/clients/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch (e) {
    if (e instanceof GatewayError) return failState(e.status === 404 ? TEXT.theClientHasAlreadyBeenDeletedOr : TEXT.clientWasNotRevoked(e.message));
    throw e;
  }
  refresh();
  const n = typeof res?.connections_revoked === "number" ? res.connections_revoked : null;
  return okState(TEXT.clientRevokedNewSignInsWithThis, n !== null ? { lines: [TEXT.connectionsDisconnected(n)] } : {});
}

export async function probeCimdAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const denied = await denyAuditor(); if (denied) return denied;
  const raw = formData.get("url"), url = typeof raw === "string" ? raw.trim() : "";
  if (!isProbeUrl(url)) return failState(TEXT.enterAnHttpsDocumentURLOfAt(CIMD_URL_MAX));
  let res: ProbeAnswer;
  try {
    res = await gw<ProbeAnswer>("/api/v1/admin/agent-auth/cimd-probe", { method: "POST", body: { url }, timeoutMs: 30_000 });
  } catch (e) {
    if (e instanceof GatewayError) return failState(TEXT.probeFailed(e.message));
    throw e;
  }
  const lines = probeLines(res ?? { ok: false });
  return res?.ok ? okState(TEXT.theDocumentWasLoadedAndPassedValidation, { lines }) : failState(TEXT.theDocumentIsNotValid, { lines });
}
