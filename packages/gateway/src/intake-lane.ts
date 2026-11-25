// Processing lane of a new record at intake: an uploaded document goes to the "now" lane by default
// (`processing.documents_lane`), so its description and links do not wait for the night window; the daytime token cap
// (`processing.daytime_token_cap`) is shared with meetings. The lane keys are written by code only: they are in
// RESERVED_ATTRS (meetings.ts) and never taken from a request body.
import { estimateTokens, log, nightWindowOf } from "@memory/shared";
import type { App } from "./context.ts";

/** Values of `processing.documents_lane`: "now" describes a document right after upload, "night" in the night window. */
export const DOCUMENTS_LANES = ["now", "night"] as const;
export type DocumentsLane = (typeof DOCUMENTS_LANES)[number];

/**
 * Lane attributes of a new record. `process_now_by: "intake"` marks a record that entered the day lane by default, not by a
 * person's explicit "process now": its model job and its place in the converter queue keep a lower priority than meetings and
 * explicit requests (scheduler.ts, conversion-queue.ts). `memory_process_now` removes the mark.
 */
export type IntakeLane =
  | { process_now_at: string; process_now_by: "intake" }
  | { deferred_reason: "daytime_cap"; deferred_to_night_at: string }
  | Record<string, never>;

/** The lane setting; an unknown or missing value means the product default "now". */
export function documentsLane(app: Pick<App, "settings">): DocumentsLane {
  return app.settings.get<string>("processing.documents_lane", "now") === "night" ? "night" : "now";
}

/**
 * Tokens the `described` stage of a new document will send: the head of its text, at most
 * `processing.budgets.describe_head_tokens`. A file that still has to be converted has no text yet — the whole head is
 * assumed, otherwise the daytime cap would always see 0 for a PDF.
 */
export function documentEstimate(app: Pick<App, "settings">, text: string, converting: boolean): number {
  const head = Number(app.settings.get<{ describe_head_tokens?: number }>("processing.budgets", { describe_head_tokens: 8000 })?.describe_head_tokens);
  const limit = Number.isFinite(head) && head > 0 ? head : 8000;
  return converting ? limit : Math.min(estimateTokens(text), limit);
}

/**
 * Lane of a newly uploaded document. Only the upload path calls it — never `createRecord`, so copies made by hand-over,
 * custody or the work profile keep their own lane. Bulk sources (connectors, folder import) decide for themselves: they call
 * this for a single interactive item or pass nothing and stay nightly.
 */
export async function intakeLane(app: Pick<App, "settings" | "db">, estimatedTokens: number): Promise<IntakeLane> {
  if (documentsLane(app) === "night") return {};
  const at = new Date().toISOString();
  if (await daytimeCapExceeded(app, estimatedTokens)) return { deferred_reason: "daytime_cap", deferred_to_night_at: at };
  return { process_now_at: at, process_now_by: "intake" };
}

/**
 * Daytime token cap (`processing.daytime_token_cap`, 0 — off, the default). Used: the sum of `details.tokens` of the
 * `processing` events of the "now" lane since midnight in the time zone of the night window. A record whose processing would
 * take the sum over the cap waits for the night. Meetings pass twice their length (summary and events read the text);
 * documents pass the head their description reads. An unreadable journal does not block intake: logged, the record goes "now".
 */
export async function daytimeCapExceeded(app: Pick<App, "settings" | "db">, tokens: number): Promise<boolean> {
  const cap = app.settings.get<number>("processing.daytime_token_cap", 0);
  if (!(cap > 0)) return false;
  const tz = nightWindowOf(app.settings).tz;
  try {
    const { rows } = await app.db.auditRead().query(
      `SELECT COALESCE(sum((details->>'tokens')::bigint), 0)::bigint AS used FROM audit_events
       WHERE at >= (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1) AND event_type = 'processing' AND details->>'lane' = 'now' AND details ? 'tokens'`, [tz]);
    return Number(rows[0]?.used ?? 0) + tokens > cap;
  } catch (e) {
    log.warn("daytime_cap_unreadable", { error: (e as Error).message.slice(0, 160) });
    return false;
  }
}
