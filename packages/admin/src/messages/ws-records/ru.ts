import { EDGE_SHOW } from "../../lib/edge-status";
import { OLD_VERSION } from "../corrections/ru";
import type { OpenCheckMark } from "../../lib/types";
import { text as closed } from "../closed-class/ru";
import { text as decision } from "../decisions/ru";
import { text as due } from "../due-check/ru";
import { MEETING_PEOPLE_PLAIN as people, HANDOVER_PLAIN, RETURN_PERSONAL } from "../plain/ru";
import { RECORD_TYPE_TITLES, EVENT_KIND_TITLES, SOURCE_KIND_TITLES, SPACE_ROLE_YOU } from "../labels/ru";
import { pluralRu } from "../../i18n/core";
import type { Messages } from "../../i18n/core";
import * as en from "./en";

export const bulkActorFormText: Messages<typeof en.bulkActorFormText> = {
  replaceAnAssigneeInAllDecisions: "Заменить исполнителя во всех решениях",
  createChangePlan: "Составить план",
  creating: "Составляется…",
  whoToReplaceAsRecordedIn: "Кого заменить (как записано в решениях)",
  replaceWith: "На кого",
};

export const copyLinkText: Messages<typeof en.copyLinkText> = {
  copied: "Скопировано",
  copyLink: "Скопировать ссылку",
  recordLinkCopied: "Ссылка на запись скопирована",
  couldNotCopyTheLinkCopy: "Не удалось — скопируйте адрес из строки браузера.",
};

export const correctBlockText: Messages<typeof en.correctBlockText> = {
  candidateCaption: (type: string, event: string | null, day: string | null): string => {
    const kind = ((event ? EVENT_KIND_TITLES[event] : null) ?? RECORD_TYPE_TITLES[type] ?? type).replace(/^./, c => c.toUpperCase());
    return ` · ${kind}${day ? ` · ${day}` : ""}`;
  },

  title: "Название",
  statement: "Суть",
  dueDate: "Срок",
  noDueDate: "<tag0/> Срока нет",
  phraseFromTheTranscript: "Фраза из стенограммы",
  optionalAnExactPhrase81: "Необязательно: дословно, от 8 до 1 000 знаков. Память сверит её со стенограммой.",
  whatIsCorrectInYourOwn: "Что верно — вашими словами",
  fillInThisFieldOrSpecify: "Нужно это поле или более новая запись — хотя бы одно.",
  newerRecord: "Более новая запись",
  untitled: "Без названия",
  pasteARecordLink: "Вставить ссылку на запись",
  linkToTheNewerRecordPage: "Ссылка на страницу более новой записи",
  linkToTheRecordPage: "ссылка на страницу записи",
  text: "Текст",
  findANewerRecord: "Найти более новую запись",
  partOfTheTitle: "часть названия",
  search: "Найти",
  noResultsForTryAnotherWord: "Ничего не нашлось по «{value0}». Попробуйте другое слово или вставьте ссылку.",
  searchDidNotRespondPasteA: "Поиск не ответил — вставьте ссылку на запись.",
  saveCorrection: "Сохранить исправление",
  saving: "Сохраняется…",
  correct: "Исправить",
};

export const correctLinkText: Messages<typeof en.correctLinkText> = {
  correct: "<tag0/>Исправить",
};

export const correctionsBlockText: Messages<typeof en.correctionsBlockText> = {
  confirm: "Подтвердить",
  reject: "Отклонить",
  thisIsIncorrect: "Это не так",
  withdraw: "Отозвать",
  correctionsToThisRecord: "Исправления этой записи",
  whoCorrectedTheRecordAndHow: "Кто и как исправил запись. Применённое действует сразу; предложение ждёт решения автора записи, участников встречи или владельца пространства.",
};

export const decisionsListText: Messages<typeof en.decisionsListText> = {
  actorNames: (kind: string | null, names: readonly string[]): string => `${kind === "decision" ? decision.whoDecided : kind === "action" ? decision.whoDoesIt : decision.whoSaidIt}: ${names.join(", ")}`,
  handoverLabel: (title: string | null): string => `${HANDOVER_PLAIN.link}: ${title || decisionsListText.decision}`,
  dueLine: (check: boolean): string => `Срок: {date}${check ? ` <check>${due.checkTheDueDate}</check>` : ""}`,
  groupHeading: (kind: string, count: number): string => `${({ decision: decision.decisions, action: decision.tasks, question_risk: decision.risksAndQuestions, fact: decision.facts } as Record<string, string>)[kind] ?? decision.other} <count>${count}</count>`,

  untitled: "(без названия)",
  dueDate: "Срок: {value0}{value1}",
  decision: "решение",
  showAll: "Показать все ({value0})",
};

