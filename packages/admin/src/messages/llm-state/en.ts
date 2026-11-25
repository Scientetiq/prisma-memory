import { pluralEn } from "../../i18n/core";

export const llmState = {
  config: "The model is unavailable because of its settings. Check the gateway address, key and model name in “Models”",
  slow: (when: string) => `The model is responding too slowly. Next attempt ${when}`,
  busy: (when: string, streak: number) => `The model is busy. Next attempt ${when}${streak ? ` (reported “busy” ${streak} ${pluralEn(streak, "time", "times")} in a row)` : ""}`,
  paused: (at: string, why: string) => `Model requests are paused until ${at}: ${why}`,
  reserved: (at: string) => `The model is reserved for developer test checks. It will be released by ${at}`,
  stub: "The model is off: test responses are used instead",
  lease: (at: string) => `The model is available only through the test queue: permission until ${at}`,
  noLease: "The model is available only through the test queue: no permission at present",
  working: "The model is working",
  dirty: (when: string) => `The model may still be finishing an interrupted request. New requests will start ${when}`,
  requests: (n: number, purpose: string) => `At the model now: ${n} ${pluralEn(n, "request", "requests")}${purpose ? ` — ${purpose}` : ""}`,
  processing: "record processing",
  probe: "test request",
  noRequests: "There are no model requests at present",
  waiting: (n: number, now: number, night: number, next: string) => `Waiting for the model: ${n} (now: ${now}, at night: ${night})${next ? `, next attempt ${next}` : ""}`,
  tooSlow: (n: number) => `The model cannot respond in time: ${n} ${pluralEn(n, "record", "records")}. Click “Retry” at night or contact the developers`,
  hold: (owner: string, why: string, at: string, note: string) => `${owner} — ${why}, until ${at}${note ? ` (${note})` : ""}`,
  reset: (failed: number, waiting: number) => `Reset: failed — ${failed}, waiting for the model — ${waiting}.`,
  converter: (n: number) => `Documents waiting for the converter will be checked now: ${n}. The converter’s pause and queue still apply.`,
  oneByOne: "They will run one at a time: the model is shared by the company. If it is still busy, they will retry automatically.",
  queueLater: "Some records could not be queued immediately. The queue sweep will pick them up.",
  pausedFor: (at: string, reason: string): string => llmState.paused(at, (Object.hasOwn(HOLD_WHY, reason) ? HOLD_WHY[reason] : undefined) ?? reason),
  requestsFor: (n: number, purpose: string, stage: string): string => llmState.requests(n, purpose ? purpose === "stage" ? (Object.hasOwn(WHAT, stage) ? WHAT[stage] : undefined) ?? llmState.processing : llmState.probe : ""),
  holdDetail: (owner: string, reason: string, at: string, note: string): string => llmState.hold(owner, (Object.hasOwn(HOLD_WHY, reason) ? HOLD_WHY[reason] : undefined) ?? reason, at, note),
};

export const WHAT = { summary: "meeting summary", events: "meeting decisions and tasks", described: "document description" } as Record<string, string>;

export const HOLD_WHY = { test: "a check is running", admin: "set by an administrator", floor: "the model is reserved for developer test checks" } as Record<string, string>;
