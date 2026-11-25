// Export of one space by a person in the workplace: a streamed tar.gz of the records the
// person can read in that space — both classes, previous versions too, not the trash — with their originals, in the
// open format prisma-memory-export/1 (contracts/export/). Only a human workplace session: never a key, an agent, a
// service or a preview; the external agents' address does not route it at all (channel.ts). The export is in the audit
// log before the first byte; closed records are logged by id, in batches, before each batch is read; a failing log
// stops the stream (an incomplete archive). Nothing is written to disk.
import type { Readable } from "node:stream";
import {
  binder, EXPORT_DAILY_DEFAULT, EXPORT_DAILY_MAX, EXPORT_DAILY_SETTING, EXPORT_ROW_SQL, EXPORT_SPACE_ENABLED_SETTING, EXPORT_SPACE_ROLE_SETTING, ExportAbort,
  exportMessage, exportOriginalChecked, exportRecordOf, exportSpaceRole, loadExportRelations, log, MemoryError, notFound, visibleSql, type DataClass, type ExportItem,
  type ExportOriginalSource, type ExportRow, type ExportSkipped,
} from "@memory/shared";
import type { App, Caller } from "../context.ts";
import { readableSpaces, type SpaceAccess } from "../access.ts";
import { listingSpec } from "../visibility.ts";
import { heldIds } from "../org-hold.ts";
import { isExternal } from "../channel.ts";
import { isHumanSession } from "../workplace.ts";
import { audit, AuditUnavailable } from "../audit.ts";
import { Slots } from "../concurrency.ts";
import { originalBucket } from "../originals.ts";

/** Records per batch: one id query, one strict audit event for the closed ones, then their rows. */
export const EXPORT_BATCH = 500;
/** Texts read from the database at a time inside a batch (a text may be large). */
const TEXT_CHUNK = 20;
/** A space export stops after this long (EXPORT-INCOMPLETE.txt, reason time_limit). */
export const EXPORT_TIME_CAP_MS = 30 * 60_000;
/**
 * Timing of the route (routes.ts). At `capMs` the export is stopped where it waits (between records, an original being
 * opened or read); if it has not ended `graceMs` later — a reader that stopped reading, a storage that does not answer —
 * the response is closed: the slot is freed and the closing event is written either way. Tests shorten both.
 */
export const EXPORT_TIMING = { capMs: EXPORT_TIME_CAP_MS, graceMs: 60_000 };
/** Two exports per gateway process, one per person (as the original downloads, originals.ts). */
export const exportSlots = new Slots(2, 1);
/** Retry hint of a refusal because exports are running. */
const BUSY_RETRY_SEC = 30;

/**
 * The daily counter: `read` events with `details.op = export` of the person in the last 24 hours (no table of its own);
 * the copies of the start event addressed to the space owners (`owner_notice`) are not exports of their own.
 */
const DAILY_SQL = `SELECT count(*)::int AS n, min(at) AS oldest FROM audit_events
                    WHERE instance_id = $1 AND event_type = 'read' AND principal_id = $2 AND details->>'op' = 'export'
                      AND NOT coalesce(details->'owner_notice' = 'true'::jsonb, false) AND at > now() - interval '24 hours'`;

const reject = (id: Parameters<typeof exportMessage>[0], reason: string, vars: Record<string, string | number> = {}): MemoryError =>
  new MemoryError("forbidden", exportMessage(id, vars), { details: { reason } });

/** The switch; off — 403 before anything else (and before the rate limit window is spent). */
export function requireExportEnabled(app: App): void {
  if (app.settings.get<boolean>(EXPORT_SPACE_ENABLED_SETTING, true) !== true) throw reject("export.disabled", "export_disabled");
}

/**
 * Who may export which space: a human workplace session; a space the person reads (an archived one too); the personal
 * space — only its owner; a team, project or company space — its owner, or also a member with
 * `access.export_space_role = member` (a reader never). Unknown or foreign space — 404, as everywhere.
 */
