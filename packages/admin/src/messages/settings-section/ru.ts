import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const SETTINGS_SECTION_TEXT: Messages<typeof en.SETTINGS_SECTION_TEXT> = {
  unknownSection: (category: string): string => `Гейтвей не знает раздел ${category}: обновите схему (contracts/schema) и перезапустите гейтвей`,
  stale: "Ничего не сохранено: часть настроек уже изменили в другом окне — обновите страницу и повторите",
  staleFields: (labels: string): string => `Изменены в другом окне: ${labels}`,
  fixFields: "Исправьте отмеченные поля — ничего не сохранено",
  noChanges: "Изменений нет — сохранять нечего",
  notSavedFields: "Не сохранено: исправьте отмеченные поля",
  notSaved: (message: string): string => `Не сохранено: ${message}`,
  changed: (labels: string): string => `Изменены: ${labels}`,
  sessionsEnded: (label: string, n: number): string => `${label}: ${n} — изменилось, кто и как входит; люди войдут заново`,
  saved: (n: number): string => `Сохранено: ${n}`,
};
