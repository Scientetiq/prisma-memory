// Mails about a request to delete a meeting (kind meeting_delete): to the organizer, to the administrator, and the
// decision "kept" to the person who asked. Rendered by renderMail (../mail-render.ts).
import { defineMessages, plural } from "@memory/i18n";

export const M = defineMessages("shared.mail-meetings", {
  untitled: { en: "meeting", ru: "встреча" },
  recordLine: { en: "Record: {id}. There is no need to reply to this message.", ru: "Запись: {id}. Отвечать на это письмо не нужно." },
  meetingPlace: { en: "The meeting is in the workspace, section “Meetings with me”.", ru: "Встреча — в рабочем месте, раздел «Встречи со мной»." },

  ownerSubject: { en: "{product}: request to delete the meeting “{title}”", ru: "Память: просьба удалить встречу «{title}»" },
  ownerAsks: {
    en: "{who} ({login}), a participant of your meeting “{title}” of {date}, asks you to delete it.",
    ru: "{who} ({login}) — участник вашей встречи «{title}» от {date} — просит её удалить.",
  },
  ownerWho: {
    en: plural({
      one: "The meeting can be deleted by its organizer (you) or by the {product} administrator: the meeting, with its summary and events, goes to the trash for {count} day.",
      other: "The meeting can be deleted by its organizer (you) or by the {product} administrator: the meeting, with its summary and events, goes to the trash for {count} days.",
    }),
    ru: "Удалить может организатор встречи — вы — или администратор памяти: встреча с резюме и событиями уйдёт в корзину на {count} дн.",
  },
  ownerOpen: { en: "Open the meeting: {url}", ru: "Открыть встречу: {url}" },
  ownerNotThere: {
    en: "If this person was not at the meeting, remove them from the participants (“Remove {who} from participants”, in the same place): the meeting stays.",
    ru: "Если человека на встрече не было — уберите его из участников («Убрать {who} из участников» там же): встреча останется.",
  },
  ownerKeep: {
    en: "If the meeting should be kept, use “Keep the meeting” in the same place: the administrator will then decide.",
    ru: "Если встречу нужно сохранить — там же «Оставить встречу»: решение тогда примет администратор.",
  },

  adminSubject: { en: "{product}: request to delete a meeting", ru: "Память: просьба удалить встречу" },
  adminAsks: {
    en: "A meeting participant ({login}) asks to delete the meeting of {date} organized by {owner}.",
    ru: "Участник встречи ({login}) просит удалить встречу организатора {owner} от {date}.",
  },
  adminWho: {
    en: plural({
      one: "The organizer or an administrator deletes it; it goes to the trash for {count} day.",
      other: "The organizer or an administrator deletes it; it goes to the trash for {count} days.",
    }),
    ru: "Удаляют организатор встречи или администратор — в корзину на {count} дн.",
  },
  adminPanel: { en: "Deletion requests in the admin panel: {url}", ru: "Просьбы удалить в панели: {url}" },
  adminPanelPlace: { en: "Deletion requests are in the admin panel, section “Deletion requests”.", ru: "Просьбы удалить — в панели, раздел «Просьбы удалить»." },

  keptSubject: { en: "{product}: decision on your request to delete a meeting", ru: "Память: решение по вашей просьбе удалить встречу" },
  kept: {
    en: "The {product} administrator has reviewed your request to delete the meeting and kept it.",
    ru: "Администратор памяти рассмотрел вашу просьбу удалить встречу и оставил её в памяти.",
  },
  keptDated: {
    en: "The {product} administrator has reviewed your request to delete the meeting of {date} and kept it.",
    ru: "Администратор памяти рассмотрел вашу просьбу удалить встречу от {date} и оставил её в памяти.",
  },
  keptLink: { en: "Meeting: {url}", ru: "Встреча: {url}" },
  keptQuestions: {
    en: "If you still have questions, contact your {product} administrator. You cannot ask to delete this meeting again.",
    ru: "Если вопрос остался — обратитесь к администратору памяти. Попросить удалить эту встречу ещё раз нельзя.",
  },
});
