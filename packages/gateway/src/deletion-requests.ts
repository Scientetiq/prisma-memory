// Ask to delete: a meeting participant asks in the workplace — the meeting owner
// and the administrator see the request (workplace, panel) and get a letter if mail sending is on (smtp.enabled);
// they delete it through the trash: the owner by the usual delete, the administrator from the panel. A participant cannot delete:
// the delete right goes by the locator (owner.ts). A request is open while the meeting is not deleted: in the trash or purged —
// fulfilled (it drops out of the lists by the locator), restored from the trash — open again. The owner may keep
// the meeting — then the administrator decides. A request has no content; the letter to the owner has the title and a link,
// the one to the administrator only links (the panel does not get the closed title).
import type { Context, Hono } from "hono";
import { instanceLocale } from "@memory/i18n/context";
import { binder, enqueueMail, instanceTz, invalid, isUuid, log, mailIsoDay, MAIL_RE, newId, notFound, renderMail, smtpConfig, visibleSql } from "@memory/shared";
import type { App, Caller } from "./context.ts";
import { loadReadable, locate, readableSpaces } from "./access.ts";
import { byIdSpec } from "./visibility.ts";
import { audit, auditShownClosed } from "./audit.ts";
import { trashDays, trashRecord } from "./owner.ts";
import { leftMarks } from "./meetings.ts";
import { requireHuman, workplaceUrl } from "./workplace.ts";
import { intParam, offsetCursor } from "./paging.ts";
import { mailNotifierFor } from "./identity.ts";

// kept — the administrator kept the meeting: the request is closed, not to be asked a second time
type Status = "open" | "declined" | "kept";
/** The reason of a request comes from a short list: no free text, so that no retelling of the meeting gets into the reason. */
export const DELETION_REASONS = ["by_mistake", "private", "no_consent", "other"] as const;
export type DeletionReason = typeof DELETION_REASONS[number];
interface Row { id: string; record_id: string; created_at: Date; declined_at: Date | null; kept_at?: Date | null; reason?: string | null }
const status = (r: { declined_at: Date | null; kept_at?: Date | null }): Status => (r.kept_at ? "kept" : r.declined_at ? "declined" : "open");
const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const view = (r: Row) => ({ id: r.id, record_id: r.record_id, status: status(r), created_at: iso(r.created_at), declined_at: iso(r.declined_at),
                            kept_at: iso(r.kept_at), reason: r.reason ?? null });
const ROW_COLS = "id, record_id, created_at, declined_at, kept_at, reason";

/** The reason from the request body: none — null, not from the list — 400. */
export function parseDeletionReason(v: unknown): DeletionReason | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !(DELETION_REASONS as readonly string[]).includes(v)) throw invalid(`reason: ${DELETION_REASONS.join(" | ")} or omit the reason`);
  return v as DeletionReason;
}

