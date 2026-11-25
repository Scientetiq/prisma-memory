// Messages in the language of the current request. One export per dictionary.
import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const PREVIEW_TEXT: Messages<typeof en.PREVIEW_TEXT> = {
  previewDenied: "В предпросмотре только просмотр",

  previewDeniedHint: "Предпросмотр открыт только для чтения: можно смотреть, искать и читать. Чтобы что-то изменить, выйдите из предпросмотра и войдите в рабочее место под своей учётной записью.",
  bar: (persona: string, role: string): string => `Вы смотрите как ${persona} (${role}, вымышленный сотрудник для показа). Это только просмотр: запоминать, загружать, удалять, показывать записи агентам, выпускать ключи и менять участников отсюда нельзя.`,
};
