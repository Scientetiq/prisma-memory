import type { Messages } from "../../i18n/core";
import type * as en from "./en";
export const texts: Messages<typeof en.texts> = {
  allColleagues: "Все сотрудники",
  colleagueCard: "Карточка сотрудника",
  listCouldNotBeLoadedLine: "<tag1>Список не загрузился.</tag1> {value1}",
  moreColleaguesLine: "Ещё сотрудники<tag1/>",
};
