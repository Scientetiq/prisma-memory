import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const MODE_TITLE: Messages<typeof en.MODE_TITLE> = { off: "выключен", optional: "по желанию", required: "обязателен" };

export const RESET_MODE_TEXT: Messages<typeof en.RESET_MODE_TEXT> = {
    basic: "Сейчас режим безопасности basic: сброс выполняется сразу, но только администратором, вошедшим в панель сам через вход компании.",
    advanced: "Сейчас режим безопасности advanced: сброс ждёт второй подписи другого администратора или аудитора ИБ на странице «Вторые подписи».",
};

export const ACTIONS_TEXT: Messages<typeof en.ACTIONS_TEXT> = {
  noColleagueSelected: "Нет сотрудника",
  enterAReason: "Укажите причину",
  value1ToValue2Characters: (value1: string | number, value2: string | number): string => `от ${value1} до ${value2} знаков`,
  confirmBothChecks: "Отметьте обе проверки",
  resettingTheFactorRequiresAnIdentityCheckNotBy: "Сбросить фактор можно только после проверки личности (не по почте) и подтверждения руководителя.",
  secondFactorReset: "Второй фактор сброшен",
  theSignInServiceRespondedLateTheResetSucceeded: "Служба проверки входа ответила с опозданием: сброс прошёл, число погашенных сессий неизвестно",
  externalSignInSessionsClosedValue1: (value1: string | number): string => `Погашено сессий входа извне: ${value1}`,
  thereWereNoActiveExternalSignInSessions: "Действующих сессий входа извне не было",
  anEmailWasSentToTheColleague: "Сотруднику ушло письмо.",
  theEmailWasNotSentTellTheColleagueAbout: "Письмо сотруднику не ушло — сообщите ему о сбросе сами (не по почте).",
  emailDeliveryIsUnknownTellTheColleagueAboutThe: "Ушло ли письмо сотруднику, неизвестно — сообщите ему о сбросе сами.",
  theyCanSetUpANewFactorInThe: "Новый фактор он настроит сам в рабочем месте: из сети офиса или с подтверждением поддержки (заявка уйдёт сама, её подтверждают на странице «Доступ извне», раздел «Подтверждения первого включения»).",
};

export const PAGE_TEXT: Messages<typeof en.PAGE_TEXT> = {
  secondFactorStatus: "состояние второго фактора",
  resetAColleagueSFactor: "Сбросить фактор сотруднику",
  colleagueLoginOrName: "Логин или имя сотрудника",
  findAColleague: "Найти сотрудника",
  find: "Найти",
  mode: "Режим",
  changeInSettings: "Изменить в настройках",
  theSecondFactorIsNotInstalledInTheDatabase: "Второй фактор в базе ещё не установлен: режим действует как «{value1}», охвата нет.",
  requiredSinceValue1: "обязателен с {value1}",
  settingChangedValue1: "настройку меняли {value1}",
  settingHasNotChanged: "настройку не меняли",
  itIsStricterThanTheSettingValue1SoIt: " — она строже настройки («{value1}»), поэтому действует она",
  minimumModeFromEdgeAnchorsValue1Value2: "Нижняя граница из якорей ребра: «{value1}»{value2}.",
  noMinimumModeFromEdgeAnchors: "Нижней границы из якорей ребра нет.",
  currentlyValue1: " (сейчас таких {value1})",
  existingApplicationConnectionsIssuedWithoutAFactorHaveA: "Льгота для подключений программ, выданных без фактора, — до {value1}{value2}. Войти извне без кода нельзя уже сейчас.",
  colleagues: "сотрудников",
  noColleaguesFound: "Никого не нашли.",
  colleague: "Сотрудник",
  login: "Логин",
  actions: "Действия",
  colleague2: "Сотрудник",
  login2: "Логин",
  actions2: "Действия",
  selected: "выбран",
  select: "Выбрать",
  showingTheFirstValue1ResultsRefineYourSearch: "Показаны первые {value1} — уточните поиск.",
};

