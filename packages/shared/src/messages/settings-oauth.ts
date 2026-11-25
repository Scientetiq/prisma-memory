// Descriptions of the oauth.* settings (agent sign-in through an external OAuth provider), as the settings listing shows them: the key of an entry is
// the settings key. Read through settingDescription (../setting-description.ts). The texts are literal: braces in
// them are examples of values, never parameters.
import { defineMessages } from "@memory/i18n";

export const M = defineMessages("shared.settings-oauth", {
  enabled: {
    en: "Sign-in of MCP agents through the browser with an external identity provider (OpenID Connect); switch on after the provider's public clients and the HTTPS resource address are set up",
    ru: "Вход MCP-агентов через браузер и внешний провайдер единого входа (OpenID Connect); включать после настройки публичных клиентов провайдера и HTTPS-адреса ресурса",
  },
  issuer: {
    en: "Issuer of the provider over HTTPS, an exact match with iss of the access token; separate from the confidential client of the workspace",
    ru: "Издатель провайдера единого входа по HTTPS, точное совпадение с iss access token; отдельный от конфиденциального клиента рабочего места",
  },
  resource_url: {
    en: "Canonical HTTPS URL of the resource with the path /mcp, equal to aud of the token; HTTP is allowed only on loopback for testing. When access.cloud_agent_base_url is set — exactly <that address>/mcp. A change revokes all connections: people sign in again",
    ru: "Канонический HTTPS URL ресурса с путём /mcp, совпадает с aud токена; HTTP допустим только на loopback для теста. Задан access.cloud_agent_base_url — ровно <он>/mcp. Смена отзывает все подключения: сотрудники входят заново",
  },
  ca_cert: {
    en: "PEM of the provider's root CA; empty — the system roots. This is a certificate, not a secret",
    ru: "PEM корневого CA провайдера единого входа; пусто — системные корни. Это сертификат, не секрет",
  },
  allowed_clients: {
    en: "Allowed azp → program: codex, claude_code, cursor, cloud_other. Unknown clients and script are refused",
    ru: "Разрешённый azp → программа: codex, claude_code, cursor, cloud_other. Неизвестные клиенты и script запрещены",
  },
  scope: {
    en: "Required scope of the access token: mcp:memory; offline_access is not published in the resource metadata",
    ru: "Обязательный scope access token: mcp:memory; offline_access не публикуется в метаданных ресурса",
  },
  timeout_sec: {
    en: "Timeout for loading the provider's metadata and JWKS, 1–60 seconds; redirects are not followed",
    ru: "Тайм-аут загрузки метаданных и JWKS провайдера единого входа, 1–60 секунд; без перенаправлений",
  },
  connection_days: {
    en: "Lifetime of a connection from the first sign-in, 1–90 days; a refresh does not extend it, a warning comes 14 days before the end",
    ru: "Срок подключения от первого входа, 1–90 дней; refresh не продлевает, за 14 дней предупреждение",
  },
});
