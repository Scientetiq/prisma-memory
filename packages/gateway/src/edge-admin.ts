import type { Context, Hono } from "hono";
import { invalid, isHumanSession, notFound, tx } from "@memory/shared";
import { noticeNetwork, noticeTime, queueExternalNotice } from "@memory/shared/external-notices";
import { HUMAN_SESSION_REQUIRED } from "./admin-plane/approvals.ts";
import { adminDb, AdminPlaneNotConfigured } from "./admin-plane/db.ts";
import { authcheckStatus, AuthcheckUnavailable, closedReasonText, statusClosed } from "./authcheck-client.ts";
import type { App } from "./context.ts";
import { CONFIRM_TTL_HOURS } from "./external-access.ts";
import { jsonObjectBody, rejectUnknownFields } from "./key-kind.ts";
import { decodeKeyset, encodeKeyset, intParam, isUuidParam, keysetAtSql } from "./paging.ts";

type AdminAudit = (c: Context<any>, op: string, details?: Record<string, unknown>) => Promise<void>;

export const REQUEST_TTL_DAYS = 7;

const iso = (v: Date | string | null | undefined): string | null => (v ? new Date(v).toISOString() : null);

export function adminLoginOf(c: Context<any>): string {
  const caller = c.get("caller") as { admin?: { login?: string } | null; principalType?: string } | undefined;
  return (caller?.admin?.login ?? (caller?.principalType === "system" ? "system" : "admin")).slice(0, 200);
}

function planeDb(app: App, c: Context<any>): { db: ReturnType<typeof adminDb> } | { res: Response } {
  try {
    return { db: adminDb(app) };
  } catch (e) {
    if (!(e instanceof AdminPlaneNotConfigured)) throw e;
    return { res: c.json({ code: "admin_plane_required", message: "This requires the admin plane, which is not configured. The memory_admin_plane role has no password in the gateway’s key directory" }, 503) };
  }
}

export async function externalLoginCheck(app: App): Promise<{ ok: boolean; level: "ok" | "warn" | "fail"; detail: string } | null> {
  if (app.settings.get<boolean>("edge.login_enabled", false) !== true) return null;
  try {
    const s = await authcheckStatus();
    const closed = statusClosed(s);
    if (closed) return { ok: false, level: "fail", detail: `sign-in from outside is enabled, but the sign-in verification service is closed: ${closedReasonText(closed)}` };
    if (!s.sweep_ok) return { ok: true, level: "warn", detail: "sign-in from outside works; the last directory scan failed and the service will retry it automatically" };
    return { ok: true, level: "ok", detail: "sign-in from outside works: the sign-in verification service is responding" };
  } catch (e) {
    if (!(e instanceof AuthcheckUnavailable)) throw e;
    return { ok: false, level: "fail", detail: "sign-in from outside is enabled, but the verification service is not responding. Sign-in from outside is unavailable" };
  }
}

interface PersonRow {
  person_id: string; display_name: string; enabled_at: Date | null; disabled_at: Date | null; disabled_code: string | null; disabled_by: string | null;
  last_external_login_at: Date | null; ad_checked_at: Date | null; ad_ok: boolean; connections_active: number; at_key: string;
}

