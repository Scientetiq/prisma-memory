// Messages in the language of the current request. One export per dictionary.
import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const STATUS_TEXT: Messages<typeof en.STATUS_TEXT> = {
  expired: "Сеанс завершён",
  idsRequired: "Не переданы идентификаторы записей",
  tooMany: (max: number): string => `За раз можно спросить не больше ${max} записей`,
};
