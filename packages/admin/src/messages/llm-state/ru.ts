import { pluralRu, type Messages } from "../../i18n/core";
import type * as en from "./en";

export const llmState: Messages<typeof en.llmState> = {
  config: "Модель недоступна по настройкам — проверьте адрес шлюза, ключ и имя модели в разделе «Модели»",
  slow: (when: string) => `Модель отвечает слишком медленно — следующая попытка ${when}`,
  busy: (when: string, streak: number) => `Модель занята — следующая попытка ${when}${streak ? ` (ответила «занята» ${streak} ${pluralRu(streak, ["раз", "раза", "раз"])} подряд)` : ""}`,
  paused: (at: string, why: string) => `Обращения к модели на паузе до ${at}: ${why}`,
  reserved: (at: string) => `Модель отдана проверке стенда разработчика — снимется сама до ${at}`,
  stub: "Модель выключена: вместо ответов модели — заготовки для проверки",
  lease: (at: string) => `Модель — только по очереди проверок: разрешение до ${at}`,
  noLease: "Модель — только по очереди проверок: разрешения сейчас нет",
  working: "Модель работает",
  dirty: (when: string) => `Модель может ещё досчитывать прерванный запрос — новые пойдут ${when}`,
  requests: (n: number, purpose: string) => `Сейчас у модели: ${n} ${pluralRu(n, ["запрос", "запроса", "запросов"])}${purpose ? ` — ${purpose}` : ""}`,
  processing: "обработка записи",
  probe: "проверочный запрос",
  noRequests: "Сейчас запросов к модели нет",
  waiting: (n: number, now: number, night: number, next: string) => `Ждут модель: ${n} (сейчас — ${now}, ночью — ${night})${next ? `, ближайшая попытка ${next}` : ""}`,
  tooSlow: (n: number) => `Модель не успевает ответить: ${n} ${pluralRu(n, ["запись", "записи", "записей"])} — нажмите «Повторить» ночью или обратитесь к разработчикам`,
  hold: (owner: string, why: string, at: string, note: string) => `${owner} — ${why}, до ${at}${note ? ` (${note})` : ""}`,
  reset: (failed: number, waiting: number) => `Сброшено: с ошибкой — ${failed}, ждущих модель — ${waiting}.`,
  converter: (n: number) => `Ждущих конвертер проверим сейчас: ${n} — пауза и очередь конвертера при этом действуют.`,
  oneByOne: "Пойдут по одной: модель одна на всю компанию. Если она ещё занята, повторятся сами.",
  queueLater: "Часть записей не удалось поставить в очередь сразу — их подберёт обход очереди.",
  pausedFor: (at: string, reason: string): string => llmState.paused(at, (Object.hasOwn(HOLD_WHY, reason) ? HOLD_WHY[reason] : undefined) ?? reason),
  requestsFor: (n: number, purpose: string, stage: string): string => llmState.requests(n, purpose ? purpose === "stage" ? (Object.hasOwn(WHAT, stage) ? WHAT[stage] : undefined) ?? llmState.processing : llmState.probe : ""),
  holdDetail: (owner: string, reason: string, at: string, note: string): string => llmState.hold(owner, (Object.hasOwn(HOLD_WHY, reason) ? HOLD_WHY[reason] : undefined) ?? reason, at, note),
};

export const WHAT: Messages<typeof en.WHAT> = { summary: "резюме встречи", events: "решения и задачи встречи", described: "описание документа" };

export const HOLD_WHY: Messages<typeof en.HOLD_WHY> = { test: "идёт проверка", admin: "поставил администратор", floor: "модель отдана проверке стенда разработчика" };
