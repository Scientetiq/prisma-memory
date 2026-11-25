// Link and quote upkeep. The control DB keeps the graph; records DBs only the details of their own class.
import type pg from "pg";
import { chainLinkSql, log, tx, type DataClass } from "@memory/shared";
import { auditWorker, recordsDb, type DbCtx } from "../ctx.ts";

interface LinkState { id: string; src_id: string; dst_id: string; src_class: DataClass; dst_class: DataClass; detail_class: DataClass;
                     relation?: string; status?: string; decided_by?: string | null }
interface Detail { link_id: string; class: DataClass; src_quote: string | null; dst_quote: string | null; rationale: string | null; created_at: Date }
export interface CopiedLinkDetails { copied: string[]; inserted: string[] }
const detailColumns = "link_id, class, src_quote, dst_quote, rationale, created_at";

async function insertClosed(c: Pick<pg.PoolClient, "query">, d: Detail): Promise<boolean> {
  return Boolean((await c.query(
    `INSERT INTO record_link_details (link_id, class, src_quote, dst_quote, rationale, created_at)
     VALUES ($1,'closed',$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING link_id`,
    [d.link_id, d.src_quote, d.dst_quote, d.rationale, d.created_at])).rowCount);
}

/** Called right after the row copy, before the row count check, also on a retry without a source. */
export async function copyLinkDetailsForClose(ctx: DbCtx, ids: string[]): Promise<CopiedLinkDetails> {
  if (!ids.length) return { copied: [], inserted: [] };
  const links = (await ctx.db.control.query("SELECT id FROM record_links WHERE src_id = ANY($1::uuid[]) OR dst_id = ANY($1::uuid[])", [ids])).rows.map((r) => r.id as string);
  if (!links.length) return { copied: [], inserted: [] };
  const details = (await recordsDb(ctx, "open").query(`SELECT ${detailColumns} FROM record_link_details WHERE link_id = ANY($1::uuid[])`, [links])).rows as Detail[];
  return tx(recordsDb(ctx, "closed"), async (c) => {
    const inserted: string[] = [];
    for (const row of details) if (await insertClosed(c, row)) inserted.push(row.link_id);
    const copied = (await c.query("SELECT link_id FROM record_link_details WHERE link_id = ANY($1::uuid[])", [links])).rows.map((r) => r.link_id as string);
    const found = new Set(copied);
    if (details.some((d) => !found.has(d.link_id))) throw new Error("link_details_copy_missing");
    return { copied, inserted };
  });
}

/** Same control transaction, right after the whole tree's locators switch. */
export async function switchLinkClasses(c: Pick<pg.PoolClient, "query">, ids: string[], to: DataClass): Promise<number> {
  if (!ids.length) return 0;
  return (await c.query(
    `UPDATE record_links SET src_class = CASE WHEN src_id = ANY($1::uuid[]) THEN $2 ELSE src_class END,
      dst_class = CASE WHEN dst_id = ANY($1::uuid[]) THEN $2 ELSE dst_class END,
      detail_class = CASE WHEN $2 = 'closed' THEN 'closed' ELSE detail_class END
     WHERE src_id = ANY($1::uuid[]) OR dst_id = ANY($1::uuid[])`, [ids, to])).rowCount ?? 0;
}

/** An open-class source record goes only after a reread of the closed copy. Details never move back. */
export async function dropMovedDetails(ctx: DbCtx, linkIds: string[], from: DataClass): Promise<void> {
  if (from !== "open" || !linkIds.length) return;
  const verified = (await recordsDb(ctx, "closed").query("SELECT link_id FROM record_link_details WHERE link_id = ANY($1::uuid[])", [linkIds])).rows.map((r) => r.link_id as string);
  if (verified.length) await recordsDb(ctx, "open").query("DELETE FROM record_link_details WHERE link_id = ANY($1::uuid[])", [verified]);
}

/** Fault before source rows are deleted: only the copies this move inserted, not the other side's closed details. */
export async function rollbackCopiedLinkDetails(ctx: DbCtx, inserted: string[]): Promise<void> {
  if (!inserted.length) return;
  await tx(ctx.db.control, async (c) => {
    const safe = (await c.query("SELECT id FROM record_links WHERE id = ANY($1::uuid[]) AND detail_class = 'open' FOR UPDATE", [inserted])).rows.map((r) => r.id as string);
    if (safe.length) await recordsDb(ctx, "closed").query("DELETE FROM record_link_details WHERE link_id = ANY($1::uuid[])", [safe]);
  });
}

