// One caller check shared by the outer route gate and the own-factor handlers.
import type { Context } from "hono";
import type { App, Caller } from "../context.ts";
import { adminLoginOf } from "../operator.ts";
import { verifySession } from "../session.ts";

export function localTotpLogin(app: App, c: Context): string | null {
  const who = c.get("caller") as Caller | undefined, a = who?.admin;
  if (who?.principalType !== "system") return null;
  if (a?.sessionId) return a.authMethod === "local" || a.authMethod === "local_breakglass" ? a.localLogin ?? null : null;
  if (a && a.authMethod !== "legacy_session") return null;
  const token = /^Bearer\s+(mem_adm_\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
  const s = token ? verifySession(app, token) : null;
  return s && s.login === adminLoginOf(c) ? s.login : null;
}
