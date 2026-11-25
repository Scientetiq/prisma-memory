"use server";

import { headers } from "next/headers";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { call, GatewayError } from "@/lib/gateway";
import { linkFromHash } from "@/lib/local-link";
import { clientHeaders, loginFailureDetail } from "@/lib/workplace-login";
import { LOCAL_SETUP } from "@/messages/local-setup";

interface SetupResponse {
  ok?: unknown;
  code?: unknown;
  reason?: unknown;
  retry_after?: unknown;
}

function rejectedPassword(reason: unknown): string {
  switch (reason) {
    case "too_short": return LOCAL_SETUP.tooShort;
    case "too_long": return LOCAL_SETUP.tooLong;
    case "same_as_login": return LOCAL_SETUP.sameAsLogin;
    case "one_character": return LOCAL_SETUP.oneCharacter;
    case "common": return LOCAL_SETUP.common;
    default: return LOCAL_SETUP.rejected;
  }
}

function unavailable(status: number, code: unknown, link: string, password: string): ActionState {
  const safeCode = typeof code === "string" && !code.includes(link) && !code.includes(password) ? code : undefined;
  const detail = loginFailureDetail(status, { code: safeCode });
  return failState(LOCAL_SETUP.unavailable, detail ? { lines: [detail] } : {});
}

export async function setLocalPasswordAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const linkField = formData.get("link");
  const link = typeof linkField === "string" ? linkFromHash(linkField) : null;
  if (!link) return failState(LOCAL_SETUP.needsLink);

  const password = formData.get("password");
  const repeat = formData.get("repeat");
  if (typeof password !== "string" || !password || typeof repeat !== "string" || !repeat) {
    return failState(LOCAL_SETUP.enterBoth);
  }
  if (password !== repeat) return failState(LOCAL_SETUP.mismatch);

  const extra = clientHeaders(await headers());
  let response;
  try {
    response = await call("/api/v1/auth/local/setup", {
      method: "POST",
      body: { link, password },
      headers: extra,
      timeoutMs: 60_000,
    });
  } catch (error) {
    if (error instanceof GatewayError) return unavailable(error.status, error.code, link, password);
    throw error;
  }

  const body = response.data as SetupResponse | null;
  if (response.status === 200 && body?.ok === true) return okState(LOCAL_SETUP.done);
  if (response.status === 400) {
    if (body?.code === "link_invalid") return failState(LOCAL_SETUP.linkInvalid);
    if (body?.code === "password_rejected") return failState(rejectedPassword(body.reason));
    return failState(LOCAL_SETUP.enterBoth);
  }
  if (response.status === 429) {
    if (body?.reason === "busy") return failState(LOCAL_SETUP.busy);
    const seconds = typeof body?.retry_after === "number" ? body.retry_after : response.retryAfter ?? 0;
    return failState(LOCAL_SETUP.limited(Math.max(1, Math.ceil(seconds / 60))));
  }
  if (response.status === 404) return failState(LOCAL_SETUP.off);
  return unavailable(response.status, body?.code, link, password);
}