/** A participant asks to delete a meeting: 201 — a new request, 200 — it exists (also one kept by the owner or administrator). */
export async function requestDeletion(app: App, caller: Caller, id: string, reason: DeletionReason | null = null): Promise<{ status: 200 | 201; body: ReturnType<typeof view> }> {
  await requireHuman(app, caller, "Ask to delete the meeting", { path: `/records/${id}`, section: "Record" });
  const me = caller.person!;
  const { rec } = await loadReadable(app, caller, id);                           // does not see the meeting — no such one (404)
  if (rec.owner_id === me.id) throw invalid("You own this meeting. Select “Delete” on the meeting page to move it to Trash");
  if (rec.type !== "transcript" || rec.parent_id) throw invalid("You can only ask to delete a whole meeting. Open the meeting and select “Ask to delete”");
  const ctl = app.db.control;
  const prev: Row | undefined = (await ctl.query(`SELECT ${ROW_COLS} FROM deletion_requests WHERE record_id = $1 AND requester_id = $2`, [id, me.id])).rows[0];
  if (prev) return { status: 200, body: view(prev) };
  const ins = await ctl.query(
    `INSERT INTO deletion_requests (id, instance_id, record_id, owner_id, requester_id, reason) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (record_id, requester_id) DO NOTHING RETURNING ${ROW_COLS}`, [newId(), app.instanceId, id, rec.owner_id, me.id, reason]);
  if (!ins.rowCount) {                                                           // a double click: the second insert lost
    const row = (await ctl.query(`SELECT ${ROW_COLS} FROM deletion_requests WHERE record_id = $1 AND requester_id = $2`, [id, me.id])).rows[0];
    return { status: 200, body: view(row) };
  }
  const row: Row = ins.rows[0];
  // author — to the meeting owner in My actions (as when a space owner deletes a foreign record)
  await audit(app, caller, { event_type: "write", class: rec.class, record_ids: [id], space_id: rec.space_id, details: { op: "deletion_requested", request_id: row.id, author: rec.owner_id, ...(reason ? { reason_code: reason } : {}) } });
  await notify(app, { id, title: rec.title, owner_id: rec.owner_id, occurred_at: rec.occurred_at }, me, row.id).catch((e: Error) => log.warn("deletion_request_mail_failed", { error: e.message.slice(0, 160) }));
  return { status: 201, body: view(row) };
}

/** Letters about a request only when sending is on: disabled mail does not pile up stale notices. */
async function notify(app: App, rec: { id: string; title: string | null; owner_id: string; occurred_at: Date }, requester: { login: string; display_name?: string | null }, reqId: string): Promise<void> {
  if (!mailNotifierFor(app.settings).canDeliver) return;
  const cfg = smtpConfig(app.settings);
  const ctl = app.db.control;
  const owner = (await ctl.query("SELECT login FROM people WHERE id = $1", [rec.owner_id])).rows[0];
  const who = requester.display_name?.trim() || requester.login, days = trashDays(app);
  const record = workplaceUrl(app, `/records/${rec.id}`), panel = workplaceUrl(app, "/admin/deletion-requests");
  const date = mailIsoDay(rec.occurred_at, instanceTz(app.settings));   // the day of the meeting in the instance zone
  let queued = 0;
  if (owner && MAIL_RE.test(owner.login)) {
    await enqueueMail(ctl, app.instanceId, {
      kind: "meeting_delete", dedupeKey: `deletion:${reqId}:owner`, createdBy: requester.login, to: owner.login,
      ...renderMail("deletion.owner", instanceLocale(), { who, login: requester.login, title: rec.title, date, days, recordUrl: record, recordId: rec.id }),
    });
    queued++;
  }
  if (cfg.admin_email && MAIL_RE.test(cfg.admin_email)) {
    await enqueueMail(ctl, app.instanceId, {
      kind: "meeting_delete", dedupeKey: `deletion:${reqId}:admin`, createdBy: requester.login, to: cfg.admin_email,
      ...renderMail("deletion.admin", instanceLocale(), { login: requester.login, owner: owner?.login ?? null, date, days, panelUrl: panel, recordId: rec.id }),
    });
    queued++;
  }
  if (queued) await app.queue.wake("mail");
}

/**
 * Meeting titles for the workplace lists — only of those the caller reads by id now (the builder's reference):
 * a participant removed from the members after the request sees their request without a title. The table `records`, not
 * records_live: non-current meeting versions keep their titles; rows of an unfinished class move (hidden_at) do not.
 */
async function titles(app: App, caller: Caller, rows: Array<{ record_id: string; class: "open" | "closed" }>): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const spec = byIdSpec(caller, await readableSpaces(app, caller));
  for (const cls of ["open", "closed"] as const) {
    const ids = [...new Set(rows.filter((r) => r.class === cls && caller.scope.classes.includes(cls)).map((r) => r.record_id))];
    if (!ids.length) continue;
    const args: unknown[] = [], bind = binder(args);
    const visible = visibleSql(spec, cls, bind);
    if (visible === null) continue;
    const db = app.db.records(cls, caller.scope);
    for (const t of (await db.query(`SELECT r.id, r.title FROM records r WHERE r.id = ANY(${bind(ids)}::uuid[]) AND r.deleted_at IS NULL AND r.hidden_at IS NULL AND ${visible}`, args)).rows)
      out.set(t.id, t.title ?? null);
  }
  return out;
}

