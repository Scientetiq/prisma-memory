import { CHAIN_TREE, CUSTODY_AFTER_DAYS, CUSTODY_MAIL_STALE, CUSTODY_MEETINGS, CUSTODY_PERSONAL, custodyCurrentSql, custodyDataSql, custodyMail, custodyMailable, custodyOp, custodyPolicy,
         despiteShown, enqueueMail, handedKey, handedParts, handedRoots, heldOrigins, log, meetingOriginOf, meetingSharedSql, MemoryError, newId, showcaseSql, smtpConfig, spaceMove,
         syncCustody, testLoginSql, tryLockCustody, tx, type CustodyBasis, type CustodyChange, type CustodyPolicy, type DataClass } from "@memory/shared";
import { auditWorker, recordsDb, type Ctx, type DbCtx } from "../ctx.ts";

const CLASSES: readonly DataClass[] = ["open", "closed"];
const MOVING = "status IN ('pending','copying','verifying')";

export interface CustodyPassResult { assigned: number; changed: number; ended: number; waiting: number }
export interface MeetingsPassResult { moved: number; returned: number; busy: number; conflicts: number; tails: number; closed: number }
export const EMPTY_CUSTODY: CustodyPassResult = { assigned: 0, changed: 0, ended: 0, waiting: 0 };
export const EMPTY_MEETINGS: MeetingsPassResult = { moved: 0, returned: 0, busy: 0, conflicts: 0, tails: 0, closed: 0 };

export const dismissedDueSql = (policy: CustodyPolicy): string =>
  `SELECT p.id AS person_id, p.login, s.id AS space_id FROM people p JOIN spaces s ON s.kind = 'personal' AND s.owner_id = p.id
     WHERE p.instance_id = $1 AND NOT p.active AND COALESCE(p.attrs->>'demo', '') <> 'true'
       AND s.archived_at IS NOT NULL AND s.archived_at < now() - make_interval(days => $2)
       AND EXISTS (SELECT 1 FROM record_locations l WHERE l.space_id = s.id AND NOT l.deleted)${policy.personal === "keep" ? `
       AND ${testLoginSql("p")}` : ""}`;

export async function custodyEvent(ctx: DbCtx, ch: CustodyChange): Promise<void> {
  await auditWorker(ctx, { event_type: "admin", space_id: ch.space,
    details: { op: custodyOp(ch.reason), by: "auto", person: ch.person, custodian: ch.to, previous: ch.from, basis: ch.basis, levels: ch.levels, reason: ch.reason } });
}

export async function dismissedCustody(ctx: DbCtx, policy: CustodyPolicy, alive?: () => Promise<void>): Promise<CustodyPassResult> {
  const out = await tx(ctx.db.control, async (q) => {
    if (!(await tryLockCustody(q, ctx.instanceId))) return null;
    if (alive) await alive();
    return syncCustody(q, ctx.instanceId, policy, { all: true });
  });
  if (!out) { log.info("dismissed_custody_busy", {}); return { ...EMPTY_CUSTODY }; }
  for (const ch of out.changes) {
    if (alive) await alive();
    await custodyEvent(ctx, ch);
  }
  const n = (ops: string[]) => out.changes.filter((c) => ops.includes(custodyOp(c.reason))).length;
  const res = { assigned: n(["custody_assign"]), changed: n(["custody_change"]), ended: n(["custody_end"]), waiting: out.waiting.length };
  if (res.assigned || res.changed || res.ended || out.created.length) log.info("dismissed_custody_synced", { ...res, created: out.created.length });
  return res;
}

interface Root {
  id: string; cls: DataClass; source_ref: string | null; space_id: string;
  origin?: string;
}
export async function meetingFamilies(ctx: DbCtx, personId: string): Promise<Map<string, Root[]>> {
  const fams = new Map<string, { roots: Root[]; shared: boolean }>();
  for (const cls of CLASSES) {
    const rows = (await recordsDb(ctx, cls).query(
      `SELECT r.id, r.source_ref, r.space_id, r.attrs->'organizer_transfer' AS ot, ${meetingSharedSql()} AS shared
         FROM records r
        WHERE r.source_kind = 'transcriber' AND r.parent_id IS NULL AND r.owner_id = $1 AND r.deleted_at IS NULL AND r.hidden_at IS NULL
        ORDER BY r.id`, [personId])).rows;
    for (const r of rows) {
      const key = r.source_ref ? `ref:${r.source_ref}` : `id:${r.id}`;
      const f = fams.get(key) ?? { roots: [], shared: false };
      f.roots.push({ id: r.id, cls, source_ref: r.source_ref ?? null, space_id: r.space_id, origin: meetingOriginOf(r.ot, personId) });
      f.shared ||= r.shared === true;
      fams.set(key, f);
    }
  }
  const lone = [...fams.values()].filter((f) => !f.shared && f.roots[0]!.source_ref);
  if (lone.length) {
    const handed = await handedParts(CLASSES.map((cls) => recordsDb(ctx, cls)), lone.map((f) => f.roots[0]!.source_ref!), personId);
    for (const f of lone) f.shared = f.roots.some((x) => handed.has(handedKey(x.source_ref!, x.origin ?? personId)));
  }
  return new Map([...fams].filter(([, f]) => f.shared).map(([k, f]) => [k, f.roots]));
}

async function familyShared(ctx: DbCtx, person: string, root: Pick<Root, "id" | "source_ref">): Promise<boolean> {
  for (const cls of CLASSES)
    if ((await recordsDb(ctx, cls).query(
      `SELECT 1 FROM records r
        WHERE r.source_kind = 'transcriber' AND r.parent_id IS NULL AND r.owner_id = $1 AND r.deleted_at IS NULL AND r.hidden_at IS NULL
          AND (r.id = $2::uuid OR ($3::text IS NOT NULL AND r.source_ref = $3::text)) AND ${meetingSharedSql()} LIMIT 1`,
      [person, root.id, root.source_ref])).rowCount) return true;
  return false;
}

export async function custodianConflicts(ctx: DbCtx, custodian: string, person: string, refs: string[], origins: string[] = [person]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!refs.length) return out;
  for (const cls of CLASSES)
    for (const r of (await recordsDb(ctx, cls).query(
      `SELECT DISTINCT source_ref FROM records WHERE source_kind = 'transcriber' AND parent_id IS NULL AND owner_id = $1 AND source_ref = ANY($2::text[])
          AND deleted_at IS NULL AND COALESCE(attrs->'organizer_transfer'->>'from', '') <> $3::text
          AND NOT COALESCE(attrs->'organizer_transfer'->>'origin' = ANY($4::text[]), false)`, [custodian, refs, person, origins])).rows) out.add(r.source_ref);
  return out;
}

