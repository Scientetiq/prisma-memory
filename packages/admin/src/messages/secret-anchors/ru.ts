// Messages in the language of the current request. One export per dictionary.
import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const ANCHOR_MESSAGES: Messages<typeof en.ANCHOR_MESSAGES> = {
  oidc: "при смене издателя, client ID или корневого сертификата введите секрет клиента заново",
  ldap: "при смене контроллеров, порта, шифрования, сертификата или учётной записи введите пароль служебной учётной записи заново",
  smtp: "при смене почтового сервера, порта, шифрования, сертификата или логина введите пароль почты заново"
};
