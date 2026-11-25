import type { Messages } from "../../i18n/core";
import type * as en from "./en";
export const texts: Messages<typeof en.texts> = {
  confirm: "Подтвердить",
  delete: "Удалить",
  moreDetails: "Подробнее",
  awaitingADecision: (value0: unknown): string => `Ждут решения: ${value0}`,
  hiddenFromAgentsUntilYouDecideThese: (value0: unknown): string => `Скрыты от агентов до вашего решения: ${value0} — они первыми.`,
  nothingFurther: "Дальше пусто.",
  record: "Запись",
  author: "Автор",
  whereFromAndWhen: "Откуда и когда",
  marks: "Отметки",
  decision: "Решение",
  record2: "Запись",
  untitled: "Без названия",
  author2: "Автор",
  leftTheCompany: "уволен",
  whereFromAndWhen2: "Откуда и когда",
  marks2: "Отметки",
  decision2: "Решение",
  oldestRecordArrivedOnLine: "Самая давняя пришла <tag1/>.",
  arrivedOnLine: "пришла <tag1/> · {value1}",
};

export const actions: Messages<typeof en.actions> = {
  chooseWrongOrNotForEveryone: "Выберите: «Неверно» или «Не для всех».",
  explainWhatIsCorrectThisWillBecome: "Напишите, что верно: это станет исправлением записи.",
  tooLongMaximum2000Characters: "Слишком длинно: до 2 000 знаков.",
  recordNotFoundOrNotVisibleTo: "Запись не найдена или вам не видна.",
  unknownAction: "Неизвестное действие.",
};
