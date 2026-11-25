// Personal morning note: one computation for two surfaces — the gateway counts for one
// person (GET /api/v1/me/morning-note, the workspace card), the worker for pages of people (the e-mail, jobs/morning-note.ts).
//
// Everything the note uses is a count: no title or text of a record leaves this module, and no record id but the rows of
// PARTICIPANT_MEETINGS_SQL, which only the equality test reads. Counters of a person for a window:
//  - meetings where the person is the organiser or listed (participantMeetingsSql — the predicate of "Meetings with me") whose
//    summary stage finished in the window, and their current derived events by kind;
//  - the person's own documents whose processing finished or finally failed in the window (both record databases);
//  - waiting for the person now — four plain control-database counters without a caller: pending bulk changes (as the list of
//    plans counts them after expired and revoked ones are settled), requests to delete the person's meetings, closed records
//    kept hidden by the open check that appeared in the window, agent keys whose term ends within the warning days.
// "Corrections to confirm" and the curators' queue are not here: both are built on a caller's visibility in the record
// databases, and a worker has no caller.
//
// The slot of the day is {time} in the time zone of the setting (null — the instance time zone, instanceTz) on an enabled
// weekday; the window of a note runs from the previous enabled slot to this one (Monday covers the weekend). The mail goes
// out within MORNING_NOTE_WINDOW_HOURS after the slot; the dedupe key carries the local day of the slot.
import type pg from "pg";
import type { DataClass } from "./db.ts";
import { MAIL_KINDS } from "./smtp.ts";
import { instanceTz, tzValid, zonedWallToInstant } from "./zoned-time.ts";

type Q = Pick<pg.Pool, "query">;
interface SettingsLike { get<T>(path: string, fallback: T): T }

/** Mail kind of the note (mail_outbox.kind); it enters the registry together with the OpenAPI lists of mail kinds. */
export const MORNING_NOTE_MAIL_KIND = "morning_note";
/**
 * The mail kind is in the registry (enums.json → MAIL_KINDS, and the CHECK of mail_outbox.kind): until it is, the job queues
 * nothing (enqueueMail would refuse an unknown kind) and the card says the e-mail is not available yet.
 */
export const morningNoteMailReady = (): boolean => (MAIL_KINDS as readonly string[]).includes(MORNING_NOTE_MAIL_KIND);
/** Hours after the slot during which the job still queues the note (a worker that was down at 08:00 sends it until 11:00). */
export const MORNING_NOTE_WINDOW_HOURS = 3;
/** People per page of the job. */
export const MORNING_NOTE_PAGE = 200;
/** Days before the end of a key's term when it counts as "expiring": the same number as KEY_EXPIRY_WARN_DAYS of the gateway. */
export const NOTE_KEY_WARN_DAYS = 14;

export interface MorningNoteConfig { enabled: boolean; time: string; tz: string; weekdays: number[] }
/** Defaults of a missing or broken field: the seed value of access.morning_note (04-seed.sql). */
export const MORNING_NOTE_DEFAULT = { enabled: true, time: "08:00", tz: null, weekdays: [1, 2, 3, 4, 5] } as const;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** access.morning_note merged with the defaults; tz null or not an IANA zone — the instance time zone. */
export function morningNoteConfig(settings: SettingsLike): MorningNoteConfig {
  const v = settings.get<unknown>("access.morning_note", null);
  const o = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const days = Array.isArray(o.weekdays) && o.weekdays.every((d) => typeof d === "number" && Number.isInteger(d) && d >= 1 && d <= 7)
    ? [...new Set(o.weekdays as number[])].sort() : [...MORNING_NOTE_DEFAULT.weekdays];
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : MORNING_NOTE_DEFAULT.enabled,
    time: typeof o.time === "string" && TIME_RE.test(o.time) ? o.time : MORNING_NOTE_DEFAULT.time,
    tz: tzValid(o.tz) ? o.tz : instanceTz(settings),
    weekdays: days,
  };
}

/** The local calendar day (YYYY-MM-DD) of an instant in a time zone. */
export function localDay(at: number, tz: string): string {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(at));
  const g = (k: string) => p.find((x) => x.type === k)!.value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}
const shiftDay = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** ISO weekday of a calendar day: 1 — Monday … 7 — Sunday. */
const isoDow = (day: string): number => ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

