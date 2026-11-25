import { PROCESS_STATE } from "../process-state/en";
export const text = {
  retryTime: (day: "today" | "tomorrow" | "date", date: string, time: string): string => day === "today" ? text.at(time) : day === "tomorrow" ? text.tomorrowAt(time) : text.at2(date, time),
  busyReason: (reason: keyof typeof REASON_TEXT): string => `${PROCESS_STATE.busy} — ${REASON_TEXT[reason]}`,
  busyRetry: (day: "today" | "tomorrow" | "date", date: string, time: string): string => `${PROCESS_STATE.busy} — ${text.theModelIsBusyNowWe(text.retryTime(day, date, time))}`,
  busyWaiting: (mode: "retry" | "night" | "usual"): string => `${PROCESS_STATE.busy} — ${mode === "retry" ? text.theModelWasBusyTryingAgain : mode === "night" ? text.theSummaryWillBeReadyAfter : text.usuallyAFewMinutes}`,
  failedRetry: (): string => text.theOrganiserCanSelectRetryOn(PROCESS_STATE.failed),
  failedFinal: (): string => text.retryingWillNotHelpContactYour(PROCESS_STATE.failed),

  at: (value0: string | number | null | undefined): string => `at ${value0}`,
  tomorrowAt: (value0: string | number | null | undefined): string => `tomorrow at ${value0}`,
  at2: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `${value0} at ${value1}`,
  theOrganiserCanSelectRetryOn: (value0: string | number | null | undefined): string => `${value0} — the organiser can select “Retry” on the meeting page`,
  retryingWillNotHelpContactYour: (value0: string | number | null | undefined): string => `${value0} — retrying will not help; contact your administrator`,
  theModelIsBusyNowWe: (value0: string | number | null | undefined): string => `the model is busy now; we will try again ${value0}. You do not need to do anything`,
  theModelWasBusyTryingAgain: "the model was busy; trying again, usually within a few minutes",
  theSummaryWillBeReadyAfter: "the summary will be ready after night processing",
  usuallyAFewMinutes: "usually a few minutes",
};
export const REASON_TEXT = {
  "model_busy": "the model was busy; the summary will be ready after night processing",
  "daytime_cap": "the daytime processing limit has been reached; the summary will be ready after night processing",
  "paused": "processing is briefly paused and will resume automatically",
  "too_slow": "the meeting is long and the model ran out of time; the summary will be ready after night processing",
  "night_cap": "waiting for the next night: the model has reached its night processing limit"
} as const;
