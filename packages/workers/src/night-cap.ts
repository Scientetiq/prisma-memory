// Night cap of the workers' model work — the only
// place that writes and reads the window counter maintenance_state.night_tokens. Users: the model stage dispatcher
// (llm-dispatch.ts), re-extraction (reextractNightly) and any later night model pass outside the dispatcher
// (relate_backfill, topics_maintain, echo): before the model call under its own slot — nightCapState({fresh:
// true}), after the call, slot still held — addNightTokens.
// It relies on one model slot per instance: the spend is added before the slot is released, and the next night run
// under the slot reads the counter anew, so at most one stage begun before the threshold goes over the cap.
// Counter failure: log.warn, no content, the stage goes on; a failed read makes the night check see the window spent
// (night work waits; the cap leaves the now lane alone). A bad window in settings (zone typo, a time not in
// form; the panel does not check processing.night_window) fails the same way: no function here throws. The dispatcher's
// finally calls the addition just before gate.release; an exception here would hold the model slot until a worker
// restart.
import { log, legacyNightStarts, nightWindowConfig, windowEndOf, nightCapOf, nightWindowOf, nightCapView, NIGHT_TOKENS_KEY, parseNightTokens, windowStartOf, type NightCapView, type NightTokensState, type NightWindow } from "@memory/shared";
import { auditWorker, type DbCtx } from "./ctx.ts";
import { LLM_STAGES, QUEUE_OF } from "./stages.ts";

/** Process cache lifetime: a check BEFORE the slot spares the DB while the queue is empty or the slot busy; under it — a fresh read. */
export const NIGHT_CAP_CACHE_MS = 15_000;
/** Model stage queues (as the scheduler's LLM_QUEUES; no import of scheduler.ts here, it imports maintenance.ts). */
const LLM_QUEUE_NAMES = [...LLM_STAGES].map((s) => QUEUE_OF[s]);
/**
 * A model job of the night lane has priority 0; the day lane has 1 or more (10 — meetings and explicit requests, 5 — documents
 * of the day lane by default, scheduler.ts INTAKE_PRIORITY) — the dispatcher's daytime threshold (llm-dispatch.ts).
 */
const DAY_PRIORITY_MIN = 1;

type CapCtx = Pick<DbCtx, "instanceId" | "db" | "settings">;
interface Cached { state: NightTokensState | null; at: number }
/** Process cache — per control pool: each context (worker, test sandbox) has its own. */
const cache = new WeakMap<object, Cached>();

const winOf = (ctx: CapCtx): NightWindow => nightWindowOf(ctx.settings);
const remember = (ctx: CapCtx, value: unknown, at: number): NightTokensState | null => {
  const state = parseNightTokens(value);
  cache.set(ctx.db.control, { state, at });
  return state;
};
const errText = (e: unknown) => (e as Error)?.message?.slice(0, 160) ?? "unknown";

/**
 * Add a night stage's spend to its window counter with one atomic UPDATE (the row comes from INSERT … ON CONFLICT):
 * same window: a sum; a new window: count anew, the old one to prev. A late addition of the past window (not with
 * one slot, but kept) goes to prev if it matches. The process cache is set from RETURNING.
 * Call under the model slot, before its release. A failure (or a bad window in settings: the spend has nowhere to go and
 * is not written) — log.warn, no exception.
 */
