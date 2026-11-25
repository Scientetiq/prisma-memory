// "When it happened" before the fix: only a count
// and a list in the administrator's morning report, nothing is shifted. Before the fix the workplace read a field value without
// a zone by its server's clock in UTC: in a UTC+5 zone 10:00 was saved as 10:00Z (15:00 local), a time after 19:00 moved
// to the next day. An automatic shift would edit records unknown to the author, need an edit of chunks.occurred_at and change
// the record address at a month boundary — so only a list: the author, when created, a link to the card. The event time is
// not in the list: for a closed record the panel sees only year and month (the folder in the address), an exact time is more than
// the decision allows; the author is asked to check the time — they see it in their record.
//
// The criterion ("the time was typed by hand" can be told from "empty — now" only roughly):
//  1) the record is live (records_live), "said by a person" by hand: source_kind = agent, method = stated_by_human,
//     origin = human, a note or an event;
//  2) the event time differs from the intake time by over a minute: an empty field is "now", off by fractions of a second;
//  3) taken in before the fix — earlier than the first gateway start with it (maintenance_state.wall_time_fix, markWallTimeFix);
//  4) created through the workplace: the journal write event of this record (record_ids[1]) — by a workplace session
//     (details.session), source_kind agent, no handover to a project (op handover copies the source record's time). An agent with
//     a key passes the time with a zone (format date-time), its records had no shift.
// Not caught: a time typed exactly 3 hours before the write moment (saved as "now"), and records corrected
// later by a new version (a version has another id and another journal event). No titles: the panel does not see closed content.
//
// The section is counted only on request: the panel's "Report" page passes manual_time=true. The panel overview (the same report
// for a day at each opening) and other report clients do not ask: they need no pass over both bases' records_live and journal.
import type { App } from "./context.ts";
import { log } from "@memory/shared";

/** The maintenance_state key: the moment from which the fix works (the first gateway start with it). */
export const WALL_TIME_FIX_KEY = "wall_time_fix";
/** List rows in the report; the number is always complete. */
export const WALL_TIME_ITEMS = 100;
/** The "time typed by hand" threshold, seconds. */
const MANUAL_GAP_SEC = 60;

/** The GET /admin/report query parameter: the section is counted only if it equals "true". */
export const MANUAL_TIME_PARAM = "manual_time";

export interface WallTimeItem { id: string; author: string | null; created_at: string }
export interface WallTimeReview { since: string; count: number; items: WallTimeItem[] }

/**
 * Mark the fix moment: once, at the first gateway start with it; later starts keep the mark. A failure goes to the log,
 * the start does not stop (the report section is then empty — null — until the next start).
 */
export async function markWallTimeFix(app: Pick<App, "db" | "instanceId">): Promise<void> {
  try {
    await app.db.control.query(
      `INSERT INTO maintenance_state (instance_id, key, value, updated_at) VALUES ($1, $2, jsonb_build_object('since', now()), now())
       ON CONFLICT (instance_id, key) DO NOTHING`, [app.instanceId, WALL_TIME_FIX_KEY]);
  } catch (e) {
    log.warn("wall_time_fix_mark_failed", { error: (e as Error).message.slice(0, 200) });
  }
}

/** The report section: null — the fix moment is not marked yet (the gateway with the fix has not started). */
export async function wallTimeReview(app: App): Promise<WallTimeReview | null> {
  const ctl = app.db.control;
  const mark = (await ctl.query("SELECT value->>'since' AS since FROM maintenance_state WHERE instance_id = $1 AND key = $2", [app.instanceId, WALL_TIME_FIX_KEY])).rows[0];
  const since = mark?.since ? new Date(mark.since) : null;
  if (!since || Number.isNaN(since.getTime())) return null;
  // 1–3: live manual "said by a person" records with a time typed by hand, taken in before the fix — in both bases
  const sys = { classes: ["open", "closed"] as const, tier: "system" as const };
  const found = new Map<string, { owner_id: string; ingested_at: Date }>();
  for (const k of ["open", "closed"] as const)
    for (const r of (await app.db.records(k, sys).query(
      `SELECT r.id, r.owner_id, r.ingested_at FROM records_live r
       WHERE r.source_kind = 'agent' AND r.method = 'stated_by_human' AND r.origin = 'human' AND r.type IN ('note', 'event')
         AND r.ingested_at < $1 AND abs(extract(epoch FROM r.occurred_at - r.ingested_at)) > $2`, [since, MANUAL_GAP_SEC])).rows)
      found.set(r.id, r);
  if (!found.size) return { since: since.toISOString(), count: 0, items: [] };
  // 4: of them — those created through the workplace (a session), not by an agent with a key
  const ids = [...found.keys()], viaWorkplace = new Set<string>();
  for (let i = 0; i < ids.length; i += 1000) {
    const part = ids.slice(i, i + 1000);
    for (const x of (await app.db.auditRead().query(
      `SELECT DISTINCT record_ids[1] AS id FROM audit_events
       WHERE instance_id = $1 AND event_type = 'write' AND record_ids && $2::uuid[] AND record_ids[1] = ANY($2::uuid[])
         AND details->>'session' = 'true' AND details->>'source_kind' = 'agent' AND details->>'type' IN ('note', 'event')
         AND COALESCE(details->>'op', '') <> 'handover'`, [app.instanceId, part])).rows) viaWorkplace.add(x.id);
  }
  const rows = ids.filter((id) => viaWorkplace.has(id)).map((id) => ({ id, ...found.get(id)! }))
    .sort((a, b) => b.ingested_at.getTime() - a.ingested_at.getTime() || a.id.localeCompare(b.id));
  const top = rows.slice(0, WALL_TIME_ITEMS);
  const owners = [...new Set(top.map((r) => r.owner_id))];
  const logins = new Map<string, string>(owners.length
    ? (await ctl.query("SELECT id, login FROM people WHERE id = ANY($1::uuid[])", [owners])).rows.map((p) => [p.id as string, p.login as string]) : []);
  return { since: since.toISOString(), count: rows.length,
           items: top.map((r) => ({ id: r.id, author: logins.get(r.owner_id) ?? null, created_at: new Date(r.ingested_at).toISOString() })) };
}

/**
 * The section for the report answer: only when asked (MANUAL_TIME_PARAM = "true"), else no field. A calculation failure —
 * null through the report's section(): the report gives the rest.
 */
export async function manualTimeSection(app: App, asked: string | undefined,
                                        section: <T>(name: string, f: () => Promise<T>) => Promise<T | null>): Promise<{ manual_time_review?: WallTimeReview | null }> {
  if (asked !== "true") return {};
  return { manual_time_review: await section("manual_time_review", () => wallTimeReview(app)) };
}
