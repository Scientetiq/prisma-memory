// Messages in the language of the current request. One export per dictionary.
import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const FINGERPRINT_TEXT: Messages<typeof en.FINGERPRINT_TEXT> = {
  invalidJson: "Отпечаток: вставьте вторую строку вывода команды целиком — {\"key_sha256\": …, \"key_prefix\": …}",
  secretEntered: "Это похоже на сам секрет ключа: его в панель не вставляют — только отпечаток (вторую строку вывода команды)",
  shaRequired: "Отпечаток: нужен sha256 секрета — 64 шестнадцатеричных знака",
  prefixRequired: "Отпечаток: нужен префикс ключа — первые 8 знаков секрета (mem_s_ и два знака)",
};
