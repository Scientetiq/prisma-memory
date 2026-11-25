import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const REVOKED_BY: Messages<typeof en.REVOKED_BY> = {
    person: "отозвал сам сотрудник",
    admin: "отозвал администратор",
    service_off: "сервис выключен или больше не читает от имени людей",
    person_inactive: "сотрудник неактивен",
    expired: "истёк срок",
};

export const STATE_BADGES: Messages<typeof en.STATE_BADGES> = {
    live: { title: "действует", tone: "ok" },
    expired: { title: "истекло", tone: "warn" },
    revoked: { title: "отозвано", tone: "muted" },
    none: { title: "не давалось", tone: "neutral" },
};

export const ACTIONS_TEXT: Messages<typeof en.ACTIONS_TEXT> = {
  noConsentID: "Нет номера согласия",
  consentRevoked: "Согласие отозвано",
  theServiceCanNoLongerReadOnBehalfOf: "Сервис больше не читает от имени этого сотрудника; сотрудник увидит отзыв в «Моих действиях»",
  consentAlreadyClosed: "Согласие уже закрыто",
  notRevokedResponseValue1: (value1: string | number): string => `Не отозвано: ответ ${value1}`,
};

export const PAGE_TEXT: Messages<typeof en.PAGE_TEXT> = {
  readConsentsOnBehalfOfPeople: "Согласия «от имени»",
  readConsentsOnBehalfOfPeople2: "Согласия «от имени»",
  consents: "Согласия",
  consents2: "согласия",
  noConsents: "Согласий нет.",
  service: "Сервис",
  colleague: "Сотрудник",
  status: "Состояние",
  expiry: "Срок",
  actions: "Действия",
  service2: "Сервис",
  colleague2: "Сотрудник",
  status2: "Состояние",
  closed: "закрыто",
  expiry2: "Срок",
  grantedValue1: "выдано {value1}",
  untilValue1: "до {value1}",
  actions2: "Действия",
  revoke: "Отозвать",
  revokeConsent: "Отозвать согласие?",
  thisColleague: "сотрудника",
  value1WillNoLongerBeAbleToReadOn: (value1: string | number, value2: string | number): string => `«${value1}» больше не сможет читать от имени ${value2}. Вернуть может только сам сотрудник в рабочем месте.`,
  revoke2: "Отозвать",
  consents3: "согласий",
};

export const VIEW_TEXT: Messages<typeof en.VIEW_TEXT> = {
  oboAdminLead: "Сервисы, которые читают память от имени сотрудников, делают это только с их согласия, если включён режим access.obo_read_consent = consent (legacy — согласие не нужно, off — чтение от имени выключено всем). Согласие даёт сам сотрудник в рабочем месте, раздел «Доступ сервисов»; администратор может только отозвать. Срок — access.obo_read_consent_days. Здесь — действующие согласия и закрытые за последние 90 дней.",
  theServiceCanReadMemoryOnYourBehalfOnly: "Сервис читает память от вашего имени, только пока действует ваше разрешение. Без разрешения он может от вашего имени только записывать.",
  withoutConsentTheServiceCannotReadOnYourBehalf: "без разрешения сервис не читает от вашего имени",
  value1WillStopReadingMemoryOnYourBehalf: (value1: string | number): string => `«${value1}» перестанет читать память от вашего имени.`,
  consentRevokedTheServiceCanNoLongerReadOn: "Согласие отозвано: сервис больше не читает от вашего имени",
  consentIsCurrentlyOptionalServicesWithReadAccessCan: "Сейчас разрешение не требуется: сервисы с правом чтения читают от имени сотрудников, как раньше. Можно разрешить заранее — оно понадобится, когда администратор включит согласие.",
  noConsentWhileConsentIsOptionalTheServiceCan: "разрешения нет — пока согласие не включено, сервис читает и без него",
  consentWillBeClosedUntilAnAdministratorRequiresConsent: (value1: string | number): string => `Разрешение будет закрыто. Пока администратор не включил согласие, «${value1}» читает от имени сотрудников и без разрешения.`,
  consentRevokedUntilAnAdministratorRequiresConsentTheService: "Разрешение отозвано. Пока администратор не включил согласие, сервис читает от имени сотрудников и без разрешения",
  readingOnBehalfOfColleaguesIsCurrentlyDisabledFor: "Сейчас чтение от имени сотрудников выключено всем сервисам. Разрешение можно дать заранее.",
  noConsentReadingOnBehalfOfPeopleIsCurrently: "разрешения нет — сейчас чтение от имени выключено всем",
  consentWillBeClosedValue1AlreadyCannotReadOn: (value1: string | number): string => `Разрешение будет закрыто. Сейчас «${value1}» и так не читает от вашего имени: чтение от имени выключено всем сервисам.`,
  consentRevokedReadingOnBehalfOfColleaguesIsCurrently: "Разрешение отозвано. Сейчас чтение от имени и так выключено всем сервисам",
};
