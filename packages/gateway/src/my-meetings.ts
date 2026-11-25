import type pg from "pg";
import { binder, invalid, log, MemoryError, isNoSpeakerLabel, smtpConfig, visibleSql, nightWindowOf } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { loadReadable, readableSpaces, type SpaceAccess } from "./access.ts";
import { audit, auditShownClosed } from "./audit.ts";
import { byIdSpec } from "./visibility.ts";
import { applyParticipants, leaveMeeting, leftMarks, MEETING_MAX_PARTICIPANTS, meetingParticipants, meetingTransferPending, notifyParticipants, withMeetingLock, type ParticipantsChange } from "./meetings.ts";
import { manyInMemory, publicParticipant, type PendingParticipant, type PersonHit, type Resolution } from "./participants.ts";
import { requireHuman } from "./workplace.ts";
import { queueReason, type StageWait } from "./records.ts";
import { gateSnapshot } from "./llm-gate-admin.ts";
import { nightCapped } from "./night-cap.ts";

const NEW_DAYS = 30;
const WHERE = { path: "/meetings", section: "Meetings with me" };

interface Row { id: string; title: string | null; occurred_at: Date; ingested_at: Date; owner_id: string; summary_line: string | null; space_id: string;
                audience: "space" | "people"; class: "open" | "closed"; process_now_at: string | null; deferred_reason: string | null; participants: number }

const iso = (d: Date | string) => new Date(d).toISOString();

interface StageRow { stage: string; status: string; attempts: number; terminal: boolean; last_error: string | null }

export function employeeStageStatus(s: StageRow | undefined, limit: number): string | null {
  if (!s) return null;
  if (s.status === "pending" && (s.last_error ?? "").startsWith("reextract:")) return "done";
  if (s.stage === "indexed" && s.status === "failed" && !s.terminal && s.attempts < limit) return "pending";
  return s.status;
}

export function failedFinal(stages: Record<string, StageRow | undefined>): boolean {
  return ["indexed", "summary", "events"].some((k) => { const s = stages[k]; return s?.status === "failed" && s.terminal && !(s.last_error ?? "").startsWith("llm_too_slow:"); });
}

const PROJECT_LABELS = 3;
const HANDED_LIMIT = 2000;

const projectsOf = (spaces: Map<string, SpaceAccess>) => new Map([...spaces].filter(([, s]) => s.kind === "project"));

async function handedTo(app: App, spaceId: string): Promise<string[]> {
  return (await app.db.control.query(
    `SELECT DISTINCT l.dst_id FROM record_links l JOIN record_locations loc ON loc.record_id = l.src_id AND NOT loc.deleted AND loc.space_id = $1
      WHERE l.relation = 'derived_from' AND l.status = 'confirmed' LIMIT ${HANDED_LIMIT}`, [spaceId])).rows.map((r) => r.dst_id as string);
}

function aboutProject(spaceId: string, events: string[], bind: (v: unknown) => string): string {
  const sp = bind(spaceId), ev = bind(events);
  const linked = (x: string) => `(${x}.space_id = ${sp} OR ${x}.attrs->>'project_mark' = ${sp}::text
    OR EXISTS (SELECT 1 FROM records e WHERE e.parent_id = ${x}.id AND e.id = ANY(${ev}::uuid[])))`;
  return `AND (${linked("r")} OR (r.source_ref IS NOT NULL AND EXISTS (SELECT 1 FROM records v WHERE v.parent_id IS NULL AND v.owner_id = r.owner_id
    AND v.source_kind = r.source_kind AND v.source_ref = r.source_ref AND v.id <> r.id AND ${linked("v")})))`;
}

