import type { Context, Hono } from "hono";
import { alertCodeInfo, log, newId, personId, raiseAlert, tx } from "@memory/shared";
import { ensurePersonalSpace } from "./access.ts";
import { secondSignatureOn } from "./admin-plane/approvals.ts";
import { BREAKGLASS_ONLY, ROLE_FORBIDDEN } from "./admin-plane/responses.ts";
import { audit } from "./audit.ts";
import { workplaceClientAddress } from "./auth.ts";
import type { App, Caller } from "./context.ts";
import { FailureWindow, IN_FLIGHT_RETRY_SEC } from "./failure-window.ts";
import { healthState } from "./health.ts";
import { sockAddr } from "./ldap-login.ts";
import { consumeLink, createCredential, hashLocalPassword, issueLink, LocalAccountsBusy, PASSWORD_MAX, passwordProblem,
  peekLink, setLocalPassword, type PasswordProblem } from "./local-accounts.ts";
import { localAccountsMessage } from "./local-accounts-admin.messages.ts";
import { localLoginLimited, localLoginMessage } from "./local-login.messages.ts";
import { revokePersonConnections } from "./oauth.ts";
import { operatorOf } from "./operator.ts";
import { grantPendingMeetings } from "./participants.ts";
import { grantSpaceInvites } from "./space-people.ts";
import { endPersonSessions } from "./user-sessions.ts";
import { fromWorkplace } from "./workplace.ts";

type AdminAudit = (c: Context<any>, op: string, details?: Record<string, unknown>) => Promise<void>;
type CreateRefusal = "security_mode_advanced" | "directory_person" | "account_exists" | "account_disabled" | "person_inactive" | "login_case_conflict";
const LOCAL_SETUP_PATH = "/api/v1/auth/local/setup";
const setupFailures = new FailureWindow(15 * 60_000);
const LOGIN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL = /\p{Cc}/u;

function atMost(value: string, max: number): boolean {
  return value.length <= max || (value.length <= 2 * max && [...value].length <= max);
}

export function registerLocalAccountsAdmin(r: Hono<any>, app: App, adminAudit: AdminAudit): void {
  r.post("/local-accounts", async (c) => {
    // The compatibility listener mounts this router without the admin-plane route gate.
    const caller = c.get("caller") as Caller;
    if (caller.admin?.role !== "memory_admin") return c.json(ROLE_FORBIDDEN, 403);
    if (caller.admin?.breakglassWindowId) return c.json(BREAKGLASS_ONLY, 403);
    const conflict = (code: CreateRefusal) => c.json({ code, message: localAccountsMessage(code) }, 409);
    if (secondSignatureOn(app)) return conflict("security_mode_advanced");

    const body = await c.req.json<{ login?: unknown; display_name?: unknown }>().catch(() => null);
    const login = typeof body?.login === "string" ? body.login.trim().toLowerCase() : "";
    const name = typeof body?.display_name === "string" ? body.display_name.trim() : "";
    if (!atMost(login, 200) || CONTROL.test(login) || !LOGIN.test(login)) {
      return c.json({ code: "invalid_argument", message: localAccountsMessage("bad_login") }, 400);
    }
    if (!name || !atMost(name, 200) || CONTROL.test(name)) {
      return c.json({ code: "invalid_argument", message: localAccountsMessage("bad_name") }, 400);
    }

    const { instanceId } = app;
    const issuedBy = c.get("caller").admin?.personId ?? (await operatorOf(app, c)).person?.id ?? null;
    const result = await tx(app.db.control, async (q) => {
      // Serialize requests for a login even before there is a person row to lock.
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended('local-account-login:' || $1::text || ':' || $2::text, 0))", [instanceId, login]);
      const { rows: matches } = await q.query<{ id: string; login: string }>(
        "SELECT id, login FROM people WHERE instance_id = $1 AND lower(login) = $2 LIMIT 2", [instanceId, login],
      );
      const [existing] = matches;
      if (matches.length > 1 || (existing && existing.login !== login)) return "login_case_conflict" as const;

      let id: string;
      let hasAccount = false;
      if (existing) {
        id = existing.id;
        // Setup takes this lock before spending the link, so the password check and reissue cannot race it.
        const { rows: [card] } = await q.query<{ active: boolean; login: string }>(
          "SELECT active, login FROM people WHERE id = $1 AND instance_id = $2 FOR UPDATE", [id, instanceId],
        );
        if (!card || card.login !== login) throw new Error();
        if (!card.active) return "person_inactive" as const;
        const directory = await q.query(
          "SELECT 1 FROM person_identities WHERE person_id = $1 AND active AND system IN ('ad', 'sso') LIMIT 1", [id],
        );
        if (directory.rowCount) return "directory_person" as const;
        const { rows: [account] } = await q.query<{ password_hash: string | null; disabled_at: Date | null }>(
          "SELECT password_hash, disabled_at FROM local_credentials WHERE person_id = $1 AND instance_id = $2 FOR UPDATE", [id, instanceId],
        );
        if (account?.disabled_at) return "account_disabled" as const;
        if (account?.password_hash) return "account_exists" as const;
        hasAccount = Boolean(account);
      } else {
        const derived = personId(login);
        id = (await q.query("SELECT 1 FROM people WHERE id = $1", [derived])).rowCount ? newId() : derived;
        await q.query(
          "INSERT INTO people (id, login, employee_id, display_name, department, instance_id, active, attrs) VALUES ($1,$2,$3,$4,$5,$6,true,$7)",
          [id, login, null, name, null, instanceId, JSON.stringify({ source: "local" })],
        );
        await ensurePersonalSpace(q, instanceId, id, login, name);
      }

      if (!hasAccount && !await createCredential(q, { instanceId, personId: id, createdBy: issuedBy ?? "memory_admin" })) {
        throw new Error();
      }
      const kind = "invite";
      const link = await issueLink(q, { instanceId, personId: id, kind, issuedBy });
      return { person: { id, login, created: !existing }, link: { id: link.id, kind, expires_at: link.expiresAt, value: link.plain } };
    });
    if (typeof result === "string") return conflict(result);

    const { person, link } = result;
    await adminAudit(c, "local_account_create", {
      person: person.id, display_name: name, created: person.created, link_id: link.id, expires_at: link.expires_at,
    });
    const code = "identity_links_changed";
    await raiseAlert({ control: app.db.control, audit: app.db.audit }, {
      instanceId, level: "high", code, summary: alertCodeInfo(code)?.title ?? code,
      details: { person: person.id, system: "local", action: "local_account_create" },
    });
    if (person.created) {
      const people = [{ id: person.id, login }];
      await grantPendingMeetings(app, people, "local_account_create", null);
      await grantSpaceInvites(app, people, "local_account_create");
    }
    c.header("Cache-Control", "no-store");
    return c.json(result, 201);
  });
}