export async function addNightTokens(ctx: CapCtx, tokens: number, at: Date = new Date()): Promise<void> {
  const add = Math.floor(Number(tokens));
  if (!Number.isFinite(add) || add <= 0) return;
  try {
    const w = winOf(ctx), start = windowStartOf(w, at), ws = start.toISOString(), cap = nightCapOf(ctx.settings);
    const { rows } = await ctx.db.control.query(
      `INSERT INTO maintenance_state AS m (instance_id, key, value, updated_at)
       VALUES ($1, $2, jsonb_build_object('window_start', $3::text, 'tokens', $4::bigint, 'capped_at', NULL, 'cap', $5::bigint, 'prev', NULL, 'window_end', $6::text, 'window_config', $7::text), now())
       ON CONFLICT (instance_id, key) DO UPDATE SET updated_at = now(), value = CASE
         WHEN m.value->>'window_start' = $3::text
           OR (m.value->>'window_config' IS DISTINCT FROM $7::text AND
               CASE WHEN m.value->>'window_end' IS NOT NULL
                 THEN (m.value->>'window_start')::timestamptz < ($6::text)::timestamptz AND (m.value->>'window_end')::timestamptz > ($3::text)::timestamptz
                 ELSE m.value->>'window_start' = ANY($8::text[]) END)
           THEN (SELECT m.value || jsonb_build_object('window_start', $3::text,
                          'tokens', COALESCE((m.value->>'tokens')::bigint, 0) + $4::bigint
                                    + CASE WHEN p.merge_prev THEN COALESCE((m.value->'prev'->>'tokens')::bigint, 0) ELSE 0 END,
                          'prev', CASE WHEN p.merge_prev THEN NULL ELSE m.value->'prev' END,
                          'cap', $5::bigint, 'window_end', $6::text, 'window_config', $7::text)
                 FROM (SELECT m.value->>'window_config' IS DISTINCT FROM $7::text AND
                         CASE WHEN m.value->'prev'->>'window_end' IS NOT NULL
                           THEN (m.value->'prev'->>'window_start')::timestamptz < ($6::text)::timestamptz
                            AND (m.value->'prev'->>'window_end')::timestamptz > ($3::text)::timestamptz
                           ELSE m.value->'prev'->>'window_start' = ANY($8::text[]) END AS merge_prev) p)
         WHEN m.value->'prev'->>'window_start' = $3::text
           THEN jsonb_set(m.value, '{prev,tokens}', to_jsonb(COALESCE((m.value->'prev'->>'tokens')::bigint, 0) + $4::bigint))
         WHEN (m.value->>'window_start') IS NOT NULL AND (m.value->>'window_start')::timestamptz > ($3::text)::timestamptz
           THEN m.value
         ELSE jsonb_build_object('window_start', $3::text, 'tokens', $4::bigint, 'capped_at', NULL, 'cap', $5::bigint, 'window_end', $6::text, 'window_config', $7::text,
                                 'prev', CASE WHEN (m.value->>'window_start') IS NULL THEN NULL
                                              ELSE jsonb_build_object('window_start', m.value->'window_start', 'tokens', COALESCE(m.value->'tokens', '0'::jsonb),
                                                                      'capped_at', m.value->'capped_at', 'cap', m.value->'cap',
                                                                      'window_end', m.value->'window_end', 'window_config', m.value->'window_config') END)
       END
       RETURNING m.value`,
      [ctx.instanceId, NIGHT_TOKENS_KEY, ws, add, cap, windowEndOf(w, start).toISOString(), nightWindowConfig(w), legacyNightStarts(w, at)]);
    if (rows[0]) remember(ctx, rows[0].value, at.getTime());
  } catch (e) {
    log.warn("night_cap_add_failed", { tokens: add, error: errText(e) });
  }
}

/** Window spent on a failure: night work waits; tokens 0 — no cap-hit mark. A bad window — no window start. */
function exhausted(ctx: CapCtx, cap: number, now: Date): NightCapView {
  let ws = "";
  try { ws = windowStartOf(winOf(ctx), now).toISOString(); } catch { /* bad window in the settings */ }
  return { window_start: ws, tokens: 0, cap, capped: true, capped_at: null, prev: null };
}

/**
 * Window as the cap sees it ({capped, tokens, cap, window_start, capped_at, prev}). `fresh: true` always reads (under
 * the slot, before a night stage or night model call); else from a process cache ≤ 15 s old. A read failure or a bad
 * settings window: the window counts as spent (capped: true, tokens 0): night work waits, now runs; no exceptions.
 */
