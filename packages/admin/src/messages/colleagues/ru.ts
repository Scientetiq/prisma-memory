import type { Messages } from "../../i18n/core";
import type * as en from "./en";
export const colleagues: Messages<typeof en.colleagues> = {
  colleagues: "Сотрудники",
  findAColleagueByNameOrDepartment: "Найдите коллегу по имени, фамилии или подразделению и откройте записи с его участием.",
  nameOrDepartment: "Имя, фамилия или подразделение",
  forExampleSmith: "Например: Смирнов",
  theColleagueDirectoryIsUnavailableToYou: "Справочник сотрудников вам недоступен: его видят сотрудники компании.",
  noColleagueCardsYetTheyAppearWhen: "Карточек сотрудников пока нет: они появляются, когда администратор загружает орг-таблицу.",
  noCardsOnThisPageTheyAre: "На этой странице карточек нет — они дальше по списку.",
  noOneFoundForCheckTheSpelling: (value0: unknown): string => `Никого не нашли по запросу «${value0}». Проверьте написание или поищите по фамилии или подразделению.`,
  showingTheFirstRefineYourSearchTo: (value0: unknown): string => `Показаны первые ${value0} — уточните запрос, чтобы найти нужного человека.`,
  colleagueCardsAreInColleaguesSearchBy: "Карточки сотрудников — в разделе «Сотрудники»: там поиск коллег по имени и подразделению.",
  recordsInvolving: "Записи с участием",
  colleague: "сотрудник",
  unnamed: "Без имени",
};
