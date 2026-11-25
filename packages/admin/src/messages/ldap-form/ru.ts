import type { Messages } from "../../i18n/core";
import type * as en from "./en";
import type { LdapField } from "../../lib/ldap-form";

export const LDAP_GROUPS: Messages<typeof en.LDAP_GROUPS> = [
    { title: "Контроллеры", fields: [
            { key: "servers", kind: "hosts", label: "Контроллеры каталога", placeholder: "dc1.example.test\ndc2.example.test",
                hint: "По одному на строке: имя контроллера или домена (example.test — проверяются все его адреса) либо IP. Порт — отдельным полем." },
            { key: "port", kind: "number", label: "Порт", hint: "0 — по режиму: 636 для LDAPS, 389 для StartTLS и без шифрования." },
            { key: "connect_timeout_sec", kind: "number", label: "Тайм-аут соединения, с", hint: "1–60: столько ждётся каждый адрес, затем берётся следующий." },
            { key: "timeout_sec", kind: "number", label: "Тайм-аут операции, с", hint: "1–120: bind и поиск." },
        ] },
    { title: "Шифрование", fields: [
            { key: "tls_mode", kind: "tls", label: "Режим", hint: "LDAPS — TLS с первого байта, порт 636; StartTLS — переход на TLS поверх 389. Без шифрования — в basic можно с отметкой «понимаю», если контроллеры не дают LDAPS: тем же каналом идут и пароли сотрудников при входе извне. В advanced вход извне без LDAPS не работает." },
            { key: "insecure_ack", kind: "bool", label: "Понимаю: без шифрования пароли людей, в том числе при входе извне, идут по сети открытым текстом" },
            { key: "ca_cert", kind: "multiline", label: "Корневой сертификат каталога (PEM)", placeholder: "-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----",
                hint: "Можно цепочкой. Пусто — доверие системному списку сервера памяти; корпоративный CA там обычно не установлен." },
            { key: "tls_server_name", kind: "text", label: "Имя в сертификате", placeholder: "dc1.example.test",
                hint: "Нужно, когда контроллеры заданы IP-адресами: сертификат проверяется по этому имени, соединение идёт на адрес." },
        ] },
    { title: "Служебная учётная запись и поиск", fields: [
            { key: "bind_dn", kind: "text", label: "DN служебной учётной записи", placeholder: "CN=svc-memory,OU=Service Accounts,DC=corp,DC=example",
                hint: "Только чтение каталога: ею ищется человек перед проверкой пароля." },
            { key: "bind_password", kind: "secret", label: "Пароль служебной учётной записи" },
            { key: "base_dn", kind: "text", label: "Где искать людей (base DN)", placeholder: "DC=corp,DC=example" },
            { key: "user_filter", kind: "multiline", label: "Фильтр поиска человека",
                hint: "{account} — короткое имя (user из CORP\\user или user@example.com), {upn} — имя как введено. Значения экранируются по RFC 4515." },
            { key: "attributes", kind: "json", label: "Имена атрибутов", hint: "Какие атрибуты каталога дают логин, ФИО, подразделение, группы, objectGUID, табельный номер, должность (title — для поиска по каталогу) и имя (given_name, в AD — givenName: по нему рабочее место здоровается)." },
        ] },
    { title: "Кто входит", fields: [
            { key: "login_groups", kind: "lines", label: "Группы доступа", placeholder: "CN=memory-users,OU=Groups,DC=corp,DC=example",
                hint: "По одной на строке: DN или имя (CN). Входят только члены этих групп; карточка создаётся при первом входе." },
            { key: "nested_groups", kind: "bool", label: "Учитывать вложенные группы", hint: "Правило транзитивного членства AD; только для групп, заданных DN." },
            { key: "domains", kind: "hosts", label: "Допустимые домены в имени входа", placeholder: "example.com\nCORP",
                hint: "Пусто — любой домен (человек всё равно ищется в base DN). CORP — для входа как CORP\\user." },
        ] },
    { title: "Участие в пространствах по группам", hint: "A project owner binds a directory group: its members become members of the space. When the directory cannot verify a group for the expiry below (directory unreachable or switched off, group deleted), its members lose that membership until the next successful sync; the failure shows in the report and health.", fields: [
            { key: "group_sync_minutes", kind: "number", label: "Сверять членство групп, минут", hint: "0–1440: вошёл в группу — стал участником, вышел — участие снято. 0 — только кнопкой и при входе человека." },
            { key: "group_stale_hours", kind: "number", label: "Membership expires without verification, hours",
                hint: "0–720, at least two sync periods plus an hour; 0 — never (as before). While the periodic sync is off (0 above) and the directory is on, nothing expires and Readiness warns." },
            { key: "group_max_members", kind: "number", label: "Наибольший размер группы", hint: "1–5000 действующих учётных записей: больше — не привязывается; выросшая после привязки группа не сверяется (состав заморожен)." },
            { key: "project_groups_base", kind: "text", label: "Ветка групп для пространств", placeholder: "OU=Projects,DC=corp,DC=example",
                hint: "Пусто — любая группа под base DN. Группа вне ветки не находится поиском и не привязывается." },
        ] },
    { title: "Сессия рабочего места", hint: "Общие для всех способов входа. Изменение не завершает уже выданные сессии: новый срок — у следующих входов, новое окно простоя — сразу.", fields: [
            { key: "session_days", category: "access", kind: "number", label: "Срок входа, дней", hint: "1–30: после этого человек входит заново, продления нет." },
            { key: "session_idle_hours", category: "access", kind: "number", label: "Простой, часов", hint: "Без запросов дольше — сессия завершается; 0 — без окна простоя; не больше 720." },
        ] },
    { title: "Помощь со входом", hint: "Страница входа в рабочее место показывает это в «Не получается войти?» и в отказах «нет в группе доступа» — и для входа логином и паролем, и для единого входа. Пусто — «обратитесь в службу поддержки компании».", fields: [
            { key: "support_contact", category: "access", kind: "text", label: "Куда обращаться", placeholder: "Служба поддержки: help@example.com",
                hint: "До 300 знаков одной строкой: контакт службы поддержки (почта или телефон), не личные данные сотрудника — её видит любой, кто открыл страницу входа, даже не войдя." },
        ] },
    { title: "Лимиты неудачных входов", hint: "С адреса неудачи считаются за последние минуты окна, на учётную запись — подряд, как их считает AD: счёт сбрасывается, когда после последней неудачи прошло окно. После лимита вход приостанавливается с ответом «повторите через N мин.» без обращения к каталогу. Одна учётная запись — один счёт, в какой бы форме ни вводили имя (короткое имя, почта, имя с доменом); попытка, на которую каталог не ответил, тоже в счёте; перезапуск памяти счёт не обнуляет. Изменения действуют сразу, без перезапуска.", fields: [
            { key: "failure_window_minutes", kind: "number", label: "Окно неудачных входов, минут",
                hint: "5–1440. Не короче окна, после которого AD сбрасывает счётчик неверных паролей. Пока ИТ не назвали порог и окно блокировки AD — 30 минут и 2 неудачи на учётную запись." },
            { key: "max_failures_per_login", kind: "number", label: "На одну учётную запись",
                hint: "1–20 неудач подряд. Держите НИЖЕ порога блокировки AD с запасом самому человеку: не больше T − R, где T — порог блокировки AD, R = max(2, T/3 с округлением вверх). Порог 5 — не больше 3, порог 10 — не больше 6." },
            { key: "max_failures_per_ip", kind: "number", label: "С одного адреса", hint: "1–100 за окно." },
        ] },
];