async function projectLabels(app: App, db: pg.Pool, ids: string[],
                             projects: Map<string, SpaceAccess>): Promise<Map<string, Array<{ slug: string; name: string }>>> {
  const out = new Map<string, Array<{ slug: string; name: string }>>();
  if (!ids.length || !projects.size) return out;
  const versions = (await db.query(
    `SELECT r.id AS meeting, v.id, v.space_id, v.attrs->>'project_mark' AS mark FROM records r
       JOIN records v ON v.parent_id IS NULL AND v.owner_id = r.owner_id
        AND (v.id = r.id OR (r.source_ref IS NOT NULL AND v.source_kind = r.source_kind AND v.source_ref = r.source_ref))
      WHERE r.id = ANY($1::uuid[])`, [ids])).rows as Array<{ meeting: string; id: string; space_id: string; mark: string | null }>;
  const found = new Map<string, string[]>();
  const add = (m: string, sp: string | null) => { if (sp && projects.has(sp)) found.set(m, [...(found.get(m) ?? []), sp]); };
  for (const v of versions) add(v.meeting, v.mark);
  for (const v of versions) add(v.meeting, v.space_id);
  const meetingOf = new Map(versions.map((v) => [v.id, v.meeting]));
  const events = (await db.query("SELECT id, parent_id FROM records WHERE parent_id = ANY($1::uuid[]) AND type = 'event'", [[...meetingOf.keys()]])).rows as Array<{ id: string; parent_id: string }>;
  if (events.length) {
    const eventMeeting = new Map(events.map((e) => [e.id, meetingOf.get(e.parent_id)!]));
    const links = (await app.db.control.query(
      `SELECT DISTINCT l.dst_id, loc.space_id FROM record_links l JOIN record_locations loc ON loc.record_id = l.src_id AND NOT loc.deleted
        WHERE l.dst_id = ANY($1::uuid[]) AND l.relation = 'derived_from' AND l.status = 'confirmed'`, [[...eventMeeting.keys()]])).rows;
    for (const l of links) add(eventMeeting.get(l.dst_id)!, l.space_id);
  }
  for (const [m, sps] of found)
    out.set(m, [...new Set(sps)].slice(0, PROJECT_LABELS).map((id) => ({ slug: projects.get(id)!.slug, name: projects.get(id)!.name })));
  return out;
}

function mine(caller: Caller, spaces: Map<string, unknown>, bind: (v: unknown) => string): string {
  const me = bind(caller.person!.id);
  return `FROM records_live r
  WHERE r.type = 'transcript' AND r.parent_id IS NULL
    AND (r.owner_id = ${me} OR EXISTS (SELECT 1 FROM record_people p WHERE p.record_id = r.id AND p.person_id = ${me}))
    AND ${visibleSql(byIdSpec(caller, spaces), "closed", bind) ?? "FALSE"}`;
}

/** Meetings with the person (counts of "What my agent sees"): the predicate of the list "Meetings with me". */
export async function myMeetingsCount(app: App, caller: Caller): Promise<number> {
  const spaces = await readableSpaces(app, caller);
  const args: unknown[] = [], bind = binder(args);
  return (await app.db.records("closed", caller.scope).query(`SELECT count(*)::int AS n ${mine(caller, spaces, bind)}`, args)).rows[0].n;
}

async function opened(app: App, personId: string, ids: string[]): Promise<Set<string> | null> {
  if (!ids.length) return new Set();
  try {
    const { rows } = await app.db.auditRead().query(
      `SELECT DISTINCT u.id FROM audit_events e CROSS JOIN LATERAL unnest(e.record_ids) AS u(id)
        WHERE e.event_type = 'read' AND e.at > now() - make_interval(days => $3) AND (e.principal_id = $1 OR e.on_behalf_of = $1)
          AND e.record_ids && $2::uuid[] AND u.id = ANY($2::uuid[])`, [personId, ids, NEW_DAYS + 1]);
    return new Set(rows.map((r) => r.id as string));
  } catch (e) {
    log.warn("meetings_new_unreadable", { error: (e as Error).message.slice(0, 160) });
    return null;
  }
}

const fresh = (r: { ingested_at: Date }) => Date.now() - new Date(r.ingested_at).getTime() < NEW_DAYS * 86_400_000;

export interface MeetingFilter {
  q?: string | null; role?: "owner" | "participant" | null; fresh?: boolean;
  space?: string | null;
}
const PEOPLE_MATCH_LIMIT = 200;
const NEW_CANDIDATES = 200;
const NAMES_SHOWN = 3;
const likeEscape = (t: string): string => t.replace(/[\\%_]/g, (m) => `\\${m}`);
export const meetingsLike = (q: string): string => `%${likeEscape(q.toLowerCase().replace(/ё/g, "е"))}%`;

