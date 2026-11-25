import { CHAIN_TREE, CHAIN_TREES, acceptedSettings, chainMemberSql, despiteVerdict, enqueueMail, joinedTexts, log, MAIL_RE, NFD_MARKS_SQL, ndaBaseline, ndaListDiff, ndaOnlySettings,
         ndaStillListed, newId, nfdSettings, OPEN_RECHECK_MAX_TRIES, OPEN_RECHECK_RETRY_GAP_MS, OPEN_RECHECK_STATE_KEY, OPEN_RECHECK_TAIL_MS,
         openCheckSettings, OpenCheckTimeout, openRecheckBatch, legacyCharsetOf, legacyScanCharsetsOf, openRecheckMailText, openTreeTexts, parseOpenCheckAccepted, recheckKinds, recheckMark, recheckRules,
         runOpenCheck, s3GetBuffer, smtpConfig, tx, LockConnectionLost, watchLock, type OpenCheckFinding, type OpenCheckSettings, type OpenCheckUnchecked, type OpenRecheckReason,
         type OpenRecheckWhy } from "@memory/shared";
import { auditWorker, recordsDb, type Ctx, type DbCtx } from "../ctx.ts";
import type { Every } from "./admin-plane.ts";
import type { PurgeCtx } from "./maintenance.ts";

export const OPEN_RECHECK_QUEUE = "open_recheck";
const LOCK = (instanceId: string) => `open_recheck:${instanceId}`;
const RETRY_UNCHECKED: ReadonlySet<OpenCheckUnchecked> = new Set(["tree_too_large", "original_unavailable", "original_too_large", "check_failed", "timeout", "busy"]);
export const OPEN_RECHECK_RUNJOB_GAP_MS = 2 * 60_000;
const FALLBACK_HELD = "COALESCE(r.attrs -> 'conversion' ->> 'error_kind', '') = 'open_check_fallback_failed'";

export interface RecheckCounts { checked: number; held: number; on_restore: number; busy: number; unchecked: number; failed: number; reopened: number; released: number; skipped: number }
const ZERO: RecheckCounts = { checked: 0, held: 0, on_restore: 0, busy: 0, unchecked: 0, failed: 0, reopened: 0, released: 0, skipped: 0 };
interface RunRow { id: string; reason: OpenRecheckReason; names: string[]; phase: "scan" | "tail" | "retry" | "done"; cursor_id: string | null; tail_from: Date;
  counts: RecheckCounts; report: { spaces?: string[]; entities?: string[] }; created_by: string | null }
type RecheckCtx = DbCtx & { alive?: () => Promise<void> };
type Ctxish = PurgeCtx & RecheckCtx & { boss?: Ctx["boss"] };
export interface RecheckOpts { pauseMs?: number; budgetMs?: number; retryGapMs?: number }
type Q = { query: DbCtx["db"]["control"]["query"] };
type Rec = { id: string; owner_id: string; space_id: string; deleted: boolean; hidden?: boolean };
type Batch = Rec[] & { last?: string | null; full?: boolean };

