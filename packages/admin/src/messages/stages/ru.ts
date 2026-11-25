import { pluralRu } from "../../i18n/core";
import type { Messages } from "../../i18n/core";
import type * as en from "./en";
export const STAGES_TEXT: Messages<typeof en.STAGES_TEXT> = {
    tooSlowText: "модель не успевает ответить на эту запись — нажмите «Повторить» ночью или обратитесь к разработчикам",
    converterWaitAdvice: "Ничего делать не нужно: перевод в текст продолжится сам.",
    tooSlowAdvice: "Модель не успевает ответить на эту запись. Нажмите «Повторить», чтобы попробовать ещё раз; если снова не выйдет, обратитесь к администратору.",
    waitingAdvice: "Ничего делать не нужно: обработка повторится сама, когда модель освободится.",
    conversionRetryAdvice: "Можно нажать «Обработать сейчас» — конвертер обработает документ заново (не больше 10 раз в час). Если снова не выйдет, администратор разберётся.",
    conversionFinalAdvice: "Обработать этот файл заново не получится: повтор даст тот же результат.",
    busyAdvice: "Обычно несколько минут, нажимать ничего не нужно.",
    waitingLine: (busy: number, slow: number, first: string | null, retry: string | null): string => {
      const n = busy + slow;
      const what = busy && slow ? "была занята или не успела ответить" : slow ? "не успела ответить" : "была занята";
      const since = first ? ` с ${first}` : "";
      const next = retry ? `следующая попытка ${retry}` : "попробуем снова, когда модель освободится";
      return n ? `ждёт модель: ${what} ${n} ${pluralRu(n, ["раз", "раза", "раз"])}${since}, ${next}` : `ждёт модель: ${next}`;
    },
    queueAhead: (n: number): string => `Ждёт перевода в текст: перед ним ${n} ${pluralRu(n, ["документ", "документа", "документов"])}`,
    converterSince: (time: string): string => `У конвертера с ${time}`,
    ocrRetry: (time: string | null): string => `Часть страниц пока не распознана — попробуем ещё раз${time ? ` ${time}` : ""}`,
    converterRetry: (time: string | null): string => `Конвертер не справился с первого раза — попробуем ещё раз${time ? ` ${time}` : ""}`,
    errorsLine: (attempts: number, max: number): string => attempts >= max ? `попыток: ${attempts} — автоповтор исчерпан (лимит ${max})` : `ошибок: ${attempts} из ${max}`,
    busyLabel: (state: string, what: string, step: number, total: number): string => `${state} · ${what.toLowerCase()}, шаг ${step} из ${total}`,
    busyDetail: (what: string, step: number, total: number): string => `${what} · шаг ${step} из ${total}`,
    failed: (state: string, stages: readonly string[]): string => `${state}: ${stages.join(", ")}`,
    empty: "нет данных об обработке",
    running: "Идёт обработка",
    waiting: "Ждёт модель",
    queued: "В очереди на обработку",
    missing: "нет данных: перенос класса или очистка",
    noStages: "стадий нет",
    failedCount: (failed: number, total: number): string => `ошибка: стадий — ${failed} из ${total}`,
    done: "готово",
    incomplete: (done: number, total: number): string => `не завершена (${done} из ${total})`,
    retry: "Повторить",
    processNow: "Обработать сейчас",
    conversionFinalWithReason: "Обработать этот файл заново не получится: повтор даст тот же результат. Причина — на странице записи.",
    adviceWithReason: (why: string, advice: string): string => `${why} ${advice}`,
    finalAdvice: "Обработка не удалась окончательно: повтор даст тот же результат. Обратитесь к администратору, он проверит сам файл или разбор документов.",
    failedAdvice: "Нажмите «Повторить», и шаги с ошибкой повторятся. Если ошибка не уходит, обратитесь к администратору.",
    nightAdvice: "Полная обработка пройдёт ночью. Если нужно раньше, нажмите «Обработать сейчас» (не больше 10 раз в час).",
    slowAdvice: "Обработка идёт дольше обычного. Можно нажать «Обработать сейчас» — запись встанет в начало очереди (не больше 10 раз в час).",

};

export const CONVERTER_WAIT_TEXT: Messages<typeof en.CONVERTER_WAIT_TEXT> = {
    queue: "Ждёт перевода в текст",
    at: "У конвертера",
    unavailable: "Конвертер сейчас недоступен — продолжим сами, ничего делать не нужно",
    config: "Конвертер временно недоступен — администратор уже видит причину",
    hold: "Конвертация приостановлена администратором",
    shaky: "Конвертер работает с перебоями — администратор уже видит",
    storage: "Хранилище временно недоступно — продолжим сами",
} as const;

export const STAGE_TITLES: Messages<typeof en.STAGE_TITLES> = { converted: "разбор файла", indexed: "подготовка к поиску", summary: "резюме", events: "решения и задачи", entities: "поиск связей", described: "описание", moved: "перенос при открытии или закрытии" };

export const STAGE_STATUS_TITLES: Messages<typeof en.STAGE_STATUS_TITLES> = { pending: "ждёт", running: "в работе", failed: "ошибка", done: "готово", skipped: "пропущено" };
