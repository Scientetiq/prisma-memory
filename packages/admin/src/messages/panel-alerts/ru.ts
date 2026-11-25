import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const LEVEL_FILTERS: Messages<typeof en.LEVEL_FILTERS> = [
    { value: "all", title: "Все" },
    { value: "page", title: "Срочные" },
    { value: "high", title: "Высокие" },
    { value: "medium", title: "Средние" },
    { value: "metric", title: "Счётчики" },
];

export const STATUS_FILTERS: Messages<typeof en.STATUS_FILTERS> = [
    { value: "all", title: "Все" },
    { value: "open", title: "Открытые" },
    { value: "acked", title: "Принятые" },
    { value: "closed", title: "Закрытые" },
];

export const LEVEL_BADGES: Messages<typeof en.LEVEL_BADGES> = {
    page: { title: "срочная", tone: "danger", hint: "Письмо дежурному уходит сразу и днём, и ночью: возможен захват ребра или обход защиты" },
    high: { title: "высокая", tone: "danger", hint: "Письмо получателям тревог уходит сразу (тревоги «только днём» — в рабочее время)" },
    medium: { title: "средняя", tone: "warn", hint: "Попадает в ежедневную сводку" },
    metric: { title: "счётчик", tone: "info", hint: "Только здесь, без писем" },
};

export const STATUS_BADGES: Messages<typeof en.STATUS_BADGES> = {
    open: { title: "открыта", tone: "danger" },
    acked: { title: "принята", tone: "ok" },
    closed: { title: "закрыта", tone: "muted" },
};

export const SUBJECT_TITLES: Messages<typeof en.SUBJECT_TITLES> = {
    person_id: "человек", connection_id: "подключение", service: "служба", client_id: "программа", ip_prefix: "сеть", change: "изменение", test: "проба",
};

export const HOST_FACT_TITLES: Messages<typeof en.HOST_FACT_TITLES> = {
    docker_members: "Кто в группе docker",
    sudo_members: "Кто в группе sudo",
    sudo_nopasswd: "Sudo без пароля",
    runner: "Раннер выкладки на ВМ",
    docker_user_rules: "Своих правил в цепочке DOCKER-USER",
    signer_owner: "Чей файл корня доверия",
    relay_local: "Мост работает на этой ВМ",
    relay_egress_rule: "Правило выхода моста совпадает с сетью и адресом ребра",
    relay_egress_drops: "Пакетов моста отброшено правилом выхода",
    relay_credentials: "Есть ключи моста",
    relay_stopped: "Мост остановлен рубильником",
    host_addrs: "Адреса этой ВМ",
    edge_tls_not_after: "Сроки сертификатов ребра (предъявленные)",
    edge_tls_checked_at: "Когда сроки ребра проверены",
    pki_leaves_not_after: "Сроки сертификатов моста и клиента прокси",
    pki_roots_not_after: "Сроки корневых сертификатов",
    pki_bridge_clients_not_after: "Ближайший срок сертификатов клиентов моста",
    pki_bridge_clients_missing: "Клиенты моста без прочитанного сертификата",
};

export const QUOTA_KIND_TITLES: Messages<typeof en.QUOTA_KIND_TITLES> = {
    search: "поиски", read: "чтения", list: "списки", text_tokens: "объём текста", originals: "оригиналы (штук)",
    originals_mib: "оригиналы (МиБ)", c2_items: "закрытое (штук)", c2_mib: "закрытое (МиБ)",
};

export const ACTIONS_TEXT: Messages<typeof en.ACTIONS_TEXT> = {
  noAlertID: "Нет номера тревоги",
  markedAsAcknowledged: "Отмечено: принято",
  alertNotFoundItMayHaveExpired: "Тревога не найдена — возможно, удалена по сроку",
  notAcknowledgedResponseValue1: (value1: string | number): string => `Не отмечено: ответ ${value1}`,
  alertsWillAppearInAMinuteRefreshThePage: "Тревоги появятся в списке через минуту: обновите страницу",
};

