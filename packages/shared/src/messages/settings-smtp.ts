// Descriptions of the smtp.* settings (outgoing mail), as the settings listing shows them: the key of an entry is
// the settings key. Read through settingDescription (../setting-description.ts). The texts are literal: braces in
// them are examples of values, never parameters.
import { defineMessages } from "@memory/i18n";

export const M = defineMessages("shared.settings-smtp", {
  enabled: {
    en: "Sending of e-mails: approvals, requests to delete meetings, the curators' digest, a new meeting to its participants. Off — e-mails wait in the queue; the test message works even when sending is off",
    ru: "Отправка писем: согласования, заявки на удаление встреч, дайджест куратора, новая встреча участникам. Выключено — письма ждут в очереди; тестовое письмо работает и при выключенной отправке",
  },
  host: {
    en: "Mail server: a host name (mail.example.com) or an IPv4 address, without scheme or port",
    ru: "Почтовый сервер: имя (mail.example.com) или IPv4-адрес, без схемы и порта",
  },
  port: {
    en: "Port: 587 — STARTTLS, 465 — TLS from the first byte, 25 — no encryption",
    ru: "Порт: 587 — STARTTLS, 465 — TLS с первого байта, 25 — без шифрования",
  },
  security: {
    en: "Encryption: starttls (TLS over 587), tls (TLS from the first byte, 465) or none — the login and password travel in clear text (only together with insecure_ack)",
    ru: "Шифрование: starttls (TLS поверх 587), tls (TLS с первого байта, 465) или none — логин и пароль идут открытым текстом (только вместе с insecure_ack)",
  },
  insecure_ack: {
    en: "The administrator understands that without encryption the login, the password and the e-mails travel over the network in clear text. Without this mark the mode none is not saved",
    ru: "Администратор понимает, что без шифрования логин, пароль и письма идут по сети открытым текстом. Без этой отметки режим none не сохраняется",
  },
  ca_cert: {
    en: "Root certificate of the mail server (PEM, a chain is fine) when it is issued by an internal CA. Empty — the built-in root list of Node.js",
    ru: "Корневой сертификат почтового сервера (PEM, можно цепочкой), если он выпущен внутренним CA. Пусто — встроенный список корневых сертификатов Node.js",
  },
  username: {
    en: "Login of the sender account; empty — the server accepts mail without signing in (relay by address)",
    ru: "Логин учётной записи отправителя; пусто — сервер принимает без входа (ретрансляция по адресу)",
  },
  password: {
    en: "Password of the sender account: stored encrypted, never returned to the panel",
    ru: "Пароль учётной записи отправителя: хранится зашифрованным, в панель не возвращается",
  },
  from_address: {
    en: "Sender address, for example memory@example.com: every e-mail of the memory is sent from it",
    ru: "Адрес отправителя, например memory@example.com: от него уходят все письма памяти",
  },
  from_name: {
    en: "Sender name in e-mails",
    ru: "Имя отправителя в письмах",
  },
  admin_email: {
    en: "E-mail of the administrator for the memory's notifications (failures, reports); empty — notifications appear in the panel only",
    ru: "Почта администратора для уведомлений памяти (сбои, отчёты); пусто — уведомления только в панели",
  },
  timeout_sec: {
    en: "Timeout of the connection to the mail server and of its answer, seconds (1–120)",
    ru: "Тайм-аут соединения и ответа почтового сервера, секунд (1–120)",
  },
  max_attempts: {
    en: "Attempts to send one e-mail (1–20): after the last failure the e-mail gets the status “error” with the reason",
    ru: "Попыток отправки одного письма (1–20): после последней неудачи письмо получает статус «ошибка» с причиной",
  },
  retry_base_sec: {
    en: "Pause before a retry, seconds (1–3600): doubled with every attempt, at most an hour",
    ru: "Пауза перед повтором, секунд (1–3600): вдвое больше с каждой попыткой, не больше часа",
  },
  keep_days: {
    en: "How many days the queue keeps sent and abandoned e-mails (the “Mail” log), after which the rows are deleted (1–365)",
    ru: "Сколько дней очередь хранит отправленные и брошенные письма (журнал «Почта»), затем строки удаляются (1–365)",
  },
});
