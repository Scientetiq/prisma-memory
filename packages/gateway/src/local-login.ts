import type { Context, Hono } from "hono";
import { log, newId, notFound, tx } from "@memory/shared";
import { audit } from "./audit.ts";
import { personCols, workplaceClientAddress } from "./auth.ts";
import type { App, PersonRow } from "./context.ts";
import { ADDRESS_IN_FLIGHT_MAX, FailureWindow, IN_FLIGHT_RETRY_SEC } from "./failure-window.ts";
import { healthState } from "./health.ts";
import { sessionCallerOf, sockAddr } from "./ldap-login.ts";
import { findForSignIn, LocalAccountsBusy, PASSWORD_MAX, verifyLocalPassword } from "./local-accounts.ts";
import { localLoginLimited, localLoginMessage } from "./local-login.messages.ts";
import { createSession } from "./user-sessions.ts";
import { fromWorkplace } from "./workplace.ts";

export const LOCAL_LOGIN_PATH = "/api/v1/auth/local";
export const LOCAL_ADDRESS_IN_FLIGHT = 4;
export const localLoginFailures = new FailureWindow(15 * 60_000);

const LOGIN_MAX = 200;

export async function localAccountsUsable(app: App): Promise<boolean> {
  try {
    const { rows } = await app.db.control.query<{ usable: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM local_credentials WHERE instance_id = $1 AND disabled_at IS NULL) AS usable`,
      [app.instanceId],
    );
    return rows[0]?.usable === true;
  } catch {
    return false;
  }
}

function withinLimit(value: string, limit: number): boolean {
  return value.length > 0 && value.length <= 2 * limit && [...value].length <= limit;
}

export function registerLocalLogin(r: Hono<any>, app: App, remoteOf: (c: Context) => string | null,
                                   seam?: { beforeIssue?: (personId: string) => Promise<void> }): void {
  r.post("/api/v1/auth/local", async (c) => {
    const sock = sockAddr(remoteOf(c));
    if (!(await fromWorkplace(app, sock))) return c.json({ code: "forbidden", message: localLoginMessage("workplace_only") }, 403);
    if ((await healthState(app)).status === "fail_closed") return c.json({ code: "internal", message: localLoginMessage("internal") }, 503);
    if (!(await localAccountsUsable(app))) throw notFound();

    const ip = await workplaceClientAddress(app, (header) => c.req.header(header), sock);
    const body = await c.req.json().catch(() => null);
    const name = typeof body?.login === "string" ? body.login.trim().toLowerCase() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!withinLimit(name, LOGIN_MAX) || !withinLimit(password, PASSWORD_MAX)) {
      return c.json({ code: "invalid_argument", message: localLoginMessage("bad_request") }, 400);
    }

    const loginKey = `ll:${name}`;
    const addressKey = `la:${ip ?? "?"}`;
    const queueKey = `lq:${ip ?? "?"}`;
    const details = { reason: "local_login", login: name };
    const limit = async (wait: number, reason?: "in_flight" | "busy") => {
      const extra = reason ? { reason } : {};
      await audit(app, null, { event_type: "rate_limited", details: { ...details, ...(reason ? { [reason]: true } : {}) }, ip });
      c.header("Retry-After", String(wait));
      return c.json({
        code: "rate_limited", message: reason ? localLoginMessage(reason) : localLoginLimited(Math.ceil(wait / 60)), retry_after: wait, ...extra,
      }, 429);
    };
    const reservation = localLoginFailures.reserve([
      [loginKey, 10], [addressKey, 20, ADDRESS_IN_FLIGHT_MAX], [queueKey, LOCAL_ADDRESS_IN_FLIGHT],
    ]);
    if ("wait" in reservation) return limit(reservation.wait, reservation.inFlight ? "in_flight" : undefined);

    const reject = async (status: 401 | 503, code: string, message: string, result: string, extra: Record<string, unknown> = {}) => {
      await audit(app, null, { event_type: "auth_failure", details: { ...details, result, ...extra }, ip });
      return c.json({ code, message }, status);
    };
    let stage = "lookup";
    let sessionId: string | undefined;
    try {
      const account = await findForSignIn(app.db.control, app.instanceId, name);
      stage = "verify";
      const verified = await verifyLocalPassword(password, account?.record ?? null);
      if (!account || account.disabled || !account.active || account.record === null || !verified) {
        const result = !account ? "unknown_login"
          : account.disabled ? "disabled"
          : !account.active ? "person_inactive"
          : account.record === null ? "no_password" : "wrong_password";
        localLoginFailures.record([loginKey, addressKey]);
        reservation.release();
        return await reject(401, "unauthorized", localLoginMessage("invalid"), result);
      }
      localLoginFailures.clear([loginKey]);
      reservation.release();

      stage = "person";
      const { rows: [person] } = await app.db.control.query<PersonRow>(
        `SELECT ${personCols()} FROM people WHERE id = $1 AND instance_id = $2`,
        [account.personId, app.instanceId],
      );
      if (!person) throw new Error();

      const id = newId();
      sessionId = id;
      const caller = sessionCallerOf(person, id, ip, new Date().toISOString());
      stage = "audit";
      try {
        await audit(app, caller, { event_type: "admin", details: { op: "login", source: "local", session_id: id }, ip }, { strict: true });
      } catch {
        return c.json({ code: "internal", message: localLoginMessage("audit_down") }, 503);
      }

      stage = "issue";
      await seam?.beforeIssue?.(person.id);
      const issued = await tx(app.db.control, async (q) => {
        const { rows: [current] } = await q.query<PersonRow>(
          `SELECT ${personCols("p")}
           FROM people p
           JOIN local_credentials c ON c.person_id = p.id AND c.instance_id = p.instance_id
           WHERE p.id = $1 AND p.instance_id = $2 AND p.active
             AND c.disabled_at IS NULL AND c.password_hash = $3
           FOR SHARE OF c, p`,
          [person.id, app.instanceId, account.record],
        );
        if (!current) return null;
        const session = await createSession(app, person.id, "local", {
          id, ip, userAgent: c.req.header("x-memory-client-ua") ?? null, q, authTime: "now",
        });
        return { session, login: current.login };
      });
      if (!issued) return await reject(503, "login_policy_changed", localLoginMessage("changed"), "changed", { session_id: id });

      const { session } = issued;
      return c.json({
        token: session.token, session: { id: session.id, expires_at: session.expires_at, source: session.source },
        person: { id: person.id, login: issued.login, created: false },
      }, 201);
    } catch (error) {
      reservation.release();
      if (stage === "verify" && error instanceof LocalAccountsBusy) return limit(IN_FLIGHT_RETRY_SEC, "busy");
      const extra = { stage, ...(sessionId ? { session_id: sessionId } : {}) };
      log.error("local_login_internal", { login: name, ...extra });
      return reject(503, "internal", localLoginMessage("internal"), "internal", extra);
    } finally {
      reservation.release();
    }
  });
}
