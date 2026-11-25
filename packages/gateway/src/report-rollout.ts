// "Rollout" in the morning report: for the last
// finished week. AI agent sessions and the open check are prepared by the outcomes_build job (the week row), notes by
// space and the adoption funnel the gateway counts on the fly from control — only it reads user_sessions. Numbers only: no
// logins, no titles, no record ids. Test people and the showcase are cut off by testLoginSql/showcaseSql (without tp_*):
// without include_test they count neither in the directory, nor among note owners, nor among space participants (else
// test participants would make the space of one real person "big"). min_group — the threshold by the current setting:
// by it sessions.small, "Small spaces" and the median; the panel writes it as a number ("fewer than 5 participants").
import { addDays, showcaseSql, testLoginSql, zonedMidnight } from "@memory/shared";
import type { App } from "./context.ts";
import { agentOutcomePeople, rolloutWeek } from "./report-search-quality.ts";

export interface RolloutCount { spaces: number; notes: number; new_week: number }
export interface SpaceNotesRow { slug: string; name: string; kind: "personal" | "team" | "project" | "org"; archived: boolean; members: number; notes: number; new_week: number }

const DAY_MS = 86_400_000;
const ITEMS_MAX = 100;
const n = (v: unknown): number => Number(v ?? 0) || 0;

/**
 * Notes by space: personal ones — in one line; team and project ones with fewer than minGroup
 * live participants (members; without include_test — without test ones and the showcase) — in one line "Small
 * spaces"; the organizational one — always its own line (it is shared by all and reveals no small group); the rest —
 * one by one, more notes higher, then more new ones, then by address; at most 100.
 */
export function groupNotes(rows: SpaceNotesRow[], minGroup: number) {
  const zero = (): RolloutCount => ({ spaces: 0, notes: 0, new_week: 0 });
  const personal = zero(), small = zero(), items: Array<Omit<SpaceNotesRow, "members"> & { kind: "team" | "project" | "org" }> = [];
  for (const r of rows) {
    if (r.notes <= 0) continue;
    const bucket = r.kind === "personal" ? personal : r.kind !== "org" && r.members < minGroup ? small : null;
    if (bucket) { bucket.spaces += 1; bucket.notes += r.notes; bucket.new_week += r.new_week; continue; }
    items.push({ slug: r.slug, name: r.name, kind: r.kind as "team" | "project" | "org", archived: r.archived, notes: r.notes, new_week: r.new_week });
  }
  items.sort((a, b) => b.notes - a.notes || b.new_week - a.new_week || a.slug.localeCompare(b.slug));
  return { personal, small, items: items.slice(0, ITEMS_MAX) };
}

/** The median of days (to one tenth) or null if there are fewer people than the threshold. */
export function medianDays(spans: number[], minGroup: number): number | null {
  if (spans.length < minGroup || !spans.length) return null;
  const xs = [...spans].sort((a, b) => a - b), m = xs.length >> 1;
  const v = xs.length % 2 ? xs[m]! : (xs[m - 1]! + xs[m]!) / 2;
  return Number(Math.max(0, v).toFixed(1));
}