export const exportTarget = (app: App, caller: Caller, slug: string): Promise<SpaceAccess> => exportSpace(app, caller, (x) => x.slug === slug);

/** The rule of exportTarget for the space `match` picks among the spaces the caller reads (archived ones too). */
async function exportSpace(app: App, caller: Caller, match: (s: SpaceAccess) => boolean): Promise<SpaceAccess> {
  if (isExternal(caller)) throw notFound();
  if (!isHumanSession(caller) || !caller.person) throw reject("export.human_only", "human_session_required");
  const s = [...(await readableSpaces(app, caller, { archived: true })).values()].find(match);
  if (!s) throw notFound();
  if (s.kind === "personal") {
    if (s.owner_id !== caller.person.id) throw reject("export.personal_owner", "export_denied");
    return s;
  }
  const role = exportSpaceRole(app.settings.get<unknown>(EXPORT_SPACE_ROLE_SETTING, "owner"));
  if (s.role === "owner" || (role === "member" && s.role === "member")) return s;
  throw reject(role === "member" ? "export.role_member" : "export.role_owner", "export_denied");
}

/** Classes the caller reads: a session reads both. */
const classesOf = (caller: Caller): DataClass[] => (["open", "closed"] as const).filter((c) => caller.scope.classes.includes(c));

/**
 * The selection of one class: home records of the space, not in the trash, not mid-move, readable by the caller.
 * `moving` — the rows of the space whose class move is under way instead (hidden_at set: "Show to agents", "Close",
 * bulk open); they are counted, never read.
 */
async function selection(app: App, caller: Caller, s: SpaceAccess, cls: DataClass, bind: (v: unknown) => string, moving: boolean | "any" = false): Promise<{ base: string; vis: string | null }> {
  const base = [`r.space_id = ${bind(s.id)}::uuid`, "r.deleted_at IS NULL"];
  if (moving !== "any") base.push(moving ? "r.hidden_at IS NOT NULL" : "r.hidden_at IS NULL");
  const held = s.kind === "org" ? await heldIds(app, caller, cls) : [];
  if (held.length) base.push(`r.id <> ALL(${bind(held)}::uuid[])`);
  return { base: base.join(" AND "), vis: visibleSql(listingSpec(app, caller, [s.id]), cls, bind) };
}

export interface ExportPreview {
  space: string; records: number; originals: number; bytes_estimate: number; classes: DataClass[]; skipped_no_access: number;
  /** Records the person reads whose class is being changed right now: not in an export started now. */
  skipped_moving: number;
}

/** Ids of the rows of the space mid-move that the caller reads in that class (a move hides the row in both databases). */
async function movingIds(app: App, caller: Caller, s: SpaceAccess, cls: DataClass, into: Set<string>): Promise<void> {
  const args: unknown[] = [], bind = binder(args);
  const { base, vis } = await selection(app, caller, s, cls, bind, true);
  if (vis === null) return;
  for (const x of (await app.db.records(cls, caller.scope).query(`SELECT r.id FROM records r WHERE ${base} AND ${vis}`, args)).rows) into.add(x.id as string);
}

/** Page size of the closing walk over the ids of a space (ids only, nothing is read). */
const ID_PAGE = 5000;

/**
 * The closing account of a space export, one walk per class: the rows of the space the caller reads in `cls` now and no
 * pass wrote — hidden now (a class move under way; its target copy may be newer than the export), or, created before the
 * export started, hidden for a moment while the pass went by (a move started and undone, a hold) — go to `into`
 * (counted as moving: the person exports again later). Ids only; hidden and visible rows in the same query, so no row
 * slips between two snapshots.
 */