export const MEETINGS_Q_MIN = 2, MEETINGS_Q_MAX = 100;
export function meetingsFilterParams(raw: { q?: string | null; role?: string | null; fresh?: string | null }): MeetingFilter {
  const q = (raw.q ?? "").replace(/\s+/g, " ").trim();
  if (q && (q.length < MEETINGS_Q_MIN || q.length > MEETINGS_Q_MAX)) throw invalid(`q: a search string from ${MEETINGS_Q_MIN} to ${MEETINGS_Q_MAX} characters with a meeting title, full name or e-mail address`);
  const role = (raw.role ?? "").trim();
  if (role && role !== "owner" && role !== "participant") throw invalid("role: owner for meetings you organize, participant for meetings you attend");
  const f = (raw.fresh ?? "").trim().toLowerCase();
  if (f && !["1", "true", "0", "false"].includes(f)) throw invalid("new: 1 for new meetings only, 0 or empty for all meetings");
  return { q: q || null, role: (role || null) as MeetingFilter["role"], fresh: f === "1" || f === "true" };
}

async function peopleMatching(app: App, q: string): Promise<string[]> {
  return (await app.db.control.query(
    `SELECT id FROM people WHERE instance_id = $1 AND (translate(lower(COALESCE(display_name, '')), 'ё', 'е') LIKE $2 ESCAPE '\\' OR lower(login) LIKE $2 ESCAPE '\\')
      ORDER BY display_name NULLS LAST, login LIMIT ${PEOPLE_MATCH_LIMIT}`, [app.instanceId, meetingsLike(q)])).rows.map((x) => x.id as string);
}

function filterSql(me: string, f: MeetingFilter, people: string[], bind: (v: unknown) => string): string {
  const parts: string[] = [];
  if (f.role === "owner") parts.push(`r.owner_id = ${bind(me)}`);
  if (f.role === "participant") parts.push(`r.owner_id <> ${bind(me)}`);
  if (f.q) {
    const ids = people.length ? bind(people) : null;
    parts.push(`(translate(lower(COALESCE(r.title, '')), 'ё', 'е') LIKE ${bind(meetingsLike(f.q))} ESCAPE '\\'${ids
      ? ` OR r.owner_id = ANY(${ids}::uuid[]) OR EXISTS (SELECT 1 FROM record_people pq WHERE pq.record_id = r.id AND pq.person_id = ANY(${ids}::uuid[]))` : ""})`);
  }
  return parts.length ? ` AND ${parts.join(" AND ")}` : "";
}

