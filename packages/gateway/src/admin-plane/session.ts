import type pg from "pg";
import { Hono, type Context } from "hono";
import { ADMIN_SESSION_PREFIX, currentAnchors, tx, generateToken, hashApiKey, isAdminSessionToken, log, newId, raiseAlert,
         type AdminRole, type AuthMethod } from "@memory/shared";
import type { AdminCaller, App, Caller } from "../context.ts";
import { audit } from "../audit.ts";
import { scopeFor } from "../auth.ts";
import { SESSION_TTL_SEC } from "../session.ts";
import { adminDb, adminPlaneConfigured } from "./db.ts";
import { adminNow } from "./test-clock.ts";

export type RevokeReason = "logout" | "logout_all" | "admin_disabled" | "expired_idle" | "ip_changed" | "role_lost" | "breakglass_closed"
  | "incident" | "parent_revoked" | "anchors" | "security_mode";

export interface AdminSessionRow {
  id: string;
  person_id: string | null;
  local_login: string | null;
  login: string;
  role: AdminRole;
  auth_method: AuthMethod;
  ip: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  uv_at: Date | null;
  parent_session_id: string | null;
  breakglass_window_id: string | null;
}

export interface SessionReject { reject: "session_expired"; reason: string; sessionId?: string; breakglassWindowId?: string }
export const isSessionReject = (x: AdminSessionRow | SessionReject): x is SessionReject => "reject" in x;

export const TOUCH_EVERY_MS = 30_000;

const minutes = (app: App, key: string, def: number): number => {
  const v = Number(app.settings.get<number>(key, def));
  return Number.isFinite(v) && v > 0 ? v : def;
};

const SESSION_COLS = `s.id, s.person_id, s.local_login, COALESCE(s.local_login, p.login) AS login, s.role, s.auth_method, host(s.ip) AS ip,
  s.created_at, s.last_seen_at, s.expires_at, s.uv_at, s.parent_session_id, s.breakglass_window_id`;

export interface CreateSessionInput {
  personId?: string | null;
  localLogin?: string | null;
  role: AdminRole;
  authMethod: AuthMethod;
  ip: string;
  uv?: boolean;
  parentId?: string | null;
  breakglassWindowId?: string | null;
  expiresAtMax?: Date | null;
  /** Second factor of a local administrator's sign-in: admin_sessions.second_factor, set once. */
  secondFactor?: "totp" | "recovery" | null;
}

export async function createAdminSession(app: App, o: CreateSessionInput): Promise<{ token: string; row: AdminSessionRow }> {
  if (!o.personId && !o.localLogin) throw new Error("an administrator session requires a profile or admin@local");
  return tx(adminDb(app), (db) => issueAdminSession(app, db, o));
}

