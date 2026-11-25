// Weekly mail to the curators of the company knowledge space (kind curator_digest): numbers and a link only. Rendered by
// renderMail (../mail-render.ts).
import { defineMessages } from "@memory/i18n";

export const M = defineMessages("shared.mail-digest", {
  subject: { en: "{product}: waiting for review in “Company knowledge” — {waiting}", ru: "Память: на проверке в «Общих знаниях компании» — {waiting}" },
  waiting: {
    en: "Waiting for review in “Company knowledge”: {waiting} (new this week: {newWeek}).",
    ru: "На проверке в «Общих знаниях компании»: {waiting} (новых за неделю: {newWeek}).",
  },
  held: {
    en: "Marked “Wrong / not for everyone” and hidden from AI agents until you decide: {held}.",
    ru: "Отмечены «Неверно / не для всех» и скрыты от ИИ-агентов до вашего решения: {held}.",
  },
  due: {
    en: "Will be returned automatically within the next 7 days unless confirmed: {dueWeek}.",
    ru: "Вернутся сами в ближайшие 7 дней, если не подтвердить: {dueWeek}.",
  },
  oldest: { en: "The oldest one has been waiting since {day}.", ru: "Самая давняя ждёт с {day}." },
  list: {
    en: "The list ({limit} per page; buttons “Confirm”, “Return”, “Delete”): {url}",
    ru: "Список (по {limit} на странице, кнопки «Подтвердить», «Вернуть», «Удалить»): {url}",
  },
  listPlace: {
    en: "The list is in the {product} workspace, section “Company knowledge review” ({limit} per page).",
    ru: "Список — в рабочем месте памяти, раздел «Проверка общих знаний» (по {limit} на странице).",
  },
  note: {
    en: "Any curator acts for all of them. This message contains no record titles or text: they are in the workspace. There is no need to reply.",
    ru: "Любой куратор действует за всех. Названий и текста записей в письме нет — они в рабочем месте. Отвечать на письмо не нужно.",
  },
});