export const LDAP_ENABLED: Messages<typeof en.LDAP_ENABLED> = { key: "enabled", kind: "bool", label: "Вход в рабочее место учётной записью компании включён",
    hint: "Включается, когда заполнены контроллеры, служебная учётная запись, base DN и группа доступа — иначе гейтвей не сохранит." };

export const TLS_MODES: Messages<typeof en.TLS_MODES> = [
    { value: "ldaps", title: "LDAPS (636)" },
    { value: "starttls", title: "StartTLS (389)" },
    { value: "none", title: "Без шифрования" },
];

export const SMTP_SECURITY_MODES: Messages<typeof en.SMTP_SECURITY_MODES> = [
    { value: "starttls", title: "STARTTLS (587)" },
    { value: "tls", title: "TLS (465)" },
    { value: "none", title: "Без шифрования" },
];

export const LDAP_STEP_TITLES: Messages<typeof en.LDAP_STEP_TITLES> = {
    config: "настройки",
    dns: "DNS",
    tcp: "TCP",
    addresses: "адреса",
    tls: "TLS",
    service_bind: "служебный bind",
    base_dn: "base DN",
    groups: "группы доступа",
    user_search: "поиск человека",
    user_bind: "проверка пароля",
    group_check: "членство в группе",
    failure: "сбой",
    unexpected: "неожиданный ответ",
};

