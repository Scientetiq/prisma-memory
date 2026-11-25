import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const TEXT: Messages<typeof en.TEXT> = {
  atMostCharacters: (value1: string | number | null | undefined): string => `Не длиннее ${value1} знаков`,
  typeAtLeastCharacters: (value1: string | number | null | undefined): string => `Наберите от ${value1} знаков`,
  suggestionsAreUnavailableInAuditorView: "В режиме аудитора подсказок нет",
  yourPanelSessionHasEndedSignIn: "Сеанс панели завершён — войдите снова",
};
