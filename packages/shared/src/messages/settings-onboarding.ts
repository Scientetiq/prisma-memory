// Descriptions of the onboarding.* settings (space descriptions and overviews), as the settings listing shows them: the key of an entry is
// the settings key. Read through settingDescription (../setting-description.ts). The texts are literal: braces in
// them are examples of values, never parameters.
import { defineMessages } from "@memory/i18n";

export const M = defineMessages("shared.settings-onboarding", {
  readme_templates_enabled: {
    en: "Space description from a template: when a project is created, and in its settings, there is a field “About this space” with ready sections — what the team or project is, what to record here and what not, where tasks and documents live. An empty description is highlighted for the owner; the description of “Company knowledge” is kept by the curators. Members' agents read this description first when they work with the space. Off — the field is nowhere; agents still see descriptions already written",
    ru: "Описание пространства по шаблону: при создании проекта и в его настройках есть поле «Подробнее о пространстве» с готовыми разделами — что это за команда или проект, что сюда записывать и чего не записывать, где задачи и документы. Владельцу пустое описание подсвечивается, описание «Общих знаний компании» ведут кураторы. Агенты участников читают это описание первым, когда работают с пространством. Выключено — поля нет нигде, уже написанные описания агенты по-прежнему видят",
  },
  space_overview_enabled: {
    en: "Space overview on the “Overview” tab of a project or team: latest decisions, open questions and risks, deadlines of this week, workstreams and deals with their record counts, and what is new this week. Everyone sees the overview within their own rights: lines and numbers cover only records they can read, each line has a link to the record and a date. The overview does not count as a search. Off — no overview",
    ru: "Обзор пространства на вкладке «Обзор» проекта или команды: последние решения, открытые вопросы и риски, сроки на этой неделе, направления и сделки с числом записей и что нового за неделю. Каждый видит обзор в своих правах: строки и числа — только по записям, которые он сам может прочитать, у каждой строки — ссылка на запись и дата. Поиском обзор не считается. Выключено — обзора нет",
  },
  addable_enabled: {
    en: "Can be added: on the “Overview” tab of a project or team a person sees their own meetings of the last 90 days where more than half of the participants belong to this project or team, ticks the ones needed and moves them. Before the move the memory shows the exact list, and exactly that list is moved. People see only their own meetings: those they organised. Meetings whose readers were restricted by the meeting service are not offered. Meeting participants keep their access, the class of the meeting does not change. The list does not count as a search. Off — the block is absent",
    ru: "Можно добавить: на вкладке «Обзор» проекта или команды человек видит свои встречи за 90 дней, где больше половины участников — из этого проекта или команды, отмечает нужные и переносит их. Перед переносом память показывает точный список, переносится ровно он. Видят только свои встречи: организатор — сам человек. Встречи, у которых круг читателей ограничил сервис встреч, не предлагаются. Участники встречи доступ сохраняют, класс встречи не меняется. Поиском список не считается. Выключено — блока нет",
  },
});