/**
 * Which requesters are no longer among the meeting's people: `left` — removed themselves (the left-by-self mark),
 * `removed` — not among the meeting's people (removed, or saw it via the project). The request stays open (deleting for all is a separate action), but
 * the organizer no longer needs to remove that person from the participants. A meeting the caller does not read has no mark.
 */
async function requestersGone(app: App, caller: Caller, rows: Array<{ record_id: string; class: "open" | "closed"; requester_id: string; login: string }>): Promise<Map<string, "left" | "removed">> {
  const out = new Map<string, "left" | "removed">();
  for (const cls of ["open", "closed"] as const) {
    const mine = rows.filter((r) => r.class === cls && caller.scope.classes.includes(cls));
    if (!mine.length) continue;
    const db = app.db.records(cls, caller.scope);
    const ids = [...new Set(mine.map((r) => r.record_id))];
    const recs = new Map<string, unknown>((await db.query("SELECT id, attrs->'participants_left' AS l FROM records WHERE id = ANY($1::uuid[]) AND owner_id = $2", [ids, caller.person!.id])).rows
      .map((x) => [x.id as string, x.l]));
    const inside = new Set((await db.query("SELECT record_id || ':' || person_id AS k FROM record_people WHERE record_id = ANY($1::uuid[]) AND person_id = ANY($2::uuid[])",
                                           [ids, [...new Set(mine.map((r) => r.requester_id))]])).rows.map((x) => x.k as string));
    for (const r of mine) {
      if (!recs.has(r.record_id) || inside.has(`${r.record_id}:${r.requester_id}`)) continue;
      const left = leftMarks({ participants_left: recs.get(r.record_id) }).some((m) => m.login === r.login.toLowerCase());
      out.set(`${r.record_id}:${r.requester_id}`, left ? "left" : "removed");
    }
  }
  return out;
}

/**
 * My requests: incoming — on my meetings (except those kept by me or the administrator), outgoing — my requests on others'.
 * Deleted meetings are not listed. Titles of closed meetings are a read of closed records: one event before the answer, without
 * titles there is no event.
 */
export async function myDeletionRequests(app: App, caller: Caller) {
  const me = caller.person!;
  const ctl = app.db.control;
  const incoming = (await ctl.query(
    `SELECT d.id, d.record_id, d.requester_id, d.created_at, d.declined_at, d.kept_at, d.reason, l.class, p.login, p.display_name
       FROM deletion_requests d JOIN record_locations l ON l.record_id = d.record_id AND NOT l.deleted JOIN people p ON p.id = d.requester_id
      WHERE d.instance_id = $2 AND l.owner_id = $1 AND d.declined_at IS NULL AND d.kept_at IS NULL ORDER BY d.created_at DESC LIMIT 200`, [me.id, app.instanceId])).rows;
  const outgoing = (await ctl.query(
    `SELECT d.id, d.record_id, d.created_at, d.declined_at, d.kept_at, d.reason, l.class, p.login, p.display_name
       FROM deletion_requests d JOIN record_locations l ON l.record_id = d.record_id AND NOT l.deleted JOIN people p ON p.id = l.owner_id
      WHERE d.instance_id = $2 AND d.requester_id = $1 ORDER BY d.created_at DESC LIMIT 200`, [me.id, app.instanceId])).rows;
  const t = await titles(app, caller, [...incoming, ...outgoing]);
  await auditShownClosed(app, caller, [...incoming, ...outgoing].filter((r) => r.class === "closed" && t.get(r.record_id) != null).map((r) => r.record_id as string), "deletion_requests");
  const gone = incoming.length ? await requestersGone(app, caller, incoming) : new Map<string, "left" | "removed">();
  return {
    incoming: incoming.map((r) => {
      const g = gone.get(`${r.record_id}:${r.requester_id}`);
      return { ...view(r), title: t.get(r.record_id) ?? null, requester: { login: r.login, display_name: r.display_name }, ...(g ? { requester_gone: g } : {}) };
    }),
    outgoing: outgoing.map((r) => ({ ...view(r), title: t.get(r.record_id) ?? null, owner: { login: r.login, display_name: r.display_name } })),
  };
}

