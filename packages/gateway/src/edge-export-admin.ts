import type { Context, Hono } from "hono";
import { invalid, isHumanSession } from "@memory/shared";
import { HUMAN_SESSION_REQUIRED, secondSignatureOn } from "./admin-plane/approvals.ts";
import { adminDb, AdminPlaneNotConfigured } from "./admin-plane/db.ts";
import type { App } from "./context.ts";
import { jsonObjectBody, rejectUnknownFields } from "./key-kind.ts";

type AdminAudit = (c: Context<any>, op: string, details?: Record<string, unknown>) => Promise<void>;
type Row = Record<string, any>;

export const CANARY_REQUEST_KEY = "edge_canary_request";
export const CANARY_STATE_KEY = "edge_canary";
export const UNKILL_NOT_READY_TEXT = "The automatic shutdown cannot be lifted yet. A clean reconciliation or a fresh canary check is still due. See the reasons for details";
export const EDGE_SERVICES = ["exporter", "intake", "reconciler"] as const;
export const HEARTBEAT_FRESH_MS = 120_000;
export const WATERMARK_WARN_MS = 30_000;
const THETA_DEFAULT_SEC = 120;

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string).toISOString());
const int = (v: unknown): number => Math.max(0, Number(v ?? 0) || 0);
const missingRelation = (e: unknown): boolean => (e as { code?: string })?.code === "42P01";

export interface EdgeExportStatus {
  export_enabled: boolean; queues_enabled: boolean;
  revoke_pending: number; revoke_age_ms: number | null; publish_pending: number;
  watermark_sent_at: string | null; last_full_sync_at: string | null; last_light_at: string | null; last_full_at: string | null;
  canary_state: "ok" | "tripped" | "unknown"; killed_at: string | null; killed_reason: string | null;
  last_result: Record<string, unknown> | null; reconcile_result: Record<string, unknown> | null;
  canary_checked_at: string | null; canary_tripped_at: string | null; canaries: number; updated_at: string | null;
  services: Array<{ service: (typeof EDGE_SERVICES)[number]; at: string; run_mode: "user" | "system" | "container"; fresh: boolean }>;
}

