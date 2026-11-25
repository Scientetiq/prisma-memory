import { formatNumber } from "../../i18n/format";
import { pluralRu, type Messages } from "../../i18n/core";
import type * as en from "./en";
import { formatCount } from "../../i18n/format";

export const nightCap: Messages<typeof en.nightCap> = {
  million: (n: string) => `${n} млн`,
  thousand: (n: string) => `${n} тыс.`,
  unavailable: "Ночной предел работы модели сейчас не посчитался — откройте отчёт позже.",
  worked: (used: string, cap: string) => `Ночью модель отработала ${used} токенов из ${cap}.`,
  capped: (at: string, waiting: number) => `Ночная обработка остановлена пределом в ${at}${waiting ? `, ждут следующей ночи: ${formatCount(waiting)} ${pluralRu(waiting, ["стадия", "стадии", "стадий"])}` : ""}. Если так бывает часто, предел можно поднять в настройках обработки («Ночной предел работы модели»).`,
  waiting: (n: number) => `Ждут ночной обработки: ${formatCount(n)} ${pluralRu(n, ["стадия", "стадии", "стадий"])}.`,
  tokenAmount: (n: number): string => {
    if (n >= 1_000_000) return nightCap.million(formatNumber(Math.floor(n / 100_000) / 10, { maximumFractionDigits: 1 }));
    if (n >= 10_000) return nightCap.thousand(formatCount(Math.floor(n / 1000)));
    return formatCount(Math.max(0, Math.floor(n)));
  },
  workedTokens: (used: number, cap: number): string => nightCap.worked(nightCap.tokenAmount(used), nightCap.tokenAmount(cap)),
};