export const edgeActionsText: Messages<typeof en.edgeActionsText> = {
  failure: (message: string): string => `${EDGE_SHOW.failed}: ${message}`,

  recordIdIsMissing: "Нет идентификатора записи",
};

export const edgeStatusBlockText: Messages<typeof en.edgeStatusBlockText> = {
  externalCopy: "Снаружи",
  theExternalCopyContainsOpenRecords: "Снаружи — копия открытых записей для ИИ-агентов коллег, подключённых из-за пределов сети компании.",
};

export const meetingProjectText: Messages<typeof en.meetingProjectText> = {
  decisionsLegend: (limit: number | null): string => meetingProjectText.meetingDecisions.replace("{value0}", limit ? meetingProjectText.atMostAtATime(limit) : ""),

  handOverTheSelectedDecisionsTo: "Передать отмеченные решения в проект?",
  eachSelectedDecisionWillBecomeA: "Каждое отмеченное решение станет отдельной записью проекта. Сама встреча останется как есть: её стенограмму участники проекта не увидят.",
  allProjectMembersIncludingThoseWho: "Все участники проекта, в том числе те, кого не было на встрече; у проекта, где новые записи видят ИИ-агенты, — и их агенты.",
  youCannotTakeBackWhatHas: "Прочитанное назад не вернуть: запись в проекте можно удалить, но её уже могли прочитать.",
  handOver: "Передать",
  iHaveReviewedTheDecisionsAnd: "Я просмотрел(а) решения и согласен(на), что их увидят участники проекта",
  untitledDecision: "Решение без названия",
  meetingAndProject: "Встреча и проект",
  theMeetingStaysWithItsOrganiser: "Встреча остаётся у организатора. В проект можно передать её решения — каждое станет записью проекта; стенограмму участники проекта не увидят.",
  youMarkedThisMeetingAsBelonging: "Вы отметили встречу как встречу по проекту <tag0>«{value0}»</tag0>: она видна в «Встречах по проекту» у участников встречи, которые читают этот проект.",
  markWhichProjectThisMeetingBelongs: "Отметьте, к какому проекту относится встреча: она появится в «Встречах по проекту» у участников встречи, которые читают проект. Кто видит встречу, не изменится.",
  changeProjectMark: "Изменить отметку",
  mark: "Отметить",
  saving: "Сохранение…",
  projectMeeting: "Встреча по проекту",
  notAProjectMeeting: "— не по проекту —",
  handOverAllDecisionsToA: "<tag0/>Передать все решения в проект…",
  sendToProject: "Передать в проект",
  handingOver: "Передача…",
  project: "Проект",
  chooseAProject: "— выберите проект —",
  atMostAtATime: (value0: string | number | null | undefined): string => ` — за один раз не больше ${value0}`,
  meetingDecisions: "Решения встречи{value0}",
  eachDecisionSTextWillBe: "Текст каждого решения уйдёт в проект как есть. Если в решении есть то, что не должно выйти за пределы встречи, — снимите галочку и передайте его по одному, поправив текст.",
};

export const orgReviewBlockText: Messages<typeof en.orgReviewBlockText> = {
  usefulCount: (count: number, departments: number): string => orgReviewBlockText.markedUsefulBy.replace("{value0}", String(count)).replace("{value1}", departments ? orgReviewBlockText.departments(departments) : ""),
  wrongGroupLines: (groups: readonly { label: string; names: string }[]): string => groups.map(g => `${g.label}: ${g.names}`).join("; ") + ".",

  companyKnowledge: "Общие знания компании",
  departments: (value0: string | number | null | undefined): string => ` (подразделений: ${value0})`,
  markedUsefulBy: "«Полезно» отметили: {value0}{value1}.",
  previewIsReadOnly: "В предпросмотре — только просмотр.",
  removeUseful: "Снять «Полезно»",
  useful: "Полезно",
  undoAnnotation: "Отменить отметку",
  wrongNotForEveryone: "Неверно / не для всех",
  mark: "Отметить",
  whatIsCorrectForWrong: "Что верно (для «Неверно»)",
  forExampleApprovalTakes5Working: "например: срок согласования — 5 рабочих дней, а не 3",
  confirm: "Подтвердить",
  returnToSource: "Вернуть обратно",
  restore: "Вернуть",
  returnTheRecordToWhereIt: "Вернуть запись туда, откуда она пришла? Её перестанут видеть сотрудники, у которых нет доступа туда. Автор увидит это в «Моих действиях».",
  delete: "Удалить",
  deleteTheRecordItWillReturn: "Удалить запись? Она вернётся туда, откуда пришла, и сразу уйдёт там в корзину; восстановить её может автор — там, а не в «Общих знаниях компании».",
};