/** The owner keeps the meeting: the request leaves their inbox, the participant sees it kept, the administrator decides. */
export async function declineDeletion(app: App, caller: Caller, reqId: string) {
  await requireHuman(app, caller, "Keep meeting", { path: "/meetings", section: "Meetings with me" });
  const me = caller.person!;
  const r = (await app.db.control.query(
    `UPDATE deletion_requests d SET declined_at = COALESCE(d.declined_at, now())
       FROM record_locations l WHERE d.id = $1 AND d.instance_id = $3 AND l.record_id = d.record_id AND NOT l.deleted AND l.owner_id = $2
     RETURNING d.id, d.record_id, d.created_at, d.declined_at, d.kept_at, d.reason, l.class, l.space_id`, [reqId, me.id, app.instanceId])).rows[0];
  if (!r) throw notFound();
  await audit(app, caller, { event_type: "write", class: r.class, record_ids: [r.record_id], space_id: r.space_id, details: { op: "deletion_declined", request_id: r.id } });
  return view(r);
}

type AdminAudit = (c: Context<any>, op: string, details?: Record<string, unknown>) => Promise<void>;
const SYSTEM_SCOPE = { classes: ["open", "closed"] as const, tier: "system" as const };

/**
 * Meeting facts for the panel: date, duration and number of participants —
 * metadata from the class database in the system context, like the unprocessed list; no titles or content.
 */
async function meetingFacts(app: App, rows: Array<{ record_id: string; class: "open" | "closed" }>) {
  const out = new Map<string, { occurred_at: string | null; duration_sec: number | null; participants: number }>();
  for (const cls of ["open", "closed"] as const) {
    const ids = [...new Set(rows.filter((r) => r.class === cls).map((r) => r.record_id))];
    if (!ids.length) continue;
    const { rows: facts } = await app.db.records(cls, SYSTEM_SCOPE).query(
      `SELECT r.id, r.occurred_at, c.duration_sec, (SELECT count(*)::int FROM record_people p WHERE p.record_id = r.id) AS participants
         FROM records r LEFT JOIN record_content c ON c.record_id = r.id WHERE r.id = ANY($1::uuid[]) AND r.hidden_at IS NULL`, [ids]);
    for (const f of facts) out.set(f.id, { occurred_at: iso(f.occurred_at), duration_sec: typeof f.duration_sec === "number" ? f.duration_sec : null, participants: f.participants ?? 0 });
  }
  return out;
}

/** Meeting state in the panel: an open request — awaiting a decision; all kept by the administrator — kept; else kept by owner. */
export const meetingState = (reqs: ReadonlyArray<{ status: Status }>): Status =>
  reqs.some((r) => r.status === "open") ? "open" : reqs.length && reqs.every((r) => r.status === "kept") ? "kept" : "declined";

/** Who kept it: a panel session writes client_label `admin:<login>`, the system key `system`. */
const keptByOf = (caller: Caller): string => (caller.clientLabel?.startsWith("admin:") ? caller.clientLabel.slice(6) : "system");

