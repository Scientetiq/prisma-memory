import { tr } from "@memory/i18n/context";
import { LOCAL_ACCOUNTS as messages } from "./messages/local-accounts-admin.ts";

export const localAccountsMessage = (name: keyof typeof messages): string => tr(messages[name]);