export const ownerActionsText: Messages<typeof en.ownerActionsText> = {
  derivedHint: (hidden: boolean): string => `${hidden ? closed.thisRecordIsPartOfThe : closed.thisRecordIsPartOfThe2} <link>${ownerActionsText.sourceRecord}</link>`,

  sourceRecord: "Исходная запись",
  iUnderstandTheConsequences: "<tag0/> Понимаю последствия",
  processNow: "Обработать сейчас",
  deleteRecord: "Удалить запись",
};

export const pageText: Messages<typeof en.pageText> = {
  returnExplanation: (space: string | null, derived: boolean, participants: boolean, open: boolean): string => (derived ? RETURN_PERSONAL.explainDerived(space) : RETURN_PERSONAL.explain(space)) + (participants ? ` ${RETURN_PERSONAL.participants}` : "") + (open ? ` ${RETURN_PERSONAL.agents}` : ""),
  returnParent: `<link>${RETURN_PERSONAL.parentLink}</link> ${RETURN_PERSONAL.parentHint}`,
  oldVersion: (title: boolean): string => `${OLD_VERSION.visible} <link>${title ? "{title}" : pageText.untitled2}</link>.`,
  sourceDetails: (source: string, ref: string | null): string => `${SOURCE_KIND_TITLES[source] ?? source}${ref ? ` · ${ref}` : ""}`,
  roleSuffix: (role: string): string => ` · ${SPACE_ROLE_YOU[role] ?? pageText.you(role)}`,
  eventKindSuffix: (kind: string): string => ` · ${EVENT_KIND_TITLES[kind] ?? kind}`,
  requesterStatus: "{name} — {status}.",

  closedNotice: (owner: boolean, participant: boolean): string => pageText.closedRecordEveryViewIsRecorded.replace("{value0}", owner ? pageText.youAreItsOwner : participant ? pageText.youAreAParticipantInThis : pageText.youCanSeeItThroughYour).replace("{value1}", owner ? pageText.untilYouShowItToAi : ""),
  meetingSource: (title: boolean, day: boolean): string => pageText.fromTheMeeting.replace("{value0}", title ? "{title}" : pageText.untitled2).replace("{value1}", day ? " · {day}" : ""),
  transcriptPart: (from: boolean, to: boolean): string => pageText.showingPartOfTheTranscript.replace("{value0}", from ? pageText.from.replace("{value0}", "{from}") : "").replace("{value1}", to ? pageText.to.replace("{value0}", "{to}") : ""),
  originalSize: (pages: number, duration: boolean): string => pageText.kb.replace("{value0}", "{kb}").replace("{value1}", pages ? pageText.pages(pages) : "").replace("{value2}", duration ? " · {duration}" : ""),
  checkHeader: (dated: boolean): string => `<tag0>Закрыта автоматической проверкой${dated ? " {at}" : ""}.</tag0>`,
  checkBody: (mark: Pick<OpenCheckMark, "findings" | "kinds" | "unchecked" | "by_word">, source: string | null, origin: string | null, personal: boolean, space: string | null, offered: boolean, allowed: boolean): string => `${closed.checkLead(source, origin, personal, space)}: ${closed.reasonSummary(mark, false)}. Поэтому запись закрытая, агенты её не видят. ${mark.by_word ? closed.wordAdvice(offered) : allowed ? offered ? closed.consentAdvice() : closed.disabledAdvice() : closed.thisCannotBeShownEvenWith}`,
  keptHeader: "Файл сохранён. Агенты его пока не видят.",

  recordNumberLine: "Номер записи: <code>{id}</code>.",
  errorCode: " Код: <code>{code}</code>.",
  deleteOrKeepMeeting: "Удалить — «Удалить встречу» в «Действиях владельца»: встреча уйдёт в корзину. Оставить — ответьте участнику; решение тогда за администратором памяти.",

  peopleCount: (count: number, named: boolean): string => `${named ? "и ещё " : ""}${count} ${named ? "" : "чел."}`,

  record: "Запись",
  detailsForIt: "Подробнее для ИТ",
  path: "Путь",
  recordNumber: "Номер записи",
  source: "Источник",
  sizeInTokens: "Объём, токенов",
  version: "Версия",
  fileFormat: "Формат файла",
  fileConversion: "Разбор файла",
  thisRecordSSpaceIsArchived: "Пространство этой записи в архиве.",
  closedByTheAutomaticCheckThe: "<tag0>Закрыта автоматической проверкой{value0}.</tag0> {value1}: {value2}. Поэтому запись закрытая, агенты её не видят. {value3}",
  recordUnavailable: "Запись недоступна",
  theRecordLinkIsInvalidIt: "Ссылка на запись неверная — возможно, она скопирована не целиком.",
  thisIsAClosedRecordOnly: "<tag0>Это закрытая запись.</tag0> В этом просмотре видны только открытые записи. Человек с доступом читает её в рабочем месте под своей учётной записью; если запись ваша, её можно показать агентам.",
  theRecordWasDeletedOrMoved: "Её удалили, перенесли или у вас нет доступа. Если это была встреча, возможно, организатор убрал вас из участников — спросите его. Своё удалённое — в <tag0>Корзине</tag0>.",
  theRecordWasDeletedOrMoved2: "Её удалили, перенесли, или это закрытая запись, а здесь видны только открытые.",
  theRecordHasNotOpenedYet: "Запись ещё не открылась.",
  theRecordCouldNotBeOpened: "Запись не открылась.",
  details: "Подробнее",
  memoryDeliberatelyGivesTheSameResponse: " Память нарочно не различает, удалена запись или закрыта от вас: так по ссылке нельзя узнать о чужой записи.",
  ownerActions: "Действия владельца",
  ifThisIsNotYourRecord: "Если запись не ваша, память откажет и ничего не изменится. Содержимое появится здесь после того, как обработка завершится.",
  closedRecord: "Закрытая запись",
  theContentsOfThisRecordAre: "Содержимое этой записи вам не показывается.",
  knownRecordDetails: "Что известно о записи",
  recordDetailsOnlyWithoutTextThis: "Только сведения о записи, без текста: здесь, как ИИ-агенту по личному ключу, закрытое не показывается. Текст закрытой записи люди с доступом читают в рабочем месте под своей учётной записью.",
  type: "Вид",
  space: "Пространство",
  owner: "Владелец",
  when: "Когда",
  processing: "Обработка",
  location: "Где лежит",
  thisIsNotYourRecordOnly: "Запись не ваша: показать её агентам может только автор, удалить — автор или владелец пространства.",
  untitled: "(без названия)",
  actions: "Действия",
  untitled2: "Без названия",
  fromTheMeeting: "<tag0/> Из встречи «{value0}»{value1}",
  youAreItsOwner: "Вы её владелец",
  youAreAParticipantInThis: "Вы участник этой встречи",
  youCanSeeItThroughYour: "Вы видите её по своей роли в пространстве",
  untilYouShowItToAi: ", пока вы не покажете её ИИ-агентам",
  closedRecordEveryViewIsRecorded: "<tag0>Закрытая запись.</tag0> {value0}. Каждый просмотр записывается в журнал аудита, его видно в <tag1>«Моих действиях»</tag1>. ИИ-агентам запись не передаётся{value1}.",
  participantsHaveAskedToDeleteThis: "Участники просят удалить эту встречу:",
  keepMeeting: (value0: string | number | null | undefined): string => `Оставить встречу — ${value0}`,
  removeFromParticipants: (value0: string | number | null | undefined): string => `Убрать ${value0} из участников`,
  from: " с [{value0}]",
  to: " до [{value0}]",
  showingPartOfTheTranscript: "Показана часть стенограммы{value0}{value1}.",
  showingPartOfTheRecord: "Показана часть записи.",
  readMore: "Читать дальше →",
  fromTheStart: "← С начала",
  summary: "Резюме",
  theSummaryCouldNotBeOpened: "Резюме не открылось.",
  decisionsAndAgreements: "Решения и договорённости",
  whatMemoryExtractedFromTheMeeting: "Что память извлекла из встречи: решения, задачи, риски и факты. Каждое из них — отдельная запись, её можно найти поиском.",
  noDecisionsOrAgreementsWereFound: "Решений и договорённостей во встрече не нашлось.",
  decisionsCouldNotBeExtracted: "решения не извлеклись",
  theseWillAppearWithTheSummary: "Появятся вместе с резюме.",
  transcript: "<tag0/>Стенограмма",
  aboutThisRecord: "О записи",
  addedToMemory: "Добавлено в память",
  visibleToMeetingParticipants: " · видят участники встречи",
  you: (value0: string | number | null | undefined): string => `вы ${value0}`,
  origin: "Откуда",
  sourceRecord: "исходная запись",
  retryingWillReceiveTheSameRefusal: " · повтор даст тот же отказ",
  access: "Доступ",
  limitedByTheSystemTheRecord: "ограничен системой, откуда пришла запись",
  recorded: "Записано",
  people: "Люди",
  recordsInvolvingThisPerson: "Записи с участием человека",
  mentions: "Упоминаются",
  topics: "Темы",
  recordsInvolving: "<tag0/>Записи с участием: {value0}",
  findWithSearch: "<tag0/>Найти в поиске",
  contents: "Содержание",
  p: " стр. {value0}",
  extractedFromThisRecord: "Извлечено из записи",
  summariesDecisionsAndTasksThatMemory: "Резюме, решения и задачи, которые память извлекла из этой записи. Каждое из них — отдельная запись.",
  original: "Оригинал",
  format: "Формат",
  size: "Размер",
  pages: (value0: string | number | null | undefined): string => ` · ${value0} стр.`,
  kb: "{value0} КБ{value1}{value2}",
  downloadFile: "<tag0/> Скачать файл",
  thisLinkExpiresSoon: "ссылка действует недолго",
  fileLinkUnavailable: "Ссылка на файл недоступна.",
  deleteMeeting: "Удалить встречу",
  deleteRecord: "Удалить запись",
  findInMemory: "<tag0/>Найти в памяти",
  meetingsWithMe: "Встречи со мной",
  overview: "<tag0/>На Обзор",
};