async function unwrittenIds(app: App, caller: Caller, s: SpaceAccess, cls: DataClass, since: Date, written: ReadonlyMap<string, DataClass>, into: Set<string>): Promise<void> {
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const args: unknown[] = [], bind = binder(args);
    const { base, vis } = await selection(app, caller, s, cls, bind, "any");
    if (vis === null) return;
    const page = (await app.db.records(cls, caller.scope).query(
      `SELECT r.id FROM records r WHERE ${base} AND ${vis} AND (r.hidden_at IS NOT NULL OR r.created_at <= ${bind(since)}::timestamptz) AND r.id > ${bind(after)}::uuid ORDER BY r.id LIMIT ${ID_PAGE}`, args))
      .rows.map((x) => x.id as string);
    for (const id of page) if (!written.has(id)) into.add(id);
    if (page.length < ID_PAGE) return;
    after = page[page.length - 1]!;
  }
}

/** What an export of the space would contain now: the same selection, numbers only (no content, no audit event). */
export async function exportPreview(app: App, caller: Caller, slug: string): Promise<ExportPreview> {
  requireExportEnabled(app);
  const s = await exportTarget(app, caller, slug);
  const classes = classesOf(caller);
  const out: ExportPreview = { space: s.slug, records: 0, originals: 0, bytes_estimate: 0, classes, skipped_no_access: 0, skipped_moving: 0 };
  const moving = new Set<string>();
  for (const cls of ["open", "closed"] as const) {
    if (classes.includes(cls)) await movingIds(app, caller, s, cls, moving);
    const args: unknown[] = [], bind = binder(args);
    const { base, vis } = await selection(app, caller, s, cls, bind);
    const v = vis ?? "FALSE";
    const row = (await app.db.records(cls, caller.scope).query(
      `SELECT count(*) FILTER (WHERE ${v})::int AS records,
              count(*) FILTER (WHERE ${v} AND c.original_key IS NOT NULL)::int AS originals,
              COALESCE(sum(COALESCE(c.original_bytes, 0) + COALESCE(octet_length(c.text), 0)) FILTER (WHERE ${v}), 0)::bigint AS bytes,
              count(*) FILTER (WHERE NOT COALESCE(${v}, false))::int AS no_access
         FROM records r LEFT JOIN record_content c ON c.record_id = r.id WHERE ${base}`, args)).rows[0] ?? {};
    out.records += row.records ?? 0; out.originals += row.originals ?? 0; out.bytes_estimate += Number(row.bytes ?? 0); out.skipped_no_access += row.no_access ?? 0;
  }
  out.skipped_moving = moving.size;
  return out;
}

/** Daily limit from the audit log; the log cannot be read — no export (it could not be logged either). */
async function requireDailyLeft(app: App, caller: Caller): Promise<void> {
  // read fail-closed like the role: a stored value that is not a whole number from 1 is the default, never "no limit"
  const v = app.settings.get<unknown>(EXPORT_DAILY_SETTING, EXPORT_DAILY_DEFAULT);
  const limit = typeof v === "number" && Number.isInteger(v) && v >= 1 ? Math.min(v, EXPORT_DAILY_MAX) : EXPORT_DAILY_DEFAULT;
  let row: { n: number; oldest: Date | null } | undefined;
  try { row = (await app.db.auditRead().query(DAILY_SQL, [app.instanceId, caller.person!.id])).rows[0]; }
  catch { throw new AuditUnavailable("audit log unreadable: the daily export limit cannot be checked"); }
  if ((row?.n ?? 0) >= limit) {
    const retry = row?.oldest ? Math.max(1, Math.ceil((new Date(row.oldest).getTime() + 86_400_000 - Date.now()) / 1000)) : 3600;
    throw new MemoryError("rate_limited", exportMessage("export.daily_limit", { limit }), { retry_after: retry, details: { reason: "export_daily_limit", limit } });
  }
}

/** Strict audit: the event is written or the caller gets AuditUnavailable (503) — nothing is sent without it. */
async function strictAudit(app: App, caller: Caller, e: Parameters<typeof audit>[2]): Promise<void> {
  try { await audit(app, caller, e, { strict: true }); }
  catch { throw new AuditUnavailable(`audit log did not accept ${String(e.details?.op ?? e.event_type)}`); }
}