/** The letter to the requester: a general subject without the meeting title — the date and a link; only with mail on. */
async function notifyKept(app: App, recordId: string, occurredAt: string | null, requesters: Array<{ login: string; request_id: string }>): Promise<number> {
  if (!mailNotifierFor(app.settings).canDeliver) return 0;
  const link = workplaceUrl(app, `/records/${recordId}`);
  const date = occurredAt ? mailIsoDay(occurredAt, instanceTz(app.settings)) : null;   // the day of the meeting in the instance zone
  let queued = 0;
  for (const q of requesters) {
    if (!MAIL_RE.test(q.login)) continue;
    await enqueueMail(app.db.control, app.instanceId, {
      kind: "meeting_delete", dedupeKey: `deletion:${q.request_id}:kept`, createdBy: "admin", to: q.login,
      ...renderMail("deletion.kept", instanceLocale(), { date, recordUrl: link, recordId }),
    });
    queued++;
  }
  if (queued) await app.queue.wake("mail");
  return queued;
}

/**
 * Panel: requests on undeleted meetings — one row per meeting: date, duration, participants,
 * space, owner, who asks and why; delete meeting moves it to the owner's trash, keep meeting closes the requests.
 * open / declined / kept — the number of MEETINGS in each state (the attention count counts meetings, not request rows).
 */