export const RESET_FORM_TEXT: Messages<typeof en.RESET_FORM_TEXT> = {
  resetSecondFactor: "Сбросить второй фактор",
  resetting: "Сброс…",
  value1WillLoseExternalCodeSignInTheirExternal: (value1: string | number): string => `У «${value1}» перестанет работать вход извне по коду, сессии входа извне погаснут.`,
  theColleagueWillReceiveAnEmailAdministratorsAndSecurity: "Сотруднику уйдёт письмо; событие увидят администраторы и аудиторы ИБ.",
  thisCannotBeUndoneTheColleagueWillSetUp: "Вернуть нельзя: сотрудник настроит новый фактор сам.",
  reset: "Сбросить",
  reason: "Причина",
  whyAreYouResettingItUseValue1Value2Characters: (value1: string | number, value2: string | number): string => `Зачем сбрасываете — ${value1}–${value2} знаков; попадёт в журнал.`,
  forExamplePhoneLostNoRecoveryCodes: "Например: потерян телефон, кодов восстановления нет",
};

export const VIEW_TEXT: Messages<typeof en.VIEW_TEXT> = {
  factorPanelTitle: "Второй фактор",
  factorPanelLead: "Код из приложения на телефоне — вторая проверка при входе в память извне. Сотрудники настраивают его сами в рабочем месте, изнутри сети компании. Здесь — действующий режим, охват и сброс фактора тому, кто потерял телефон.",
  identityLabel: "Личность подтверждена не по почте: лично или видеозвонком",
  managerLabel: "Подтверждено руководителем",
  resetHint: "Для того, кто потерял телефон и коды восстановления. Сначала проверьте личность лично или видеозвонком (не по почте) и получите подтверждение руководителя. После сброса вход извне по коду у сотрудника перестанет работать, сессии входа извне погаснут, ему уйдёт письмо; новый фактор он настроит сам изнутри сети компании.",
  resetConfirm: "Сбросить второй фактор сотрудника?",
  nobodyHasEnabledExternalAccessYet: "Доступ извне пока никто не включал.",
  coverage: (people: number, enrolled: number, percent: number): string => `Доступ извне включён у ${people} сотр.; второй фактор настроен у ${enrolled} (${percent}%).`,
  requiredWarning: (without: number, connections: number, days: number): string => {
    const people = without
      ? `у ${without} сотр. с доступом извне фактора ещё нет: их входы извне завершатся сразу, а войти снова они смогут только после настройки фактора изнутри.`
      : "у всех сотрудников с доступом извне фактор настроен.";
    const programs = !connections ? "" : days > 0
      ? ` Подключения программ, выданные без фактора (${connections}), проработают ещё ${days} дн. (льгота), потом отключатся.`
      : ` Подключения программ, выданные без фактора (${connections}), отключатся сразу: льготы нет.`;
    return `Если сделать второй фактор обязательным, ${people}${programs}`;
  },
  notResetOnlyAnAdministratorPersonallySignedInThrough: "Не сброшено: сбросить второй фактор может только администратор, вошедший в панель сам через вход компании — не системным ключом, не локальной учётной записью и не аварийным доступом",
  notResetTheRequestIsStaleOrAlreadyUsed: "Не сброшено: заявка устарела или уже использована — начните заново",
  notResetTheSignInServiceDidNotRespond: "Не сброшено: служба проверки входа не ответила. Попробуйте позже",
  notResetAnotherAdministratorMustResetYourSecondFactor: "Не сброшено: свой второй фактор сбрасывает другой администратор. Телефон можно заменить самому — кодом восстановления в рабочем месте",
  notResetThisRequiresTheAdminPlaneWhichIs: "Не сброшено: это делается через админ-плоскость, а она не настроена",
  notResetColleagueNotFoundRefreshThePage: "Не сброшено: сотрудника нет — обновите страницу",
  notResetValue1: (value1: string | number): string => `Не сброшено: ${value1}`,
  notResetValue12: (value1: string | number): string => `Не сброшено: ${value1}`,
  gatewayError: "ошибка шлюза",
  notResetValue13: (value1: string | number): string => `Не сброшено: ${value1}`,
};
