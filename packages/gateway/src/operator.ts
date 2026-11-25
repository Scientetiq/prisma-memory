// Who works under the local administrator: the local admin login is linked to the card
// of a specific person. Extended access needs the link: preset 5 is confirmed by a superior manager, who must not
// be the person behind the local admin login; while there is no link, preset 5 cannot be given (operatorPerson → null).
// The link is set in the panel after the person signed in through the directory (an AD card); a change is a journal event with
// the old and the new person. The administrator's password and hash do not get here.
import type { Context, Hono } from "hono";
import { invalid, notFound, raiseAlert, tx } from "@memory/shared";
import { adminDb, adminPlaneConfigured } from "./admin-plane/db.ts";
import { endLocalLoginSessionsOnLinkChange } from "./admin-plane/session.ts";
import type { App } from "./context.ts";

type AdminAudit = (c: Context<any>, op: string, details?: Record<string, unknown>) => Promise<void>;

export interface OperatorPerson { id: string; login: string; display_name: string | null; department: string | null; active: boolean; demo: boolean; directory_linked: boolean }

const PERSON_SQL = `SELECT p.id, p.login, p.display_name, p.department, p.active, COALESCE(p.attrs->>'demo','') = 'true' AS demo,
       EXISTS (SELECT 1 FROM person_identities i WHERE i.person_id = p.id AND i.system = 'ad' AND i.active) AS directory_linked
  FROM people p`;

async function personById(app: App, id: string | null): Promise<OperatorPerson | null> {
  if (!id) return null;
  return ((await app.db.control.query(`${PERSON_SQL} WHERE p.id = $1`, [id])).rows[0] as OperatorPerson | undefined) ?? null;
}

/**
 * The person behind the local administrator — for the extended access rules: null if there is no link, the person is inactive
 * or it is a demo persona. Without a login — the only active administrator of the instance (there is only one).
 */
export async function operatorPerson(app: App, adminLogin?: string): Promise<OperatorPerson | null> {
  const { rows } = await app.db.control.query(
    "SELECT login, person_id FROM admin_users WHERE instance_id = $1 AND disabled_at IS NULL AND ($2::text IS NULL OR login = $2)", [app.instanceId, adminLogin ?? null]);
  if (rows.length !== 1) return null;
  const p = await personById(app, rows[0].person_id);
  return p && p.active && !p.demo ? p : null;
}

/** A person in the API answer — without the internal id. */
const view = (p: OperatorPerson | null) =>
  p ? { login: p.login, display_name: p.display_name, department: p.department, active: p.active, demo: p.demo, directory_linked: p.directory_linked } : null;

/**
 * The local administrator login of a panel session: the local admin of an admin-listener session (mem_as_) or of an older panel
 * session (`admin:<login>`); the system key and an identity provider sign-in session (a card is behind it, not the local admin) — null.
 */
export const adminLoginOf = (c: Context<any>): string | null => {
  const caller = c.get("caller");
  const a = caller?.admin;
  if (a?.sessionId) return a.localLogin ?? null;
  const label: string = caller?.clientLabel ?? "";
  return label.startsWith("admin:") ? label.slice("admin:".length) : null;
};

/**
 * The person acting in the admin API: the card of the administrator session (signed in through the identity provider, or the local admin with
 * a link), else the local admin link of an older panel session. unknown — a panel session without a "Who is the administrator"
 * link: "not oneself" cannot be checked; such actions are refused. A system key has none: { person: null, unknown: false }.
 * An inactive or demo card — as without a link (unknown).
 */
export async function operatorOf(app: App, c: Context<any>): Promise<{ person: OperatorPerson | null; unknown: boolean }> {
  const a = c.get("caller")?.admin;
  if (a?.personId) {
    const p = await personById(app, a.personId);
    return p && p.active && !p.demo ? { person: p, unknown: false } : { person: null, unknown: true };
  }
  const login = adminLoginOf(c);
  if (!login) return { person: null, unknown: !!a?.sessionId };
  const p = await operatorPerson(app, login);
  return { person: p, unknown: !p };
}

/** A card by login (the request signer — approverOf gives the login): the id and login, or null. */
export async function personByLogin(app: App, login: string | null): Promise<{ id: string; login: string } | null> {
  if (!login) return null;
  return ((await app.db.control.query("SELECT id, login FROM people WHERE login = $1 AND instance_id = $2", [login.trim().toLowerCase(), app.instanceId])).rows[0] as
    { id: string; login: string } | undefined) ?? null;
}