export async function listMyMeetings(app: App, caller: Caller, limit: number, offset: number, o: MeetingFilter = {}) {
  await requireHuman(app, caller, "Open “Meetings with me”", WHERE);
  const me = caller.person!;
  const db = app.db.records("closed", caller.scope);
  const spaces = await readableSpaces(app, caller);
  const projects = projectsOf(spaces);
  const project = o.space ? [...projects.values()].find((s) => s.slug === o.space) ?? null : null;
  if (o.space && !project) return { items: [], next_cursor: null, project: null };
  const projectPart = o.space && project ? { project: { slug: project.slug, name: project.name } } : {};
  const handed = project ? await handedTo(app, project.id) : [];
  const people = o.q ? await peopleMatching(app, o.q) : [];
  const where = (bind: (v: unknown) => string) =>
    `${mine(caller, spaces, bind)}${filterSql(me.id, o, people, bind)}${project ? ` ${aboutProject(project.id, handed, bind)}` : ""}`;
  let only: string[] | null = null, more = false;
  if (o.fresh) {
    const a: unknown[] = [], b = binder(a);
    const cand = (await db.query(`SELECT r.id ${where(b)} AND r.ingested_at > now() - make_interval(days => ${b(NEW_DAYS)}) ORDER BY r.occurred_at DESC, r.id DESC LIMIT ${b(NEW_CANDIDATES)}`, a))
      .rows.map((r) => r.id as string);
    const seenAll = await opened(app, me.id, cand);
    if (seenAll === null) return { items: [], next_cursor: null, new_unavailable: true as const, ...projectPart };
    const unopened = cand.filter((id) => !seenAll.has(id));
    only = unopened.slice(offset, offset + limit);
    more = unopened.length > offset + limit;
    if (!only.length) return { items: [], next_cursor: null, ...projectPart };
  }
  const args: unknown[] = [], bind = binder(args);
  const { rows } = await db.query(
    `SELECT r.id, r.title, r.occurred_at, r.ingested_at, r.owner_id, r.summary_line, r.space_id, r.audience, r.class,
            r.attrs->>'process_now_at' AS process_now_at, r.attrs->>'deferred_reason' AS deferred_reason,
            (SELECT count(*) FROM record_people p WHERE p.record_id = r.id AND p.person_id <> r.owner_id)::int AS participants
       ${where(bind)}${only ? ` AND r.id = ANY(${bind(only)}::uuid[])` : ""} ORDER BY r.occurred_at DESC, r.id DESC${only ? "" : ` LIMIT ${bind(limit + 1)} OFFSET ${bind(offset)}`}`, args);
  const page = (only ? rows : rows.slice(0, limit)) as Row[];
  const ids = page.map((r) => r.id);
  const stages = new Map<string, Record<string, StageRow>>(), waits = new Map<string, StageWait[]>();
  if (ids.length)
    for (const s of (await db.query(
      `SELECT record_id, stage, status, attempts, terminal, last_error, busy_retries, slow_retries, retry_at FROM record_stages
        WHERE record_id = ANY($1::uuid[]) AND stage IN ('indexed','summary','events')`, [ids])).rows) {
      stages.set(s.record_id, { ...(stages.get(s.record_id) ?? {}), [s.stage]: { stage: s.stage, status: s.status, attempts: Number(s.attempts ?? 0), terminal: s.terminal === true, last_error: s.last_error ?? null } });
      if (s.stage === "indexed") continue;
      waits.set(s.record_id, [...(waits.get(s.record_id) ?? []), { stage: s.stage, status: s.status, busy_retries: s.busy_retries, slow_retries: s.slow_retries,
                                                                    retry_at: s.retry_at ? new Date(s.retry_at).toISOString() : null }]);
    }
  const anyWaiting = [...waits.values()].some((w) => w.some((x) => x.status === "pending" || x.status === "running"));
  const gate = anyWaiting ? await gateSnapshot(app).catch(() => null) : null;
  const nightWaits = page.some((r) => !r.process_now_at && (waits.get(r.id) ?? []).some((x) => x.status === "pending"));
  const capped = nightWaits ? await nightCapped(app) : false;
  const now = new Date(), win = nightWindowOf(app.settings);
  const retries = app.settings.get<{ limit: number }>("processing.retries", { limit: 3 }).limit;
  const partOf = new Map<string, string[]>();
  if (ids.length)
    for (const x of (await db.query(
      "SELECT p.record_id, p.person_id FROM record_people p JOIN records r ON r.id = p.record_id WHERE p.record_id = ANY($1::uuid[]) AND p.person_id <> r.owner_id AND p.person_id <> $2",
      [ids, me.id])).rows) partOf.set(x.record_id, [...(partOf.get(x.record_id) ?? []), x.person_id as string]);
  const named = new Map<string, { login: string; display_name: string | null }>();
  const personIds = [...new Set([...page.map((r) => r.owner_id), ...[...partOf.values()].flat()])];
  if (personIds.length)
    for (const p of (await app.db.control.query("SELECT id, login, display_name FROM people WHERE id = ANY($1::uuid[])", [personIds])).rows) named.set(p.id, { login: p.login, display_name: p.display_name });
  const nameKey = (p: { login: string; display_name: string | null }) => p.display_name?.trim() || p.login;
  const seen = only ? null : await opened(app, me.id, page.filter(fresh).map((r) => r.id));
  const labels = await projectLabels(app, db, ids, projects).catch((e: Error) => {
    log.warn("meetings_project_labels_failed", { error: e.message.slice(0, 160) });
    return new Map<string, Array<{ slug: string; name: string }>>();
  });
  await auditShownClosed(app, caller, page.filter((r) => r.class === "closed").map((r) => r.id), "my_meetings");
  return {
    items: page.map((r) => {
      const st = stages.get(r.id) ?? {};
      const why = queueReason(r.process_now_at ? null : r.deferred_reason, waits.get(r.id) ?? [], gate, { lane: r.process_now_at ? "now" : "night", now, win, nightCapped: capped });
      const names = (partOf.get(r.id) ?? []).flatMap((id) => named.get(id) ?? []).sort((a, b) => nameKey(a).localeCompare(nameKey(b), "ru")).slice(0, NAMES_SHOWN);
      return {
        id: r.id, title: r.title, occurred_at: iso(r.occurred_at), ingested_at: iso(r.ingested_at),
        role: r.owner_id === me.id ? "owner" as const : "participant" as const, owner: named.get(r.owner_id) ?? { login: "—", display_name: null },
        participants: r.participants, participant_names: names, summary_line: r.summary_line,
        stages: { summary: employeeStageStatus(st.summary, retries), events: employeeStageStatus(st.events, retries), indexed: employeeStageStatus(st.indexed, retries) },
        lane: r.process_now_at ? "now" as const : "night" as const, reason: why.reason ?? null, retry_at: why.retry_at ?? null,
        failed_final: failedFinal(st),
        new: only ? true : seen !== null && fresh(r) && !seen.has(r.id),
        projects: labels.get(r.id) ?? [],
      };
    }),
    next_cursor: (only ? more : rows.length > limit) ? String(offset + limit) : null,
    ...projectPart,
  };
}

