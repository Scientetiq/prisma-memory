"use server";

import { endedState } from "@/lib/action-ended";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { call, GatewayError, type CallResult } from "@/lib/gateway";
import { PREVIEW_TEXT } from "@/lib/preview";
import { actionSession } from "@/lib/user-session";
import { LOCAL_CHANGE } from "@/messages/local-change";

function rejectionText(reason: unknown): string {
  switch (reason) {
    case "same_as_current": return LOCAL_CHANGE.sameAsCurrent;
    case "too_short": return LOCAL_CHANGE.tooShort;
    case "too_long": return LOCAL_CHANGE.tooLong;
    case "same_as_login": return LOCAL_CHANGE.sameAsLogin;
    case "one_character": return LOCAL_CHANGE.oneCharacter;
    case "common": return LOCAL_CHANGE.common;
    default: return LOCAL_CHANGE.rejected;
  }
}

export async function changeLocalPasswordAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession();
  if ("ok" in session) return session;
  if (session.preview) return failState(PREVIEW_TEXT.previewDenied, { lines: [PREVIEW_TEXT.previewDeniedHint] });

  const current = formData.get("current");
  const next = formData.get("next");
  const repeat = formData.get("repeat");
  if (typeof current !== "string" || !current || typeof next !== "string" || !next || typeof repeat !== "string" || !repeat) {
    return failState(LOCAL_CHANGE.enterAll);
  }
  if (next !== repeat) return failState(LOCAL_CHANGE.mismatch);

  let result: CallResult;
  try {
    result = await call("/api/v1/me/local-password", { method: "POST", body: { current, next }, token: session.key });
  } catch (e) {
    if (!(e instanceof GatewayError)) throw e;
    const ended = endedState({ code: e.code });
    if (ended) return ended;
    return failState(LOCAL_CHANGE.unavailable, { lines: [e.code] });
  }

  const { status } = result;
  if (status === 401) return endedState({ code: "unauthorized" });
  const data = result.data as {
    ok?: unknown;
    ended_sessions?: unknown;
    code?: unknown;
    reason?: unknown;
    retry_after?: unknown;
  } | null;
  if (status === 200 && data?.ok === true) {
    const ended = typeof data.ended_sessions === "number" ? data.ended_sessions : 0;
    return okState(LOCAL_CHANGE.done(ended));
  }
  if (status === 400) {
    if (data?.code === "current_password_wrong") return failState(LOCAL_CHANGE.wrongCurrent);
    if (data?.code === "password_rejected") return failState(rejectionText(data.reason));
    return failState(LOCAL_CHANGE.enterAll);
  }
  if (status === 404) return failState(LOCAL_CHANGE.noAccount);
  if (status === 409) return failState(LOCAL_CHANGE.changed);
  if (status === 429) {
    if (data?.reason === "in_flight") return failState(LOCAL_CHANGE.inFlight);
    if (data?.reason === "busy") return failState(LOCAL_CHANGE.busy);
    const seconds = typeof data?.retry_after === "number" ? data.retry_after : 0;
    return failState(LOCAL_CHANGE.limited(Math.max(1, Math.ceil(seconds / 60))));
  }
  const code = typeof data?.code === "string" ? data.code : `HTTP ${status}`;
  return failState(LOCAL_CHANGE.unavailable, { lines: [code] });
}
