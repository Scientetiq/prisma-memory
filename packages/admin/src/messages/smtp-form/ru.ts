import { productName } from "../../i18n/brand";
import type { Messages } from "../../i18n/core";
import type * as en from "./en";
import type { LdapField } from "../../lib/ldap-form";

export const SMTP_GROUPS: Messages<typeof en.SMTP_GROUPS> = [
    { title: "Сервер", fields: [
            { key: "host", category: "smtp", kind: "text", label: "Почтовый сервер", placeholder: "mail.example.com", hint: "Имя или IPv4-адрес, без схемы и порта." },
            { key: "port", category: "smtp", kind: "number", label: "Порт", hint: "587 — STARTTLS, 465 — TLS с первого байта, 25 — без шифрования." },
            { key: "security", category: "smtp", kind: "smtp_security", label: "Шифрование", hint: "STARTTLS — переход на TLS поверх 587; TLS — с первого байта, 465. Сертификат сервера проверяется всегда." },
            { key: "insecure_ack", category: "smtp", kind: "bool", label: "Понимаю: без шифрования логин, пароль и письма идут по сети открытым текстом" },
            { key: "ca_cert", category: "smtp", kind: "multiline", label: "Корневой сертификат сервера (PEM)", placeholder: "-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----",
                hint: "Нужен, если сертификат почтового сервера выпущен внутренним CA. Пусто — доверие системному списку сервера памяти." },
            { key: "timeout_sec", category: "smtp", kind: "number", label: "Тайм-аут, с", hint: "1–120: соединение и каждый ответ сервера." },
        ] },
    { title: "Учётная запись отправителя", hint: "Пустой логин — сервер принимает письма без входа (ретрансляция по адресу сервера памяти).", fields: [
            { key: "username", category: "smtp", kind: "text", label: "Логин", placeholder: "memory@example.com" },
            { key: "password", category: "smtp", kind: "secret", label: "Пароль" },
        ] },
    { title: "Письма", fields: [
            { key: "from_address", category: "smtp", kind: "text", label: "Адрес отправителя", placeholder: "memory@example.com" },
            { key: "from_name", category: "smtp", kind: "text", label: "Имя отправителя", get placeholder() { return `${productName()}`; } },
            { key: "workplace_url", category: "access", kind: "text", label: "Адрес рабочего места для ссылок", placeholder: "https://memory.example.com",
                hint: "Из писем и ответов агентам ведут ссылки в рабочее место. Пусто — письма называют раздел без ссылки." },
            { key: "admin_email", category: "smtp", kind: "text", label: "Почта администратора для уведомлений", placeholder: "admin@example.com",
                hint: "Сюда — сбои и отчёты памяти. Пусто — уведомления только в панели." },
        ] },
    { title: "Очередь", hint: "Письма уходят через очередь: временный сбой — повтор с паузой вдвое больше (не больше часа), после последней попытки — статус «ошибка» с причиной.", fields: [
            { key: "max_attempts", category: "smtp", kind: "number", label: "Попыток на письмо", hint: "1–20." },
            { key: "retry_base_sec", category: "smtp", kind: "number", label: "Первая пауза перед повтором, с", hint: "1–3600." },
            { key: "keep_days", category: "smtp", kind: "number", label: "Хранить журнал писем, дней", hint: "1–365: отправленные и брошенные письма, затем строки удаляются." },
        ] },
];

export const SMTP_ENABLED: Messages<typeof en.SMTP_ENABLED> = { key: "enabled", category: "smtp", kind: "bool", label: "Отправка писем включена",
    hint: "Выключено — письма ждут в очереди. Включается, когда заданы сервер и адрес отправителя. Тестовое письмо работает и при выключенной отправке." };

export const MAIL_KIND_TITLES: Messages<typeof en.MAIL_KIND_TITLES> = {
    test: "тестовое",
    approval: "заявка на согласование",
    meeting_delete: "просьба удалить встречу",
    curator_digest: "недельный список куратору",
    meeting_new: "новая встреча участникам",
    custody: "передача записей ушедшего сотрудника",
};

export const MAIL_STATUS_TITLES: Messages<typeof en.MAIL_STATUS_TITLES> = {
    pending: "ждёт",
    sending: "отправляется",
    sent: "отправлено",
    failed: "ошибка",
    cancelled: "отменено",
};

export const SMTP_ERROR_TITLES: Messages<typeof en.SMTP_ERROR_TITLES> = {
    smtp_not_configured: "почта не настроена",
    smtp_dns_failed: "имя сервера не разрешается",
    smtp_unreachable: "сервер недоступен",
    smtp_timeout: "сервер не ответил",
    smtp_tls_failed: "шифрование или сертификат",
    smtp_auth_failed: "сервер отверг логин",
    smtp_rejected: "сервер отказал",
    smtp_temporary: "временный отказ",
    smtp_interrupted: "отправка прервалась",
    smtp_failed: "письмо не отправлено",
    participant_removed: "человека убрали из встречи",
    recipient_not_participant: "получатель не участник встречи",
    recipient_check_failed: "не удалось проверить получателя",
    custody_not_current: "хранение уже не такое, как в письме",
};

export const TEXT: Messages<typeof en.TEXT> = {
  unencryptedDelivery: "работы без шифрования",
  portNormallyUsesButTLSFromThe: (value1: string | number | null | undefined, value2: string | number | null | undefined): string => `Порт ${value1} обычно для ${value2}, а выбран TLS с первого байта — тестовое письмо может висеть до тайм-аута. Для TLS обычно 465.`,
  noEncryption: "без шифрования",
  portNormallyExpectsTLSFromTheFirst: (value1: string | number | null | undefined): string => `Порт 465 обычно ждёт TLS с первого байта, а выбрано «${value1}» — тестовое письмо может висеть до тайм-аута. Для STARTTLS обычно 587, без шифрования — 25.`,
  aLoginIsSetWithoutAPassword: "логин задан без пароля — задайте пароль или очистите логин (отправка без входа)",
  aSenderAddressIsRequired: "нужен адрес отправителя — от него уходят письма",
  aServerIsRequiredMailExampleCom: "нужен сервер (mail.example.com)",
  mailLogRetentionMustBeDays: "срок хранения журнала писем — 1–365 дней",
  retryDelayMustBeSeconds: "пауза перед повтором — 1–3600 секунд",
  attemptsMustBe: "попыток — 1–20",
  timeoutMustBeSeconds: "тайм-аут — 1–120 секунд",
  administratorEmailMustBeAnEmailAddress: "почта администратора — адрес почты",
  senderNameMustBeOneLineAt: "имя отправителя — одной строкой до 100 знаков, без кавычек и угловых скобок",
  senderAddressMustBeAnEmailAddress: "адрес отправителя — почта (memory@example.com)",
  loginMustBeOneLineAtMost: "логин — одной строкой до 254 знаков",
  theRootCertificateCouldNotBeParsed: "корневой сертификат не разбирается: нет блока -----BEGIN CERTIFICATE-----",
  withoutEncryptionMailLoginAndPasswordTravel: "без шифрования письма, логин и пароль идут по сети открытым текстом — отметьте «понимаю риск» или выберите STARTTLS",
  encryptionMustBeSTARTTLSTLSOrNo: "шифрование — STARTTLS, TLS или без шифрования",
  portMustBeForSTARTTLSForTLS: "порт — 1–65535 (587 — STARTTLS, 465 — TLS)",
  serverMustBeAHostNameMail: "сервер — имя (mail.example.com) или IPv4-адрес, без схемы и порта",
};