async function deleteDetails(ctx: DbCtx, ids: string[]): Promise<void> {
  for (const cls of ["open", "closed"] as const) await recordsDb(ctx, cls).query("DELETE FROM record_link_details WHERE link_id = ANY($1::uuid[])", [ids])
    .catch(() => log.warn("link_details_cleanup_failed", { class: cls, links: ids.length }));
}

/**
 * The source-loss mark: a derived record whose live source
 * (derived_from, not rejected by a person) is purged for good while it stays — attrs.derived_lost = true in both records
 * DBs by id, one way only. The claimed count alone does not remember a purge: a retry with new sources would catch
 * up, and the move would check only the rest and new. With the mark the set basis is incomplete for good (an agent
 * moves it no wider; a person only with confirmation). Called BEFORE links go; a fault throws; links stay this pass
 * (the sweeper drops them later and marks it).
 *
 * A version begun by a fix in another class already has the mark — with the cause `derived_lost_cause: class_change`
 * (shared DERIVED_LOST_CLASS_CHANGE: from-a-meeting is settled at the edit; the meeting sign sees no such mark as loss).
 * A purge of a source such a version linked to later (a memory_remember retry) is a real loss: the cause
 * is dropped and from-a-meeting can no longer be checked (the meeting rule of make-available-to-agents).
 */
export async function markDerivedLost(ctx: DbCtx, links: ReadonlyArray<Pick<LinkState, "src_id" | "dst_id"> & { status?: string; decided_by?: string | null }>,
                                      gone: ReadonlySet<string>): Promise<number> {
  const src = [...new Set(links.filter((l) => gone.has(l.dst_id) && !gone.has(l.src_id) && !(l.status === "rejected" && l.decided_by)).map((l) => l.src_id))];
  if (!src.length) return 0;
  let n = 0;
  for (const cls of ["open", "closed"] as const)
    n += (await recordsDb(ctx, cls).query(
      `UPDATE records SET attrs = (attrs - 'derived_lost_cause') || '{"derived_lost": true}'::jsonb
        WHERE id = ANY($1::uuid[]) AND ((attrs->>'derived_lost') IS DISTINCT FROM 'true' OR attrs ? 'derived_lost_cause')`,
      [src])).rowCount ?? 0;
  log.info("derived_lost_marked", { records: src.length, marked: n });
  return n;
}

/**
 * The loss mark and the deletion of derived_from links to
 * leaving records — under class move locks. A move reads the derived row into memory and inserts it at the target: a mark
 * set in the source DB between read and insert was lost with the link. Here each derived record gets the same
 * order as the sweeper (sweepLinks): locks record:<id> of ancestors and chain (pg_try_advisory_xact_lock — no wait),
 * a recheck of a running move under them, mark, details and link rows — one control transaction under the locks. Lock busy
 * or a move running: its links are deferred (they live until marked under locks; the sweeper drops them in the same
 * order), and the leaving end's locator is held by KEEP_FOR_MARK. A link a person rejected and a link whose derived record
 * leaves itself need no mark — the caller drops them the usual way. A mark failure throws (the link stays).
 */
