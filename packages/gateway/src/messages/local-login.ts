import { defineMessages } from "@memory/i18n";

export const LOCAL_LOGIN = defineMessages("gateway.local-login", {
  invalid: {
    en: "Wrong e-mail or password.",
    ru: "Неверная почта или пароль.",
  },
  limited: {
    en: "Too many failed sign-in attempts. Try again in {minutes} min.",
    ru: "Слишком много неудачных попыток входа. Повторите через {minutes} мин.",
  },
  in_flight: {
    en: "A sign-in is already being checked. Try again in a few seconds.",
    ru: "Вход уже проверяется. Повторите через несколько секунд.",
  },
  busy: {
    en: "The server is busy checking other sign-ins. Try again in a few seconds.",
    ru: "Сервер занят проверкой других входов. Повторите через несколько секунд.",
  },
  workplace_only: {
    en: "Sign-in with e-mail and password is accepted only from the workplace server.",
    ru: "Вход по почте и паролю принимается только от сервера рабочего места.",
  },
  bad_request: {
    en: "Send the e-mail, up to 200 characters, and the password, up to 1024 characters.",
    ru: "Укажите почту, до 200 знаков, и пароль, до 1024 знаков.",
  },
  audit_down: {
    en: "The audit journal is unavailable, so sign-in was not completed. Try again later.",
    ru: "Журнал аудита недоступен, поэтому вход не выполнен. Повторите позже.",
  },
  changed: {
    en: "The account changed while the sign-in was being checked. Sign in again.",
    ru: "Учётная запись изменилась, пока шла проверка входа. Войдите снова.",
  },
  internal: {
    en: "Sign-in was not completed because of an internal error. Try again later.",
    ru: "Вход не завершён из-за внутренней ошибки. Повторите позже.",
  },
});