/** The person is still active and the workplace session neither ended nor expired (sessions are ended, never deleted). */
const STILL_SIGNED_IN_SQL = `SELECT p.active AND COALESCE(p.attrs->>'demo', '') <> 'true' AS person_ok,
       NOT EXISTS (SELECT 1 FROM user_sessions u WHERE u.id = $2::uuid AND (u.ended_at IS NOT NULL OR u.expires_at <= now())) AS session_ok
  FROM people p WHERE p.id = $1`;

/**
 * Before every batch: the switch, the person and the session, the space and the role again (the same rules as at the
 * start, the space found by id). Taken away while the export runs — ExportAbort access_revoked: the archive ends
 * without manifest.json and no further record is read. A failing database is not a refusal: it stops as `internal`.
 */
async function requireStillAllowed(app: App, caller: Caller, s: SpaceAccess): Promise<void> {
  try {
    requireExportEnabled(app);
    const row = (await app.db.control.query(STILL_SIGNED_IN_SQL, [caller.person!.id, caller.keyId])).rows[0];
    if (row?.person_ok !== true || row.session_ok !== true) throw new ExportAbort("access_revoked");
    await exportSpace(app, caller, (x) => x.id === s.id);
  } catch (e) {
    if (e instanceof MemoryError) throw new ExportAbort("access_revoked");
    throw e;
  }
}

/** At most this many owners get the notice of one export (a space has one or a few; the rest is logged). */
export const OWNER_NOTICE_MAX = 50;

/**
 * The people who own the space now — the rule of readableSpaces: an effective `owner` row (assigned by hand, a head of
 * the department, a group or grant), or `spaces.owner_id` outside a department space while that person still reads the
 * space (a member row, or the company space for an active person). `owner_id` alone gives no owner rights: a former
 * head or a person removed from the space is not told. Personal spaces have no other owner.
 */
const OWNERS_SQL = `SELECT person_id FROM (
    SELECT m.person_id FROM space_members_effective m WHERE m.space_id = $1 AND m.role = 'owner'
    UNION
    SELECT s.owner_id FROM spaces s JOIN people p ON p.id = s.owner_id
     WHERE s.id = $1 AND s.org_unit_id IS NULL
       AND (EXISTS (SELECT 1 FROM space_members_effective m2 WHERE m2.space_id = s.id AND m2.person_id = s.owner_id)
            OR (s.kind = 'org' AND p.active AND COALESCE(p.attrs->>'demo', '') <> 'true'))) o
  WHERE person_id IS NOT NULL AND person_id <> $2 ORDER BY person_id LIMIT ${OWNER_NOTICE_MAX + 1}`;

/** The owners of `s` other than the caller, who are told of the caller's export (the space owner's feed). */
export async function spaceOwners(app: App, caller: Caller, s: SpaceAccess): Promise<string[]> {
  if (s.kind === "personal") return [];
  const ids = (await app.db.control.query(OWNERS_SQL, [s.id, caller.person!.id])).rows.map((x) => x.person_id as string);
  if (ids.length > OWNER_NOTICE_MAX) log.warn("space_export_owner_notice_capped", { space: s.slug, max: OWNER_NOTICE_MAX });
  return ids.slice(0, OWNER_NOTICE_MAX);
}

/**
 * The copies of an export event for the space owners (their "My actions"): the same details, `author` — the owner it is
 * addressed to, `owner_notice` (the caller's own feed and the daily counter leave these copies out), `by_role` — whether
 * an owner or a member took the copy (the feed names who did it, audit.ts actorOf), and `resultCount` — the record count
 * of the event itself, so the owner reads the same number as the exporter (the closing event; RC-sGb-1). Strict for the
 * start event: the owners are told before the first byte, or nothing is sent.
 */