export const participantPickerText: Messages<typeof en.participantPickerText> = {
  retryAfter: (seconds: number | null): string => participantPickerText.tooManySearchesInARow(seconds ? participantPickerText.seconds(seconds) : participantPickerText.aMinute),
  optionCaption: (department: string, login: string, inMemory: boolean): string => [department, login].filter(Boolean).join(" · ") + (inMemory ? "" : participantPickerText.willSeeTheMeetingAfterFirst(people.labelWaiting)),
  insideCaption: (department: string): string => [department, people.inMeeting].filter(Boolean).join(" · "),

  willSeeTheMeetingAfterFirst: (value0: string | number | null | undefined): string => ` — ${value0}: увидит встречу после первого входа`,
  yourSessionEndedRefreshThePage: "Сеанс завершён — обновите страницу и войдите снова",
  searchDidNotRespondTryAgain: "Поиск не ответил — попробуйте ещё раз",
  seconds: (value0: string | number | null | undefined): string => `${value0} с`,
  aMinute: "минуту",
  tooManySearchesInARow: (value0: string | number | null | undefined): string => `Слишком много поисков подряд — подождите ${value0} и продолжите набирать`,
  searchDidNotRespondCheckYour: "Поиск не ответил — проверьте сеть и попробуйте ещё раз",
  searchingPeopleWhoHaveAccessTo: "Ищем среди тех, у кого есть доступ к памяти…",
  noMatchesAmongPeopleWithAccess: "Никого не нашлось среди тех, у кого есть доступ к памяти. Проверьте написание или добавьте коллегу вручную ниже.",
  matchingColleagues: "Подходящие коллеги",
  showingTheFirst10NarrowYour: "Показаны первые 10 — уточните фамилию.",
  adding: "Добавляем…",
};