export async function nightCapState(ctx: CapCtx, o: { fresh?: boolean; now?: Date } = {}): Promise<NightCapView> {
  const now = o.now ?? new Date(), cap = nightCapOf(ctx.settings);
  try {
    const w = winOf(ctx);
    const hit = cache.get(ctx.db.control);
    if (!o.fresh && hit && now.getTime() - hit.at >= 0 && now.getTime() - hit.at < NIGHT_CAP_CACHE_MS) return nightCapView(hit.state, cap, w, now);
    const { rows } = await ctx.db.control.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = $2", [ctx.instanceId, NIGHT_TOKENS_KEY]);
    return nightCapView(remember(ctx, rows[0]?.value ?? null, now.getTime()), cap, w, now);
  } catch (e) {
    log.warn("night_cap_read_failed", { error: errText(e) });
    cache.delete(ctx.db.control);
    return exhausted(ctx, cap, now);
  }
}

/** How many night jobs (the night lane, priority below DAY_PRIORITY_MIN) wait in the model queues; null on a failure. */
export async function nightWaiting(ctx: CapCtx): Promise<number | null> {
  try {
    const { rows } = await ctx.db.control.query(
      `SELECT count(*)::int AS n FROM pgboss.job WHERE name = ANY($1) AND state IN ('created','retry') AND priority < ${DAY_PRIORITY_MIN}`, [LLM_QUEUE_NAMES]);
    return Number(rows[0]?.n ?? 0);
  } catch { return null; }
}

/**
 * First time in a window, mark that the cap stopped night work: `capped_at` in the row and a journal event
 * `processing {job: "night_cap", tokens, cap, waiting}` — numbers only. Again in that window — nothing (false).
 * Marked only when the cap really holds night work (contract `NightCapReport`: the first refusal of a night
 * stage in a window): the row count reached the cap (a read-failure hit in nightCapState sets no mark), and the
 * model queues hold a night job to run. The last night stage crossed the threshold and there are no more night jobs —
 * nothing stopped, no mark: else the report would show stopped by the limit, and the recount for the new
 * version next night would be skipped with no tail at all. A night job later in that window — the mark then.
 * Both terms — in one UPDATE.
 */
export async function markCapped(ctx: CapCtx, view: NightCapView, now: Date = new Date()): Promise<boolean> {
  if (!view.capped || view.capped_at) return false;
  let marked = false;
  try {
    const w = winOf(ctx), start = windowStartOf(w, now);
    const { rows } = await ctx.db.control.query(
      `UPDATE maintenance_state SET value = value || jsonb_build_object('capped_at', now()), updated_at = now()
        WHERE instance_id = $1 AND key = $2 AND value->>'window_start' = $3 AND (value->>'capped_at') IS NULL
          AND COALESCE((value->>'tokens')::bigint, 0)
              + CASE WHEN value->>'window_config' IS DISTINCT FROM $6::text AND
                     CASE WHEN value->'prev'->>'window_end' IS NOT NULL
                       THEN (value->'prev'->>'window_start')::timestamptz < ($7::text)::timestamptz
                        AND (value->'prev'->>'window_end')::timestamptz > ($8::text)::timestamptz
                       ELSE value->'prev'->>'window_start' = ANY($9::text[]) END
                  THEN COALESCE((value->'prev'->>'tokens')::bigint, 0) ELSE 0 END >= $4::bigint
          AND EXISTS (SELECT 1 FROM pgboss.job j WHERE j.name = ANY($5) AND j.state IN ('created','retry') AND j.priority < ${DAY_PRIORITY_MIN} AND j.start_after <= now())
        RETURNING value`, [ctx.instanceId, NIGHT_TOKENS_KEY, view.window_start, view.cap, LLM_QUEUE_NAMES,
          nightWindowConfig(w), windowEndOf(w, start).toISOString(), start.toISOString(), legacyNightStarts(w, now)]);
    if (rows[0]) { marked = true; remember(ctx, rows[0].value, now.getTime()); }
  } catch (e) {
    log.warn("night_cap_mark_failed", { error: errText(e) });
    return false;
  }
  if (!marked) return false;
  const waiting = await nightWaiting(ctx);
  log.info("night_cap_reached", { tokens: view.tokens, cap: view.cap, waiting });
  await auditWorker(ctx, { event_type: "processing", details: { job: "night_cap", tokens: view.tokens, cap: view.cap, waiting } });
  return true;
}
