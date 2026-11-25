import type { Hono } from "hono";
import { log, tx } from "@memory/shared";
import { audit } from "./audit.ts";
import type { App, Caller } from "./context.ts";
import { FailureWindow } from "./failure-window.ts";
import { hashLocalPassword, LocalAccountsBusy, passwordProblem, setLocalPassword, verifyLocalPassword } from "./local-accounts.ts";
import { localPasswordMessage } from "./local-password-change.messages.ts";
import { isHumanSession } from "./workplace.ts";

export const LOCAL_PASSWORD_PATH = "/api/v1/me/local-password";
export const localPasswordFailures = new FailureWindow(15 * 60_000);

const accountSql = "SELECT password_hash AS record, disabled_at IS NOT NULL AS disabled FROM local_credentials WHERE instance_id = $1 AND person_id = $2";
type AccountRow = { record: string | null; disabled: boolean };
class AccountChanged extends Error {}

function validPasswordField(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024;
}

export function registerLocalPasswordChange(r: Hono<any>, app: App, seam?: { beforeStore?: (personId: string) => Promise<void> }): void {
  // The OpenAPI validator reads route literals.
  r.post("/api/v1/me/local-password" satisfies typeof LOCAL_PASSWORD_PATH, async (c) => {
    const caller = c.get("caller") as Caller;
    if (!isHumanSession(caller)) {
      return c.json({ code: "forbidden", message: localPasswordMessage("session_only") }, 403);
    }
    const person = caller.person!;
    const body = await c.req.json<{ current?: unknown; next?: unknown }>().catch(() => null);
    if (body === null || typeof body !== "object" || Array.isArray(body) || !validPasswordField(body.current) || !validPasswordField(body.next)) {
      return c.json({ code: "invalid_argument", message: localPasswordMessage("bad_request") }, 400);
    }
    const { current, next } = body;
    const instanceId = app.instanceId;
    const sessionId = caller.keyId;
    const key = "cp:" + person.id;
    const reason = "local_password_change";
    const slot = localPasswordFailures.reserve([[key, 5]]);
    if ("wait" in slot) {
      const { wait, inFlight } = slot;
      await audit(app, caller, { event_type: "rate_limited", details: { reason, person: person.id } });
      c.header("Retry-After", String(wait));
      const message = inFlight ? localPasswordMessage("in_flight") : localPasswordMessage("limited", Math.ceil(wait / 60));
      return c.json({ code: "rate_limited", message, retry_after: wait, ...(inFlight ? { reason: "in_flight" } : {}) }, 429);
    }

    const { release } = slot;
    const failureAudit = (result: "wrong_current" | "changed" | "internal") => audit(app, caller, {
      event_type: "auth_failure",
      details: { reason, result, person: person.id, ...(result === "wrong_current" ? {} : { session_id: sessionId }) },
    });
    let stage: "read" | "verify" | "policy" | "hash" | "audit" | "before_store" | "store" = "read";
    try {
      const { rows: [account] } = await app.db.control.query<AccountRow>(accountSql, [instanceId, person.id]);
      if (!account || account.disabled || account.record === null) {
        return c.json({ code: "not_found", message: localPasswordMessage("no_account") }, 404);
      }
      stage = "verify";
      if (!(await verifyLocalPassword(current, account.record))) {
        localPasswordFailures.record([key]);
        release();
        await failureAudit("wrong_current");
        return c.json({ code: "current_password_wrong", message: localPasswordMessage("wrong_current") }, 400);
      }
      stage = "policy";
      const problem = next === current ? "same_as_current" : passwordProblem(next, person.login);
      if (problem) {
        return c.json({ code: "password_rejected", reason: problem, message: localPasswordMessage(problem) }, 400);
      }

      stage = "hash";
      const newRecord = await hashLocalPassword(next);
      localPasswordFailures.clear([key]);
      release();
      stage = "audit";
      await audit(app, caller, { event_type: "admin", details: { op: reason, person: person.id, session_id: sessionId } }, { strict: true });
      stage = "before_store";
      await seam?.beforeStore?.(person.id);
      stage = "store";
      const ended = await tx(app.db.control, async (q) => {
        const { rows: [locked] } = await q.query<AccountRow>(accountSql + " FOR UPDATE", [instanceId, person.id]);
        if (!locked || locked.disabled || locked.record !== account.record) throw new AccountChanged();
        if (!(await setLocalPassword(q, instanceId, person.id, newRecord))) throw new AccountChanged();
        const { rowCount } = await q.query(
          "UPDATE user_sessions SET ended_at = now(), ended_reason = 'end_all' WHERE person_id = $1 AND instance_id = $2 AND id <> $3 AND ended_at IS NULL",
          [person.id, instanceId, sessionId],
        );
        return rowCount ?? 0;
      });
      return c.json({ ok: true, ended_sessions: ended }, 200);
    } catch (error) {
      release();
      if ((stage === "verify" || stage === "hash") && error instanceof LocalAccountsBusy) {
        c.header("Retry-After", "5");
        return c.json({ code: "rate_limited", message: localPasswordMessage("busy"), retry_after: 5, reason: "busy" }, 429);
      }
      if (error instanceof AccountChanged) {
        await failureAudit("changed");
        return c.json({ code: "account_changed", message: localPasswordMessage("changed") }, 409);
      }
      log.error("local_password_change", { person: person.id, stage });
      await failureAudit("internal");
      return c.json({ code: "internal", message: localPasswordMessage(stage === "audit" ? "audit_down" : "internal") }, 503);
    } finally {
      release();
    }
  });
}