export async function meetingsSummary(app: App, caller: Caller): Promise<{ new: number; asked: number }> {
  await requireHuman(app, caller, "Open “Meetings with me”", WHERE);
  const me = caller.person!;
  const db = app.db.records("closed", caller.scope);
  const spaces = await readableSpaces(app, caller);
  const args: unknown[] = [], bind = binder(args);
  const visible = (await db.query(`SELECT r.id ${mine(caller, spaces, bind)} AND r.ingested_at > now() - make_interval(days => ${bind(NEW_DAYS)}) ORDER BY r.ingested_at DESC LIMIT 200`,
                                  args)).rows.map((r) => r.id as string);
  const seen = await opened(app, me.id, visible);
  const asked = (await app.db.control.query(
    `SELECT count(*)::int AS n FROM deletion_requests d JOIN record_locations l ON l.record_id = d.record_id AND NOT l.deleted
      WHERE d.instance_id = $2 AND l.owner_id = $1 AND d.declined_at IS NULL AND d.kept_at IS NULL`, [me.id, app.instanceId])).rows[0].n;
  return { new: seen === null ? 0 : visible.filter((id) => !seen.has(id)).length, asked };
}

async function readableMeeting(app: App, caller: Caller, id: string) {
  const { rec, db } = await loadReadable(app, caller, id);
  if (rec.type !== "transcript" || rec.parent_id) throw invalid("The participant list is available for the whole meeting. Open the meeting");
  return { rec, db };
}

const SPEAKERS_CHECKED = 20, NOT_INVITED_SHOWN = 10;
const SPEAKER_LINE = String.raw`^\[[0-9:]+\] ([^:\n\]]{2,80}):`;

interface Hint { why: "speaker" | "actor"; p: PersonHit | null }
const HINTS_TTL_MS = 10 * 60_000, HINTS_MAX = 500;
const hintsCache = new Map<string, { at: number; hints: Hint[] }>();
export function clearHintsCache(): void { hintsCache.clear(); }

