// Messages in the language of the current request. One export per dictionary.
import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const WEB_ROLE_TEXT: Messages<typeof en.WEB_ROLE_TEXT> = {
  invalid: (v: string): string => `MEMORY_WEB_ROLE=${v.slice(0, 20)}: ожидается all, workplace или panel`,
};
