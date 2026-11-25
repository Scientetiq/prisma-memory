import "server-only";
import { redirect } from "next/navigation";
import { call, GatewayError, toGatewayError, type CallInit } from "./gateway";
import { clearSessionCookie, requireSession } from "./session";

export type ApiInit = Omit<CallInit, "token">;

export async function gw<T>(path: string, init: ApiInit = {}): Promise<T> {
  const session = await requireSession();
  const { status, data } = await call(path, { ...init, token: session.token });
  if (status === 401) {
    await clearSessionCookie();
    redirect("/admin/login?expired=1");
  }
  if (status >= 400) throw toGatewayError(status, data);
  return data as T;
}

export type Result<T> = { ok: true; data: T } | { ok: false; status: number; code: string; message: string };

export async function tryGw<T>(path: string, init: ApiInit = {}): Promise<Result<T>> {
  try {
    return { ok: true, data: await gw<T>(path, init) };
  } catch (e) {
    if (e instanceof GatewayError) return { ok: false, status: e.status, code: e.code, message: e.message };
    throw e;
  }
}