export interface MorningNoteSlot {
  /** Local day of the slot (the dedupe key of the mail). */
  day: string;
  /** The slot: the window of the note ends here. */
  start: Date;
  /** The previous enabled slot: the window of the note starts here. */
  from: Date;
  /** Now is within [start, start + MORNING_NOTE_WINDOW_HOURS): the job may queue the note. */
  inWindow: boolean;
}

const LOOK_BACK_DAYS = 15;

/**
 * The latest slot at or before `now` and the window of its note; null — no weekday is enabled (`weekdays: []` sends nothing).
 * The instant of a slot is computed per day (zonedWallToInstant), so a daylight-saving change between two slots gives a window
 * one hour shorter or longer, and the slot stays at {time} on the wall.
 */
export function morningNoteSlot(now: Date, cfg: Pick<MorningNoteConfig, "time" | "tz" | "weekdays">): MorningNoteSlot | null {
  if (!cfg.weekdays.length) return null;
  const at = (day: string): number => zonedWallToInstant(`${day}T${cfg.time}`, cfg.tz)!;
  const today = localDay(now.getTime(), cfg.tz);
  let day: string | null = null;
  for (let i = 0; i <= LOOK_BACK_DAYS && !day; i++) {
    const d = shiftDay(today, -i);
    if (cfg.weekdays.includes(isoDow(d)) && at(d) <= now.getTime()) day = d;
  }
  if (!day) return null;
  let prev: string | null = null;
  for (let i = 1; i <= LOOK_BACK_DAYS && !prev; i++) {
    const d = shiftDay(day, -i);
    if (cfg.weekdays.includes(isoDow(d))) prev = d;
  }
  const start = at(day);
  return { day, start: new Date(start), from: new Date(at(prev!)), inWindow: now.getTime() < start + MORNING_NOTE_WINDOW_HOURS * 3_600_000 };
}

export interface MorningNoteCounts {
  meetings: number; decisions: number; actions: number; questions_risks: number; facts: number;
  documents_processed: number; documents_failed: number;
  plans_pending: number; deletion_requests: number; held_by_check: number; keys_expiring: number;
}
export const MORNING_NOTE_COUNTERS: ReadonlyArray<keyof MorningNoteCounts> = [
  "meetings", "decisions", "actions", "questions_risks", "facts", "documents_processed", "documents_failed",
  "plans_pending", "deletion_requests", "held_by_check", "keys_expiring",
];
export const emptyCounts = (): MorningNoteCounts => Object.fromEntries(MORNING_NOTE_COUNTERS.map((k) => [k, 0])) as unknown as MorningNoteCounts;
export const countsTotal = (c: MorningNoteCounts): number => MORNING_NOTE_COUNTERS.reduce((s, k) => s + c[k], 0);

/**
 * Meetings of a person (`m` — a row of records_live in the closed database, `person` — an SQL expression of the person's id):
 * a whole meeting (the root transcript), the person is its organiser or in its list of people. It is the predicate of
 * "Meetings with me" (mine() of the gateway): for the person's own workspace session the visibility part of mine() is true
 * for exactly these rows (the author and the list of people read a record whatever its audience), and the list reads the
 * closed database only. A pg test proves the equality on a matrix.
 */
export function participantMeetingsSql(person: string, m = "m"): string {
  return `${m}.type = 'transcript' AND ${m}.parent_id IS NULL
    AND (${m}.owner_id = ${person} OR EXISTS (SELECT 1 FROM record_people rp WHERE rp.record_id = ${m}.id AND rp.person_id = ${person}))`;
}

/** Ids of the meetings of each person (no window): the equality test with "Meetings with me" reads this. */
export const PARTICIPANT_MEETINGS_SQL = `
  SELECT p.person_id, m.id FROM unnest($1::uuid[]) AS p(person_id)
    JOIN records_live m ON ${participantMeetingsSql("p.person_id")}`;

