import { defineMessages } from "@memory/i18n";

export const LOCAL_ACCOUNTS_MANAGE = defineMessages("gateway.local-accounts-manage", {
  no_account: {
    en: "This person has no local account.",
    ru: "У этого человека нет своей учётной записи.",
  },
  internal: {
    en: "The change was not made because of an internal error. Try again later.",
    ru: "Изменение не выполнено из-за внутренней ошибки. Повторите позже.",
  },
});