export const TEST_LOGIN_OUTCOMES: Messages<typeof en.TEST_LOGIN_OUTCOMES> = {
    create_card: "Вход пройдёт: при первом входе будет создана карточка",
    login: "Вход пройдёт: найдена карточка человека",
    not_in_group: "Вход будет отклонён: человек не входит в группы доступа (ldap.login_groups)",
    no_mail: "Вход будет отклонён: у учётной записи нет почты — почта становится логином в памяти",
    conflict: "Вход будет отклонён: подходят две карточки — объедините их или поправьте табельный номер/почту",
    person_inactive: "Вход будет отклонён: карточка человека в памяти отключена",
    not_found: "Фильтр не нашёл ни одной записи",
    ambiguous: "Фильтр нашёл больше одной записи — вход отклоняется до проверки пароля",
    bad_password: "Каталог отклонил пароль",
    empty_password: "Пустой пароль не проверяется",
    account_state: "Каталог отклонил вход из-за состояния учётной записи",
    domain_not_allowed: "Домен не входит в допустимые (ldap.domains)",
    guid_conflict: "Вход будет отклонён: карточка уже связана с другой учётной записью каталога",
    guid_link_unconfirmed: "Вход будет отклонён: связь учётной записи с карточкой не подтверждена",
    ldap_attribute_missing: "Вход будет отклонён: каталог не отдал objectGUID учётной записи",
};

export const MATCHED_BY: Messages<typeof en.MATCHED_BY> = {
    guid: "по objectGUID (прежний вход)", guid_confirmed: "по objectGUID из орг-таблицы, подтверждено табельным номером или почтой",
    guid_restored: "по objectGUID, подтверждено табельным номером или почтой", guid_unconfirmed: "по objectGUID, связь не подтверждена",
    employee_id: "по табельному номеру", mail: "по почте",
};