async function issueAdminSession(app: App, db: Pick<pg.PoolClient, "query">, o: CreateSessionInput): Promise<{ token: string; row: AdminSessionRow }> {
  const now = adminNow();
  let personId = o.personId ?? null;
  if (o.localLogin) {
    // the link is read under a share lock in the transaction of the INSERT, so a link change
    // (operator.ts, which updates this row and then ends the login's sessions) either commits first — and this sign-in
    // carries the new card — or waits until this session exists and then ends it; a session with the former card cannot
    // outlive the change
    const au = await db.query("SELECT person_id FROM admin_users WHERE login = $1 AND instance_id = $2 FOR SHARE", [o.localLogin, app.instanceId]);
    personId = (au.rows[0]?.person_id as string | null | undefined) ?? null;
  }
  const maxMin = o.authMethod === "tool" ? minutes(app, "admin.tool_session_max_min", 30) : minutes(app, "admin.session_max_min", 60);
  let expires = new Date(now.getTime() + maxMin * 60_000);
  if (o.parentId) {
    const parent = (await db.query("SELECT expires_at, auth_method, parent_session_id FROM admin_sessions WHERE id = $1 AND instance_id = $2 AND revoked_at IS NULL", [o.parentId, app.instanceId])).rows[0];
    if (!parent) throw new Error("the parent session is invalid");
    if (parent.auth_method === "tool" || parent.parent_session_id !== null) throw new Error("A tool session cannot be a parent");
    if (new Date(parent.expires_at) < expires) expires = new Date(parent.expires_at);
  }
  if (o.expiresAtMax && o.expiresAtMax.getTime() < expires.getTime()) expires = new Date(o.expiresAtMax);
  if (o.breakglassWindowId) {
    const w = (await db.query("SELECT expires_at, closed_at FROM breakglass_windows WHERE id = $1 AND instance_id = $2", [o.breakglassWindowId, app.instanceId])).rows[0] as
      { expires_at: Date; closed_at: Date | null } | undefined;
    if (!w || w.closed_at) throw new Error("the emergency access window is closed or missing");
    if (new Date(w.expires_at).getTime() < expires.getTime()) expires = new Date(w.expires_at);
  }
  if (expires.getTime() <= now.getTime()) throw new Error("the session already expired because the emergency access window or parent session ended");
  const { plain, hash } = generateToken(ADMIN_SESSION_PREFIX);
  const id = newId();
  // second_factor only when a factor was used: the INSERT of a factor-less session stays the one of before
  const sf = o.secondFactor ?? null;
  await db.query(
    `INSERT INTO admin_sessions (id, instance_id, token_hash, person_id, local_login, role, auth_method, ip, created_at, last_seen_at, expires_at,
                                 uv_at, parent_session_id, breakglass_window_id${sf ? ", second_factor" : ""})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::inet, $9, $9, $10, $11, $12, $13${sf ? ", $14" : ""})`,
    [id, app.instanceId, hash, personId, o.localLogin ?? null, o.role, o.authMethod, o.ip, now, expires,
     o.uv ? now : null, o.parentId ?? null, o.breakglassWindowId ?? null, ...(sf ? [sf] : [])]);
  const row = (await db.query(`SELECT ${SESSION_COLS} FROM admin_sessions s LEFT JOIN people p ON p.id = s.person_id WHERE s.id = $1`, [id])).rows[0] as AdminSessionRow;
  return { token: plain, row };
}

export async function revokeAdminSessions(app: App, by: { sessionId?: string; personId?: string; localLogin?: string; windowId?: string; all?: boolean }, reason: RevokeReason,
  control: Pick<pg.Pool, "query"> = adminDb(app)): Promise<number> {
  const db = control;
  const now = adminNow();
  const where: string[] = [], args: unknown[] = [app.instanceId, now, reason];
  if (by.sessionId) { args.push(by.sessionId); where.push(`id = $${args.length}`); }
  if (by.localLogin) { args.push(by.localLogin); where.push(`local_login = $${args.length}`); }
  if (by.personId) {
    args.push(by.personId);
    where.push(`person_id = $${args.length}`,
               `local_login IN (SELECT login FROM admin_users WHERE person_id = $${args.length} AND instance_id = $1)`);
  }
  if (by.windowId) { args.push(by.windowId); where.push(`breakglass_window_id = $${args.length}`); }
  if (!where.length && !by.all) throw new Error("revokeAdminSessions: no sessions specified");
  if (by.all) await db.query("UPDATE admin_users SET sessions_revoked_at = now() WHERE instance_id = $1", [app.instanceId]);
  else if (by.personId) await db.query("UPDATE admin_users SET sessions_revoked_at = now() WHERE instance_id = $1 AND person_id = $2", [app.instanceId, by.personId]);
  const r = await db.query(
    `UPDATE admin_sessions SET revoked_at = $2, revoked_reason = $3
      WHERE instance_id = $1 AND revoked_at IS NULL${where.length ? ` AND (${where.join(" OR ")})` : ""} RETURNING id`, args);
  const ids = r.rows.map((x: { id: string }) => x.id);
  let children = 0;
  for (let level = 0, parents = ids; parents.length && level < 3; level++) {
    const c = await db.query(
      `UPDATE admin_sessions SET revoked_at = $2, revoked_reason = 'parent_revoked'
        WHERE instance_id = $1 AND revoked_at IS NULL AND parent_session_id = ANY($3::uuid[]) RETURNING id`, [app.instanceId, now, parents]);
    parents = c.rows.map((x: { id: string }) => x.id);
    children += parents.length;
  }
  return ids.length + children;
}

