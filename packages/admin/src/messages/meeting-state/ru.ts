import { PROCESS_STATE } from "../process-state/ru";
import type { Messages } from "../../i18n/core";
import * as en from "./en";
export const text: Messages<typeof en.text> = {
  retryTime: (day: "today" | "tomorrow" | "date", date: string, time: string): string => day === "today" ? text.at(time) : day === "tomorrow" ? text.tomorrowAt(time) : text.at2(date, time),
  busyReason: (reason: keyof typeof REASON_TEXT): string => `${PROCESS_STATE.busy} — ${REASON_TEXT[reason]}`,
  busyRetry: (day: "today" | "tomorrow" | "date", date: string, time: string): string => `${PROCESS_STATE.busy} — ${text.theModelIsBusyNowWe(text.retryTime(day, date, time))}`,
  busyWaiting: (mode: "retry" | "night" | "usual"): string => `${PROCESS_STATE.busy} — ${mode === "retry" ? text.theModelWasBusyTryingAgain : mode === "night" ? text.theSummaryWillBeReadyAfter : text.usuallyAFewMinutes}`,
  failedRetry: (): string => text.theOrganiserCanSelectRetryOn(PROCESS_STATE.failed),
  failedFinal: (): string => text.retryingWillNotHelpContactYour(PROCESS_STATE.failed),

  at: (value0: string | number | null | undefined): string => `в ${value0}`,
  tomorrowAt: (value0: string | number | null | undefined): string => `завтра в ${value0}`,
  at2: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `${value0} в ${value1}`,
  theOrganiserCanSelectRetryOn: (value0: string | number | null | undefined): string => `${value0} — организатор может нажать «Повторить» на странице встречи`,
  retryingWillNotHelpContactYour: (value0: string | number | null | undefined): string => `${value0} — повтор не поможет, обратитесь к администратору`,
  theModelIsBusyNowWe: (value0: string | number | null | undefined): string => `модель сейчас занята, попробуем снова ${value0}; ничего делать не нужно`,
  theModelWasBusyTryingAgain: "модель была занята, пробуем снова; обычно несколько минут",
  theSummaryWillBeReadyAfter: "резюме будет после ночной обработки",
  usuallyAFewMinutes: "обычно несколько минут",
};
export const REASON_TEXT: Messages<typeof en.REASON_TEXT> = {
  "model_busy": "модель была занята, резюме будет после ночной обработки",
  "daytime_cap": "дневной лимит обработки исчерпан, резюме будет после ночной обработки",
  "paused": "обработка ненадолго приостановлена, продолжится сама",
  "too_slow": "встреча длинная, модель не успела; резюме будет после ночной обработки",
  "night_cap": "ждёт следующей ночи: модель уже отработала свой ночной предел"
};
