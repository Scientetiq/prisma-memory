import type { Messages } from "../../i18n/core";
import type * as en from "./en";
export const spaces: Messages<typeof en.spaces> = {
  personalAndCompanyWide: "Личное и вся компания",
  departmentAndTeams: "Подразделение и команды",
  projects: "Проекты",
  myTeam: "Моя команда",
  myTeams: "Мои команды",
};

export const MONTHS: Messages<typeof en.MONTHS> = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"] as const;

export const PROJECT_TAB_TITLES: Messages<typeof en.PROJECT_TAB_TITLES> = { overview: "Обзор", records: "Записи", members: "Участники", repo: "Для разработчиков", settings: "Настройки" };