export function registerOperatorAdmin(r: Hono<any>, app: App, adminAudit: AdminAudit): void {
  const ctl = app.db.control;

  // local administrators and the people behind them; current — the panel session login (null for the system key)
  r.get("/admin-users", async (c) => {
    const { rows } = await ctl.query(
      "SELECT login, person_id, created_at, last_login_at, disabled_at IS NOT NULL AS disabled FROM admin_users WHERE instance_id = $1 ORDER BY login", [app.instanceId]);
    const items = [];
    for (const u of rows) {
      const p = await personById(app, u.person_id);
      // ready — a live real person stands behind the administrator: without it preset 5 is not given
      items.push({ login: u.login, created_at: u.created_at, last_login_at: u.last_login_at, disabled: u.disabled, ready: Boolean(p && p.active && !p.demo), person: view(p) });
    }
    return c.json({ items, current: adminLoginOf(c) });
  });

  // "Who works under the local admin": link to a card (the person's login) or remove the link (null)
  r.put("/admin-users/:login/person", async (c) => {
    const adminLogin = c.req.param("login").trim().toLowerCase();
    const b = await c.req.json().catch(() => { throw invalid("The request body is not JSON"); }) as { person?: unknown };
    if (!Object.hasOwn(b ?? {}, "person")) throw invalid("The person field is required: provide the person’s login, or null to remove the link");
    if (b.person !== null && typeof b.person !== "string") throw invalid("person — the person’s login (e-mail address) or null");
    const cur = (await ctl.query("SELECT login, person_id FROM admin_users WHERE login = $1 AND instance_id = $2 AND disabled_at IS NULL", [adminLogin, app.instanceId])).rows[0];
    if (!cur) throw notFound();
    let next: OperatorPerson | null = null;
    if (typeof b.person === "string") {
      const login = b.person.trim().toLowerCase();
      if (!login) throw invalid("Enter the person’s login (e-mail address) or remove the link");
      next = ((await ctl.query(`${PERSON_SQL} WHERE p.login = $1 AND p.instance_id = $2`, [login, app.instanceId])).rows[0] as OperatorPerson | undefined) ?? null;
      if (!next) throw invalid(`There is no profile with login ${login}. A person appears in memory after directory sign-in or an org table upload`);
      if (!next.active) throw invalid(`${login} is inactive. An administrator can only be linked to an active employee`);
      if (next.demo) throw invalid(`${login} is a demo persona from the role showcase. An administrator must be linked to a real person`);
      const taken = (await ctl.query("SELECT login FROM admin_users WHERE person_id = $1 AND login <> $2 AND instance_id = $3", [next.id, adminLogin, app.instanceId])).rows[0];
      if (taken) throw invalid(`${login} is already linked to administrator ${taken.login}. A person can only have one administrator account`);
      // the security auditor checks the administrator's actions — they cannot stand behind the local admin
      const auditor = await ctl.query(
        `SELECT 1 FROM role_grants WHERE person_id = $1 AND instance_id = $2 AND role_code = 'security_auditor'
           AND revoked_at IS NULL AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())`, [next.id, app.instanceId]);
      if (auditor.rowCount) throw invalid(`${login} is a security auditor. An administrator cannot be linked to someone who audits their actions. Revoke the role first on the “Roles and grants” page`);
    }
    const prev = await personById(app, cur.person_id);
    if ((prev?.id ?? null) === (next?.id ?? null)) return c.json({ login: adminLogin, person: view(next), changed: false });
    // the new link and the end of the login's sessions (mem_as_ with their tools, mem_adm_) commit together or
    // not at all — on the admin-plane pool where it exists (its role also writes admin_users), else on the gateway's pool.
    // ending live sessions of a login other than the caller's own raises HIGH
    // admin_session_ended (the login, who, the count — no session ids), stored before COMMIT on the process pool, as the
    // selected revoke does (alert-pool-guard: never a transaction's client); not stored — the link change rolls back.
    // Own: the caller's local login, or the login linked to the caller's own card before the change.
    const caller = c.get("caller") as { admin?: { login?: string; personId?: string | null } | null; principalType?: string } | undefined;
    const own = adminLoginOf(c) === adminLogin || (!!caller?.admin?.personId && caller.admin.personId === cur.person_id);
    const by = (caller?.admin?.login ?? (caller?.principalType === "system" ? "system" : "admin")).slice(0, 200);
    const ended = await tx(adminPlaneConfigured(app) ? adminDb(app) : ctl, async (q) => {
      await q.query("UPDATE admin_users SET person_id = $1 WHERE login = $2 AND instance_id = $3", [next?.id ?? null, adminLogin, app.instanceId]);
      const sessions = await endLocalLoginSessionsOnLinkChange(app, q, adminLogin);
      if (!own && (sessions.live === null || sessions.live > 0)) {
        const alert = await raiseAlert({ control: app.db.control, audit: app.db.audit }, {
          instanceId: app.instanceId, level: "high", code: "admin_session_ended",
          summary: "A change of an administrator's person link ended that administrator's live sessions",
          details: { local_login: adminLogin, by, count: sessions.live } });
        if (!alert.inserted) throw new Error("The required administrator-session alert could not be stored");
      }
      return sessions;
    });
    // the reason of the ended sessions is stored as role_lost until adds one of its own (contracts/schema enums):
    // the journal row says why
    await adminAudit(c, "operator_linked", { admin_login: adminLogin, from: prev?.login ?? null, to: next?.login ?? null, directory_linked: next?.directory_linked ?? null,
      sessions_ended: ended.ended, sessions_ended_reason: "link_changed" });
    return c.json({ login: adminLogin, person: view(next), changed: true });
  });
}
