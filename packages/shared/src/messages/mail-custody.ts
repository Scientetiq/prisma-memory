// Mail to the custodian of a former employee's personal records (kind custody): "handed over to you" and "handed over
// to someone else". Rendered by renderMail (../mail-render.ts).
import { defineMessages } from "@memory/i18n";

export const M = defineMessages("shared.mail-custody", {
  handedSubject: { en: "Records of a former employee have been handed over to you: {name}", ru: "Вам переданы записи сотрудника: {name}" },
  handedIntro: {
    en: "{name} no longer works at the company. Their personal records have been handed over to you for safekeeping: {basis}.",
    ru: "{name} больше не работает в компании. Личные записи этого сотрудника переданы вам на хранение: {basis}.",
  },
  basisManager: { en: "you are their manager in the org chart", ru: "вы руководитель по орг-таблице" },
  basisDepartmentHead: { en: "you are the head of their department", ru: "вы руководитель подразделения" },
  basisAdmin: { en: "the {product} administrator decided so", ru: "так решил администратор памяти" },
  handedView: { en: "View them: {where}", ru: "Посмотреть: {where}" },
  handedPlace: { en: "in the workspace, section “Handed over to me”", ru: "в рабочем месте, раздел «Переданные мне»" },
  handedMeetings: {
    en: "Meetings that had other participants are now yours, and you are their organizer: {meetings}. Their participants and your agents see them like any other meeting of yours.",
    ru: "Встречи, где были другие участники, теперь ваши — вы их организатор: {meetings}. Их видят участники и ваши агенты, как любые ваши встречи.",
  },
  handedOnlyYou: {
    en: "Only you can see the employee's personal records, and only in the workspace; your agents cannot see them.",
    ru: "Личные записи сотрудника видите только вы, в рабочем месте; ваши агенты их не видят.",
  },
  handedWrongPerson: {
    en: "If someone else should hold these records, contact your {product} administrator.",
    ru: "Если записи должны быть у другого человека, напишите администратору памяти.",
  },
  offSubject: { en: "Records of {name} have been handed over to another custodian", ru: "Записи сотрудника {name} переданы другому хранителю" },
  offText: {
    en: "The {product} administrator has handed the safekeeping of {name}'s personal records over to someone else. Meetings that have already passed to you stay with you.",
    ru: "Администратор памяти передал хранение личных записей {name} другому человеку. Встречи, которые уже перешли к вам, остаются у вас.",
  },
});