export async function stepUp(app: App, id: string): Promise<Date | null> {
  const now = adminNow();
  const r = await adminDb(app).query("UPDATE admin_sessions SET uv_at = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING uv_at", [id, now]);
  return r.rows[0] ? new Date(r.rows[0].uv_at) : null;
}

export function freshUv(app: App, uvAt: Date | null): boolean {
  if (!uvAt) return false;
  return adminNow().getTime() - uvAt.getTime() <= minutes(app, "admin.stepup_max_min", 5) * 60_000;
}

async function roleProblem(app: App, s: AdminSessionRow): Promise<RevokeReason | null> {
  const db = adminDb(app);
  if (s.local_login) {
    const au = await db.query("SELECT 1 FROM admin_users WHERE login = $1 AND instance_id = $2 AND disabled_at IS NULL", [s.local_login, app.instanceId]);
    return au.rowCount ? null : "admin_disabled";
  }
  if (!s.person_id) return "admin_disabled";
  const r = await db.query(
    `SELECT 1 FROM people p
      WHERE p.id = $1 AND p.instance_id = $3 AND p.active AND COALESCE(p.attrs->>'demo', '') <> 'true'
        AND EXISTS (SELECT 1 FROM role_grants g WHERE g.person_id = p.id AND g.role_code = $2 AND g.instance_id = $3
                       AND g.revoked_at IS NULL AND g.valid_from <= now() AND (g.valid_to IS NULL OR g.valid_to > now()))`,
    [s.person_id, s.role, app.instanceId]);
  return r.rowCount ? null : "role_lost";
}

async function anchorsProblem(app: App, s: AdminSessionRow): Promise<boolean> {
  const a = currentAnchors();
  if (!a.inForce || !s.person_id || s.local_login) return false;
  const ids = new Set((a.admin?.ldap_ids ?? []).map((x) => x.toLowerCase()));
  const r = await adminDb(app).query(
    "SELECT external_id FROM person_identities WHERE person_id = $1 AND system = 'ad' AND active AND verified", [s.person_id]);
  return !r.rows.some((x: { external_id: string }) => ids.has(String(x.external_id).toLowerCase()));
}

export async function verifyAdminSession(app: App, token: string, ip: string | null, o: { direct?: boolean } = {}): Promise<AdminSessionRow | SessionReject> {
  if (!isAdminSessionToken(token)) return { reject: "session_expired", reason: "malformed" };
  const db = adminDb(app);
  const row = (await db.query(
    `SELECT ${SESSION_COLS}, s.revoked_at, (s.parent_session_id IS NOT NULL AND (par.id IS NULL OR par.revoked_at IS NOT NULL)) AS parent_gone
       FROM admin_sessions s LEFT JOIN people p ON p.id = s.person_id LEFT JOIN admin_sessions par ON par.id = s.parent_session_id
      WHERE s.token_hash = $1 AND s.instance_id = $2`, [hashApiKey(token), app.instanceId])).rows[0] as (AdminSessionRow & { revoked_at: Date | null; parent_gone: boolean }) | undefined;
  if (!row) return { reject: "session_expired", reason: "unknown" };
  const id = row.id;
  if (row.revoked_at) return { reject: "session_expired", reason: "revoked", sessionId: id };
  const now = adminNow().getTime();
  const maxMin = row.auth_method === "tool" ? minutes(app, "admin.tool_session_max_min", 30) : minutes(app, "admin.session_max_min", 60);
  if (now >= new Date(row.expires_at).getTime() || now >= new Date(row.created_at).getTime() + maxMin * 60_000)
    return { reject: "session_expired", reason: "expired", sessionId: id, ...(row.breakglass_window_id ? { breakglassWindowId: row.breakglass_window_id } : {}) };
  const revoke = async (reason: RevokeReason): Promise<SessionReject> => {
    await revokeAdminSessions(app, { sessionId: id }, reason);
    return { reject: "session_expired", reason, sessionId: id };
  };
  if (row.parent_gone) return revoke("parent_revoked");
  if (now - new Date(row.last_seen_at).getTime() > minutes(app, "admin.session_idle_min", 15) * 60_000) return revoke("expired_idle");
  const toolElsewhere = row.auth_method === "tool" && o.direct !== true;
  if (toolElsewhere || !ip || ip !== row.ip) {
    if (!ip && !toolElsewhere) return { reject: "session_expired", reason: "ip_unknown", sessionId: id };
    const out = await revoke("ip_changed");
    await raiseAlert({ control: app.db.control, audit: app.db.audit }, {
      instanceId: app.instanceId, level: "medium", code: "session_ip_changed",
      summary: `Administrator ${row.login}’s session came from a different address and was revoked`,
      details: { admin_session: id, login: row.login }, dedupeKey: `session_ip_changed:${id}` });
    return out;
  }
  const lost = await roleProblem(app, row);
  if (lost) return revoke(lost);
  if (await anchorsProblem(app, row)) return revoke("anchors");
  if (now - new Date(row.last_seen_at).getTime() > TOUCH_EVERY_MS)
    await db.query("UPDATE admin_sessions SET last_seen_at = $2 WHERE id = $1 AND revoked_at IS NULL", [id, new Date(now)]).catch((e: unknown) =>
      log.warn("admin_session_touch_failed", { error: ((e as Error)?.message ?? String(e)).slice(0, 200) }));
  const { revoked_at: _r, parent_gone: _p, ...clean } = row;
  return clean;
}

