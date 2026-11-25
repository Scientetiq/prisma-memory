import type { Messages } from "../../i18n/core";
import type * as en from "./en";
import type { NavSection } from "../../components/shell";
import { NAV_ICONS as I } from "../../lib/nav-icons";

export const FULL: Messages<typeof en.FULL> = [
    { items: [
            { href: "/admin", title: "Обзор", icon: I.panelOverview, exact: true },
            { href: "/admin/search", title: "Найти запись или человека", icon: I.search },
            { href: "/admin/unprocessed", title: "Обработка", icon: I.processing },
            { href: "/admin/deletion-requests", title: "Просьбы удалить", icon: I.deletionRequests },
        ] },
    { label: "Организация", items: [
            { href: "/admin/people", title: "Люди", icon: I.people },
            { href: "/admin/roles", title: "Роли", icon: I.roles },
            { href: "/admin/spaces", title: "Пространства", icon: I.spaces },
            { href: "/admin/services", title: "Сервисы", icon: I.services },
            { href: "/admin/preview", title: "Смотреть как", icon: I.preview },
        ] },
    { label: "Контроль", items: [
            { href: "/admin/report", title: "Отчёт", icon: I.report },
            { href: "/admin/search-quality", title: "Качество поиска", icon: I.searchQuality },
            { href: "/admin/audit", title: "Аудит", icon: I.audit },
        ] },
    { label: "Внешний доступ", items: [
            { href: "/admin/external", title: "Доступ извне", icon: I.external },
            { href: "/admin/edge-export", title: "Экспорт на ребро", icon: I.edgeExport },
        ] },
    { label: "Система", items: [
            { href: "/admin/settings", title: "Настройки", icon: I.settings },
            { href: "/admin/connectors", title: "Коннекторы", icon: I.services },
            { href: "/admin/ldap", title: "Вход и LDAP", icon: I.ldap },
            { href: "/admin/sso", title: "Единый вход", icon: I.sso },
            { href: "/admin/agent-login", title: "Вход агентов", icon: I.agentLogin },
            { href: "/admin/smtp", title: "Почта", icon: I.mail },
            { href: "/admin/open-check", title: "Проверка открытого", icon: I.openCheck },
            { href: "/admin/operator", title: "Кто администратор", icon: I.operator },
            { href: "/admin/factor-local", title: "Two-step sign-in", icon: I.localFactor },
        ] },
];

export const AUDITOR: Messages<typeof en.AUDITOR> = [
    { label: "Аудит и отчётность", items: [
            { href: "/admin/audit", title: "Аудит", icon: I.audit },
            { href: "/admin/report", title: "Отчёт", icon: I.report },
            { href: "/admin/search-quality", title: "Качество поиска", icon: I.searchQuality },
        ] },
];

export const TEXT: Messages<typeof en.TEXT> = {
  seeTheAdminServiceLogsForDetails: "Подробности — в логах сервиса admin.",
  adminPlane: "Админ-плоскость",
  signOutOfThePanel: "Выйти из панели",
  localAdministrator: "локальный администратор",
  auditorView: "режим аудитора",
  securityAuditor: "аудитор ИБ",
  adminPanel: "панель",
  audit: "аудит",
  overview: "Обзор",
  reportsForOtherPeriods: "Отчёт за другие окна →",
  queued: "В очереди",
  failed: "С ошибкой",
  processed: "Обработано",
  received: "Принято",
  type: "Тип",
  queued2: "В очереди",
  failed2: "С ошибкой",
  processed2: "Обработано",
  received2: "Принято",
  type2: "Тип",
  noRecordsReceivedInTheLastHours: "За сутки записи не поступали.",
  report: "отчёт",
  generated: "Сформирован: {value1}.",
  lastHours: "За сутки",
  processing: "Обработка →",
  stageStates: "Состояния стадий: {value1}",
  stage: "Стадия",
  theQueueIsEmptyAllStagesAre: "Очередь пуста: все стадии выполнены.",
  queue: "очередь",
  stagesThatAreWaitingRunningOrHave: "Стадии, которые ждут, выполняются или упали.",
  queueByStage: "Очередь по стадиям",
  failedSeeNeedsAttention: " — не пройдена, см. «Требует внимания»",
  theGatewayDidNotReturnTheList: "Гейтвей не отдал список проверок.",
  instance: (value1: string | number | null | undefined): string => `, инстанс ${value1}`,
  text: (value1: string | number | null | undefined, value2: string | number | null | undefined): string => `${value1}${value2}`,
  gatewayChecks: "Проверки гейтвея",
  needsAttention: "Требует внимания",
  processedShare: "доля обработанных",
  receivedInTheLastHours: "принято за сутки",
  failedStages: "стадий с ошибкой",
  queuedStages: "стадий в очереди",
  gateway: "гейтвей",
  instanceStatusAtAGlanceGatewayChecks: "Состояние инстанса одним экраном: проверки гейтвея, очередь обработки, сводка за сутки и то, что требует внимания администратора.",
  overview2: "Обзор",
  notResponding: "не отвечает",
  restricted: "ограничения",
  healthy: "в порядке",
  unreachable: "нет связи",
};
