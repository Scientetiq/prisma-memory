// Own-factor operations only: upstream authentication identifies the caller, this boundary selects its local account.
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { audit } from "./audit.ts";
import { NOT_FOUND_BODY } from "./channel.ts";
import type { App, Caller } from "./context.ts";
import { loginFailures, verifyAdminPasswordAsync } from "./session.ts";
import { fromWorkplace } from "./workplace.ts";
import { workplaceClientAddress } from "./auth.ts";
import { localTotpLogin } from "./admin-plane/local-totp-caller.ts";
import { currentListener } from "./admin-plane/listeners.ts";
import { adminClientIp } from "./admin-plane/middleware.ts";
import { confirmLocalTotp, disableLocalTotp, enrollLocalTotp, localTotpStatus, setLocalTotpSetupAvailable } from "./admin-plane/local-totp.ts";
import { revokeLocalSessions } from "./admin-plane/session.ts";

type Env = { Variables: { caller: Caller; factorLogin: string } };
export const localTotpBody = (b: unknown, keys: string[]): b is Record<string, unknown> =>
  !!b && typeof b === "object" && !Array.isArray(b) && Object.keys(b).every(k => keys.includes(k));

async function clientIp(app: App, c: Context): Promise<string> {
  if (currentListener()?.kind === "admin") return (await adminClientIp(app, c)) ?? "?";
  let sock = "?";
  try { sock = (getConnInfo(c).remote.address ?? "?").replace(/^::ffff:/, ""); } catch { /* unknown socket */ }
  return (await fromWorkplace(app, sock)) ? (await workplaceClientAddress(app, n => c.req.header(n), sock)) ?? sock : sock;
}

export function localTotpAdminRoutes(app: App): Hono<Env> {
  const r = new Hono<Env>();
  setLocalTotpSetupAvailable(true);
  r.use("/local-totp*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const login = localTotpLogin(app, c);
    if (!login) return c.json(NOT_FOUND_BODY, 404);
    c.set("factorLogin", login);
    await next();
  });
  r.use("/local-totp/*", bodyLimit({ maxSize: 64 * 1024, onError: c => c.json({ code: "too_large", message: "Request body is too large" }, 413) }));
  const invalid = (c: Context, reason = "invalid_body") => c.json({ code: "invalid_argument", reason, message: "Send only the required fields with their documented types and lengths" }, 400);
  const unavailable = (c: Context) => c.json({ code: "internal", reason: "factor_unavailable", message: "The second factor is unavailable; try again later" }, 503);
  const event = (c: Context<Env>, op: string, details: Record<string, unknown> = {}) =>
    audit(app, c.get("caller"), { event_type: "admin", details: { op, login: c.get("factorLogin"), ...details } }, { strict: true });

  r.get("/local-totp", async c => {
    if (!c.get("factorLogin")) return c.json(NOT_FOUND_BODY, 404);
    try { return c.json(await localTotpStatus(app, c.get("factorLogin"))); } catch { return unavailable(c); }
  });
  r.post("/local-totp/enroll", async c => {
    if (!c.get("factorLogin")) return c.json(NOT_FOUND_BODY, 404);
    const b = await c.req.json().catch(() => null);
    if (!localTotpBody(b, ["password"]) || typeof b.password !== "string" || b.password.length > 1024) return invalid(c);
    const login = c.get("factorLogin"), ip = await clientIp(app, c), slot = loginFailures.reserve(login, ip);
    if ("wait" in slot) {
      c.header("Retry-After", String(slot.wait));
      return c.json({ code: "rate_limited", message: "Too many password attempts; try again later", retry_after: slot.wait }, 429);
    }
    try {
      const u = (await app.db.control.query("SELECT password_hash FROM admin_users WHERE login=$1 AND instance_id=$2 AND disabled_at IS NULL", [login, app.instanceId])).rows[0];
      if (!await verifyAdminPasswordAsync(b.password, u?.password_hash ?? null)) {
        loginFailures.record(login, ip);
        await audit(app, c.get("caller"), { event_type: "auth_failure", details: { reason: "local_totp_enroll", login }, ip: ip === "?" ? null : ip });
        return c.json({ code: "unauthorized", reason: "bad_password", message: "The password is incorrect" }, 401);
      }
      const out = await enrollLocalTotp(app, login);
      if ("error" in out) return c.json({ code: "conflict", reason: out.error, message: "A second factor is already enrolled" }, 409);
      loginFailures.clear(login, ip);
      await event(c, "local_totp_enroll");
      return c.json(out);
    } catch { return unavailable(c); } finally { slot.release(); }
  });
  r.post("/local-totp/confirm", async c => {
    if (!c.get("factorLogin")) return c.json(NOT_FOUND_BODY, 404);
    const b = await c.req.json().catch(() => null);
    if (!localTotpBody(b, ["code"]) || typeof b.code !== "string" || b.code.length > 64) return invalid(c);
    try {
      const login = c.get("factorLogin"), sessionId = c.get("caller").admin?.sessionId ?? null;
      const out = await confirmLocalTotp(app, login, b.code, { beforeWrite: async control => {
        const revoked = await revokeLocalSessions(app, login, { exceptSessionId: sessionId, control });
        await event(c, "local_totp_confirm", { revoked });
      } });
      if ("error" in out) {
        if (out.error === "bad_code") await audit(app, c.get("caller"), { event_type: "auth_failure", details: { reason: "local_totp_confirm", login } });
        return c.json({ code: "invalid_argument", reason: out.error, message: out.error === "code_expired" ? "The enrollment expired; start again" : "The authenticator code is incorrect" }, 400);
      }
      return c.json({ ...out, signed_out: !sessionId });
    } catch { return unavailable(c); }
  });
  r.post("/local-totp/disable", async c => {
    if (!c.get("factorLogin")) return c.json(NOT_FOUND_BODY, 404);
    const b = await c.req.json().catch(() => null);
    if (!localTotpBody(b, ["code"]) || typeof b.code !== "string" || b.code.length > 64) return invalid(c);
    try {
      const out = await disableLocalTotp(app, c.get("factorLogin"), b.code, { beforeWrite: () => event(c, "local_totp_disable") });
      if (!("error" in out)) return c.json(out);
      if (out.error === "unavailable") return unavailable(c);
      if (out.error === "required") return c.json({ code: "conflict", reason: "required", message: "A second factor is required by the installation policy" }, 409);
      if (out.error === "locked") {
        const wait = out.retryAfter ?? 900; c.header("Retry-After", String(wait));
        return c.json({ code: "rate_limited", reason: "factor_locked", message: "The second factor is temporarily locked", retry_after: wait }, 429);
      }
      await audit(app, c.get("caller"), { event_type: "auth_failure", details: { reason: "local_totp_disable", login: c.get("factorLogin") } });
      return c.json({ code: "unauthorized", reason: "bad_code", message: "The code is incorrect or has already been used" }, 401);
    } catch { return unavailable(c); }
  });
  return r;
}
