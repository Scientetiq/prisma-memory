import type { Context, Hono } from "hono";
import { invalid, MemoryError, newId, notFound, OPEN_RECHECK_STATE_KEY, openCheckSettings, openRecheckBatch, recheckText, recheckWhyOf } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { locate, readableSpaces } from "./access.ts";
import { audit } from "./audit.ts";
import { jsonObjectBody, rejectUnknownFields } from "./key-kind.ts";
import { intParam, isUuidParam, offsetCursor } from "./paging.ts";
import { requireHuman } from "./workplace.ts";

type AdminAudit = (c: any, op: string, details?: Record<string, unknown>) => Promise<void>;
const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);
const LISTED = ["held", "kept", "on_restore", "failed"];

export async function recheckSummary(app: App): Promise<Record<string, unknown>> {
  const ctl = app.db.control;
  const [state, running, held] = await Promise.all([
    ctl.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = $2", [app.instanceId, OPEN_RECHECK_STATE_KEY]),
    ctl.query("SELECT id, reason, phase, counts, created_at FROM open_rechecks WHERE instance_id = $1 AND state = 'running'", [app.instanceId]),
    ctl.query(`SELECT count(*) FILTER (WHERE state = 'held')::int AS held, count(*) FILTER (WHERE state = 'kept')::int AS kept,
                      count(*) FILTER (WHERE state = 'on_restore')::int AS on_restore, count(*) FILTER (WHERE state = 'failed')::int AS failed
                 FROM (SELECT DISTINCT ON (record_id) record_id, state FROM open_recheck_holds WHERE instance_id = $1 ORDER BY record_id, updated_at DESC) h`, [app.instanceId]),
  ]);
  const st = (state.rows[0]?.value ?? {}) as { baseline?: unknown[]; last?: Record<string, unknown> };
  const run = running.rows[0];
  return {
    enabled: app.settings.get<unknown>("open_check.recheck_on_nda_change", true) !== false,
    batch: openRecheckBatch(app.settings.get<unknown>("open_check.recheck_batch", 100)),
    baseline_known: Array.isArray(st.baseline),
    running: run ? { id: run.id, reason: run.reason, phase: run.phase, counts: run.counts ?? {}, started_at: iso(run.created_at) } : null,
    last: st.last ?? null,
    holds: held.rows[0] ?? { held: 0, kept: 0, on_restore: 0, failed: 0 },
  };
}

export function registerOpenRecheckAdmin(r: Hono<any>, app: App, adminAudit: AdminAudit): void {
  const ctl = app.db.control;
  r.use("/settings", async (c, next) => {
    await next();
    if (c.req.method === "PUT" && c.res.status < 300) await app.queue.wake("open_recheck").catch(() => false);
  });

  r.get("/open-check/recheck", async (c) => {
    await app.settings.load(true).catch(() => undefined);
    const limit = intParam(c.req.query("limit"), 50, 1, 200), offset = offsetCursor(c.req.query("cursor"));
    const stateQ = c.req.query("state");
    const states = stateQ && LISTED.includes(stateQ) ? [stateQ] : LISTED;
    const [summary, list] = await Promise.all([recheckSummary(app), ctl.query(
      `SELECT h.record_id, h.state, h.why, h.kinds, h.rules, h.held_at, h.decided_at, o.reason AS run_reason,
              s.slug, s.name AS space_name, s.kind AS space_kind, p.login, p.display_name, count(*) OVER () AS total
         FROM (SELECT DISTINCT ON (record_id) * FROM open_recheck_holds WHERE instance_id = $1 ORDER BY record_id, updated_at DESC) h
         JOIN open_rechecks o ON o.id = h.run_id LEFT JOIN spaces s ON s.id = h.space_id LEFT JOIN people p ON p.id = h.owner_id
        WHERE h.state = ANY($2::text[])
        ORDER BY h.held_at DESC NULLS LAST, h.record_id LIMIT $3 OFFSET $4`, [app.instanceId, states, limit + 1, offset])]);
    const last = (summary.last ?? null) as { run?: string } | null;
    const report = last?.run ? (await ctl.query("SELECT report FROM open_rechecks WHERE id = $1", [last.run])).rows[0]?.report ?? {} : {};
    const spaceIds = Array.isArray(report.spaces) ? report.spaces : [], entityIds = Array.isArray(report.entities) ? report.entities : [];
    const [spaces, entities] = await Promise.all([
      spaceIds.length ? ctl.query("SELECT slug, name, kind FROM spaces WHERE id = ANY($1::uuid[]) ORDER BY slug", [spaceIds]) : Promise.resolve({ rows: [] as any[] }),
      entityIds.length ? ctl.query("SELECT id, kind FROM entities WHERE id = ANY($1::uuid[]) ORDER BY id", [entityIds]) : Promise.resolve({ rows: [] as any[] }),
    ]);
    const rows = list.rows;
    return c.json({
      ...summary,
      report: { spaces: spaces.rows.map((s) => ({ slug: s.slug, name: s.name, kind: s.kind })), entities: entities.rows.map((e) => ({ id: e.id, kind: e.kind })) },
      items: rows.slice(0, limit).map((h) => ({
        record_id: h.record_id, state: h.state, why: h.why ?? null, kinds: h.kinds ?? [], rules: h.rules ?? [], run_reason: h.run_reason,
        held_at: iso(h.held_at), decided_at: iso(h.decided_at),
        space: h.slug ? { slug: h.slug, name: h.space_name, kind: h.space_kind } : null,
        author: h.login ? { login: h.login, display_name: h.display_name ?? null } : null,
      })),
      next_cursor: rows.length > limit ? String(offset + limit) : null,
      total: Number(rows[0]?.total ?? 0),
    });
  });

  r.post("/open-check/recheck", async (c) => {
    const body = jsonObjectBody(await c.req.json().catch(() => null), "{action: held | all}");
    rejectUnknownFields(body, ["action"]);
    if (body.action !== "held" && body.action !== "all") throw invalid("action: held to recheck hidden records, all to check everything again");
    await app.settings.load(true).catch(() => undefined);
    const caller = c.get("caller") as Caller;
    const names = body.action === "all" ? (openCheckSettings(app.settings).nda_customers ?? []).filter((n): n is string => typeof n === "string") : [];
    if (body.action === "all" && !names.length) throw invalid("The strict NDA client list is empty. There is nothing to check against", { reason: "nda_empty" });
    const id = newId(), reason = body.action === "all" ? "manual" : "held";
    try {
      await ctl.query(`INSERT INTO open_rechecks (id, instance_id, reason, names, tail_from, created_by) VALUES ($1, $2, $3, $4::jsonb, now() - interval '10 minutes', $5)`,
                      [id, app.instanceId, reason, JSON.stringify(names), caller.person?.id ?? null]);
    } catch (e) {
      if ((e as { code?: string }).code === "23505")
        throw new MemoryError("conflict", "A recheck is already running. Wait for its results on this page", { details: { reason: "recheck_running" } });
      throw e;
    }
    await adminAudit(c, "open_recheck_start", { run: id, reason });
    const woke = await app.queue.wake("open_recheck").catch(() => false);
    return c.json({ run: id, reason, woke }, 202);
  });
}

