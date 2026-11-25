// Descriptions of the locale.* settings (language and time zone of the installation), as the settings listing shows them: the key of an entry is
// the settings key. Read through settingDescription (../setting-description.ts). The texts are literal: braces in
// them are examples of values, never parameters.
import { defineMessages } from "@memory/i18n";

export const M = defineMessages("shared.settings-locale", {
  mcp_language: {
    en: "Language of what agents see over MCP: tool names and descriptions shown to people, connection instructions, resources and prompts. en — English, ru — Russian. Tool identifiers and schemas are the same in both languages; agents see the change within 5 minutes or after their session restarts",
    ru: "Язык того, что агенты видят через MCP: названия и описания инструментов, инструкции подключения, ресурсы и промпты. en — английский, ru — русский. Имена инструментов и схемы на обоих языках одни и те же; агенты увидят смену в течение 5 минут или после перезапуска сессии",
  },
  language: {
    en: "Language of the installation: e-mails, alerts, the admin panel and other texts people see, unless a request asks for another one. en — English, ru — Russian. The language of what agents see over MCP is set separately, by locale.mcp_language",
    ru: "Язык установки: письма, оповещения, панель администратора и другие тексты, которые видят люди, если запрос не просит другой язык. en — английский, ru — русский. Язык того, что агенты видят через MCP, задаётся отдельно — locale.mcp_language",
  },
  timezone: {
    en: "Time zone of the installation (an IANA name such as UTC, Europe/Berlin or America/New_York): days and hours in searches, plans and e-mails are counted in it",
    ru: "Часовой пояс установки (имя IANA, например UTC, Europe/Berlin или America/New_York): в нём считаются дни и часы в поиске, планах и письмах",
  },
});
