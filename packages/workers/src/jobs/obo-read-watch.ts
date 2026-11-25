// Watch of on-behalf reads: hourly, over the last 24 hours of the journal — on behalf of how many
// people each service read (read, search, list events with on_behalf_of). Over access.obo_read_alert_people_day —
// medium alert obo_read_many_people, one per service a day. Read by role memory_audit_reader, with the index
// audit_events_obo_idx; alert: service id and name, people count only.
import { log, raiseAlert } from "@memory/shared";
import type { DbCtx } from "../ctx.ts";

export const OBO_READ_EVENTS = ["read", "search", "list"] as const;

export interface OboWatchResult { services: Array<{ service: string; people: number }>; alerts: number }

/** access.obo_read_alert_people_day (1–10000; junk: 20). */
export function oboPeopleLimit(s: DbCtx["settings"]): number {
  const n = Number(s.get<number>("access.obo_read_alert_people_day", 20));
  return Number.isFinite(n) ? Math.min(10_000, Math.max(1, Math.trunc(n))) : 20;
}

export async function oboReadWatch(ctx: DbCtx, o: { now?: Date } = {}): Promise<OboWatchResult> {
  const limit = oboPeopleLimit(ctx.settings);
  const { rows } = await ctx.db.auditRead().query(
    `SELECT service_id::text AS service, count(DISTINCT on_behalf_of)::int AS people FROM audit_events
      WHERE instance_id = $1 AND on_behalf_of IS NOT NULL AND service_id IS NOT NULL AND event_type = ANY($2::text[])
        AND at > now() - interval '24 hours'
      GROUP BY service_id HAVING count(DISTINCT on_behalf_of) > $3
      ORDER BY 2 DESC LIMIT 100`, [ctx.instanceId, [...OBO_READ_EVENTS], limit]);
  const found = rows as Array<{ service: string; people: number }>;
  if (!found.length) return { services: [], alerts: 0 };
  const names = new Map<string, string>(((await ctx.db.control.query("SELECT id::text AS id, name FROM services WHERE id = ANY($1::uuid[])", [found.map((r) => r.service)])).rows as Array<{ id: string; name: string }>)
    .map((r) => [r.id, r.name]));
  const day = (o.now ?? new Date()).toISOString().slice(0, 10);
  let alerts = 0;
  for (const r of found) {
    const a = await raiseAlert({ control: ctx.db.control, audit: ctx.db.audit }, {
      instanceId: ctx.instanceId, level: "medium", code: "obo_read_many_people",
      summary: `Service “${(names.get(r.service) ?? r.service).slice(0, 80)}” read on behalf of ${r.people} different people in one day (threshold ${limit})`,
      details: { service: r.service, people: r.people, day }, dedupeKey: `obo_read_many_people:${r.service}:${day}`,
    });
    if (a.inserted) alerts++;
  }
  if (alerts) log.warn("obo_read_many_people", { services: found.length, alerts });
  return { services: found, alerts };
}
