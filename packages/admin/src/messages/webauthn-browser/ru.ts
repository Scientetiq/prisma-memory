import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const BROWSER_TEXT: Messages<typeof en.BROWSER_TEXT> = {
  notBase64url: "не base64url",
  theKeyDidNotConfirmTheRequestTimedOut: "Ключ не подтвердил: время вышло или касание отменено. Попробуйте ещё раз",
  thisKeyIsAlreadyRegistered: "Этот ключ уже зарегистрирован",
  theBrowserBlockedTheKeyAtThisAddressThe: "Браузер не дал работать с ключом на этом адресе: панель открыта не по тому имени, что задано в настройках (admin.webauthn_rp_id)",
  thisBrowserOrKeyDoesNotSupportTheRequired: "Этот браузер или ключ не поддерживает нужный способ подписи",
  couldNotCommunicateWithTheKeyCheckThatIt: "Не удалось поговорить с ключом. Проверьте, что ключ подключён, и попробуйте ещё раз",
};