export async function edgeExportStatus(app: App, now = Date.now()): Promise<EdgeExportStatus> {
  const ctl = app.db.control;
  const enabled = app.settings.get<boolean>("edge.export_enabled", false) === true;
  let st: Row = {}, q: Row = {};
  try {
    st = (await ctl.query("SELECT * FROM edge_export_status WHERE one")).rows[0] ?? {};
    q = (await ctl.query("SELECT enabled FROM edge_outbox_control_state WHERE one")).rows[0] ?? {};
  } catch (e) {
    if (!missingRelation(e)) throw e;
  }
  const hb = (await ctl.query("SELECT service, at, run_mode FROM service_heartbeats WHERE instance_id = $1 AND service = ANY($2::text[]) ORDER BY service",
                              [app.instanceId, [...EDGE_SERVICES]]).catch((e) => { if (missingRelation(e)) return { rows: [] }; throw e; })).rows as Row[];
  const canary = (await ctl.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = $2", [app.instanceId, CANARY_STATE_KEY])).rows[0]?.value as Row | undefined;
  const pending = int(st.revoke_pending);
  return {
    export_enabled: enabled, queues_enabled: q.enabled === true,
    revoke_pending: pending, revoke_age_ms: st.revoke_age_ms === null || st.revoke_age_ms === undefined ? null : int(st.revoke_age_ms), publish_pending: int(st.publish_pending),
    watermark_sent_at: iso(st.watermark_sent_at), last_full_sync_at: iso(st.last_full_sync_at), last_light_at: iso(st.last_light_at), last_full_at: iso(st.last_full_at),
    canary_state: st.canary_state === "ok" || st.canary_state === "tripped" ? st.canary_state : "unknown",
    killed_at: iso(st.killed_at), killed_reason: (st.killed_reason as string | null | undefined) ?? null,
    last_result: (st.last_result as Row | null | undefined) ?? null, reconcile_result: (st.reconcile_result as Row | null | undefined) ?? null,
    canary_checked_at: iso(st.canary_checked_at), canary_tripped_at: iso(st.canary_tripped_at), canaries: int(canary?.active), updated_at: iso(st.updated_at),
    services: hb.map((h) => ({ service: h.service, at: iso(h.at)!, run_mode: h.run_mode, fresh: now - new Date(h.at).getTime() <= HEARTBEAT_FRESH_MS })),
  };
}

export interface EdgeExportCheck { ok: boolean; detail: string; level?: "ok" | "warn" | "fail" }

export async function edgeExportCheck(app: App, now = Date.now()): Promise<EdgeExportCheck | null> {
  const on = app.settings.get<boolean>("edge.export_enabled", false) === true;
  let st: Row | undefined, q: Row | undefined;
  try {
    st = (await app.db.control.query("SELECT watermark_sent_at, canary_state, killed_at, killed_reason FROM edge_export_status WHERE one")).rows[0];
    q = (await app.db.control.query("SELECT enabled, revoke_enabled FROM edge_outbox_control_state WHERE one")).rows[0];
  } catch (e) {
    if (missingRelation(e)) return null;
    throw e;
  }
  if (st?.killed_at) return { ok: false, level: "fail", detail: `edge export was shut off automatically (${st.killed_reason ?? "reason not recorded"}). An administrator must lift the shutdown` };
  if (st?.canary_state === "tripped") return { ok: false, level: "fail", detail: "a canary was found on the edge. Investigate before enabling export" };
  const seen = !!(q?.enabled || q?.revoke_enabled);
  if (!on) return seen ? { ok: true, detail: "edge export is off" } : null;
  const hb = (await app.db.control.query("SELECT at FROM service_heartbeats WHERE instance_id = $1 AND service = 'exporter'", [app.instanceId])
    .catch((e) => { if (missingRelation(e)) return { rows: [] }; throw e; })).rows[0] as Row | undefined;
  if (!hb?.at || now - new Date(hb.at).getTime() > HEARTBEAT_FRESH_MS)
    return { ok: false, level: "fail", detail: "edge export is on, but the exporter is not responding. Revocations and the watermark are not being sent" };
  const theta = (Number(app.settings.get<number>("edge.deadman_theta_sec", THETA_DEFAULT_SEC)) || THETA_DEFAULT_SEC) * 1000;
  const age = st?.watermark_sent_at ? Math.max(0, now - new Date(st.watermark_sent_at).getTime()) : null;
  const canary = st?.canary_state === "ok" ? "checked" : "not yet checked";
  if (age !== null && age > theta)
    return { ok: false, level: "fail", detail: `watermark last sent ${Math.round(age / 1000)} s ago, beyond the ${Math.round(theta / 1000)} s limit. The edge shut itself off (“dead man’s switch”)` };
  const mark = age === null ? "watermark not yet sent (waiting for full synchronization and the first reconciliation)" : `watermark last sent ${Math.round(age / 1000)} s ago`;
  return { ok: true, level: age === null || age > WATERMARK_WARN_MS ? "warn" : "ok", detail: `edge export is on; ${mark}; canaries ${canary}` };
}

export function registerEdgeExportAdmin(r: Hono<any>, app: App, adminAudit: AdminAudit): void {
  const adminOf = (c: Context<any>) => (c.get("caller") as { admin?: Parameters<typeof isHumanSession>[0] & { login?: string } } | undefined)?.admin ?? null;
  const humanOrSigned = (c: Context<any>): boolean => secondSignatureOn(app) || isHumanSession(adminOf(c));
  r.get("/edge-export/status", async (c) => c.json(await edgeExportStatus(app)));

  r.post("/edge-export/canaries", async (c) => {
    const requested_at = new Date().toISOString();
    await app.db.control.query(
      `INSERT INTO maintenance_state (instance_id, key, value, updated_at) VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (instance_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [app.instanceId, CANARY_REQUEST_KEY, JSON.stringify({ requested_at })]);
    await adminAudit(c, "edge_canaries_requested", { requested_at });
    return c.json({ requested_at }, 202);
  });

  r.post("/edge/unkill", async (c) => {
    const b = jsonObjectBody(await c.req.json().catch(() => null), "{reason, killed_at}");
    rejectUnknownFields(b, ["reason", "killed_at"]);
    if (typeof b.reason !== "string" || !b.reason.trim() || b.reason.length > 500) throw invalid("reason: why the shutdown is being lifted, 1 to 500 characters");
    const a = adminOf(c);
    if (!humanOrSigned(c)) return c.json(HUMAN_SESSION_REQUIRED, 403);
    if (typeof b.killed_at !== "string" || b.killed_at.length > 40 || !Number.isFinite(Date.parse(b.killed_at)))
      throw invalid("killed_at: automatic shutdown time shown in the admin panel (ISO 8601)");
    const seen = new Date(b.killed_at);
    let db;
    try { db = adminDb(app); } catch (e) {
      if (!(e instanceof AdminPlaneNotConfigured)) throw e;
      return c.json({ code: "admin_plane_required", message: "Lifting the automatic export shutdown requires the admin plane, which is not configured" }, 503);
    }
    const st = (await app.db.control.query<{ killed_reason: string | null }>("SELECT killed_reason FROM edge_export_status WHERE one")).rows[0];
    const by = `admin:${a?.login ?? "system"}`.slice(0, 200);
    const res = (await db.query<{ ok: boolean; reasons: string[] }>("SELECT ok, reasons FROM edge_unkill_checked($1, $2)", [by, seen])).rows[0];
    if (!res?.ok) {
      const reasons = res?.reasons ?? ["not_killed"];
      await adminAudit(c, "edge_unkill_refused", { reasons, killed_at: seen.toISOString() });
      return c.json({ code: "unkill_not_ready", message: UNKILL_NOT_READY_TEXT, details: { reasons } }, 409);
    }
    await adminAudit(c, "edge_unkill", { reason: b.reason.trim().slice(0, 500), killed_reason: st?.killed_reason ?? null, killed_at: seen.toISOString() });
    return c.json({ was_killed: true });
  });

  r.get("/edge-export/canary-holds", async (c) => {
    try {
      const rows = (await app.db.control.query<{ record_id: string; created_at: Date }>(
        "SELECT record_id, created_at FROM edge_hold WHERE reason = 'manual' AND source = 'canary_trip' ORDER BY created_at DESC, record_id LIMIT 50")).rows;
      return c.json({ items: rows.map((x) => ({ record_id: x.record_id, created_at: iso(x.created_at)! })) });
    } catch (e) {
      if (missingRelation(e)) return c.json({ items: [] });
      throw e;
    }
  });

  r.post("/edge-export/canary-holds/:id/release", async (c) => {
    const id = c.req.param("id");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw invalid("id: record identifier");
    if (!humanOrSigned(c)) return c.json(HUMAN_SESSION_REQUIRED, 403);
    let db;
    try { db = adminDb(app); } catch (e) {
      if (!(e instanceof AdminPlaneNotConfigured)) throw e;
      return c.json({ code: "admin_plane_required", message: "Releasing a canary finding requires the admin plane, which is not configured" }, 503);
    }
    const released = (await db.query<{ ok: boolean }>("SELECT edge_canary_hold_release($1::uuid) AS ok", [id])).rows[0]?.ok === true;
    if (released) await adminAudit(c, "canary_hold_released", { record_id: id });
    return c.json({ released: released ? 1 : 0 });
  });

  r.post("/edge-export/canary-holds/release", async (c) => {
    const b = jsonObjectBody(await c.req.json().catch(() => null), "{since}");
    rejectUnknownFields(b, ["since"]);
    let since = "-infinity";
    if (b.since !== undefined && b.since !== null) {
      if (typeof b.since !== "string" || !Number.isFinite(Date.parse(b.since))) throw invalid("since: an ISO 8601 timestamp or null to release all findings");
      since = new Date(b.since).toISOString();
    }
    if (!humanOrSigned(c)) return c.json(HUMAN_SESSION_REQUIRED, 403);
    let db;
    try { db = adminDb(app); } catch (e) {
      if (!(e instanceof AdminPlaneNotConfigured)) throw e;
      return c.json({ code: "admin_plane_required", message: "Releasing canary findings requires the admin plane, which is not configured" }, 503);
    }
    const n = Number((await db.query<{ n: number }>("SELECT edge_canary_hold_release_since($1::timestamptz) AS n", [since])).rows[0]?.n ?? 0);
    if (n) await adminAudit(c, "canary_hold_released", { count: n, since: since === "-infinity" ? null : since });
    return c.json({ released: n });
  });
}
