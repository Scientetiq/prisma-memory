// Original Russian messages for this area.
import type { Messages } from "../../i18n/core";
import type * as en from "./en";
export const EXTERNAL_FACTS: Messages<typeof en.EXTERNAL_FACTS> = [
    "Агент извне видит только открытое, что видите вы: закрытого и личного снаружи нет.",
    "Записывать и удалять извне нельзя — только читать.",
    "Пароль проверяет каталог компании; память его не хранит.",
];
export const DISABLED_CODE_TEXT: Messages<typeof en.DISABLED_CODE_TEXT> = {
    self: "вы выключили его сами",
    admin: "его выключил администратор памяти",
    support: "его выключила поддержка",
    idle: "им давно не пользовались",
    person_inactive: "ваша карточка сотрудника выключена",
    ad_disabled: "ваша учётная запись в каталоге компании выключена",
    ad_deleted: "вашей учётной записи больше нет в каталоге компании",
    ad_expired: "срок вашей учётной записи в каталоге компании истёк",
    ad_group: "вас нет в группе доступа извне",
    ad_deny: "вы в группе, которой доступ извне запрещён",
    admin_no_webauthn: "администратору памяти доступ извне — только с ключом WebAuthn",
    compromise: "по подозрению на взлом",
    ad_link_changed: "сменилась связь вашей карточки с учётной записью в каталоге",
};
export const NOT_ALLOWED_TEXT: Messages<typeof en.NOT_ALLOWED_TEXT> = {
    closed: "служба проверки входа сейчас не может вас проверить",
    person_inactive: "ваша карточка сотрудника выключена",
    no_directory_link: "ваша карточка не связана с учётной записью в каталоге компании",
    not_in_login_groups: "вас нет в группе доступа извне",
    in_deny_groups: "вы в группе, которой доступ извне запрещён",
    admin_count: "у вашей учётной записи в каталоге особые права — таким доступ извне не включают",
    ad_disabled: "ваша учётная запись в каталоге выключена",
    ad_expired: "срок вашей учётной записи в каталоге истёк",
    ad_deleted: "вашей учётной записи нет в каталоге",
    admin_no_webauthn: "администратору памяти нужен ключ WebAuthn",
    directory_unavailable: "каталог компании сейчас не отвечает",
};
export const FIRST_CONFIRM_TEXT: Messages<typeof en.FIRST_CONFIRM_TEXT> = {
    not_needed: null,
    office: "Первое включение: вы сейчас в сети офиса — подтверждение поддержки не нужно.",
    none: "Первое включение — из сети офиса или после того, как поддержка подтвердит, что это вы. Нажмите «Включить»: если вы не в офисе, заявка уйдёт в поддержку.",
    requested: "Заявка на подтверждение уже в поддержке. Когда поддержка подтвердит, что это вы, нажмите «Включить» ещё раз — у вас будут сутки.",
    confirmed: "Поддержка подтвердила, что это вы: включите доступ в течение суток.",
};
export const ENABLE_CONFIRM: Messages<typeof en.ENABLE_CONFIRM> = {
    question: "Включить доступ извне?",
    change: "Ваши агенты смогут читать открытое, что видите вы, из-за пределов сети компании — после входа с паролем на странице входа памяти. О каждом новом подключении придёт письмо.",
    verb: "Включить",
} as const;
export const DISABLE_CONFIRM: Messages<typeof en.DISABLE_CONFIRM> = {
    question: "Выключить доступ извне?",
    change: "Все подключения извне сразу перестанут работать. Включить снова можно здесь же — только изнутри и со свежим входом.",
    verb: "Выключить",
    danger: true,
} as const;
export const REVOKE_ALL_CONFIRM: Messages<typeof en.REVOKE_ALL_CONFIRM> = {
    question: "Отключить все подключения извне?",
    change: "Все программы, подключённые извне, придётся подключить заново. Сам доступ останется включённым.",
    verb: "Отключить всё",
    danger: true,
} as const;
export const CLOSED_REASON_TEXT: Messages<typeof en.CLOSED_REASON_TEXT> = {
    threshold_unknown: "не задан порог блокировки в каталоге — пароли извне не проверяются",
    window_unknown: "не задано окно счётчика неверных паролей",
    pdc_unset: "не задан главный контроллер домена",
    pdc_unreachable: "главный контроллер домена не отвечает",
    pdc_not_emulator: "главный контроллер домена записан не так, как один из контроллеров «Вход и LDAP», не эмулятор PDC или его роль не видна",
    counter_unreadable: "счётчик неверных паролей в каталоге не читается",
    pso_unreadable: "политика паролей в каталоге не читается",
    tls_none: "к каталогу нет защищённого соединения",
    no_keys: "у службы нет ключей",
    anchors_invalid: "якоря ребра не прошли проверку",
    login_disabled: "внешний вход выключен в настройках",
    settings_invalid: "настройки службы испорчены",
    groups_unreadable: "группы входа и запрета не читаются в каталоге",
};
export const PAUSE_CONFIRM: Messages<typeof en.PAUSE_CONFIRM> = {
    question: "Приостановить вход извне?",
    change: "Новые входы извне не пройдут, пока пауза не кончится или её не снимут. Уже подключённые программы продолжат работать.",
    verb: "Приостановить",
} as const;
export const LIFT_CONFIRM: Messages<typeof en.LIFT_CONFIRM> = {
    question: "Снять ручную паузу?",
    change: "Вход извне снова пойдёт. Автопаузу из-за неверных паролей это не снимает — она кончится сама.",
    verb: "Снять паузу",
} as const;
export const EXTERNAL_ACCESS_MESSAGES: Messages<typeof en.EXTERNAL_ACCESS_MESSAGES> = {
    externalTitle: "Доступ извне",
    externalLead: "Чтобы ваши ИИ-агенты (Claude Code, Codex) работали с памятью из дома или в поездке — без сети компании. Включаете только вы и только отсюда, изнутри; выключить можно в любой момент.",
    foreverPauseText: "Вход извне приостановлен бессрочно: сработало автовыключение экспорта на ребро. Здесь эта пауза не снимается и сама не кончится — она уходит вместе с автовыключением («Экспорт на ребро» → «Приманки и автовыключение» → «Снять автовыключение»).",
    itWasDisabled: "его выключили",
    supportHasMoreInformationAbout: "есть причина, о которой знает поддержка",
    reason: (value1: string | number): string => `Почему: ${value1}.`,
    externalSignInIsCurrently: "Внешний вход сейчас недоступен. Попробуйте позже",
    thisProtectsYouIfSomeone: "Это защита на случай, если кто-то сел за ваш компьютер: пароль спросят ещё раз.",
    signInAgain: "Войти заново",
    supportWillContactYouAnd: "Поддержка свяжется с вами и проверит, что это вы. После этого нажмите «Включить» ещё раз.",
    firstSetUpASecond: "Сначала настройте второй фактор — код из приложения на телефоне.",
    setUpSecondFactor: "Настроить второй фактор",
    used: "использована",
    confirmed: "подтверждена",
    confirmationExpired: "срок подтверждения вышел",
    awaitingSupport: "ждёт поддержку",
    expired: "устарела",
    theColleagueThemselves: "сам сотрудник",
    automatically: "автоматически",
    administrator: "администратор",
    support: "поддержка",
    disabledByText5: (value1: string | number, value2: string | number): string => `${value1} ${value2}`,
    notResponding: "не отвечает",
    theInternalSignInCheck: "Служба проверки входа внутри не отвечает: вход извне сейчас не работает, включить доступ сотрудники не могут.",
    reasonUnknown: "причина неизвестна",
    closed: "закрыта",
    externalPasswordsAreNotChecked: (value1: string | number): string => `Пароли извне не проверяются: ${value1}.`,
    theLastDirectoryCheckFailed: "Последний обход каталога не прошёл — служба повторит его сама.",
    running: "работает",
    colleagues: "Сотрудники",
    confirmations: "Подтверждения",
    externalSignIn: "Вход извне",
    disableExternalAccessFor: (value1: string | number): string => `Выключить доступ извне сотруднику ${value1}?`,
    allTheirExternalConnectionsWill: "Все его подключения извне сразу перестанут работать; он получит письмо. Включить снова может только он сам — изнутри.",
    disable: "Выключить",
    confirmThatTheRequestWas: (value1: string | number): string => `Подтвердить, что заявку подал ${value1}?`,
    confirmOnlyAfterVerifyingIdentity: "Подтверждайте только после проверки личности вне памяти (звонок, встреча). У сотрудника будут сутки, чтобы включить доступ извне.",
    confirm: "Подтвердить",
};
