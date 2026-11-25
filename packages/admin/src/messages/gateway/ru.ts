// Messages in the language of the current request. One export per dictionary.
import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const GATEWAY_TEXT: Messages<typeof en.GATEWAY_TEXT> = {
  unreachable: "Гейтвей не отвечает: проверьте, что сервис gateway запущен и доступен панели",
  responseLost: "Ответ памяти оборвался посреди передачи: выполнено ли действие, неизвестно",
  httpError: (status: number): string => `Гейтвей ответил ошибкой HTTP ${status}`,
  healthUnexpected: "Гейтвей вернул неожиданный ответ на /api/v1/health",
  healthUnreachable: "Гейтвей не отвечает",
};