export const PAGE_TEXT: Messages<typeof en.PAGE_TEXT> = {
  alerts: "Оповещения",
  alerts2: "Оповещения",
  alertsBySeverity: "Тревоги по уровню",
  alertsByStatus: "Тревоги по состоянию",
  alerts3: "Тревоги",
  all: "все",
  value1Value2: (value1: string | number, value2: string | number): string => `${value1} · ${value2}`,
  alerts4: "тревоги",
  noAlerts: "Тревог нет.",
  when: "Когда",
  severity: "Уровень",
  whatHappened: "Что случилось",
  acknowledged: "Принято",
  when2: "Когда",
  firstSeenValue1: "впервые {value1}",
  severity2: "Уровень",
  whatHappened2: "Что случилось",
  eventCode: "Код события",
  groupingSubjectIdentifierNotAName: "Предмет склейки: идентификатор, не имя",
  tag1Value2Tag1: " · <tag1>{value2}</tag1>",
  tag1Value2Tag1Value3Value4: "<tag1>{value2}</tag1>{value3}{value4}",
  acknowledged2: "Принято",
  acknowledge: "Принято",
  pending: "ещё нет",
  alerts5: "тревог",
  deliveryTest: "Проверка доставки",
  sendTestAlerts: "Отправить тестовые тревоги",
  queuing: "Ставлю…",
  prepareDigestNow: "Собрать сводку сейчас",
  queuing2: "Ставлю…",
  aMemoryAdministratorCanSendTestAlertsAndPrepare: "Пробные тревоги и сводку вне расписания запускает администратор памяти.",
  hostFacts: "Факты хоста",
  hostFacts2: "факты хоста",
  theHostCheckHasNotReportedAnyFactsYet: "Проверка хоста ещё не присылала фактов.",
  lastCheckValue1: "Последняя проверка: {value1}",
  edgeQuotasRequestsThatWouldBeRefused: "Квоты ребра: было бы отказано",
  quotaReport: "отчёт квот",
  noRequestsWouldHaveBeenRefusedInTheLast: "За 14 суток никому не было бы отказано.",
  who: "Кто",
  quota: "Квота",
  daysWithRequestsThatWouldBeRefused: "Было бы отказано, суток",
  daysWithRefusedRequests: "Отказано, суток",
  who2: "Кто",
  quota2: "Квота",
  daysWithRequestsThatWouldBeRefused2: "Было бы отказано, суток",
  daysWithRefusedRequests2: "Отказано, суток",
  rows: "строк",
};

export const VIEW_TEXT: Messages<typeof en.VIEW_TEXT> = {
  alertsLead: "Тревоги о входах администраторов, изменениях ролей, ключей и защиты, отправке журнала и чтении от имени людей, а также о ребре и внешнем входе: молчащие службы, сертификаты, новые подключения и сети, попытки ребра выйти в сеть. Срочные и высокие сразу уходят письмом, средние — в ежедневную сводку (admin.alert_digest_hour); повторы одной тревоги склеиваются в строку с числом повторов. Письма уходят, когда включена почта и заданы получатели — admin.alert_recipients; иначе тревоги видны только здесь. Высокие, которые не ушли, пока писем не было, придут одним письмом, когда письма пойдут. В тревогах нет текстов записей, запросов и паролей.",
  testHint: "Три пробные тревоги — срочная, высокая и средняя — идут тем же путём, что настоящие: срочная и высокая придут письмом через минуту, средняя — в сводке («Собрать сводку сейчас»). Так проверяется, что тревоги доходят до дежурного.",
  hostFactsHint: "Подсказка, а не доказательство: проверка хоста раз в час сообщает, кто может управлять контейнерами, есть ли sudo без пароля и раннер, и как работает мост к ребру (в basic он на этой ВМ). В «Готовности» — то же.",
  quotaHint: "За 14 суток: кому из людей было бы отказано (режим наблюдения edge.quota_mode) или отказано по суточным пределам обращений извне, и в скольких сутках. Перед переходом из наблюдения в отказы — посмотрите, не заденет ли он тех, кто работает честно.",
  administratorWithoutAProfile: "администратор без карточки",
  repeatedValue1Times: (value1: string | number): string => `повторялась ${value1} раз`,
  fromTheEdgeValue1: (value1: string | number): string => `с ребра · ${value1}`,
  fromTheEdge: "с ребра",
  mailIsDisabledSmtpEnabled: "почта выключена (smtp.enabled)",
  noRecipientsSetAdminAlertRecipients: "получатели не заданы (admin.alert_recipients)",
  alertEmailsAreNotBeingSentValue1AlertsAppear: (value1: string | number): string => `Письма-тревоги сейчас не уходят: ${value1}. Тревоги видны только здесь; высокие придут одним письмом, когда письма пойдут.`,
  testAlertsQueuedUrgentAndHighAlertsWillArrive: "Пробные тревоги поставлены: срочная и высокая придут письмом через минуту, средняя — в сводке",
  value1ResponseValue2: (value1: string | number, value2: string | number): string => `${value1} (ответ ${value2})`,
  notQueuedValue1: (value1: string | number): string => `Не поставлены: ${value1}`,
  digestQueuedEmailsValue1: (value1: string | number): string => `Сводка поставлена: писем — ${value1}`,
  nothingToIncludeNoNewMediumAlertsOrUnreviewed: "Сводить нечего: новых средних тревог и неразобранных тревог безопасности нет",
  alertEmailsAreNotBeingSentEnableMailAnd: "Письма-тревоги не уходят: включите почту и задайте получателей",
  notQueuedResponseValue1: (value1: string | number): string => `Не поставлено: ответ ${value1}`,
  yes: "да",
  no: "нет",
  no2: "нет",
};