class InvalidSetupLink extends Error {}
class SetupAuditUnavailable extends Error {}

export function registerLocalSetup(r: Hono<any>, app: App, remoteOf: (c: Context) => string | null,
                                   seam?: { beforeSpend?: (personId: string) => Promise<void> }): void {
  r.post(LOCAL_SETUP_PATH, async (c) => {
    const sock = sockAddr(remoteOf(c));
    if (!(await fromWorkplace(app, sock))) return c.json({ code: "forbidden", message: localLoginMessage("workplace_only") }, 403);
    const internal = (message = localLoginMessage("internal")) => c.json({ code: "internal", message }, 503);
    if ((await healthState(app)).status === "fail_closed") return internal();

    const body = await c.req.json<{ link?: unknown; password?: unknown }>().catch(() => null);
    if (typeof body?.link !== "string" || typeof body?.password !== "string") {
      return c.json({ code: "invalid_argument", message: localAccountsMessage("setup_bad_request") }, 400);
    }
    const { link, password } = body;
    const linkFits = atMost(link, 1024);
    const passwordRejected = (reason: PasswordProblem) =>
      c.json({ code: "password_rejected", reason, message: localAccountsMessage(reason) }, 400);
    if (!atMost(password, PASSWORD_MAX)) return passwordRejected("too_long");

    const ip = await workplaceClientAddress(app, (header) => c.req.header(header), sock);
    const key = "ls:" + (ip ?? "?");
    const limit = (wait: number, busy = false) => {
      c.header("Retry-After", String(wait));
      return c.json({
        code: "rate_limited", message: busy ? localLoginMessage("busy") : localLoginLimited(Math.ceil(wait / 60)),
        retry_after: wait,
      }, 429);
    };
    const reservation = setupFailures.reserve([[key, 20]]);
    if ("wait" in reservation) return limit(reservation.wait, reservation.inFlight);
    const invalid = () => {
      setupFailures.record([key]);
      return c.json({ code: "link_invalid", message: localAccountsMessage("link_invalid") }, 400);
    };

    try {
      const { instanceId } = app;
      const ctl = app.db.control;
      const invitation = linkFits ? await peekLink(ctl, instanceId, link) : null;
      if (!invitation) return invalid();

      const { personId } = invitation;
      const { rows: [account] } = await ctl.query<{ login: string; disabled_at: Date | null }>(
        "SELECT p.login, a.disabled_at FROM people p JOIN local_credentials a ON a.person_id = p.id AND a.instance_id = p.instance_id " +
        "WHERE p.id = $1 AND p.instance_id = $2 AND p.active", [personId, instanceId],
      );
      if (!account || account.disabled_at) return invalid();
      const { login } = account;
      const problem = passwordProblem(password, login);
      if (problem) return passwordRejected(problem);

      const record = await hashLocalPassword(password);
      await seam?.beforeSpend?.(personId);
      await tx(ctl, async (q) => {
        const card = await q.query(
          "SELECT 1 FROM people WHERE id = $1 AND instance_id = $2 AND login = $3 AND active FOR UPDATE", [personId, instanceId, login],
        );
        if (!card.rowCount) throw new InvalidSetupLink();
        const spent = await consumeLink(q, instanceId, link);
        if (!spent || spent.personId !== personId) throw new InvalidSetupLink();
        if (!await setLocalPassword(q, instanceId, personId, record)) throw new InvalidSetupLink();
        await endPersonSessions(app, [personId], "end_all", q);
        try {
          await audit(app, null, { event_type: "admin", ip, details: {
            op: "local_password_set", person: personId, link_id: spent.id, kind: spent.kind,
          } }, { strict: true });
        } catch {
          throw new SetupAuditUnavailable();
        }
      });

      try {
        await revokePersonConnections(app, personId);
      } catch {
        log.error("local_setup_connections_not_revoked", { person: personId });
        await audit(app, null, { event_type: "auth_failure", ip, details: {
          reason: "local_setup", result: "connections_not_revoked", person: personId,
        } });
      }
      return c.json({ ok: true, login }, 200);
    } catch (error) {
      if (error instanceof InvalidSetupLink) return invalid();
      if (error instanceof SetupAuditUnavailable) return internal(localLoginMessage("audit_down"));
      if (error instanceof LocalAccountsBusy) return limit(IN_FLIGHT_RETRY_SEC, true);
      log.error("local_setup_internal");
      return internal();
    } finally {
      reservation.release();
    }
  });
}
