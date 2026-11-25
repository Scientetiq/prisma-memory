// Messages in the language of the current request. One export per dictionary.
import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const FORM_TEXT: Messages<typeof en.FORM_TEXT> = {
  openAckMissing: "Отметьте, что согласны: записи проекта будут читать ИИ-агенты участников",
  openAckNote: "Отметьте «Понимаю…» в шаге 2 — или выберите «Только люди»",
};
