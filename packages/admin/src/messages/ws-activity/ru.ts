import type { Messages } from "../../i18n/core";
import * as en from "./en";

export const pageText: Messages<typeof en.pageText> = {
  myActions: "Мои действия",
  automatic: "служебное",
  theWorkspaceLoadedThisAutomaticallyWhen: "Рабочее место загрузило это само при открытии страницы — это не действие человека и не агента.",
  whatYouAndYourAgentsDid: "Что делали вы и ваши агенты от вашего имени. Тексты запросов и содержимое записей сюда не попадают.",
  whatToShow: "Что показать",
  whoseActions: "Чьи действия",
  actionType: "Вид действия",
  auditLog: "журнал",
  noMoreActions: "Дальше действий нет.",
  noMatchingActions: "Таких действий не было.",
  showHighlights: "Показать главное",
  noActionsYetUploadAFile: "Действий пока нет: загрузите файл или подключите агента — его действия появятся здесь.",
  connectAnAgent: "<tag0/>Подключить агента",
  pages: "Страницы",
  backToTheStart: "← в начало",
  earlier: "раньше →",
  records: "записей: {value0}",
  last: "{value0}, последний — ",
  details: "Подробнее",
  tool: "Инструмент",
  program: "Программа",
  sourceTheProgramSuppliesItsOwn: (value0: string | number | null | undefined): string => `Откуда: ${value0}. Имя присылает сама программа — на права оно не влияет.`,
  results: "Результатов",
};
