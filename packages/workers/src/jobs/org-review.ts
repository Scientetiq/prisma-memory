// Job org_review: hourly, at start, by a panel button
// (POST /admin/maintenance/org-review) and by hand (run-job.ts org_review). Part return — returning unconfirmed records
// of company knowledge by term to where they came from; part digest — the weekly mail to curators (only the mail queue,
// @memory/shared org-digest.ts; a manual admin send: the gateway's POST /admin/org-review/digest).
// The parts are apart: a test run wakes only the return, and no mail goes out then.
// Switch access.org_review_enabled = false — the job does nothing. The term is the DB now() (DUE_RETURNS_SQL without Node
// time); held Wrong marks are not returned by term. A busy record (class move, curator decision) — next time.
// Overdue ones — in pages of 200 with a cursor (term, id), up to 10 pages per pass: records with nowhere to return
// (author left) or busy stay in place and no longer block everything behind them.
// Also the narrowed-circle pickup: a record under review in org with scope participants only
// the gateway did not return on narrowing (it was busy) goes back where it came from, by memory's decision.
import {
  DUE_RETURNS_AFTER_SQL, DUE_RETURNS_SQL, log, NARROWED_OF_SQL, ORG_ACTIVE_UNITS_SQL, orgDigest, orgReviewEnabled, returnFromOrg, SCOPE_SYSTEM, tx, type DigestRun,
} from "@memory/shared";
import { auditWorker, type DbCtx } from "../ctx.ts";

const BATCH = 200;
/** Page cap per pass (2000 records): the rest — next pass in an hour; the job does not hold the worker. */
export const MAX_DUE_PAGES = 10;
export type OrgReviewPart = "return" | "digest" | "all";
/** Pass outcome: `returned` by term, `narrowed` narrowed-circle pickups; busy and nowhere-to-return — both kinds. */
export interface OrgReviewTick { returned: number; busy: number; no_target: number; narrowed?: number; skipped?: string; digest?: DigestRun | { failed: string } }

/** Overdue page: the first without cursor, the next strictly after the previous page's last row. */
async function duePage(ctx: DbCtx, after: { key: string; id: string } | null): Promise<Array<{ record_id: string; after_key: string }>> {
  return (await (after ? ctx.db.control.query(DUE_RETURNS_AFTER_SQL, [ctx.instanceId, BATCH, after.key, after.id])
                       : ctx.db.control.query(DUE_RETURNS_SQL, [ctx.instanceId, BATCH]))).rows;
}

/** Return by term: pages of overdue ones, each record under its own lock and transaction (returnFromOrg). */
export async function orgReturnsDue(ctx: DbCtx): Promise<Omit<OrgReviewTick, "digest">> {
  const out = { returned: 0, busy: 0, no_target: 0 };
  let after: { key: string; id: string } | null = null, pages = 0;
  while (pages < MAX_DUE_PAGES) {
    const rows = await duePage(ctx, after);
    pages++;
    await returnPage(ctx, rows.map((r) => r.record_id), out);
    if (rows.length < BATCH) break;
    const last = rows[rows.length - 1]!;
    after = { key: last.after_key, id: last.record_id };
  }
  if (out.returned || out.busy || out.no_target) log.info("org_returns", { ...out, pages });
  return out;
}

async function returnPage(ctx: DbCtx, due: string[], out: { returned: number; busy: number; no_target: number }): Promise<void> {
  for (const id of due) {
    try {
      const r = await returnFromOrg(ctx.db.control, (cls) => ctx.db.records(cls, SCOPE_SYSTEM),
                                    { recordId: id, instanceId: ctx.instanceId, actorId: null, by: "auto", final: "returned", expect: ["unreviewed"], due: true });
      if (r.status === "done") {
        out.returned++;
        // the author sees the return in My actions (details.author), signed memory (system + MEMORY_OPS)
        await auditWorker(ctx, { event_type: "promote", class: r.cls, record_ids: [id, ...r.ids.filter((x) => x !== id)], space_id: r.toSpaceId,
                                 details: { tool: "org_review", op: "org_return", by: "auto", from_space: r.orgSpaceId, to_space: r.toSlug, author: r.authorId, derived: r.derived } });
      } else if (r.status === "busy") out.busy++;
      else if (r.status === "no_target") out.no_target++;            // author left, nowhere to return — waits for a curator
    } catch (e) {
      log.warn("org_return_failed", { record_id: id, error: (e as Error).message.slice(0, 200) });
    }
  }
}

/** Record ids per check against the class DB in the narrowed-circle pickup. */
const NARROW_CHUNK = 1000;

/**
 * Narrowed-circle pickup: a meeting or its part lying in
 * org under review was narrowed (new attendees, a service resend or /ingest/access): the gateway at once
 * returns it to where it came from (leaveOrgNarrowed). If the record was busy then (class move, curator decision)
 * or the call failed, it would stay in org participants-only forever, and a held one title-hidden for curators outside the
 * circle. Hourly the job picks them up the same way (returnFromOrg): a memory decision (by system, reason
 * narrowed), to the author — in My actions signed memory. Scope people — in the class records DB, rows — in control.
 */