export const TEXT: Messages<typeof en.TEXT> = {
  membershipExpiry: "membership expiry — whole hours 0–720; 0 — membership from directory groups never expires",
  chooseEncryption: "Выберите шифрование",
  chooseAnEncryptionMode: "Выберите режим шифрования",
  invalidJSON: (value1: string | number | null | undefined): string => `Некорректный JSON: ${value1}`,
  aJSONObjectIsRequired: "Ожидается JSON-объект: { … }",
  enterANumber: "Нужно число",
  enterANumber2: "Нужно число",
  anAccessGroupMemoryUsersIsRequired: "нужна группа доступа (memory-users): без неё не входит никто",
  baseDNIsRequired: "нужен base DN",
  theServiceAccountPasswordIsRequired: "нужен пароль служебной учётной записи",
  theServiceAccountDNIsRequired: "нужен DN служебной учётной записи",
  atLeastOneControllerIsRequired: "нужен хотя бы один контроллер",
  theGroupBranchMustBeADN: "ветка групп — DN вида OU=Projects,DC=corp,DC=example; пусто — любая группа под base DN",
  theGroupBranchMustBeOneLine: "ветка групп — одна строка до 1024 знаков",
  maximumGroupSizeMustBeAnInteger: "наибольший размер группы — целое 1–5000 человек",
  groupVerificationMustBeAnIntegerFrom: "сверка групп — целое 0–1440 минут; 0 — только кнопкой и при входе",
  theFailedSignInWindowMustBe: "окно неудачных входов — целое 5–1440 минут, не короче окна блокировки AD",
  attemptsPerLoginMustBeAnInteger: "попыток на логин — целое 1–20 за окно неудачных входов, ниже порога блокировки AD",
  attemptsPerAddressMustBeAnInteger: "попыток с адреса — целое 1–100 за окно неудачных входов",
  operationTimeoutMustBeSeconds: "тайм-аут операции — 1–120 секунд",
  connectionTimeoutMustBeSeconds: "тайм-аут соединения — 1–60 секунд",
  attributeMustBeAnLDAPAttributeName: (value1: string | number | null | undefined, value2: string | number | null | undefined): string => `атрибут ${value1}: «${value2}» — имя атрибута LDAP (латиница, цифры, дефис)`,
  isNotADomainExampleComOr: (value1: string | number | null | undefined): string => `«${value1}» — не домен (example.com) и не имя NetBIOS (CORP)`,
  eachGroupMustBeADNOr: "группа — DN или имя (CN) одной строкой до 1024 знаков",
  atMostAccessGroups: "не больше 20 групп доступа",
  theFilterNeedsAnShortNameOr: "в фильтре нужна подстановка {account} (короткое имя) или {upn} (как введено)",
  theFilterMustBeOneLDAPExpression: "фильтр — одно выражение LDAP в скобках, скобки парные",
  baseDNMustLookLikeDCCorp: "base DN — вида DC=corp,DC=example или OU=Users,DC=corp,DC=example",
  baseDNMustBeOneLineAt: "base DN — одна строка до 1024 знаков",
  theServiceAccountDNMustBeOne: "DN служебной учётной записи — одна строка до 1024 знаков",
  theCertificateNameMustBeAHost: "имя в сертификате — имя хоста (например, dc1.example.test)",
  theRootCertificateCouldNotBeParsed: "корневой сертификат не разбирается: нет блока -----BEGIN CERTIFICATE-----",
  withoutEncryptionPasswordsTravelAsPlainText: "без шифрования пароли идут по сети открытым текстом: включите «понимаю риск», иначе выберите LDAPS или StartTLS",
  portMustBeAnIntegerFromTo: "порт — целое 1–65535; 0 — по режиму (636 для LDAPS, 389 для StartTLS и без шифрования)",
  isNotAHostNameOrIP: (value1: string | number | null | undefined): string => `«${value1}» — не имя хоста и не IP-адрес (порт — отдельным полем)`,
  atMostControllers: "не больше 8 контроллеров",
  noSessionWasCreatedNoPersonS: "Сессия не создана, карточка не изменена, пароль нигде не сохранён",
  memberOfSpaces: (value1: string | number | null | undefined): string => `Участник пространств: ${value1}`,
  rolesNone: (value1: string | number | null | undefined): string => `Роли: нет${value1}`,
  roles: (value1: string | number | null | undefined): string => `Роли: ${value1}`,
  defaultPermissions: (value1: string | number | null | undefined): string => `Права по умолчанию: ${value1}`,
  thePreviousDirectoryLinkWasDisabledSign: "Прежняя связь с каталогом была отключена — вход восстановит её",
  theCardSLoginWillChangeTo: (value1: string | number | null | undefined): string => `Логин карточки сменится на ${value1} (почта в каталоге изменилась)`,
  noPersonSCardExistsOneWill: "Карточки нет — будет создана при первом входе",
  cardMatched: (value1: string | number | null | undefined, value2: string | number | null | undefined): string => `Карточка: ${value1}, сопоставлена ${value2}`,
  matchingCardsConflict: (value1: string | number | null | undefined): string => `Подходят карточки: ${value1} — конфликт`,
  none: "ни одной",
  matchingAccessGroups: (value1: string | number | null | undefined): string => `Группы доступа, через которые проходит: ${value1}`,
  noEmail: "нет почты",
  fromFullName: "— (возьмётся из ФИО)",
  memoryLoginEmailFullNameGivenName: (value1: string | number | null | undefined, value2: string | number | null | undefined, value3: string | number | null | undefined, value4: string | number | null | undefined, value5: string | number | null | undefined): string => `Логин в памяти (почта): ${value1}; ФИО: ${value2}; имя: ${value3}; подразделение: ${value4}; табельный: ${value5}`,
  directoryRecord: (value1: string | number | null | undefined): string => `Запись каталога: ${value1}`,
  adSubcodeThePersonSeesOnlyIncorrect: (value1: string | number | null | undefined, value2: string | number | null | undefined): string => `Подкод AD ${value1}${value2} (человеку показывается только «неверный логин или пароль»)`,
  notSpecified: "не назван",
  outcome: (value1: string | number | null | undefined): string => `Итог: ${value1}`,
};