export const adminOfSession = (s: AdminSessionRow): AdminCaller => ({
  sessionId: s.id, personId: s.person_id, localLogin: s.local_login, login: s.login, role: s.role, authMethod: s.auth_method,
  uvAt: s.uv_at ? new Date(s.uv_at) : null, breakglassWindowId: s.breakglass_window_id,
});

export function adminSessionCaller(s: AdminSessionRow, ip: string | null, baseUrl: string): Caller {
  return { keyId: s.id, keyKind: "system", tier: "T0", principalType: "system", person: null, service: null, onBehalfOf: false,
           allowedOps: new Set(["admin"]), clientLabel: `admin:${s.login}`, clientKind: null, expiresAt: new Date(s.expires_at), ip,
           netBound: false, preview: false, scope: scopeFor("system", "T0"), baseUrl, channel: "internal", admin: adminOfSession(s) };
}

type Env = { Variables: { caller: Caller } };
const sessionOf = (c: Context<Env>): AdminCaller | null => {
  const a = c.get("caller")?.admin;
  return a?.sessionId ? a : null;
};
const NOT_A_SESSION = { code: "session_expired", message: "The administrator session has ended. Sign in again" } as const;
const adminAudit = (app: App, c: Context<Env>, op: string, details: Record<string, unknown> = {}) =>
  audit(app, c.get("caller"), { event_type: "admin", details: { op, ...details } });

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Use the same absolute and idle limits as authentication, including a shorter tool lifetime.
const LIVE_SESSION = `s.instance_id = $1 AND s.revoked_at IS NULL AND s.expires_at > $2
  AND s.created_at > $2::timestamptz - (CASE WHEN s.auth_method = 'tool' THEN $4 ELSE $3 END)::double precision * interval '1 minute'
  AND s.last_seen_at >= $2::timestamptz - $5::double precision * interval '1 minute'
  AND (s.parent_session_id IS NULL OR EXISTS (SELECT 1 FROM admin_sessions par
    WHERE par.id = s.parent_session_id AND par.instance_id = $1 AND par.revoked_at IS NULL AND par.expires_at > $2))`;
const liveSessionArgs = (app: App): unknown[] => [app.instanceId, adminNow(), minutes(app, "admin.session_max_min", 60),
  minutes(app, "admin.tool_session_max_min", 30), minutes(app, "admin.session_idle_min", 15)];

