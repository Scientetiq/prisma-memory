// Second phase of a new version of a converted document. The gateway wrote the new version
// of a PDF or office file as a record of its own with `attrs.version_pending = {of, places}` and an empty supersedes_id:
// its text exists only after conversion and the open check, and superseding at upload time would leave the document with
// no current version when conversion fails. This module replaces the head in the SAME transaction that completes the
// `converted` stage (convert.ts, the single success point of convertDocument):
//   - before that transaction the old version is current and searchable, the new one has no text and no chunks;
//   - the transaction marks `converted` done, writes the text and makes the new record the head (supersedeInTx), so the
//     `indexed` stage — which removes the old version's chunks (SUPERSEDED_CHUNKS_SQL) — cannot be claimed before it:
//     at no moment are two versions of one document in search.
// Under the record locks of the whole chain (the gateway's owner operations and the class move take the same `record:<id>`
// locks), against the CURRENT head: another version that landed meanwhile makes this one head.version + 1.
// When the worker refuses the supersede — the head was deleted or purged (`head_gone`), moved to another space or class
// (`head_moved`), got another owner or audience (`head_changed`), or a newer version landed after this file had failed to
// convert and was retried (`head_newer`) — the converted text is NOT published: the transaction is rolled back, the stage
// ends as a terminal refusal (no text, no chunks, `conversion.status = failed`, `error_kind = version_refused`), and the
// record is narrowed to its author and uploader (audience `people`). Otherwise the new content would stay visible to the
// audience the document had before the owner's restrictive action (hide from agents, narrow the audience, move away).
// The mark `version_pending.final` with the reason stays; a retried conversion of such a record refuses again.
// A chain therefore never spans two spaces, classes or audiences. A failed conversion or a refusal of the open check
// never reaches this point: the old version simply stays current (versionPendingOf shows the state).
import { CHAIN_HEAD, CHAIN_MEMBERS, carryOrgReview, log, supersedeInTx, tx, undoCarryOrgReview, versionPendingOf, versionRetried, watchLock, type DataClass, type OrgReviewState,
         SUPERSEDED_STAGE_NOTE, type VersionPendingReason } from "@memory/shared";
import type pg from "pg";
import { CYCLE_END_DROP, CYCLE_MARK } from "../conversion-rules.ts";
import { auditWorker, recordsDb, type Ctx } from "../ctx.ts";
import { StageClaimLost, StageRefused, StageWait, type StageClaim } from "../stages.ts";

/** Reason on the skipped stages of the replaced version (`last_error`). */
const SUPERSEDED_NOTE = SUPERSEDED_STAGE_NOTE;
/** How long the finisher tries the chain's locks before the stage waits (no attempt is spent) and comes back. */
export const VERSION_LOCK_WAIT = { tryMs: 10_000, pauseMs: 200, retrySec: 30 };
const MOVES_IN_FLIGHT = "SELECT 1 FROM class_moves WHERE record_id = ANY($1::uuid[]) AND status IN ('pending','copying','verifying') LIMIT 1";
/** `attrs.conversion.error_kind` of a converted version the worker refused to supersede with (the reason is in `version_pending`). */
export const VERSION_REFUSED = "version_refused";

/** Why the converted file did not become the new version — the stage's terminal refusal (`last_error`, kept under 200 characters). */
const REFUSED_WHY: Record<VersionPendingReason, string> = {
  head_gone: "The document was deleted while this file was being processed as its new version",
  head_moved: "The document was moved, or hidden from or shown to agents, while this file was processed as its new version",
  head_changed: "The document's owner or audience changed while this file was being processed as its new version",
  head_newer: "A newer version of the document was added after this file failed to process",
  conversion_failed: "This file could not be converted",
  open_check: "This file did not pass the secrets check",
};
const refusedText = (reason: VersionPendingReason): string => `${REFUSED_WHY[reason]}: it was not added, only you can see it. Upload it again or delete it`;

/** Called inside the transaction that completes `converted`: replaces the head, or refuses (the transaction is then rolled back). */
export type FinishVersion = (c: pg.PoolClient) => Promise<void>;

const noop: FinishVersion = async () => undefined;

