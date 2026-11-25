import type { Messages } from "../../i18n/core";
import type * as en from "./en";
import type { EdgeGroup } from "../../lib/edge-form";
type Stage = "P0" | "1a" | "1b" | "1c" | "1d" | "1e" | "1f" | "S2-3" | "4" | "E2" | "5";

export const GROUPS_BY_STAGE: Messages<typeof en.GROUPS_BY_STAGE> = {

  P0: [],

  "1a": [],

  "1b": [
    { title: "Экспорт на ребро", hint: "Ребро — внешняя копия открытых записей только для чтения. Включение — личной сессией администратора (в advanced — со второй подписью) и только при работающем экспортёре и пройденных воротах контура.", fields: [
      { key: "export_enabled", kind: "bool", label: "Отправлять открытые записи на ребро", category: "edge" },
      { key: "bridge_url", kind: "text", label: "Адрес моста к ребру", placeholder: "https://bridge.example.test",
        hint: "Мост принимает копию и отзывы; адрес закреплён в якорях внутреннего контура. В basic — https://memory-relay:8445 (мост — служба на этой ВМ, адрес ставит выкладка), в advanced — адрес ВМ-моста.", category: "edge" },
      { key: "originals_max_mib", kind: "number", label: "Самый большой файл-оригинал на ребре, МиБ", hint: "1–20: файлы больше доступны только изнутри.", category: "edge" },
    ] },
    { title: "Свежесть и отзыв", hint: "Ребро перестаёт выдавать данные, если давно не было связи с памятью; отзыв записи должен доходить за секунды.", fields: [
      { key: "deadman_theta_sec", kind: "number", label: "Через сколько секунд без связи ребро перестаёт выдавать данные", hint: "60–600, в пределах якорей.", category: "edge" },
      { key: "revoke_lag_warn_sec", kind: "number", label: "Предупреждать, если отзыв задерживается дольше, с", hint: "5–300.", category: "edge" },
      { key: "revoke_lag_alarm_sec", kind: "number", label: "Тревога, если отзыв задерживается дольше, с", hint: "30–900.", category: "edge" },
    ] },
    { title: "Сверка и права", fields: [
      { key: "reconcile_light_min", kind: "number", label: "Как часто сверять ребро, мин", hint: "5–60.", category: "edge" },
      { key: "reconcile_full_hour", kind: "number", label: "Час ночной полной сверки", hint: "0–23, по времени сервера.", category: "edge" },
      { key: "projection_refresh_sec", kind: "number", label: "Как часто полностью обновлять права на ребре, с", hint: "60–3600; сужение прав уходит сразу.", category: "edge" },
    ] },
    { title: "Подключения агентов", fields: [
      { key: "max_concurrent_per_connection", kind: "number", label: "Одновременных запросов от одного подключения", hint: "1–8.", category: "edge" },
      { key: "connection_expiry_warn_days", kind: "number", label: "За сколько дней предупреждать о конце подключения", hint: "1–14.", category: "edge" },
    ] },
  ],

  "1c": [
    { title: "Канал к каталогу для входа извне", hint: "Пароли входа извне служба проверки несёт в каталог тем же каналом, что настроен в «Вход и LDAP». В basic можно и без шифрования (с отметкой «понимаю риск») или по StartTLS — ворота покажут предупреждение; в advanced — только LDAPS.", fields: [
      { category: "edge", key: "ldap_require_ldaps", kind: "bool", label: "Проверять пароли входа извне только по LDAPS", hint: "StartTLS и вход без шифрования не принимать. В basic по умолчанию выключено; в advanced обязательно, выключение там — со второй подписью. Пока вход извне открыт, менять — только личной сессией администратора." },
    ] },
  ],

  "1d": [
    { title: "Суточные квоты", hint: "Сколько один человек может сделать извне за сутки — на все его подключения и программы вместе. Сначала — только наблюдение: вызовы сверх квоты отмечаются, но проходят; кому было бы отказано, видно в отчёте квот на странице «Оповещения» и в утренней сводке. Включить отказы в basic может один администратор или агент; шире пилота вход извне открывают только с отказами. Возврат к наблюдению и любое изменение квот — в advanced со второй подписью, в basic сразу и с высокой тревогой.", fields: [
      { category: "edge", key: "quota_mode", kind: "text", label: "Режим квот", hint: "observe — «Наблюдение»: только отмечать; enforce — «Отказывать»: сверх квоты вызов получает отказ текстом: когда квота обновится и к кому обращаться." },
      { category: "edge", key: "quota_daily", kind: "json", label: "Квоты на человека за сутки",
        hint: "search, read, list — вызовов; text_tokens — объём выданного текста; originals и originals_mib — файлы и их МиБ; c2_items и c2_mib — заявки на запись и их МиБ; tz — пояс суток." },
    ] },
    { title: "Тревоги о подключениях", hint: "Тревога, а не запрет: подключение работает, администратор получает письмо.", fields: [
      { category: "edge", key: "max_new_connections_alert_day", kind: "number", label: "Новых подключений у человека за сутки — тревога, если больше", hint: "1–100." },
      { category: "edge", key: "geo_alert_enabled", kind: "bool", label: "Тревога о новой стране или сети провайдера" },
      { category: "edge", key: "geoip_db_path", kind: "text", label: "Файл базы стран и сетей", placeholder: "/var/lib/memory/geoip/country-asn.mmdb", hint: "Полный путь на сервере. Пусто — тревога по смене сети /16." },
    ] },
    { title: "Письма о тревогах", fields: [
      { category: "admin", key: "alert_work_hours", kind: "json", label: "Рабочее время для тревог «только днём»", hint: "weekdays — «09:00-19:00» по будням, tz — пояс." },
      { category: "admin", key: "alert_cooldown_min", kind: "number", label: "Пауза между повторами одной тревоги, минут", hint: "5–1440." },
    ] },
    { title: "Зонд и синтетический вход", hint: "Проверка снаружи, что ребро отвечает и вход работает. Включаются, только когда служба зонда работает системной службой или в контейнере.", fields: [
      { category: "edge", key: "probe_base_url", kind: "text", label: "Внешний адрес для зонда", placeholder: "https://memory-edge.example.test", hint: "Только https:// и только узел ребра из якорей: туда уходят пароль и код синтетического входа. Смена — в advanced со второй подписью, в basic сразу и с высокой тревогой. Пусто — зонд никуда не ходит." },
      { category: "edge", key: "probe_connect_addr", kind: "text", label: "Внешний слушатель общего прокси", placeholder: "203.0.113.10:443",
        hint: "Адрес и порт внешнего слушателя общего прокси. Имя узла ребра уходит в SNI и Host, сертификат сверяется по нему. Не внутренний адрес и не адрес доверенного прокси. Пусто — внешнего адреса у общего прокси нет, зонд выключен." },
      { category: "edge", key: "probe_inner_hosts", kind: "lines", label: "Внутренние имена для проверки внешнего адреса", placeholder: "memory.example.test",
        hint: "По одному на строку, до 20: имена памяти, панели, входа сотрудников и других служб. На внешнем адресе каждое должно получить 404 прокси или отказ TLS. Случайное имя в домене ребра зонд добавляет сам." },
      { category: "edge", key: "probe_interval_min", kind: "number", label: "Как часто зонд, минут", hint: "1–60." },
      { category: "edge", key: "synthetic_login_account", kind: "text", label: "Учётная запись синтетического входа", placeholder: "probe-login@example.test", hint: "Почта или логин служебной учётной записи; пароль и секрет кода — в каталоге ключей службы. Смена — в advanced со второй подписью, в basic сразу и с высокой тревогой." },
      { category: "edge", key: "synthetic_login_interval_min", kind: "number", label: "Как часто синтетический вход, минут", hint: "15–1440." },
      { category: "edge", key: "probe_enabled", kind: "bool", label: "Зонд внешнего адреса включён" },
      { category: "edge", key: "synthetic_login_enabled", kind: "bool", label: "Синтетический вход включён" },
    ] },
  ],

  "1e": [
    { title: "Кому можно включить «Доступ извне»", hint: "Включает сам человек в рабочем месте из сети компании. Пустой список групп — никому.", fields: [
      { category: "edge", key: "login_groups", kind: "lines", label: "Группы AD, которым можно включить доступ", placeholder: "CN=memory-external,OU=Groups,DC=example,DC=test",
        hint: "По одной на строке: DN или имя группы, до 50." },
      { category: "edge", key: "deny_groups", kind: "lines", label: "Группы, которым внешний вход запрещён", hint: "Запрет сильнее разрешения." },
      { category: "edge", key: "deny_admin_count", kind: "bool", label: "Запретить учётным записям с признаком adminCount" },
      { category: "edge", key: "optin_first_confirm", kind: "text", label: "Первое включение", hint: "office_or_support — из сети офиса или с подтверждением поддержкой; none — без подтверждения." },
      { category: "edge", key: "office_networks", kind: "lines", label: "Сети офиса (не VPN)", placeholder: "192.0.2.0/24", hint: "Не шире /16 для IPv4 и /48 для IPv6. Пусто — первое включение только через поддержку." },
      { category: "edge", key: "optin_fresh_login_min", kind: "number", label: "Свежесть входа для включения, минут", hint: "1–60." },
      { category: "edge", key: "optin_idle_days", kind: "number", label: "Доступ гаснет без входа извне через, дней", hint: "14–365; за 7 дней — письмо." },
    ] },
    { title: "Каталог и пароли", hint: "Пока порог блокировки AD неизвестен (−1), пароли извне не проверяются вовсе.", fields: [
      { category: "edge", key: "ad_lockout_threshold", kind: "number", label: "Порог блокировки AD", hint: "−1 — неизвестен; 0 — блокировки нет; 1–999." },
      { category: "edge", key: "ad_lockout_window_min", kind: "number", label: "Окно счётчика неверных паролей AD, минут", hint: "−1 — неизвестно; 1–1440." },
      { category: "edge", key: "ad_pdc", kind: "text", label: "Главный контроллер домена (PDC-эмулятор)", placeholder: "pdc.example.test", hint: "Счётчик неверных паролей читается с него. Запишите его так же, как один из контроллеров в «Вход и LDAP» (то же имя или тот же IP): к другому адресу служба не ходит, и пароли извне не проверяются. Пусто — тоже не проверяются; обход каталога идёт по контроллерам из «Вход и LDAP»." },
      { category: "edge", key: "login_domain", kind: "text", label: "Домен почты для короткого логина", placeholder: "example.test", hint: "Пусто — только полный адрес почты." },
      { category: "edge", key: "badpwd_reserve_min", kind: "number", label: "Запас попыток человеку для входа изнутри", hint: "2–10." },
      { category: "edge", key: "password_failures_per_window", kind: "number", label: "Неверных паролей извне за окно", hint: "1–3." },
      { category: "edge", key: "password_window_min", kind: "number", label: "Окно бюджета, минут", hint: "15–1440." },
      { category: "edge", key: "password_failures_per_day", kind: "number", label: "Неудач извне на учётную запись за сутки", hint: "1–20." },
      { category: "edge", key: "global_binds_per_min", kind: "number", label: "Проверок пароля в каталоге в минуту", hint: "5–600." },
      { category: "edge", key: "ad_sweep_min", kind: "number", label: "Обход каталога, минут", hint: "1–60." },
      { category: "edge", key: "ad_state_max_age_hours", kind: "number", label: "Предельный возраст сведений AD, часов", hint: "1–72." },
      { category: "edge", key: "ad_pso_visible", kind: "bool", label: "ИТ подтвердили: политики паролей (PSO) видны", hint: "Без подтверждения ИТ невидимая PSO остаётся риском. Включение ослабляет защиту от блокировки в каталоге — правила подписи те же, что у порога блокировки AD." },
      { category: "edge", key: "decoy_guids", kind: "lines", label: "Учётные записи-ловушки (objectGUID)", hint: "До 10; вход ими — тревога." },
    ] },
    { title: "Перебор паролей и пределы", fields: [
      { category: "edge", key: "spray_alert_accounts_10min", kind: "number", label: "Тревога: неудачи по разным людям за 10 минут" },
      { category: "edge", key: "spray_pause_accounts_10min", kind: "number", label: "Автопауза: неудачи по разным людям за 10 минут", hint: "Не меньше порога тревоги." },
      { category: "edge", key: "spray_auto_pause", kind: "bool", label: "Автоматическая пауза на 15 минут" },
      { category: "edge", key: "login_ip_limits", kind: "json", label: "Пределы по адресу и логину" },
      { category: "edge", key: "nat_cidrs", kind: "lines", label: "Общие адреса NAT компании", placeholder: "198.51.100.0/24", hint: "До 50 сетей, не шире /16 для IPv4 и /48 для IPv6; для них пределы по адресу выше." },
      { category: "edge", key: "login_step_floor_ms", kind: "number", label: "Наименьшее время ответа шага входа, мс", hint: "500–10000." },
      { category: "edge", key: "login_check_timeout_sec", kind: "number", label: "Ожидание проверки пароля, секунд", hint: "2–20." },
      { category: "edge", key: "check_unhealthy_queue", kind: "number", label: "Очередь проверок до «нездоров»", hint: "10–200." },
    ] },
    { title: "Подключения программ", fields: [
      { category: "edge", key: "mfa_mode", kind: "text", label: "Второй фактор", hint: "off — выключен, optional — по желанию, required — обязателен; не ниже границы из якорей ребра. Ослабление в basic — сразу (пока открыт вход извне — только в личной сессии), в advanced — со второй подписью. Перед «обязателен» посмотрите охват на странице «Второй фактор»." },
      { category: "edge", key: "access_token_min", kind: "number", label: "Срок токена доступа, минут", hint: "5–60." },
      { category: "edge", key: "connection_idle_days", kind: "number", label: "Подключение гаснет после простоя, дней", hint: "1–30." },
      { category: "edge", key: "connection_max_days", kind: "number", label: "Предельный срок подключения, дней", hint: "1–30." },
      { category: "edge", key: "max_active_connections", kind: "number", label: "Подключений на человека", hint: "1–20." },
      { category: "edge", key: "login_session_hours", kind: "number", label: "Сессия входа с фактором, часов", hint: "1–24." },
      { category: "edge", key: "login_session_hours_no_mfa", kind: "number", label: "Сессия входа без фактора, часов", hint: "1–12." },
      { category: "edge", key: "grant_ttl_min", kind: "number", label: "Срок разрешения до обмена кода, минут", hint: "1–30." },
      { category: "edge", key: "refresh_reuse_grace_sec", kind: "number", label: "Окно повторного обновления, секунд", hint: "0–60." },
      { category: "edge", key: "refresh_reuse_action", kind: "text", label: "При повторе ключа обновления", hint: "revoke_connection — отключить подключение; reject_only — только отказать." },
      { category: "edge", key: "account_page_enabled", kind: "bool", label: "Страница «Мои подключения» вне сети компании" },
      { category: "edge", key: "disabled_clients", kind: "lines", label: "Выключенные программы (client_id)" },
    ] },
    { title: "Внешний вход", hint: "Новые входы извне. Выданные подключения работают и при выключенном входе — до срока или отзыва.", fields: [
      { category: "edge", key: "login_enabled", kind: "bool", label: "Внешний вход включён" },
    ] },
  ],

  "1f": [
    { title: "Второй фактор", hint: "Сам режим («Второй фактор» в группе «Подключения программ») по умолчанию выключен. Ослабление режима и мер защиты — в advanced со второй подписью, в basic сразу и с высокой тревогой.", fields: [
      { category: "edge", key: "mfa_provider", kind: "text", label: "Вид второго фактора", hint: "totp — приложение с кодами на телефоне." },
      { category: "edge", key: "mfa_required_grace_days", kind: "number", label: "Льгота подключениям без фактора после «Обязателен», дней", hint: "0–60." },
      { category: "edge", key: "mfa_issuer_label", kind: "text", label: "Название в приложении для кодов", hint: "1–40 знаков, без двоеточия." },
      { category: "edge", key: "mfa_fresh_login_min", kind: "number", label: "Свежесть входа для настройки фактора, минут", hint: "2–60. Увеличение — в advanced со второй подписью, в basic сразу и с высокой тревогой." },
      { category: "edge", key: "mfa_pending_ttl_min", kind: "number", label: "Сколько ждать первого кода при настройке, минут", hint: "5–60. Увеличение — в advanced со второй подписью, в basic сразу и с высокой тревогой." },
      { category: "edge", key: "recovery_low_threshold", kind: "number", label: "Напоминать, когда кодов восстановления осталось не больше", hint: "0–5; 0 — не напоминать." },
    ] },
    { title: "Неверные коды", hint: "Сверх предела вход по коду запирается, человеку уходит письмо. Ослабление — больше неверных кодов, короче окно или запирание — в advanced со второй подписью, в basic сразу и с высокой тревогой.", fields: [
      { category: "edge", key: "code_failures_per_window", kind: "number", label: "Неверных кодов за окно — не больше", hint: "1–20." },
      { category: "edge", key: "code_failures_window_min", kind: "number", label: "Окно неверных кодов, минут", hint: "5–120." },
      { category: "edge", key: "code_failures_per_day", kind: "number", label: "Неверных кодов за сутки — не больше", hint: "5–100." },
      { category: "edge", key: "code_lock_min", kind: "number", label: "На сколько запирать вход по коду, минут", hint: "15–1440." },
    ] },
  ],

  "S2-3": [],

  "4": [],

  E2: [],

  "5": [],
};
