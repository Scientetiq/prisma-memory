// Messages in the language of the current request. One export per dictionary.
import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const UPLOAD_TEXT: Messages<typeof en.UPLOAD_TEXT> = {
  tooLarge: (max: number): string => `Файл больше ${max} МБ`,
  origin: "Загрузка принимается только со страниц рабочего места",
  expired: "Сеанс завершён — войдите снова",
  formRequired: "Ожидалась форма с файлом",
  fileRequired: "Файл не передан",
  invalidSpace: "Неверное пространство",
  cannotWrite: "В это пространство вы не пишете: выберите своё или то, где вы владелец или участник",
};