async function meetingHints(app: App, db: pg.Pool, rec: { id: string; attrs: unknown }): Promise<Hint[]> {
  const stamp = (await db.query(
    "SELECT (SELECT count(*) FROM chunks WHERE record_id = $1)::int AS c, (SELECT count(*) FROM records WHERE parent_id = $1 AND type = 'event' AND deleted_at IS NULL)::int AS e",
    [rec.id])).rows[0] as { c: number; e: number };
  const key = `${rec.id}:${stamp.c}:${stamp.e}`;
  const hit = hintsCache.get(key);
  if (hit && Date.now() - hit.at < HINTS_TTL_MS) return hit.hints;
  const names = new Map<string, "speaker" | "actor">();
  const add = (raw: unknown, why: "speaker" | "actor") => {
    const n = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (n.length < 2 || n.length > 200 || isNoSpeakerLabel(n) || names.size >= SPEAKERS_CHECKED) return;
    if (![...names.keys()].some((k) => k.toLowerCase() === n.toLowerCase())) names.set(n, why);
  };
  const segs = (rec.attrs as { segments?: unknown } | null)?.segments;
  if (Array.isArray(segs)) for (const x of segs) add((x as { speaker?: unknown })?.speaker, "speaker");
  if (names.size < SPEAKERS_CHECKED && stamp.c)
    for (const r of (await db.query(
      `SELECT DISTINCT m[1] AS name FROM chunks c CROSS JOIN LATERAL regexp_matches(c.text, $2, 'gn') AS m WHERE c.record_id = $1 LIMIT ${SPEAKERS_CHECKED * 2}`, [rec.id, SPEAKER_LINE])).rows)
      add(r.name, "speaker");
  if (names.size < SPEAKERS_CHECKED && stamp.e)
    for (const r of (await db.query(
      `SELECT DISTINCT a.name FROM records e CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(e.attrs->'actors') = 'array' THEN e.attrs->'actors' ELSE '[]'::jsonb END) AS a(name)
        WHERE e.parent_id = $1 AND e.type = 'event' AND e.deleted_at IS NULL LIMIT ${SPEAKERS_CHECKED * 2}`, [rec.id])).rows)
      add(r.name, "actor");
  const found = names.size ? await manyInMemory(app, [...names.keys()]) : new Map<string, PersonHit | null>();
  const hints = [...names].map(([name, why]) => ({ why, p: found.get(name) ?? null }));
  hintsCache.delete(key);
  hintsCache.set(key, { at: Date.now(), hints });
  for (const k of hintsCache.keys()) { if (hintsCache.size <= HINTS_MAX) break; hintsCache.delete(k); }
  return hints;
}

async function notInvited(app: App, db: pg.Pool, rec: { id: string; owner_id: string; attrs: unknown },
                          skip: { ids: Set<string>; logins: Set<string> }) {
  const out: Array<{ login: string; display_name: string | null; department: string | null; why: "speaker" | "actor" }> = [];
  for (const { why, p } of await meetingHints(app, db, rec)) {
    if (out.length >= NOT_INVITED_SHOWN) break;
    if (!p || p.id === rec.owner_id || skip.ids.has(p.id) || skip.logins.has(p.login.toLowerCase()) || out.some((x) => x.login === p.login)) continue;
    out.push({ login: p.login, display_name: p.display_name ?? null, department: p.department ?? null, why });
  }
  return out;
}

