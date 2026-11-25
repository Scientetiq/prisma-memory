import { pluralEn } from "../../i18n/core";
export const spaceGuide = {
  quote: (name: string): string => `“${name}”`,
  tokenCount: (n: number): string => `Currently about ${n} ${pluralEn(n, "token", "tokens")}.`,
  token: "token",
  tokens: "tokens",
};
