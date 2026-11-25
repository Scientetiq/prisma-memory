import type { Context, Hono, MiddlewareHandler } from "hono";
import type pg from "pg";
import { alertCodeInfo, log, raiseAlert, tx } from "@memory/shared";
import { secondSignatureOn } from "./admin-plane/approvals.ts";
import { BREAKGLASS_ONLY, ROLE_FORBIDDEN } from "./admin-plane/responses.ts";
import { audit } from "./audit.ts";
import type { App, Caller } from "./context.ts";
import { localAccountsMessage } from "./local-accounts-admin.messages.ts";
import { localAccountsManageMessage } from "./local-accounts-manage.messages.ts";
import { clearLocalPassword, issueLink, type LinkKind } from "./local-accounts.ts";
import { revokePersonConnections } from "./oauth.ts";
import { operatorOf } from "./operator.ts";
import { isUuidParam } from "./paging.ts";
import { endPersonSessions } from "./user-sessions.ts";

type RouteEnv = { Variables: { caller: Caller } };
type AdminAudit = (c: Context<any>, op: string, details?: Record<string, unknown>) => Promise<void>;
type ResetRefusal = "security_mode_advanced" | "account_disabled" | "person_inactive" | "directory_person";
type Change = "local_account_reset" | "local_account_disable";
type AccountListRow = {
  id: string;
  login: string;
  display_name: string;
  active: boolean;
  has_password: boolean;
  password_set_at: Date | null;
  disabled_at: Date | null;
  created_at: Date;
} & (
  { link_id: null; link_kind: null; link_expires_at: null } |
  { link_id: string; link_kind: LinkKind; link_expires_at: Date }
);

const missing = (c: Context) => c.json({ code: "not_found", message: localAccountsManageMessage("no_account") }, 404);
const conflict = (c: Context, code: ResetRefusal) => c.json({ code, message: localAccountsMessage(code) }, 409);
const internal = (c: Context, personId: string, stage: Change) => {
  log.error("local_account_manage_internal", { person: personId, stage });
  return c.json({ code: "internal", message: localAccountsManageMessage("internal") }, 503);
};

// The compatibility listener mounts this router without the admin-plane route gate.
const memoryAdmin: MiddlewareHandler<RouteEnv> = async (c, next) => {
  const caller = c.get("caller");
  if (caller.admin?.role !== "memory_admin") return c.json(ROLE_FORBIDDEN, 403);
  await next();
};

async function lockAccount(q: pg.PoolClient, instanceId: string, personId: string) {
  const { rows: [account] } = await q.query<{ has_password: boolean; disabled_at: Date | null; login: string; active: boolean }>(
    "SELECT c.password_hash IS NOT NULL AS has_password, c.disabled_at, p.login, p.active FROM local_credentials c JOIN people p ON p.id = c.person_id AND p.instance_id = c.instance_id WHERE c.instance_id = $1 AND c.person_id = $2 FOR UPDATE OF c",
    [instanceId, personId],
  );
  return account;
}

