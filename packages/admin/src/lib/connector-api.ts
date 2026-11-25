import "server-only";
import { redirect } from "next/navigation";
import { call, GatewayError, toGatewayError } from "./gateway";
import type { ApiInit } from "./api";
import { clearSessionCookie, requireSession } from "./session";

// Preserve the connector contract's top-level reason: the shared client exposes only code/message/details.
export async function connectorGw<T>(path: string, init: ApiInit = {}): Promise<T> {
  const session = await requireSession();
  const { status, data } = await call(path, { ...init, token: session.token });
  if (status === 401) { await clearSessionCookie(); redirect("/admin/login?expired=1"); }
  if (status >= 400) {
    const e = toGatewayError(status, data);
    const reason = data && typeof data === "object" && "reason" in data ? data.reason : undefined;
    throw new GatewayError(status, e.code, e.message, { reason, problems: (e.details as { problems?: unknown } | undefined)?.problems });
  }
  return data as T;
}
