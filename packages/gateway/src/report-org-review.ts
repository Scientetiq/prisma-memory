// The `org_review` section of the administrator's morning report (GET /api/v1/admin/report):
// how many wait in "Shared knowledge review", the oldest, how many are held as "Wrong / not for everyone", how many returned in
// the window (by term — separately: returns are not "moves"), curator decisions and curators. "Wrong" marks of the window — with
// the marker's login (finding abuse: any employee can hide a record from agents). Ids and logins, without content.
// Returns on narrowed readers (the organizer changed the people, a service sent a new list, a job pick; details.reason
// narrowed) — as their own number `narrowed`, not among "by authors": count = auto + curator +
// author + narrowed.
import { orgCurators, orgQueueCounts, orgReviewEnabled } from "@memory/shared";
import type { App } from "./context.ts";
import { orgSpace } from "./org-hold.ts";

const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);

export async function orgReviewReport(app: App, hours: number) {
  const ctl = app.db.control;
  const org = await orgSpace(app);
  const [counts, curators, last] = await Promise.all([
    orgQueueCounts(ctl, app.instanceId),
    orgCurators(ctl, app.instanceId, false),
    ctl.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = 'org_review'", [app.instanceId]).then((r) => r.rows[0]?.value ?? null),
  ]);
  const ev = (await app.db.auditRead().query(
    `SELECT count(*) FILTER (WHERE event_type = 'promote' AND details->>'op' = 'org_return')::int AS returned,
            count(*) FILTER (WHERE event_type = 'promote' AND details->>'op' = 'org_return' AND details->>'by' = 'auto')::int AS returned_auto,
            count(*) FILTER (WHERE event_type = 'promote' AND details->>'op' = 'org_return' AND details->>'by' = 'curator')::int AS returned_curator,
            count(*) FILTER (WHERE event_type = 'promote' AND details->>'op' = 'org_return' AND details->>'by' = 'author'
                              AND details->>'reason' IS DISTINCT FROM 'narrowed')::int AS returned_author,
            count(*) FILTER (WHERE event_type = 'promote' AND details->>'op' = 'org_return' AND details->>'reason' = 'narrowed')::int AS returned_narrowed,
            count(*) FILTER (WHERE event_type = 'confirmation' AND details->>'op' = 'org_confirm')::int AS confirmed,
            count(*) FILTER (WHERE event_type = 'confirmation' AND details->>'op' = 'org_useful' AND details->>'community' = 'true')::int AS community,
            count(*) FILTER (WHERE event_type = 'forget' AND details->>'op' = 'org_delete')::int AS deleted,
            count(*) FILTER (WHERE event_type = 'admin' AND details->>'op' = 'org_digest')::int AS digests
       FROM audit_events WHERE instance_id = $1 AND at > now() - make_interval(hours => $2) AND details->>'tool' = 'org_review'`,
    [app.instanceId, hours])).rows[0] ?? {};
  const holds = (await app.db.auditRead().query(
    `SELECT at, record_ids[1] AS record_id, principal_id, details->>'reason' AS reason, count(*) OVER ()::int AS total
       FROM audit_events WHERE instance_id = $1 AND at > now() - make_interval(hours => $2) AND event_type = 'confirmation'
        AND details->>'tool' = 'org_review' AND details->>'op' = 'org_wrong'
      ORDER BY at DESC LIMIT 50`, [app.instanceId, hours])).rows;
  const ids = [...new Set(holds.map((h) => h.principal_id).filter(Boolean))];
  const logins = new Map((ids.length ? (await ctl.query("SELECT id, login FROM people WHERE id = ANY($1::uuid[])", [ids])).rows : []).map((p) => [p.id as string, p.login as string]));
  return {
    enabled: orgReviewEnabled(app.settings), org: org?.slug ?? null,
    waiting: counts.waiting, new_week: counts.new_week, held: counts.held, due_week: counts.due_week, oldest_entered_at: iso(counts.oldest),
    returned: { count: ev.returned ?? 0, auto: ev.returned_auto ?? 0, curator: ev.returned_curator ?? 0, author: ev.returned_author ?? 0, narrowed: ev.returned_narrowed ?? 0 },
    confirmed: ev.confirmed ?? 0, community: ev.community ?? 0, deleted: ev.deleted ?? 0, digests: ev.digests ?? 0,
    curators: { count: curators.length, logins: curators.slice(0, 20).map((p) => p.login) },
    wrong_marks: { count: (holds[0]?.total as number | undefined) ?? 0,
                   items: holds.map((h) => ({ at: iso(h.at), record_id: h.record_id as string, by: logins.get(h.principal_id) ?? null, reason: (h.reason as string | null) ?? null })) },
    last_run: last,
  };
}
