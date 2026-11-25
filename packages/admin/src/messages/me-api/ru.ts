// Messages in the language of the current request. One export per dictionary.
import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const ME_API_TEXT: Messages<typeof en.ME_API_TEXT> = {
  unauthorized: "сеанс не принят",
};