export const participantsBlockText: Messages<typeof en.participantsBlockText> = {
  leftCaption: (dated: boolean): string => participantsBlockText.leftVoluntarily.replace("{value0}", dated ? " · {at}" : ""),
  deletionKept: (dated: boolean): string => participantsBlockText.youAskedToDeleteTheMeeting.replace("{value0}", dated ? " {at}" : ""),
  deletionDeclined: (dated: boolean): string => participantsBlockText.youAskedToDeleteTheMeeting2.replace("{value0}", dated ? " {at}" : ""),

  personCaption: (name: string, you: boolean, gone: boolean): string => name + (you ? participantsBlockText.you : "") + (gone ? ` — ${people.gone}` : ""),
  participantNames: (names: readonly (string | { name: string; you: boolean; gone: boolean })[], more: number): string => (names.length ? names.map(p => typeof p === "string" ? p : participantsBlockText.personCaption(p.name, p.you, p.gone)).join(", ") : people.noParticipants) + (more > 0 ? participantsBlockText.andMore(more) : ""),
  organizerCaption: (name: string, you: boolean): string => `<tag0>${people.organizer}:</tag0> ${participantsBlockText.personCaption(name, you, false)}`,
  participantHeading: "Участники:",
  unresolvedNames: (names: readonly string[]): string => `${people.unresolved}: ${names.join(", ")}.`,
  suggestedPerson: (department: string | null, why: string): string => [department, people.why[why as keyof typeof people.why] ?? null].filter(Boolean).join(" · "),

  colleagueExample: "colleague@example.com",
  you: " (вы)",
  recordsInvolvingThisPerson: "Записи с участием человека",
  andMore: (value0: string | number | null | undefined): string => ` и ещё ${value0}`,
  participants: "Участники",
  remove: "Убрать",
  add: "Добавить",
  leftVoluntarily: "вышел(а) сам(а){value0}",
  youAskedToDeleteTheMeeting: "Вы просили удалить встречу <tag0/>. Администратор памяти оставил встречу{value0} — попросить удалить её ещё раз нельзя.",
  youAskedToDeleteTheMeeting2: "Вы просили удалить встречу <tag0/>. Организатор её оставил{value0} — окончательно решит администратор памяти.",
  deletionRequestedTheOrganiserAndMemory: "Просьба удалить отправлена <tag0/>: её видят организатор и администратор памяти.",
  reasonOptional: "Почему (необязательно)",
  doNotSpecify: "не указывать",
};

