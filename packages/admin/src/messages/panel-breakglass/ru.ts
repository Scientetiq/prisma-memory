import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const REASONS: Messages<typeof en.REASONS> = {
    keys_lost: "ключи безопасности потеряны", sso_down: "провайдер единого входа недоступен", directory_down: "каталог недоступен", incident: "инцидент", drill: "учения",
};

export const PAGE_TEXT: Messages<typeof en.PAGE_TEXT> = {
  emergencyAccess: "Аварийный доступ",
  emergencyAccess2: "Аварийный доступ",
  openAnEmergencyAccessWindowOnTheVMFrom: "Окно аварийного доступа открывается на ВМ командой memory-admin-cli breakglass open с бастиона: две половины ключа вводят по очереди их хранители. Пока окно открыто, можно войти без ключа безопасности, но только для сужающих действий и чтения; вторую подпись такие сессии не дают. Окно — не дольше admin.breakglass_max_hours (до 2 часов); закрытие отзывает все его сессии.",
  emergencyAccessStatus: "состояние аварийного доступа",
  window: "Окно",
  tag1WindowOpenTag1Value2: "<tag1>Окно открыто</tag1>{value2}.",
  closesAutomaticallyValue1ToCloseItEarlierRunMemory: "Закроется само: {value1}. Закрыть раньше — memory-admin-cli breakglass close на ВМ.",
  windowClosed: "Окно закрыто.",
};
