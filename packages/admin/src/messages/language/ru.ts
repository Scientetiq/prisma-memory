// The language switch in Russian. Same constants and keys as en.ts.
import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const language: Messages<typeof en.language> = {
  name: "Русский",
  label: "Язык интерфейса",
};
