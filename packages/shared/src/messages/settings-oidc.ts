// Descriptions of the oidc.* settings (sign-in through an OpenID Connect provider), as the settings listing shows them: the key of an entry is
// the settings key. Read through settingDescription (../setting-description.ts). The texts are literal: braces in
// them are examples of values, never parameters.
import { defineMessages } from "@memory/i18n";

export const M = defineMessages("shared.settings-oidc", {
  enabled: {
    en: "Sign-in to the workspace through the identity provider (OpenID Connect), the second way after the directory. Switch on when the issuer, the client, the secret, the redirect address and the access group are set; run “Check provider” first",
    ru: "Вход в рабочее место через провайдера единого входа (OpenID Connect), второй способ после каталога. Включается, когда заданы издатель, клиент, секрет, адрес возврата и группа доступа; «Проверить провайдера» — до включения",
  },
  issuer: {
    en: "Issuer — the provider's HTTPS address (for Keycloak, the realm address): https://auth.example.com/realms/main. The metadata is read from …/.well-known/openid-configuration; the issuer in it and in the tokens must equal this address",
    ru: "Издатель (issuer) — адрес провайдера единого входа по HTTPS (в Keycloak — адрес realm): https://auth.example.com/realms/main. Метаданные читаются по …/.well-known/openid-configuration, издатель в них и в токенах должен совпасть с этим адресом",
  },
  client_id: {
    en: "Client ID of the workspace's confidential client at the provider. Empty by default: an example name does not become a working value",
    ru: "Client ID конфиденциального клиента рабочего места у провайдера единого входа. Пусто по умолчанию: пример имени не становится рабочим значением",
  },
  client_secret: {
    en: "Client secret: stored encrypted, never returned to the panel, sent only to the provider when the code is exchanged",
    ru: "Секрет клиента: хранится зашифрованным, в панель не возвращается, уходит только провайдеру единого входа при обмене кода",
  },
  redirect_uri: {
    en: "Redirect address — http(s)://workspace-address/auth/oidc/callback, for example https://memory.example.com/auth/oidc/callback. The same address goes into the client's valid redirect URIs",
    ru: "Адрес возврата — http(s)://адрес-рабочего-места/auth/oidc/callback, например https://memory.example.com/auth/oidc/callback. Тот же адрес — в Valid redirect URIs клиента",
  },
  scopes: {
    en: "Scopes separated by spaces; openid is required",
    ru: "Области (scope) через пробел; openid обязателен",
  },
  ca_cert: {
    en: "Root certificate of the provider (PEM, a chain is fine) when its certificate is issued by an internal CA. Empty — the built-in root list of Node.js",
    ru: "Корневой сертификат провайдера единого входа (PEM, можно цепочкой), если его сертификат выпущен внутренним CA. Пусто — встроенный список корневых сертификатов Node.js",
  },
  login_groups: {
    en: "Access groups in the groups claim (the Group Membership mapper in Keycloak): a group name, case-sensitive (Memory-Users also matches /Memory-Users), or a full path. Without a group nobody signs in; a group gives sign-in only — roles are assigned by the administrator",
    ru: "Группы доступа в claim групп (маппер Group Membership): имя группы AD с учётом регистра (Memory-Users — совпадает и с /Memory-Users) или полный путь. Без группы не входит никто; группа даёт только вход — роли назначает администратор",
  },
  claims: {
    en: "Names of the claims: stable identifier (LDAP_ID — objectGUID from the directory, the link to the person card and to the directory sign-in), e-mail (the login in the memory), e-mail verification, full name, department, employee number, groups, sign-in name, given name (how the workspace addresses the person; refreshed at every sign-in)",
    ru: "Имена claims: устойчивый идентификатор (LDAP_ID — objectGUID из AD, связь с карточкой и со входом через каталог), почта (логин в памяти), подтверждение почты, ФИО, подразделение, табельный, группы, имя входа, имя (обращение в рабочем месте; обновляется при каждом входе)",
  },
  timeout_sec: {
    en: "Timeout of a request to the provider, seconds (1–60): metadata, keys, the code exchange",
    ru: "Тайм-аут запроса к провайдеру единого входа, секунд (1–60): метаданные, ключи, обмен кода",
  },
  private_networks: {
    en: "Private networks of the provider: IPs or CIDRs separated by spaces or new lines. A private address outside the list is blocked; empty — all private addresses are blocked. Loopback, link-local and cloud metadata addresses are always forbidden. One rule for the workspace sign-in and for MCP OAuth",
    ru: "Частные сети провайдера: IP или CIDR через пробел или с новой строки. Частный адрес вне списка закрыт; пусто — закрыты все частные. Loopback, link-local и адреса метаданных облака запрещены всегда. Правило общее для входа рабочего места и MCP OAuth",
  },
});
