import type { Messages } from "../../i18n/core";
import * as en from "./en";

export const text: Messages<typeof en.text> = {
  skillInstallInvalidArchiveAddressFormat: "skill-install: адрес архива неверной формы",
  skillInstallArchiveChecksumIsNot: "skill-install: сумма архива — не SHA-256",
  invalidLineBreakInConnectionParameters: "Недопустимый перенос в параметрах подключения",
};
