import { defineMessages } from "@memory/i18n";

export const LOCAL_PASSWORD = defineMessages("gateway.local-password-change", {
  session_only: {
    en: "Only the person, signed in to the workplace, can change their password.",
    ru: "Сменить пароль может только сам человек, вошедший в рабочее место.",
  },
  bad_request: {
    en: "Send the current password and the new one, up to 1024 characters each.",
    ru: "Передайте текущий пароль и новый, каждый до 1024 знаков.",
  },
  no_account: {
    en: "This account has no password of its own here, so there is nothing to change.",
    ru: "У этой учётной записи здесь нет своего пароля, поэтому менять нечего.",
  },
  wrong_current: {
    en: "The current password is wrong.",
    ru: "Текущий пароль неверен.",
  },
  limited: {
    en: "Too many wrong attempts. Try again in {minutes} min.",
    ru: "Слишком много неверных попыток. Повторите через {minutes} мин.",
  },
  in_flight: {
    en: "A password change is already being checked. Try again in a few seconds.",
    ru: "Смена пароля уже проверяется. Повторите через несколько секунд.",
  },
  busy: {
    en: "The server is busy checking other sign-ins. Try again in a few seconds.",
    ru: "Сервер занят проверкой других входов. Повторите через несколько секунд.",
  },
  same_as_current: {
    en: "The new password must differ from the current one.",
    ru: "Новый пароль должен отличаться от текущего.",
  },
  too_short: {
    en: "The password must be at least 12 characters long.",
    ru: "Пароль должен быть не короче 12 знаков.",
  },
  too_long: {
    en: "The password must be at most 1024 characters long.",
    ru: "Пароль должен быть не длиннее 1024 знаков.",
  },
  same_as_login: {
    en: "The password must not be your e-mail address or its first part.",
    ru: "Пароль не должен совпадать с вашей почтой или её первой частью.",
  },
  one_character: {
    en: "The password must not be one character repeated.",
    ru: "Пароль не должен состоять из одного повторяющегося знака.",
  },
  common: {
    en: "This password is too common. Choose another one.",
    ru: "Этот пароль слишком распространён. Выберите другой.",
  },
  audit_down: {
    en: "The audit journal is unavailable, so the password was not changed. Try again later.",
    ru: "Журнал аудита недоступен, поэтому пароль не изменён. Повторите позже.",
  },
  changed: {
    en: "The account changed while the password was being checked. Nothing was changed. Try again.",
    ru: "Учётная запись изменилась, пока шла проверка пароля. Ничего не изменено. Повторите.",
  },
  internal: {
    en: "The password was not changed because of an internal error. Try again later.",
    ru: "Пароль не изменён из-за внутренней ошибки. Повторите позже.",
  },
});
