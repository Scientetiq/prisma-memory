import { tr } from "@memory/i18n/context";
import { LOCAL_ACCOUNTS_MANAGE as messages } from "./messages/local-accounts-manage.ts";

export const localAccountsManageMessage = (name: keyof typeof messages): string => tr(messages[name]);
