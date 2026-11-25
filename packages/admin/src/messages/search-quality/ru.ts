import { pluralRu, type Messages } from "../../i18n/core";
import type * as en from "./en";
import { formatCount } from "../../i18n/format";

export const searchQuality: Messages<typeof en.searchQuality> = {
  fewerPeople: (n: number) => `меньше ${formatCount(n)} ${pluralRu(n, ["человека", "человек", "человек"])}`,
  fewerMembers: (n: number) => `меньше ${formatCount(n)} ${pluralRu(n, ["участника", "участников", "участников"])}`,
  peopleCount: (n: number) => `${formatCount(n)} ${pluralRu(n, ["человек", "человека", "человек"])}`,
  smallWeek: (n: number) => `мало данных — искали меньше ${formatCount(n)} ${pluralRu(n, ["человека", "человек", "человек"])}`,
  smallSessions: (n: number) => `мало данных — с ИИ-агентами работали меньше ${formatCount(n)} ${pluralRu(n, ["человека", "человек", "человек"])}`,
  smallSpaces: (n: number, spaces: number) => `Небольшие пространства — меньше ${formatCount(n)} ${pluralRu(n, ["участника", "участников", "участников"])} (${formatCount(spaces)})`,
  smallNote: (n: number) => `Если искали меньше ${formatCount(n)} ${pluralRu(n, ["человека", "человек", "человек"])}, числа не показываем: иначе по ним можно узнать, как ищет конкретный сотрудник.`,
  emptyNothing: (n: number) => `Пока нечего показать: поисков ещё не было или их делали меньше ${formatCount(n)} ${pluralRu(n, ["человека", "человек", "человек"])}.`,
  sliceHidden: (n: number) => `Разрез не показан: в нём меньше ${formatCount(n)} ${pluralRu(n, ["человека", "человек", "человек"])}`,
  emptyQueriesLead: (n: number) => `Чего в памяти не нашлось. Текст показываем, только если так спрашивали не меньше ${formatCount(n)} разных людей; тексты запросов хранятся 90 дней.`,
  emptyQueriesTail: (hidden: number, n: number) => `Ещё ${formatCount(hidden)} ${pluralRu(hidden, ["запрос", "запроса", "запросов"])} без результата задавали меньше ${formatCount(n)} ${pluralRu(n, ["человека", "человек", "человек"])} — их текст не показываем.`,
  emptyQueriesNone: (n: number) => `Нет запросов без результата, которые задавали бы ${formatCount(n)} ${pluralRu(n, ["человек", "человека", "человек"])} и больше.`,
  corrections: (day: string) => `досчитается к ${day}`,
  notBuilt: "Подсчёт ещё ни разу не прошёл: он идёт раз в 15 минут.",
  behind: (n: number) => `Подсчёт отстаёт на ${formatCount(n)} ч — сообщите тому, кто обслуживает память.`,
  lastBuilt: "Последний расчёт:",
  numbersAppear: (n: number) => `Числа появятся, когда за неделю будут искать хотя бы ${formatCount(n)} ${pluralRu(n, ["разный человек", "разных человека", "разных людей"])}`,
  previousWeek: (value: string) => `прошлая неделя — ${value}`,
  change: (what: string, up: boolean, before: string, after: string) => `${what} ${up ? "чаще" : "реже"}: ${before} → ${after}`,
  pooledLead: (n: number) => `Недели, где искали меньше нужного числа людей, складываются в постоянные периоды по четыре недели: здесь ${formatCount(n)} ${pluralRu(n, ["неделя сложена", "недели сложены", "недель сложено"])} вместе.${n < 4 ? " Недели этого периода, где искали достаточно людей, показаны отдельно и в сумму не входят." : ""} Числа периода появляются через неделю после его конца, когда досчитаны исправления, и больше не меняются. Недели внутри него по отдельности не показываем, чтобы вклад одного человека нельзя было вычислить вычитанием.`,
  poolWait: "Недели, где искали меньше, складываются по четыре: числа такого периода появятся через неделю после его конца, если вместе за него искало достаточно людей.",
  metricChange: (key: keyof typeof METRIC_WHAT, up: boolean, before: string, after: string, summary: boolean): string => {
    const change = searchQuality.change(METRIC_WHAT[key], up, before, after);
    return summary ? `Больше всего изменилось: ${change}.` : change;
  },
};

export const SQ_TEXT: Messages<typeof en.SQ_TEXT> = {
  lead: "Помогает ли поиск памяти: находит ли он что-нибудь, открывают ли найденное и с какого места в выдаче. Считается по журналу — без текстов записей и без чисел по отдельным сотрудникам. Данные обновляются раз в 15 минут; неделя показывается, когда она закончилась.",
  exactHint: "Агент сообщил, из какого поиска открыл запись. Остальное память связывает сама: тот же ключ, не позже 10 минут после поиска.",
  current: "Неделя ещё идёт — числа появятся в понедельник",
  rules: "в эту неделю менялись правила подсчёта — сравнивайте осторожно",
  off: "Подсчёт выключен администратором в настройках (раздел «Наблюдаемость»). Прежние данные остаются.",
  failed: "Не удалось посчитать — сообщите тому, кто обслуживает память.",
  stale: "Разрезы пересчитываются после смены настроек — загляните через 15 минут.",
  queued: "Пересчёт запущен, обновите страницу через минуту.",
};

export const METRIC_WHAT: Messages<typeof en.METRIC_WHAT> = {
  zero_share: "ничего не находят",
  read1_share: "первую находку открывают",
  read3_share: "одну из первых трёх открывают",
  no_read_share: "ничего не открывают",
  reformulated_share: "сразу спрашивают иначе",
  corrected_share: "найденное потом исправляют",
  outdated_share: "устаревшим отмечают",
  useful_share: "полезным отмечают",
};
