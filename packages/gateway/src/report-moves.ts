// Moves and returns in the administrator's morning report (GET /api/v1/admin/report). Moves into a team and into org:
// where, whose record, who moved it. Returns of one's own records to personal (`details.op: return`) — a separate block
// `returns`: they are not in `promotions`. Returns and deletions by curators of "Company shared knowledge" (`op: org_*`)
// — in neither: they have their own `org_review` section (report-org-review.ts). Ids and logins, without content.
import type { App } from "./context.ts";

const iso = (v: Date | string | null) => v ? new Date(v).toISOString() : null;

export async function movesReport(app: App, hours: number) {
  // $3: returns (true) or moves (false) — one query per kind, each with its own counter and its own limit of 50
  const events = (returns: boolean) => app.db.auditRead().query(
    `SELECT at, record_ids[1] AS record_id, class, space_id, principal_id, details->>'from_space' AS from_space, details->>'author' AS author, count(*) OVER ()::int AS total
     FROM audit_events WHERE instance_id = $1 AND event_type = 'promote' AND at > now() - make_interval(hours => $2)
       AND (COALESCE(details->>'op', '') = 'return') = $3 AND COALESCE(details->>'op', '') NOT LIKE 'org\\_%'
     ORDER BY at DESC LIMIT 50`, [app.instanceId, hours, returns]).then((r) => r.rows);
  const [promo, back] = await Promise.all([events(false), events(true)]);
  const all = [...promo, ...back];
  const spaceIds = [...new Set(all.flatMap((p) => [p.space_id, p.from_space]).filter(Boolean))];
  const peopleIds = [...new Set(all.flatMap((p) => [p.principal_id, p.author]).filter(Boolean))];
  const ctl = app.db.control;
  const slugs = new Map((spaceIds.length ? (await ctl.query("SELECT id, slug, kind FROM spaces WHERE id = ANY($1::uuid[])", [spaceIds])).rows : []).map((s) => [s.id as string, s as { slug: string; kind: string }]));
  const logins = new Map((peopleIds.length ? (await ctl.query("SELECT id, login FROM people WHERE id = ANY($1::uuid[])", [peopleIds])).rows : []).map((p) => [p.id as string, p.login as string]));
  const promotions = { count: (promo[0]?.total as number | undefined) ?? 0, to_org: promo.filter((p) => slugs.get(p.space_id)?.kind === "org").length,
    items: promo.map((p) => ({ at: iso(p.at), record_id: p.record_id as string, class: p.class as string | null, to_space: slugs.get(p.space_id)?.slug ?? null,
                               from_space: slugs.get(p.from_space)?.slug ?? null, by: logins.get(p.principal_id) ?? null,
                               author: p.author ? logins.get(p.author) ?? null : logins.get(p.principal_id) ?? null })) };
  // only the author returns: by — the same one; where to — their personal space, so it is not shown
  const returns = { count: (back[0]?.total as number | undefined) ?? 0,
    items: back.map((p) => ({ at: iso(p.at), record_id: p.record_id as string, class: p.class as string | null, from_space: slugs.get(p.from_space)?.slug ?? null,
                              by: logins.get(p.principal_id) ?? null })) };
  return { promotions, returns };
}
