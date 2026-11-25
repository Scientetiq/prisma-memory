// Descriptions of the admin.* settings (the admin panel and its sign-in), as the settings listing shows them: the key of an entry is
// the settings key. Read through settingDescription (../setting-description.ts). The texts are literal: braces in
// them are examples of values, never parameters.
import { defineMessages } from "@memory/i18n";

export const M = defineMessages("shared.settings-admin", {
  sso_login_enabled: {
    en: "Sign-in of administrators to the panel through the identity provider (OpenID Connect), with the account checked against the directory and the role. Off — the panel sign-in stays as before (admin@local). Switching it off is a weakening: an alert in basic, a second signature in advanced",
    ru: "Вход администраторов в панель через провайдера единого входа (OpenID Connect) со сверкой учётной записи с каталогом и ролью. Выключено — вход в панель прежний (admin@local). Выключение — ослабление: в basic — тревога, в advanced — вторая подпись",
  },
  oidc_client_id: {
    en: "OIDC client for the admin panel: in basic it may be the workspace client (with a separate exact redirect address of the panel and the same secret); in advanced — a separate client for the panel",
    ru: "OIDC-клиент для панели администратора: в basic можно клиент рабочего места (с отдельным точным адресом возврата панели и тем же секретом); в advanced — отдельный клиент для панели",
  },
  oidc_client_secret: {
    en: "Secret of the panel's OIDC client (stored encrypted)",
    ru: "Секрет OIDC-клиента панели (хранится зашифрованным)",
  },
  oidc_redirect_uri: {
    en: "Redirect address of the panel after sign-in through the provider: the https address of the page /admin/login/callback (on a test installation — http://localhost)",
    ru: "Адрес возврата панели после входа через провайдера единого входа: https-адрес страницы /admin/login/callback (на стенде — http://localhost)",
  },
  ad_admin_group: {
    en: "Directory group without which an administrator does not sign in (optional): a DN or a group name. Empty — only the role and the link to the person card are checked",
    ru: "Группа каталога, без которой администратор не входит (необязательно): DN или имя группы. Пусто — проверяются только роль и связь с карточкой",
  },
  oidc_username_form: {
    en: "In which form the provider passes the administrator's name (preferred_username): any — the short name or the full UPN with the domain, either one; account — the short name only (sAMAccountName); upn — the full UPN only. A name without a domain is never matched against a UPN",
    ru: "В какой форме провайдер единого входа передаёт имя администратора (preferred_username): any — короткое имя или полный UPN с доменом, любое из двух; account — только короткое имя (sAMAccountName); upn — только полный UPN. Имя без домена с UPN не сверяется никогда",
  },
  networks: {
    en: "Networks the panel opens from (CIDR, up to 20, no wider than /16 for IPv4 and /48 for IPv6). Empty — any network (as before)",
    ru: "Сети, из которых открывается панель (CIDR, до 20, не шире /16 для IPv4 и /48 для IPv6). Пусто — любая сеть (как раньше)",
  },
  webauthn_rp_id: {
    en: "Name of the panel for WebAuthn keys (RP ID) — the panel's host name without the port",
    ru: "Имя панели для ключей WebAuthn (RP ID) — имя хоста панели без порта",
  },
  webauthn_origins: {
    en: "Exact origins of the panel for WebAuthn keys (https://name[:port]); on a test installation — http://localhost:18083",
    ru: "Точные источники панели для ключей WebAuthn (https://имя[:порт]); на стенде — http://localhost:18083",
  },
  webauthn_uv: {
    en: "User verification on the key (a PIN or a fingerprint): required — mandatory, preferred — when possible",
    ru: "Проверка пользователя на ключе (PIN или отпечаток): required — обязательна, preferred — по возможности",
  },
  webauthn_required: {
    en: "A WebAuthn key is mandatory for the sign-in of every administrator. Switches on only when “Readiness” is passed (everyone has keys, emergency access is set up). An administrator with a registered key signs in with it even when the flag is off",
    ru: "Ключ WebAuthn обязателен для входа всем администраторам. Включается только при пройденной «Готовности» (ключи у всех, аварийный доступ настроен). Администратор с зарегистрированным ключом входит с ним и при выключенном флаге",
  },
  webauthn_min_keys: {
    en: "How many keys every administrator must have (1–5): a main one and a spare",
    ru: "Сколько ключей должно быть у каждого администратора (1–5): основной и запасной",
  },
  stepup_max_min: {
    en: "For how many minutes a key touch counts as fresh for signing someone else's request, deleting one's own key and a tool session (1–15)",
    ru: "Сколько минут касание ключа считается свежим для подписи чужой заявки, удаления своего ключа и сессии инструмента (1–15)",
  },
  session_max_min: {
    en: "How many minutes an administrator session lives from sign-in (15–480). In advanced mode — at most 60",
    ru: "Сколько минут живёт сессия администратора от входа (15–480). В режиме advanced — не больше 60",
  },
  session_idle_min: {
    en: "After how many minutes without actions an administrator session ends (5–120). In advanced mode — at most 15",
    ru: "Через сколько минут без действий сессия администратора завершается (5–120). В режиме advanced — не больше 15",
  },
  tool_sessions: {
    en: "Sessions for tools on the server itself: an administrator issues a short session to a script. Off — none are issued",
    ru: "Сессии для инструментов на самой ВМ: администратор выдаёт короткую сессию скрипту. Выключено — не выдаются",
  },
  tool_session_max_min: {
    en: "How many minutes a tool session lives (5–60)",
    ru: "Сколько минут живёт сессия инструмента (5–60)",
  },
  second_signature: {
    en: "The second signature is decided by the security mode (security.mode): in basic there is none — actions take effect at once, the audit log notes that a signature would have been needed, and weakenings of the external perimeter raise an alert; in advanced it is always on. The value itself is not read in basic",
    ru: "Вторая подпись определяется режимом безопасности (security.mode): в basic её нет — действия исполняются сразу, в журнале отмечается, что подпись была бы нужна, ослабления внешнего контура поднимают тревогу; в advanced она включена всегда. Само значение в basic не читается",
  },
  second_signature_ttl_hours: {
    en: "How many hours a request for a second signature waits for a decision (1–72)",
    ru: "Сколько часов заявка на вторую подпись ждёт решения (1–72)",
  },
  system_key_admin: {
    en: "The system key opens the admin API (as before). Off — any system key is refused with an alert; maintenance goes through an administrator session or the CLI on the server",
    ru: "Системный ключ открывает админ-API (как раньше). Выключено — любой системный ключ получает отказ и тревогу; обслуживание — сессией администратора или CLI на ВМ",
  },
  local_login: {
    en: "Sign-in as admin@local: open — as before; breakglass — only while an emergency access window is open; off — closed",
    ru: "Вход admin@local: open — как раньше; breakglass — только при открытом окне аварийного доступа; off — закрыт",
  },
  auditor_key_access: {
    en: "The security auditor reads the audit log, the report and “Search quality” with a personal agent key (as before). Off — only with a session in the panel",
    ru: "Аудитор ИБ читает журнал, отчёт и «Качество поиска» личным ключом агента (как раньше). Выключено — только сессией в панели",
  },
  service_keys_by_fingerprint: {
    en: "Service keys by fingerprint only: the service's operator creates the secret on their side and the panel never sees it. Always so for “on behalf of” services",
    ru: "Ключи сервисов — только по отпечатку: секрет создаёт оператор сервиса у себя, панель его не видит. Для сервисов «от имени» — всегда",
  },
  breakglass_max_hours: {
    en: "How many hours an emergency access window stays open (1–2)",
    ru: "Сколько часов открыто окно аварийного доступа (1–2)",
  },
  bastion_cidrs: {
    en: "Addresses of the bastion from which emergency access is opened (CIDR, up to 10). Empty — emergency access cannot be opened",
    ru: "Адреса бастиона, с которого открывается аварийный доступ (CIDR, до 10). Пусто — аварийный доступ не открывается",
  },
  alert_recipients: {
    en: "Who receives alert e-mails for administrators (up to 10 addresses). Empty — no e-mails are sent and alerts are visible in the panel only (the administrator's address smtp.admin_email is not a fallback)",
    ru: "Кому письма-тревоги администраторам (до 10 адресов). Пусто — письма не уходят, тревоги видны только в панели (почта администратора памяти, smtp.admin_email, запасным адресом не служит)",
  },
  alert_digest_hour: {
    en: "At which hour (0–23) the daily digest of medium alerts arrives",
    ru: "В каком часу (0–23) приходит ежедневная сводка средних тревог",
  },
  audit_show_personal_titles: {
    en: "Show the administrator the titles of personal records in the audit log. Off — titles of personal records are hidden",
    ru: "Показывать администратору названия личных записей в журнале. Выключено — названия личных записей скрыты",
  },
  search_quality_query_texts: {
    en: "Show the administrator the texts of frequent empty searches in “Search quality” (texts without people, and only when enough different people asked)",
    ru: "Показывать администратору тексты частых пустых поисков в «Качестве поиска» (тексты — без людей, только при достаточном числе разных людей)",
  },
  webauthn_aaguids: {
    en: "Models of the administrators' device-bound keys (AAGUIDs of the form 00000000-0000-0000-0000-000000000000, up to 50). Only a hint in “Readiness” for advanced: the key itself reports the AAGUID, a person confirms that it is device-bound",
    ru: "Модели ключей администраторов, привязанных к устройству (AAGUID вида 00000000-0000-0000-0000-000000000000, до 50). Только подсказка в «Готовности» к advanced: AAGUID сообщает сам ключ, привязку к устройству подтверждает человек",
  },
  alert_work_hours: {
    en: "Working hours for “daytime only” alerts: weekdays from–to, with an optional time zone tz (otherwise the installation's zone). Outside the window such alerts wait for it to start",
    ru: "Рабочее время для тревог «только днём»: по будням с — по, пояс tz. Вне окна такие тревоги ждут его начала",
  },
  alert_cooldown_min: {
    en: "Pause between repeated e-mails about the same alert, minutes (5–1440)",
    ru: "Пауза между повторными письмами об одной и той же тревоге, минут (5–1440)",
  },
});