export async function ownerNotices(app: App, caller: Caller, s: SpaceAccess, owners: readonly string[], details: Record<string, unknown>, strict: boolean,
                                   resultCount: number | null = null): Promise<void> {
  const byRole = s.role === "owner" ? "space_owner" : "space_member";
  for (const author of owners) {
    const e = { event_type: "read" as const, class: null, space_id: s.id, result_count: resultCount, details: { ...details, owner_notice: true, author, by_role: byRole } };
    if (strict) await strictAudit(app, caller, e);
    else await audit(app, caller, e);
  }
}

/** Logins by person id, cached for the export. */
async function logins(app: App, ids: Iterable<string>, cache: Map<string, string | null>): Promise<void> {
  const want = [...new Set(ids)].filter((id) => !cache.has(id));
  if (!want.length) return;
  for (const p of (await app.db.control.query("SELECT id, login FROM people WHERE id = ANY($1::uuid[])", [want])).rows) cache.set(p.id, p.login);
  for (const id of want) if (!cache.has(id)) cache.set(id, null);
}

/** The original of a row, read from storage when the engine reaches it. */
function originalOf(app: App, r: ExportRow): ExportOriginalSource | null {
  if (!r.original_key) return null;
  const key = r.original_key, bucket = originalBucket(r.class, r.attrs?.original_closed === true);
  const known = r.original_bytes === null || r.original_bytes === undefined ? null : Number(r.original_bytes);
  const missing = (e: { code?: unknown }) => { if (e?.code === "NoSuchKey" || e?.code === "NotFound") return null; throw e; };
  return {
    name: typeof r.attrs?.filename === "string" ? r.attrs.filename : null, mime: r.original_mime, pages: r.pages, duration_sec: r.duration_sec,
    open: async () => {
      if (known !== null && Number.isSafeInteger(known) && known >= 0) {
        const s: Readable | null = await app.storage.getStream(bucket, key).catch(missing);
        return s ? { bytes: known, body: s } : null;
      }
      const b = await app.storage.get(bucket, key, app.settings.get<number>("limits.upload_max_bytes", 20_971_520)).catch(missing);
      return b ? { bytes: b.length, body: [b] } : null;
    },
  };
}

export interface ExportRun {
  space: SpaceAccess; classes: DataClass[];
  /** The space owners told of this export at its start (spaceOwners); the closing event goes to them too. */
  owners: string[];
  /** Counts the source keeps while it runs (no_access, gone, original_unchecked). */
  skipped: ExportSkipped;
  items: AsyncGenerator<ExportItem>;
  /** Frees the slot; idempotent. The source calls it when it ends; the route also calls it when the response closes. */
  release: () => void;
}

/**
 * The source of one space export: the space, then the records in id order, batch by batch — the open database, the
 * closed one, then the open one again for records that moved there from the closed one meanwhile (each record once:
 * an id already written is skipped, `moved` when it turns up again under the other class, in either direction). Before
 * every batch the rights are checked again (requireStillAllowed); before a batch of closed records (and of open records whose file lies
 * in the closed bucket) is read, its ids go to the audit log strictly; a refusal stops the export (ExportAbort). A
 * record deleted between the id query and the row query is counted as gone; rows mid-move as moving (both only when
 * the record was not written after all). At the end one walk per class over the ids of the space (hidden or not) counts
 * every row no pass wrote as moving — hidden now, or hidden while its pass went by: nothing the space held when the
 * export started is missing without a count. `finally` runs when the engine finishes or the reader goes away: `release` frees
 * the slot.
 */
