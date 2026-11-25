import type { Messages } from "../../i18n/core";
import * as en from "./en";

export const text: Messages<typeof en.text> = {
  gatewayIsNotResponding: "Гейтвей не отвечает",
  theMemoryResponseWasInterruptedDuring: "Ответ памяти оборвался посреди передачи",
};
