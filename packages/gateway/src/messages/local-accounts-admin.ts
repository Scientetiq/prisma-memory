import { defineMessages } from "@memory/i18n";

export const LOCAL_ACCOUNTS = defineMessages("gateway.local-accounts-admin", {
  link_invalid: {
    en: "This link is not valid any more. Ask the administrator for a new one.",
    ru: "Эта ссылка больше не действует. Попросите у администратора новую.",
  },
  setup_bad_request: {
    en: "Send the link and the new password.",
    ru: "Передайте ссылку и новый пароль.",
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
  security_mode_advanced: {
    en: "Local accounts are managed only in the security mode basic.",
    ru: "Свои учётные записи управляются только в режиме безопасности basic.",
  },
  directory_person: {
    en: "This person signs in through the company directory, so a local account is not created for them.",
    ru: "Этот человек входит через каталог компании, поэтому своя учётная запись ему не создаётся.",
  },
  account_exists: {
    en: "This person already has a local account with a password. Use the password reset.",
    ru: "У этого человека уже есть своя учётная запись с паролем. Используйте сброс пароля.",
  },
  account_disabled: {
    en: "This person's local account is disabled.",
    ru: "Своя учётная запись этого человека отключена.",
  },
  person_inactive: {
    en: "This person's card is inactive.",
    ru: "Карточка этого человека отключена.",
  },
  login_case_conflict: {
    en: "This sign-in name differs from an existing person's sign-in name only in letter case.",
    ru: "Это имя для входа отличается от имени уже существующего человека только регистром букв.",
  },
  bad_login: {
    en: "The sign-in name must be an e-mail address of up to 200 characters.",
    ru: "Имя для входа должно быть адресом почты не длиннее 200 знаков.",
  },
  bad_name: {
    en: "Give the person's name, 1 to 200 characters.",
    ru: "Укажите имя человека, от 1 до 200 знаков.",
  },
});