async function holdOf(app: App, id: string): Promise<{ run_id: string; state: string; why: string | null; held_at: Date | null; reason: string } | null> {
  return (await app.db.control.query(
    `SELECT h.run_id, h.state, h.why, h.held_at, o.reason FROM open_recheck_holds h JOIN open_rechecks o ON o.id = h.run_id
      WHERE h.instance_id = $1 AND h.record_id = $2 AND h.state IN ('held','kept','on_restore') ORDER BY h.updated_at DESC LIMIT 1`, [app.instanceId, id])).rows[0] ?? null;
}

async function authorOrOwner(app: App, caller: Caller, id: string) {
  if (!caller.person) throw notFound();
  const loc = await locate(app, id);
  if (!loc) throw notFound();
  if (loc.owner_id === caller.person.id) return loc;
  const spaces = await readableSpaces(app, caller);
  if (spaces.get(loc.space_id)?.role !== "owner") throw notFound();
  return loc;
}

export function registerOpenRecheckRecord(r: Hono<any>, app: App): void {
  const caller = (c: Context) => c.get("caller") as Caller;
  const recordId = (c: Context): string => { const id = c.req.param("id") ?? ""; if (!isUuidParam(id)) throw notFound(); return id; };
  r.get("/api/v1/records/:id/recheck", async (c) => {
    await requireHuman(app, caller(c), "See why a recheck hid the record", { path: "/records", section: "Records" });
    const id = recordId(c);
    await authorOrOwner(app, caller(c), id);
    const h = await holdOf(app, id);
    if (!h) return c.json({ held: false });
    const why = recheckWhyOf({ why: h.why, reason: h.reason });
    return c.json({ held: true, state: h.state, why, reason: h.reason, held_at: iso(h.held_at), text: recheckText(why), can_keep: h.state === "held" });
  });
  r.post("/api/v1/records/:id/recheck-keep", async (c) => {
    await requireHuman(app, caller(c), "Keep the record hidden", { path: "/records", section: "Records" });
    const id = recordId(c);
    const loc = await authorOrOwner(app, caller(c), id);
    const me = caller(c).person!.id;
    const n = (await app.db.control.query(
      `UPDATE open_recheck_holds SET state = 'kept', decided_by = $3, decided_at = now(), updated_at = now()
        WHERE instance_id = $1 AND record_id = $2 AND state = 'held' RETURNING run_id`, [app.instanceId, id, me])).rowCount ?? 0;
    if (!n) throw invalid("The record is not awaiting a decision. The recheck did not hide it, or a decision was already made", { reason: "not_held" });
    await audit(app, caller(c), { event_type: "processing", class: loc.class, record_ids: [id], space_id: loc.space_id,
                                  details: { op: "open_recheck_kept", ...(loc.owner_id !== me ? { author: loc.owner_id } : {}) } });
    return c.json({ id, state: "kept" });
  });
}
