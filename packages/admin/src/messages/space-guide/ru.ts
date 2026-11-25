import { pluralRu } from "../../i18n/core";
import type { Messages } from "../../i18n/core";
import type * as en from "./en";
export const spaceGuide: Messages<typeof en.spaceGuide> = {
  quote: (name: string): string => `«${name}»`,
  tokenCount: (n: number): string => `Сейчас — около ${n} ${pluralRu(n, ["токен", "токена", "токенов"])}.`,
  token: "токен",
  tokens: "токена",
};