export async function orgNarrowedSweep(ctx: DbCtx): Promise<{ narrowed: number; busy: number; no_target: number }> {
  const out = { narrowed: 0, busy: 0, no_target: 0 };
  const units = (await ctx.db.control.query(ORG_ACTIVE_UNITS_SQL, [ctx.instanceId])).rows as Array<{ record_id: string; class: "open" | "closed" }>;
  const done = new Set<string>();
  for (const cls of ["open", "closed"] as const) {
    const ids = units.filter((u) => u.class === cls).map((u) => u.record_id);
    for (let i = 0; i < ids.length; i += NARROW_CHUNK) {
      const narrowed = (await ctx.db.records(cls, SCOPE_SYSTEM).query(NARROWED_OF_SQL, [ids.slice(i, i + NARROW_CHUNK)])).rows.map((r) => r.id as string);
      for (const id of narrowed) {
        if (done.has(id)) continue;                                    // went with the meeting tree earlier this pass
        try {
          const r = await returnFromOrg(ctx.db.control, (c) => ctx.db.records(c, SCOPE_SYSTEM),
                                        { recordId: id, instanceId: ctx.instanceId, actorId: null, by: "system", final: "returned" });
          if (r.status === "done") {
            out.narrowed++;
            for (const x of r.ids) done.add(x);
            await auditWorker(ctx, { event_type: "promote", class: r.cls, record_ids: [id, ...r.ids.filter((x) => x !== id)], space_id: r.toSpaceId,
                                     details: { tool: "org_review", op: "org_return", by: "system", reason: "narrowed", from_space: r.orgSpaceId, to_space: r.toSlug,
                                                author: r.authorId, derived: r.derived } });
          } else if (r.status === "busy") out.busy++;
          else if (r.status === "no_target") out.no_target++;
        } catch (e) {
          log.warn("org_narrowed_return_failed", { record_id: id, error: (e as Error).message.slice(0, 200) });
        }
      }
    }
  }
  if (out.narrowed || out.busy || out.no_target) log.info("org_narrowed_returns", out);
  return out;
}

/**
 * Job pass. Part digest: the mail to curators is only the mail queue (orgDigest: mail and the letter
 * on, the week slot window, something to review, dedupe of the week); queued — event admin `op: org_digest` (numbers, no
 * recipients by name) and a mail queue kick (`kickMail`: worker's mailTick pass). A mail fault does not undo returns.
 */
export async function orgReviewTick(ctx: DbCtx, part: OrgReviewPart = "all", o: { kickMail?: () => Promise<unknown>; now?: Date } = {}): Promise<OrgReviewTick> {
  await ctx.settings.load(true);
  if (!orgReviewEnabled(ctx.settings)) return { returned: 0, busy: 0, no_target: 0, skipped: "access.org_review_enabled = false" };
  const out: OrgReviewTick = part === "digest" ? { returned: 0, busy: 0, no_target: 0 } : await orgReturnsDue(ctx);
  if (part !== "digest") {
    // a failed narrowed pickup undoes neither the term return nor the mail
    const n = await orgNarrowedSweep(ctx).catch((e) => { log.warn("org_narrowed_sweep_failed", { error: (e as Error).message.slice(0, 200) }); return null; });
    out.narrowed = n?.narrowed ?? 0;
    if (n) { out.busy += n.busy; out.no_target += n.no_target; }
  }
  const state: Record<string, unknown> = { at: new Date().toISOString(), part, returned: out.returned, busy: out.busy, no_target: out.no_target,
                                           ...(part !== "digest" ? { narrowed: out.narrowed } : {}) };
  if (part !== "return") {
    try {
      const d = await orgDigest(ctx.db.control, ctx.instanceId, ctx.settings, { now: o.now });
      out.digest = d;
      Object.assign(state, { digest_week: d.week, digest_sent: d.queued, digest_skipped: d.skipped ?? null, digest_at: new Date().toISOString() });
      if (d.queued) {
        await auditWorker(ctx, { event_type: "admin", details: { tool: "org_review", op: "org_digest", week: d.week, recipients: d.recipients, queued: d.queued, waiting: d.waiting, held: d.held, manual: false } });
        await o.kickMail?.().catch((e) => log.warn("org_digest_mail_kick_failed", { error: (e as Error).message.slice(0, 200) }));
        log.info("org_digest", { week: d.week, queued: d.queued, waiting: d.waiting });
      }
    } catch (e) {
      out.digest = { failed: (e as Error).message.slice(0, 200) };
      log.warn("org_digest_failed", { error: (e as Error).message.slice(0, 200) });
    }
  }
  await ctx.db.control.query(
    `INSERT INTO maintenance_state (instance_id, key, value, updated_at) VALUES ($1, 'org_review', $2, now())
     ON CONFLICT (instance_id, key) DO UPDATE SET value = maintenance_state.value || EXCLUDED.value, updated_at = now()`,
    [ctx.instanceId, JSON.stringify(state)]);
  return out;
}

/**
 * A new version of an employee card from the org table (profilesSync): the old one has a review row (marked Wrong) —
 * the new version inherits it with the hold and the Wrong marks (cards follow the same
 * rules, without return). No row — nothing: the card is outside review.
 */
export async function inheritCardReview(control: import("pg").Pool, prevId: string, nextId: string): Promise<boolean> {
  return tx(control, async (q) => {
    const prev = (await q.query("SELECT 1 FROM org_reviews WHERE record_id = $1 FOR UPDATE", [prevId])).rowCount;
    if (!prev) return false;
    await q.query(
      `INSERT INTO org_reviews (record_id, instance_id, state, cycle, entered_via, entered_human, from_audience, exempt_kind, held_at, held_by, disputed_at, supersedes_id, returns)
       SELECT $2, instance_id, 'exempt', cycle, 'legacy', false, from_audience, 'org_card', held_at, held_by, disputed_at, $1, returns FROM org_reviews WHERE record_id = $1
       ON CONFLICT (record_id) DO NOTHING`, [prevId, nextId]);
    await q.query("UPDATE org_reviews SET state = 'superseded' WHERE record_id = $1", [prevId]);
    await q.query("UPDATE org_review_marks SET record_id = $2 WHERE record_id = $1 AND kind = 'wrong'", [prevId, nextId]);
    return true;
  });
}
