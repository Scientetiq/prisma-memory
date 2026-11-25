import type { Messages } from "../../i18n/core";
import type * as en from "./en";
import type { AdminField, AdminFieldKind, AdminFormGroup } from "../../lib/admin-form";
const A = (key: string, kind: AdminFieldKind, hint?: string, placeholder?: string): AdminField => ({ category: "admin", key, kind, hint, placeholder });

export const ADMIN_FORM_TEXT: Messages<typeof en.ADMIN_FORM_TEXT> = {
    approvalPendingText: "Изменение ждёт второй подписи: его подтвердит другой администратор или аудитор ИБ",
};

export const ADMIN_FORM_GROUPS: Messages<typeof en.ADMIN_FORM_GROUPS> = [
    { title: "Вход", hint: "Вход администраторов через провайдера единого входа (OpenID Connect) и откуда открывается панель. Значения закрепляются якорями.", fields: [
            A("sso_login_enabled", "bool", "Включать после настройки клиента и проверки «Готовности»: до этого администраторы входят как раньше."),
            A("oidc_client_id", "text", "В basic можно клиент рабочего места memory: ИТ добавляют ему один точный адрес возврата панели. В advanced — отдельный клиент memory-admin."),
            A("oidc_client_secret", "secret", "Секрет того же клиента (в basic — как у рабочего места). Хранится зашифрованным; в журнал попадает только отпечаток."),
            A("oidc_redirect_uri", "text", "Точный адрес https://<имя панели>/admin/login/callback — такой же, как у клиента у провайдера единого входа (в basic — без порта и без «*»); http — только localhost стенда.", "https://admin.example.test/admin/login/callback"),
            A("ad_admin_group", "text", "Необязательно: DN или имя группы; вход — только её членам с ролью администратора."),
            A("oidc_username_form", "enum", "Как провайдер единого входа передаёт имя: короткое имя, полный UPN с доменом или любое из двух. Имя без домена с UPN не сверяется."),
            A("networks", "lines", "По одной сети CIDR на строке, не шире /16 (IPv4) и /48 (IPv6). Пусто — сеть не проверяется.", "198.51.100.0/24"),
        ] },
    { title: "Ключи WebAuthn", hint: "Аппаратные ключи администраторов: вход и подпись опасных действий касанием.", fields: [
            A("webauthn_rp_id", "text", "Имя хоста панели без схемы и порта; на стенде — localhost.", "admin.example.test"),
            A("webauthn_origins", "lines", "Точные источники панели https://имя[:порт], по одному на строке; на стенде — http://localhost:18083."),
            A("webauthn_uv", "enum", "«Обязательна» — ключ спрашивает PIN или отпечаток при каждом касании."),
            A("webauthn_required", "bool", "Включается после того, как у каждого администратора есть ключи («Готовность»)."),
            A("webauthn_min_keys", "number", "1–5: столько ключей должно быть у администратора, чтобы потеря одного не закрыла вход."),
            A("stepup_max_min", "number", "1–15 минут: опасное действие просит коснуться ключа, если последнее касание старше."),
            A("webauthn_aaguids", "lines", "Режим advanced: модели ключей, привязанных к устройству (AAGUID), по одной на строке. Пусто — привязку подтверждает человек в «Готовности».", "00000000-0000-0000-0000-000000000000"),
        ] },
    { title: "Сессии", hint: "Сессия администратора привязана к адресу браузера; срок и простой не продлеваются.", fields: [
            A("session_max_min", "number", "15–480 минут от входа; в режиме advanced — не больше 60."),
            A("session_idle_min", "number", "5–120 минут без действий — выход; в режиме advanced — не больше 15."),
            A("tool_sessions", "bool", "Короткие сессии для скриптов на самой ВМ, только прямо на сокет админ-слушателя."),
            A("tool_session_max_min", "number", "5–60 минут, не дольше сессии, из которой выдана."),
        ] },
    { title: "Режим безопасности", hint: "basic — действия исполняются сразу, ослабления поднимают тревогу; advanced — вторые подписи и ключи. Режим меняется только кнопкой «Включить advanced» в «Готовности» и возвратом по заявке двух людей.", fields: [
            { category: "security", key: "mode", kind: "enum", hint: "Только для чтения: в настройках режим не меняется." },
            { category: "security", key: "downgrade_delay_hours", kind: "number", hint: "24–168 часов от подписи до исполнения возврата в basic." },
        ] },
    { title: "Вторая подпись", hint: "В режиме advanced опасные действия ждут подписи другого администратора или аудитора ИБ; в basic исполняются сразу.", fields: [
            A("second_signature", "enum", "Определяется режимом безопасности: в basic подписи нет, в advanced — всегда."),
            A("second_signature_ttl_hours", "number", "1–72 часа: неподписанная заявка истекает."),
        ] },
    { title: "Старое и аварийное", hint: "Прежние способы входа и аварийный доступ. Включение advanced ставит здесь строгие значения.", fields: [
            A("system_key_admin", "bool", "Выключить — системный ключ перестаёт открывать админ-API (обслуживание — сессией или CLI на ВМ)."),
            A("local_login", "enum", "Закрыть вход admin@local можно, когда работают вход через провайдера единого входа и аварийный доступ."),
            A("local_totp_required", "bool", "Can be turned on once every local administrator has set up an authenticator app (Readiness: local_admin_factor)."),
            A("auditor_key_access", "bool", "Аудитор ИБ читает журнал, отчёт и «Качество поиска» личным ключом агента."),
            A("service_keys_by_fingerprint", "bool", "Панель не выдаёт сервисам секрет: ключ сервиса — только по отпечатку открытого ключа."),
            A("breakglass_max_hours", "number", "1–2 часа: окно аварийного доступа закрывается само."),
            A("bastion_cidrs", "lines", "По одной сети CIDR на строке: аварийный доступ открывается только с бастиона."),
        ] },
    { title: "Оповещения", hint: "Письма-тревоги о входах, ключах, якорях и аварийном доступе.", fields: [
            A("alert_recipients", "lines", "Адреса почты, по одному на строке.", "ops@example.test"),
            A("alert_digest_hour", "number", "0–23: средние тревоги приходят одной сводкой раз в сутки в этот час."),
        ] },
    { title: "Что видит администратор", fields: [
            A("audit_show_personal_titles", "bool", "Показывать в журнале названия личных записей людей."),
            A("search_quality_query_texts", "bool", "Показывать в «Качестве поиска» тексты частых пустых запросов."),
        ] },
    { title: "Чтение от имени людей", hint: "Сервисы с правом чтения от имени человека.", fields: [
            { category: "access", key: "obo_read_consent", kind: "enum", hint: "«Только с согласия» — человек даёт согласие в рабочем месте на срок ниже." },
            { category: "access", key: "obo_read_consent_days", kind: "number", hint: "1–365 дней." },
            { category: "access", key: "obo_read_alert_people_day", kind: "number", hint: "Тревога, если сервис за сутки читал от имени большего числа людей." },
        ] },
    { title: "Отправка журнала наружу", hint: "Копия журнала аудита во внешнее хранилище (SIEM).", fields: [
            { category: "observability", key: "audit_ship_mode", kind: "enum" },
            { category: "observability", key: "audit_ship_target", kind: "json", hint: "{\"file_dir\": \"/путь\"} — файлы (стенд); {\"host\", \"port\", \"ca_cert\", \"tls_server_name\"} — syslog по TLS." },
            { category: "observability", key: "audit_ship_batch", kind: "number", hint: "50–5000 событий за раз." },
            { category: "observability", key: "audit_ship_interval_sec", kind: "number", hint: "5–300 секунд." },
            { category: "observability", key: "audit_ship_lag_sec", kind: "number", hint: "30–900 секунд: отправка отстала сильнее — тревога." },
        ] },
];

export const TEXT: Messages<typeof en.TEXT> = {
  openRequest: "Открыть заявку",
  signBy: (value1: string | number | null | undefined, value2: string | number | null | undefined): string => `Срок подписи — до ${value1} (${value2})`,
  request: (value1: string | number | null | undefined): string => `Заявка: ${value1}`,
};