async function familyHolders(ctx: DbCtx, ref: string, origin: string, person: string): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (const r of await handedRoots(CLASSES.map((cls) => recordsDb(ctx, cls)), [ref], person))
    if (r.origin === origin && !out.has(r.owner_id)) out.set(r.owner_id, r.basis);
  return out;
}

async function treeMoving(q: { query: DbCtx["db"]["control"]["query"] }, ctx: DbCtx, cls: DataClass, rootId: string): Promise<boolean> {
  const ids = (await recordsDb(ctx, cls).query(`${CHAIN_TREE} SELECT id FROM tree`, [rootId])).rows.map((r) => r.id as string);
  return !!(await q.query(`SELECT 1 FROM class_moves WHERE record_id = ANY($1::uuid[]) AND ${MOVING} LIMIT 1`, [ids.length ? ids : [rootId]])).rowCount;
}

const lockBusy = (e: unknown): boolean => (e as { code?: string })?.code === "55P03";

async function meetingsNow(q: { query: DbCtx["db"]["control"]["query"] }, instanceId: string): Promise<unknown> {
  const r = (await q.query("SELECT COALESCE(value, default_value) AS v FROM settings WHERE instance_id = $1 AND category = 'access' AND key = 'dismissed_meetings'", [instanceId])).rows[0];
  return r?.v ?? "transfer";
}

async function afterDaysNow(q: { query: DbCtx["db"]["control"]["query"] }, instanceId: string): Promise<number> {
  const r = (await q.query("SELECT COALESCE(value, default_value) AS v FROM settings WHERE instance_id = $1 AND category = 'access' AND key = 'dismissed_custody_after_days'",
                           [instanceId])).rows[0];
  return custodyPolicy({ get: <T>(path: string, fallback: T): T => (path === "access.dismissed_custody_after_days" && r?.v != null ? r.v as T : fallback) }).afterDays;
}

const TRANSFER_STILL_DUE_SQL = `SELECT 1 FROM people p JOIN spaces s ON s.id = $2::uuid AND s.kind = 'personal' AND s.owner_id = p.id
  WHERE p.id = $1 AND NOT p.active AND s.archived_at = $3::timestamptz AND s.archived_at <= now() - make_interval(days => $4::int)
  FOR SHARE OF p NOWAIT`;

export const DETACH_LEFT_SQL = `${CHAIN_TREE}
  UPDATE records c SET parent_id = NULL,
         attrs = c.attrs || jsonb_build_object('detached_from', jsonb_build_object('record_id', p.id, 'type', p.type, 'occurred_at', p.occurred_at,
                                                                                  'reason', $3::text, 'at', now()))
    FROM records p
   WHERE c.id IN (SELECT id FROM tree) AND c.parent_id = p.id AND c.space_id = $2::uuid AND p.space_id <> $2::uuid AND c.hidden_at IS NULL
  RETURNING c.id`;

const CARRY_TRASH_SQL = `${CHAIN_TREE}
  UPDATE records r SET owner_id = $4::uuid, space_id = $5::uuid, purge_after = now() + make_interval(days => $6::int)
   WHERE r.id IN (SELECT id FROM tree) AND r.deleted_at IS NOT NULL AND r.hidden_at IS NULL AND r.space_id = $3::uuid AND r.owner_id = $2::uuid
  RETURNING r.id, r.space_id, r.purge_after`;

const trashDaysOf = (ctx: DbCtx): number => { const n = Math.round(Number(ctx.settings.get("access.trash_days", 30))); return Number.isFinite(n) && n >= 1 ? n : 30; };

type HandOp = "organizer_transfer" | "organizer_return";

type Step = { status: "moved"; ids: string[]; requests: number; fromSpace: string; toSpace: string; space: string; closeMove: string | null; detached: string[] }
  | { status: "busy" } | { status: "gone" } | { status: "skip" } | { status: "failed" } | { status: "unshared" };