// Events count as they stood at the end of the window (ingested before the slot): the card read later shows the e-mail's numbers.
const MEETINGS_SQL = `
  WITH mine AS (
    SELECT p.person_id, m.id FROM unnest($1::uuid[]) AS p(person_id)
      JOIN records_live m ON ${participantMeetingsSql("p.person_id")}
     WHERE EXISTS (SELECT 1 FROM record_stages s WHERE s.record_id = m.id AND s.stage = 'summary' AND s.status = 'done'
                      AND s.updated_at >= $2 AND s.updated_at < $3))
  SELECT x.person_id, count(*)::int AS meetings,
         coalesce(sum(e.decisions), 0)::int AS decisions, coalesce(sum(e.actions), 0)::int AS actions,
         coalesce(sum(e.questions_risks), 0)::int AS questions_risks, coalesce(sum(e.facts), 0)::int AS facts
    FROM mine x
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE ev.event_kind = 'decision') AS decisions, count(*) FILTER (WHERE ev.event_kind = 'action') AS actions,
             count(*) FILTER (WHERE ev.event_kind = 'question_risk') AS questions_risks, count(*) FILTER (WHERE ev.event_kind = 'fact') AS facts
        FROM records_live ev WHERE ev.parent_id = x.id AND ev.type = 'event' AND ev.ingested_at < $3) e ON true
   GROUP BY x.person_id`;

/**
 * The person's documents (the root record, current): processed — no stage pending, running or failed, and the last stage
 * finished in the window; failed — a stage stopped for good in the window, as the scheduler stops it ($4 —
 * processing.retries.limit): a terminal refusal, the retry limit reached, or "the model is too slow" (llm_too_slow:, the
 * prefix of the workers' stages, waits for a manual retry). A failure with retries left is still being processed.
 */
const DOCUMENTS_SQL = `
  SELECT d.owner_id AS person_id,
         count(*) FILTER (WHERE st.open_stages = 0 AND st.last_at >= $2 AND st.last_at < $3)::int AS documents_processed,
         count(*) FILTER (WHERE st.failed_in_window)::int AS documents_failed
    FROM records_live d
    JOIN LATERAL (
      SELECT count(*) FILTER (WHERE s.status IN ('pending','running','failed')) AS open_stages, max(s.updated_at) AS last_at,
             bool_or(s.status = 'failed' AND (s.terminal OR s.attempts >= $4 OR COALESCE(s.last_error, '') LIKE 'llm_too_slow:%')
                     AND s.updated_at >= $2 AND s.updated_at < $3) AS failed_in_window
        FROM record_stages s WHERE s.record_id = d.id) st ON true
   WHERE d.type = 'document' AND d.parent_id IS NULL AND d.owner_id = ANY($1::uuid[])
   GROUP BY d.owner_id`;

/**
 * Waiting for the person now (control database; $1 — people, $2 — instance, $3/$4 — window, $5 — warning days):
 *  - plans: what the list of plans and GET /me/nav count after expired and revoked plans are settled (pending, not
 *    expired, its key neither revoked nor expired; or applying);
 *  - deletion requests of the person's meetings that neither the person declined nor an administrator kept (as /me/nav);
 *  - closed records of the person kept hidden by the open check whose locator appeared in the window;
 *  - the person's own agent keys whose term ends within the warning days (as /me/nav, without its page limit).
 */
const WAITING_SQL = `
  SELECT p.id AS person_id,
    (SELECT count(*) FROM action_plans a WHERE a.person_id = p.id AND a.instance_id = $2
        AND (a.status = 'applying' OR (a.status = 'pending' AND a.expires_at > now()
             AND NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.id = a.key_id AND (k.revoked_at IS NOT NULL OR k.expires_at <= now())))))::int AS plans_pending,
    (SELECT count(*) FROM deletion_requests d JOIN record_locations l ON l.record_id = d.record_id AND NOT l.deleted
      WHERE d.instance_id = $2 AND l.owner_id = p.id AND d.declined_at IS NULL AND d.kept_at IS NULL)::int AS deletion_requests,
    (SELECT count(*) FROM record_locations l WHERE l.owner_id = p.id AND l.class = 'closed' AND NOT l.deleted AND l.open_check IS NOT NULL
        AND l.created_at >= $3 AND l.created_at < $4)::int AS held_by_check,
    (SELECT count(*) FROM api_keys k WHERE k.auth_method = 'api_key' AND k.principal_type = 'person' AND k.principal_id = p.id AND k.instance_id = $2
        AND k.revoked_at IS NULL AND k.preview IS NOT TRUE AND k.expires_at > now() AND k.expires_at <= now() + make_interval(days => $5))::int AS keys_expiring
    FROM people p WHERE p.id = ANY($1::uuid[]) AND p.instance_id = $2`;