export const recheckActionsText: Messages<typeof en.recheckActionsText> = {
  failure: (message: string): string => `${recheckViewText.couldNotPrepare}: ${message}`,

  recordIdIsMissing: "Нет идентификатора записи",
};

export const recheckViewText: Messages<typeof en.recheckViewText> = {
  hiddenByRecheck: "Скрыто перепроверкой",
  anOpenCheckRecheckHidesRecords: "Перепроверка открытого скрывает от агентов записи, в которых нашлось то, что агентам показывать нельзя. Люди запись по-прежнему видят.",
  hiddenFromAgents: "Скрыто от агентов",
  keptHidden: "Оставлено скрытым",
  willReturnFromTrashHidden: "Вернётся скрытой из корзины",
  keepHidden: "Оставить скрытой",
  theRecordWillStayHiddenFrom: "Запись останется скрытой от агентов, и администратор больше не увидит её в списке «к просмотру». Показать её агентам потом можно обычной кнопкой — с полной проверкой. Оставить скрытой?",
  youChoseToKeepItHidden: "Вы решили оставить её скрытой. Показать агентам можно обычной кнопкой — с полной проверкой.",
  recordKeptHidden: "Запись оставлена скрытой",
  couldNotPrepare: "Не получилось",
};

export const recordTrailText: Messages<typeof en.recordTrailText> = {
  backToSearchResults: "К результатам поиска",
  recordLocation: "Где лежит запись",
};

export const showAnywayPanelText: Messages<typeof en.showAnywayPanelText> = {
  iUnderstandTheConsequences: "Понимаю последствия",
};

export const transcriptJumpText: Messages<typeof en.transcriptJumpText> = {
  thisPointIsBeyondThePart: "Это место дальше показанной части стенограммы: страница показывает только начало длинной встречи.",
};

export const whoSeesText: Messages<typeof en.whoSeesText> = {
  peopleWhoCanAccessTheRecord: "люди, которым доступна запись, и их ИИ-агенты",
  onlyPeopleWhoCanAccessThe: "только люди, которым доступна запись, — здесь, в рабочем месте",
  whoCanSeeTheRecord: "Кто видит запись",
  whoCanSeeIt: "Кто видит:",
  why: "Почему так",
};
