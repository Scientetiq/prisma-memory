// The night cap of model work as the gateway sees it: the gateway writes no counter — it is
// kept by the worker (workers/src/night-cap.ts) — it only reads the maintenance_state.night_tokens row: the wait reason
// night_cap in the record status and "Meetings with me", and the morning report's night_cap section. Numbers and time only.
import { log, nightCapOf, nightCapView, NIGHT_TOKENS_KEY, parseNightTokens, windowStartOf, nightWindowOf, type NightCapView } from "@memory/shared";
import type { App } from "./context.ts";
import { DAY_PRIORITY_MIN, LLM_QUEUES } from "./queue.ts";

type CapApp = Pick<App, "db" | "instanceId" | "settings">;

let snap: { view: NightCapView; at: number } | null = null;

/** Window state: the counter row, the cap and the window from settings. A read failure throws (the caller decides). */
export async function readNightCap(app: CapApp, now: Date = new Date()): Promise<NightCapView> {
  const { rows } = await app.db.control.query("SELECT value FROM maintenance_state WHERE instance_id = $1 AND key = $2", [app.instanceId, NIGHT_TOKENS_KEY]);
  return nightCapView(parseNightTokens(rows[0]?.value ?? null), nightCapOf(app.settings), nightWindowOf(app.settings), now);
}

/**
 * Has the current window (by day, the past one) hit the cap — for the wait reason; 5 s cache, as gateSnapshot. A read failure —
 * false: the record status does not fail and invents no reason.
 */
export async function nightCapped(app: CapApp): Promise<boolean> {
  if (snap && Date.now() - snap.at < 5000) return snap.view.capped;
  try {
    const view = await readNightCap(app);
    snap = { view, at: Date.now() };
    return view.capped;
  } catch (e) {
    log.warn("night_cap_unreadable", { error: (e as Error).message.slice(0, 160) });
    return false;
  }
}
export const resetNightCapSnapshot = (): void => { snap = null; };

/**
 * Did the cap hold night work in the current window (by day — the past night) or in the window right before it (`capped_at`
 * is set only when night jobs really waited) — for the "model" check in health: a night tail
 * stretched by the limit over several nights is not the model's trouble. A long-past night does not count. A read failure and
 * a bad window in the settings — false: health stays as before and invents no reason.
 */
export async function nightCapHeld(app: CapApp, now: Date = new Date()): Promise<boolean> {
  try {
    const v = await readNightCap(app, now);
    if (v.capped_at) return true;
    if (!v.prev?.capped_at) return false;
    const w = nightWindowOf(app.settings);
    return v.prev.window_start === windowStartOf(w, new Date(Date.parse(v.window_start) - 1)).toISOString();
  } catch (e) {
    log.warn("night_cap_unreadable", { error: (e as Error).message.slice(0, 160) });
    return false;
  }
}

/** Morning report section (contract `NightCapReport`): the cap, the last night (current if running), night stages waiting on a model. */
export interface NightCapReport { cap: number; last_night: { window_start: string; tokens: number; capped: boolean; capped_at: string | null }; waiting: number }

export async function nightCapReport(app: CapApp, now: Date = new Date()): Promise<NightCapReport> {
  const v = await readNightCap(app, now);
  let waiting = 0;
  // the pg-boss queue is created by the worker: before its first start there is no schema — nothing waits
  try {
    // the night lane is priority 0: documents of the day lane by default (priority 5) do not wait for the night
    waiting = Number((await app.db.control.query(
      `SELECT count(*)::int AS n FROM pgboss.job WHERE name = ANY($1) AND state IN ('created','retry') AND priority < ${DAY_PRIORITY_MIN}`, [LLM_QUEUES])).rows[0]?.n ?? 0);
  } catch { /* no pgboss schema yet */ }
  return { cap: v.cap, last_night: { window_start: v.window_start, tokens: v.tokens, capped: v.capped_at !== null, capped_at: v.capped_at }, waiting };
}