/** processing.retries.limit — the scheduler's limit of attempts (the same default as the workers' and the workspace's). */
export const noteRetryLimit = (settings: SettingsLike): number => {
  const v = Number(settings.get<{ limit?: unknown }>("processing.retries", { limit: 3 })?.limit);
  return Number.isInteger(v) && v >= 1 ? v : 3;
};

export interface NoteSources { control: Q; records: (cls: DataClass) => Q }
export interface NoteWindow { from: Date; to: Date }

/** Counters of each person of the list for a window; a person without anything gets zeros. Counts only. */
export async function morningNoteCounts(src: NoteSources, instanceId: string, personIds: readonly string[], win: NoteWindow,
                                        o: { keyWarnDays?: number; retryLimit?: number } = {}): Promise<Map<string, MorningNoteCounts>> {
  const out = new Map<string, MorningNoteCounts>(personIds.map((id) => [id, emptyCounts()]));
  if (!personIds.length) return out;
  const ids = [...out.keys()];
  const add = (rows: Array<Record<string, unknown>>, keys: ReadonlyArray<keyof MorningNoteCounts>) => {
    for (const r of rows) {
      const c = out.get(r.person_id as string);
      if (c) for (const k of keys) c[k] += Number(r[k] ?? 0);
    }
  };
  const [meetings, docsOpen, docsClosed, waiting] = await Promise.all([
    src.records("closed").query(MEETINGS_SQL, [ids, win.from, win.to]),
    src.records("open").query(DOCUMENTS_SQL, [ids, win.from, win.to, o.retryLimit ?? 3]),
    src.records("closed").query(DOCUMENTS_SQL, [ids, win.from, win.to, o.retryLimit ?? 3]),
    src.control.query(WAITING_SQL, [ids, instanceId, win.from, win.to, o.keyWarnDays ?? NOTE_KEY_WARN_DAYS]),
  ]);
  add(meetings.rows, ["meetings", "decisions", "actions", "questions_risks", "facts"]);
  add(docsOpen.rows, ["documents_processed", "documents_failed"]);
  add(docsClosed.rows, ["documents_processed", "documents_failed"]);
  add(waiting.rows, ["plans_pending", "deletion_requests", "held_by_check", "keys_expiring"]);
  return out;
}

/**
 * Recipients of the e-mail ($1 — instance, $2 — the last id of the previous page or NULL, $3 — page size, $4 — take people
 * marked as test: only the operator's manual run does, as the curators' digest): active people, not demo, not test unless
 * $4 (the filter of ORG_CURATORS_SQL), whose login is an e-mail and who did not turn the note off. given_name — the name the
 * product addresses the person by (people.attrs.given_name: the directory, the sign-in provider or the people table).
 * The address check is repeated with MAIL_RE before queueing.
 */
export const MORNING_NOTE_RECIPIENTS_SQL = `
  SELECT p.id, p.login, p.display_name, p.attrs->>'given_name' AS given_name FROM people p
   WHERE p.instance_id = $1 AND p.active AND p.morning_note IS NOT FALSE
     AND COALESCE(p.attrs->>'demo', '') <> 'true' AND ($4::boolean OR COALESCE(p.attrs->>'test', '') <> 'true')
     AND p.login LIKE '%@%' AND ($2::uuid IS NULL OR p.id > $2::uuid)
   ORDER BY p.id LIMIT $3`;

/** The same person is still a recipient right before queueing ($3 — as $4 above): deactivated, switched off or marked since. */
export const MORNING_NOTE_STILL_RECIPIENT_SQL = `
  SELECT 1 FROM people p WHERE p.id = $1 AND p.instance_id = $2 AND p.active AND p.morning_note IS NOT FALSE
     AND COALESCE(p.attrs->>'demo', '') <> 'true' AND ($3::boolean OR COALESCE(p.attrs->>'test', '') <> 'true')`;

/**
 * Dedupe key of a person's note: one e-mail per person per slot day, whichever worker and run queues it; the operator's
 * manual run — one per person per hour (`manual` — the UTC hour, YYYY-MM-DDTHH), as the curators' digest.
 */
export const morningNoteDedupeKey = (day: string, personId: string, manual?: string): string =>
  manual ? `morning_note:manual:${manual}:${personId}` : `morning_note:${day}:${personId}`;