export function registerEdgeAdmin(r: Hono<any>, app: App, adminAudit: AdminAudit): void {
  r.get("/external/people", async (c) => {
    const state = c.req.query("state") ?? "on";
    if (!["on", "off", "all"].includes(state)) throw invalid("state: on, off or all");
    const limit = intParam(c.req.query("limit"), 50, 1, 100), cur = decodeKeyset(c.req.query("cursor"));
    const args: unknown[] = [app.instanceId];
    const cond = state === "on" ? "AND a.enabled_at IS NOT NULL AND a.disabled_at IS NULL" : state === "off" ? "AND (a.enabled_at IS NULL OR a.disabled_at IS NOT NULL)" : "";
    if (cur) args.push(cur.at, cur.id);
    args.push(limit + 1);
    const at = "COALESCE(a.enabled_at, a.updated_at)";
    const rows = (await app.db.control.query<PersonRow>(
      `SELECT a.person_id, p.display_name, a.enabled_at, a.disabled_at, a.disabled_code, a.disabled_by, a.last_external_login_at, a.ad_checked_at, a.ad_ok,
              (SELECT count(*)::int FROM oauth_connections oc JOIN api_keys k ON k.id = oc.id
                WHERE oc.person_id = a.person_id AND oc.origin = 'edge' AND k.revoked_at IS NULL AND k.expires_at > now()) AS connections_active,
              ${keysetAtSql(at)} AS at_key
         FROM external_access a JOIN people p ON p.id = a.person_id
        WHERE a.instance_id = $1 ${cond} ${cur ? `AND (${at}, a.person_id) < ($2::timestamptz, $3::uuid)` : ""}
        ORDER BY ${at} DESC, a.person_id DESC LIMIT $${args.length}`, args)).rows;
    const page = rows.slice(0, limit);
    return c.json({
      items: page.map((x) => ({ person_id: x.person_id, display_name: x.display_name, enabled: !!x.enabled_at && !x.disabled_at, enabled_at: iso(x.enabled_at),
        disabled_at: iso(x.disabled_at), disabled_code: x.disabled_code, disabled_by: x.disabled_by, last_external_login_at: iso(x.last_external_login_at),
        ad_checked_at: iso(x.ad_checked_at), ad_ok: x.ad_ok, connections_active: Number(x.connections_active) })),
      next_cursor: rows.length > limit ? encodeKeyset(page.at(-1)!.at_key, page.at(-1)!.person_id) : null,
    });
  });

  r.post("/external/people/:id/disable", async (c) => {
    const id = c.req.param("id");
    if (!isUuidParam(id)) throw notFound();
    const login = adminLoginOf(c);
    const off = await tx(app.db.control, async (q) => {
      if (!(await q.query("SELECT 1 FROM people WHERE id = $1 AND instance_id = $2 FOR UPDATE", [id, app.instanceId])).rowCount) throw notFound();
      const done = (await q.query<{ ok: boolean }>("SELECT external_access_disable($1::uuid, $2, 'admin') AS ok", [id, `admin:${login}`])).rows[0]?.ok === true;
      if (done) await queueExternalNotice(q, id, "optin_disabled", { time: noticeTime(new Date()) });
      return done;
    });
    if (off) await adminAudit(c, "external_disable", { person_id: id });
    return c.json({ disabled: off });
  });

  r.get("/external/confirmations", async (c) => {
    const rows = (await app.db.control.query<{ id: string; person_id: string; display_name: string; requested_at: Date; requested_ip: string | null;
                                                confirmed_by: string | null; confirmed_at: Date | null; expires_at: Date | null; used_at: Date | null }>(
      `SELECT x.id, x.person_id, p.display_name, x.requested_at, host(x.requested_ip) AS requested_ip, x.confirmed_by, x.confirmed_at, x.expires_at, x.used_at
         FROM external_access_confirmations x JOIN people p ON p.id = x.person_id
        WHERE x.instance_id = $1 AND x.requested_at > now() - make_interval(days => 30)
        ORDER BY (x.used_at IS NULL AND x.confirmed_at IS NULL) DESC, x.requested_at DESC, x.id DESC LIMIT 200`, [app.instanceId])).rows;
    return c.json({ items: rows.map((x) => ({ id: x.id, person_id: x.person_id, display_name: x.display_name, requested_at: iso(x.requested_at)!,
      requested_network: x.requested_ip ? noticeNetwork(x.requested_ip) || null : null, confirmed_by: x.confirmed_by, confirmed_at: iso(x.confirmed_at),
      expires_at: iso(x.expires_at), used_at: iso(x.used_at) })) });
  });

  r.post("/external/confirmations", async (c) => {
    const b = jsonObjectBody(await c.req.json().catch(() => null), "{id}");
    rejectUnknownFields(b, ["id"]);
    if (typeof b.id !== "string" || !isUuidParam(b.id)) throw invalid("id: request identifier");
    const a = (c.get("caller") as { admin?: Parameters<typeof isHumanSession>[0] } | undefined)?.admin ?? null;
    if (!isHumanSession(a)) return c.json(HUMAN_SESSION_REQUIRED, 403);
    const own = (await app.db.control.query<{ person_id: string }>("SELECT person_id FROM external_access_confirmations WHERE id = $1 AND instance_id = $2",
                                                                    [b.id, app.instanceId])).rows[0];
    if (own && a?.personId && own.person_id === a.personId)
      return c.json({ code: "own_request", message: "You cannot confirm your own request: another support employee checks who you are" }, 409);
    const row = (await app.db.control.query<{ person_id: string; expires_at: Date }>(
      `UPDATE external_access_confirmations SET confirmed_by = $3, confirmed_at = now(), expires_at = now() + make_interval(hours => $4)
        WHERE id = $1 AND instance_id = $2 AND used_at IS NULL AND confirmed_at IS NULL AND requested_at > now() - make_interval(days => $5)
          AND person_id IS DISTINCT FROM $6::uuid
        RETURNING person_id, expires_at`, [b.id, app.instanceId, `support:${adminLoginOf(c)}`, CONFIRM_TTL_HOURS, REQUEST_TTL_DAYS, a?.personId ?? null])).rows[0];
    if (!row) throw notFound();
    await adminAudit(c, "external_confirm", { request_id: b.id, person_id: row.person_id });
    return c.json({ confirmed: true, expires_at: iso(row.expires_at)! });
  });

  r.post("/external/pause", async (c) => {
    const b = jsonObjectBody(await c.req.json().catch(() => null), "{minutes}");
    rejectUnknownFields(b, ["minutes"]);
    if (!Number.isInteger(b.minutes) || b.minutes < 1 || b.minutes > 1440) throw invalid("minutes: an integer from 1 to 1440");
    const p = planeDb(app, c);
    if ("res" in p) return p.res;
    const row = (await p.db.query<{ id: string; reason: string; started_at: Date; until: Date; by: string }>(
      `INSERT INTO auth_pause (id, instance_id, until, reason, "by") VALUES (gen_random_uuid(), $1, now() + make_interval(mins => $2), 'manual', $3)
       RETURNING id, reason, started_at, until, "by"`, [app.instanceId, b.minutes, `admin:${adminLoginOf(c)}`])).rows[0]!;
    await adminAudit(c, "pause_manual", { until: iso(row.until) });
    return c.json({ id: row.id, reason: row.reason, started_at: iso(row.started_at)!, until: iso(row.until)!, by: row.by });
  });

  r.delete("/external/pause", async (c) => {
    const p = planeDb(app, c);
    if ("res" in p) return p.res;
    const r2 = await p.db.query(
      `UPDATE auth_pause SET lifted_at = now(), lifted_by = $2 WHERE instance_id = $1 AND reason = 'manual' AND lifted_at IS NULL AND until > now()`,
      [app.instanceId, `admin:${adminLoginOf(c)}`]);
    const lifted = r2.rowCount ?? 0;
    if (lifted) await adminAudit(c, "pause_manual", { lifted });
    return c.json({ lifted });
  });

  r.get("/external/status", async (c) => {
    try {
      return c.json({ reachable: true, status: await authcheckStatus() });
    } catch (e) {
      if (!(e instanceof AuthcheckUnavailable)) throw e;
      return c.json({ reachable: false, status: null });
    }
  });
}