/** The "Rollout" section (GET /admin/report → rollout). */
export async function rolloutReport(app: App, includeTest: boolean, current: boolean) {
  const wk = await rolloutWeek(app, includeTest, current);
  const from = new Date(zonedMidnight(wk.weekStart, wk.tz)), to = new Date(zonedMidnight(addDays(wk.weekStart, 7), wk.tz));
  const ro = wk.row?.rollout && typeof wk.row.rollout === "object" ? wk.row.rollout : null;
  const s = ro?.sessions, oc = ro?.open_check;
  const sessions = s ? (n(s.people) < wk.minGroup ? { small: true } : {
    small: false, total: n(s.total), with_query: n(s.with_query), found_past_by_query: n(s.found_past_by_query), read_past: n(s.read_past),
    found_colleague_notes: n(s.found_colleague_notes), overview_found_past: n(s.overview_found_past) }) : null;
  const open_check = oc ? { agent_notes: n(oc.agent_notes), agent_refused: n(oc.agent_refused), agent_saved_closed: n(oc.agent_saved_closed),
    other_by_via: Object.fromEntries(Object.entries(oc.other_by_via ?? {}).map(([k, v]) => [k, n(v)]).filter(([, v]) => (v as number) > 0)) } : null;

  const ctl = app.db.control;
  const notTest = (p: string) => (includeTest ? "TRUE" : `NOT ${testLoginSql(p)} AND NOT ${showcaseSql(p)}`);
  const spaceRows = (await ctl.query(
    `SELECT s.slug, s.name, s.kind, s.archived_at IS NOT NULL AS archived,
            (SELECT count(*) FROM space_members_effective m JOIN people mp ON mp.id = m.person_id WHERE m.space_id = s.id AND ${notTest("mp")})::int AS members,
            count(*)::int AS notes, count(*) FILTER (WHERE l.created_at >= $2 AND l.created_at < $3)::int AS new_week
       FROM record_locations l JOIN spaces s ON s.id = l.space_id AND s.instance_id = $1 JOIN people o ON o.id = l.owner_id
      WHERE l.type = 'note' AND NOT l.deleted AND ${notTest("o")}
      GROUP BY s.id, s.slug, s.name, s.kind, s.archived_at`, [app.instanceId, from, to])).rows as SpaceNotesRow[];
  const notes_by_space = groupNotes(spaceRows, wk.minGroup);

  // the funnel: who counts — live employees of the instance without test ones and the showcase (without include_test)
  const people = (await ctl.query(`SELECT p.id FROM people p WHERE p.instance_id = $1 AND p.active AND ${notTest("p")}`, [app.instanceId])).rows.map((r) => r.id as string);
  const catalog = new Set(people);
  const ids = [...catalog];
  const firstLogin = new Map<string, number>(
    (await ctl.query(`SELECT person_id, min(created_at) AS at FROM user_sessions WHERE instance_id = $1 AND source IN ('ldap','oidc') AND person_id = ANY($2::uuid[]) GROUP BY person_id`,
      [app.instanceId, ids])).rows.map((r) => [r.person_id as string, new Date(r.at).getTime()]));
  const keyed = new Set<string>((await ctl.query(
    `SELECT DISTINCT principal_id FROM api_keys WHERE instance_id = $1 AND principal_type = 'person' AND kind IN ('personal','extended') AND NOT preview
        AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()) AND principal_id = ANY($2::uuid[])`, [app.instanceId, ids])).rows.map((r) => r.principal_id as string));
  const noted = new Set<string>((await ctl.query(
    `SELECT DISTINCT l.owner_id FROM record_locations l JOIN spaces s ON s.id = l.space_id AND s.instance_id = $1
      WHERE l.type = 'note' AND NOT l.deleted AND l.owner_id = ANY($2::uuid[])`, [app.instanceId, ids])).rows.map((r) => r.owner_id as string));
  const inProject = new Set<string>((await ctl.query(
    `SELECT DISTINCT m.person_id FROM space_members_effective m JOIN spaces s ON s.id = m.space_id
      WHERE s.instance_id = $1 AND s.kind = 'project' AND s.archived_at IS NULL AND m.person_id = ANY($2::uuid[])`, [app.instanceId, ids])).rows.map((r) => r.person_id as string));
  // a meeting: the organizer or on its people list, both bases, with the system scope (as the report's summary by types)
  const met = new Set<string>();
  for (const k of ["open", "closed"] as const) {
    const db = app.db.records(k, { classes: ["open", "closed"], tier: "system" });
    for (const r of (await db.query(
      `SELECT DISTINCT x.p FROM (
         SELECT r.owner_id AS p FROM records_live r WHERE r.type = 'transcript' AND r.parent_id IS NULL AND r.owner_id = ANY($1::uuid[])
         UNION SELECT rp.person_id FROM record_people rp JOIN records_live r ON r.id = rp.record_id
                WHERE r.type = 'transcript' AND r.parent_id IS NULL AND rp.person_id = ANY($1::uuid[])) x`, [ids])).rows) met.add(r.p as string);
  }
  const agent = await agentOutcomePeople(app);
  const count = (s: Set<string> | Map<string, unknown>) => [...s.keys()].filter((p) => catalog.has(p)).length;
  const steps = [firstLogin, keyed, agent.found, agent.read, noted, met, inProject].map((s, i) => ({ step: i + 1, people: count(s) }));
  const spans = [...agent.firstRead].filter(([p]) => catalog.has(p) && firstLogin.has(p)).map(([p, t]) => (t - firstLogin.get(p)!) / DAY_MS).filter((d) => d >= 0);
  return { week_start: wk.weekStart, week_end: addDays(wk.weekStart, 6), min_group: wk.minGroup, sessions, open_check, notes_by_space,
           funnel: { catalog: catalog.size, steps, median_days_first_login_to_read: medianDays(spans, wk.minGroup) } };
}
