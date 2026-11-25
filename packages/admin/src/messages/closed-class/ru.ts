import type { OpenCheckMark } from "../../lib/types";
import { OPEN_CHECK_FIELD_TITLES, OPEN_CHECK_KIND_TITLES } from "../labels/ru";
import type { Messages } from "../../i18n/core";
import * as en from "./en";
export const text: Messages<typeof en.text> = {
  findingLine: (f: { kind: string; reason: string; field: string; at?: number }, position: boolean): string =>
    f.kind === "never_open" ? text.neverOpenRule(f.reason) : text.looksLikeField(f.reason, OPEN_CHECK_FIELD_TITLES[f.field] ?? f.field, position && typeof f.at === "number" ? text.position(f.at) : ""),
  reasonSummary: (mark: Pick<OpenCheckMark, "findings" | "kinds" | "unchecked">, position: boolean): string => {
    const parts = (mark.findings ?? []).slice(0, 3).map(f => text.findingLine(f, position));
    const more = (mark.findings?.length ?? 0) - parts.length;
    // Keep the remainder with the last finding, before any scan warning.
    if (more > 0) parts[parts.length - 1] += text.andMore(more);
    if (mark.unchecked === "empty_text") parts.push(text.noTextCouldBeExtractedFrom);
    else if (mark.unchecked === "partial_text") parts.push(text.somePagesAreScansAndCould);
    if (!parts.length) parts.push((mark.kinds ?? []).map(k => OPEN_CHECK_KIND_TITLES[k] ?? k).join(", ") || text.aCheckFinding);
    return parts.join("; ");
  },
  checkLead: (source: string | null, origin: string | null, personal: boolean, space: string | null): string => {
    const where = personal ? text.toYourPersonalSpace : space ? text.toTheSpace(space) : text.toThisSpace;
    return source === "upload" ? text.youUploadedThisFileButThe(where) : source === "agent"
      ? origin === "human" ? text.youSavedThisRecordButThe(where) : text.yourAiAgentSavedThisRecord(where)
      : text.thisRecordWasSavedButThe(where);
  },
  wordAdvice: (offered: boolean): string => offered ? text.ifAgentsNeedThisTellYour(text.makeAvailableToAgents, text.allFindingsOfTheseKindsIn) : text.ifAgentsNeedThisTellYour2(text.allFindingsOfTheseKindsIn),
  consentAdvice: (): string => text.ifAgentsNeedThisSelectMemory(text.makeAvailableToAgents),
  openConfirmation: (): string => text.showTheRecordToAgents(CLOSED_CLASS_TEXT.openClassWarning),
  hideUndo: (): string => text.youCanShowItAgainHere(ACCESS_ACTION.show),
  disabledAdvice: (): string => text.theAdministratorHasDisabledMakeAvailable(text.asANewNoteOrUpload),
  reopenAdvice: (): string => text.thisRecordWasPreviouslyShownTo(text.makeAvailableToAgents),
  neverAdvice: (reasons: string): string => text.thisRecordCannotBeShownTo(reasons, text.asANewNoteOrUpload),
  sensitiveAdvice: (): string => text.passportDetailsSnilsAndBankCard(text.asANewNoteOrUpload),
  noWriteAdvice: (space: string | null): string => text.youCanNoLongerChangeRecords(space ? text.inTheSpace(space) : text.inThisSpace),
  orgAdvice: (): string => text.recordsWithThisFindingCannotBe(text.asANewNoteOrUpload),
  disabledGateAdvice: (projects: boolean): string => projects ? text.theAdministratorHasDisabledMakeAvailable3(text.asANewNoteOrUpload) : text.theAdministratorHasDisabledMakeAvailable2(text.asANewNoteOrUpload),
  ownerChange: (previous: string | null, department: boolean): string => [text.theNewOwnerManagesMembershipAnd, previous ? text.thePreviousOwnerWillRemainA(previous) : "", department ? text.theOrgTableAlsoSetsThe : ""].filter(Boolean).join(" "),
  keptReasons: (reasons: readonly string[]): string => !reasons.length ? text.informationThatIsUsuallyHiddenFrom : reasons.length === 1 ? reasons[0]! : text.and(reasons.slice(0, -1).join(", "), reasons[reasons.length - 1]),
  keptWhy: (mark: Pick<OpenCheckMark, "findings" | "kinds" | "via" | "unchecked">): string => {
    const reasons = [...new Set((mark.findings ?? []).filter(f => f.kind !== "never_open").map(f => f.reason))];
    const parts = reasons.length || mark.unchecked !== "partial_text" ? [`проверка нашла${mark.via === "convert" && reasons.length ? " в тексте" : ""} ${text.keptReasons(reasons)}`] : [];
    if (mark.unchecked === "partial_text") parts.push(text.somePagesAreScansAndCould);
    return parts.join("; ");
  },
  keptUpload: (mark: Pick<OpenCheckMark, "findings" | "kinds" | "via" | "unchecked">, kind: string | null, name: string | null): string => text.fileSavedButAgentsCannotSee(text.keptWhy(mark), text.peopleIn(kind, name)),
  keptNotice: (mark: Pick<OpenCheckMark, "findings" | "kinds" | "via" | "unchecked">, kind: string | null, name: string | null): string => {
    const why = text.keptWhy(mark);
    return text.peopleCanSeeItAsUsual(why.charAt(0).toUpperCase() + why.slice(1), text.peopleIn(kind, name));
  },

  peopleIn: (kind: string | null, name: string | null): string => `${kind === "team" ? "в команде" : kind === "project" ? "в проекте" : "в пространстве"}${name ? ` «${name}»` : ""}`,

  ifARecordIsClosedAn: "Если запись закрытая, ИИ-агенту по личному ключу она недоступна, и здесь её тоже не видно. Человек с доступом читает её в рабочем месте под своей учётной записью, а показать её агентам может владелец.",
  showTheRecordToAgents: (value0: string | number | null | undefined): string => `Показать запись агентам? ${value0}`,
  thisRecordIsPartOfThe: "Эта запись — часть исходной и скрывается от агентов только вместе с ней.",
  thisRecordIsPartOfThe2: "Эта запись — часть исходной и показывается агентам только вместе с ней.",
  neverOpenRule: (value0: string | number | null | undefined): string => `правило «никогда не открывать»: ${value0}`,
  position: (value0: string | number | null | undefined): string => `, позиция ${value0}`,
  looksLikeField: (value0: string | number | null | undefined, value1: string | number | null | undefined, value2: string | number | null | undefined): string => `похоже на ${value0} (поле «${value1}»${value2})`,
  toTheSpace: (value0: string | number | null | undefined): string => `в пространство «${value0}»`,
  toThisSpace: "в это пространство",
  toYourPersonalSpace: "в личное пространство",
  youUploadedThisFileButThe: (value0: string | number | null | undefined): string => `Вы загрузили этот файл ${value0}, но проверка нашла`,
  youSavedThisRecordButThe: (value0: string | number | null | undefined): string => `Вы сохранили эту запись ${value0}, но проверка нашла`,
  yourAiAgentSavedThisRecord: (value0: string | number | null | undefined): string => `Ваш ИИ-агент сохранил эту запись ${value0}, но проверка нашла`,
  thisRecordWasSavedButThe: (value0: string | number | null | undefined): string => `Эта запись сохранена ${value0}, но проверка нашла`,
  andMore: (value0: string | number | null | undefined): string => ` и ещё ${value0}`,
  noTextCouldBeExtractedFrom: "текст из файла не извлёкся, проверять нечего",
  somePagesAreScansAndCould: "часть страниц — сканы, их не удалось проверить",
  aCheckFinding: "находка проверки",
  ifAgentsNeedThisTellYour: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `Если это нужно агентам, скажите агенту «покажи» или нажмите здесь «${value0}». Ваше согласие распространится на ${value1}.`,
  ifAgentsNeedThisTellYour2: (value0: string | number | null | undefined): string => `Если это нужно агентам, скажите агенту «покажи». Ваше согласие распространится на ${value0}.`,
  ifAgentsNeedThisSelectMemory: (value0: string | number | null | undefined): string => `Если это нужно агентам, нажмите «${value0}»: память покажет, что нашла и кто увидит запись, и спросит вас.`,
  thisCannotBeShownEvenWith: "Нельзя даже с вашего согласия: уберите это и запишите заново.",
  asANewNoteOrUpload: "новой заметкой или загрузите исправленный файл заново (правка этой записи не поможет: память проверяет и её прежние версии)",
  theAdministratorHasDisabledMakeAvailable: (value0: string | number | null | undefined): string => `Администратор выключил «Сделать доступным агентам». Если это нужно агентам, запишите нужное без найденного ${value0}.`,
  allFindingsOfTheseKindsIn: "все такие находки в самой записи и в извлечённых из неё записях — какие они сейчас",
  theUsualShowToAgentsAction: "Обычная «Показать агентам» откажет из-за этой находки. Нажмите «Сделать доступным агентам» — память покажет, что нашла, и спросит вас.",
  showToAgentsWillCheckThe: "Кнопка «Показать агентам» снова проверит запись и откажет, если находка осталась.",
  makeAvailableToAgents: "Сделать доступным агентам",
  thisRecordWasPreviouslyShownTo: (value0: string | number | null | undefined): string => `Эту запись уже показывали агентам, потом скрыли. Чтобы показать снова, нажмите «${value0}»: память ещё раз покажет, что нашла проверка, и спросит вас.`,
  showTheRecordToAgents2: "Показать запись агентам?",
  aiAgentsOfEveryoneWhoCan2: "Запись смогут читать ИИ-агенты всех, кто её видит, например Claude Code или Codex. Эти агенты работают на внешних облачных моделях, поэтому текст записи уйдёт за пределы компании.",
  youCanHideTheRecordFrom: "Запись можно снова скрыть от агентов, но то, что они успели прочитать, останется у них.",
  iUnderstandTheConsequences: "Понимаю последствия",
  assignANewSpaceOwner: "Назначить нового владельца пространства?",
  theyWillBeAbleToDelete: "Он сможет удалять и переносить записи пространства и менять его состав. Прежний владелец останется участником.",
  youCanChangeTheOwnerAgain: "Владельца можно сменить снова здесь же.",
  assign: "Назначить",
  makeTheOwnerOf: (value0: string | number | null | undefined): string => `Сделать {} владельцем «${value0}»?`,
  theNewOwnerManagesMembershipAnd: "Новый владелец распоряжается составом, переносит и удаляет записи пространства.",
  thePreviousOwnerWillRemainA: (value0: string | number | null | undefined): string => `Прежний владелец ${value0} останется участником: пишет и читает.`,
  theOrgTableAlsoSetsThe: "Владельца пространства подразделения задаёт и орг-таблица: при следующей загрузке она может его сменить.",
  applyMembershipChanges: "Применить изменения состава?",
  addedMembersWillImmediatelySeeSpace: "Добавленные сразу увидят записи пространства, убранные — перестанут.",
  youCanChangeMembershipAgainHere: "Состав можно изменить снова здесь же; прочитанное добавленными не вернуть.",
  apply: "Применить",
  agentsWillImmediatelyStopFindingAnd2: "Агенты сразу перестанут находить и читать запись. То, что они уже прочитали, останется у них.",
  hideTheRecordFromAgents2: "Скрыть запись от агентов?",
  youCanShowItAgainHere: (value0: string | number | null | undefined): string => `Показать снова можно здесь же кнопкой «${value0}».`,
  makeAvailableToAgents2: "Сделать доступным агентам?",
  theCheckFoundInformationInThe: "Проверка нашла в записи то, что обычно не показывают ИИ-агентам.",
  inTheRecordItself: "в самой записи",
  inRecordsExtractedFromIt: "в извлечённых из неё записях",
  agentsWillAlsoSeeColleaguesAnnotations: (value0: string | number | null | undefined): string => `Вместе с записью агенты увидят пометки коллег: ${value0}.`,
  yourAiAgentsSuchAsClaude: "Ваши ИИ-агенты — например, Claude Code или Codex, подключённые по вашему ключу.",
  agentsUseExternalCloudModelsSo: "Агенты работают на внешних облачных моделях, поэтому текст записи уйдёт за пределы компании.",
  onlyThisRecordAsItIs: "Только на эту запись в нынешнем виде и только на сведения тех видов, что перечислены выше, — на все такие сведения в записи, сколько бы их ни было. Если запись или извлечённые из неё записи изменятся, коллега добавит пометку, запись перенесут, разместят в другом пространстве или дадут к ней отдельный доступ, — память спросит вас снова. То, что проверка найдёт позже, агентам не покажется.",
  theCountShowsHowManyPlaces: "Число — в скольких местах записи (название, краткое содержание, текст, файл, извлечённые записи) проверка это нашла. Краткое содержание — отдельное место, даже если повторяет начало текста: агенты видят его в результатах поиска. В одном месте таких сведений может быть несколько — агенты увидят все.",
  theFileContainsScannedPagesAgents: "В файле есть страницы-сканы. Агенты получат только распознанный текст, который проверила память. Сам файл и страницы-сканы останутся видны только людям.",
  iAmTheRecordAuthorAnd: "Я автор записи и понимаю: то, что нашла проверка, станет видно агентам",
  keepHidden: "Не показывать",
  ifThisPageHasBeenOpen: "Если страница открыта дольше 15 минут, обновите её — память проверит запись заново.",
  thisRecordCannotBeShownTo: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `Эту запись нельзя показать агентам даже с вашего согласия: в ней есть ${value0}. Если это нужно агентам, запишите нужное без этого ${value1}.`,
  passportDetailsSnilsAndBankCard: (value0: string | number | null | undefined): string => `Паспортные данные, СНИЛС и номер банковской карты можно показать агентам только в вашем личном пространстве, которое видите вы один. Остальное можно показать: запишите его без этих данных ${value0}.`,
  noTextWasFoundInThe: "В файле не нашлось текста — похоже, это скан или фото страниц. Агентам показывать нечего: файл видят только люди.",
  theRecordAndItsEditHistory: "Запись вместе с историей правок слишком большая, чтобы проверить её целиком. Нужное агентам запишите новой заметкой.",
  theAdministratorHasDisabledShowingScans: "Администратор выключил показ сканов текстом. Файл видят только люди.",
  inTheSpace: (value0: string | number | null | undefined): string => `в пространстве «${value0}»`,
  inThisSpace: "в этом пространстве",
  youCanNoLongerChangeRecords: (value0: string | number | null | undefined): string => `Вы больше не можете менять записи ${value0}, поэтому показать запись агентам нельзя.`,
  recordsWithThisFindingCannotBe: (value0: string | number | null | undefined): string => `В «Общих знаниях компании» запись с такой находкой показать агентам нельзя. Запишите нужное без найденного ${value0}.`,
  thisRecordIsPlacedInCompany: "Запись размещена в «Общих знаниях компании», поэтому с такой находкой её показать агентам нельзя.",
  someRecordsExtractedFromThisRecord: "Часть извлечённых из записи записей лежит в другом пространстве, поэтому показать их вместе нельзя.",
  meetingsAndRecordsDerivedFromThem: "Встречу и то, что из неё получено, так показать нельзя. Так же нельзя показать запись, чей источник удалён или связь с ним записана не до конца: память не может проверить, не из встречи ли она.",
  theAdministratorHasDisabledMakeAvailable2: (value0: string | number | null | undefined): string => `Администратор выключил «Сделать доступным агентам». Запишите нужное без найденного ${value0} — или спросите администратора.`,
  theAdministratorHasDisabledMakeAvailable3: (value0: string | number | null | undefined): string => `Администратор выключил «Сделать доступным агентам» в командах и проектах. Запишите нужное без найденного ${value0} — или спросите администратора.`,
  theRecordCouldNotBeChecked: "Сейчас не получилось проверить запись. Повторите через минуту.",
  theFileIsStillBeingProcessed: "Файл ещё обрабатывается. Откройте эту страницу снова, когда обработка закончится.",
  theRecordCouldNotBeChecked2: "Не получилось проверить запись. Обновите страницу через минуту.",
  onlyTheRecordAuthorCanMake: "Сделать доступным агентам может только автор записи.",
  agentsSeeOnlyRecognisedTextThey: "Агентам показан только распознанный текст: сам файл и страницы-сканы они не получают.",
  saveAsANewNote: "Записать новой заметкой",
  uploadAgain: "Загрузить заново",
  informationThatIsUsuallyHiddenFrom: "то, что обычно не показывают ИИ-агентам",
  and: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `${value0} и ${value1}`,
  inTheText: " в тексте",
  theCheckFound: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `проверка нашла${value0} ${value1}`,
  fileSavedButAgentsCannotSee: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `Файл сохранён, но агенты его пока не видят: ${value0}. Люди ${value1} видят его как обычно.`,
  fileSavedAgentsCannotSeeIt: "Файл сохранён. Агенты его пока не видят",
  peopleCanSeeItAsUsual: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `${value0}. Люди ${value1} видят его как обычно.`,
};
export const CLOSED_CLASS_TEXT: Messages<typeof en.CLOSED_CLASS_TEXT> = {
  "closedClassLine": "Запись закрытая: её видят только люди здесь, в рабочем месте, и каждое открытие попадает в журнал. Вашему ИИ-агенту она не передаётся, пока вы не покажете её агентам.",
  "closedSessionLine": "Закрытые записи вы видите здесь, в рабочем месте: по своей роли в пространстве или как участник встречи. Каждое открытие закрытой записи записывается в журнал аудита, его видно в «Моих действиях». ИИ-агентам закрытые записи не передаются. Чтобы агенты могли прочитать вашу запись, покажите её агентам.",
  "closedSpaceNotice": "Здесь видны только открытые записи: так пространство видит ИИ-агент по личному ключу. Закрытые записи люди читают в рабочем месте, войдя под своей учётной записью.",
  "closedHiddenLabel": "скрыто закрытых записей",
  "closedHiddenHint": "Здесь видны только открытые записи, как ИИ-агенту по личному ключу. У закрытых видны только дата и номер записи, без заголовка и текста.",
  "closedHiddenActions": "Свою скрытую запись можно показать агентам или удалить в корзину, не читая её: оба действия работают по номеру записи. Показать агентам можно только здесь, в рабочем месте, и прочитанное агентами назад не вернуть.",
  "openClassWarning": "После этого запись смогут читать ИИ-агенты всех, кто видит это пространство, например Claude Code или Codex. Эти агенты работают на внешних облачных моделях, поэтому текст записи уйдёт за пределы компании. Запись можно снова скрыть от агентов, но то, что они успели прочитать, останется у них.",
  "openClassLead": "Прочитанное агентами назад не вернуть.",
  "openSpaceWarning": "Записи открытого пространства читают ИИ-агенты всех участников, например Claude Code или Codex. Эти агенты работают на внешних облачных моделях, поэтому текст записей уходит за пределы компании. Название, описание и адрес пространства агенты тоже видят, а адрес попадёт в файлы репозитория (CLAUDE.md, AGENTS.md). Поэтому все три проверяются так же, как открытые записи. Если записи нельзя отдавать облачным моделям, выберите закрытое пространство.",
  "repoClosedWarning": "ИИ-агенты участников смогут записывать сюда, но не смогут прочитать записанное: ни свои записи, ни чужие. Чтобы агенты в репозитории пользовались памятью проекта, нужно открытое пространство.",
  "repoReaderWarning": "Вы здесь только читаете — и ваш ИИ-агент сможет только читать это пространство, записать в него он не сможет.",
  "closeClassWarning": "Агенты сразу перестанут находить и читать запись. Затем она вместе с исходным файлом переедет в закрытое хранилище. Агенты, которые уже прочитали запись, могли сохранить её у себя: закрытие действует на будущее.",
  "closeClassConfirm": "Скрыть запись от агентов? Агенты сразу перестанут находить и читать запись. Затем она вместе с исходным файлом переедет в закрытое хранилище. Агенты, которые уже прочитали запись, могли сохранить её у себя: закрытие действует на будущее.",
  "closedExplainTitle": "Почему часть записей скрыта",
  "showAnywayOpen": "Запись уже видна агентам.",
  "showAnywayInProgress": "Запись сейчас скрывается или показывается агентам. Обновите страницу через минуту.",
  "showAnywayClosing": "Запись сейчас скрывается от агентов. Подождите минуту и попробуйте снова.",
  "showAnywayDone": "Готово: запись показывается агентам. Через несколько секунд они смогут её читать. Скрыть её снова можно здесь же.",
  "showAnywayBecoming": "Запись становится видна агентам, это займёт несколько секунд.",
  "showAnywayRefused": "Запись не показана агентам: пока её показывали, что-то изменилось. Откройте её и посмотрите снова. Подробности — в «Моих действиях».",
  "showAnywayLook": "Посмотреть, что нашла проверка",
  "uploadKeptAgain": "Этот файл уже загружен сюда и скрыт от агентов.",
  "uploadKeptLink": "Посмотреть и показать агентам"
};
export const ACCESS_ACTION: Messages<typeof en.ACCESS_ACTION> = {
  "show": "Показать агентам",
  "hide": "Скрыть от агентов",
  "title": "Доступ для ИИ-агентов",
  "more": "Подробнее"
};
export const SHOW_AGENTS_LINES: Messages<typeof en.SHOW_AGENTS_LINES> = [
  [
    "Зачем",
    "ИИ-агенты будут находить запись и отвечать по ней — вам и коллегам, которые её видят."
  ],
  [
    "Кто увидит",
    "ИИ-агенты всех, кто видит запись, например Claude Code или Codex."
  ],
  [
    "Что уйдёт наружу",
    "Агенты работают на внешних облачных моделях: текст записи уйдёт за пределы компании, прочитанное назад не вернуть."
  ]
];
export const SHOW_ANYWAY_LINES: Messages<typeof en.SHOW_ANYWAY_LINES> = {
  "found": "Что нашла проверка",
  "who": "Кто увидит",
  "undo": "Можно ли вернуть",
  "scope": "На что действует согласие"
};
export const SHOW_ANYWAY_STALE: Messages<typeof en.SHOW_ANYWAY_STALE> = {
  "changed": "Запись изменилась, пока была открыта эта страница. Посмотрите ещё раз, что нашла проверка.",
  "more_found": "Проверка нашла в записи что-то новое. Посмотрите ещё раз, что она нашла.",
  "audience": "Изменилось, кто видит запись. Посмотрите ещё раз, кто её увидит.",
  "expired": "Страница была открыта слишком долго. Память проверила запись заново — посмотрите ещё раз.",
  "consent_required": "Страница устарела. Обновите её и подтвердите ещё раз.",
  "consent_invalid": "Страница устарела. Обновите её и подтвердите ещё раз."
};
