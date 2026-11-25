// Descriptions of the access.* settings (access, sessions, networks and people's data), as the settings listing shows them: the key of an entry is
// the settings key. Read through settingDescription (../setting-description.ts). The texts are literal: braces in
// them are examples of values, never parameters.
import { defineMessages } from "@memory/i18n";

export const M = defineMessages("shared.settings-access", {
  origin_allowlist: {
    en: "Browser Origins allowed for /mcp (protection against DNS rebinding). An empty list refuses every Origin; requests without an Origin (desktop MCP clients, services, the panel) always pass. Items: a whole origin, a host or *.domain. \"*\" is a deliberate choice of “any Origin”: health shows degraded",
    ru: "Разрешённые браузерные Origin для /mcp (защита от DNS rebinding). Пустой список — любой Origin отвергается; запросы без Origin (десктопные MCP-клиенты, сервисы, панель) проходят всегда. Элементы: origin целиком, хост или *.домен. \"*\" — осознанный выбор «любой Origin»: health показывает degraded",
  },
  t1_providers: {
    en: "Trusted external providers (level T1): names of the services of trusted external providers. Empty — level T1 is closed: a T1 service is not registered, no key is issued, an existing T1 key is refused; admitting a provider is an explicit act of the administrator after your legal team agrees",
    ru: "Доверенные внешние провайдеры (уровень T1): имена сервисов — доверенных внешних провайдеров. Пусто — уровень T1 закрыт: сервис T1 не регистрируется, ключ не выпускается, существующий ключ T1 отвергается; включение провайдера — явное действие администратора после согласования с юристами",
  },
  original_link_ttl_sec: {
    en: "Lifetime of a signed link to an original file, seconds",
    ru: "Срок подписанной ссылки на оригинал",
  },
  link_signing_key: {
    en: "Key that signs links to original files; generated at first run (stored encrypted)",
    ru: "Ключ подписи ссылок; генерируется на first-run",
  },
  public_base_url: {
    en: "Public (internal) address of the gateway, for example https://memory.example.com: used by the workspace and the “Open original” links, scripts and programs in the company network, agents with extended access, services. Cloud agents get the same address until cloud_agent_base_url is set. Empty — the panel derives the address from the request",
    ru: "Публичный (внутренний) адрес гейтвея, например https://memory.example.com: рабочее место и ссылки «Открыть оригинал», скрипты и программы в сети компании, агенты с расширенным доступом, сервисы. Облачным агентам — он же, пока не задан cloud_agent_base_url. Пусто — панель выводит адрес из адреса запроса",
  },
  cloud_agent_base_url: {
    en: "Address of the memory for Claude Code, Codex, Cursor and other cloud agents: connection commands, the “Skill archive” line, the installation prompt. Use an HTTPS origin without a path (HTTP is accepted for localhost in local testing), the name in lower case, without :443. While agent sign-in through an account is on, oauth.resource_url must be exactly <this address>/mcp. In the panel, step by step: if this address is already set, clear it first; then change oauth.resource_url (the “Agent sign-in (OAuth)” tab); then set this address. Or change both settings in one PUT request (see the admin guide). Empty — the same as public_base_url",
    ru: "Адрес памяти для Claude Code, Codex, Cursor и других облачных агентов: команды подключения, строка «Архив скилла», промпт установки. Только https://имя без пути (http — только для localhost при локальной проверке), имя строчными буквами, без :443. Пока включён вход агентов через учётную запись, oauth.resource_url должен быть ровно <этот адрес>/mcp. В панели — по очереди: если этот адрес уже задан, сначала очистить его; затем сменить oauth.resource_url (вкладка «Вход агентов (OAuth)»); затем задать этот адрес. Или обе настройки одним запросом PUT. Пусто — как public_base_url",
  },
  org_spaces_auto_create: {
    en: "Create department spaces when the org table is loaded; membership comes from the org table",
    ru: "Создавать пространства подразделений при загрузке орг-таблицы; участие — из орг-таблицы",
  },
  obo_external_identities: {
    en: "Accept X-On-Behalf-Of of the form <system>:<external id>; only verified links of person_identities",
    ru: "Принимать X-On-Behalf-Of вида <система>:<внешний id>; только проверенные связи person_identities",
  },
  acl_stale_days: {
    en: "After how many days access data from a source counts as stale (a line in the administrator's report only). Reserved: this version does not read it",
    ru: "Через сколько дней сведения о доступе от источника считаются устаревшими (только отчёт администратору)",
  },
  obo_denial_pause: {
    en: "A run of “on behalf of” refusals (X-On-Behalf-Of: the service is not allowed, the person is unknown, inactive or a demo persona): more than limit refusals of one key within window_min minutes — the key is refused for pause_min minutes; every refusal and the pause go to the audit log (auth_failure), the pause also to the report and the panel. limit 0 — no pause",
    ru: "Серия отказов «от имени» (X-On-Behalf-Of: сервису не разрешено, человек неизвестен, неактивен или демо): больше limit отказов одного ключа за window_min минут — ключ на pause_min минут отвергается; каждый отказ и пауза — в журнале (auth_failure), пауза — в отчёте и в панели. limit 0 — без паузы",
  },
  trash_days: {
    en: "How many days a deleted record stays in the trash: the author and the space owner see it, a person can restore it or delete it permanently in the workspace; after that it is purged for good together with the original. Applies to deletions made after the change",
    ru: "Сколько дней удалённая запись лежит в корзине: её видят автор и владелец пространства, восстановить или удалить навсегда может человек в рабочем месте; по истечении — очистка безвозвратно вместе с оригиналом. Действует на удаления после изменения",
  },
  workplace_url: {
    en: "Address of the workspace for people, for example https://memory.example.com: answers to agents link to it (“trash”, “open the record”). Empty — answers name the workspace section without a link",
    ru: "Адрес рабочего места для людей, например https://memory.example.com: из ответов агентам ведут ссылки «корзина», «открыть запись». Пусто — ответы называют раздел рабочего места без ссылки",
  },
  workplace_peers: {
    en: "The workspace server: addresses, CIDRs or host names from which the gateway accepts workspace sessions. “Human only” actions (open, restore, delete permanently, issue and revoke a key) need a session, and a session is accepted only from here. Keep the list short",
    ru: "Сервер рабочего места: адреса, CIDR или имена хостов, с которых шлюз принимает сессии рабочего места. Действия «только человек» (открыть, восстановить, удалить навсегда, выпустить и отозвать ключ) — только по сессии, а сессия — только отсюда. Список держите коротким",
  },
  session_days: {
    en: "Lifetime of a workspace session in days from sign-in, without extension: after that the person signs in again. Sign-out, “End all sessions” and deactivating the person end the session at once",
    ru: "Срок сессии рабочего места в днях от входа, без продления: по истечении человек входит заново. Выход, «Завершить все» и деактивация человека завершают сессию сразу",
  },
  test_sessions: {
    en: "For testing only: POST /api/v1/admin/test-sessions issues a workspace session to a test person (attrs.test, not a demo persona, no directory link) for an hour, without a password. While on, health is degraded; switching it off ends all issued test sessions",
    ru: "Только для проверок: POST /api/v1/admin/test-sessions выдаёт сессию рабочего места тестовому человеку (attrs.test, не демо, без связи с AD) на час, без пароля. Пока включено, health — degraded; выключение гасит все выданные тестовые сессии",
  },
  author_rule: {
    en: "The author rule in search, lists and folder counters. legacy — as before: by id (memory_read, status, original, resources, “Meetings with me”) authors always read their own record, while search and lists find it only if they read its space or placement, are in the record's list of people, or the record has the “people” scope. always — “authors always read their own record” in search and lists too: a record moved to where its author no longer reads (a transfer, removal from a team, a move by a manager) is still found by search. One rule for all queries, changed here without touching code. Other values are not saved",
    ru: "Правило автора в поиске, списках и счётчиках папок. legacy — как было: по id (memory_read, статус, оригинал, ресурсы, «Встречи со мной») автор читает свою запись всегда, а поиск и списки находят её, только если он читает её пространство или размещение, есть в списке людей записи или у записи область «люди». always — «автор читает свою запись всегда» и в поиске и списках: запись, унесённая туда, где автор больше не читает (перевод, исключение из команды, перенос руководителем), находится и поиском. Правило одно на все выборки — меняется здесь, без правки кода. Другие значения не сохраняются",
  },
  session_idle_hours: {
    en: "Idle time of a workspace session in hours: without requests for longer, the session ends and the person signs in again. 0 — no idle limit; the lifetime from sign-in is session_days",
    ru: "Простой сессии рабочего места в часах: без запросов дольше — сессия завершается, человек входит заново. 0 — без ограничения простоя; срок от входа — session_days",
  },
  support_contact: {
    en: "Where to turn when signing in fails: the contact of your IT support (an e-mail address or a phone number), for example support@example.com. Shown on the workspace sign-in page to everyone, signed in or not, and in the refusal “not in the access group”. Empty — “contact your company's support”. Up to 300 characters",
    ru: "Куда обращаться, если не получается войти: контакт службы поддержки ИТ (почта или телефон), например support@example.com. Показывается на странице входа рабочего места всем, даже не вошедшим, и в отказе «нет в группе доступа». Пусто — «обратитесь в службу поддержки компании». До 300 знаков",
  },
  trusted_proxies: {
    en: "CIDRs of trusted proxies (up to 20; IPv4 no wider than /12, IPv6 no wider than /64, a /0 network is not allowed): X-Forwarded-For is accepted only from them. The client address behind a proxy decides the network binding of keys, the address in the audit log, the channel of the request (a client outside access.internal_networks is external) and the per-address request limits before the key check. No traffic through a proxy is internal: a host name that arrives through it and is in neither access.external_hosts nor access.agent_hosts counts as external (except the gateway machine itself and the workspace server). Empty — the socket address is used, and everything that comes through a proxy counts as coming from the proxy's own address: one limit for all and nothing external by address",
    ru: "CIDR доверенных прокси (до 20; IPv4 не шире /12, IPv6 не шире /64, сеть /0 не допускается): только от них принимается X-Forwarded-For. Адрес клиента за прокси решает сетевую привязку ключей, адрес в аудите, канал запроса (клиент вне «Внутренних сетей компании» — внешний) и пределы запросов до проверки ключа по адресу. Через прокси внутреннего трафика нет: имя, пришедшее через него не из «Внешних адресов агентов» и не из «Адресов для агентов», считается внешним (кроме самой машины шлюза и сервера рабочего места). Пусто — адрес сокета, и всё, что приходит через прокси, считается пришедшим с адреса самого прокси: один предел на всех и ни одного внешнего по адресу",
  },
  external_hosts: {
    en: "Host names of the external agent address (the name only, without scheme, port or path, for example agents.example.test; up to 20). A request with such a Host counts as external: only /mcp, the OAuth resource description, the skill, originals of open records, the meeting upload by link and the health check (status only) are open, everything else is “not found”; the system and extended keys, the preview key, service keys with full access and “on behalf of”, and panel and workspace sessions are not accepted there, and answers say nothing about closed records. A client with an address outside access.internal_networks is external too, and so is a name that arrives through a trusted proxy and is neither here nor in access.agent_hosts. The proxy must preserve Host. Empty — this list closes nothing (the health check warns if a proxy is set)",
    ru: "Имена внешнего адреса агентов (только имя, без схемы, порта и пути, например agents.example.test; до 20). Запрос с таким Host считается внешним: открыты только /mcp, описание ресурса OAuth, скилл, оригиналы открытых записей, загрузка встречи по ссылке и проверка здоровья (только статус), остальное — «не найдено»; там не принимаются системный и расширенный ключи, ключ предпросмотра, ключи сервисов с полным доступом и «от имени», сессии панели и рабочего места, а ответы ничего не говорят о закрытом. Внешним считается и клиент с адресом вне «Внутренних сетей компании», и имя, пришедшее через доверенный прокси, которого нет ни здесь, ни в «Адресах для агентов». Прокси обязан сохранять Host. Пусто — по этому списку ничего не закрывается (проверка здоровья предупредит, если задан прокси)",
  },
  agent_hosts: {
    en: "Host names agents use to connect to the memory (the name only, for example agents.example.test; up to 20): on them the admin API, the panel sign-in, the first run, people's sign-in and workspace sessions are closed — the answer is “not found”, the system key and sessions are not accepted; everything else works as usual. The external address is stricter: everything closed here is closed there too. Through a trusted proxy a name that is neither in this list nor in access.external_hosts counts as external — add here every name the proxy lets agents in by",
    ru: "Имена, по которым к памяти подключаются агенты (только имя, например agents.example.test; до 20): по ним закрыты админ-API, вход в панель, первый запуск, вход людей и сессии рабочего места — ответ «не найдено», системный ключ и сессии не принимаются; остальное работает как обычно. Внешний адрес строже: всё, что закрыто здесь, закрыто и там. Через доверенный прокси имя не из этого списка и не из «Внешних адресов агентов» считается внешним — допишите сюда все имена, по которым прокси пускает агентов",
  },
  internal_networks: {
    en: "Internal company networks (CIDR, up to 50; IPv4 no wider than /8, IPv6 no wider than /7): a client whose address (after X-Forwarded-For from a trusted proxy) is outside them is external, like a request to an external host name. Not set: the default of the deploy profile applies — internet: loopback only (127.0.0.0/8, ::1/128); internal-http and development: loopback, RFC 1918 (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) and ULA (fc00::/7). A list you set must cover 127.0.0.1 and ::1 (otherwise the panel and the workplace would become external); /0 and IPv6 networks over IPv4 addresses (::ffff:0:0/96) are refused — write IPv4 as IPv4. Add VPN pools outside the private networks here",
    ru: "Внутренние сети компании (CIDR, до 50; IPv4 не шире /8, IPv6 не шире /7): клиент, чей адрес (после X-Forwarded-For от доверенного прокси) лежит вне них, — внешний, как запрос по внешнему имени. Не задано — действует умолчание профиля развёртывания: internet — только петля (127.0.0.0/8, ::1/128); internal-http и development — петля, RFC 1918 (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) и ULA (fc00::/7). Заданный список обязан покрывать 127.0.0.1 и ::1 (иначе панель и рабочее место стали бы внешними); /0 и сети IPv6 поверх адресов IPv4 (::ffff:0:0/96) отклоняются — IPv4 записывается как IPv4. Пулы VPN вне частных сетей допишите сюда",
  },
  system_key_networks: {
    en: "Where the gateway accepts the system key from: CIDR networks (up to 20; IPv4 no wider than /12, IPv6 no wider than /64); the connection address is compared, not X-Forwarded-For. A panel session is accepted from here or from the workspace server. Requests from here are not counted by the limits before the key check. The list must cover 127.0.0.1 (the gateway machine and its tools use loopback); a /0 network and IPv6 networks over IPv4 addresses (::ffff:0:0/96) are not allowed. Administrator tools on another machine go through an SSH tunnel to loopback",
    ru: "Откуда шлюз принимает системный ключ: сети CIDR (до 20; IPv4 не шире /12, IPv6 не шире /64), сверяется адрес соединения, а не X-Forwarded-For. Сессию панели — отсюда или с сервера рабочего места. Запросы отсюда не считаются пределами до проверки ключа. Список обязан покрывать 127.0.0.1 (с петли ходят сама машина шлюза и её инструменты), сеть /0 и сети IPv6 поверх адресов IPv4 (::ffff:0:0/96) не допускаются. Инструменты администратора с другой машины ходят через SSH-туннель на петлю",
  },
  obo_service_keys: {
    en: "Issuing keys to services that act “on behalf of” people, and switching “on behalf of” on for a service. Off — the panel and the admin API refuse. On — a new key of this kind only with an address binding, and if the service reads on behalf of people — with a lifetime of at most 30 days. Keys already issued keep working",
    ru: "Выпуск ключей сервисам, которые действуют «от имени» людей, и включение «от имени» у сервиса. Выключено — панель и админ-API отказывают. Включено — новый такой ключ только с привязкой к адресу, а если сервис читает от имени — со сроком не больше 30 дней. Уже выпущенные ключи работают",
  },
  require_department_code: {
    en: "An org table upload must give a stable department_code for every department: a batch without codes is refused as a whole, with the list of departments. false — the earlier behaviour: the code is derived from the name, and the answer and the panel warn",
    ru: "Выгрузка орг-таблицы обязана давать устойчивый department_code для каждого подразделения: пакет без кодов отвергается целиком с перечнем подразделений. false — прежнее поведение: код выводится из названия, ответ и панель предупреждают",
  },
  dismissed_retention_days: {
    en: "After how many days from deactivation the frozen personal space of a test account (an address at corp.test or in the .test domain) is deleted, and with access.dismissed_personal = delete — that of an employee too: the regular way (deleted_at → purge), by a worker job; reactivation within the term lifts the freeze. 0 — delete nobody (0–3650)",
    ru: "Через сколько дней после отключения удаляется замороженное личное пространство тестовой учётной записи (адрес на corp.test или в домене .test), а при access.dismissed_personal = delete — и сотрудника: штатным путём (deleted_at → purge) заданием воркера; повторная активация в срок снимает заморозку. 0 — не удалять никого (0–3650)",
  },
  dismissed_personal: {
    en: "Personal space of a former employee (deactivated by the org table): keep — store without a term and do not purge the trash: the records belong to the company; delete — remove after access.dismissed_retention_days. Warning: switching to delete removes, from the next pass, the personal space of everyone frozen for longer than the term. Test accounts are deleted by the term under either value",
    ru: "Личное пространство уволенного сотрудника (отключён орг-таблицей): keep — хранить бессрочно, корзину не очищать: записи — собственность компании; delete — удалять через access.dismissed_retention_days. Внимание: переключение на delete со следующего прохода удалит личное всех, кто заморожен дольше срока. Тестовые учётные записи удаляются по сроку при любом значении",
  },
  dismissed_meetings: {
    en: "Meetings of a former employee that had other participants: transfer — after access.dismissed_custody_after_days days they pass to the custodian (the manager), who becomes the organiser; wait — they stay with the former employee without an organiser, and those already handed over return on the next pass",
    ru: "Встречи уволенного сотрудника, где были другие участники: transfer — через access.dismissed_custody_after_days дней переходят хранителю (руководителю), он становится организатором; wait — остаются у уволенного без организатора, а уже переданные возвращаются к нему следующим проходом",
  },
  dismissed_custody_after_days: {
    en: "How many days after the dismissal the meetings pass to the custodian and the custodian gets access to the personal space (0–90). Reactivation within this term moves nothing",
    ru: "Через сколько дней после увольнения встречи переходят хранителю и хранитель получает доступ к личному (0–90). Повторная активация в этот срок ничего не двигает",
  },
  dismissed_custody_test: {
    en: "For test installations only: test accounts (corp.test, .test) also get a custodian — a test one — and the handover of meetings. Off — their personal space is deleted by the term and meetings are not handed over",
    ru: "Только для тестовых установок: тестовые учётные записи (corp.test, .test) тоже получают хранителя — тестового — и передачу встреч. Выключено — их личное удаляется по сроку, встречи не передаются",
  },
  dismissed_custody: {
    en: "What the custodian of a former employee's personal space reads in the workspace (“Handed over to me”): all — all records, closed ones after a confirmation for each, every opening in the audit log; open — open records only, for closed ones just the count; off — the personal space is kept but nobody reads it. The custodian's agents never see it",
    ru: "Что читает хранитель личного уволенного в рабочем месте («Переданные мне»): all — все записи, закрытые — после подтверждения на каждую, каждое открытие в журнале; open — только открытые, о закрытых — только число; off — личное хранится, но не читает никто. Агенты хранителя личное уволенного не видят никогда",
  },
  mass_deactivation_share: {
    en: "A full org table upload (“deactivate everyone absent from this upload”): if it would deactivate more than this share of active employees (demo personas are not counted), a second, separate confirmation with the number and the first names is required — without it the upload is refused as a whole and nothing changes. A number from 0 to 1: 0.2 — one fifth (the default); 0 — confirm any deactivation; 1 — the second confirmation is never asked",
    ru: "Полная выгрузка орг-таблицы («деактивировать всех, кого нет в этой загрузке»): если она отключит больше этой доли работающих сотрудников (демо-персоны не считаются), нужно второе, отдельное подтверждение с числом и первыми фамилиями — без него загрузка отвергается целиком, ничего не меняется. Число от 0 до 1: 0.2 — пятая часть (по умолчанию); 0 — подтверждать любое отключение; 1 — второе подтверждение не спрашивается никогда",
  },
  space_invite_days: {
    en: "How many days an invitation to a project or team waits for a colleague who has not signed in to the memory yet: at the first sign-in it becomes membership; if it expires, it is withdrawn. 1–365",
    ru: "Сколько дней ждёт приглашение в проект или команду коллеги, который ещё не входил в память: при первом входе оно становится участием, не дождалось — снимается само. 1–365",
  },
  test_leftovers_scope: {
    en: "Where records of deactivated test accounts (the test mark, an address at corp.test or in the .test domain) are deleted without the trash: off — nowhere, an emergency stop (from the next batch, also for the company-wide space); org — only in the company-wide space; all — in all their spaces (outside the company-wide space through a 7-day trash nobody sees), and their empty spaces are archived. Records of employees, demo personas and the showcase are never deleted. Deletion cannot be undone",
    ru: "Где удалять без корзины записи деактивированных тестовых учётных записей (пометка test, адрес на corp.test или в домене .test): off — нигде, стоп-кран (со следующей пачки, и для пространства всей компании); org — только в пространстве всей компании; all — во всех их пространствах (вне пространства всей компании — через корзину на 7 дней, которую никто не видит), а их пустые пространства — в архив. Записи сотрудников, демо-персоны и витрина не удаляются никогда. Удаление необратимо",
  },
  test_leftovers_grace_minutes: {
    en: "How many minutes after a test account is deactivated to wait before deleting its records outside the company-wide space (1–10080). Reactivation within this term cancels the deletion",
    ru: "Сколько минут после деактивации тестовой учётной записи ждать, прежде чем удалять её записи вне пространства всей компании (1–10080). Повторная активация в этот срок отменяет удаление",
  },
  test_purge: {
    en: "Final deletion of deactivated test accounts, their archived spaces, keys, sessions and assignments: off — do not delete; auto — once an hour delete what is older than the hold time. The automation does not touch records or the trash. Employees, the role showcase, the audit log and tombstones are never deleted. Deletion cannot be undone",
    ru: "Окончательное удаление отключённых тестовых учётных записей, их архивных пространств, ключей, сессий и назначений: off — не удалять; auto — раз в час удалять то, что старше выдержки. Записи и корзину автоматика не трогает. Сотрудники, витрина ролей, журнал и надгробия не удаляются никогда. Удаление необратимо",
  },
  test_purge_after_hours: {
    en: "How many hours after deactivation and archiving test data is deleted for good by the automation (1–8760)",
    ru: "Через сколько часов после отключения и архивации тестовое удаляется автоматикой насовсем (1–8760)",
  },
  test_purge_max: {
    en: "How many objects of one kind the automation deletes in one run, at most (1–100000); the rest waits for the next hour",
    ru: "Сколько объектов одного вида автоматика удаляет за один запуск, не больше (1–100000); остальное — в следующий час",
  },
  plan_agent_max_items: {
    en: "How many plan items an agent may apply in one space within plan_ttl_minutes per person after explicit consent in the conversation (0–2000). More than that, several spaces, permanent deletion, a script key or a preview key — only a person in the workspace. 0 — everything goes through the workspace",
    ru: "Сколько позиций планов агент может применить в одном пространстве за plan_ttl_minutes на человека после явного согласия в разговоре (0–2000). Больше, несколько пространств, удаление навсегда, ключ скрипта или предпросмотра — только человек в рабочем месте. 0 — всё через рабочее место",
  },
  plan_ttl_minutes: {
    en: "How many minutes a bulk change plan is valid (1–120): applying must start before the term ends, and what was started may continue for as long after the start",
    ru: "Сколько минут действует план массового действия (1–120): начать применение — до конца срока, продолжить начатое — столько же после начала",
  },
  correct_non_participant: {
    en: "A correction from someone who only reads the record (not the author, not a meeting participant, not the space owner and, for “outdated”, not a member of the space): proposed — a proposal that the author, a meeting participant or the space owner confirms in the workspace; deny — refused",
    ru: "Исправление от того, кто запись только читает (не автор, не участник встречи, не владелец пространства и, для «устарело», не участник пространства): proposed — предложение, его подтверждает автор, участник встречи или владелец пространства в рабочем месте; deny — отказ",
  },
  org_review_enabled: {
    en: "Review of “Company knowledge” records by curators: a new record there is visible to everyone at once with the mark “not confirmed” and ranks lower in search; once a week the curators confirm it or send it back (“Company knowledge review”); without a confirmation it returns by itself to where it came from; people mark records “Useful” and “Wrong / not for everyone”. Off — new records do not go to review, there is no mark and no return by term; what is already marked “Wrong” stays hidden from agents until a curator decides",
    ru: "Проверка записей «Общих знаний компании» кураторами: новая запись там сразу видна всем с пометкой «не подтверждено» и стоит ниже в поиске, кураторы раз в неделю подтверждают или возвращают её («Проверка общих знаний»), без подтверждения она сама возвращается туда, откуда пришла; люди отмечают «Полезно» и «Неверно / не для всех». Выключено — новые записи не встают на проверку, пометки и возврата по сроку нет; уже отмеченное «Неверно» агенты по-прежнему не находят до решения куратора",
  },
  org_review_days: {
    en: "After how many days an unconfirmed “Company knowledge” record returns by itself to where it came from (an integer from 1 to 365). Applies to records that arrive after the change; records marked “Wrong” do not return by themselves — they wait for a curator",
    ru: "Через сколько дней неподтверждённая запись «Общих знаний компании» сама возвращается туда, откуда пришла (целое от 1 до 365). Действует на записи, вошедшие после изменения; отмеченные «Неверно» сами не возвращаются — ждут куратора",
  },
  org_review_queue_limit: {
    en: "How many records a curator sees per page of “Company knowledge review” (1–50); the rest are on the next pages, the total is in the counter",
    ru: "Сколько записей на странице «Проверка общих знаний» у куратора (1–50); остальные — на следующих страницах, число — в счётчике",
  },
  org_review_community_teams: {
    en: "How many different departments must mark a record “Useful” for it to become “confirmed by the community” and stop returning by term (2–10). A mark from a person without a department is recorded but does not count",
    ru: "Сколько разных подразделений должны отметить «Полезно», чтобы запись стала «подтверждено сообществом» и не возвращалась по сроку (2–10). Отметка человека без подразделения учитывается, но в счёт не идёт",
  },
  org_review_digest: {
    en: "Weekly e-mail to the curators of “Company knowledge”: the weekday (1 — Monday, 7 — Sunday), the time and an optional time zone (tz; otherwise the installation's zone). Sent when mail is on and only if there is something to review: numbers and a link to “Company knowledge review”, without titles or texts of records. enabled = false — no e-mail, the counter in the workspace stays",
    ru: "Недельное письмо кураторам «Общих знаний компании»: день недели (1 — понедельник, 7 — воскресенье), время и часовой пояс. Уходит при включённой почте и только если есть что проверять: числа и ссылка на «Проверку общих знаний», без названий и текста записей. enabled = false — письма нет, счётчик в рабочем месте остаётся",
  },
  profile_enabled: {
    en: "Work profile of an employee: people write in the workspace (or their agent writes from their words) their role, what they are working on now, what they know well, how to work with them and what to tell an agent; agents read the profile when they start working. The profile lives in the person's personal space and only the person and their agents see it; health, family, salary and assessments of people must not be written — such text is not saved. The administrator does not read profiles. Off — the profile is nowhere; profiles already written stay as records in the personal space",
    ru: "Рабочий профиль сотрудника: человек сам пишет в рабочем месте (или его агент с его слов) роль, чем занят сейчас, в чём разбирается, как с ним работать и что сказать агенту; агенты читают профиль в начале работы. Профиль лежит в личном пространстве человека, его видят только он и его агенты; о здоровье, семье, зарплате и оценках людей писать нельзя — такой текст не сохраняется. Администратор профили не читает. Выключено — профиля нет нигде, уже написанные остаются записями в личном пространстве",
  },
  profile: {
    en: "Limits of the work profile: max_tokens — the whole profile (200–4000 tokens), section_max_tokens — one section (50–1000, no more than the whole profile), focus_fresh_days — after how many days (1–365) the “Current focus” section counts as outdated: the agent asks the person about it instead of asserting it, and the workspace home page asks to update it. Longer than the limit — the section is not saved and the person is told the section and the numbers",
    ru: "Пределы рабочего профиля: max_tokens — весь профиль (200–4000 токенов), section_max_tokens — один раздел (50–1000, не больше всего профиля), focus_fresh_days — через сколько дней (1–365) раздел «Сейчас в работе» считается устаревшим: агент уточняет его у человека, а не утверждает, а на главной рабочего места появляется просьба обновить. Длиннее предела — раздел не сохраняется, человеку названы раздел и числа",
  },
  space_guide_enabled: {
    en: "The “How we work” guide of a space: a short note by the owner — where tasks live, where documents live, which sources are the main ones, a vocabulary, who is responsible for what and when the meetings are. Only a person writes it, in the workspace: the owner of a team or project, and the curators for “Company knowledge”; every change is saved as a new version. Members' agents find the guide as the first line of the space description and read it as data, not as instructions. If the space is open to agents, the guide passes the same check as records. The administrator does not read guides. Off — the guide is nowhere and guides already written stay as notes of the space; agents' proposals to guides wait until it is switched on: the owner does not see them, and whoever proposed one can withdraw it",
    ru: "Карта «Как мы работаем» у пространства: короткая записка владельца — где задачи, где документы, какие источники главные, словарь, кто за что и когда встречи. Пишет только человек в рабочем месте: владелец команды или проекта, у «Общих знаний компании» — кураторы; каждое изменение сохраняется новой версией. Агенты участников находят карту первой строкой описания пространства и читают её как данные, а не как указания. Если пространство открыто агентам, карта проходит ту же проверку, что и записи. Администратор карты не читает. Выключено — карты нет нигде, уже написанные остаются заметками пространства; предложения агентов к картам ждут включения: владелец их не видит, предложивший может отозвать своё",
  },
  space_guide: {
    en: "Limit of the “How we work” guide: max_tokens — the whole guide, 300–4000 tokens (1500 is about 6000 characters). Longer — the guide is not saved and the person is told the numbers: it is a place for short lines and links, knowledge belongs in notes",
    ru: "Предел карты «Как мы работаем»: max_tokens — вся карта, 300–4000 токенов (1500 — около 6000 знаков). Длиннее — карта не сохраняется, человеку названы числа: здесь место коротким строкам и ссылкам, а знания пишут заметками",
  },
  obo_read_consent: {
    en: "Reading “on behalf of” people: legacy — as before, a service with the read right needs no consent; consent — only on behalf of those who consented in the workspace; off — reading on behalf of people is off for everyone. Loosening it is a weakening: an alert in basic, a second signature in advanced",
    ru: "Чтение «от имени» людей: legacy — как раньше, сервису с правом чтения согласие не нужно; consent — только от имени тех, кто дал согласие в рабочем месте; off — чтение от имени выключено всем. Ослабление: в basic — тревога, в advanced — вторая подпись",
  },
  obo_read_consent_days: {
    en: "How many days a person's consent to reading on their behalf is valid (1–365)",
    ru: "Сколько дней действует согласие человека на чтение от его имени (1–365)",
  },
  obo_read_alert_people_day: {
    en: "Alert when a service read on behalf of more than this many different people in a day (1–10000)",
    ru: "Тревога, если сервис за сутки читал от имени большего числа разных людей (1–10000)",
  },
  https_port: {
    en: "HTTPS port of the gateway (1024–65535); 0 — off. Needs a key and a certificate in the service's key directory. Takes effect after the gateway restarts",
    ru: "Порт HTTPS шлюза (1024–65535); 0 — выключен. Нужны ключ и сертификат в каталоге ключей службы. Действует после перезапуска шлюза",
  },
});
