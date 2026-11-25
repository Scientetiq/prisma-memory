import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const TEXT: Messages<typeof en.TEXT> = {
    stepup_required: "Сначала подтвердите себя касанием уже зарегистрированного ключа (кнопка «Подтвердить касанием»)",
    admin_webauthn_missing: "У вас ещё нет ключей — зарегистрируйте первый",
    webauthn_failed: "Ключ не подтвердил действие. Попробуйте ещё раз",
};

export const TRANSPORT_TITLES: Messages<typeof en.TRANSPORT_TITLES> = {
    usb: "USB", nfc: "NFC", ble: "Bluetooth", internal: "встроенный", hybrid: "телефон", "smart-card": "смарт-карта",
};

export const ROLE_TITLES: Messages<typeof en.ROLE_TITLES> = { memory_admin: "администратор", security_auditor: "аудитор ИБ" };

export const ACTIONS_TEXT: Messages<typeof en.ACTIONS_TEXT> = {
  notSso: "Ключи безопасности привязаны к сессии корпоративного входа: войдите в панель через корпоративный вход",
  notCompletedResponseValue1: (value1: string | number): string => `Не выполнено: ответ ${value1}`,
  keyRegistered: "Ключ зарегистрирован",
  touchAcceptedYouCanRemoveAKeyOrAdd: "Касание принято: несколько минут можно удалять ключ и добавлять новый",
  noKeyID: "Нет номера ключа",
  keyRemovedItCanNoLongerBeUsedTo: "Ключ удалён: войти им больше нельзя",
};

export const PAGE_TEXT: Messages<typeof en.PAGE_TEXT> = {
  lead: "Ключ безопасности (USB или NFC, отпечаток пальца) подтверждает вход в панель и важные действия касанием. Держите не меньше двух ключей: основной и запасной в надёжном месте. Второй ключ и удаление ключа — только после касания уже зарегистрированного.",
  webauthnKeys: "Ключи WebAuthn",
  noActiveKeysAddYourFirstKeyBelowIt: "Действующих ключей нет. Добавьте первый ниже — для него касание не нужно.",
  label: "Подпись",
  connection: "Как подключается",
  added: "Добавлен",
  lastSignIn: "Последний вход",
  label2: "Подпись",
  unlabelled: "без подписи",
  canBeCopied: "с копией",
  thisKeyCanBeCopiedBetweenDevicesPasswordManager: "Ключ может копироваться между устройствами (менеджер паролей, облако)",
  disabled: "выключен",
  thisKeyCanNoLongerSignInItWas: "Этим ключом больше не войти: его выключили (похож на копию, удалён вами или коллегой)",
  connection2: "Как подключается",
  added2: "Добавлен",
  lastSignIn2: "Последний вход",
  noSignInsYet: "ещё не входили",
  sinceValue1: "с {value1}",
  delete: "Удалить",
  unlabelled2: "без подписи",
  deleteKeyValue1ItCanNoLongerSignIn: (value1: string | number): string => `Удалить ключ «${value1}»? Войти им больше будет нельзя, вернуть его можно только новой регистрацией.`,
  nobodyHasAnAdministratorOrSecurityAuditorRole: "Ни у кого нет роли администратора или аудитора ИБ.",
  who: "Кто",
  role: "Роль",
  keys: "Ключей",
  enoughKeys: "Хватает ли",
  who2: "Кто",
  role2: "Роль",
  keys2: "Ключей",
  enoughKeys2: "Хватает ли",
  enough: "хватает",
  fewerThanValue1: "меньше {value1}",
  noKeys: "нет ключей",
  webauthnKeys2: "Ключи WebAuthn",
  myKeys: "Мои ключи",
  yourSessionDetails: "сведения о вашей сессии",
  securityKeysBelongToCompanySignInYouSigned: "Ключи безопасности привязаны к корпоративному входу. Вы вошли учётной записью admin@local — выйдите и войдите через корпоративный вход, чтобы добавить свои ключи.",
  yourKeys: "ваши ключи",
  emergencyAccessIsOpenANewKeyCanBe: "Открыт аварийный доступ: ключ можно добавить без касания старого — так восстанавливают вход после потери ключей. Это видят в оповещениях.",
  everyoneSKeys: "Ключи у всех",
  activeKeysHeldByEachAdministratorAndSecurityAuditor: "Сколько действующих ключей у каждого администратора и аудитора ИБ. Потерял ключ коллега — пусть удалит его сам, подтвердив запасным; если ключей не осталось — через аварийный доступ.",
  everyoneSKeys2: "ключи у всех",
};

export const REGISTER_CLIENT_TEXT: Messages<typeof en.REGISTER_CLIENT_TEXT> = {
  noWebauthn: "Этот браузер не работает с ключами безопасности на этом адресе: нужна панель по https (на стенде — localhost)",
  theKeyDidNotRespondTryAgain: "Ключ не ответил — попробуйте ещё раз",
  touchYourSecurityKey: "Коснитесь ключа безопасности…",
  couldNotCompleteTheActionTryAgain: "Не получилось — попробуйте ещё раз",
  waitingForKey: "Ждём ключ…",
  confirmWithATouch: "Подтвердить касанием",
  touchTheNewSecurityKey: "Коснитесь нового ключа безопасности…",
  theKeyDidNotRespondTryAgain2: "Ключ не ответил — попробуйте ещё раз",
  couldNotCompleteTheActionTryAgain2: "Не получилось — попробуйте ещё раз",
  forExampleMainKeySpareInSafe: "Например: основной, запасной в сейфе",
  tag1KeyLabelTag1Value2: "<tag1>Подпись ключа</tag1>{value2}",
  waitingForKey2: "Ждём ключ…",
  addKey: "Добавить ключ",
};
