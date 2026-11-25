// The trash and the owner's old questions:
//  - a dismissed person's meeting handed to a custodian and put in the trash by the custodian is not erased while
//    the organizer is dismissed and dismissed people's personal spaces are kept (heldTransferred, shared/custody.ts):
//    "Delete forever" — 409 purge_held with an explanation, in the trash — the held mark instead of a term, restore allowed;
//  - open recheck: a record in the trash where the recheck found a name from the NDA list (open_recheck_holds,
//    state on_restore) is restored closed at once — by a regular closing with via nda_recheck (restoreHeldClosed). The same —
//    a record whose closing by the recheck did not arrive because it had been deleted (a held or kept row with an open class);
//  - a meeting a return put in a dismissed person's trash (organizer_return, trashed), shown to agents by someone else despite
//    a finding is restored closed at once — as on a live return (returnedDespite);
//  - a part of a live record (a summary, a meeting event) deleted apart, with a recheck finding, is closed only together with
//    the head of its tree: the request, the mark and the hold — on the head, the whole tree is hidden (restoreCloseHead;
//    a request for one part failed at the worker with parent_other_class, and the class reconciler showed it to agents).
// Records commit before control: if the gateway fell between the two COMMITs, rows are hidden with no request — the closing by
// the current hold row (or the return mark) is made by the class reconciler (maintenance.ts recloseRecheck, recloseReturned).
import { CHAIN_HEAD, CHAIN_TREE, custodyPolicy, despiteShown, HELD_TRANSFER_TEXTS, SCOPE_SYSTEM, heldOrigins, heldTransferred, inProgress, invalid, MemoryError, newId, openCheckSettings,
         recheckHoldSummary, recheckHoldsToHead, recheckMark, type DataClass, type RecheckHoldSummary } from "@memory/shared";
import type pg from "pg";
import type { App } from "./context.ts";

/** Original organizers with a hold now (on delete — empty). */
export async function heldOriginsNow(app: App): Promise<string[]> {
  return heldOrigins(app.db.control, app.instanceId, custodyPolicy(app.settings));
}

/** Which trash roots are held as handed-over meetings of dismissed people; origins — already taken (one snapshot per request). */
export async function heldTrashIds(app: App, rows: ReadonlyArray<{ id: string; class: DataClass }>, origins?: string[]): Promise<Set<string>> {
  if (!rows.length) return new Set();
  const o = origins ?? await heldOriginsNow(app);
  if (!o.length) return new Set();
  const out = new Set<string>();
  for (const cls of ["open", "closed"] as const) {
    const ids = rows.filter((r) => r.class === cls).map((r) => r.id);
    if (ids.length) for (const id of await heldTransferred(app.db.records(cls, SCOPE_SYSTEM), ids, o)) out.add(id);
  }
  return out;
}

/** Whether this record is held (a trash package root or a record to be deleted forever). */
export async function isHeldTransfer(app: App, cls: DataClass, id: string): Promise<boolean> {
  return (await heldTrashIds(app, [{ id, class: cls }])).has(id);
}

/** "Delete forever" of a held meeting — 409 purge_held with an explanation; the rest — no refusal. */
export async function refusePurgeHeld(app: App, cls: DataClass, id: string): Promise<void> {
  if (await isHeldTransfer(app, cls, id))
    throw new MemoryError("conflict", HELD_TRANSFER_TEXTS.refused, { hint: "You can restore the record from the Trash", details: { reason: "purge_held" } });
}

const recheckReady = new WeakMap<object, true>();
/**
 * Whether the recheck hold table exists (schema 17). A gateway newer than the schema — no recheck yet, no
 * on_restore rows: a restore goes as before, without a query to a missing table inside the restore transaction.
 * "Exists" is remembered per pool connection until a restart.
 */
export async function recheckHoldsReady(app: App): Promise<boolean> {
  if (recheckReady.has(app.db.control)) return true;
  const ok = (await app.db.control.query("SELECT to_regclass('open_recheck_holds') IS NOT NULL AS ok")).rows[0]?.ok === true;
  if (ok) recheckReady.set(app.db.control, true);
  return ok;
}

/**
 * Restoring a record the open recheck found in the trash (state on_restore): under the record lock, in the same
 * control transaction as the restore — the records database already hid the rows; here the class_moves open → closed request on
 * behalf of the author with via nda_recheck, and the hold row → held. The finding mark (attrs.open_check_fallback, move_id) — by
 * the caller into the records database before commit — its move puts it into the locator. held and kept rows too: a record in
 * the open class with such a row means the recheck closing did not arrive (it was deleted before the move began), and
 * the restore must not return it to agents open. Rules — the union of the record's rows, each one's kind — by the
 * rule itself (recheckFindings: before, kinds were taken by number from a separately sorted array). No such rows — null.
 */
export async function onRestoreHold(q: Pick<pg.PoolClient, "query">, instanceId: string, recordId: string, extraRules: ReadonlyArray<{ name?: unknown; kind?: unknown }> = []):
  Promise<RecheckHoldSummary | null> {
  // findings without matches and positions (the record text is not read here)
  return recheckHoldSummary((await q.query(
    `SELECT run_id, rules, why FROM open_recheck_holds WHERE instance_id = $1 AND record_id = $2 AND state IN ('on_restore','held','kept')
      ORDER BY held_at DESC NULLS LAST, updated_at DESC`, [instanceId, recordId])).rows as Array<{ run_id: string; rules: string[] | null; why: string | null }>, extraRules);
}

/** The administrator's own rules — for the finding kind of a hold row (recheckFindings). */
export const recheckExtraRules = (app: App): ReadonlyArray<{ name?: unknown; kind?: unknown }> => openCheckSettings(app.settings).extra_rules ?? [];

