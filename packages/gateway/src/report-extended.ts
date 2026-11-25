// Extended access and open content in the administrator's morning report (GET /api/v1/admin/report):
// how much agents with extended access wrote into open content by permission in the window (events with
// `details.extended_open`) and how much the gate refused (`op: extended_open_denied`), which keys have permission now, and
// the last 50 actions — ids, the space and the login, without content.
import type { App } from "./context.ts";

const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);
const WHERE = `instance_id = $1 AND at > now() - make_interval(hours => $2)
  AND (details->>'extended_open' = 'true' OR details->>'op' = 'extended_open_denied')`;

export interface ExtendedOpenItem { at: string | null; outcome: "written" | "denied"; attempt: string | null; record_id: string | null; space: string | null; by: string | null }
export interface ExtendedOpenReport {
  written: number; denied: number;
  keys_allowed: Array<{ id: string; key_prefix: string; principal: string | null; expires_at: string | null }>;
  items: ExtendedOpenItem[];
}

export async function extendedOpenReport(app: App, hours: number): Promise<ExtendedOpenReport> {
  const audit = app.db.auditRead(), ctl = app.db.control;
  const [counts, events, keys] = await Promise.all([
    audit.query(`SELECT count(*) FILTER (WHERE details->>'extended_open' = 'true')::int AS written,
                        count(*) FILTER (WHERE details->>'op' = 'extended_open_denied')::int AS denied
                 FROM audit_events WHERE ${WHERE}`, [app.instanceId, hours]).then((r) => r.rows[0] ?? {}),
    audit.query(`SELECT at, record_ids[1] AS record_id, space_id, principal_id, (details->>'extended_open' = 'true') AS written,
                        COALESCE(details->>'extended_op', details->>'attempt') AS attempt
                 FROM audit_events WHERE ${WHERE} ORDER BY at DESC LIMIT 50`, [app.instanceId, hours]).then((r) => r.rows),
    // live keys with permission — regardless of the window: the administrator sees who is allowed now
    ctl.query(`SELECT k.id, k.key_prefix, p.login, k.expires_at FROM api_keys k LEFT JOIN people p ON k.principal_type = 'person' AND p.id = k.principal_id
               WHERE k.instance_id = $1 AND k.open_write AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())
               ORDER BY k.created_at LIMIT 200`, [app.instanceId]).then((r) => r.rows),
  ]);
  const spaceIds = [...new Set(events.map((e) => e.space_id).filter(Boolean))];
  const peopleIds = [...new Set(events.map((e) => e.principal_id).filter(Boolean))];
  const slugs = new Map((spaceIds.length ? (await ctl.query("SELECT id, slug FROM spaces WHERE id = ANY($1::uuid[])", [spaceIds])).rows : []).map((s) => [s.id as string, s.slug as string]));
  const logins = new Map((peopleIds.length ? (await ctl.query("SELECT id, login FROM people WHERE id = ANY($1::uuid[])", [peopleIds])).rows : []).map((p) => [p.id as string, p.login as string]));
  return {
    written: Number(counts.written ?? 0), denied: Number(counts.denied ?? 0),
    keys_allowed: keys.map((k) => ({ id: k.id as string, key_prefix: k.key_prefix as string, principal: (k.login as string | null) ?? null, expires_at: iso(k.expires_at) })),
    items: events.map((e) => ({ at: iso(e.at), outcome: e.written === true ? "written" as const : "denied" as const, attempt: (e.attempt as string | null) ?? null,
                                record_id: (e.record_id as string | null) ?? null, space: e.space_id ? slugs.get(e.space_id) ?? null : null,
                                by: e.principal_id ? logins.get(e.principal_id) ?? null : null })),
  };
}
