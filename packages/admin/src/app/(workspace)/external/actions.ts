"use server";
import { headers } from "next/headers";
import { refresh } from "next/cache";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { endedState } from "@/lib/action-ended";
import { enableRefusal } from "@/lib/external-access";
import { meGw } from "@/lib/me-api";
import { invalidateExternal } from "@/lib/nav";
import { PREVIEW_TEXT } from "@/lib/preview";
import { actionSession } from "@/lib/user-session";
import { clientHeaders } from "@/lib/workplace-login";
import { WS_EXTERNAL_MESSAGES } from "@/messages/ws-external";

async function human(): Promise<{ key: string } | ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  if (session.preview) return failState(PREVIEW_TEXT.previewDenied, { lines: [PREVIEW_TEXT.previewDeniedHint] });
  return { key: session.key };
}

export async function enableExternalAction(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  const s = await human(); if (!s || "ok" in s) return s;
  const res = await meGw<{ enabled: boolean; first_confirm: string | null }>(s.key, "/api/v1/me/external/enable",
    { method: "POST", body: {}, headers: clientHeaders(await headers()) });
  invalidateExternal(s.key);
  if (!res.ok) {
    const ended = await endedState(res); if (ended) return ended;
    const r = enableRefusal(res);
    refresh();
    return failState(r.message, { lines: r.lines, ...(r.link ? { link: r.link } : {}) });
  }
  refresh();
  return okState(WS_EXTERNAL_MESSAGES.externalAccessEnabled, { lines: [WS_EXTERNAL_MESSAGES.connectAnAppBelowYou] });
}

export async function disableExternalAction(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  const s = await human(); if (!s || "ok" in s) return s;
  const res = await meGw<{ disabled: boolean }>(s.key, "/api/v1/me/external/disable", { method: "POST", body: {} });
  invalidateExternal(s.key);
  if (!res.ok) return (await endedState(res)) ?? failState(res.message);
  refresh();
  return okState(res.data.disabled ? WS_EXTERNAL_MESSAGES.externalAccessDisabled : WS_EXTERNAL_MESSAGES.externalAccessWasAlreadyDisabled,
    { lines: res.data.disabled ? [WS_EXTERNAL_MESSAGES.allExternalConnectionsHaveStopped] : [] });
}

export async function revokeAllExternalAction(_prev: ActionState, _formData: FormData): Promise<ActionState> {
  const s = await human(); if (!s || "ok" in s) return s;
  const res = await meGw<{ revoked: number }>(s.key, "/api/v1/me/external/revoke-all", { method: "POST", body: {} });
  invalidateExternal(s.key);
  if (!res.ok) return (await endedState(res)) ?? failState(res.message);
  refresh();
  return okState(res.data.revoked ? WS_EXTERNAL_MESSAGES.connectionsDisconnected(res.data.revoked) : WS_EXTERNAL_MESSAGES.thereWereNoActiveExternal,
    { lines: [WS_EXTERNAL_MESSAGES.externalAccessIsStillEnabled] });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function seenExternalNoticesAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const s = await human(); if (!s || "ok" in s) return s;
  const ids = [...new Set(formData.getAll("id").map(String).filter((x) => UUID_RE.test(x)))].slice(0, 50);
  if (!ids.length) return failState(WS_EXTERNAL_MESSAGES.noNotices);
  const res = await meGw<{ seen: number }>(s.key, "/api/v1/me/external/notices/seen", { method: "POST", body: { ids } });
  invalidateExternal(s.key);
  if (!res.ok) return (await endedState(res)) ?? failState(res.message);
  refresh();
  return okState(WS_EXTERNAL_MESSAGES.markedAsSeen);
}
