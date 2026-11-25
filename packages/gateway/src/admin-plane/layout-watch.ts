import { auditArchivedBefore, log, raiseAlert } from "@memory/shared";
import type { App } from "../context.ts";

export const LAYOUT_WATCH_MS = 3_600_000;

type WatchApp = Pick<App, "db" | "instanceId">;

async function preparedSigns(app: WatchApp): Promise<string[] | null> {
  const ctl = app.db.control;
  try {
    const signs: string[] = [];
    const has = (await ctl.query(`SELECT to_regclass('edge_prepared') IS NOT NULL AS e, to_regclass('anchors_applied') IS NOT NULL AS a,
                                         to_regclass('security_mode_changes') IS NOT NULL AS m`)).rows[0] as { e: boolean; a: boolean; m: boolean };
    if (has.e && ((await ctl.query("SELECT 1 FROM edge_prepared WHERE instance_id = $1", [app.instanceId])).rowCount ?? 0) > 0) signs.push("edge_prepared");
    if (has.a && ((await ctl.query("SELECT 1 FROM anchors_applied WHERE instance_id = $1 AND kind = 'inner' LIMIT 1", [app.instanceId])).rowCount ?? 0) > 0) signs.push("inner_anchors");
    if (has.m && ((await ctl.query("SELECT 1 FROM security_mode_changes WHERE instance_id = $1 LIMIT 1", [app.instanceId])).rowCount ?? 0) > 0) signs.push("security_mode_changes");
    return signs;
  } catch (e) {
    log.warn("layout_watch_read_failed", { what: "prepared", error: ((e as Error)?.message ?? "").slice(0, 160) });
    return null;
  }
}

export async function unverifiedAdminGrants(app: WatchApp): Promise<Array<{ id: string; role: string; person: string; login: string }> | null> {
  try {
    type Grant = { id: string; role: string; person: string; login: string; created_at: Date; cursor_at: string };
    const pageSize = 500;
    const pending: Grant[] = [];
    let cursor: Grant | undefined;
    for (;;) {
      const grants = (await app.db.control.query<Grant>(
        `SELECT g.id::text AS id, g.role_code AS role, g.person_id::text AS person, p.login, g.created_at, g.created_at::text AS cursor_at
           FROM role_grants g JOIN people p ON p.id = g.person_id
          WHERE g.instance_id = $1 AND g.role_code IN ('memory_admin', 'security_auditor') AND g.revoked_at IS NULL AND g.valid_from <= now()
            AND (g.valid_to IS NULL OR g.valid_to > now())
            AND ($2::timestamptz IS NULL OR (g.created_at, g.id) > ($2::timestamptz, $3::uuid))
          ORDER BY g.created_at, g.id LIMIT $4`,
        [app.instanceId, cursor?.cursor_at ?? null, cursor?.id ?? null, pageSize])).rows;
      if (!grants.length) break;
      const ev = (await app.db.auditRead().query(
        `SELECT details->>'grant_id' AS g, details->>'admin_auth' AS auth, details->>'admin_session' AS s, details->>'via' AS via, details->>'recovery' AS rec
           FROM audit_events WHERE instance_id = $1 AND event_type = 'admin' AND details->>'op' = 'grant_create' AND details->>'grant_id' = ANY($2::text[])`,
        [app.instanceId, grants.map((g) => g.id)])).rows as Array<{ g: string; auth: string | null; s: string | null; via: string | null; rec: string | null }>;
      const ok = new Set(ev.filter((e) => (e.s && (e.auth === "sso" || e.auth === "sso_webauthn")) || (e.via === "cli" && e.rec === "true")).map((e) => e.g));
      pending.push(...grants.filter((g) => !ok.has(g.id)));
      if (grants.length < pageSize) break;
      cursor = grants.at(-1);
    }
    const archived = pending.length ? await auditArchivedBefore(app.db.auditRead()) : null;
    return pending.filter((g) => !archived || new Date(g.created_at).getTime() >= archived.getTime())
      .map((g) => ({ id: g.id, role: g.role, person: g.person, login: g.login }));
  } catch (e) {
    log.warn("layout_watch_read_failed", { what: "grants", error: ((e as Error)?.message ?? "").slice(0, 160) });
    return null;
  }
}

export async function layoutWatchPass(app: WatchApp, o: { adminSeparate: boolean; now?: Date }): Promise<string[]> {
  const raised: string[] = [];
  const day = (o.now ?? new Date()).toISOString().slice(0, 10);
  const raise = async (code: string, summary: string, details: Record<string, unknown>, dedupeKey: string) => {
    const r = await raiseAlert({ control: app.db.control, audit: app.db.audit }, { instanceId: app.instanceId, level: "high", code, summary, details, dedupeKey })
      .catch(() => ({ inserted: false }));
    if (r.inserted) raised.push(code);
  };
  if (!o.adminSeparate) {
    const signs = await preparedSigns(app);
    if (signs?.length)
      await raise("admin_listener_absent",
        "The gateway is running without its admin listener (MEMORY_ADMIN_LISTEN is unset) after setup. Personal sessions are unavailable, and the “always” group, alert e-mail and “human only” roles are inactive. Restore the configuration with the admin listener",
        { signs }, `admin_listener_absent:${day}`);
    return raised;
  }
  const grants = await unverifiedAdminGrants(app);
  for (const g of grants ?? [])
    await raise("admin_role_changed",
      `Role ${g.role} for ${g.login} was granted outside a personal administrator session or before audit logging. Review it and revoke it if in doubt`,
      { role: g.role, person: g.person, grant_id: g.id, action: "unverified" }, `admin_role_unverified:${g.id}`);
  return raised;
}

export function startLayoutWatch(app: WatchApp, o: { adminSeparate: boolean }): () => void {
  const run = () => void layoutWatchPass(app, o).then((r) => { if (r.length) log.warn("layout_watch", { alerts: r }); },
    (e: unknown) => log.warn("layout_watch_failed", { error: ((e as Error)?.message ?? "").slice(0, 160) }));
  run();
  const t = setInterval(run, LAYOUT_WATCH_MS);
  t.unref?.();
  return () => clearInterval(t);
}
