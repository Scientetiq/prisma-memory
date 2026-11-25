import { formatNumber } from "../../i18n/format";
import { pluralRu, type Messages } from "../../i18n/core";
import { formatCount } from "../../i18n/format";
import type * as en from "./en";

export const ORPHAN_WHY: Messages<typeof en.ORPHAN_WHY> = {
  purge: "запись удалена насовсем",
  open_check_refused: "документ не принят в общее пространство",
  open_check_fallback: "документ перенесён в закрытое — у записи теперь другая копия",
};

export const PHASE_TEXT: Messages<typeof en.PHASE_TEXT> = { uploading: "загружается в конвертер", submitted: "у конвертера", rerun_wait: "ждёт повтора распознавания", fetching: "забираем результат" };

export const STAGE_TEXT: Messages<typeof en.STAGE_TEXT> = { done: "готово", failed: "не получилось", running: "в работе", pending: "ждёт", skipped: "не нужна" };

export const DC_TEXT: Messages<typeof en.DC_TEXT> = {
  ACCEPTED: "принят", PROCESSING: "обрабатывается", VERIFYING: "проверяется", PASS_AUTOMATED: "готов", PASS_WITH_REVIEW: "готов",
  NEEDS_REVIEW: "готов", REJECTED_AUTOMATED: "готов (черновик)", CANCELLED: "отменён", FAILED: "ошибка",
};

export const WAIT_TEXT: Messages<typeof en.WAIT_TEXT> = {
  queue: "в очереди", at_converter: "у конвертера", doc_error: "конвертер пока не отдаёт результат", unavailable: "конвертер недоступен",
  config: "конвертер не пускает учётную запись", hold: "пауза администратора", ocr_rerun: "ждёт повтора распознавания", shaky: "перебои конвертера",
  storage: "хранилище недоступно", other: "ждёт",
};

export const converterState: Messages<typeof en.converterState> = {
  since: (when: string) => `с ${when.replace(/^в /, "")}`,
  bytes: (n: string) => `${n} Б`,
  units: ["КБ", "МБ", "ГБ", "ТБ"],
  health: (detail: string) => `Проверка состояния: ${detail}`,
  caps: (fast: boolean, version: string, when: string) => `${fast ? "Быстрый режим у конвертера есть" : "Быстрого режима у конвертера нет"}${version ? `, версия конвертера ${version}` : ""} (проверено ${when})`,
  unchecked: "Возможности конвертера ещё не проверялись — нажмите «Проверить подключение»",
  window: (k: number, effective: number, flight: number, suspect: number) => `Одновременно у конвертера — до ${k} ${pluralRu(k, ["документа", "документов", "документов"])}${effective !== k ? ` (сейчас можно ${effective})` : ""}; в работе: ${flight}${suspect ? `; приняты конвертером и не начаты слишком долго: ${suspect}` : ""}`,
  queue: (n: number, since: string, kinds: string) => `Ждут перевода в текст: ${formatCount(n)}${since ? `, самый давний ждёт ${since}` : ""}${kinds ? ` — ${kinds}` : ""}`,
  empty: "Очередь пуста: документов, ждущих перевода в текст, нет",
  uploads: (n: number, bytes: string) => `За 30 дней отправлено в конвертер: ${formatCount(n)} ${pluralRu(n, ["документ", "документа", "документов"])}${n ? `, ${bytes}` : ""}`,
  noUploads: "Журнал не прочитан: сколько документов отправлено за 30 дней, сейчас не видно",
  orphans: (n: number) => `У конвертера остались копии, которые памяти больше не нужны: ${formatCount(n)} (за год) — их убирают у конвертера вручную, номера — ниже`,
  noOrphans: "Журнал не прочитан: ненужные копии у конвертера сейчас не видны",
  reruns: (n: number) => `повторов распознавания: ${n}`,
  newRuns: (n: number) => `новых прогонов: ${n}`,
  terminal: (state: string) => `${state} — повтор даст тот же отказ`,
  other: "другой",
  missingRoles: (roles: string) => `Учётной записи памяти не хватает прав у конвертера: ${roles}`,
  woken: (n: number) => `Ждавшие документы продолжат сейчас: ${n}`,
  byteSize: (n: number): string => {
    if (n < 1024) return converterState.bytes(formatCount(n));
    let value = n / 1024, unit = 0;
    while (value >= 1024 && unit < converterState.units.length - 1) { value /= 1024; unit++; }
    return `${formatNumber(value, { maximumFractionDigits: value < 10 ? 1 : 0 })} ${converterState.units[unit]}`;
  },
  queueDetails: (n: number, when: string, kinds: Array<{ title: string; count: number }>): string => converterState.queue(n, when ? converterState.since(when) : "", kinds.map((kind) => `${kind.title}: ${kind.count}`).join(", ")),
  uploadsWithBytes: (n: number, bytes: number): string => converterState.uploads(n, converterState.byteSize(bytes)),
  repeatSummary: (reruns: number, newRuns: number): string => [reruns ? converterState.reruns(reruns) : "", newRuns ? converterState.newRuns(newRuns) : ""].filter(Boolean).join(", ") || "—",
  recentState: (phase: string | null, status: string, wait: keyof typeof WAIT_TEXT | null, terminal: boolean): string => {
    const state = phase && PHASE_TEXT[phase] ? PHASE_TEXT[phase]! : status === "pending" && wait ? WAIT_TEXT[wait] : STAGE_TEXT[status] ?? status;
    return terminal ? converterState.terminal(state) : state;
  },
};
