import { tr } from "@memory/i18n/context";
import { LOCAL_LOGIN as messages } from "./messages/local-login.ts";

export const localLoginMessage = (name: Exclude<keyof typeof messages, "limited">): string => tr(messages[name]);
export const localLoginLimited = (minutes: number): string => tr(messages.limited, { minutes });