interface Hand {
  op: HandOp;
  from: string;
  to: string;
  fromHome: string;
  toHome: { id: string; slug: string };
  attrs: (cur: Record<string, any> | null) => { set: Record<string, unknown>; drop?: string };
  recheck: (q: { query: DbCtx["db"]["control"]["query"] }) => Promise<boolean>;
  stillShared?: () => Promise<boolean>;
  carryTrashDays?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handRoot(ctx: DbCtx, root: Root, h: Hand): Promise<Step> {
  const db = recordsDb(ctx, root.cls);
  let planned = false;
  try {
    return await tx(ctx.db.control, async (q): Promise<Step> => {
      if (!(await q.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok", [`record:${root.id}`])).rows[0]?.ok) return { status: "busy" };
      if (!(await h.recheck(q))) return { status: "gone" };
      if (await treeMoving(q, ctx, root.cls, root.id)) return { status: "busy" };
      if (h.stillShared && !(await h.stillShared())) return { status: "unshared" };
      const rec = (await db.query("SELECT space_id, owner_id, attrs, deleted_at IS NOT NULL AS deleted, hidden_at IS NOT NULL AS hidden FROM records WHERE id = $1", [root.id])).rows[0];
      if (!rec || rec.deleted || rec.hidden || rec.owner_id !== h.from) return { status: "skip" };
      const closeMove = root.cls === "open" && (await despiteShown(q, [{ id: root.id, holder: h.to }])).size ? newId() : null;
      planned = !!closeMove;
      const mark = h.attrs(rec.attrs ?? null);
      const markSql = `UPDATE records SET attrs = (attrs${mark.drop ? " - $3::text" : ""}) || $2::jsonb WHERE id = $1`;
      const markParams = mark.drop ? [root.id, JSON.stringify(mark.set), mark.drop] : [root.id, JSON.stringify(mark.set)];
      let carried: Array<{ id: string; space_id: string; purge_after: Date }> = [];
      const records = async (c: { query: DbCtx["db"]["control"]["query"] }): Promise<string[]> => {
        await c.query(markSql, markParams);
        if (h.carryTrashDays !== undefined && UUID_RE.test(h.fromHome))
          carried = (await c.query(CARRY_TRASH_SQL, [root.id, h.from, h.fromHome, h.to, h.toHome.id, h.carryTrashDays])).rows;
        return UUID_RE.test(h.fromHome) ? (await c.query(DETACH_LEFT_SQL, [root.id, h.fromHome, h.op])).rows.map((r) => r.id as string) : [];
      };
      const control = async (c: { query: DbCtx["db"]["control"]["query"] }) => {
        for (const x of carried)
          await q.query("UPDATE record_locations SET owner_id = $2, space_id = $3, purge_after = $4, updated_at = now() WHERE record_id = $1", [x.id, h.to, x.space_id, x.purge_after]);
        if (closeMove) await c.query(`${CHAIN_TREE} UPDATE records SET hidden_at = now() WHERE id IN (SELECT id FROM tree) AND hidden_at IS NULL`, [root.id]);
        const requests = (await q.query("DELETE FROM deletion_requests WHERE record_id = $1 AND requester_id = $2 RETURNING id", [root.id, h.to])).rowCount ?? 0;
        if (closeMove) await q.query("INSERT INTO class_moves (id, record_id, from_class, to_class, requested_by, via) VALUES ($1, $2, 'open', 'closed', $3, 'organizer_transfer')",
                                     [closeMove, root.id, h.to]);
        return requests;
      };
      if (rec.space_id === h.fromHome) {
        const out = await spaceMove(q, db, { recordId: root.id, cls: root.cls, toSpaceId: h.toHome.id, actorId: null, authorId: h.from, op: "move_space", widen: false,
                                             onlyFrom: h.fromHome, reown: { from: h.from, to: h.to }, hiddenStay: true }, async (c) => {
          const detached = await records(c);
          return { requests: await control(c), detached };
        });
        if (out.status !== "moved") return { status: "skip" };
        return { status: "moved", ids: out.moved.map((m) => m.id), requests: out.extra.requests, fromSpace: h.fromHome, toSpace: h.toHome.slug, space: h.toHome.id, closeMove,
                 detached: out.extra.detached };
      }
      const done = await tx(db, async (c) => {
        const r = (await c.query("SELECT owner_id FROM records WHERE id = $1 FOR UPDATE", [root.id])).rows[0];
        if (!r || r.owner_id !== h.from) return null;
        await c.query("UPDATE records SET owner_id = $2 WHERE id = $1 AND owner_id = $3", [root.id, h.to, h.from]);
        const detached = await records(c);
        await q.query("UPDATE record_locations SET owner_id = $2, updated_at = now() WHERE record_id = $1 AND owner_id = $3", [root.id, h.to, h.from]);
        return { requests: await control(c), detached };
      });
      if (done === null) return { status: "skip" };
      const slug = (await q.query("SELECT slug FROM spaces WHERE id = $1", [rec.space_id])).rows[0]?.slug ?? null;
      return { status: "moved", ids: [root.id], requests: done.requests, fromSpace: rec.space_id, toSpace: slug, space: rec.space_id, closeMove, detached: done.detached };
    });
  } catch (e) {
    if (lockBusy(e) || (e instanceof MemoryError && e.code === "in_progress")) return { status: "busy" };
    await finishTail(ctx, root, h.from).catch((x) => log.warn("dismissed_meetings_tail_deferred", { record_id: root.id, error: (x as Error).message.slice(0, 120) }));
    if (planned) await closeShown(ctx, { id: root.id, holder: h.to }).catch(() => undefined);
    log.error("dismissed_meetings_failed", { record_id: root.id, error: (e as Error).message.slice(0, 200) });
    return { status: "failed" };
  }
}

async function detachedEvent(ctx: DbCtx, cls: DataClass, ids: string[], space: string, person: string, via: HandOp): Promise<void> {
  if (!ids.length) return;
  await auditWorker(ctx, { event_type: "processing", class: cls, record_ids: ids, space_id: space,
    details: { job: "dismissed_retention", op: "detached", via, person, detached: ids.length } });
}

async function alignLocators(ctx: DbCtx, root: Pick<Root, "id" | "cls">, from: string): Promise<Array<{ id: string; from_space: string }>> {
  const rows = (await recordsDb(ctx, root.cls).query(`${CHAIN_TREE} SELECT r.id, r.owner_id, r.space_id, r.purge_after FROM records r WHERE r.id IN (SELECT id FROM tree) AND r.owner_id <> $2`,
                                                     [root.id, from])).rows;
  if (!rows.length) return [];
  const stale = new Map((await ctx.db.control.query("SELECT record_id, space_id FROM record_locations WHERE record_id = ANY($1::uuid[]) AND owner_id = $2",
                                                    [rows.map((r) => r.id), from])).rows.map((r) => [r.record_id as string, r.space_id as string]));
  const fixed: Array<{ id: string; from_space: string }> = [];
  for (const r of rows.filter((x) => stale.has(x.id)))
    if ((await ctx.db.control.query("UPDATE record_locations SET owner_id = $2, space_id = $3, purge_after = $5, updated_at = now() WHERE record_id = $1 AND owner_id = $4",
                                    [r.id, r.owner_id, r.space_id, from, r.purge_after ?? null])).rowCount) fixed.push({ id: r.id, from_space: stale.get(r.id)! });
  return fixed;
}

async function finishTail(ctx: DbCtx, root: Pick<Root, "id" | "cls">, from: string): Promise<number> {
  const aligned = await alignLocators(ctx, root, from);
  const top = aligned.find((a) => a.id === root.id);
  if (!top) return aligned.length;
  const r = (await recordsDb(ctx, root.cls).query("SELECT owner_id, space_id, attrs FROM records WHERE id = $1", [root.id])).rows[0];
  const ot = r?.attrs?.organizer_transfer, back = r?.attrs?.organizer_return;
  const op: HandOp | null = !r ? null : ot?.to === r.owner_id && ot?.from === from ? "organizer_transfer"
    : back?.to === r.owner_id && back?.from === from ? "organizer_return" : null;
  if (!op) return aligned.length;
  const to = r.owner_id as string;
  const requests = (await ctx.db.control.query("DELETE FROM deletion_requests WHERE record_id = $1 AND requester_id = $2 RETURNING id", [root.id, to])).rowCount ?? 0;
  const slug = (await ctx.db.control.query("SELECT slug FROM spaces WHERE id = $1", [r.space_id])).rows[0]?.slug ?? null;
  await auditWorker(ctx, { event_type: "promote", class: root.cls, record_ids: aligned.map((a) => a.id), space_id: r.space_id,
    details: { job: "dismissed_retention", op, by: "auto", from_person: from, to_person: to, author: op === "organizer_transfer" ? to : from,
               ...(op === "organizer_return" ? { reason: back.reason ?? null, ...(back.trashed === true ? { trashed: true } : {}) } : {}), from_space: top.from_space, to_space: slug,
               requests_closed: requests, repaired: true } });
  const home = await homeOf(ctx, from), at = (op === "organizer_transfer" ? ot?.at : back?.at) ?? null;
  if (home) {
    const left = (await recordsDb(ctx, root.cls).query(
      `SELECT id FROM records WHERE space_id = $1 AND attrs->'detached_from'->>'record_id' = $2 AND attrs->'detached_from'->>'reason' = $3
          AND ($4::timestamptz IS NULL OR (attrs->'detached_from'->>'at')::timestamptz >= $4::timestamptz - interval '1 minute') ORDER BY id`,
      [home.id, root.id, op, typeof at === "string" && Number.isFinite(Date.parse(at)) ? at : null])).rows.map((x) => x.id as string);
    await detachedEvent(ctx, root.cls, left, home.id, from, op);
  }
  log.warn("dismissed_meetings_tail_repaired", { record_id: root.id, op });
  return aligned.length;
}

async function returnTails(ctx: DbCtx): Promise<number> {
  let fixed = 0;
  for (const cls of CLASSES)
    for (const r of (await recordsDb(ctx, cls).query(
      `SELECT id, attrs->'organizer_return'->>'from' AS w FROM records
        WHERE attrs ? 'organizer_return' AND parent_id IS NULL AND owner_id::text <> COALESCE(attrs->'organizer_return'->>'from', owner_id::text)`)).rows)
      fixed += await finishTail(ctx, { id: r.id, cls }, r.w);
  return fixed;
}

async function fixTails(ctx: DbCtx, person: string): Promise<number> {
  const locs = (await ctx.db.control.query("SELECT record_id, class FROM record_locations WHERE owner_id = $1 AND NOT deleted", [person])).rows;
  let fixed = 0;
  for (const cls of CLASSES) {
    const ids = locs.filter((l) => l.class === cls).map((l) => l.record_id as string);
    if (!ids.length) continue;
    const roots = (await recordsDb(ctx, cls).query(
      `WITH RECURSIVE up AS (
         SELECT r.id AS aid, r.parent_id, r.attrs FROM records r WHERE r.id = ANY($1::uuid[]) AND r.owner_id <> $2
         UNION SELECT a.id, a.parent_id, a.attrs FROM up u JOIN records a ON a.id = u.parent_id)
       SELECT DISTINCT aid FROM up
        WHERE parent_id IS NULL AND $2::text IN (attrs->'organizer_transfer'->>'from', attrs->'organizer_return'->>'from') ORDER BY aid`, [ids, person])).rows;
    for (const r of roots) fixed += await finishTail(ctx, { id: r.aid, cls }, person);
  }
  return fixed;
}

const homeOf = async (ctx: DbCtx, person: string): Promise<{ id: string; slug: string } | null> =>
  (await ctx.db.control.query("SELECT id, slug FROM spaces WHERE kind = 'personal' AND owner_id = $1", [person])).rows[0] ?? null;

async function kickClose(ctx: DbCtx, moveId: string): Promise<void> {
  if (typeof (ctx as Partial<Ctx>).s3 !== "function") return;
  const { moveClass } = await import("./maintenance.ts");
  await moveClass(ctx as Ctx, moveId).catch((e) => log.warn("dismissed_meetings_close_failed", { move_id: moveId, error: (e as Error).message.slice(0, 200) }));
}

async function closeEvent(ctx: DbCtx, rootId: string, moveId: string, spaceId: string | null, author: string, repaired = false): Promise<void> {
  await auditWorker(ctx, { event_type: "class_move", class: "open", record_ids: [rootId], space_id: spaceId,
    details: { job: "dismissed_retention", op: "close", move_id: moveId, via: "organizer_transfer", by: "auto", author, ...(repaired ? { repaired: true } : {}) } });
  await kickClose(ctx, moveId);
}

async function closeShown(ctx: DbCtx, r: { id: string; holder: string; since?: string | null }): Promise<string | null> {
  const open = recordsDb(ctx, "open");
  const got = await tx(ctx.db.control, async (q) => {
    if (!(await q.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok", [`record:${r.id}`])).rows[0]?.ok) return null;
    const cur = (await open.query("SELECT owner_id, space_id, deleted_at IS NOT NULL AS deleted FROM records WHERE id = $1", [r.id])).rows[0];
    if (!cur || cur.deleted || cur.owner_id !== r.holder) return null;
    if (await treeMoving(q, ctx, "open", r.id)) return null;
    if (!(await despiteShown(q, [r])).size) return null;
    const moveId = newId();
    await q.query("INSERT INTO class_moves (id, record_id, from_class, to_class, requested_by, via) VALUES ($1, $2, 'open', 'closed', $3, 'organizer_transfer')", [moveId, r.id, r.holder]);
    return { moveId, space: cur.space_id as string };
  });
  if (!got) return null;
  await open.query(`${CHAIN_TREE} UPDATE records SET hidden_at = now() WHERE id IN (SELECT id FROM tree) AND hidden_at IS NULL`, [r.id])
    .catch((e) => log.warn("dismissed_meetings_close_hide_deferred", { record_id: r.id, error: (e as Error).message.slice(0, 120) }));
  await closeEvent(ctx, r.id, got.moveId, got.space, r.holder, true);
  return got.moveId;
}

async function closeLeftovers(ctx: DbCtx): Promise<number> {
  const open = recordsDb(ctx, "open");
  const pick = async (mark: HandOp) => (await open.query(
    `SELECT id, owner_id, attrs->'${mark}'->>'at' AS since FROM records
      WHERE attrs ? '${mark}' AND parent_id IS NULL AND deleted_at IS NULL AND owner_id::text = attrs->'${mark}'->>'to'`)).rows;
  const byId = new Map<string, { id: string; holder: string; since: string | null }>();
  for (const r of [...await pick("organizer_transfer"), ...await pick("organizer_return")])
    if (!byId.has(r.id)) byId.set(r.id, { id: r.id as string, holder: r.owner_id as string, since: (r.since ?? null) as string | null });
  const all = [...byId.values()];
  const due = await despiteShown(ctx.db.control, all);
  let n = 0;
  for (const r of all) if (due.has(r.id) && await closeShown(ctx, r).catch(() => null)) n++;
  if (n) log.warn("dismissed_meetings_close_repaired", { roots: n });
  return n;
}

interface CustodyRow {
  person_id: string; space_id: string; custodian_id: string | null; basis: string;
  meetings_waiting: number; busy_passes: number; meetings_conflicts: number; due: boolean;
  archived: string | null;
}

const activePerson = async (ctx: DbCtx, id: string): Promise<boolean> =>
  !!(await ctx.db.control.query(`SELECT 1 FROM people p WHERE p.id = $1 AND p.instance_id = $2 AND p.active AND NOT ${showcaseSql("p")}`, [id, ctx.instanceId])).rowCount;

async function transferPerson(ctx: DbCtx, r: CustodyRow): Promise<{ moved: number; busy: boolean; conflicts: number; gone: boolean; roots: number }> {
  const P = r.person_id, C = r.custodian_id!;
  const res = { moved: 0, busy: false, conflicts: 0, gone: false, roots: 0 };
  const fams = await meetingFamilies(ctx, P);
  const homes = new Map<string, { id: string; slug: string } | null>();
  const home = async (who: string) => { if (!homes.has(who)) homes.set(who, await homeOf(ctx, who)); return homes.get(who)!; };
  if (!(await home(C))) { log.warn("dismissed_meetings_no_home", { space_id: r.space_id }); return res; }
  const refs = [...new Set([...fams.values()].flatMap((f) => f.map((x) => x.source_ref)).filter((x): x is string => !!x))];
  const origins = [...new Set([P, ...[...fams.values()].flatMap((f) => f.map((x) => x.origin ?? P))])];
  const clash = await custodianConflicts(ctx, C, P, refs, origins);
  let waiting = 0;
  for (const roots of fams.values()) {
    const ref = roots[0]!.source_ref, origin = roots[0]!.origin ?? P;
    let to = C, basis = r.basis, started = false;
    if (ref) {
      const holders = await familyHolders(ctx, ref, origin, P);
      if (holders.size > 1) { waiting++; res.conflicts++; log.warn("dismissed_meetings_split", { space_id: r.space_id }); continue; }
      const [held] = [...holders];
      started = !!held;
      if (held && held[0] !== C) {
        if (!(await activePerson(ctx, held[0])) || !(await home(held[0]))) { waiting++; res.busy = true; continue; }
        to = held[0]; basis = held[1] ?? r.basis;
        if ((await custodianConflicts(ctx, to, P, [ref], origins)).size) { waiting++; res.conflicts++; continue; }
      } else if (clash.has(ref)) { waiting++; res.conflicts++; continue; }
    }
    const toHome = (await home(to))!;
    let famBusy = false, unshared = false;
    for (const root of roots) {
      const out = await handRoot(ctx, root, {
        op: "organizer_transfer", from: P, to, fromHome: r.space_id, toHome,
        attrs: (cur) => ({ set: { organizer_transfer: { from: P, to, origin: cur?.organizer_transfer?.to === P && cur.organizer_transfer.origin ? cur.organizer_transfer.origin : P,
                                                        at: new Date().toISOString(), basis } } }),
        recheck: async (q) => {
          if (!r.archived || !(await q.query(TRANSFER_STILL_DUE_SQL, [P, r.space_id, r.archived, await afterDaysNow(q, ctx.instanceId)])).rowCount) return false;
          if ((await q.query("SELECT custodian_id FROM personal_custody WHERE person_id = $1 FOR SHARE NOWAIT", [P])).rows[0]?.custodian_id !== C) return false;
          if (!(await q.query("SELECT 1 FROM people WHERE id = $1 AND active FOR SHARE NOWAIT", [to])).rowCount) return false;
          return (await meetingsNow(q, ctx.instanceId)) === "transfer";
        },
        ...(started ? {} : { stillShared: () => familyShared(ctx, P, root) }),
      });
      if (out.status === "unshared") { unshared = true; break; }
      if (out.status === "failed") { famBusy = true; continue; }
      if (out.status === "gone") { res.gone = true; log.info("dismissed_meetings_gone", { space_id: r.space_id }); return res; }
      if (out.status === "busy") { famBusy = true; continue; }
      if (out.status !== "moved") continue;
      started = true;
      res.moved++; res.roots += out.ids.length;
      await auditWorker(ctx, { event_type: "promote", class: root.cls, record_ids: out.ids, space_id: out.space,
        details: { job: "dismissed_retention", op: "organizer_transfer", by: "auto", from_person: P, to_person: to, author: to, from_space: out.fromSpace, to_space: out.toSpace,
                   requests_closed: out.requests } });
      await detachedEvent(ctx, root.cls, out.detached, r.space_id, P, "organizer_transfer");
      if (out.closeMove) await closeEvent(ctx, root.id, out.closeMove, out.space, to);
    }
    if (unshared) { log.info("dismissed_meetings_unshared", { space_id: r.space_id }); continue; }
    if (famBusy) { res.busy = true; waiting++; }
  }
  if (res.conflicts) log.info("dismissed_meetings_conflict", { space_id: r.space_id });
  const passes = res.busy ? r.busy_passes + 1 : 0;
  if (waiting !== r.meetings_waiting || passes !== r.busy_passes || res.conflicts !== r.meetings_conflicts)
    await ctx.db.control.query("UPDATE personal_custody SET meetings_waiting = $2, busy_passes = $3, meetings_conflicts = $4 WHERE person_id = $1", [P, waiting, passes, res.conflicts]);
  if (res.busy) log.warn("dismissed_meetings_busy", { space_id: r.space_id, passes });
  return res;
}

async function returnTrashed(ctx: DbCtx, root: { id: string; cls: DataClass }, h: { from: string; to: string; fromHome: string; toHome: { id: string; slug: string };
  reason: "reactivated" | "wait"; recheck: (q: { query: DbCtx["db"]["control"]["query"] }) => Promise<boolean> }): Promise<Step> {
  const db = recordsDb(ctx, root.cls), days = trashDaysOf(ctx);
  try {
    return await tx(ctx.db.control, async (q): Promise<Step> => {
      if (!(await q.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok", [`record:${root.id}`])).rows[0]?.ok) return { status: "busy" };
      if (!(await h.recheck(q))) return { status: "gone" };
      if (await treeMoving(q, ctx, root.cls, root.id)) return { status: "busy" };
      const done = await tx(db, async (c) => {
        const rec = (await c.query("SELECT owner_id, space_id, attrs, deleted_at IS NOT NULL AS deleted, hidden_at IS NOT NULL AS hidden FROM records WHERE id = $1 FOR UPDATE",
                                   [root.id])).rows[0];
        if (!rec || !rec.deleted || rec.hidden || rec.owner_id !== h.from || rec.attrs?.organizer_transfer?.origin !== h.to) return null;
        const home = UUID_RE.test(h.fromHome) ? h.fromHome : null;
        const rows = (await c.query(
          `${CHAIN_TREE}
           UPDATE records r SET owner_id = $2::uuid, space_id = CASE WHEN r.space_id = $3::uuid THEN $4::uuid ELSE r.space_id END,
                  purge_after = now() + make_interval(days => $5::int)
            WHERE r.id IN (SELECT id FROM tree) AND r.deleted_at IS NOT NULL AND r.hidden_at IS NULL AND r.owner_id = $6::uuid
           RETURNING r.id, r.space_id, r.purge_after`, [root.id, h.to, home, h.toHome.id, days, h.from])).rows as Array<{ id: string; space_id: string; purge_after: Date }>;
        await c.query("UPDATE records SET attrs = (attrs - 'organizer_transfer') || $2::jsonb WHERE id = $1",
                      [root.id, JSON.stringify({ organizer_return: { from: h.from, to: h.to, at: new Date().toISOString(), reason: h.reason, trashed: true } })]);
        return { rows, fromSpace: rec.space_id as string };
      });
      if (!done) return { status: "skip" };
      for (const x of done.rows)
        await q.query("UPDATE record_locations SET owner_id = $2, space_id = $3, purge_after = $4, updated_at = now() WHERE record_id = $1", [x.id, h.to, x.space_id, x.purge_after]);
      const requests = (await q.query("DELETE FROM deletion_requests WHERE record_id = $1 AND requester_id = $2 RETURNING id", [root.id, h.to])).rowCount ?? 0;
      const space = done.rows.find((x) => x.id === root.id)?.space_id ?? done.fromSpace;
      const slug = (await q.query("SELECT slug FROM spaces WHERE id = $1", [space])).rows[0]?.slug ?? null;
      return { status: "moved", ids: done.rows.map((x) => x.id), requests, fromSpace: done.fromSpace, toSpace: slug, space, closeMove: null, detached: [] };
    });
  } catch (e) {
    if (lockBusy(e) || (e instanceof MemoryError && e.code === "in_progress")) return { status: "busy" };
    await finishTail(ctx, root, h.from).catch((x) => log.warn("dismissed_meetings_tail_deferred", { record_id: root.id, error: (x as Error).message.slice(0, 120) }));
    log.error("dismissed_meetings_failed", { record_id: root.id, error: (e as Error).message.slice(0, 200) });
    return { status: "failed" };
  }
}

async function returnMeetings(ctx: DbCtx, policy: CustodyPolicy): Promise<{ roots: number; people: number; busy: number }> {
  const res = { roots: 0, people: 0, busy: 0 };
  const origins = new Set<string>();
  for (const cls of CLASSES)
    for (const r of (await recordsDb(ctx, cls).query(
      `SELECT DISTINCT attrs->'organizer_transfer'->>'origin' AS o FROM records
        WHERE attrs ? 'organizer_transfer' AND parent_id IS NULL AND hidden_at IS NULL`)).rows) if (r.o) origins.add(r.o);
  if (!origins.size) return res;
  const reasonOf = new Map<string, "reactivated" | "wait">();
  for (const p of (await ctx.db.control.query(`SELECT p.id, p.active FROM people p WHERE p.id::text = ANY($1::text[]) AND p.instance_id = $2 AND NOT ${showcaseSql("p")}`,
                                              [[...origins], ctx.instanceId])).rows) {
    if (p.active) reasonOf.set(p.id, "reactivated");
    else if (policy.meetings === "wait") reasonOf.set(p.id, "wait");
  }
  if (!reasonOf.size) return res;
  const back = new Set<string>();
  for (const cls of CLASSES) {
    const rows = (await recordsDb(ctx, cls).query(
      `SELECT id, owner_id, space_id, attrs->'organizer_transfer' AS ot, deleted_at IS NOT NULL AS deleted FROM records
        WHERE attrs ? 'organizer_transfer' AND (attrs->'organizer_transfer'->>'origin') = ANY($1::text[])
          AND parent_id IS NULL AND hidden_at IS NULL ORDER BY id`, [[...reasonOf.keys()]])).rows;
    for (const r of rows) {
      const O = r.ot?.origin as string, W = r.ot?.to as string, reason = reasonOf.get(O)!;
      if (!W || r.owner_id !== W) continue;
      const [fromHome, toHome] = [await homeOf(ctx, W), await homeOf(ctx, O)];
      if (!toHome) continue;
      const recheck = async (q: { query: DbCtx["db"]["control"]["query"] }) => {
        const o = (await q.query("SELECT active FROM people WHERE id = $1 FOR SHARE NOWAIT", [O])).rows[0];
        if (!o) return false;
        return reason === "reactivated" ? o.active === true : !o.active && (await meetingsNow(q, ctx.instanceId)) === "wait";
      };
      const out = r.deleted
        ? await returnTrashed(ctx, { id: r.id, cls }, { from: W, to: O, fromHome: fromHome?.id ?? "", toHome, reason, recheck })
        : await handRoot(ctx, { id: r.id, cls, source_ref: null, space_id: r.space_id }, {
          op: "organizer_return", from: W, to: O, fromHome: fromHome?.id ?? "", toHome, carryTrashDays: trashDaysOf(ctx),
          attrs: () => ({ set: { organizer_return: { from: W, to: O, at: new Date().toISOString(), reason } }, drop: "organizer_transfer" }),
          recheck,
        });
      if (out.status === "busy" || out.status === "failed") { res.busy++; continue; }
      if (out.status !== "moved") continue;
      res.roots++; back.add(O);
      await auditWorker(ctx, { event_type: "promote", class: cls, record_ids: out.ids, space_id: out.space,
        details: { job: "dismissed_retention", op: "organizer_return", by: "auto", from_person: W, to_person: O, author: W, reason, from_space: out.fromSpace, to_space: out.toSpace,
                   requests_closed: out.requests, ...(r.deleted ? { trashed: true } : {}) } });
      if (fromHome) await detachedEvent(ctx, cls, out.detached, fromHome.id, W, "organizer_return");
      if (out.closeMove) await closeEvent(ctx, r.id, out.closeMove, out.space, O);
    }
  }
  res.people = back.size;
  return res;
}

export async function dismissedMeetings(ctx: DbCtx, policy: CustodyPolicy, alive?: () => Promise<void>): Promise<MeetingsPassResult> {
  const res = { ...EMPTY_MEETINGS };
  const rows = (await ctx.db.control.query(
    `SELECT pc.person_id, pc.space_id, pc.custodian_id, pc.basis, pc.meetings_waiting, pc.busy_passes, pc.meetings_conflicts,
            COALESCE(s.archived_at <= now() - make_interval(days => $2::int) AND ${custodyCurrentSql("pc", "s")}, false) AS due,
            s.archived_at::text AS archived
       FROM personal_custody pc JOIN spaces s ON s.id = pc.space_id JOIN people p ON p.id = pc.person_id AND NOT p.active
      WHERE pc.instance_id = $1 ORDER BY pc.space_id`, [ctx.instanceId, policy.afterDays])).rows as CustodyRow[];
  for (const r of rows) {
    if (alive) await alive();
    res.tails += await fixTails(ctx, r.person_id);
  }
  if (alive) await alive();
  res.tails += await returnTails(ctx);
  if (res.tails) log.info("dismissed_meetings_tail_fixed", { records: res.tails });
  if (alive) await alive();
  const back = await returnMeetings(ctx, policy);
  res.returned = back.roots; res.busy += back.busy;
  if (back.roots) log.info("dismissed_meetings_returned", { people: back.people, roots: back.roots });
  let people = 0, roots = 0;
  for (const r of rows) {
    if (alive) await alive();
    if (policy.meetings !== "transfer" || !r.custodian_id || !r.due) {
      if (r.meetings_waiting || r.busy_passes || r.meetings_conflicts)
        await ctx.db.control.query("UPDATE personal_custody SET meetings_waiting = 0, busy_passes = 0, meetings_conflicts = 0 WHERE person_id = $1", [r.person_id]);
      continue;
    }
    const out = await transferPerson(ctx, r);
    res.moved += out.moved; res.conflicts += out.conflicts; res.busy += out.busy ? 1 : 0;
    if (out.moved) { people++; roots += out.roots; }
  }
  if (people) log.info("dismissed_meetings_moved", { people, roots });
  if (alive) await alive();
  res.closed = await closeLeftovers(ctx);
  return res;
}

export interface PreviewAssume { personal?: CustodyPolicy["personal"]; meetings?: CustodyPolicy["meetings"]; afterDays?: number; retentionDays?: number }

export function previewAssume(args: readonly string[]): PreviewAssume {
  const out: PreviewAssume = {};
  const int = (flag: string, v: string | undefined, [lo, hi]: readonly [number, number]): number => {
    const n = Number(v);
    if (v === undefined || !/^\d+$/.test(v) || n < lo || n > hi) throw new Error(`dismissed_retention_preview: ${flag} must be an integer from ${lo} to ${hi}`);
    return n;
  };
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], v = args[i + 1];
    if (flag === "--meetings" && (CUSTODY_MEETINGS as readonly unknown[]).includes(v)) out.meetings = v as CustodyPolicy["meetings"];
    else if (flag === "--personal" && (CUSTODY_PERSONAL as readonly unknown[]).includes(v)) out.personal = v as CustodyPolicy["personal"];
    else if (flag === "--after-days") out.afterDays = int(flag, v, CUSTODY_AFTER_DAYS);
    else if (flag === "--retention-days") out.retentionDays = int(flag, v, [0, 3650]);
    else throw new Error(`dismissed_retention_preview: unknown flag or value “${[flag, v].filter((x) => x !== undefined).join(" ")}”; `
                         + `available options: --meetings transfer|wait, --personal keep|delete, --after-days 0–90, --retention-days 0–3650`);
  }
  return out;
}

export async function dismissedPreview(ctx: DbCtx, assume: PreviewAssume = {}): Promise<Record<string, unknown>> {
  await ctx.settings.load(true);
  const base = custodyPolicy(ctx.settings);
  const policy: CustodyPolicy = { ...base, ...assume };
  const c = await ctx.db.control.connect();
  const custody: Array<Record<string, unknown>> = [], meetings: Array<Record<string, unknown>> = [];
  try {
    await c.query("BEGIN");
    if (!(await tryLockCustody(c, ctx.instanceId)))
      return { busy: "an org table upload or custodian assignment is in progress. Retry the preview in a minute" };
    const before = new Set((await c.query("SELECT person_id FROM personal_custody WHERE instance_id = $1", [ctx.instanceId])).rows.map((r) => r.person_id as string));
    await syncCustody(c, ctx.instanceId, policy, { all: true });
    const rows = (await c.query(
      `SELECT pc.person_id, pc.custodian_id, pc.basis, pc.levels, p.login, k.login AS custodian_login,
              COALESCE(s.archived_at <= now() - make_interval(days => $2::int), false) AS due
         FROM personal_custody pc JOIN people p ON p.id = pc.person_id JOIN spaces s ON s.id = pc.space_id LEFT JOIN people k ON k.id = pc.custodian_id
        WHERE pc.instance_id = $1 AND NOT p.active ORDER BY p.login`, [ctx.instanceId, policy.afterDays])).rows;
    for (const r of rows) {
      custody.push({ login: r.login, custodian_login: r.custodian_login ?? null, basis: r.basis, levels: r.levels, has_row: before.has(r.person_id) });
      if (policy.meetings !== "transfer" || !r.custodian_id || !r.due) continue;
      const fams = await meetingFamilies(ctx, r.person_id);
      if (!fams.size) continue;
      const refs = [...new Set([...fams.values()].flatMap((f) => f.map((x) => x.source_ref)).filter((x): x is string => !!x))];
      const origins = [...new Set([r.person_id, ...[...fams.values()].flatMap((f) => f.map((x) => x.origin ?? r.person_id))])];
      const clash = await custodianConflicts(ctx, r.custodian_id, r.person_id, refs, origins);
      let roots = 0, conflicts = 0, busy = 0;
      for (const f of fams.values()) {
        if (f[0]!.source_ref && clash.has(f[0]!.source_ref)) { conflicts++; continue; }
        roots += f.length;
        for (const x of f) if (await treeMoving(c, ctx, x.cls, x.id)) { busy++; break; }
      }
      meetings.push({ login: r.login, to_login: r.custodian_login, families: fams.size, roots, conflicts, busy });
    }
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    c.release();
  }
  const returns: Array<Record<string, unknown>> = [];
  const byOrigin = new Map<string, number>(), trashOf = new Map<string, number>();
  for (const cls of CLASSES)
    for (const r of (await recordsDb(ctx, cls).query(
      `SELECT attrs->'organizer_transfer'->>'origin' AS o, deleted_at IS NOT NULL AS deleted, count(*)::int AS n FROM records
        WHERE attrs ? 'organizer_transfer' AND parent_id IS NULL AND hidden_at IS NULL
          AND owner_id::text = attrs->'organizer_transfer'->>'to' GROUP BY 1, 2`)).rows) {
      if (!r.o) continue;
      const m = r.deleted ? trashOf : byOrigin;
      m.set(r.o, (m.get(r.o) ?? 0) + r.n);
    }
  const origins = [...new Set([...byOrigin.keys(), ...trashOf.keys()])];
  const held = new Set(await heldOrigins(ctx.db.control, ctx.instanceId, policy));
  const trash = { held: 0, returning: 0 };
  if (origins.length)
    for (const p of (await ctx.db.control.query(`SELECT p.id, p.login, p.active FROM people p WHERE p.id::text = ANY($1::text[]) AND p.instance_id = $2 ORDER BY p.login`,
                                                [origins, ctx.instanceId])).rows) {
      const back = p.active || policy.meetings === "wait";
      if (held.has(p.id) && !p.active) trash.held += trashOf.get(p.id) ?? 0;
      if (back) trash.returning += trashOf.get(p.id) ?? 0;
      if (back) returns.push({ login: p.login, roots: byOrigin.get(p.id) ?? 0, trashed: trashOf.get(p.id) ?? 0, reason: p.active ? "reactivated" : "wait" });
    }
  const days = assume.retentionDays ?? Number(ctx.settings.get("access.dismissed_retention_days", 90));
  let del = { people: 0, records: 0 };
  if (Number.isFinite(days) && days > 0) {
    const due = (await ctx.db.control.query(dismissedDueSql(policy), [ctx.instanceId, days])).rows as Array<{ space_id: string }>;
    const n = due.length ? (await ctx.db.control.query("SELECT count(*)::int AS n FROM record_locations WHERE space_id = ANY($1::uuid[]) AND NOT deleted",
                                                      [due.map((d) => d.space_id)])).rows[0].n as number : 0;
    del = { people: due.length, records: n };
  }
  const assumed = Object.keys(assume).length
    ? Object.fromEntries(Object.entries({ personal: assume.personal, meetings: assume.meetings, after_days: assume.afterDays, retention_days: assume.retentionDays })
        .filter(([, v]) => v !== undefined))
    : null;
  return { policy: { personal: policy.personal, meetings: policy.meetings, after_days: policy.afterDays, test_too: policy.testToo, retention_days: Number.isFinite(days) ? days : null },
           assumed, custody, meetings, returns, held_transferred: trash, delete: del };
}

export async function custodyAfterDelete(ctx: DbCtx, d: { person_id: string; space_id: string }, alive?: () => Promise<void>): Promise<void> {
  const left = (await ctx.db.control.query(`SELECT ${custodyDataSql("$1::uuid", "$2::uuid", true)} AS has`, [d.person_id, d.space_id])).rows[0]?.has === true;
  if (left) return;
  if (alive) await alive();
  const gone = (await ctx.db.control.query("DELETE FROM personal_custody WHERE space_id = $1 RETURNING person_id, space_id, custodian_id", [d.space_id])).rows[0];
  if (gone) await custodyEvent(ctx, { person: gone.person_id, space: gone.space_id, from: gone.custodian_id ?? null, to: null, basis: null, levels: 0, reason: "deleted" });
}

export interface NotifyPassResult { sent: number; skipped?: "off" | "smtp_disabled" }
export const EMPTY_NOTIFY: NotifyPassResult = { sent: 0 };

async function movedFamilies(ctx: DbCtx, custodian: string, person: string): Promise<number> {
  const fams = new Set<string>();
  for (const cls of ["open", "closed"] as DataClass[])
    for (const r of (await recordsDb(ctx, cls).query(
      `SELECT DISTINCT COALESCE(source_ref, id::text) AS fam FROM records
        WHERE owner_id = $1 AND parent_id IS NULL AND is_current AND deleted_at IS NULL AND attrs->'organizer_transfer'->>'from' = $2::text`, [custodian, person])).rows)
      fams.add(r.fam as string);
  return fams.size;
}

export async function dismissedNotify(ctx: DbCtx, policy: CustodyPolicy, alive?: () => Promise<void>): Promise<NotifyPassResult> {
  const res: NotifyPassResult = { ...EMPTY_NOTIFY };
  if (policy.read === "off") return { ...res, skipped: "off" };
  if (!smtpConfig(ctx.settings).enabled) return { ...res, skipped: "smtp_disabled" };
  const base = String(ctx.settings.get<string>("access.workplace_url", "") ?? "").trim().replace(/\/+$/, "") || null;
  const rows = (await ctx.db.control.query(
    `SELECT pc.space_id, pc.person_id, pc.custodian_id, pc.notified_id, pc.basis, s.slug, s.archived_at, p.login, p.display_name,
            k.login AS c_login, k.active AS c_active, ${showcaseSql("k")} AS c_demo
       FROM personal_custody pc
       JOIN people p ON p.id = pc.person_id AND NOT p.active
       JOIN spaces s ON s.id = pc.space_id AND s.kind = 'personal' AND s.owner_id = p.id
       JOIN people k ON k.id = pc.custodian_id
      WHERE pc.instance_id = $1 AND pc.custodian_id IS NOT NULL AND pc.custodian_id IS DISTINCT FROM pc.notified_id AND NOT ${showcaseSql("p")}
        AND s.archived_at IS NOT NULL AND s.archived_at <= now() - make_interval(days => $2::int) AND ${custodyCurrentSql("pc", "s")}
      ORDER BY pc.space_id`, [ctx.instanceId, policy.afterDays])).rows;
  for (const r of rows) {
    if (!custodyMailable({ active: r.c_active, demo: r.c_demo, login: r.c_login })) continue;
    const name = (r.display_name as string | null) || (r.login as string);
    const mail = custodyMail({ name, basis: r.basis as CustodyBasis, link: base ? `${base}/custody/${r.slug}` : null, meetings: await movedFamilies(ctx, r.custodian_id, r.person_id) });
    if (alive) await alive();
    const out = await enqueueMail(ctx.db.control, ctx.instanceId, { kind: "custody", to: r.c_login, ...mail,
                                                                   dedupeKey: `custody:${r.space_id}:${r.custodian_id}:${new Date(r.archived_at).toISOString()}`,
                                                                   createdBy: "workers:dismissed_retention" });
    if (out.created) res.sent++;
    else if ((await ctx.db.control.query(
      `UPDATE mail_outbox SET status = 'pending', attempts = 0, next_attempt_at = now(), subject = $3, body_text = $4, to_address = $6, last_error_code = NULL,
              last_error = NULL, updated_at = now()
        WHERE id = $1 AND instance_id = $2 AND status = 'cancelled' AND last_error_code = $5`,
      [out.id, ctx.instanceId, mail.subject.replace(/[\r\n]+/g, " ").slice(0, 250), mail.text, CUSTODY_MAIL_STALE, String(r.c_login).toLowerCase()])).rowCount) res.sent++;
    await ctx.db.control.query(
      "UPDATE personal_custody SET notified_id = custodian_id WHERE space_id = $1 AND custodian_id = $2 AND notified_id IS NOT DISTINCT FROM $3",
      [r.space_id, r.custodian_id, r.notified_id ?? null]);
  }
  if (res.sent) log.info("dismissed_custody_notified", { sent: res.sent });
  return res;
}
