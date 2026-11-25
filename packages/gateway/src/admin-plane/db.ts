import type pg from "pg";
import type { App } from "../context.ts";

export class AdminPlaneNotConfigured extends Error {
  constructor() { super("The admin plane is not configured. The memory_admin_plane role has no password in the gateway key directory"); }
}

export function adminDb(app: App): pg.Pool {
  if (!app.adminDb) throw new AdminPlaneNotConfigured();
  return app.adminDb;
}

export const adminPlaneConfigured = (app: App): boolean => !!app.adminDb;

/**
 * which pool of memory_admin_plane the gateway keeps. With the separate administrator listener — adminDb, as
 * always. Without it (the legacy layout) the admin plane stays OFF even when the role has a password: every reader of
 * adminDb() / adminPlaneConfigured() answers as without the admin plane (503 admin_plane_required, break-glass «closed», …);
 * the role's pool goes only to alertsDb, which nothing but the legacy alerts router reads. `open` is called once.
 */
export function adminPlanePools(adminSeparate: boolean, open: () => pg.Pool | null): { adminDb: pg.Pool | null; alertsDb: pg.Pool | null } {
  const pool = open();
  return adminSeparate ? { adminDb: pool, alertsDb: null } : { adminDb: null, alertsDb: pool };
}

/** The pool of the alerts router: the admin plane's where it exists, else the legacy alerts pool; neither — not configured. */
export function alertsPool(app: App): pg.Pool {
  const pool = app.adminDb ?? app.alertsDb;
  if (!pool) throw new AdminPlaneNotConfigured();
  return pool;
}
