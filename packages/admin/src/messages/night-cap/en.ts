import { formatNumber } from "../../i18n/format";
import { pluralEn } from "../../i18n/core";
import { formatCount } from "../../i18n/format";

export const nightCap = {
  million: (n: string) => `${n} million`,
  thousand: (n: string) => `${n} thousand`,
  unavailable: "The model’s night limit could not be calculated. Open the report later.",
  worked: (used: string, cap: string) => `The model used ${used} tokens overnight out of ${cap}.`,
  capped: (at: string, waiting: number) => `Night processing reached its limit at ${at}${waiting ? `; ${formatCount(waiting)} ${pluralEn(waiting, "stage is", "stages are")} waiting for the next night` : ""}. If this happens often, increase the limit in processing settings (“Model night limit”).`,
  waiting: (n: number) => `Waiting for night processing: ${formatCount(n)} ${pluralEn(n, "stage", "stages")}.`,
  tokenAmount: (n: number): string => {
    if (n >= 1_000_000) return nightCap.million(formatNumber(Math.floor(n / 100_000) / 10, { maximumFractionDigits: 1 }));
    if (n >= 10_000) return nightCap.thousand(formatCount(Math.floor(n / 1000)));
    return formatCount(Math.max(0, Math.floor(n)));
  },
  workedTokens: (used: number, cap: number): string => nightCap.worked(nightCap.tokenAmount(used), nightCap.tokenAmount(cap)),
};
