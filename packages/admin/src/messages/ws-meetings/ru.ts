import type { Messages } from "../../i18n/core";
import * as en from "./en";

export const pageText: Messages<typeof en.pageText> = {
  meetingsWithMe: "Встречи со мной",
  requestsToDeleteYourMeetings: "Просят удалить ваши встречи",
  aParticipantAskedToDeleteA: "Участник попросил удалить встречу. Если его там не было — уберите его из участников: встреча останется. На странице встречи: «Удалить запись» — встреча уйдёт в корзину; «Оставить встречу» — участник увидит ваш ответ, окончательно решит администратор памяти.",
  untitled: "(без названия)",
  requestedBy: (value0: string | number | null | undefined): string => `просит ${value0}`,
  removeFromParticipants: (value0: string | number | null | undefined): string => `Убрать ${value0} из участников`,
  yourDeletionRequests: "Ваши просьбы удалить",
  theMeetingOrganiserOrMemoryAdministrator: "Удалить встречу могут её организатор или администратор памяти. Удалённая встреча отсюда пропадает.",
  organiser: (value0: string | number | null | undefined): string => `организатор ${value0}`,
  theAdministratorKeptTheMeeting: "администратор оставил встречу",
  theOrganiserKeptItTheAdministrator: "организатор оставил — решит администратор",
  awaitingADecision: "ждёт решения",
  meetingsForThisProject: "Встречи по проекту",
  meetings: "Встречи",
  project: "Проект: {value0}",
  projectNotFoundAmongYourSpaces: "Проект не найден среди ваших",
  showAllMeetings: "Показать все встречи",
  meetingsWhoseDecisionsWereHandedOver: "Встречи, решения которых переданы в проект, и встречи, которые организатор отметил как встречи по проекту.",
  whichMeetingsToShow: "Какие встречи показать",
  meetingList: "список встреч",
  backToTheStartOfThe: "К началу списка",
  searchMemory: "Найти в памяти",
};
