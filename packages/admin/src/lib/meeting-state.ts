import { text as M } from "../messages/meeting-state";
import { derived } from "../i18n/runtime";
import { PROCESS_STATE } from "./process-state";
import { dayKey, dayKeyAfter, formatDate } from "../i18n/format";
import { instanceTz } from "../i18n/runtime";

export type MeetingReason = "model_busy" | "daytime_cap" | "paused" | "too_slow" | "night_cap";

export { REASON_TEXT } from "../messages/meeting-state";

const hm = (at: Date, tz: string): string => formatDate(at, { timeZone: tz, hour: "2-digit", minute: "2-digit" });
const dm = (at: Date, tz: string): string => formatDate(at, { timeZone: tz, day: "numeric", month: "long" });

/** Time on the clock of the installation (or of zone tz): "14:30". */
export const clockTime = (iso: string | Date, tz: string = instanceTz()): string => hm(new Date(iso), tz);

/** When the next attempt is, on the clock of the installation (or of tz): today, tomorrow or a day and month, with the time. */
function retryParts(iso: string, now: Date, tz: string): ["today" | "tomorrow" | "date", string, string] {
  const at = new Date(iso);
  const day = dayKey(at, tz), today = dayKey(now, tz), tomorrow = dayKeyAfter(now, 1, tz);
  return [day === today ? "today" : day === tomorrow ? "tomorrow" : "date", dm(at, tz), hm(at, tz)];
}
export function retryWhen(iso: string, now: Date = new Date(), tz: string = instanceTz()): string {
  return M.retryTime(...retryParts(iso, now, tz));
}

export const MEETING_FAILED = derived(() => ({
  retry: M.failedRetry(),
  final: M.failedFinal(),
} as const));

export function meetingState(m: { stages: { summary: string | null; events: string | null; indexed?: string | null }; lane: "now" | "night"; reason: MeetingReason | null; retry_at?: string | null;
                                  failed_final?: boolean },
                             now: Date = new Date()): { label: string; tone: "ok" | "info" | "warn" | "danger" } {
  const { summary, events, indexed } = m.stages;
  if (summary === "done" && (events === "done" || events === "skipped" || events === null)) return { label: PROCESS_STATE.done, tone: "ok" };
  if (summary === "failed" || events === "failed" || indexed === "failed")
    return { label: m.failed_final ? MEETING_FAILED.final : MEETING_FAILED.retry, tone: "danger" };
  if (m.reason === "paused") return { label: M.busyReason("paused"), tone: "info" };
  if (m.reason === "model_busy" && m.lane === "now") {
    return m.retry_at && Date.parse(m.retry_at) > now.getTime()
      ? { label: M.busyRetry(...retryParts(m.retry_at, now, instanceTz())), tone: "warn" }
      : { label: M.busyWaiting("retry"), tone: "info" };
  }
  if (m.reason) return { label: M.busyReason(m.reason), tone: "warn" };
  if (m.lane === "night") return { label: M.busyWaiting("night"), tone: "info" };
  return { label: M.busyWaiting("usual"), tone: "info" };
}

export const isHandoverBusy = (res: { code: string; details?: unknown }): boolean =>
  res.code === "in_progress" && (res.details as { reason?: unknown } | undefined)?.reason === "organizer_transfer";
