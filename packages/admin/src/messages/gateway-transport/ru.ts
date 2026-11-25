// Messages in the language of the current request. One export per dictionary.
import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const TRANSPORT_TEXT: Messages<typeof en.TRANSPORT_TEXT> = {
  absoluteSocket: "адрес шлюза unix:<путь> — путь абсолютный",
  addressScheme: "адрес шлюза — http(s)://… или unix:<путь>",
  panelOnly: "Панель (MEMORY_WEB_ROLE=panel) не ходит в рабочее место шлюза",
  workplaceOnly: "Рабочее место (MEMORY_WEB_ROLE=workplace) не ходит в админ-API шлюза",
  adminAddressRequired: "GATEWAY_ADMIN_URL не задан: панели (MEMORY_WEB_ROLE=panel) нужен адрес админ-слушателя шлюза",
};