interface RecheckState { baseline?: string[]; last?: Record<string, unknown> }
async function readState(ctx: DbCtx): Promise<RecheckState> {
  const v = (await ctx.db.control.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = $2", [ctx.instanceId, OPEN_RECHECK_STATE_KEY])).rows[0]?.value;
  return v && typeof v === "object" ? v as RecheckState : {};
}
async function patchState(ctx: DbCtx, patch: RecheckState): Promise<void> {
  await ctx.db.control.query(
    `INSERT INTO maintenance_state (instance_id, key, value, updated_at) VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (instance_id, key) DO UPDATE SET value = maintenance_state.value || EXCLUDED.value, updated_at = now()`,
    [ctx.instanceId, OPEN_RECHECK_STATE_KEY, JSON.stringify(patch)]);
}

const currentList = (ctx: DbCtx): unknown[] => { const v = openCheckSettings(ctx.settings).nda_customers; return Array.isArray(v) ? v : []; };

async function freshSettings(ctx: DbCtx): Promise<boolean> {
  try { await ctx.settings.load(true); return true; }
  catch (e) {
    log.warn("open_recheck_settings_stale", { error: String((e as Error)?.message ?? e).slice(0, 120) });
    return false;
  }
}

async function runningRun(ctx: DbCtx): Promise<RunRow | null> {
  const r = (await ctx.db.control.query(
    "SELECT id, reason, names, phase, cursor_id, tail_from, counts, report, created_by FROM open_rechecks WHERE instance_id = $1 AND state = 'running'", [ctx.instanceId])).rows[0];
  return r ? { ...r, counts: { ...ZERO, ...(r.counts ?? {}) }, report: r.report ?? {}, names: Array.isArray(r.names) ? r.names : [] } as RunRow : null;
}

export async function startRecheck(ctx: DbCtx, reason: OpenRecheckReason, names: readonly string[], createdBy: string | null = null): Promise<string | null> {
  const id = newId();
  try {
    await ctx.db.control.query(
      `INSERT INTO open_rechecks (id, instance_id, reason, names, tail_from, created_by) VALUES ($1, $2, $3, $4::jsonb, now() - make_interval(secs => $5::int), $6)`,
      [id, ctx.instanceId, reason, JSON.stringify(names), Math.round(OPEN_RECHECK_TAIL_MS / 1000), createdBy]);
  } catch (e) {
    if ((e as { code?: string })?.code === "23505") return null;
    throw e;
  }
  await auditWorker(ctx, { event_type: "admin", record_ids: [], details: { op: "open_recheck_start", run: id, reason, added: reason === "added" ? names.length : null, by: createdBy ? "admin" : "auto" } });
  log.info("open_recheck_started", { run: id, reason, names: names.length });
  return id;
}

export async function noticeListChange(ctx: DbCtx): Promise<{ baseline: "set" | "same" | "updated" | "deferred"; run: string | null; added: number }> {
  // Also repair historical rows restored from backups made before name cleanup.
  await ctx.db.control.query("UPDATE open_rechecks SET names = '[]'::jsonb WHERE instance_id = $1 AND state <> 'running' AND names <> '[]'::jsonb", [ctx.instanceId]);
  const st = await readState(ctx), list = currentList(ctx);
  if (!Array.isArray(st.baseline)) {
    await patchState(ctx, { baseline: ndaBaseline(list) });
    log.info("open_recheck_baseline", { names: ndaBaseline(list).length });
    return { baseline: "set", run: null, added: 0 };
  }
  const diff = ndaListDiff(st.baseline, list);
  if (!diff.added.length && !diff.removed) return { baseline: "same", run: null, added: 0 };
  const on = ctx.settings.get<unknown>("open_check.recheck_on_nda_change", true) !== false;
  if (diff.added.length && on) {
    if (await runningRun(ctx)) return { baseline: "deferred", run: null, added: diff.added.length };
    const run = await startRecheck(ctx, "added", diff.added);
    if (!run) return { baseline: "deferred", run: null, added: diff.added.length };
    await patchState(ctx, { baseline: diff.baseline });
    return { baseline: "updated", run, added: diff.added.length };
  }
  await patchState(ctx, { baseline: diff.baseline });
  return { baseline: "updated", run: null, added: on ? 0 : diff.added.length };
}

function runSettings(ctx: DbCtx, run: RunRow): OpenCheckSettings | null {
  const base = openCheckSettings(ctx.settings);
  if (run.reason === "nfd" || run.reason === "held") return nfdSettings(base);
  const names = run.reason === "added" ? ndaStillListed(run.names, currentList(ctx)) : currentList(ctx).filter((n): n is string => typeof n === "string");
  return names.length ? ndaOnlySettings(base, names) : null;
}

const whyOf = (run: Pick<RunRow, "reason">, unchecked: boolean): OpenRecheckWhy => unchecked ? "unchecked" : run.reason === "nfd" ? "rules" : "nda";

type Verdict = { kind: "clean" } | { kind: "match"; found: OpenCheckFinding[] } | { kind: "unchecked"; why: OpenCheckUnchecked } | { kind: "skip" };

async function consentSettings(ctx: DbCtx, id: string, cls: "open" | "closed", settings: OpenCheckSettings): Promise<OpenCheckSettings> {
  const r = (await recordsDb(ctx, cls).query("SELECT owner_id, space_id, attrs -> 'open_check_accepted' AS accepted FROM records WHERE id = $1", [id])).rows[0];
  const acc = parseOpenCheckAccepted(r?.accepted);
  if (!r || !acc?.rules.length) return settings;
  const own = (await ctx.db.control.query("SELECT 1 FROM spaces WHERE id = $1 AND kind = 'personal' AND owner_id = $2", [r.space_id, r.owner_id])).rowCount;
  const scope = own ? acc.scope ?? "solo" : "shared";
  const rules = acc.rules.filter((rule) => despiteVerdict(rule, scope) === "ok");
  return rules.length ? acceptedSettings(settings, rules) : settings;
}

async function evaluate(ctx: Ctxish, id: string, o: { deleted: boolean; settings: OpenCheckSettings; run: string; cls?: "open" | "closed"; consent?: boolean }): Promise<Verdict> {
  const cls = o.cls ?? "open";
  const s3 = typeof ctx.s3 === "function" ? ctx.s3(cls) : null;
  const tree = await openTreeTexts({ records: recordsDb(ctx, cls), control: ctx.db.control, original: s3 ? (key) => s3GetBuffer(s3, key) : undefined, legacyCharset: legacyCharsetOf(ctx.settings), scanCharsets: legacyScanCharsetsOf(ctx.settings) }, id, { live: !o.deleted });
  if (tree.unchecked && RETRY_UNCHECKED.has(tree.unchecked)) return { kind: "unchecked", why: tree.unchecked };
  const j = joinedTexts(tree.texts);
  const settings = o.consent ? await consentSettings(ctx, id, cls, o.settings) : o.settings;
  await ctx.alive?.();
  try {
    const found = j.map(await runOpenCheck(settings, j.texts, { owner: `recheck:${o.run}` }));
    return found.length ? { kind: "match", found } : tree.unchecked === "conversion_pending" && !tree.texts.length ? { kind: "skip" } : { kind: "clean" };
  } catch (e) {
    if (e instanceof OpenCheckTimeout) return { kind: "unchecked", why: e.why === "timeout" ? "timeout" : "busy" };
    log.warn("open_recheck_check_failed", { run: o.run, error: String((e as Error)?.message ?? e).slice(0, 120) });
    return { kind: "unchecked", why: "check_failed" };
  }
}

const kindsOf = (h: { state: string; why: string | null; found?: OpenCheckFinding[] }): string[] =>
  [...new Set([...recheckKinds(h.found ?? []), ...(h.why === "unchecked" && h.state !== "pending" ? ["unchecked"] : [])])].sort();

async function putHold(ctx: RecheckCtx, run: string, rec: { id: string; space_id?: string | null; owner_id?: string | null }, h: {
  state: string; why: string | null; found?: OpenCheckFinding[]; moveId?: string | null; attempts?: number }, q: Q = ctx.db.control): Promise<void> {
  await ctx.alive?.();
  await q.query(
    `INSERT INTO open_recheck_holds (run_id, record_id, instance_id, state, why, kinds, rules, move_id, attempts, space_id, owner_id, held_at)
     VALUES ($1, $2, $3, $4, $5, $6::text[], $7::text[], $8, $9, $10, $11, CASE WHEN $4 IN ('held','on_restore') THEN now() END)
     ON CONFLICT (run_id, record_id) DO UPDATE SET state = EXCLUDED.state, why = EXCLUDED.why, kinds = EXCLUDED.kinds, rules = EXCLUDED.rules,
       move_id = COALESCE(EXCLUDED.move_id, open_recheck_holds.move_id), attempts = EXCLUDED.attempts,
       space_id = COALESCE(EXCLUDED.space_id, open_recheck_holds.space_id), owner_id = COALESCE(EXCLUDED.owner_id, open_recheck_holds.owner_id),
       held_at = COALESCE(EXCLUDED.held_at, open_recheck_holds.held_at), updated_at = now()`,
    [run, rec.id, ctx.instanceId, h.state, h.why, kindsOf(h), recheckRules(h.found ?? []), h.moveId ?? null, h.attempts ?? 1,
     rec.space_id ?? null, rec.owner_id ?? null]);
}

async function curatorLine(ctx: DbCtx, id: string): Promise<void> {
  try {
    const n = (await ctx.db.control.query(
      `UPDATE org_reviews SET disputed_at = COALESCE(disputed_at, now()), updated_at = now()
        WHERE record_id = $1 AND state IN ('unreviewed','confirmed','community','exempt')`, [id])).rowCount ?? 0;
    if (!n)
      await ctx.db.control.query(
        `INSERT INTO org_reviews (record_id, instance_id, state, entered_via, entered_human, disputed_at) VALUES ($1, $2, 'confirmed', 'legacy', false, now())
         ON CONFLICT (record_id) DO NOTHING`, [id, ctx.instanceId]);
  } catch (e) {
    log.warn("open_recheck_curator_line_failed", { record_id: id, error: String((e as Error)?.message ?? e).slice(0, 120) });
  }
}

async function closeRecord(ctx: Ctxish, run: RunRow, id: string, found: OpenCheckFinding[], unchecked: boolean): Promise<"held" | "busy" | "gone" | "deleted"> {
  const open = recordsDb(ctx, "open");
  const got = await tx(ctx.db.control, async (q) => {
    if (!(await q.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok", [`record:${id}`])).rows[0]?.ok) return "busy" as const;
    const loc = (await q.query("SELECT class, deleted FROM record_locations WHERE record_id = $1", [id])).rows[0];
    if (!loc || loc.class !== "open") return "gone" as const;
    if (loc.deleted) return "deleted" as const;
    const cur = (await open.query("SELECT owner_id, space_id, deleted_at IS NOT NULL AS deleted, hidden_at IS NOT NULL AS hidden FROM records WHERE id = $1", [id])).rows[0];
    if (!cur) return "gone" as const;
    if (cur.deleted) return "deleted" as const;
    if (cur.hidden) return "busy" as const;
    if ((await q.query("SELECT 1 FROM class_moves WHERE record_id = $1 AND status IN ('pending','copying','verifying')", [id])).rowCount) return "busy" as const;
    const moveId = newId();
    await ctx.alive?.();
    await q.query("INSERT INTO class_moves (id, record_id, from_class, to_class, requested_by, via) VALUES ($1, $2, 'open', 'closed', $3, 'nda_recheck')", [moveId, id, cur.owner_id]);
    const mark = recheckMark(found, { moveId, run: run.id, unchecked });
    await ctx.alive?.();
    await open.query("UPDATE records SET attrs = COALESCE(attrs, '{}'::jsonb) || jsonb_build_object('open_check_fallback', $2::jsonb) WHERE id = $1", [id, JSON.stringify(mark)]);
    return { moveId, space: cur.space_id as string, owner: cur.owner_id as string, mark };
  });
  if (typeof got === "string") return got;
  await ctx.alive?.();
  await open.query(`${CHAIN_TREE} UPDATE records SET hidden_at = now() WHERE id IN (SELECT id FROM tree) AND hidden_at IS NULL`, [id])
    .catch((e) => log.warn("open_recheck_hide_deferred", { record_id: id, error: (e as Error).message.slice(0, 120) }));
  const why = whyOf(run, unchecked);
  await putHold(ctx, run.id, { id, space_id: got.space, owner_id: got.owner }, { state: "held", why, found, moveId: got.moveId, attempts: OPEN_RECHECK_MAX_TRIES });
  const org = (await ctx.db.control.query("SELECT kind = 'org' AS org FROM spaces WHERE id = $1", [got.space])).rows[0]?.org === true;
  await ctx.alive?.();
  if (org) await curatorLine(ctx, id);
  await ctx.alive?.();
  await auditWorker(ctx, { event_type: "class_move", class: "open", record_ids: [id], space_id: got.space,
    details: { job: "open_recheck", op: "close", move_id: got.moveId, via: "nda_recheck", why, by: "auto", run: run.id } });
  await ctx.alive?.();
  await auditWorker(ctx, { event_type: "processing", class: "open", record_ids: [id], space_id: got.space,
    details: { op: "open_recheck_held", via: "nda_recheck", why, run: run.id, reason: run.reason, kinds: got.mark.kinds, rules: got.mark.rules, author: got.owner,
               ...(unchecked ? { unchecked: true } : {}), ...(org ? { org: true } : {}) } });
  await ctx.alive?.();
  if (ctx.boss) await ctx.boss.send("kick", { class: "open", record_id: id, lane: "now" }, { priority: 10, singletonKey: `${id}:now`, retryLimit: 3, expireInSeconds: 900 } as any)
    .catch((e: Error) => log.warn("open_recheck_kick_failed", { record_id: id, error: e.message.slice(0, 120) }));
  return "held";
}

async function holdOnRestore(ctx: Ctxish, run: RunRow, rec: Rec, found: OpenCheckFinding[], unchecked: boolean, attempt: number): Promise<"on_restore" | "live" | "busy" | "gone"> {
  return tx(ctx.db.control, async (q) => {
    if (!(await q.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok", [`record:${rec.id}`])).rows[0]?.ok) return "busy" as const;
    const loc = (await q.query("SELECT class, deleted FROM record_locations WHERE record_id = $1", [rec.id])).rows[0];
    if (!loc || loc.class !== "open") return "gone" as const;
    const row = (await recordsDb(ctx, "open").query("SELECT deleted_at IS NOT NULL AS deleted FROM records WHERE id = $1", [rec.id])).rows[0];
    if (!row) return "gone" as const;
    if (!loc.deleted && !row.deleted) return "live" as const;
    await putHold(ctx, run.id, rec, { state: "on_restore", why: whyOf(run, unchecked), found, attempts: attempt }, q);
    return "on_restore" as const;
  });
}

async function onRestoreEvent(ctx: RecheckCtx, run: RunRow, rec: Rec, found: OpenCheckFinding[], unchecked: boolean): Promise<void> {
  await ctx.alive?.();
  await auditWorker(ctx, { event_type: "processing", class: "open", record_ids: [rec.id], space_id: rec.space_id,
    details: { op: "open_recheck_on_restore", via: "nda_recheck", why: whyOf(run, unchecked), run: run.id, kinds: recheckKinds(found), rules: recheckRules(found), author: rec.owner_id } });
}

async function trashedParts(ctx: Ctxish, run: RunRow, root: Rec, settings: OpenCheckSettings): Promise<number> {
  const parts = (await recordsDb(ctx, "open").query(
    `${CHAIN_TREE} SELECT r.id, r.owner_id, r.space_id FROM records r WHERE r.id IN (SELECT id FROM tree) AND r.id <> $1 AND r.deleted_at IS NOT NULL AND r.deleted_batch = r.id ORDER BY r.id`,
    [root.id])).rows as Array<{ id: string; owner_id: string; space_id: string }>;
  let n = 0;
  for (const p of parts) {
    const v = await evaluate(ctx, p.id, { deleted: true, settings, run: run.id, consent: run.reason === "nfd" });
    if (v.kind !== "match" && v.kind !== "unchecked") continue;
    const found = v.kind === "match" ? v.found : [], unchecked = v.kind === "unchecked";
    const part: Rec = { ...p, deleted: true };
    const out = await holdOnRestore(ctx, run, part, found, unchecked, 1);
    if (out === "on_restore") { n++; await onRestoreEvent(ctx, run, part, found, unchecked); continue; }
    if (out === "live") {
      const again = await evaluate(ctx, root.id, { deleted: false, settings, run: run.id, consent: run.reason === "nfd" });
      if (again.kind === "match") await closeRecord(ctx, run, root.id, again.found, false);
    }
  }
  return n;
}

async function settle(ctx: Ctxish, run: RunRow, rec: Rec, v: Verdict, attempt: number, settings: OpenCheckSettings): Promise<keyof RecheckCounts | null> {
  await ctx.alive?.();
  if (v.kind === "skip" || v.kind === "clean") {
    if (v.kind === "clean" && attempt > 1) await ctx.db.control.query("DELETE FROM open_recheck_holds WHERE run_id = $1 AND record_id = $2 AND state = 'pending'", [run.id, rec.id]);
    if (!rec.deleted) run.counts.on_restore += await trashedParts(ctx, run, rec, settings);
    return v.kind === "skip" ? "skipped" : null;
  }
  const unchecked = v.kind === "unchecked";
  if (unchecked && attempt < OPEN_RECHECK_MAX_TRIES) {
    await putHold(ctx, run.id, rec, { state: "pending", why: "unchecked", attempts: attempt });
    return null;
  }
  const found = v.kind === "match" ? v.found : [];
  if (rec.deleted) {
    const out = await holdOnRestore(ctx, run, rec, found, unchecked, attempt);
    if (out === "on_restore") { await onRestoreEvent(ctx, run, rec, found, unchecked); return "on_restore"; }
    if (out === "gone") { await ctx.db.control.query("DELETE FROM open_recheck_holds WHERE run_id = $1 AND record_id = $2 AND state = 'pending'", [run.id, rec.id]); return null; }
    if (out === "live") return settle(ctx, run, { ...rec, deleted: false }, await evaluate(ctx, rec.id, { deleted: false, settings, run: run.id, consent: run.reason === "nfd" }), attempt, settings);
    return busyRetry(ctx, run, rec, found, attempt);
  }
  const out = await closeRecord(ctx, run, rec.id, found, unchecked);
  if (out === "held") return unchecked ? "unchecked" : "held";
  if (out === "gone") { await ctx.db.control.query("DELETE FROM open_recheck_holds WHERE run_id = $1 AND record_id = $2 AND state = 'pending'", [run.id, rec.id]); return null; }
  if (out === "deleted") return settle(ctx, run, { ...rec, deleted: true }, v, attempt, settings);
  return busyRetry(ctx, run, rec, found, attempt);
}

async function busyRetry(ctx: DbCtx, run: RunRow, rec: Rec, found: OpenCheckFinding[], attempt: number): Promise<keyof RecheckCounts | null> {
  if (attempt < OPEN_RECHECK_MAX_TRIES) { await putHold(ctx, run.id, rec, { state: "pending", why: "busy", found, attempts: attempt }); return attempt === 1 ? "busy" : null; }
  await putHold(ctx, run.id, rec, { state: "failed", why: "busy", found, attempts: attempt });
  return "failed";
}

const bump = (c: RecheckCounts, k: keyof RecheckCounts | null): void => { if (k) c[k]++; };

async function saveRun(ctx: RecheckCtx, run: RunRow): Promise<void> {
  await ctx.alive?.();
  await ctx.db.control.query("UPDATE open_rechecks SET phase = $2, cursor_id = $3, counts = $4::jsonb, report = $5::jsonb, updated_at = now() WHERE id = $1",
                             [run.id, run.phase, run.cursor_id, JSON.stringify(run.counts), JSON.stringify(run.report)]);
}

async function nfdMarked(ctx: DbCtx, rows: Rec[]): Promise<Rec[]> {
  if (!rows.length) return rows;
  const marked = new Set((await recordsDb(ctx, "open").query(
    `${CHAIN_TREES} SELECT DISTINCT t.start FROM tree t JOIN records r ON r.id = t.id LEFT JOIN record_content c ON c.record_id = r.id
      WHERE r.title ~ $2 OR c.text ~ $2`, [rows.map((r) => r.id), NFD_MARKS_SQL])).rows.map((r) => r.start as string));
  return rows.filter((r) => marked.has(r.id));
}

async function withActiveHold(ctx: DbCtx, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  return new Set((await ctx.db.control.query(
    "SELECT DISTINCT record_id FROM open_recheck_holds WHERE instance_id = $1 AND record_id = ANY($2::uuid[]) AND state IN ('held','kept','on_restore')",
    [ctx.instanceId, ids])).rows.map((r) => r.record_id as string));
}

/**
 * Roots of the open class after the cursor: visible to agents, in the trash and hidden by someone else's close (such a close
 * may fail and show the rows again — they are retried as busy, not skipped); older versions of a chain (agent note or
 * document, chainMemberSql) are checked with their head. Documents hidden by the fallback path (FALLBACK_HELD) are not
 * visible to agents until fully checked — not taken. `last` / `full` refer to the whole batch of roots (the Mac-letters
 * pass keeps only the marked ones).
 */
async function scanBatch(ctx: DbCtx, run: RunRow, batch: number): Promise<Batch> {
  const rows = (await recordsDb(ctx, "open").query(
    `SELECT r.id, r.owner_id, r.space_id, r.deleted_at IS NOT NULL AS deleted, r.hidden_at IS NOT NULL AS hidden FROM records r
      WHERE r.parent_id IS NULL AND ($1::uuid IS NULL OR r.id > $1::uuid)
        AND NOT (${chainMemberSql("r")} AND r.superseded_by_id IS NOT NULL)
        AND (r.hidden_at IS NULL OR NOT ${FALLBACK_HELD})
      ORDER BY r.id LIMIT $2`, [run.cursor_id, batch])).rows as Rec[];
  const last = rows[rows.length - 1]?.id ?? null, full = rows.length === batch;
  const picked = run.reason === "nfd" ? await nfdMarked(ctx, rows) : rows;
  const active = await withActiveHold(ctx, picked.filter((r) => r.hidden && !r.deleted).map((r) => r.id));
  return Object.assign(picked.filter((r) => !active.has(r.id)), { last, full });
}

async function tailBatch(ctx: DbCtx, run: RunRow, batch: number): Promise<Batch> {
  const ids = (await ctx.db.control.query(
    `SELECT DISTINCT m.record_id FROM class_moves m
      WHERE ((m.to_class = 'open' AND m.status = 'done') OR (m.to_class = 'closed' AND m.status = 'failed' AND m.via IS DISTINCT FROM 'nda_recheck'))
        AND m.finished_at >= $1 AND ($2::uuid IS NULL OR m.record_id > $2::uuid)
        AND NOT EXISTS (SELECT 1 FROM open_recheck_holds h WHERE h.run_id = $4 AND h.record_id = m.record_id AND h.state IN ('held','on_restore'))
      ORDER BY m.record_id LIMIT $3`, [run.tail_from, run.cursor_id, batch, run.id])).rows.map((r) => r.record_id as string);
  if (!ids.length) return Object.assign([] as Rec[], { last: null, full: false });
  const rows = (await recordsDb(ctx, "open").query(
    `SELECT r.id, r.owner_id, r.space_id, r.deleted_at IS NOT NULL AS deleted, r.hidden_at IS NOT NULL AS hidden FROM records r
      WHERE r.id = ANY($1::uuid[]) AND (r.hidden_at IS NULL OR NOT ${FALLBACK_HELD}) ORDER BY r.id`, [ids])).rows as Rec[];
  const picked = run.reason === "nfd" ? await nfdMarked(ctx, rows) : rows;
  const active = await withActiveHold(ctx, picked.filter((r) => r.hidden && !r.deleted).map((r) => r.id));
  return Object.assign(picked.filter((r) => !active.has(r.id)), { last: ids[ids.length - 1]!, full: ids.length === batch });
}

async function hiddenNow(ctx: DbCtx, run: RunRow, rec: Rec): Promise<keyof RecheckCounts | null> {
  await putHold(ctx, run.id, rec, { state: "pending", why: "busy", attempts: 1 });
  return "busy";
}

async function heldBatch(ctx: Ctxish, run: RunRow, batch: number, settings: OpenCheckSettings): Promise<number> {
  const rows = (await ctx.db.control.query(
    `SELECT * FROM (SELECT DISTINCT ON (h.record_id) h.record_id, h.owner_id, h.space_id, h.state FROM open_recheck_holds h
                     WHERE h.instance_id = $1 AND h.run_id <> $2 AND ($3::uuid IS NULL OR h.record_id > $3::uuid)
                     ORDER BY h.record_id, h.updated_at DESC) x
      WHERE x.state IN ('held','on_restore') ORDER BY x.record_id LIMIT $4`, [ctx.instanceId, run.id, run.cursor_id, batch])).rows;
  const gone = (id: string) => ctx.db.control.query("UPDATE open_recheck_holds SET state = 'gone', updated_at = now() WHERE record_id = $1 AND state IN ('held','kept','on_restore')", [id]);
  for (const h of rows) {
    await ctx.alive?.();
    run.cursor_id = h.record_id;
    const loc = (await ctx.db.control.query("SELECT class, deleted, owner_id, space_id FROM record_locations WHERE record_id = $1", [h.record_id])).rows[0];
    if (!loc) { await gone(h.record_id); continue; }
    if (h.state === "on_restore") {
      if (loc.class !== "open" || !loc.deleted) continue;
      run.counts.checked++;
      if ((await evaluate(ctx, h.record_id, { deleted: true, settings, run: run.id })).kind !== "clean") continue;
      await ctx.alive?.();
      const done = await tx(ctx.db.control, async (q) => {
        if (!(await q.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok", [`record:${h.record_id}`])).rows[0]?.ok) return null;
        return (await q.query("UPDATE open_recheck_holds SET state = 'released', updated_at = now() WHERE record_id = $1 AND state = 'on_restore'", [h.record_id])).rowCount ?? 0;
      });
      if (done === null) run.counts.busy++;
      else if (done) run.counts.released++;
      continue;
    }
    if (loc.class !== "closed" || loc.deleted) continue;
    const ownClose = async (q: Q) => {
      const last = (await q.query(`SELECT via, to_class FROM class_moves WHERE record_id = $1 AND status = 'done' ORDER BY finished_at DESC NULLS LAST, requested_at DESC LIMIT 1`,
                                  [h.record_id])).rows[0];
      return last?.via === "nda_recheck" && last.to_class === "closed" && (!h.owner_id || h.owner_id === loc.owner_id) && (!h.space_id || h.space_id === loc.space_id);
    };
    if (!(await ownClose(ctx.db.control))) { await gone(h.record_id); continue; }
    run.counts.checked++;
    const v = await evaluate(ctx, h.record_id, { deleted: false, settings, run: run.id, cls: "closed" });
    if (v.kind !== "clean") continue;
    await ctx.alive?.();
    const moveId = await tx(ctx.db.control, async (q) => {
      if (!(await q.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok", [`record:${h.record_id}`])).rows[0]?.ok) return null;
      if ((await q.query("SELECT 1 FROM class_moves WHERE record_id = $1 AND status IN ('pending','copying','verifying')", [h.record_id])).rowCount) return null;
      const now = (await q.query("SELECT class, deleted, owner_id, space_id FROM record_locations WHERE record_id = $1", [h.record_id])).rows[0];
      if (!now || now.class !== "closed" || now.deleted || now.owner_id !== loc.owner_id || !(await ownClose(q))) return "changed" as const;
      const id = newId();
      await q.query("INSERT INTO class_moves (id, record_id, from_class, to_class, requested_by, via) VALUES ($1, $2, 'closed', 'open', $3, 'nda_recheck')", [id, h.record_id, loc.owner_id]);
      return id;
    });
    if (moveId === "changed") continue;
    if (!moveId) { run.counts.busy++; continue; }
    run.counts.reopened++;
    await ctx.alive?.();
    await auditWorker(ctx, { event_type: "class_move", class: "closed", record_ids: [h.record_id], space_id: h.space_id,
      details: { job: "open_recheck", op: "open", move_id: moveId, via: "nda_recheck", by: "auto", author: loc.owner_id, run: run.id } });
    await ctx.alive?.();
    if (ctx.boss) await ctx.boss.send("kick", { class: "closed", record_id: h.record_id, lane: "now" }, { priority: 10, singletonKey: `${h.record_id}:now`, retryLimit: 3, expireInSeconds: 900 } as any).catch(() => undefined);
  }
  return rows.length;
}

async function retryPending(ctx: Ctxish, run: RunRow, settings: OpenCheckSettings, batch: number, gapMs: number): Promise<number> {
  const rows = (await ctx.db.control.query(
    `SELECT record_id, attempts FROM open_recheck_holds WHERE run_id = $1 AND state = 'pending' AND updated_at <= now() - make_interval(secs => $2::double precision)
      ORDER BY record_id LIMIT $3`, [run.id, gapMs / 1000, batch])).rows;
  for (const p of rows) {
    await ctx.alive?.();
    const rec = (await recordsDb(ctx, "open").query("SELECT id, owner_id, space_id, deleted_at IS NOT NULL AS deleted, hidden_at IS NOT NULL AS hidden FROM records WHERE id = $1",
                                                    [p.record_id])).rows[0] as Rec | undefined;
    const attempt = Number(p.attempts) + 1;
    if (!rec) { await ctx.db.control.query("UPDATE open_recheck_holds SET state = 'gone', updated_at = now() WHERE run_id = $1 AND record_id = $2", [run.id, p.record_id]); continue; }
    if (rec.hidden && !rec.deleted) {
      if (attempt < OPEN_RECHECK_MAX_TRIES) { await putHold(ctx, run.id, { id: p.record_id }, { state: "pending", why: "busy", attempts: attempt }); continue; }
      await putHold(ctx, run.id, { id: p.record_id }, { state: "failed", why: "busy", attempts: attempt });
      run.counts.failed++;
      continue;
    }
    const v = await evaluate(ctx, rec.id, { deleted: rec.deleted, settings, run: run.id, consent: run.reason === "nfd" });
    bump(run.counts, await settle(ctx, run, rec, v, attempt, settings));
  }
  return Number((await ctx.db.control.query("SELECT count(*)::int AS n FROM open_recheck_holds WHERE run_id = $1 AND state = 'pending'", [run.id])).rows[0]?.n ?? 0);
}

async function reportSpaces(ctx: RecheckCtx, run: RunRow, settings: OpenCheckSettings): Promise<void> {
  const spaces: string[] = [], entities: string[] = [];
  const check = async (texts: Array<{ field: string; value: string | null }>) => {
    await ctx.alive?.();
    try { return (await runOpenCheck(settings, texts, { owner: `recheck:${run.id}` })).length > 0; } catch { return false; }
  };
  for (const s of (await ctx.db.control.query("SELECT id, name, description FROM spaces WHERE instance_id = $1 AND kind <> 'personal' AND archived_at IS NULL ORDER BY id",
                                               [ctx.instanceId])).rows)
    if (await check([{ field: "name", value: s.name }, { field: "description", value: s.description }])) spaces.push(s.id);
  for (const e of (await ctx.db.control.query("SELECT id, display_name FROM entities WHERE instance_id = $1 AND kind IN ('company','deal') ORDER BY id", [ctx.instanceId])).rows)
    if (await check([{ field: "entities", value: e.display_name }])) entities.push(e.id);
  run.report = { spaces, entities };
}

async function finishRun(ctx: RecheckCtx, run: RunRow): Promise<void> {
  const c = run.counts, spaces = run.report.spaces?.length ?? 0, entities = run.report.entities?.length ?? 0;
  await ctx.alive?.();
  await ctx.db.control.query("UPDATE open_rechecks SET phase = 'done', state = 'done', names = '[]'::jsonb, counts = $2::jsonb, report = $3::jsonb, finished_at = now(), updated_at = now() WHERE id = $1",
                             [run.id, JSON.stringify(c), JSON.stringify(run.report)]);
  const last = { run: run.id, reason: run.reason, at: new Date().toISOString(), ...c, spaces, entities };
  await ctx.alive?.();
  await patchState(ctx, { last });
  const hidden = c.held + c.unchecked, alert = hidden + c.failed;
  await ctx.alive?.();
  await auditWorker(ctx, { event_type: "admin", record_ids: [], details: { op: "open_recheck_done", run: run.id, reason: run.reason, ...c, spaces, entities,
                                                                        ...(alert ? { code: "open_recheck_held", count: alert } : {}) } });
  log.info("open_recheck_done", { run: run.id, reason: run.reason, ...c, spaces, entities });
  if (!alert && !c.on_restore && !spaces && !entities) return;
  const cfg = smtpConfig(ctx.settings);
  if (!cfg.enabled || !MAIL_RE.test(cfg.admin_email)) return;
  await ctx.alive?.();
  await enqueueMail(ctx.db.control, ctx.instanceId, { kind: "alert", to: cfg.admin_email,
    ...openRecheckMailText({ checked: c.checked, held: hidden, unchecked: c.unchecked, failed: c.failed, onRestore: c.on_restore, spaces, entities, reason: run.reason }),
    dedupeKey: `open_recheck:${run.id}` })
    .then(async () => {
      await ctx.alive?.();
      await ctx.db.control.query("UPDATE open_rechecks SET mailed_at = now() WHERE id = $1", [run.id]);
    })
    .catch((e) => {
      if (e instanceof LockConnectionLost) throw e;
      log.warn("open_recheck_mail_failed", { run: run.id, error: (e as Error).message.slice(0, 120) });
    });
}

export async function stepRecheck(ctx: Ctxish, run: RunRow, o: RecheckOpts = {}): Promise<"more" | "wait" | "done"> {
  await ctx.alive?.();
  if (!(await freshSettings(ctx))) return "wait";
  if (run.reason === "added") {
    const names = ndaStillListed(run.names, currentList(ctx));
    if (names.length !== run.names.length) {
      const keptKeys = new Set(ndaBaseline(names));
      const removedKeys = ndaBaseline(run.names).filter((key) => !keptKeys.has(key));
      // Prune both atomically: a restored name needs a fresh scan, even if another addition is deferred.
      await ctx.alive?.();
      await ctx.db.control.query(
        `WITH pruned AS (
           UPDATE open_rechecks SET names = $2::jsonb WHERE id = $1 AND instance_id = $3 AND state = 'running' RETURNING id
         )
         UPDATE maintenance_state
         SET value = jsonb_set(value, '{baseline}', (value -> 'baseline') - $5::text[]), updated_at = now()
         WHERE instance_id = $3 AND key = $4 AND jsonb_typeof(value -> 'baseline') = 'array'
           AND EXISTS (SELECT 1 FROM pruned)`,
        [run.id, JSON.stringify(names), ctx.instanceId, OPEN_RECHECK_STATE_KEY, removedKeys]);
      run.names = names;
    }
  }
  const batch = openRecheckBatch(ctx.settings.get<unknown>("open_check.recheck_batch", 100));
  const settings = runSettings(ctx, run);
  if (!settings) { await finishRun(ctx, run); return "done"; }
  if (run.reason === "held") {
    const n = await heldBatch(ctx, run, batch, settings);
    if (n < batch) { await finishRun(ctx, run); return "done"; }
    await saveRun(ctx, run);
    return "more";
  }
  if (run.phase === "scan" || run.phase === "tail") {
    const rows = run.phase === "scan" ? await scanBatch(ctx, run, batch) : await tailBatch(ctx, run, batch);
    for (const rec of rows) {
      await ctx.alive?.();
      run.counts.checked++;
      if (rec.hidden && !rec.deleted) { bump(run.counts, await hiddenNow(ctx, run, rec)); continue; }
      bump(run.counts, await settle(ctx, run, rec, await evaluate(ctx, rec.id, { deleted: rec.deleted, settings, run: run.id, consent: run.reason === "nfd" }), 1, settings));
    }
    if (rows.full && rows.last) run.cursor_id = rows.last;
    else { run.phase = run.phase === "scan" ? "tail" : "retry"; run.cursor_id = null; }
    await saveRun(ctx, run);
    return "more";
  }
  const left = await retryPending(ctx, run, settings, batch, o.retryGapMs ?? OPEN_RECHECK_RETRY_GAP_MS);
  if (left) { await saveRun(ctx, run); return "wait"; }
  if (run.reason !== "nfd") await reportSpaces(ctx, run, settings);
  await finishRun(ctx, run);
  return "done";
}

async function driveRun(ctx: Ctxish, o: RecheckOpts): Promise<RunRow | null> {
  const until = Date.now() + (o.budgetMs ?? 240_000), pause = o.pauseMs ?? 1_000, gap = o.retryGapMs ?? OPEN_RECHECK_RETRY_GAP_MS;
  for (;;) {
    await ctx.alive?.();
    const run = await runningRun(ctx);
    if (!run) return null;
    const step = await stepRecheck(ctx, run, o);
    if (step === "done") return run;
    const wait = step === "wait" ? Math.max(pause, gap, 1_000) : pause;
    if (Date.now() + wait > until) return run;
    await new Promise((r) => setTimeout(r, wait));
  }
}

async function locked<T>(ctx: DbCtx, fn: (alive: () => Promise<void>) => Promise<T>): Promise<T | null> {
  const client = await ctx.db.control.connect();
  let broken: Error | boolean | undefined;
  try {
    if (!(await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [LOCK(ctx.instanceId)])).rows[0]?.ok) return null;
    const watch = watchLock(client);
    try { return await fn(watch.alive); }
    finally {
      try {
        if (!watch.lost()) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK(ctx.instanceId)]).catch((e) => { broken = e as Error; });
        if (watch.lost()) {
          broken = true;
          log.warn("lock_connection_lost", { job: "open_recheck" });
        }
      } finally { watch.done(); }
    }
  } finally { client.release(broken); }
}

export async function openRecheckTick(ctx: Ctxish, o: RecheckOpts = {}): Promise<Record<string, unknown>> {
  const out = await locked(ctx, async (alive) => {
    ctx = { ...ctx, alive };
    await alive();
    if (!(await freshSettings(ctx))) return { skipped: "settings" };
    await alive();
    const seen = await noticeListChange(ctx);
    const run = await driveRun(ctx, o);
    return { ...seen, ...(run ? { run: run.id, phase: run.phase, counts: run.counts } : {}) };
  });
  return out ?? { busy: true };
}

function recheckMode(args: readonly string[]): "added" | "full" | "nfd" {
  const bad = args.filter((a) => a !== "--all" && a !== "--nfd");
  if (bad.length || (args.includes("--all") && args.includes("--nfd"))) throw new Error("open_recheck: use exactly one flag, --all or --nfd");
  return args.includes("--nfd") ? "nfd" : args.includes("--all") ? "full" : "added";
}

export async function openRecheckRun(ctx: Ctxish, args: string[] = [], o: RecheckOpts = {}): Promise<Record<string, unknown>> {
  const mode = recheckMode(args);
  const out = await locked(ctx, async (alive) => {
    ctx = { ...ctx, alive };
    await alive();
    if (!(await freshSettings(ctx))) throw new Error("open_recheck: could not read settings from the database. Try again later");
    if (await runningRun(ctx)) return { busy: "another run is in progress. Wait for it to finish (under “Open check”)" };
    if (mode === "added") {
      await alive();
      const seen = await noticeListChange(ctx);
      if (!seen.run) return { started: false, ...seen };
    } else {
      const names = mode === "full" ? currentList(ctx).filter((n): n is string => typeof n === "string") : [];
      if (mode === "full" && !names.length) return { started: false, reason: "NDA list is empty" };
      await alive();
      if (!(await startRecheck(ctx, mode, names))) return { busy: "another run is in progress" };
      if (mode === "full") await patchState(ctx, { baseline: ndaBaseline(currentList(ctx)) });
    }
    const gap = o.retryGapMs ?? OPEN_RECHECK_RUNJOB_GAP_MS;
    let run: RunRow | null = null;
    for (;;) {
      await alive();
      const cur = await runningRun(ctx);
      if (!cur) break;
      run = cur;
      const step = await stepRecheck(ctx, cur, { retryGapMs: gap });
      if (step === "done") break;
      await new Promise((r) => setTimeout(r, step === "wait" ? Math.max(gap, 1_000) : o.pauseMs ?? 1_000));
    }
    const done = run ? (await ctx.db.control.query("SELECT id, reason, counts, report FROM open_rechecks WHERE id = $1", [run.id])).rows[0] : null;
    return done ? { run: done.id, reason: done.reason, ...done.counts, spaces: done.report?.spaces?.length ?? 0, entities: done.report?.entities?.length ?? 0 } : { started: false };
  });
  return out ?? { busy: "open_recheck is running a scheduled pass. Try again in a minute" };
}

export async function openRecheckPreview(ctx: Ctxish, args: string[] = []): Promise<Record<string, unknown>> {
  const mode = recheckMode(args);
  await ctx.settings.load(true);
  const base = openCheckSettings(ctx.settings), st = await readState(ctx);
  const names = mode === "added" ? ndaListDiff(st.baseline ?? [], currentList(ctx)).added : currentList(ctx).filter((n): n is string => typeof n === "string");
  const settings = mode === "nfd" ? nfdSettings(base) : names.length ? ndaOnlySettings(base, names) : null;
  const res = { mode, names: mode === "nfd" ? null : names.length, checked: 0, match: 0, in_trash: 0, unchecked: 0, by_space_kind: {} as Record<string, number>,
                ...(mode === "nfd" ? { nfd_marked: 0 } : {}), ...(Array.isArray(st.baseline) ? {} : { baseline: "not set — the first scheduled pass will only save the list" }) };
  if (!settings) return res;
  const fake: RunRow = { id: `preview-${newId()}`, reason: mode, names, phase: "scan", cursor_id: null, tail_from: new Date(), counts: { ...ZERO }, report: {}, created_by: null };
  const kinds = new Map<string, string>((await ctx.db.control.query("SELECT id, kind FROM spaces WHERE instance_id = $1", [ctx.instanceId])).rows.map((r) => [r.id, r.kind]));
  for (;;) {
    const rows = await scanBatch(ctx, fake, 500);
    for (const r of rows) {
      if (r.hidden && !r.deleted) continue;
      res.checked++;
      if (mode === "nfd") (res as { nfd_marked: number }).nfd_marked++;
      const v = await evaluate(ctx, r.id, { deleted: r.deleted, settings, run: fake.id, consent: mode === "nfd" });
      if (v.kind === "unchecked") { res.unchecked++; continue; }
      if (v.kind !== "match") continue;
      if (r.deleted) { res.in_trash++; continue; }
      res.match++;
      const k = kinds.get(r.space_id) ?? "unknown";
      res.by_space_kind[k] = (res.by_space_kind[k] ?? 0) + 1;
    }
    if (!rows.full || !rows.last) break;
    fake.cursor_id = rows.last;
  }
  return res;
}

export function registerOpenRecheck(ctx: Ctx, every: Every): void {
  let chain: Promise<unknown> = Promise.resolve();
  const once = () => (chain = chain.catch(() => undefined).then(() => openRecheckTick(ctx)));
  every(600_000, "open_recheck", once);
  void (async () => {
    const cur = await ctx.boss.getQueue(OPEN_RECHECK_QUEUE);
    if (cur?.policy !== "stately") {
      if (cur) await ctx.boss.deleteQueue(OPEN_RECHECK_QUEUE);
      await ctx.boss.createQueue(OPEN_RECHECK_QUEUE, { policy: "stately" });
    }
    await ctx.boss.work(OPEN_RECHECK_QUEUE, { batchSize: 1 } as any, async () => { await once(); });
    await once();
  })().catch((e) => log.warn("open_recheck_failed", { error: String((e as Error)?.message ?? e).slice(0, 200) }));
}
