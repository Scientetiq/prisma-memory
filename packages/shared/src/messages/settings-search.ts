// Descriptions of the search.* settings (search ranking), as the settings listing shows them: the key of an entry is
// the settings key. Read through settingDescription (../setting-description.ts). The texts are literal: braces in
// them are examples of values, never parameters.
import { defineMessages } from "@memory/i18n";

export const M = defineMessages("shared.settings-search", {
  domains: {
    en: "Vocabulary of record topics: the processing model assigns topics from this list only, others are dropped",
    ru: "Словарь тем записей: модель обработки ставит темы только из этого списка, чужие отбрасываются",
  },
  boosts: {
    en: "Adjustments of the result order: with a reranker — multipliers of its scores, without one — only the order of records with equal scores; the values are starting points",
    ru: "Поправки порядка выдачи: с реранкером — множители к его оценкам, без реранкера — только порядок записей с равной оценкой; значения стартовые",
  },
  current_space_boost: {
    en: "Priority of the current space in search: from 1 to 3; 1 — off. Records of the space, documents placed in it and links to the project count. With a reranker the factor raises the score, without one it only breaks ties. The “latest” mode and access rights do not change",
    ru: "Приоритет текущего пространства в поиске: от 1 до 3; 1 — выключен. Учитываются записи пространства, размещённые в нём документы и связи с проектом. С реранкером коэффициент повышает оценку, без него только разрешает ничьи. Режим «последние» и права доступа не меняются",
  },
  max_per_parent: {
    en: "At most this many chunks of one record (with its derived records) among the reranker's candidates: a meeting does not crowd out documents",
    ru: "Не больше стольких фрагментов одной записи (с её производными) среди кандидатов реранкера: встреча не вытесняет документы",
  },
  org_unreviewed_factor: {
    en: "Score multiplier of “Company knowledge” records marked “not confirmed” (0.1 to 1; 1 — off): with a reranker it applies to the score, without one it only breaks ties. Records confirmed by a curator or by the community get no multiplier",
    ru: "Множитель оценки записей «Общих знаний компании» с пометкой «не подтверждено» (от 0.1 до 1; 1 — выключен): с реранкером — к оценке, без реранкера только разводит ничьи. Подтверждённые куратором или сообществом — без множителя",
  },
  derivation_order_enabled: {
    en: "Put an agent's retellings in search right after the record they are based on: when the source is not on the page it is added before the retelling (only records the person sees anyway under the same search conditions), and the retelling is slightly lowered. Off — the result order stays as it was; the “Based on” mark is always shown. The “latest” mode does not change",
    ru: "Пересказы агента в поиске ставить сразу после записи, на которой они основаны: если источника нет на странице, он добавляется перед пересказом (только записи, которые человек и так видит при тех же условиях поиска), а пересказ немного понижается. Выключено — порядок выдачи прежний; пометка «Основано на» показывается всегда. Режим «последние» не меняется",
  },
  derivation_factor: {
    en: "How much an agent's retelling is lowered in search when search.derivation_order_enabled is on: 0.1 to 1; 1 — not lowered. With a reranker it applies to the score, without one it only breaks ties",
    ru: "Насколько понижать пересказ агента в поиске, когда включена настройка «Пересказы в поиске — сразу после источника»: от 0.1 до 1; 1 — без понижения. С реранкером — к оценке, без реранкера только разводит ничьи",
  },
});
