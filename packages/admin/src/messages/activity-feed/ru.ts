import { pluralRu } from "../../i18n/core";
import type { Messages } from "../../i18n/core";
import * as en from "./en";

export const text: Messages<typeof en.text> = {
  highlights: "Главное",
  agents: "Агенты",
  me: "Я",
  all: "Всё",
  records: "Записи",
  search: "Поиск",
  deletions: "Удаления",
  errors: "Ошибки",
  yourAgent: "Ваш агент",
  you: "Вы",
  onYourBehalf: "от вашего имени",
  administratorInViewAsMode: "Администратор в режиме «Смотреть как»",
  actorService: "Сервис",
  actorMemory: "Память",
  actorAdministrator: "Администратор",
  actorOrgCurator: "Куратор «Общих знаний компании»",
  actorColleague: "Коллега",
  actorMeetingParticipant: "Участник встречи",
  actorSpaceOwner: "Владелец пространства",
  actorSpaceMember: "Участник пространства",
  actorColleagueProposal: "Коллега (предложение)",
  and: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `${value0} и ${value1}`,
  fileSavedAgentsCannotSeeIt: (value0: string | number | null | undefined): string => `файл сохранён. Агенты его пока не видят: проверка нашла ${value0}`,
  record: "запись",
  untitled: "без названия",
  agentRequest: "запрос агента",
  workspaceAction: "действие в рабочем месте",
  serviceRequest: "запрос сервиса",
  shown: (value0: string | number | null | undefined): string => `показано: ${value0}`,
  actionsRows: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `действий: ${value0}, строк: ${value1}`,
  inOneMinute: "за минуту",
  moreRecords: (n: number): string => { const m10 = n % 10, m100 = n % 100; const w = m10 === 1 && m100 !== 11 ? "запись" : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? "записи" : "записей"; return `и ещё ${n} ${w}`; },
  goneRecords: (n: number): string => n === 1 ? "запись недоступна или удалена" : `${n} ${n >= 2 && n <= 4 ? "записи" : "записей"} недоступны или удалены`,
  minutesSpan: (n: number): string => `за ${n} ${pluralRu(n, ["минуту", "минуты", "минут"])}`,
  hoursSpan: (n: number): string => `за ${n} ${pluralRu(n, ["час", "часа", "часов"])}`,
  daysSpan: (n: number): string => `за ${n} ${pluralRu(n, ["день", "дня", "дней"])}`,
  repeats: (n: number, span: string): string => `${n} ${pluralRu(n, ["раз", "раза", "раз"])} ${span}`,
};


export const FEED_EVENT: Messages<typeof en.FEED_EVENT> = {
  read: "прочитано", search: "поиск", list: "просмотрен список", write: "записано", promote: "перенесено между пространствами",
  open: "показано агентам", forget: "удалено", extended_key_use: "прочитано закрытое агентом с расширенным доступом",
  t1_fallback: "ответ без части проверок", confirmation: "подтверждение", admin: "управление ключами и входом", processing: "обработка памятью",
  auth_failure: "отказ: ключ не принят", rate_limited: "отказ: слишком часто", class_move: "изменён доступ", purge: "очистка", directory: "поиск коллеги",
  external: "доступ извне",
};

export const REFUSED_TOOL_PLAIN: Messages<typeof en.REFUSED_TOOL_PLAIN> = {
  memory_search: "поиск", memory_read: "чтение записи", memory_list: "просмотр списка", memory_me: "сведения о себе",
  memory_remember: "сохранение записи", memory_upload: "загрузка файла", memory_meeting_upload: "загрузка встречи",
  memory_process_now: "обработка записи", memory_space_create: "создание проекта", memory_space_add_member: "приглашение коллеги",
  memory_space_remove_member: "исключение коллеги", memory_promote: "перенос записи", memory_open: "показ записи агентам",
  memory_close: "скрытие записи от агентов", memory_delete: "удаление записи", memory_correct: "исправление записи",
  memory_plan: "массовое изменение", memory_apply: "массовое изменение",
};
