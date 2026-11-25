import type { Messages } from "../../i18n/core";
import * as en from "./en";

export const actionsText: Messages<typeof en.actionsText> = {
  noServiceSelected: "Не выбран сервис",
  thisServiceNoLongerReadsOn: "Этот сервис больше не читает от имени сотрудников",
  allowedCanReadMemoryOnYour: (value0: string | number | null | undefined): string => `Разрешено: «${value0}» может читать память от вашего имени`,
  untilRenewPermissionAfterwardsIfNeeded: (value0: string | number | null | undefined): string => `До ${value0} — потом разрешите снова, если нужно`,
  noConsentId: "Нет номера согласия",
  consentHasAlreadyEnded: "Согласие уже закрыто",
};

export const pageText: Messages<typeof en.pageText> = {
  companyServicesThatCanSearchAnd: "Какие сервисы компании могут искать и читать память от вашего имени — видеть то же, что видите вы. Вы решаете, кому это разрешить; отозвать можно в любой момент.",
  services: "сервисы",
  services2: "Сервисы",
  noServicesCurrentlyReadOnBehalf: "Сервисов, которые читают от имени сотрудников, сейчас нет.",
  notAllowed: "не разрешено",
  allowedUntil: "разрешено до <tag0/>",
  ended: "закрыто",
  expired: "срок вышел <tag0/>",
  renew: "Продлить",
  withdraw: "Отозвать",
  revokePermission: "Отозвать разрешение?",
  allow: "Разрешить",
  allowToReadOnYourBehalf: (value0: string | number | null | undefined): string => `Разрешить «${value0}» читать от вашего имени?`,
  withinItsPermissionsTheServiceCan: "Сервис сможет искать и читать то, что видите вы, в пределах своих прав. Каждое чтение от вашего имени видно в «Моих действиях».",
};