export function spaceExportSource(app: App, caller: Caller, s: SpaceAccess, classes: DataClass[], skipped: ExportSkipped, release: () => void): AsyncGenerator<ExportItem> {
  const add = (k: string, n: number) => { if (n > 0) skipped[k] = (skipped[k] ?? 0) + n; };
  const people = new Map<string, string | null>();
  // id → the class it was written under (a later copy under the other class is `moved`)
  const written = new Map<string, DataClass>(), gone = new Set<string>(), moving = new Set<string>();
  const passes: Array<{ cls: DataClass; again: boolean }> = [{ cls: "open", again: false }, { cls: "closed", again: false }, { cls: "open", again: true }];
  return (async function* () {
    try {
      await logins(app, s.owner_id ? [s.owner_id] : [], people);
      // `since` — the database clock at the start: records created later are not owed to this archive
      const head = (await app.db.control.query("SELECT created_at, now() AS since FROM spaces WHERE id = $1", [s.id])).rows[0];
      const created = head?.created_at ?? null, since: Date = head?.since ?? new Date();
      yield { kind: "space", space: { slug: s.slug, name: s.name, kind: s.kind, default_class: s.default_class, description: s.description, created_at: created,
                                      owner: s.owner_id ? people.get(s.owner_id) ?? null : null, archived_at: s.archived_at ?? null }, scope: { space: s.slug } };
      for (const { cls, again } of passes) {
        const db = app.db.records(cls, caller.scope);
        if (!again) {
          // records the caller cannot read in this space (or a class it does not read) are counted, never read
          const args: unknown[] = [], bind = binder(args);
          const { base, vis } = await selection(app, caller, s, cls, bind);
          add("no_access", (await db.query(`SELECT count(*)::int AS n FROM records r WHERE ${base} AND NOT COALESCE(${vis ?? "FALSE"}, false)`, args)).rows[0]?.n ?? 0);
          if (vis === null || !classes.includes(cls)) continue;
        } else if (!classes.includes(cls)) continue;
        await movingIds(app, caller, s, cls, moving);
        let after = "00000000-0000-0000-0000-000000000000";
        for (;;) {
          await requireStillAllowed(app, caller, s);
          const args: unknown[] = [], bind = binder(args);
          const { base, vis } = await selection(app, caller, s, cls, bind);
          if (vis === null) break;
          const listed = (await db.query(`SELECT r.id FROM records r WHERE ${base} AND ${vis} AND r.id > ${bind(after)}::uuid ORDER BY r.id LIMIT ${EXPORT_BATCH}`, args))
            .rows.map((x) => x.id as string);
          if (!listed.length) break;
          after = listed[listed.length - 1]!;
          // already in the archive under the other class (moved while the export ran) — skipped, never read or logged twice
          const ids = listed.filter((id) => !written.has(id));
          add("moved", listed.filter((id) => written.has(id) && written.get(id) !== cls).length);
          if (!ids.length) continue;
          if (cls === "closed") {
            try { await strictAudit(app, caller, { event_type: "read", class: "closed", record_ids: ids, space_id: s.id, result_count: ids.length,
                                                   details: { op: "export_records", space: s.slug } }); }
            catch { throw new ExportAbort("audit_unavailable"); }
          }
          // the rows of the batch again under the same selection: deleted, moved or no longer readable since — gone
          const rargs: unknown[] = [], rbind = binder(rargs);
          const sel = await selection(app, caller, s, cls, rbind);
          const rows = (await db.query(`SELECT ${EXPORT_ROW_SQL} FROM records r LEFT JOIN record_content c ON c.record_id = r.id
                                         WHERE r.id = ANY(${rbind(ids)}::uuid[]) AND ${sel.base} AND ${sel.vis} ORDER BY r.id`, rargs)).rows as ExportRow[];
          const got = rows.map((r) => r.id);
          const present = new Set(got);
          for (const id of ids) if (!present.has(id)) gone.add(id);
          // open records whose file lies in the closed bucket (shown to agents "as text only"): the file is closed data
          const closedFiles = rows.filter((r) => r.class === "open" && r.original_key && r.attrs?.original_closed === true && exportOriginalChecked(r)).map((r) => r.id);
          if (closedFiles.length) {
            try { await strictAudit(app, caller, { event_type: "read", class: "closed", record_ids: closedFiles, space_id: s.id, result_count: closedFiles.length,
                                                   details: { op: "export_files", space: s.slug } }); }
            catch { throw new ExportAbort("audit_unavailable"); }
          }
          // people listed on the records, entities, corrections: the same mapping as the whole-instance export (shared export/rows.ts)
          const rel = await loadExportRelations(db, app.db.control, got);
          const derived = new Map<string, string[]>();
          if (got.length) {
            await logins(app, [...rows.map((r) => r.owner_id), ...[...rel.listed.values()].flat()], people);
            const dargs: unknown[] = [], dbind = binder(dargs);
            const dsel = await selection(app, caller, s, cls, dbind);
            for (const x of (await db.query(`SELECT r.parent_id, r.id FROM records r WHERE r.parent_id = ANY(${dbind(got)}::uuid[]) AND ${dsel.base} AND ${dsel.vis} ORDER BY r.id`, dargs)).rows)
              (derived.get(x.parent_id) ?? derived.set(x.parent_id, []).get(x.parent_id)!).push(x.id);
          }
          for (let i = 0; i < rows.length; i += TEXT_CHUNK) {
            const chunk = rows.slice(i, i + TEXT_CHUNK);
            const texts = new Map<string, string>();
            for (const t of (await db.query("SELECT record_id, text FROM record_content WHERE record_id = ANY($1::uuid[])", [chunk.map((r) => r.id)])).rows) texts.set(t.record_id, t.text);
            for (const r of chunk) {
              const unchecked = !!r.original_key && !exportOriginalChecked(r);
              add("original_unchecked", unchecked ? 1 : 0);
              const record = exportRecordOf(r, s.slug, rel, derived.get(r.id) ?? [], people);
              const original = originalOf(app, r);
              written.set(r.id, cls);
              yield { kind: "record", record, text: texts.get(r.id) ?? null, original: original && unchecked ? { ...original, withheld: "unchecked" } : original };
            }
          }
        }
      }
      // hidden since its pass took the snapshot of hidden rows, or visible again after the pass went by: counted, never read
      for (const cls of ["open", "closed"] as const) if (classes.includes(cls)) await unwrittenIds(app, caller, s, cls, since, written, moving);
      // what is not in the archive after all: a record deleted or mid-move here may have been written under its other class
      // (one hidden between its id query and its row query and still hidden now is moving, not gone: counted once)
      add("gone", [...gone].filter((id) => !written.has(id) && !moving.has(id)).length);
      add("moving", [...moving].filter((id) => !written.has(id)).length);
    } finally {
      release();
    }
  })();
}

