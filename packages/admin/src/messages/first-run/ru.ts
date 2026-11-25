import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const TEXT: Messages<typeof en.TEXT> = {
  firstRunCodeHint: "Код — на сервере: установка (setup) записала его в файл secrets/gateway/first-run-code в домашней папке установки, а строка Install code в итоге setup показывает команду, которая его выводит. Если такого файла нет, гейтвей один раз вывел код в свой журнал (событие first_run_code_generated). Его видит только тот, у кого есть доступ к серверу.",
  theGatewayReturnedHTTP: (value1: string | number | null | undefined): string => `Гейтвей ответил ошибкой HTTP ${value1}`,
  tooManyIncorrectCodesInARow: (value1: string | number | null | undefined): string => `Слишком много неверных кодов подряд. Попробуйте снова через ${value1} мин.`,
  theFirstAdministratorHasAlreadyBeenCreated: "Первичный администратор уже создан — войдите под его учётной записью",
  theSetupCodeDidNotWorkCheck: "Код установки не подошёл. Выведите его на сервере ещё раз командой из строки Install code в итоге setup (файл secrets/gateway/first-run-code в домашней папке установки; если такого файла нет — событие first_run_code_generated в журнале гейтвея), скопируйте только код, без знаков после него, и введите его ещё раз.",
};
