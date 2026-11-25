import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const SETTING_PAGE_TITLES: Messages<typeof en.SETTING_PAGE_TITLES> = {
  ldap: "Вход и LDAP",
  oidc: "Единый вход",
  smtp: "Почта",
  open_check: "Проверка открытого",
};
export const SETTING_LABEL_TEXT: Messages<typeof en.SETTING_LABEL_TEXT> = {
  text: (text: string): string => text,
};