/**
 * Everything before the first byte of a space export, in this order: the switch, the session, the space and the role,
 * a slot (one per person, two per process), the daily limit from the audit log, then the strict `read` event
 * `{op: export}` and its strict copies for the other owners of the space (ownerNotices). Any refusal frees the slot.
 * The caller streams `items` through the engine and writes the closing event.
 */
export async function startSpaceExport(app: App, caller: Caller, slug: string): Promise<ExportRun> {
  requireExportEnabled(app);
  const space = await exportTarget(app, caller, slug);
  const slot = exportSlots.take(caller.person!.id);
  if (slot === "key") throw new MemoryError("in_progress", exportMessage("export.busy_person"), { retry_after: BUSY_RETRY_SEC, details: { reason: "export_running" } });
  if (slot === "total") throw new MemoryError("rate_limited", exportMessage("export.busy_total"), { retry_after: BUSY_RETRY_SEC, details: { reason: "exports_busy" } });
  try {
    await requireDailyLeft(app, caller);
    const classes = classesOf(caller);
    const owners = await spaceOwners(app, caller, space);
    const details = { op: "export", scope: "space", space: space.slug, classes };
    await strictAudit(app, caller, { event_type: "read", class: classes.includes("closed") ? "closed" : "open", space_id: space.id, details });
    await ownerNotices(app, caller, space, owners, details, true);
    const skipped: ExportSkipped = {};
    return { space, classes, owners, skipped, items: spaceExportSource(app, caller, space, classes, skipped, slot.release), release: slot.release };
  } catch (e) {
    slot.release();
    throw e;
  }
}
