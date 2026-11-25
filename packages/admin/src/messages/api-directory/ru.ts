// Messages in the language of the current request. One export per dictionary.
import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const DIRECTORY_TEXT: Messages<typeof en.DIRECTORY_TEXT> = {
  expired: "Сеанс завершён — войдите снова",
  tooShort: (min: number): string => `Наберите от ${min} знаков`,
  tooLong: (max: number): string => `Не длиннее ${max} знаков`,
};
