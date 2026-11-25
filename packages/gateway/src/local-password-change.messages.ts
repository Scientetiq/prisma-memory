import { tr } from "@memory/i18n/context";
import { LOCAL_PASSWORD as messages } from "./messages/local-password-change.ts";

export function localPasswordMessage(...args: [key: Exclude<keyof typeof messages, "limited">] | [key: "limited", minutes: number]): string {
  const [key, minutes] = args;
  return key === "limited" ? tr(messages[key], { minutes }) : tr(messages[key]);
}