export async function participantsView(app: App, caller: Caller, id: string, o: { audited?: boolean; hints?: boolean } = {}) {
  const { rec, db } = await readableMeeting(app, caller, id);
  const ids = (await db.query("SELECT person_id FROM record_people WHERE record_id = $1", [id])).rows.map((r) => r.person_id as string);
  const ot = transferMark(rec.attrs, rec.owner_id);
  const people = (await app.db.control.query("SELECT id, login, display_name, department, active FROM people WHERE id = ANY($1::uuid[])", [[...new Set([...ids, rec.owner_id, ...(ot ? [ot.from] : [])])]])).rows;
  const owner = people.find((p) => p.id === rec.owner_id);
  const prevOwner = ot ? people.find((p) => p.id === ot.from) : undefined;
  const attrs = (rec.attrs ?? {}) as { participants_pending?: PendingParticipant[]; participants_unresolved?: string[] };
  if (rec.class === "closed" && !o.audited) await auditShownClosed(app, caller, [id], "participants");
  const pending = (Array.isArray(attrs.participants_pending) ? attrs.participants_pending : []).map((x) => ({ login: String(x.login), display_name: x.display_name ?? null }));
  const canEdit = rec.owner_id === caller.person?.id && caller.keyKind === "session" && !caller.onBehalfOf && !caller.preview;
  let extra: { left: Array<{ login: string; display_name: string | null; at: string }>; notify: boolean; not_invited?: Awaited<ReturnType<typeof notInvited>> } | null = null;
  if (canEdit) {
    const marks = leftMarks(rec.attrs);
    const named = marks.length ? (await app.db.control.query("SELECT lower(login) AS login, display_name FROM people WHERE instance_id = $1 AND lower(login) = ANY($2::text[])",
                                                             [app.instanceId, marks.map((m) => m.login)])).rows : [];
    const left = marks.map((m) => ({ login: m.login, display_name: (named.find((x) => x.login === m.login)?.display_name ?? null) as string | null, at: m.at }));
    const notify = app.settings.get<boolean>("meetings.notify_participants", false) === true && smtpConfig(app.settings).enabled;
    extra = { left, notify };
    if (o.hints !== false)
      extra.not_invited = await notInvited(app, db, rec, { ids: new Set(ids), logins: new Set([...pending.map((x) => x.login.toLowerCase()), ...marks.map((m) => m.login)]) })
        .catch((e: Error) => { log.warn("meeting_not_invited_failed", { error: e.message.slice(0, 160) }); return []; });
  }
  return {
    id, owner: { login: owner?.login ?? "—", display_name: owner?.display_name ?? null },
    participants: people.filter((p) => p.id !== rec.owner_id && ids.includes(p.id))
      .map((p) => ({ login: p.login as string, display_name: (p.display_name ?? null) as string | null, department: (p.department ?? null) as string | null,
                     ...(p.active === false ? { gone: true as const } : {}) }))
      .sort((a, b) => (a.display_name ?? a.login).localeCompare(b.display_name ?? b.login, "ru")),
    pending,
    unresolved: Array.isArray(attrs.participants_unresolved) ? attrs.participants_unresolved.map(String) : [],
    can_edit: canEdit,
    project_mark: await markOf(app, caller, rec.attrs),
    organizer_transfer: ot ? { from: { login: (prevOwner?.login ?? "—") as string, display_name: (prevOwner?.display_name ?? null) as string | null }, at: ot.at } : null,
    ...(extra ?? {}),
  };
}

export function transferMark(attrs: unknown, ownerId: string): { from: string; at: string | null } | null {
  const t = (attrs as { organizer_transfer?: { from?: unknown; to?: unknown; at?: unknown } } | null)?.organizer_transfer;
  if (!t || typeof t.from !== "string" || t.to !== ownerId) return null;
  return { from: t.from, at: typeof t.at === "string" ? t.at : null };
}

export async function leaveMyMeeting(app: App, caller: Caller, id: string) {
  await requireHuman(app, caller, "Leave the meeting", { path: `/records/${id}`, section: "Meetings with me" });
  const { rec, db } = await readableMeeting(app, caller, id);
  await meetingTransferPending(app, caller, rec);
  const me = caller.person!;
  if (rec.owner_id === me.id) throw invalid("You are the meeting organizer. You can delete the meeting, but you cannot leave it");
  const inside = (await db.query("SELECT 1 FROM record_people WHERE record_id = $1 AND person_id = $2", [id, me.id])).rowCount;
  if (!inside) throw invalid("You are not on the participant list. You can see the meeting through a project or because it is shared with the company. Ask to delete it if it should not be in memory");
  return withMeetingLock(`${rec.owner_id}\u0000${rec.source_ref ?? id}`, async () => {
    const r = await leaveMeeting(app, caller, id, rec.owner_id);
    return { id, changed: r.changed, versions: r.versions };
  });
}

async function markOf(app: App, caller: Caller, attrs: unknown): Promise<{ slug: string; name: string } | null> {
  const id = (attrs as { project_mark?: unknown } | null)?.project_mark;
  if (typeof id !== "string" || !caller.person) return null;
  const s = projectsOf(await readableSpaces(app, caller)).get(id);
  return s ? { slug: s.slug, name: s.name } : null;
}

