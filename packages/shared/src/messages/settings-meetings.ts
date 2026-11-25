// Descriptions of the meetings.* settings (meetings and consent), as the settings listing shows them: the key of an entry is
// the settings key. Read through settingDescription (../setting-description.ts). The texts are literal: braces in
// them are examples of values, never parameters.
import { defineMessages } from "@memory/i18n";

export const M = defineMessages("shared.settings-meetings", {
  consent_version: {
    en: "Version of the participants' consent text: a meeting is accepted only with consent.version equal to this. Change it together with the text — the previous version stops being accepted. v0 — a draft until your legal and HR teams approve the text",
    ru: "Версия текста согласия участников встречи: приём встречи требует consent.version, равную этой. Меняйте вместе с текстом — прежняя версия перестаёт приниматься. v0 — черновик до согласования с юристами и HR",
  },
  consent_text: {
    en: "Consent text the sender of a meeting confirms with a tick (a transcription service, an agent, a script); an agent sees it in the 400 answer and at GET /api/v1/meetings/consent",
    ru: "Текст согласия, который отправитель встречи подтверждает галочкой (транскрибатор, агент, скрипт); его видит агент в ответе 400 и в GET /api/v1/meetings/consent",
  },
  upload_ticket_ttl_sec: {
    en: "For how many seconds a one-time meeting upload link works (POST /api/v1/meetings/uploads, the memory_meeting_upload tool): after that the link does not accept a file (404) and the agent asks for a new one",
    ru: "Сколько секунд действует одноразовая ссылка загрузки встречи (POST /api/v1/meetings/uploads, инструмент memory_meeting_upload): после срока ссылка не принимает файл (404), агент просит новую",
  },
  upload_max_mb: {
    en: "Largest transcript through a one-time link, MB (1–50): applies to links issued after saving; larger — 413, and the link is not used up",
    ru: "Наибольший размер стенограммы по одноразовой ссылке, МБ (1–50): действует для ссылок, выданных после сохранения; больше — 413, ссылка при этом не тратится",
  },
  notify_participants: {
    en: "E-mail to participants about a meeting: a new meeting — to the recognised participants except the organiser; the organiser added a person — to that person. Title, date, organiser and a link, without the text of the meeting. Sent only when mail is on (smtp.enabled)",
    ru: "Письмо участникам о встрече: новая встреча — распознанным участникам, кроме организатора; организатор добавил человека — ему. Название, дата, организатор и ссылка, без текста встречи. Уходит только при включённой почте (smtp.enabled)",
  },
});
