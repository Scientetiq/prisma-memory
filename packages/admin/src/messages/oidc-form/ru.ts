import type { Messages } from "../../i18n/core";
import type * as en from "./en";
import type { LdapField } from "../../lib/ldap-form";

export const OIDC_GROUPS: Messages<typeof en.OIDC_GROUPS> = [
    { title: "Провайдер", fields: [
            { key: "issuer", category: "oidc", kind: "text", label: "Издатель (issuer)", placeholder: "https://auth.example.com/realms/example",
                hint: "Адрес издателя по HTTPS (в Keycloak: адрес realm). Метаданные читаются по …/.well-known/openid-configuration; издатель в них и в токенах должен совпасть с этим адресом." },
            { key: "ca_cert", category: "oidc", kind: "multiline", label: "Корневой сертификат провайдера единого входа (PEM)", placeholder: "-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----",
                hint: "Нужен, если сертификат auth.example.com выпущен внутренним CA. Пусто — доверие системному списку сервера памяти. Смена — только вместе с секретом клиента." },
            { key: "timeout_sec", category: "oidc", kind: "number", label: "Тайм-аут, с", hint: "1–60: метаданные, ключи, обмен кода." },
            { key: "private_networks", category: "oidc", kind: "hosts", label: "Частные сети провайдера", placeholder: "fd00::5/128",
                hint: "IP или CIDR через пробел или с новой строки — например, адрес прокси, за которым стоит провайдер единого входа. Частный адрес вне списка закрыт; пусто — закрыты все частные. Loopback, link-local и адреса метаданных облака запрещены всегда" },
        ] },
    { title: "Клиент рабочего места", hint: "Конфиденциальный клиент у провайдера единого входа: Standard flow, PKCE S256, Client authentication — включено (шаг 1 выше).", fields: [
            { key: "client_id", category: "oidc", kind: "text", label: "Client ID", hint: "Как он записан у провайдера единого входа (в Keycloak: Clients → клиент рабочего места → Client ID)." },
            { key: "client_secret", category: "oidc", kind: "secret", label: "Секрет клиента" },
            { key: "redirect_uri", category: "oidc", kind: "text", label: "Адрес возврата",
                hint: "Адрес рабочего места + /auth/oidc/callback. Тот же — в разрешённых адресах возврата клиента у провайдера единого входа (в Keycloak: Valid redirect URIs)." },
            { key: "scopes", category: "oidc", kind: "text", label: "Области (scope)", placeholder: "openid profile email", hint: "Через пробел; openid обязателен." },
        ] },
    { title: "Кто входит", fields: [
            { key: "login_groups", category: "oidc", kind: "lines", label: "Группы доступа", placeholder: "MemoryAI-Users",
                hint: "По одной на строке: имя группы AD, как её отдаёт провайдер единого входа, например MemoryAI-Users (совпадает и с /MemoryAI-Users), или полный путь группы. Регистр важен: memoryai-users — другая группа. Голое имя совпадёт и с вложенной группой того же имени — надёжнее полный путь (/MemoryAI-Users), если провайдер отдаёт полные пути групп (в Keycloak: маппер групп с full.path). Входят только члены этих групп." },
            { key: "claims", category: "oidc", kind: "json", label: "Имена claims",
                hint: "guid — LDAP_ID (objectGUID из AD): по нему человек узнаётся и совпадает со входом через каталог. mail становится логином, если провайдер единого входа подтверждает почту (mail_verified). given_name — имя, по которому рабочее место здоровается (нет — имя из ФИО)." },
        ] },
];

export const OIDC_ENABLED: Messages<typeof en.OIDC_ENABLED> = { key: "enabled", category: "oidc", kind: "bool", label: "Вход в рабочее место через провайдера единого входа включён",
    hint: "Включается, когда заданы издатель, клиент, секрет, адрес возврата и группа доступа — иначе гейтвей не сохранит." };

export const OIDC_STEP_TITLES: Messages<typeof en.OIDC_STEP_TITLES> = {
    config: "настройки",
    discovery: "метаданные",
    issuer: "издатель",
    endpoints: "адреса и PKCE",
    jwks: "ключи подписи",
    redirect_uri: "адрес возврата",
    client: "клиент",
    groups: "группы доступа",
};

export const TEXT: Messages<typeof en.TEXT> = {
  isNotAPrivateNetworkItMust: (value1: string | number | null | undefined): string => `«${value1}» — не частная сеть: только внутри 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, fc00::/7`,
  isNotAnIPAddressOrCIDR: (value1: string | number | null | undefined): string => `«${value1}» — не IP-адрес и не CIDR (например, fd00::5/128)`,
  anAccessGroupMemoryUsersIsRequired: "нужна группа доступа (memory-users): без неё не входит никто",
  aReturnURLIsRequiredHttpWorkspace: (value1: string | number | null | undefined): string => `нужен адрес возврата (http://адрес-рабочего-места${value1}) — тот же, что в клиенте у провайдера единого входа`,
  aClientSecretIsRequiredForThe: "нужен секрет клиента — конфиденциальный клиент у провайдера единого входа",
  aClientIDIsRequiredTheCompany: "нужен client ID (клиент компании у провайдера единого входа, например memory)",
  anIssuerURLIsRequiredHttpsAuth: "нужен адрес издателя (https://auth.example.com/realms/example)",
  atMostPrivateNetworks: "не больше 20 частных сетей",
  timeoutMustBeSeconds: "тайм-аут — 1–60 секунд",
  claimMustBeAClaimNameLatin: (value1: string | number | null | undefined, value2: string | number | null | undefined): string => `claim ${value1}: «${value2}» — имя claim (латиница, цифры, _ . : -)`,
  eachGroupMustBeANameOr: "группа — имя или путь (/memory-users) одной строкой до 255 знаков",
  atMostAccessGroups: "не больше 20 групп доступа",
  theRootCertificateCouldNotBeParsed: "корневой сертификат не разбирается: нет блока -----BEGIN CERTIFICATE-----",
  theRootCertificateMustBeAtMost: "корневой сертификат — не длиннее 64000 знаков и не больше 10 сертификатов в цепочке",
  isNotAScopeNameSpaceSeparated: (value1: string | number | null | undefined): string => `«${value1}» — не имя области (через пробел: openid profile email)`,
  atMostScopes: "не больше 20 областей",
  openidIsRequiredInTheListOtherwise: "в списке нужен openid — без него провайдер единого входа не выдаёт ID-токен",
  theReturnURLPathMustBeHandled: (value1: string | number | null | undefined): string => `путь адреса возврата — ${value1} (его обрабатывает рабочее место)`,
  theReturnURLMustBeHttpS: (value1: string | number | null | undefined): string => `адрес возврата — http(s)://адрес-рабочего-места${value1}, без ? и #`,
  theReturnURLMustBeAtMost: "адрес возврата — не длиннее 500 знаков",
  clientIDMustUseLatinLettersDigits: "client ID — латиница, цифры и знаки без пробелов, до 255",
  theIssuerURLMustBeHttpsServer: "адрес издателя — URL с https:// без ? и # (секрет клиента и токены идут только по HTTPS)",
};