export function registerDeletionAdmin(r: Hono<any>, app: App, adminAudit: AdminAudit): void {
  const ctl = app.db.control;
  r.get("/deletion-requests", async (c) => {
    const limit = intParam(c.req.query("limit"), 50, 1, 200), offset = offsetCursor(c.req.query("cursor"));
    const GROUPS = `SELECT d.record_id, l.class, l.space_id, l.owner_id,
                           bool_or(d.kept_at IS NULL AND d.declined_at IS NULL) AS has_open, bool_and(d.kept_at IS NOT NULL) AS all_kept, max(d.created_at) AS last_at
                      FROM deletion_requests d JOIN record_locations l ON l.record_id = d.record_id AND NOT l.deleted
                     WHERE d.instance_id = $1 GROUP BY d.record_id, l.class, l.space_id, l.owner_id`;
    const { rows } = await ctl.query(
      `SELECT g.*, s.slug, s.name AS space_name, o.login AS owner_login, o.display_name AS owner_name
         FROM (${GROUPS}) g LEFT JOIN spaces s ON s.id = g.space_id JOIN people o ON o.id = g.owner_id
        ORDER BY g.all_kept, g.has_open DESC, g.last_at DESC, g.record_id LIMIT $2 OFFSET $3`, [app.instanceId, limit + 1, offset]);
    const counts = (await ctl.query(
      `SELECT count(*) FILTER (WHERE g.has_open)::int AS open, count(*) FILTER (WHERE NOT g.has_open AND NOT g.all_kept)::int AS declined,
              count(*) FILTER (WHERE g.all_kept)::int AS kept FROM (${GROUPS}) g`, [app.instanceId])).rows[0];
    const shown = rows.slice(0, limit);
    const ids = shown.map((x) => x.record_id as string);
    const reqs = ids.length ? (await ctl.query(
      `SELECT d.id, d.record_id, d.created_at, d.declined_at, d.kept_at, d.kept_by, d.reason, q.login, q.display_name
         FROM deletion_requests d JOIN people q ON q.id = d.requester_id WHERE d.instance_id = $1 AND d.record_id = ANY($2::uuid[]) ORDER BY d.created_at, d.id`,
      [app.instanceId, ids])).rows : [];
    const facts = await meetingFacts(app, shown);
    const items = shown.map((x) => {
      const mine = reqs.filter((q) => q.record_id === x.record_id).map((q) => ({ ...view(q), kept_by: q.kept_by ?? null, requester: { login: q.login, display_name: q.display_name } }));
      const f = facts.get(x.record_id);
      const kept = mine.filter((q) => q.status === "kept").sort((a, b) => String(b.kept_at).localeCompare(String(a.kept_at)))[0];
      return {
        record_id: x.record_id, class: x.class, status: meetingState(mine),
        occurred_at: f?.occurred_at ?? null, duration_sec: f?.duration_sec ?? null, participants: f?.participants ?? null,
        space: x.slug ? { slug: x.slug, name: x.space_name ?? x.slug } : null,
        owner: { login: x.owner_login, display_name: x.owner_name },
        requests: mine,
        kept: kept ? { at: kept.kept_at, by: kept.kept_by } : null,
      };
    });
    return c.json({ items, next_cursor: rows.length > limit ? String(offset + limit) : null, open: counts.open, declined: counts.declined, kept: counts.kept });
  });

  // keep meeting: closes all requests of this meeting the administrator has not closed yet. The meeting
  // stays; the requesters get an event in My actions (details.author) and a letter without the meeting title if mail is on
  r.post("/deletion-requests/:id/keep", async (c) => {
    const reqId = c.req.param("id");
    if (!isUuid(reqId)) throw notFound();
    const d = (await ctl.query("SELECT id, record_id FROM deletion_requests WHERE id = $1 AND instance_id = $2", [reqId, app.instanceId])).rows[0];
    const loc = d ? await locate(app, d.record_id) : null;
    if (!d || !loc || loc.deleted) throw notFound();                              // already deleted — nothing to keep
    const by = keptByOf(c.get("caller"));
    const closed = (await ctl.query(
      `UPDATE deletion_requests d SET kept_at = now(), kept_by = $3 FROM people q
        WHERE d.record_id = $1 AND d.instance_id = $2 AND d.kept_at IS NULL AND q.id = d.requester_id
      RETURNING d.id, d.requester_id, q.login, d.kept_at`, [d.record_id, app.instanceId, by])).rows;
    for (const q of closed)
      await audit(app, c.get("caller"), { event_type: "write", class: loc.class, record_ids: [d.record_id], space_id: loc.space_id,
                                          details: { op: "deletion_kept", request_id: q.id, author: q.requester_id } });
    await adminAudit(c, "deletion_request_keep", { request_id: d.id, record_id: d.record_id, closed: closed.length });
    const occurred = closed.length ? (await meetingFacts(app, [{ record_id: d.record_id, class: loc.class }])).get(d.record_id)?.occurred_at ?? null : null;
    const mailed = await notifyKept(app, d.record_id, occurred, closed.map((q) => ({ login: q.login, request_id: q.id })))
      .catch((e: Error) => { log.warn("deletion_kept_mail_failed", { error: e.message.slice(0, 160) }); return 0; });
    return c.json({ record_id: d.record_id, closed: closed.length, kept_at: iso(closed[0]?.kept_at ?? null), mailed });
  });

  r.post("/deletion-requests/:id/delete", async (c) => {
    const reqId = c.req.param("id");
    if (!isUuid(reqId)) throw notFound();
    const d = (await ctl.query("SELECT id, record_id FROM deletion_requests WHERE id = $1 AND instance_id = $2", [reqId, app.instanceId])).rows[0];
    const loc = d ? await locate(app, d.record_id) : null;
    if (!d || !loc || loc.deleted) throw notFound();                              // already deleted — the request is fulfilled
    const { out } = await trashRecord(app, SYSTEM_SCOPE, loc, d.record_id, null);
    const affected = out.ids.length;
    // the delete event is as for the owner (forget), to the meeting's author in My actions; the panel action is a separate event
    await audit(app, c.get("caller"), { event_type: "forget", class: loc.class, record_ids: out.ids, space_id: loc.space_id,
                                        details: { tool: "admin_deletion_request", action: "delete", request_id: d.id, batch: out.row.deleted_batch ?? d.record_id, affected, author: loc.owner_id } });
    await adminAudit(c, "deletion_request_delete", { request_id: d.id, record_id: d.record_id, affected });
    return c.json({ id: d.id, record_id: d.record_id, deleted_at: iso(out.row.deleted_at), purge_after: iso(out.row.purge_after), affected });
  });
}