/** Thrown out of the `converted` transaction to roll it back when the worker refuses the supersede: nothing of the text is kept. */
class VersionRefusal extends Error {
  constructor(readonly reason: VersionPendingReason, readonly space: string | null) { super(`version refused: ${reason}`); this.name = "VersionRefusal"; }
}

/**
 * Session advisory locks `record:<id>` of all ids on one control connection, tried (never waited for blindly) in a fixed
 * order: the gateway takes the same keys with try-locks, the class move holds the record's lock for its whole run. Not all
 * taken within VERSION_LOCK_WAIT.tryMs → null (nothing held). The caller holds the pending record's own lock already.
 */
async function tryLocks(ctx: Ctx, ids: string[]): Promise<{ alive: () => Promise<void>; release: () => Promise<void> } | null> {
  const client = await ctx.db.control.connect();
  const held: string[] = [];
  let clean = true;
  let watch: ReturnType<typeof watchLock> | undefined;
  const release = async (): Promise<void> => {
    try {
      for (const id of held.splice(0).reverse()) {
        if (watch?.lost()) break;
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`record:${id}`]).catch(() => { clean = false; });
      }
      if (watch?.lost()) {
        clean = false;
        log.warn("lock_connection_lost", { job: "doc_version_finish" });
      }
    } finally {
      watch?.done();
      client.release(!clean);
    }
  };
  try {
    const until = Date.now() + VERSION_LOCK_WAIT.tryMs;
    for (const id of [...new Set(ids)].sort()) {
      for (;;) {
        if ((await client.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok", [`record:${id}`])).rows[0]?.ok === true) { held.push(id); break; }
        if (Date.now() + VERSION_LOCK_WAIT.pauseMs > until) { await release(); return null; }
        await new Promise((r) => setTimeout(r, VERSION_LOCK_WAIT.pauseMs));
      }
    }
    watch = watchLock(client);
    return { alive: watch.alive, release };
  } catch (e) {
    clean = false;
    await release();
    throw e;
  }
}

const wait = (code: string): StageWait => new StageWait(new Date(Date.now() + VERSION_LOCK_WAIT.retrySec * 1000), `version_wait:${code}`);

/** Audience of a row: mode and the sorted people list — a new version never gets another audience than its chain. */
async function audienceOf(c: Pick<pg.PoolClient, "query">, id: string, mode: string): Promise<string> {
  if (mode !== "people") return mode;
  const people = (await c.query("SELECT person_id FROM record_people WHERE record_id = $1 ORDER BY person_id", [id])).rows.map((r) => String(r.person_id));
  return `people:${people.join(",")}`;
}

/**
 * A retried conversion: this record's conversion already ended once (it failed — a pending version never ends `done`
 * without being decided) and "Retry" / "Process now" started a new cycle. The marks are read BEFORE the `converted`
 * transaction replaces `attrs.conversion` with the result. Besides the conversion's own marks, the gateway's "Process now"
 * marks `version_pending.retried` when the stage had failed (versionRetried): a stage failed by the scheduler's sweep of a
 * stuck pass, or one whose failure mark was lost, leaves `conversion` as it was.
 */
const conversionRetried = (attrs: unknown): boolean => {
  const conv = (attrs as { conversion?: Record<string, unknown> } | null | undefined)?.conversion;
  return versionRetried(attrs) || (!!conv && typeof conv === "object" && (conv.status === "failed" || typeof conv[CYCLE_MARK] === "string"));
};

interface Outcome { kind: "superseded"; head: string; version: number; space: string | null }
interface Refusal { kind: "failed"; reason: VersionPendingReason; space: string | null }
/** The record is no pending version any more (another pass decided it): the transaction goes on as for any document. */
interface Nothing { kind: "none" }

/**
 * Runs `fn` — the transaction that completes `converted` — with a FinishVersion to call inside it. A record that is not a
 * pending version gets a no-op and runs exactly as before. A pending version: the chain's locks are taken first (busy, or
 * a class move of the chain in flight → StageWait: the stage comes back later without spending an attempt, nothing is
 * written); after the commit the decision is journaled. The org-review row of the head moves to the new version inside the
 * transaction (control database) and moves back when the transaction does not commit. A refusal rolls the transaction
 * back and ends the stage as a terminal refusal (StageRefused, see refuse); `claim` fences that write like the result.
 */
export async function withDocVersionFinish<T>(ctx: Ctx, cls: DataClass, recordId: string, fn: (finish: FinishVersion) => Promise<T>,
                                              o: { claim?: StageClaim } = {}): Promise<T> {
  const db = recordsDb(ctx, cls);
  const attrs = (await db.query("SELECT attrs FROM records WHERE id = $1", [recordId])).rows[0]?.attrs;
  const pending = versionPendingOf(attrs);
  if (!pending) return fn(noop);
  if (pending.final) {
    // refused once — refused for good: a retried conversion ("Process now") does not publish the text after all
    const reason = pending.reason ?? "head_gone";
    try { return await fn(async () => { throw new VersionRefusal(reason, null); }); }
    catch (e) { if (e instanceof VersionRefusal) return refuse(ctx, cls, recordId, { of: pending.of, reason, space: null, claim: o.claim, journal: false }); throw e; }
  }
  const retried = conversionRetried(attrs);
  // the chain of the head as it is now: its locks, then everything is read again inside the transaction
  const ofHere = (await db.query("SELECT id FROM records WHERE id = $1", [pending.of])).rowCount;
  const head = ofHere ? String((await db.query(CHAIN_HEAD, [pending.of])).rows[0]?.id ?? pending.of) : null;
  const ids = head ? [...new Set([head, ...(await db.query(CHAIN_MEMBERS, [[head]])).rows.map((r) => String(r.id))])].filter((id) => id !== recordId) : [];
  const locks = ids.length ? await tryLocks(ctx, ids) : { alive: undefined, release: async () => undefined };
  if (!locks) throw wait("locked");
  let decided: Outcome | null = null;
  let carried: OrgReviewState | null = null;
  try {
    if (ids.length && (await ctx.db.control.query(MOVES_IN_FLIGHT, [ids])).rowCount) throw wait("moving");
    const finish: FinishVersion = async (c) => {
      if (locks.alive) await locks.alive();
      const d = await decide(ctx, c, cls, recordId, new Set(ids), retried);
      if (d.kind === "failed") throw new VersionRefusal(d.reason, d.space);
      if (d.kind === "none") return;
      decided = d;
      // org-review row of the head (state, holds, "wrong" marks) moves to the new version, as createRecord does for a text
      // version outside "Company knowledge" (converted versions are not accepted there, doc-versions.ts)
      if (locks.alive) await locks.alive();
      carried = await tx(ctx.db.control, (q) => carryReview(q, d.head, recordId));
    };
    let out: T;
    try {
      if (locks.alive) await locks.alive();
      out = await fn(finish);
    }
    catch (e) {
      // the transaction did not commit: the org-review row goes back to the head (undo is a no-op when nothing moved)
      const d = decided as Outcome | null;
      if (carried && d) {
        await undoCarry(ctx, cls, d.head, recordId, carried).catch((err: Error) => log.warn("doc_version_review_undo_failed", { record_id: recordId, error: err.message.slice(0, 120) }));
        if (locks.alive) await locks.alive();
      }
      if (e instanceof VersionRefusal) {
        if (locks.alive) await locks.alive();
        return await refuse(ctx, cls, recordId, { of: pending.of, reason: e.reason, space: e.space, claim: o.claim, journal: true });
      }
      throw e;
    }
    const d = decided as Outcome | null;
    if (d) {
      if (locks.alive) await locks.alive();
      await auditWorker(ctx, { event_type: "processing", class: cls, record_ids: [recordId, d.head], space_id: d.space,
                               details: { op: "version_superseded", via: "convert", supersedes: d.head, version: d.version } });
      log.info("doc_version_superseded", { record_id: recordId, head: d.head, version: d.version });
    }
    return out;
  } finally {
    await locks.release();
  }
}

/**
 * The org-review row moves to the new version. A copy left by an earlier attempt whose transaction did not commit (no
 * role has DELETE on org_reviews, so undo only gives the head its state back) makes carryOrgReview a no-op: the move is
 * finished here — the head's row superseded, its "wrong" marks moved — instead of leaving the old version's row active.
 */
async function carryReview(q: Pick<pg.PoolClient, "query">, head: string, next: string): Promise<OrgReviewState | null> {
  const carried = await carryOrgReview(q, head, next, { nextOutsideOrg: true });
  if (carried) return carried;
  const prev = (await q.query("SELECT state FROM org_reviews WHERE record_id = $1 FOR UPDATE", [head])).rows[0] as { state: OrgReviewState } | undefined;
  if (!prev || prev.state === "superseded") return null;
  if (!(await q.query("SELECT 1 FROM org_reviews WHERE record_id = $1 AND supersedes_id = $2", [next, head])).rowCount) return null;
  await q.query("UPDATE org_reviews SET state = 'superseded' WHERE record_id = $1", [head]);
  await q.query("UPDATE org_review_marks SET record_id = $2 WHERE record_id = $1 AND kind = 'wrong'", [head, next]);
  return prev.state;
}

/**
 * The terminal refusal of a pending version (the `converted` transaction was rolled back, so no text was written). In one
 * transaction fenced by the stage claim: `version_pending` keeps `final: true` with the reason, the record is version 1 of
 * its own, `attrs.conversion` says `failed` / version_refused (the file is not served from the open class, the record is
 * no "same file" any more), and the audience is narrowed to the author and the uploader — the content never reaches the
 * audience the document had before the owner's action. Then the decision is journaled and the stage refused.
 */
async function refuse(ctx: Ctx, cls: DataClass, recordId: string,
                      a: { of: string; reason: VersionPendingReason; space: string | null; claim?: StageClaim; journal: boolean }): Promise<never> {
  const db = recordsDb(ctx, cls);
  const space = await tx(db, async (c) => {
    if (a.claim && !(await a.claim.touch(c))) throw new StageClaimLost();
    const r = (await c.query(
      `UPDATE records SET version = 1, audience = 'people',
              attrs = jsonb_set(attrs, '{version_pending}', (attrs -> 'version_pending') || jsonb_build_object('final', true, 'reason', $2::text))
                      || jsonb_build_object('conversion', (COALESCE(attrs -> 'conversion', '{}'::jsonb) - $3::text[]) || jsonb_build_object('status', 'failed', 'error_kind', $4::text))
        WHERE id = $1 AND attrs ? 'version_pending' RETURNING space_id, owner_id, attrs ->> 'uploaded_by' AS uploaded_by`,
      [recordId, a.reason, [...CYCLE_END_DROP, "next_action"], VERSION_REFUSED])).rows[0];
    if (!r) return a.space;
    await c.query("DELETE FROM record_people WHERE record_id = $1", [recordId]);
    // the uploader (an owner of the space who replaced a member's document) keeps seeing the file it uploaded
    const by = typeof r.uploaded_by === "string" && /^[0-9a-f-]{36}$/i.test(r.uploaded_by) && r.uploaded_by !== String(r.owner_id) ? r.uploaded_by : null;
    if (by) await c.query("INSERT INTO record_people (record_id, person_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [recordId, by]);
    return String(r.space_id);
  });
  if (a.journal) {
    await auditWorker(ctx, { event_type: "processing", class: cls, record_ids: [recordId], space_id: space,
                             details: { op: "version_not_superseded", via: "convert", reason: a.reason, of: a.of } });
    log.info("doc_version_not_superseded", { record_id: recordId, reason: a.reason });
  }
  throw new StageRefused(VERSION_REFUSED, refusedText(a.reason));
}

/**
 * Inside the transaction (`c`, the class database of the pending record), under the chain's locks: supersede the current
 * head, or say why not (nothing is written then: the caller rolls the transaction back). `locked` — the ids whose locks
 * are held: a head outside them (a version landed between the lookup and the locks) makes the stage wait and come back.
 * `retried` — the conversion had failed once and was retried: a version that landed meanwhile is newer than this file.
 */
async function decide(ctx: Ctx, c: pg.PoolClient, cls: DataClass, recordId: string, locked: Set<string>, retried: boolean): Promise<Outcome | Refusal | Nothing> {
  const me = (await c.query("SELECT id, space_id, owner_id, audience, attrs FROM records WHERE id = $1 FOR UPDATE", [recordId])).rows[0];
  const pending = versionPendingOf(me?.attrs);
  if (!me || !pending || pending.final) return { kind: "none" };
  const space = String(me.space_id);
  const refusal = (reason: VersionPendingReason): Refusal => ({ kind: "failed", reason, space });
  const ofRow = (await c.query("SELECT id FROM records WHERE id = $1", [pending.of])).rows[0];
  if (!ofRow) {
    // the version it was uploaded on top of is not in this class database: moved to the other class, or deleted and purged
    const loc = (await ctx.db.control.query("SELECT class, deleted FROM record_locations WHERE record_id = $1", [pending.of])).rows[0] as { class: DataClass; deleted: boolean } | undefined;
    return refusal(loc && !loc.deleted && loc.class !== cls ? "head_moved" : "head_gone");
  }
  const headId = String((await c.query(CHAIN_HEAD, [pending.of])).rows[0]?.id ?? pending.of);
  if (!locked.has(headId)) throw wait("head_changed");
  const head = (await c.query("SELECT id, version, is_current, space_id, owner_id, audience, deleted_at, hidden_at FROM records WHERE id = $1 FOR UPDATE", [headId])).rows[0];
  const loc = (await ctx.db.control.query("SELECT class, deleted, space_id FROM record_locations WHERE record_id = $1", [headId])).rows[0] as { class: DataClass; deleted: boolean; space_id: string } | undefined;
  if (!head || !loc || loc.deleted || head.deleted_at || head.hidden_at || !head.is_current) return refusal("head_gone");
  if (loc.class !== cls || String(head.space_id) !== space || String(loc.space_id) !== space) return refusal("head_moved");
  if (String(head.owner_id) !== String(me.owner_id)
      || await audienceOf(c, headId, String(head.audience)) !== await audienceOf(c, recordId, String(me.audience))) return refusal("head_changed");
  // a file whose conversion failed and was retried later must not push out a version added in the meantime
  if (retried && headId !== pending.of) return refusal("head_newer");
  const version = Number(head.version) + 1;
  await supersedeInTx(c, { id: recordId, prevId: headId, staleNote: SUPERSEDED_NOTE });
  await c.query("UPDATE records SET version = $2, supersedes_id = $3, attrs = attrs - 'version_pending' WHERE id = $1", [recordId, version, headId]);
  // placements of the head move to the new version only into spaces the uploader could write to at upload time
  if (pending.places.length)
    await c.query(`INSERT INTO record_placements (record_id, space_id, placed_by)
                   SELECT $1, space_id, placed_by FROM record_placements WHERE record_id = $2 AND space_id = ANY($3::uuid[]) ON CONFLICT DO NOTHING`,
                  [recordId, headId, pending.places]);
  return { kind: "superseded", head: headId, version, space };
}

/**
 * The undo of the carried org-review row is this holder's own compensation and runs without
 * the lock probe — also after the lock connection was lost. It is a compare-and-set: the pending record's row is locked
 * first, the lock every finisher takes first in decide(), so a holder that came after the loss has either committed —
 * then the version is in the chain and nothing is undone — or waits until the undo is over; and the head's row is changed
 * only while it still holds what the carry wrote: state `superseded` and a row of the new version that supersedes it.
 */
async function undoCarry(ctx: Ctx, cls: DataClass, head: string, next: string, prev: OrgReviewState): Promise<void> {
  await tx(recordsDb(ctx, cls), async (c) => {
    const me = (await c.query("SELECT supersedes_id FROM records WHERE id = $1 FOR UPDATE", [next])).rows[0] as { supersedes_id: string | null } | undefined;
    if (me && me.supersedes_id !== null) return;
    await tx(ctx.db.control, async (q) => {
      const row = (await q.query("SELECT state FROM org_reviews WHERE record_id = $1 FOR UPDATE", [head])).rows[0] as { state: OrgReviewState } | undefined;
      if (row?.state !== "superseded") return;
      if (!(await q.query("SELECT 1 FROM org_reviews WHERE record_id = $1 AND supersedes_id = $2", [next, head])).rowCount) return;
      await undoCarryOrgReview(q, head, next, prev);
    });
  });
}
