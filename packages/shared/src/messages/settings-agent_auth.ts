// Descriptions of the agent_auth.* settings (the built-in agent sign-in), as the settings listing shows them: the key of an entry is
// the settings key. Read through settingDescription (../setting-description.ts). The texts are literal: braces in
// them are examples of values, never parameters.
import { defineMessages } from "@memory/i18n";

export const M = defineMessages("shared.settings-agent_auth", {
  mode: {
    en: "Who lets agents in through the browser: external — an external OAuth provider (the “Agent sign-in (OAuth)” section, as before), builtin — the memory itself (a built-in sign-in server on the agent address, consent in the workspace), off — nobody (personal keys only). Changing the mode revokes the connections of the previous one; builtin switches on only when it is ready",
    ru: "Кто впускает агентов через браузер: external — внешний провайдер единого входа (раздел «Вход агентов (OAuth)», как прежде), builtin — сама память (встроенный сервер входа на адресе агентов, согласие — в рабочем месте), off — никто (только личные ключи). Смена режима отзывает подключения прежнего; builtin включается, только когда готов",
  },
  clients: {
    en: "Pre-registered programs (Client IDs): client_id, the kind of program, the caption on the consent screen, whether it is enabled, redirect addresses (as in the edge anchors; {\"uri\"} — the program's own scheme). Disabling or removing a program revokes its connections; removing one redirect address disconnects nobody — new sign-ins to it fail, while connections already obtained through it stay (to disconnect: “Disconnect” by the employee, on the person card in the panel, or disable the program)",
    ru: "Заранее заведённые программы (Client ID): client_id, вид программы, подпись на согласии, включена ли, адреса возврата (как у якорей ребра; {\"uri\"} — своя схема программы). Выключение или удаление программы отзывает её подключения; снятие одного адреса возврата никого не отключает — новые входы на него не пройдут, а подключения, уже полученные через него, остаются (отключить: «Отключить» у сотрудника, на карточке человека в панели или выключить программу)",
  },
  cimd_hosts: {
    en: "Where the memory takes a program's “passport” (the CIMD document) from: entries host/prefix/, for example claude.ai/oauth/. A document from another host or path is not loaded. Removing an entry revokes the connections of programs from that address",
    ru: "Где память берёт «паспорт» программы (документ CIMD): записи хост/префикс/, например claude.ai/oauth/. Документ с другого хоста или пути не загружается. Снятие записи отзывает подключения программ с этого адреса",
  },
  cimd_any_https: {
    en: "Accept a program's “passport” from any HTTPS address (except IP addresses and IDN names). Such a program is marked on the consent screen as not on the list of known ones",
    ru: "Принимать «паспорт» программы с любого HTTPS-адреса (кроме IP и IDN). Такая программа на согласии помечена как не из списка известных",
  },
  dcr_enabled: {
    en: "Automatic client registration (DCR): a program obtains a Client ID by itself. Off by default; on the consent screen such a program is marked as not on the list of known ones. Switching it off revokes all such connections",
    ru: "«Регистрация программ автоматически» (DCR): программа сама получает Client ID. Выключено по умолчанию; на согласии такая программа помечена как не из списка известных. Выключение отзывает все такие подключения",
  },
  dcr_limits: {
    en: "Limits of automatic registration: per_day — registrations per day for the whole memory (1–10000), per_day_net — from one network (1–1000), per_day_trusted — the share of the day for all egress networks of cloud programs (agent_auth.dcr_trusted_egress) together, less than per_day (0–9999; other networks always keep per_day − per_day_trusted; half by default), max_clients — live programs (1–10000), unused_hours — after how many hours a program without a single sign-in is deleted (1–2160)",
    ru: "Пределы автоматической регистрации: per_day — регистраций в сутки на память (1–10000), per_day_net — с одной сети (1–1000), per_day_trusted — доля суток для всех сетей выхода облачных программ (agent_auth.dcr_trusted_egress) вместе, меньше per_day (0–9999; остальным сетям всегда остаётся per_day − per_day_trusted; по умолчанию половина), max_clients — живых программ (1–10000), unused_hours — через сколько часов удаляется программа без единого входа (1–2160)",
  },
  dcr_trusted_egress: {
    en: "Egress networks of cloud programs for automatic registration (CIDR): the operator enters the published egress ranges of Anthropic (claude.ai) and OpenAI (ChatGPT) here — they register one program per employee from a few shared addresses. A registration from an address in these networks is counted not against per_day_net (“from one network”) but against the per_day_trusted share of dcr_limits (common to all these networks, less than the daily per_day); per_day, max_clients and the per-minute limit per address apply to everyone. The connection address is compared (X-Forwarded-For only from a trusted proxy of access.trusted_proxies), not what the program sent. Up to 256 networks, no wider than /16 (IPv4) and /32 (IPv6), without “the whole internet”, without overlaps and without special networks (loopback, private and service networks, link-local, multicast, documentation, 6to4, Teredo, NAT64 and other transition ranges). A network that overlaps a trusted proxy gives a warning on the “Agent sign-in” page. Empty — the per-network limit applies to everyone",
    ru: "Сети выхода облачных программ для автоматической регистрации (CIDR): сюда оператор вписывает опубликованные диапазоны выхода Anthropic (claude.ai) и OpenAI (ChatGPT) — они регистрируют по программе на сотрудника с немногих общих адресов. Регистрация с адреса из этих сетей считается не в пределе per_day_net «с одной сети», а в доле per_day_trusted пределов dcr_limits (общей для всех этих сетей, меньше суточного per_day); per_day, max_clients и предел в минуту на адрес действуют для всех. Сверяется адрес соединения (X-Forwarded-For — только от доверенного прокси access.trusted_proxies), а не то, что прислала программа. До 256 сетей, не шире /16 (IPv4) и /32 (IPv6), без «всего интернета», без пересечений между собой и без особых сетей (петля, частные и служебные сети, link-local, multicast, документация, 6to4, Teredo, NAT64 и прочие переходные). Сеть, пересекающая доверенный прокси, — предупреждение на странице «Вход агентов». Пусто — предел сети для всех",
  },
  connection_days: {
    en: "Lifetime of an agent connection through the built-in sign-in, days (1–90); refreshing the token does not extend it",
    ru: "Срок подключения агента через встроенный вход, дней (1–90); обновление токена срок не продлевает",
  },
  idle_days: {
    en: "After how many days without use an agent connection expires (1–90)",
    ru: "Через сколько дней без использования подключение агента гаснет (1–90)",
  },
});
