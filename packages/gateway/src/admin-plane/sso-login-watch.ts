import { log, raiseAlert } from "@memory/shared";
import type pg from "pg";
import type { App } from "../context.ts";

export interface SsoChange {
  id: string; before: unknown; after: unknown; who: string | null;
  state?: SsoState;
}
interface SsoState { enabled: boolean; period: string; event?: string | null; who?: string | null }

/**
 * Serialize the durable observation with setting writes, not with their later journal inserts.
 * The setting row is locked before updating the per-instance marker. A false-to-false save keeps
 * its period; a stored on value ends it. The journal id is attribution only, never state evidence.
 * Called inside the API save transaction too, so an on/off pair between polls is not missed.
 */
export async function rememberSsoLoginState(control: Pick<pg.Pool, "query">, instanceId: string, change?: SsoChange, defaultEnabled = false): Promise<SsoState | undefined> {
  // no settings row for the key reads as the registry default, not as «no state»
  const r = await control.query(
    `WITH stored AS MATERIALIZED (
       SELECT coalesce(nullif(value, 'null'::jsonb), default_value, 'false'::jsonb) = 'true'::jsonb AS enabled
         FROM settings WHERE instance_id = $1 AND category = 'admin' AND key = 'sso_login_enabled' FOR UPDATE
     ), current_setting AS MATERIALIZED (
       SELECT coalesce((SELECT enabled FROM stored), $4::boolean) AS enabled
     )
     INSERT INTO maintenance_state (instance_id, key, value)
       SELECT $1, 'admin_sso_login_watch', jsonb_build_object('enabled', enabled,
         'period', coalesce($2::text, gen_random_uuid()::text), 'event', $2::text, 'who', $3::text) FROM current_setting
     ON CONFLICT (instance_id, key) DO UPDATE SET
       value = CASE WHEN maintenance_state.value->'enabled' = excluded.value->'enabled'
         THEN maintenance_state.value ELSE excluded.value END, updated_at = now()
     RETURNING value`, [instanceId, change?.id ?? null, change?.who ?? null, defaultEnabled]);
  return r.rows[0]?.value as SsoState | undefined;
}

/** A standing alert follows the CURRENT stored value. No journal scan or outside-write inference. */
/** The registry default of admin.sso_login_enabled (what an absent settings row means). */
export function ssoLoginDefault(app: { settings?: Pick<App["settings"], "meta"> }): boolean {
  try { return app.settings?.meta("admin.sso_login_enabled").defaultValue === true; } catch { return false; }
}

export async function observeSsoLoginState(app: Pick<App, "db" | "instanceId"> & { settings?: Pick<App["settings"], "meta"> }): Promise<void> {
  const defaultEnabled = ssoLoginDefault(app);
  // Commit the period first. The later lock only verifies current state, so a failed COMMIT cannot lose its dedupe key.
  const observed = await rememberSsoLoginState(app.db.control, app.instanceId, undefined, defaultEnabled);
  if (!observed || observed.enabled) return;
  const q = await app.db.control.connect();
  try {
    await q.query("BEGIN");
    const current = (await q.query(
      `SELECT coalesce(nullif(value, 'null'::jsonb), default_value, 'false'::jsonb) = 'true'::jsonb AS enabled
         FROM settings WHERE instance_id = $1 AND category = 'admin' AND key = 'sso_login_enabled' FOR UPDATE`, [app.instanceId])).rows[0];
    if ((current?.enabled ?? defaultEnabled) === false) {
      const state = (await q.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = 'admin_sso_login_watch'", [app.instanceId])).rows[0]?.value as SsoState | undefined;
      // The alert helper receives the process pool, as required by alert-pool-guard. The setting stays locked until it returns.
      if (state && !state.enabled) await raiseSsoLoginStateAlert(app, state);
    }
    await q.query("COMMIT");
  } catch (e) { await q.query("ROLLBACK").catch(() => undefined); throw e; }
  finally { q.release(); }
}

/** The API hands off the state captured with its committed save, even if a later save has already enabled sign-in. */
export async function raiseSsoLoginStateAlert(app: Pick<App, "db" | "instanceId">, state: SsoState): Promise<void> {
  if (state.enabled) return;
  await raiseAlert({ control: app.db.control, audit: app.db.audit }, {
    instanceId: app.instanceId, level: "high", code: "admin_sso_login_disabled",
    summary: "Personal administrator sign-in is disabled. Review the setting and restore sign-in.",
    details: { ...(state.event ? { setting_change: state.event } : {}), ...(state.who ? { admin_login: state.who } : {}) },
    dedupeKey: `admin_sso_login_disabled:state:${state.period}`,
  });
}

/** Consecutive failed settings reloads after which the watcher says so in the log (the observation runs on each of them). */
export const SSO_WATCH_RELOAD_FAILURES = 3;

export function ssoLoginWatch(app: Pick<App, "settings" | "db" | "instanceId">): (phase: "startup" | "periodic" | "reload_failed") => Promise<void> {
  let reading = false, reloadFailures = 0;
  return async (phase) => {
    // the watcher reads the stored value even after a failed reload.
    // a failing or hung stored read can leave sign-in off with no alert.
    // Consecutive reload failures are logged on every pass from the third onward.
    if (phase === "reload_failed") {
      reloadFailures++;
      if (reloadFailures >= SSO_WATCH_RELOAD_FAILURES) log.warn("admin_sso_watch_reload_failed", { consecutive: reloadFailures });
    } else reloadFailures = 0;
    if (reading) return;
    reading = true;
    try { await observeSsoLoginState(app); }
    catch { log.warn("admin_sso_watch_read_failed", { reload_failures: reloadFailures }); }
    finally { reading = false; }
  };
}