/** A row's root by parent_id (a derivative → its record). */
const ROOT_OF = `WITH RECURSIVE up AS (SELECT id, parent_id, 0 AS depth FROM records WHERE id = $1
  UNION ALL SELECT r.id, r.parent_id, u.depth + 1 FROM records r JOIN up u ON r.id = u.parent_id WHERE u.depth < 64)
  SELECT id FROM up ORDER BY depth DESC LIMIT 1`;

/** The tree head the closing is made on at restore (restoreCloseHead). */
export interface CloseHead { head: string; owner: string; space: string | null }
/**
 * Where to make the recheck closing when restoring package `id`. A package without a parent — `id` itself
 * (null: the request — as before). A part of a live record (a summary, a meeting event, deleted separately) moves between classes
 * only together with the source record (owner.ts derivedAlone; the worker refuses parent_other_class): the head of the chain
 * of its root is closed with the tree the part returns to. Under the `id` lock, same control transaction — the head lock, no wait
 * (busy — 409 "retry in a minute": the head is being closed, moved or restored). The head is deleted or not in the open
 * class — a refusal, as for a derivative with a deleted parent; a move runs over the head's tree — also "retry": the running move
 * could already have read the tree without the part, and it would stay open alone.
 */
export async function restoreCloseHead(app: App, q: Pick<pg.PoolClient, "query">, id: string): Promise<CloseHead | null> {
  const open = app.db.records("open", SCOPE_SYSTEM);
  const parent = (await open.query("SELECT parent_id FROM records WHERE id = $1", [id])).rows[0]?.parent_id as string | null | undefined;
  if (!parent) return null;
  const root = ((await open.query(ROOT_OF, [id])).rows[0]?.id ?? parent) as string;
  const head = ((await open.query(CHAIN_HEAD, [root])).rows[0]?.id ?? root) as string;
  if (!(await q.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok", [`record:${head}`])).rows[0]?.ok) throw inProgress(60);
  const loc = (await q.query("SELECT class, deleted, owner_id, space_id FROM record_locations WHERE record_id = $1", [head])).rows[0];
  if (!loc || loc.class !== "open" || loc.deleted)
    throw invalid("Restore the source record first. This derived record was deleted separately, and the source record is also in Trash");
  const tree = (await open.query(`${CHAIN_TREE} SELECT id FROM tree`, [head])).rows.map((r) => r.id as string);
  if ((await q.query("SELECT 1 FROM class_moves WHERE record_id = ANY($1::uuid[]) AND status IN ('pending','copying','verifying') LIMIT 1", [tree])).rowCount) throw inProgress(60);
  return { head, owner: loc.owner_id as string, space: (loc.space_id as string | null) ?? null };
}

/**
 * The closing request and the hold rows after the restore (see onRestoreHold). `target` — the head of the part's tree
 * (restoreCloseHead): the request on behalf of the head author, the hold goes to the head (recheckHoldsToHead). Result: move id,
 * the record it is made on (its tree is hidden, its attrs get the mark), and the mark.
 */
export async function restoreHeldClosed(q: Pick<pg.PoolClient, "query">, instanceId: string, recordId: string, author: string,
  hold: RecheckHoldSummary, target: CloseHead | null = null): Promise<{ moveId: string; head: string; mark: ReturnType<typeof recheckMark> }> {
  const moveId = newId(), head = target?.head ?? recordId;
  await q.query("INSERT INTO class_moves (id, record_id, from_class, to_class, requested_by, via) VALUES ($1,$2,'open','closed',$3,'nda_recheck')", [moveId, head, target?.owner ?? author]);
  if (target) await recheckHoldsToHead(q, { instanceId, head, ids: [recordId], moveId, sum: hold, spaceId: target.space, ownerId: target.owner });
  else await q.query(`UPDATE open_recheck_holds SET state = 'held', move_id = $3, held_at = COALESCE(held_at, now()), updated_at = now()
                       WHERE instance_id = $1 AND record_id = $2 AND state IN ('on_restore','held','kept')`, [instanceId, recordId, moveId]);
  return { moveId, head, mark: recheckMark(hold.found, { moveId, run: hold.run, unchecked: hold.unchecked }) };
}

/**
 * A meeting returned to the original organizer O into their trash (organizer_return with trashed), shown to agents
 * despite a finding not by them (the consent — of the author and the space; despiteShown, shared with the worker), on O's restore
 * is closed at once: on a live return the return itself closes it (handRoot), while the closings sweep
 * (closeLeftovers) runs once an hour, and until then O's agents would read the record by another's consent. Call it
 * under the record lock in the restore control transaction. true — close (the request — closeReturned).
 */
export async function returnedDespite(app: App, q: Pick<pg.PoolClient, "query">, recordId: string, owner: string): Promise<boolean> {
  const back = (await app.db.records("open", SCOPE_SYSTEM).query("SELECT attrs -> 'organizer_return' AS back FROM records WHERE id = $1", [recordId])).rows[0]?.back;
  if (!back || typeof back !== "object" || back.trashed !== true || back.to !== owner) return false;
  return (await despiteShown(q, [{ id: recordId, holder: owner, since: typeof back.at === "string" ? back.at : null }])).size > 0;
}

/** The closing request of a returned meeting (returnedDespite) — the same requester as at the return (organizer_transfer). */
export async function closeReturned(q: Pick<pg.PoolClient, "query">, recordId: string, owner: string): Promise<string> {
  const moveId = newId();
  await q.query("INSERT INTO class_moves (id, record_id, from_class, to_class, requested_by, via) VALUES ($1,$2,'open','closed',$3,'organizer_transfer')", [moveId, recordId, owner]);
  return moveId;
}