export async function setProjectMark(app: App, caller: Caller, id: string, body: unknown) {
  await requireHuman(app, caller, "Tag a meeting with a project", { path: `/records/${id}`, section: "Meetings with me" });
  const b = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  if (!b || !("space" in b) || Object.keys(b).some((k) => k !== "space") || (b.space !== null && typeof b.space !== "string"))
    throw invalid("Use {\"space\": project address or null} as the request body");
  const { rec } = await readableMeeting(app, caller, id);
  await meetingTransferPending(app, caller, rec);
  if (rec.owner_id !== caller.person!.id) throw new MemoryError("forbidden", "Only the organizer can tag the meeting with a project");
  let project: SpaceAccess | null = null;
  if (b.space) {
    project = [...projectsOf(await readableSpaces(app, caller)).values()].find((s) => s.slug === b.space) ?? null;
    if (!project) throw invalid("This project is not among your projects. Choose a project you are a member of");
  }
  const ids = (await app.db.recordsForWrite(rec.class, caller.scope).query(
    `UPDATE records SET attrs = CASE WHEN $3::text IS NULL THEN attrs - 'project_mark' ELSE attrs || jsonb_build_object('project_mark', $3::text) END
      WHERE parent_id IS NULL AND owner_id = $2 AND (id = $1 OR ($4::text IS NOT NULL AND source_kind = $5 AND source_ref = $4)) RETURNING id`,
    [id, rec.owner_id, project?.id ?? null, rec.source_ref ?? null, rec.source_kind])).rows.map((r) => r.id as string);
  await audit(app, caller, { event_type: "write", class: rec.class, record_ids: ids, details: { op: "meeting_project_mark", space: project?.slug ?? null, versions: ids.length } });
  return { id, project_mark: project ? { slug: project.slug, name: project.name } : null };
}

function participantsOp(body: unknown): { op: "set" | "add" | "remove"; list: string[] } {
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const given = (["participants", "add", "remove"] as const).filter((k) => b[k] !== undefined);
  const field = given.length === 1 ? given[0]! : given.length ? null : "participants";
  if (!field) throw invalid("The request body must contain one field: participants (the full list), add or remove");
  const list = b[field];
  if (!Array.isArray(list) || list.some((x) => typeof x !== "string" || !x.trim() || x.length > 200)) throw invalid(`${field}: a list of strings with participant logins, e-mail addresses or full names`);
  if (list.length > MEETING_MAX_PARTICIPANTS) throw invalid(`${field}: at most ${MEETING_MAX_PARTICIPANTS}`);
  if (field !== "participants" && !list.length) throw invalid(`${field}: add at least one participant`);
  return { op: field === "participants" ? "set" : field, list: [...new Set(list.map((x: string) => x.trim()))] };
}

export async function setParticipants(app: App, caller: Caller, id: string, body: unknown) {
  await requireHuman(app, caller, "Change meeting participants", { path: `/records/${id}`, section: "Meetings with me" });
  const req = participantsOp(body);
  const { rec, db } = await readableMeeting(app, caller, id);
  await meetingTransferPending(app, caller, rec);
  if (rec.owner_id !== caller.person!.id) throw new MemoryError("forbidden", "Only the organizer can change the participant list. A participant can ask to delete the meeting");
  return withMeetingLock(`${rec.owner_id}\u0000${rec.source_ref ?? id}`, async () => {
    const pending = req.op === "remove" ? null : (await db.query("SELECT attrs->'participants_pending' AS p FROM records WHERE id = $1", [id])).rows[0]?.p;
    const rp: Resolution | null = req.op === "remove" ? null : await meetingParticipants(app, caller, req.list, { pending });
    const change: ParticipantsChange = rp ? { op: req.op as "set" | "add", rp } : { op: "remove", logins: req.list };
    if (rec.class === "closed") await auditShownClosed(app, caller, [id], "participants");
    const applied = await applyParticipants(app, caller, id, rec.owner_id, change, "workplace", { maxTotal: MEETING_MAX_PARTICIPANTS });
    if (applied.added.length) await notifyParticipants(app, { id, title: rec.title, occurred_at: rec.occurred_at, owner_id: rec.owner_id }, applied.added)
      .catch((e: Error) => log.warn("meeting_mail_failed", { error: e.message.slice(0, 160) }));
    return { ...(await participantsView(app, caller, id, { audited: rec.class === "closed", hints: false })), changed: applied.changed, versions: applied.versions, results: rp ? rp.items.map(publicParticipant) : [],
             ...(rp?.warnings.length ? { warnings: rp.warnings } : {}) };
  });
}
