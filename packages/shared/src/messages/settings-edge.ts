// Descriptions of the edge.* settings (the external perimeter (edge)), as the settings listing shows them: the key of an entry is
// the settings key. Read through settingDescription (../setting-description.ts). The texts are literal: braces in
// them are examples of values, never parameters.
import { defineMessages } from "@memory/i18n";

export const M = defineMessages("shared.settings-edge", {
  export_enabled: {
    en: "Send open records to the edge (the read-only external perimeter). An administrator switches it on with a personal session (in advanced — with a second signature), and only when the exporter is running and the perimeter gates are passed",
    ru: "Отправлять открытые записи на ребро (внешний контур только для чтения). Включает администратор личной сессией (в advanced — со второй подписью) и только при работающем экспортёре и пройденных воротах контура",
  },
  deadman_theta_sec: {
    en: "After how many seconds without contact with the memory the edge stops serving data (60–600, within the anchors)",
    ru: "Через сколько секунд без связи с памятью ребро перестаёт выдавать данные (60–600, в пределах якорей)",
  },
  revoke_lag_warn_sec: {
    en: "Warn when revoking a record from the edge is delayed by more than this many seconds (5–300)",
    ru: "Предупреждать, если отзыв записи с ребра задерживается дольше стольких секунд (5–300)",
  },
  revoke_lag_alarm_sec: {
    en: "Alert when revoking a record from the edge is delayed by more than this many seconds (30–900)",
    ru: "Тревога, если отзыв записи с ребра задерживается дольше стольких секунд (30–900)",
  },
  reconcile_light_min: {
    en: "How often the copy on the edge is reconciled with the memory, minutes (5–60)",
    ru: "Как часто сверять копию на ребре с памятью, минут (5–60)",
  },
  reconcile_full_hour: {
    en: "Hour of the nightly full reconciliation of the edge (0–23, server time)",
    ru: "Час ночной полной сверки ребра (0–23, по времени сервера)",
  },
  projection_refresh_sec: {
    en: "How often people's rights on the edge are fully refreshed, seconds (60–3600); a narrowing of rights is sent at once",
    ru: "Как часто полностью обновлять права людей на ребре, секунд (60–3600); сужение прав уходит сразу",
  },
  originals_max_mib: {
    en: "Largest original file that goes to the edge, MiB (1–20); larger files are available from inside only",
    ru: "Самый большой файл-оригинал, который уходит на ребро, МиБ (1–20); файлы больше доступны только изнутри",
  },
  max_concurrent_per_connection: {
    en: "How many requests at once the edge accepts from one agent connection (1–8)",
    ru: "Сколько запросов одновременно ребро принимает от одного подключения агента (1–8)",
  },
  connection_expiry_warn_days: {
    en: "How many days before a connection expires the edge warns the person (1–14)",
    ru: "За сколько дней до конца срока подключения ребро предупреждает человека (1–14)",
  },
  bridge_url: {
    en: "Address of the bridge for the exporter, the receiver and the reconciler (https://…); empty — the bridge is not set up. Pinned in the anchors of the inner perimeter",
    ru: "Адрес моста для экспортёра, приёмника и сверщика (https://…); пусто — мост не настроен. Закреплён в якорях внутреннего контура",
  },
  ldap_require_ldaps: {
    en: "LDAPS only for checking passwords of sign-ins from outside: the check service accepts neither StartTLS nor an unencrypted connection. Off by default in basic: the channel is as set in “Sign-in and LDAP”, with a warning; in advanced it must be on. Switching it off in advanced needs a second signature",
    ru: "Только LDAPS для проверки паролей входа извне: StartTLS и вход без шифрования служба проверки не принимает. В basic по умолчанию выключено: канал — как настроен «Вход и LDAP», с предупреждением; в advanced обязательно включено. Выключение в advanced — со второй подписью",
  },
  quota_mode: {
    en: "Daily quotas of connections from outside: observe — only note calls above the quota (a “would have been refused” event in the summary and in the quota report on the “Alerts” page); enforce — refuse them with a text that names the reset time. In basic one administrator or agent switches it: refusals start at once, the return to observe is immediate and raises a high alert; in advanced the return to observe needs a second signature. Open sign-in from outside beyond a pilot only with enforce",
    ru: "Суточные квоты подключений извне: observe — только отмечать вызовы сверх квоты (событие «было бы отказано» в сводке и в отчёте квот на странице «Оповещения»); enforce — отказывать в них текстом со сроком сброса. В basic переключает один администратор или агент: отказы — сразу, возврат к observe — сразу и с высокой тревогой; в advanced возврат к observe — со второй подписью. Шире пилота вход извне открывают только с enforce",
  },
  quota_daily: {
    en: "Daily quotas of one person from outside — for all their connections together: searches, reads, lists, volume of text served (in tokens, characters / 4), original files and their MiB, write requests and their MiB. The day follows the zone tz. In basic one administrator or agent changes them (at once, with a high alert); in advanced a change needs a second signature",
    ru: "Суточные квоты одного человека извне — на все его подключения вместе: поисков, чтений, списков, объёма выданного текста (в токенах, знаков / 4), файлов-оригиналов и их МиБ, заявок на запись и их МиБ. Сутки — по поясу tz. В basic меняет один администратор или агент (сразу, с высокой тревогой); в advanced изменение — со второй подписью",
  },
  max_new_connections_alert_day: {
    en: "Alert when a person gets more than this many new connections from outside in a day (1–100)",
    ru: "Тревога, если у человека за сутки появилось больше стольких новых подключений извне (1–100)",
  },
  geo_alert_enabled: {
    en: "Alert when a connection from outside comes from a new country or provider network; without a country database — when the /16 network changes. This is an alert, not a ban",
    ru: "Тревога, когда подключение извне приходит из новой страны или сети провайдера; без базы стран — при смене сети /16. Это тревога, а не запрет",
  },
  probe_enabled: {
    en: "Probe of the external address: a service inside checks on a schedule, from the outside, that the edge answers and serves nothing extra. Switches on only when the probe service runs as a system service or in a container",
    ru: "Зонд внешнего адреса: служба внутри по расписанию проверяет снаружи, что ребро отвечает и не выдаёт лишнего. Включается, только когда служба зонда работает системной службой или в контейнере",
  },
  probe_base_url: {
    en: "External address of the edge for the probe (https://…). The synthetic sign-in sends the password and the code of a service account there, so the probe goes only to the edge host named in the anchors. Changing the address needs a second signature in advanced, one signature with a high alert in basic; empty — the probe goes nowhere",
    ru: "Внешний адрес ребра для зонда (https://…). Синтетический вход шлёт туда пароль и код служебной учётной записи, поэтому зонд ходит только на узел ребра из якорей. Смена адреса — в advanced со второй подписью, в basic одной подписью с высокой тревогой; пусто — зонд никуда не ходит",
  },
  probe_connect_addr: {
    en: "External listener of the shared proxy for the probe: address and port, an IP or a name. The probe connects here, sends the edge host name in SNI and Host and verifies the certificate against it: DNS on the memory server need not change, and a wrong address gets a TLS refusal, not the password. Outside a test installation — neither an internal address nor the address of a trusted proxy (access.trusted_proxies). Empty — the shared proxy has no external address: the probe is off, and outside checks run from an external machine",
    ru: "Внешний слушатель общего прокси для зонда: адрес и порт, IP или имя. Зонд подключается сюда, а имя узла ребра передаёт в SNI и Host и сверяет сертификат по нему: DNS на ВМ памяти менять не нужно, чужой адрес получит отказ TLS, а не пароль. Вне стенда — не внутренний адрес и не адрес доверенного прокси (access.trusted_proxies). Пусто — внешнего адреса у общего прокси нет: зонд выключен, пробы снаружи — с внешней машины",
  },
  probe_inner_hosts: {
    en: "Names that must not be served by the external listener of the shared proxy: internal names of the memory, the panel, the employee sign-in and other services (up to 20). The probe sends requests with these names in SNI and Host to the external address and expects the proxy's 404 with a marker, or a TLS refusal; one more name is a random one in the edge domain. Empty — the random name only",
    ru: "Имена, которых не должно быть на внешнем слушателе общего прокси: внутренние имена памяти, панели, входа сотрудников и других служб (до 20). Зонд шлёт на внешний адрес запросы с этими именами в SNI и Host и ждёт 404 прокси с маркером или отказ TLS; ещё одно имя — случайное в домене ребра. Пусто — только случайное имя",
  },
  probe_interval_min: {
    en: "How often the probe checks the external address, minutes (1–60)",
    ru: "Как часто зонд проверяет внешний адрес, минут (1–60)",
  },
  synthetic_login_enabled: {
    en: "Synthetic sign-in: the probe service signs in from outside with a service account and checks the whole sign-in path. The password and the code secret are in the service's key directory, not in the settings",
    ru: "Синтетический вход: служба зонда входит извне служебной учётной записью и проверяет весь путь входа. Пароль и секрет кода — в каталоге ключей службы, не в настройках",
  },
  synthetic_login_account: {
    en: "Service account of the synthetic sign-in (an e-mail address or a login); empty — no synthetic sign-in. A change needs a second signature in advanced, one signature with a high alert in basic",
    ru: "Служебная учётная запись синтетического входа (почта или логин); пусто — синтетический вход не идёт. Смена — в advanced со второй подписью, в basic одной подписью с высокой тревогой",
  },
  synthetic_login_interval_min: {
    en: "How often the synthetic sign-in runs, minutes (15–1440)",
    ru: "Как часто синтетический вход, минут (15–1440)",
  },
  geoip_db_path: {
    en: "File of the country and provider network database on the server (a full path); empty — the alert goes by a change of the /16 network",
    ru: "Файл базы стран и сетей провайдеров на сервере (полный путь); пусто — тревога по смене сети /16",
  },
  login_enabled: {
    en: "Sign-in to the memory from the internet for those who switched “External access” on for themselves: the edge sign-in page checks the password in the directory through the check service inside. Off — no new sign-ins from outside; connections already issued work until they expire or are revoked. Switching it on needs a second signature",
    ru: "Вход в память из интернета для тех, кто сам включил себе «Доступ извне»: страница входа ребра проверяет пароль в каталоге через службу проверки внутри. Выключено — новых входов извне нет, выданные подключения работают до срока или отзыва. Включение — со второй подписью",
  },
  login_groups: {
    en: "Directory groups whose members may switch on “External access”: a DN or a group name, up to 50. Empty — nobody",
    ru: "Группы каталога, участникам которых можно включить «Доступ извне»: DN или имя группы, до 50. Пусто — никому",
  },
  deny_groups: {
    en: "Directory groups for which sign-in from outside is forbidden even if the person is in an allowed group: a DN or a name, up to 50",
    ru: "Группы каталога, которым вход извне запрещён, даже если человек есть в разрешённой группе: DN или имя, до 50",
  },
  deny_admin_count: {
    en: "Forbid sign-in from outside to accounts with the adminCount flag (privileged directory accounts)",
    ru: "Запретить вход извне учётным записям с признаком adminCount (привилегированные учётные записи каталога)",
  },
  decoy_guids: {
    en: "Decoy accounts (objectGUID, up to 10): any attempt to sign in with them from outside raises an alert, the password is not checked",
    ru: "Учётные записи-ловушки (objectGUID, до 10): любая попытка войти ими извне — тревога, пароль не проверяется",
  },
  login_domain: {
    en: "E-mail domain for a short login on the outside sign-in page: the person types the login without “@” and the memory appends “@domain”. Empty — the full e-mail address only",
    ru: "Домен почты для короткого логина на странице входа извне: человек вводит логин без «@», память дописывает «@домен». Пусто — только полный адрес почты",
  },
  optin_fresh_login_min: {
    en: "“External access” can be switched on only after a fresh sign-in to the workspace: no more than this many minutes ago (1–60)",
    ru: "Включить «Доступ извне» можно только после свежего входа в рабочее место: не раньше стольких минут назад (1–60)",
  },
  optin_idle_days: {
    en: "After how many days without a sign-in from outside “External access” switches itself off (14–365); an e-mail comes 7 days before",
    ru: "Через сколько дней без входа извне «Доступ извне» выключается сам (14–365); за 7 дней до этого — письмо",
  },
  optin_first_confirm: {
    en: "The first switching on of “External access”: from the office network or with a confirmation by support (office_or_support), or without this step (none)",
    ru: "Первое включение «Доступа извне»: из сети офиса или с подтверждением поддержкой (office_or_support) либо без этого шага (none)",
  },
  office_networks: {
    en: "Office networks (not VPN) from which the first switching on of “External access” passes without support: up to 50 networks, no wider than /16 for IPv4 and /48 for IPv6. Empty — through support only",
    ru: "Сети офиса (не VPN), из которых первое включение «Доступа извне» проходит без поддержки: до 50 сетей, не шире /16 для IPv4 и /48 для IPv6. Пусто — только через поддержку",
  },
  ad_lockout_threshold: {
    en: "Account lockout threshold of the directory (the number of wrong passwords). -1 — unknown: passwords from outside are not checked at all; 0 — no lockout; 1–999 — the threshold",
    ru: "Порог блокировки учётной записи в каталоге (число неверных паролей). -1 — неизвестен: пароли извне не проверяются вовсе; 0 — блокировки нет; 1–999 — порог",
  },
  ad_lockout_window_min: {
    en: "Window of the directory's bad-password counter, minutes (1–1440). -1 — unknown: passwords from outside are not checked",
    ru: "Окно счётчика неверных паролей каталога, минут (1–1440). -1 — неизвестно: пароли извне не проверяются",
  },
  ad_pdc: {
    en: "Primary domain controller (the PDC emulator): one of the addresses of ldap.servers (“Sign-in and LDAP”), by the same name or IP; the service touches no other address, and without a match passwords from outside are not checked. The bad-password counter is read from it. Empty — passwords from outside are not checked (pdc_unset); with the field empty the directory sweep goes through the controllers of “Sign-in and LDAP”",
    ru: "Главный контроллер домена (PDC-эмулятор): один из адресов ldap.servers («Вход и LDAP»), тем же именем или IP; другой адрес служба не трогает, пароли извне не проверяются. Счётчик неверных паролей читается с него. Пусто — пароли извне не проверяются (pdc_unset); обход каталога при пустом поле идёт по контроллерам из «Вход и LDAP»",
  },
  ad_state_max_age_hours: {
    en: "Maximum age of the directory's data about a person, hours (1–72): if it is older, the edge neither extends connections nor issues new ones",
    ru: "Предельный возраст сведений каталога о человеке, часов (1–72): старше — ребро не продлевает подключения и не выдаёт новые",
  },
  ad_sweep_min: {
    en: "How often everyone with “External access” on is checked against the directory, minutes (1–60): for those disabled or removed from the groups it is switched off",
    ru: "Как часто сверять с каталогом всех, у кого включён «Доступ извне», минут (1–60): выключенных и вышедших из групп — выключить",
  },
  ad_pso_visible: {
    en: "Your IT team confirmed that the directory service account can see password policies (PSOs) and their values. On — “no PSO visible for the person” means “no PSO assigned”; off — an invisible PSO remains possible, and sign-in from outside treats that as a risk",
    ru: "ИТ подтвердили, что служебной учётной записи каталога видны политики паролей (PSO) и их значения. Включено — «PSO у человека не видно» значит «PSO не назначена»; выключено — невидимая PSO остаётся возможной, и вход извне считает это риском",
  },
  badpwd_reserve_min: {
    en: "How many wrong passwords before the directory lockout are always left to the person for signing in from inside (2–10)",
    ru: "Сколько неверных паролей до блокировки в каталоге всегда оставлять человеку для входа изнутри (2–10)",
  },
  password_failures_per_window: {
    en: "Wrong passwords from outside per account within the window — at most (1–3)",
    ru: "Неверных паролей извне на учётную запись за окно — не больше (1–3)",
  },
  password_window_min: {
    en: "Window for counting wrong passwords from outside, minutes (15–1440); no shorter than the directory's window",
    ru: "Окно счёта неверных паролей извне, минут (15–1440); не короче окна каталога",
  },
  password_failures_per_day: {
    en: "Wrong passwords from outside per account in a day — at most (1–20); after that sign-in from outside is suspended for the account until the end of the day",
    ru: "Неверных паролей извне на учётную запись за сутки — не больше (1–20); дальше вход извне для неё приостановлен до конца суток",
  },
  global_binds_per_min: {
    en: "Password checks in the directory from outside sign-ins per minute for the whole memory (5–600)",
    ru: "Проверок пароля в каталоге со входа извне за минуту на всю память (5–600)",
  },
  spray_alert_accounts_10min: {
    en: "“Password spraying” alert: failed sign-ins from outside for this many different accounts within 10 minutes (1–10000)",
    ru: "Тревога «перебор паролей по многим людям»: неудачные входы извне по стольким разным учётным записям за 10 минут (1–10000)",
  },
  spray_pause_accounts_10min: {
    en: "Automatic pause of sign-in from outside: failed sign-ins for this many different accounts within 10 minutes (1–10000, no less than the alert threshold)",
    ru: "Автопауза входа извне: неудачные входы по стольким разным учётным записям за 10 минут (1–10000, не меньше порога тревоги)",
  },
  spray_auto_pause: {
    en: "Suspend sign-in from outside for 15 minutes when failed sign-ins for different people exceed the automatic pause threshold",
    ru: "Приостанавливать вход извне на 15 минут, когда неудачных входов по разным людям больше порога автопаузы",
  },
  login_step_floor_ms: {
    en: "Shortest answer time of an outside sign-in step, ms (500–10000): a right and a wrong password take equally long to answer",
    ru: "Наименьшее время ответа шага входа извне, мс (500–10000): верный и неверный пароль отвечают одинаково долго",
  },
  login_check_timeout_sec: {
    en: "How long the outside sign-in page waits for the password check, seconds (2–20); longer — “try again later”",
    ru: "Сколько странице входа извне ждать проверки пароля, секунд (2–20); дольше — «попробуйте позже»",
  },
  check_unhealthy_queue: {
    en: "How many sign-in checks may wait in the queue (10–200); above that, sign-in from outside temporarily answers “try again later”",
    ru: "Сколько проверок входа может ждать в очереди (10–200); больше — вход извне временно отвечает «попробуйте позже»",
  },
  login_ip_limits: {
    en: "Limits of the outside sign-in page by address and login: failures per 15 minutes, sign-ins per hour, sign-in steps per 15 minutes, token exchanges and authorisation requests per minute (1–10000); nat_multiplier — how many times higher the limits are for the company's shared addresses (1–100)",
    ru: "Пределы страницы входа извне по адресу и логину: неудач за 15 минут, входов за час, шагов входа за 15 минут, обменов токена и запросов авторизации в минуту (1–10000); nat_multiplier — во сколько раз выше пределы для общих адресов компании (1–100)",
  },
  nat_cidrs: {
    en: "Shared addresses of the company on the internet (NAT), up to 50 networks no wider than /16 for IPv4 and /48 for IPv6: for them the per-address limits are nat_multiplier times higher",
    ru: "Общие адреса компании в интернете (NAT), до 50 сетей не шире /16 для IPv4 и /48 для IPv6: для них пределы по адресу выше в nat_multiplier раз",
  },
  mfa_mode: {
    en: "Second factor at sign-in from outside: off — not asked, optional — for those who set it up, required — for everyone. No lower than the limit in the anchors",
    ru: "Второй фактор при входе извне: off — не спрашивается, optional — у кого настроен, required — у всех. Не ниже предела из якорей",
  },
  access_token_min: {
    en: "Lifetime of the access token of an outside connection, minutes (5–60)",
    ru: "Срок токена доступа подключения извне, минут (5–60)",
  },
  connection_idle_days: {
    en: "An outside connection expires after this many days without use (1–30)",
    ru: "Подключение извне гаснет после стольких дней без использования (1–30)",
  },
  connection_max_days: {
    en: "Maximum lifetime of an outside connection, days (1–30): after that the program is connected again",
    ru: "Предельный срок подключения извне, дней (1–30): потом программу подключают заново",
  },
  max_active_connections: {
    en: "Outside connections per person (1–20): an extra one pushes out the oldest",
    ru: "Подключений извне у одного человека (1–20): лишнее вытесняет самое старое",
  },
  login_session_hours: {
    en: "Outside sign-in session with a second factor, hours (1–24)",
    ru: "Сессия входа извне со вторым фактором, часов (1–24)",
  },
  login_session_hours_no_mfa: {
    en: "Outside sign-in session without a second factor, hours (1–12)",
    ru: "Сессия входа извне без второго фактора, часов (1–12)",
  },
  grant_ttl_min: {
    en: "Lifetime of a connection grant from consent to the issue of the token, minutes (1–30)",
    ru: "Срок разрешения на подключение от согласия до выдачи токена, минут (1–30)",
  },
  refresh_reuse_grace_sec: {
    en: "Window in which a repeated use of a connection's refresh token is accepted without consequences, seconds (0–60)",
    ru: "Окно, в которое повтор ключа обновления подключения принимается без последствий, секунд (0–60)",
  },
  refresh_reuse_action: {
    en: "What to do when a refresh token is reused outside the window: revoke_connection — disconnect the connection; reject_only — only refuse and warn the person",
    ru: "Что делать при повторе ключа обновления вне окна: revoke_connection — отключить подключение; reject_only — только отказать и предупредить человека",
  },
  account_page_enabled: {
    en: "The “My connections” page on the edge: people see and disconnect their outside connections without entering the company network",
    ru: "Страница «Мои подключения» на ребре: человек видит и отключает свои подключения извне, не заходя в сеть компании",
  },
  disabled_clients: {
    en: "Disabled programs (client_id from the anchors): their outside connections are revoked and new ones are not issued",
    ru: "Выключенные программы (client_id из якорей): их подключения извне отзываются, новые не выдаются",
  },
  mfa_provider: {
    en: "Kind of the second factor: totp — an authenticator app with codes on the phone. A change needs a second signature",
    ru: "Вид второго фактора: totp — приложение с кодами на телефоне. Смена — со второй подписью",
  },
  mfa_required_grace_days: {
    en: "When the second factor becomes mandatory, connections without it keep working for this many days (0–60), then a new sign-in with a code is needed. Raising it needs a second signature",
    ru: "Когда второй фактор становится обязательным, подключения без него работают ещё столько дней (0–60), потом нужен новый вход с кодом. Увеличение — со второй подписью",
  },
  code_failures_per_window: {
    en: "Wrong second-factor codes per person within the window — at most (1–20); after that sign-in by code is locked. Raising it needs a second signature",
    ru: "Неверных кодов второго фактора у человека за окно — не больше (1–20); дальше вход по коду заперт. Увеличение — со второй подписью",
  },
  code_failures_per_day: {
    en: "Wrong second-factor codes per person in a day — at most (5–100). Raising it needs a second signature",
    ru: "Неверных кодов второго фактора у человека за сутки — не больше (5–100). Увеличение — со второй подписью",
  },
  code_failures_window_min: {
    en: "Window for counting wrong codes, minutes (5–120). Lowering it needs a second signature",
    ru: "Окно счёта неверных кодов, минут (5–120). Уменьшение — со второй подписью",
  },
  code_lock_min: {
    en: "For how long sign-in by code is locked after wrong codes, minutes (15–1440); the person gets an e-mail. Lowering it needs a second signature",
    ru: "На сколько запирать вход по коду после неверных кодов, минут (15–1440); человеку уходит письмо. Уменьшение — со второй подписью",
  },
  mfa_fresh_login_min: {
    en: "The second factor can be set up or replaced only after a fresh sign-in to the workspace: no more than this many minutes ago (2–60). Raising it needs a second signature",
    ru: "Настроить или заменить второй фактор можно только после свежего входа в рабочее место: не раньше стольких минут назад (2–60). Увеличение — со второй подписью",
  },
  mfa_pending_ttl_min: {
    en: "How long to wait for the first code when the second factor is set up, minutes (5–60); after that the set-up starts again. Raising it needs a second signature",
    ru: "Сколько ждать первого кода при настройке второго фактора, минут (5–60); потом настройку начинают заново. Увеличение — со второй подписью",
  },
  mfa_issuer_label: {
    en: "Name shown in the authenticator app (1–40 characters, no colon)",
    ru: "Название в приложении для кодов (1–40 знаков, без двоеточия)",
  },
  recovery_low_threshold: {
    en: "Remind the person when this many recovery codes or fewer are left (0–5; 0 — no reminder)",
    ru: "Напоминать человеку, когда кодов восстановления осталось не больше стольких (0–5; 0 — не напоминать)",
  },
});