export function registerLocalAccountsManage(r: Hono<any>, app: App, adminAudit: AdminAudit,
                                            seam?: { revokeConnections?: (personId: string) => Promise<number> }): void {
  const { instanceId } = app;

  async function revokeConnections(c: Context<RouteEnv>, id: string, reason: Change): Promise<"revoked" | "not_revoked"> {
    try {
      if (seam?.revokeConnections) await seam.revokeConnections(id);
      else await revokePersonConnections(app, id);
      return "revoked";
    } catch {
      log.error("local_account_connections_not_revoked", { person: id, stage: "revoke_connections", reason });
      await audit(app, c.get("caller"), { event_type: "auth_failure", details: {
        reason, result: "connections_not_revoked", person: id,
      } });
      return "not_revoked";
    }
  }

  r.get("/local-accounts", memoryAdmin, async (c) => {
    const { rows } = await app.db.control.query<AccountListRow>(
      `SELECT p.id, p.login, p.display_name, p.active,
       c.password_hash IS NOT NULL AS has_password, c.password_set_at, c.disabled_at, c.created_at,
       l.id AS link_id, l.kind AS link_kind, l.expires_at AS link_expires_at
FROM local_credentials c
JOIN people p ON p.id = c.person_id AND p.instance_id = c.instance_id
LEFT JOIN LATERAL (
  SELECT id, kind, expires_at FROM auth_links
  WHERE instance_id = c.instance_id AND person_id = c.person_id AND kind IN ('invite', 'reset')
    AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
  ORDER BY issued_at DESC LIMIT 1
) l ON true
WHERE c.instance_id = $1
ORDER BY lower(p.login), p.id
LIMIT 501`, [instanceId],
    );
    const items = rows.slice(0, 500).map((row) => ({
      person: { id: row.id, login: row.login, display_name: row.display_name, active: row.active },
      has_password: row.has_password,
      password_set_at: row.password_set_at?.toISOString() ?? null,
      disabled_at: row.disabled_at?.toISOString() ?? null,
      created_at: row.created_at.toISOString(),
      link: row.link_id === null ? null : { id: row.link_id, kind: row.link_kind, expires_at: row.link_expires_at.toISOString() },
    }));
    return c.json({ items, truncated: rows.length > 500 });
  });

  r.post("/local-accounts/:id/reset", memoryAdmin, async (c) => {
    if (c.get("caller").admin?.breakglassWindowId) return c.json(BREAKGLASS_ONLY, 403);
    if (secondSignatureOn(app)) return conflict(c, "security_mode_advanced");
    const id = c.req.param("id");
    if (!isUuidParam(id)) return missing(c);

    let result;
    try {
      const issuedBy = c.get("caller").admin?.personId ?? (await operatorOf(app, c)).person?.id ?? null;
      result = await tx(app.db.control, async (q) => {
        const account = await lockAccount(q, instanceId, id);
        if (!account) return "not_found" as const;
        if (account.disabled_at) return "account_disabled" as const;
        if (!account.active) return "person_inactive" as const;
        const directory = await q.query(
          "SELECT 1 FROM person_identities WHERE person_id = $1 AND active AND system IN ('ad', 'sso') LIMIT 1", [id],
        );
        if (directory.rowCount) return "directory_person" as const;
        if (!await clearLocalPassword(q, instanceId, id)) throw new Error();
        const ended_sessions = await endPersonSessions(app, [id], "end_all", q);
        const kind = "reset";
        const link = await issueLink(q, { instanceId, personId: id, kind, issuedBy });
        return { person: { id, login: account.login }, link: { id: link.id, kind, expires_at: link.expiresAt, value: link.plain }, ended_sessions };
      });
    } catch {
      return internal(c, id, "local_account_reset");
    }
    if (result === "not_found") return missing(c);
    if (typeof result === "string") return conflict(c, result);

    const { person, link, ended_sessions } = result;
    await adminAudit(c, "local_account_reset", {
      person: person.id, login: person.login, link_id: link.id, expires_at: link.expires_at, ended_sessions,
    });
    const agent_connections = await revokeConnections(c, id, "local_account_reset");
    const code = "identity_links_changed";
    await raiseAlert({ control: app.db.control, audit: app.db.audit }, {
      instanceId, level: "high", code, summary: alertCodeInfo(code)?.title ?? code,
      details: { person: person.id, system: "local", action: "local_account_reset" },
    });
    c.header("Cache-Control", "no-store");
    return c.json({ ...result, agent_connections }, 201);
  });

  r.post("/local-accounts/:id/disable", memoryAdmin, async (c) => {
    const id = c.req.param("id");
    if (!isUuidParam(id)) return missing(c);

    let result;
    try {
      result = await tx(app.db.control, async (q) => {
        const account = await lockAccount(q, instanceId, id);
        if (!account) return null;
        const person = { id, login: account.login };
        if (account.disabled_at) {
          return { person, disabled_at: account.disabled_at.toISOString(), revoked_links: 0, ended_sessions: 0, already: true };
        }
        const { rows: [disabled] } = await q.query<{ disabled_at: Date }>(
          "UPDATE local_credentials SET disabled_at = now() WHERE instance_id = $1 AND person_id = $2 AND disabled_at IS NULL RETURNING disabled_at",
          [instanceId, id],
        );
        if (!disabled) throw new Error();
        const links = await q.query(
          "UPDATE auth_links SET revoked_at = now() WHERE instance_id = $1 AND person_id = $2 AND kind IN ('invite', 'reset') AND used_at IS NULL AND revoked_at IS NULL",
          [instanceId, id],
        );
        const sessions = await q.query(
          "UPDATE user_sessions SET ended_at = now(), ended_reason = 'deactivated' WHERE person_id = $2 AND instance_id = $1 AND source = 'local' AND ended_at IS NULL",
          [instanceId, id],
        );
        return { person, disabled_at: disabled.disabled_at.toISOString(), revoked_links: links.rowCount ?? 0,
          ended_sessions: sessions.rowCount ?? 0, already: false };
      });
    } catch {
      return internal(c, id, "local_account_disable");
    }
    if (!result) return missing(c);

    const { person, revoked_links, ended_sessions, already } = result;
    if (!already) await adminAudit(c, "local_account_disable", { person: person.id, login: person.login, revoked_links, ended_sessions });
    const agent_connections = await revokeConnections(c, id, "local_account_disable");
    return c.json({ ...result, agent_connections }, 200);
  });
}