export async function dropDerivedLinks(ctx: DbCtx, gone: readonly string[]): Promise<{ removed: number; postponed: string[] }> {
  const set = new Set(gone);
  const rows = (await ctx.db.control.query(
    "SELECT id, src_id, dst_id, status, decided_by FROM record_links WHERE relation = 'derived_from' AND dst_id = ANY($1::uuid[])", [[...gone]])).rows as LinkState[];
  const bySrc = new Map<string, LinkState[]>();
  for (const l of rows) if (!set.has(l.src_id) && !(l.status === "rejected" && l.decided_by)) bySrc.set(l.src_id, [...(bySrc.get(l.src_id) ?? []), l]);
  let removed = 0;
  const postponed: string[] = [];
  for (const [src, links] of bySrc) {
    const lockIds = await lockIdsFor(ctx, [src]);
    const done = await tx(ctx.db.control, async (c) => {
      for (const id of lockIds)
        if (!(await c.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok", [`record:${id}`])).rows[0]?.ok) return null;
      if ((await c.query("SELECT record_id FROM class_moves WHERE record_id = ANY($1::uuid[]) AND status IN ('pending','copying','verifying') LIMIT 1", [lockIds])).rows.length) return null;
      await markDerivedLost(ctx, links, set);
      const ids = links.map((l) => l.id);
      await deleteDetails(ctx, ids);
      return (await c.query("DELETE FROM record_links WHERE id = ANY($1::uuid[])", [ids])).rowCount ?? 0;
    });
    if (done === null) { postponed.push(...links.map((l) => l.id)); log.info("derived_lost_postponed", { record_id: src, links: links.length }); }
    else removed += done;
  }
  return { removed, postponed };
}

/**
 * Leaving record locator `alias.record_id` holds while a live derived_from from outside the leaving ones points at it (`set` —
 * uuid[] parameter): the link goes by cascade with the locator, and an unmarked derived record would keep no mark.
 */
export const KEEP_FOR_MARK = (alias: string, set: string): string =>
  `EXISTS (SELECT 1 FROM record_links k WHERE k.dst_id = ${alias}.record_id AND k.relation = 'derived_from' AND NOT k.src_id = ANY(${set})
             AND NOT (k.status = 'rejected' AND k.decided_by IS NOT NULL))`;

/** A locator the delete deferred until the loss mark (KEEP_FOR_MARK) — as it was at batch time. */
export interface HeldLocator { id: string; cls: DataClass; space_id: string; owner_id: string; deleted: boolean; deleted_by: string | null; created_at: Date }

/**
 * The ONLY path that deletes locators of leaving records (trash
 * purge, dangling test-leftover locators, the test_purge tail). KEEP_FOR_MARK lives here, inside: the locator
 * of an unmarked derived record's source holds (derived_from would go by cascade with no loss mark). `notMoving` — also
 * spares a record mid class move. One statement: DELETE in WITH plus a snapshot of those locators before it —
 * deleted and deferred (held — with space and owner at batch time: the caller carries them through the run).
 * A static check requires DELETE FROM record_locations only here and in
 * the exception list, by exact text.
 */
export async function deleteLocators(q: { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> }, ids: readonly string[], o: { notMoving?: boolean } = {})
  : Promise<{ deleted: string[]; held: HeldLocator[] }> {
  if (!ids.length) return { deleted: [], held: [] };
  const rows = (await q.query(
    `WITH d AS (
       DELETE FROM record_locations l WHERE l.record_id = ANY($1::uuid[])
         AND NOT ($2::boolean AND EXISTS (SELECT 1 FROM class_moves m WHERE m.record_id = l.record_id AND m.status IN ('pending', 'copying', 'verifying')))
         AND NOT ${KEEP_FOR_MARK("l", "$1::uuid[]")}
       RETURNING l.record_id)
     SELECT l.record_id::text AS id, l.class AS cls, l.space_id::text AS space_id, l.owner_id::text AS owner_id, l.deleted, l.deleted_by::text AS deleted_by, l.created_at,
            d.record_id IS NOT NULL AS gone, ${KEEP_FOR_MARK("l", "$1::uuid[]")} AS held
       FROM record_locations l LEFT JOIN d ON d.record_id = l.record_id WHERE l.record_id = ANY($1::uuid[])`, [[...ids], o.notMoving === true])).rows;
  return { deleted: rows.filter((r) => r.gone).map((r) => r.id as string),
           held: rows.filter((r) => !r.gone && r.held).map(({ gone: _g, held: _h, ...l }) => l as HeldLocator) };
}

/**
 * Details → loss mark on derived records (under move locks, dropDerivedLinks) → links → (caller) locators via
 * deleteLocators. Trash changes no links before the purge. Deferred derived-record links are left alone.
 */
export async function purgeLinks(ctx: DbCtx, gone: string[]): Promise<number> {
  if (!gone.length) return 0;
  const d = await dropDerivedLinks(ctx, gone);
  const ids = (await ctx.db.control.query("SELECT id FROM record_links WHERE (src_id = ANY($1::uuid[]) OR dst_id = ANY($1::uuid[])) AND NOT id = ANY($2::uuid[])",
                                          [gone, d.postponed])).rows.map((r) => r.id as string);
  if (!ids.length) return d.removed;
  await deleteDetails(ctx, ids);
  return d.removed + ((await ctx.db.control.query("DELETE FROM record_links WHERE id = ANY($1::uuid[])", [ids])).rowCount ?? 0);
}

export interface LinkSweepResult { orphan_details: number; stray_details: number; copied: number; class_fixed: number; purged_links: number; skipped_moving: number; skipped_locked: number }

/** How long the sweeper waits for a link row or locator lock: longer — the link waits for the next pass. */
export const SWEEP_LOCK_TIMEOUT = "5s";
/** The lock wait timed out (lock_timeout) or PostgreSQL broke a deadlock. */
const lockGaveUp = (e: unknown): boolean => ["55P03", "40P01"].includes(String((e as { code?: unknown })?.code ?? ""));

/**
 * Ancestors from both databases: during a move part of the tree may already live only in the target.
 * With the version chain (chain rule of chainLinkSql: agent notes or documents): the head holds the move and the lock of
 * the whole chain, so an older version is locked together with its head — alone it would miss the head's move lock.
 */
async function lockIdsFor(ctx: DbCtx, ends: string[]): Promise<string[]> {
  const ids = new Set(ends);
  for (const cls of ["open", "closed"] as const) {
    const rows = (await recordsDb(ctx, cls).query(
      `WITH RECURSIVE ancestors AS (SELECT id, parent_id, supersedes_id, superseded_by_id, source_kind FROM records WHERE id = ANY($1::uuid[])
        UNION SELECT r.id, r.parent_id, r.supersedes_id, r.superseded_by_id, r.source_kind FROM records r JOIN ancestors a
          ON r.id = a.parent_id
          OR (r.id IN (a.supersedes_id, a.superseded_by_id) AND ${chainLinkSql("a", "r")}))
       SELECT id FROM ancestors`, [ends])).rows;
    for (const row of rows) ids.add(row.id as string);
  }
  return [...ids].sort();
}

/**
 * Part of reconcileClasses, no separate schedule. Only class raising: a closed copy is never moved
 * to the open DB. The moving snapshot is backed by end/root locks and a request recheck under them.
 */
export async function sweepLinks(ctx: DbCtx, moving: ReadonlySet<string> = new Set()): Promise<LinkSweepResult> {
  const out: LinkSweepResult = { orphan_details: 0, stray_details: 0, copied: 0, class_fixed: 0, purged_links: 0, skipped_moving: 0, skipped_locked: 0 };
  const saved = (await ctx.db.control.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = 'links_sweep'", [ctx.instanceId])).rows[0]?.value ?? {};
  const cursors: Record<string, string | null> = {};
  const batch = (await ctx.db.control.query(
    "SELECT id FROM record_links WHERE ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id LIMIT 5000", [saved.cursors?.links ?? null])).rows;
  cursors.links = batch.length === 5000 ? batch.at(-1)!.id : null;
  const scanned = new Map<DataClass, Detail[]>(), ids = new Set<string>(batch.map((r) => r.id as string));
  for (const cls of ["open", "closed"] as const) {
    const rows = (await recordsDb(ctx, cls).query(
      `SELECT ${detailColumns} FROM record_link_details WHERE ($1::uuid IS NULL OR link_id > $1::uuid) ORDER BY link_id LIMIT 5000`,
      [saved.cursors?.[cls] ?? null])).rows as Detail[];
    scanned.set(cls, rows); cursors[cls] = rows.length === 5000 ? rows.at(-1)!.link_id : null;
    for (const row of rows) ids.add(row.link_id);
  }
  const links = ids.size ? (await ctx.db.control.query("SELECT id, src_id, dst_id, src_class, dst_class, detail_class, relation, status, decided_by FROM record_links WHERE id = ANY($1::uuid[])", [[...ids]])).rows as LinkState[] : [];
  const linked = new Set(links.map((r) => r.id));
  // Unfinished insert details stay an hour: the control transaction may not have committed the link.
  for (const [cls, rows] of scanned) {
    const orphan = rows.filter((d) => !linked.has(d.link_id) && new Date(d.created_at).getTime() < Date.now() - 3_600_000).map((d) => d.link_id);
    if (!orphan.length) continue;
    const appeared = new Set((await ctx.db.control.query("SELECT id FROM record_links WHERE id = ANY($1::uuid[])", [orphan])).rows.map((r) => r.id as string));
    const stale = orphan.filter((id) => !appeared.has(id));
    if (stale.length) out.orphan_details += (await recordsDb(ctx, cls).query("DELETE FROM record_link_details WHERE link_id = ANY($1::uuid[])", [stale])).rowCount ?? 0;
  }
  for (const original of links) {
    const ends = [original.src_id, original.dst_id], lockIds = await lockIdsFor(ctx, ends);
    if (lockIds.some((id) => moving.has(id))) { out.skipped_moving++; continue; }
    try { await tx(ctx.db.control, async (c) => {
      // row locks (link FOR UPDATE, locators FOR SHARE) — at most SWEEP_LOCK_TIMEOUT: a purge may hold them that
      // itself waits for another connection (a wait across connections is not detected by PostgreSQL and stood until restart)
      await c.query(`SET LOCAL lock_timeout = '${SWEEP_LOCK_TIMEOUT}'`);
      for (const id of lockIds) {
        const got = (await c.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok", [`record:${id}`])).rows[0]?.ok;
        if (!got) { out.skipped_moving++; return; }
      }
      if ((await c.query("SELECT record_id FROM class_moves WHERE record_id = ANY($1::uuid[]) AND status IN ('pending','copying','verifying')", [lockIds])).rows.length) {
        out.skipped_moving++; return;
      }
      const row = (await c.query("SELECT id, src_id, dst_id, src_class, dst_class, detail_class, relation, status, decided_by FROM record_links WHERE id = $1 FOR UPDATE", [original.id])).rows[0] as LinkState | undefined;
      if (!row) return;
      const locations = new Map<string, DataClass>((await c.query("SELECT record_id, class FROM record_locations WHERE record_id = ANY($1::uuid[]) FOR SHARE", [ends])).rows.map((r) => [r.record_id, r.class]));
      const present = new Set<string>(), tombs = new Set<string>();
      const details = new Map<DataClass, Detail>();
      for (const cls of ["open", "closed"] as const) {
        const db = recordsDb(ctx, cls);
        for (const t of (await db.query("SELECT id FROM record_tombstones WHERE id = ANY($1::uuid[]) AND reason = 'purged'", [ends])).rows) tombs.add(t.id as string);
        for (const rec of (await db.query("SELECT id FROM records WHERE id = ANY($1::uuid[])", [ends])).rows) present.add(rec.id as string);
        const detail = (await db.query(`SELECT ${detailColumns} FROM record_link_details WHERE link_id = $1`, [row.id])).rows[0] as Detail | undefined;
        if (detail) details.set(cls, detail);
      }
      const gone = new Set(ends.filter((id) => tombs.has(id) || !present.has(id)));
      if (gone.size) {
        // derived record's source purged: loss mark before the link goes (a fault rolls back; the link waits a pass)
        if (row.relation === "derived_from") await markDerivedLost(ctx, [row], gone);
        await deleteDetails(ctx, [row.id]);
        out.purged_links += (await c.query("DELETE FROM record_links WHERE id = $1", [row.id])).rowCount ?? 0;
        // the locator of a purged end (purged tombstone, no row in either DB) that the purge
        // kept for an unmarked derived record — once nothing else refers to it
        for (const id of gone) if (tombs.has(id) && !present.has(id))
          await c.query("DELETE FROM record_locations l WHERE l.record_id = $1 AND NOT EXISTS (SELECT 1 FROM record_links k WHERE k.src_id = $1 OR k.dst_id = $1)", [id]);
        return;
      }
      const src = locations.get(row.src_id), dst = locations.get(row.dst_id);
      if (!src || !dst) return; // no locator is a separate fault; no new graph is made
      const strict: DataClass = row.detail_class === "closed" || src === "closed" || dst === "closed" || details.has("closed") ? "closed" : "open";
      const open = details.get("open");
      if (strict === "closed" && open && !details.has("closed")) {
        if (await insertClosed(recordsDb(ctx, "closed"), open)) out.copied++;
        const verified = (await recordsDb(ctx, "closed").query(`SELECT ${detailColumns} FROM record_link_details WHERE link_id = $1`, [row.id])).rows[0] as Detail | undefined;
        if (!verified) throw new Error("link_details_copy_missing");
        details.set("closed", verified);
      }
      if (row.src_class !== src || row.dst_class !== dst || row.detail_class !== strict) {
        out.class_fixed += (await c.query("UPDATE record_links SET src_class = $2, dst_class = $3, detail_class = $4 WHERE id = $1", [row.id, src, dst, strict])).rowCount ?? 0;
        log.warn("link_class_reconciled", { link_id: row.id });
      }
      if (strict === "closed" && open && details.has("closed")) out.stray_details += (await recordsDb(ctx, "open").query("DELETE FROM record_link_details WHERE link_id = ANY($1::uuid[])", [[row.id]])).rowCount ?? 0;
    }); } catch (e) {
      if (!lockGaveUp(e)) throw e;
      out.skipped_locked++;                                             // rolled back: the link waits for the next pass
      log.warn("links_sweep_lock_timeout", { link_id: original.id, code: (e as { code?: string }).code });
    }
  }
  await ctx.db.control.query(
    `INSERT INTO maintenance_state (instance_id, key, value, updated_at) VALUES ($1, 'links_sweep', $2, now())
     ON CONFLICT (instance_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [ctx.instanceId, JSON.stringify({ ...out, cursors, at: new Date().toISOString() })]);
  if (out.orphan_details || out.stray_details || out.copied || out.class_fixed || out.purged_links) await auditWorker(ctx, { event_type: "processing", details: { op: "links_sweep", ...out } });
  return out;
}