export function sessionRoutes(app: App): Hono<Env> {
  const r = new Hono<Env>();

  r.get("/api/v1/admin-auth/session", async (c) => {
    const a = sessionOf(c);
    if (!a) return c.json(NOT_A_SESSION, 401);
    const caller = c.get("caller");
    return c.json({ session_id: a.sessionId, person_id: a.personId, login: a.login, role: a.role, auth_method: a.authMethod,
                    uv_at: a.uvAt ? a.uvAt.toISOString() : null, expires_at: caller.expiresAt ? new Date(caller.expiresAt).toISOString() : null,
                    breakglass: a.breakglassWindowId !== null });
  });

  r.post("/api/v1/admin-auth/logout", async (c) => {
    const a = sessionOf(c);
    if (!a) return c.json(NOT_A_SESSION, 401);
    await revokeAdminSessions(app, { sessionId: a.sessionId! }, "logout");
    await adminAudit(app, c, "admin_logout", { scope: "session" });
    return c.body(null, 204);
  });

  r.post("/api/v1/admin-auth/logout-all", async (c) => {
    const a = sessionOf(c);
    if (!a) return c.json(NOT_A_SESSION, 401);
    // A local login always ends every session of that login (and its mem_adm_ tokens), whatever card each
    // session snapshotted at sign-in; the cards ended are the one this session carries and the login's link read now,
    // so an unlink or relink after this session was issued narrows nothing. The login goes last: its legacy cutoff
    // (one millisecond ahead) is then not overwritten by the cards' now().
    let revoked = 0;
    if (a.localLogin) {
      const linked = (await adminDb(app).query("SELECT person_id FROM admin_users WHERE login = $1 AND instance_id = $2",
        [a.localLogin, app.instanceId])).rows[0]?.person_id as string | null | undefined;
      for (const personId of new Set([a.personId, linked ?? null].filter((p): p is string => !!p)))
        revoked += await revokeAdminSessions(app, { personId }, "logout_all");
      revoked += await revokeLocalSessions(app, a.localLogin);
    } else if (a.personId) revoked = await revokeAdminSessions(app, { personId: a.personId }, "logout_all");
    await adminAudit(app, c, "admin_logout", { scope: "all", revoked });
    return c.json({ revoked });
  });

  r.get("/api/v1/admin/sessions", async (c) => {
    const a = c.get("caller").admin;
    if (a?.role !== "memory_admin") return c.json({ code: "role_forbidden", message: "A memory administrator is required" }, 403);
    const person = c.req.query("person_id"), local = c.req.query("local_login"), rawLimit = c.req.query("limit");
    const limit = rawLimit === undefined ? 200 : /^[1-9][0-9]*$/.test(rawLimit) ? Number(rawLimit) : NaN;
    if ((person !== undefined && (!SESSION_UUID.test(person) || local !== undefined)) ||
        (local !== undefined && (!local || local.length > 128)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      return c.json({ code: "invalid_argument", message: "Use person_id or local_login and a limit from 1 to 500" }, 400);
    const rows = (await adminDb(app).query(
      `SELECT ${SESSION_COLS} FROM admin_sessions s LEFT JOIN people p ON p.id = s.person_id
       WHERE ${LIVE_SESSION} AND ($6::uuid IS NULL OR s.person_id = $6) AND ($7::text IS NULL OR s.local_login = $7)
       ORDER BY s.created_at DESC, s.id DESC LIMIT $8`, [...liveSessionArgs(app), person ?? null, local ?? null, limit + 1])).rows as AdminSessionRow[];
    const truncated = rows.length > limit;
    // Explicit projection: credentials and their hashes can never become response fields.
    const items = rows.slice(0, limit).map((s) => ({ id: s.id, person_id: s.person_id, local_login: s.local_login, role: s.role,
      auth_method: s.auth_method, client_ip: s.ip, created_at: new Date(s.created_at).toISOString(), last_seen_at: new Date(s.last_seen_at).toISOString(),
      expires_at: new Date(s.expires_at).toISOString(), tool: s.parent_session_id !== null, breakglass: s.breakglass_window_id !== null, current: s.id === a.sessionId }));
    await adminAudit(app, c, "admin_sessions_list", { count: items.length, truncated });
    return c.json({ items, truncated });
  });

  r.post("/api/v1/admin/sessions/:id/revoke", async (c) => {
    const a = c.get("caller").admin;
    if (a?.role !== "memory_admin") return c.json({ code: "role_forbidden", message: "A memory administrator is required" }, 403);
    const id = c.req.param("id");
    const missing = () => c.json({ code: "not_found", message: "Session not found" }, 404);
    if (!SESSION_UUID.test(id)) return missing();
    const tx = await adminDb(app).connect();
    let target: Pick<AdminSessionRow, "id" | "person_id" | "local_login"> | undefined;
    let revoked = 0, own = false;
    const current = a.sessionId?.toLowerCase() === id.toLowerCase();
    try {
      await tx.query("BEGIN");
      target = (await tx.query(`SELECT s.id, s.person_id, s.local_login FROM admin_sessions s
        WHERE ${LIVE_SESSION} AND s.id = $6 FOR UPDATE OF s`, [...liveSessionArgs(app), id])).rows[0];
      if (target) {
        own = current || (target.person_id !== null && target.person_id === a.personId) ||
          (target.local_login !== null && target.local_login === (a.localLogin ?? (a.authMethod === "legacy_session" ? a.login : null)));
        revoked = await revokeAdminSessions(app, { sessionId: target.id }, own ? "logout" : "admin_disabled", tx);
        if (!own) {
          // Persist the required alert on the pool before committing. A later commit failure leaves a truthful alert about the request.
          const alert = await raiseAlert({ control: app.db.control, audit: app.db.audit }, {
            instanceId: app.instanceId, level: "high", code: "admin_session_ended", summary: "An administrator requested ending another administrator's session",
            details: { admin_person: target.person_id, session: target.id, by: a.login } });
          if (!alert.inserted) throw new Error("The required administrator-session alert could not be stored");
        }
      }
      await tx.query("COMMIT");
    } catch (e) {
      await tx.query("ROLLBACK");
      throw e;
    } finally { tx.release(); }
    if (!target || revoked < 1) return missing();
    const op = current ? "admin_session_end_current" : own ? "admin_session_end_own" : "admin_session_end";
    // admin_person is reserved for the audit actor; target_person is the owner (registry addition requested from K).
    await adminAudit(app, c, op, { session: target.id, count: revoked,
      ...(!own ? { target_person: target.person_id, local_login: target.local_login } : {}) });
    return c.json({ revoked });
  });

  r.post("/api/v1/admin-auth/tool-session", async (c) => {
    if (app.settings.get<boolean>("admin.tool_sessions", false) !== true) return c.json({ code: "not_found", message: "Not found" }, 404);
    const a = sessionOf(c);
    if (!a) return c.json(NOT_A_SESSION, 401);
    if (a.authMethod === "tool") return c.json({ code: "role_forbidden", message: "A tool session cannot create another session" }, 403);
    if (a.role !== "memory_admin") return c.json({ code: "role_forbidden", message: "This action is not available to your role" }, 403);
    if (!freshUv(app, a.uvAt)) return c.json({ code: "stepup_required", message: "Touch the key once more: this action needs a fresh confirmation" }, 403);
    const body = await c.req.json<{ label?: unknown }>().catch(() => ({} as { label?: unknown }));
    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (!label || label.length > 60) return c.json({ code: "invalid_argument", message: "label must be 1 to 60 characters" }, 400);
    const { token, row } = await createAdminSession(app, { personId: a.personId, localLogin: a.localLogin ?? null, role: a.role,
                                                           authMethod: "tool", ip: "127.0.0.1", parentId: a.sessionId });
    await adminAudit(app, c, "tool_session", { tool_session: row.id, label });
    await raiseAlert({ control: app.db.control, audit: app.db.audit }, { instanceId: app.instanceId, level: "medium", code: "tool_session_issued",
      summary: `Administrator ${a.login} issued a tool session`, details: { admin_session: a.sessionId, tool_session: row.id, login: a.login } });
    return c.json({ session: token, expires_at: new Date(row.expires_at).toISOString() }, 201);
  });

  r.post("/api/v1/admin/sessions/revoke", async (c) => {
    const body = await c.req.json<{ person_id?: unknown }>().catch(() => ({} as { person_id?: unknown }));
    const personId = typeof body.person_id === "string" && /^[0-9a-f-]{36}$/i.test(body.person_id) ? body.person_id : null;
    if (!personId) return c.json({ code: "invalid_argument", message: "person_id must be a profile identifier" }, 400);
    const revoked = await revokeAdminSessions(app, { personId }, "admin_disabled");
    await adminAudit(app, c, "admin_session_revoke", { person: personId, revoked });
    await raiseAlert({ control: app.db.control, audit: app.db.audit }, { instanceId: app.instanceId, level: "high", code: "admin_disabled",
      summary: `Administrator deactivated. Sessions revoked: ${revoked}`, details: { person: personId, revoked, by: c.get("caller").admin?.login ?? null } });
    return c.json({ revoked });
  });

  return r;
}

export async function revokeLocalSessions(app: App, login: string, o: { exceptSessionId?: string | null; control?: Pick<pg.Pool, "query"> } = {}): Promise<number> {
  // Keep the cutoff strictly after a token issued in the same millisecond.
  await (o.control ?? app.db.control).query("UPDATE admin_users SET sessions_revoked_at = clock_timestamp() + interval '1 millisecond' WHERE login = $1 AND instance_id = $2", [login, app.instanceId]);
  if (!adminPlaneConfigured(app)) return 0;
  const r = await adminDb(app).query("SELECT id FROM admin_sessions WHERE instance_id = $1 AND local_login = $2 AND revoked_at IS NULL AND ($3::uuid IS NULL OR id <> $3)", [app.instanceId, login, o.exceptSessionId ?? null]);
  let n = 0;
  for (const x of r.rows as Array<{ id: string }>) n += await revokeAdminSessions(app, { sessionId: x.id }, "logout_all");
  return n;
}

/**
 * The link update in `q` holds the admin_users row lock. Moving the cutoff one millisecond ahead ends the login's
 * mem_adm_ tokens. The split layout also ends mem_as_ sessions and their tools with role_lost and returns session counts.
 * On the legacy layout the ended count is unknown. A sign-in after the previous cutoff and within the token lifetime
 * is evidence of live tokens. The live count for the alert is null with that evidence and zero otherwise.
 * On the split layout `q` belongs to the admin-plane pool, whose role can also write admin_users.
 */
export async function endLocalLoginSessionsOnLinkChange(app: App, q: Pick<pg.PoolClient, "query">, login: string): Promise<{ ended: number | null; live: number | null }> {
  const split = adminPlaneConfigured(app);
  let legacyLive = false;
  if (!split) {
    const { rows } = await q.query<{ live: boolean | null }>(
      `SELECT (last_login_at > COALESCE(sessions_revoked_at, '-infinity'::timestamptz)
            AND last_login_at > clock_timestamp() - $3::integer * interval '1 second') AS live
         FROM admin_users WHERE login = $1 AND instance_id = $2`, [login, app.instanceId, SESSION_TTL_SEC]);
    legacyLive = rows[0]?.live === true;
  }
  await q.query("UPDATE admin_users SET sessions_revoked_at = clock_timestamp() + interval '1 millisecond' WHERE login = $1 AND instance_id = $2", [login, app.instanceId]);
  if (!split) return { ended: null, live: legacyLive ? null : 0 };
  // how many of them were LIVE (not revoked, not past their end) — the count of the HIGH alert
  const live = Number((await q.query(
    "SELECT count(*)::int AS n FROM admin_sessions WHERE instance_id = $1 AND local_login = $2 AND revoked_at IS NULL AND expires_at > $3",
    [app.instanceId, login, adminNow()])).rows[0]?.n ?? 0);
  return { ended: await revokeAdminSessions(app, { localLogin: login }, "role_lost", q), live };
}

/**
 * admin.local_totp_required turned on: sessions of local administrators issued without a second factor end.
 * Signed mem_adm_ tokens cannot be told apart once issued, so every local administrator's token ends
 * (admin_users.sessions_revoked_at, on the gateway's pool — the default install has no admin listener); on the admin
 * listener every live mem_as_ session of a local sign-in without second_factor is revoked (logout_all), the ones with a
 * factor stay. Returns the number of revoked mem_as_ sessions.
 */
export async function revokeFactorlessLocalSessions(app: App): Promise<number> {
  await app.db.control.query("UPDATE admin_users SET sessions_revoked_at = now() WHERE instance_id = $1", [app.instanceId]);
  if (!adminPlaneConfigured(app)) return 0;
  const r = await adminDb(app).query(
    `SELECT id FROM admin_sessions WHERE instance_id = $1 AND revoked_at IS NULL AND local_login IS NOT NULL
        AND auth_method IN ('local', 'local_breakglass') AND second_factor IS NULL`, [app.instanceId]);
  let n = 0;
  for (const x of r.rows as Array<{ id: string }>) n += await revokeAdminSessions(app, { sessionId: x.id }, "logout_all");
  return n;
}
