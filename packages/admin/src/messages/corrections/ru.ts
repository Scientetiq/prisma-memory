import { text as closed } from "../closed-class/ru";
import type { OpenCheckMark } from "../../lib/types";
import type { CorrectionView } from "../../lib/types";
import type { Messages } from "../../i18n/core";
import * as en from "./en";
export const text: Messages<typeof en.text> = {
  closedCheckResult: (mark: OpenCheckMark): string => text.closedResult(closed.reasonSummary(mark, false)),

  ownTextTitle: (type: string, event: string | null): string => text.changeText((event ? OWN_TEXT_NOUN[event] : null) ?? OWN_TYPE_NOUN[type] ?? text.record),
  actorsField: (event: string | null): string => text.separatedByCommas(event === "action" ? text.whoDoesIt : event === "decision" ? text.whoDecided : text.whoSaidIt),
  decidedLine: (status: string, role: keyof typeof DECIDED_BY_TITLES, day: string): string => status === "rejected" ? text.rejectedBy(DECIDED_BY_TITLES[role], day) : text.confirmedBy(DECIDED_BY_TITLES[role], day),
  correctionLine: (v: Pick<CorrectionView, "status" | "kind" | "by_role" | "quote_checked" | "effect" | "newer" | "via" | "link_status">, day: string): string => {
    const who = CORRECTION_BY_TITLES[v.by_role] ?? CORRECTION_BY_TITLES.reader;
    if (v.status === "proposed") return text.proposedByAwaitingADecision(who, day);
    let line: string;
    switch (v.kind) {
      case "extraction_error": line = text.correctedBy(who, day, v.quote_checked ? text.confirmedByAPhrase : text.notConfirmedByAQuote); break;
      case "outdated": line = v.effect === "link" ? v.newer?.title ? text.markedAsReplacedBy(v.newer.title, day) : text.markedAsReplacedByANewer(day) : text.markedByAsNoLongerValid(who, day); break;
      case "own_note": line = text.noteReplacedBy(who, day); break;
      default: line = text.correctedBy2(who, day);
    }
    if (v.via === "mcp" && v.link_status === "active") line += text.byAnAgentUnconfirmed;
    if (v.via === "plan") line += text.byChangePlan;
    return line;
  },
  proposedAssignees: (names: readonly string[]): string => text.assignees(names.length ? names.join(", ") : text.noAssignees),
  proposedNewer: (title: string | null): string => text.newerRecord2(title || text.untitled),
  knownResult: (applied: boolean): string => text.thisCorrectionAlreadyExists(applied ? text.applied : text.awaitingADecision),
  closedResult: (why: string | null): string => text.savedButOnlyPeopleCanSee(why ? `: ${why}` : text.informationThatCannotBeShownTo),

  otherCases: "Другие случаи",
  record: "записи",
  changeText: (value0: string | number | null | undefined): string => `Изменить текст ${value0}`,
  whoDoesIt: "Кто делает",
  whoDecided: "Кто решил",
  whoSaidIt: "Кто сказал",
  separatedByCommas: (value0: string | number | null | undefined): string => `${value0} (через запятую)`,
  currentlyChooseADateToReplace: (value0: string | number | null | undefined): string => `Сейчас: «${value0}». Выберите дату, чтобы заменить; если оставить пустым, срок не изменится.`,
  applied: "применено",
  awaitingADecision: "ждёт решения",
  theCorrectionIsSavedInMemory: "Исправление сохраняется в памяти: следующий агент уже не повторит ошибку. Прежний вариант не стирается — он остаётся в истории записи.",
  theRecordAuthorMeetingParticipantsAnd: "Исправить сразу могут автор записи, участники встречи и владелец пространства — ваше исправление уйдёт им на подтверждение.",
  afterSavingYourAiAgentsWill: "После сохранения ваши ИИ-агенты перестанут видеть эту запись, а прежняя версия уйдёт в корзину.",
  yourAiAgentsWillContinueTo: "Ваши ИИ-агенты продолжат видеть запись, если автоматическая проверка ничего не найдёт в названии и тексте. Если найдёт — новая версия будет видна только людям, и вы увидите почему.",
  thisIsALongNotePaste: "Заметка длинная: вставьте новый текст целиком.",
  transcriptExcerptAroundTheEventCopy: "Фрагмент стенограммы вокруг события — скопируйте фразу отсюда:",
  aNewMeetingVersionResetsCorrections: "Новая версия встречи сбрасывает исправления: если встречу загрузят заново, решения извлекутся заново, а исправления этой версии к новой не перейдут — их нужно будет внести снова.",
  ifTheSameAssigneeWasRecorded: "Если исполнителя записали неверно сразу в нескольких решениях — замените его везде одним планом. Вы проверите список и примените его на странице плана.",
  proposalSentUntilItIsApproved: "Предложение отправлено. Пока его не подтвердят, его видите вы и те, кто может его подтвердить.",
  confirmThisCorrectionEveryoneWhoCan: "Подтвердить исправление? Его увидят все, кто видит запись.",
  confirmThatTheCorrectionIsAccurate: "Подтвердить, что исправление верное? Пометка „не подтверждено“ исчезнет.",
  removeThisCorrectionItWillNo: "Снять исправление? Оно перестанет действовать.",
  memoryCorrectionsAwaitingYourDecisionAnd: "Исправления памяти, которые ждут вашего решения, и те, что предложили вы.",
  colleaguesProposedCorrectionsToRecordsYou: "Коллеги предложили исправить записи, которые вы вправе исправлять сами. Пока никто не решил, предложение видят его автор и все, кто может его подтвердить; после подтверждения — все, кто видит запись.",
  correctionsYouMadeOrProposedWhile: "Что вы исправили или предложили исправить. Пока предложение ждёт решения, его видите вы и те, кто может его подтвердить, — и его можно отозвать.",
  applied2: "Применено",
  awaitingADecision2: "Ждёт решения",
  rejected2: "Отклонено",
  withdrawn2: "Отозвано",
  outOfDateRecordChanged2: "Устарело: запись изменилась",
  planCancelledNotApplied: "План отменён — не применено",
  notSavedTryAgain: "Не записалось — повторите",
  notApplied2: "Не применено",
  rejectedBy: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `Отклонил ${value0} · ${value1}`,
  confirmedBy: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `Подтвердил ${value0} · ${value1}`,
  theRecordOrCorrectionIsUnavailable: "Запись или исправление недоступны: их нет или у вас нет права.",
  noDecisionInThisMeetingHas: "Ни в одном решении этой встречи нет такого исполнителя.",
  theMeetingIsBeingMovedBetween: "Встреча сейчас переносится между классами — попробуйте через минуту.",
  theMeetingSSpaceIsArchived: "Пространство встречи в архиве — его записи не меняются.",
  meetingParticipantsTheAuthorAndThe: "Исправлять решения этой встречи сразу или предложением могут её участники, автор и владелец пространства — у вас такого права нет.",
  changeAtLeastOneFieldTitle: "Измените хотя бы одно поле: название, суть, срок или исполнителей.",
  changeTheNoteTextOrTitle: "Измените текст или название заметки.",
  confirmedByAPhrase: "фразой подтверждено",
  notConfirmedByAQuote: "цитатой не подтверждено",
  correctedBy: (value0: string | number | null | undefined, value1: string | number | null | undefined, value2: string | number | null | undefined): string => `Исправлено ${value0} ${value1} · ${value2}`,
  markedAsReplacedBy: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `Отмечено: заменено записью „${value0}“ ${value1}`,
  markedAsReplacedByANewer: (value0: string | number | null | undefined): string => `Отмечено: заменено более новой записью ${value0}`,
  markedByAsNoLongerValid: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `Отмечено ${value0}: больше не действует ${value1}`,
  noteReplacedBy: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `Заметка заменена ${value0} ${value1}`,
  correctedBy2: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `Исправлено ${value0} ${value1}`,
  byAnAgentUnconfirmed: " (агентом, не подтверждено)",
  byChangePlan: " · по плану",
  proposedByAwaitingADecision: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `Предложено ${value0} ${value1} — ждёт решения`,
  correctionRecord: "запись-исправление",
  newerRecord: "более новая запись",
  correction: "Исправление",
  title: (value0: string | number | null | undefined): string => `Название: ${value0}`,
  statement: (value0: string | number | null | undefined): string => `Суть: ${value0}`,
  dueDateRemoved: "Срок: снят",
  dueDate: (value0: string | number | null | undefined): string => `Срок: ${value0}`,
  noAssignees: "без исполнителей",
  assignees: (value0: string | number | null | undefined): string => `Исполнители: ${value0}`,
  phrase: (value0: string | number | null | undefined): string => `Фраза: „${value0}“`,
  untitled: "Без названия",
  newerRecord2: (value0: string | number | null | undefined): string => `Более новая запись: „${value0}“`,
  newerRecordYouDoNotHave: "Более новая запись: вам недоступна",
  thisCorrectionAlreadyExists: (value0: string | number | null | undefined): string => `Такое исправление уже есть (${value0}).`,
  openCorrectedRecord: "Открыть исправленную запись",
  savedOnlyPeopleCanSeeThe: "Сохранено. Новая версия видна только людям, прежняя — в корзине.",
  savedYourAiAgentsCanSee: "Сохранено. Ваши ИИ-агенты видят исправленную запись.",
  informationThatCannotBeShownTo: " то, что нельзя показывать ИИ-агентам",
  savedButOnlyPeopleCanSee: (value0: string | number | null | undefined): string => `Сохранено, но новая версия видна только людям: автоматическая проверка нашла${value0}. Прежняя версия — в корзине.`,
  correctedWithoutAConfirmingPhraseThe: "Исправлено без подтверждения фразой — у записи пометка „цитатой не подтверждено“.",
  correctedAgentsWillFindTheCorrected: "Исправлено. Агенты находят исправленный вариант.",
  correctionSavedAlongsideTheRecordSearch: "Исправление сохранено рядом с записью: поиск находит обе.",
  markedAsReplacedByANewer2: "Отмечено: запись заменена более новой. Агентам отвечайте по более новой записи — в выдаче поиска пометка пока не показывается.",
  titleCannotBeEmpty: "Название не может быть пустым.",
  titleMustBeAtMost200: "Название — до 200 знаков.",
  statementCannotBeEmpty: "Суть не может быть пустой.",
  statementMustBeAtMost2: "Суть — до 2 000 знаков.",
  enterADueDateOrSelect: "Укажите срок или отметьте «Срока нет» — не то и другое.",
  chooseADueDateFromThe: "Срок — дата из календаря.",
  useNoMoreThan20Assignees: "Исполнителей — не больше 20.",
  anAssigneeSNameMustBe: "Имя исполнителя — до 120 знаков.",
  thisExactPhraseWasNotFound: "Эта фраза не нашлась в стенограмме дословно. Скопируйте её из фрагмента выше или сохраните без фразы.",
  thePhraseCouldNotBeChecked: "Фразу не успели сверить со стенограммой — ничего не изменено. Повторите через минуту или сохраните без фразы.",
  youCannotSeeThisMeetingS: "Стенограмма этой встречи вам не видна — сохраните исправление без фразы.",
  thisKindOfCorrectionDoesNot: "Такое исправление к этой записи не подходит.",
  thisRecordHasAlreadyBeenCorrected: "Эту запись уже исправили — исправляйте действующий вариант.",
  aPersonMustPerformThisAction: "Эту операцию выполняет человек: откройте её в рабочем месте.",
  tooLongUseAtMost2: "Слишком длинно: до 2 000 знаков — скажите коротко, что верно.",
  theSpecifiedRecordIsOlderThan: "Указанная запись старше исправляемой — укажите ту, что её заменила.",
  theAuthorOfTheRecordBeing: "Эту запись не видит автор исправляемой — выберите запись из того же пространства.",
  thisSpaceIsArchivedItsRecords: "Пространство в архиве: исправлять в нём нельзя.",
  theNoteAuthorAndSpaceOwner: "Заменить заметку могут её автор и владелец пространства.",
  theRecordAuthorMeetingParticipantsAnd2: "Исправлять эту запись могут её автор, участники встречи и владелец пространства.",
  aDecisionHasAlreadyBeenMade: "Решение уже принято или предложение отозвано.",
  theRecordChangedAfterThisProposal: "Запись изменилась после предложения — предложение устарело. Если поправка ещё нужна, предложите её заново.",
  aNewVersionCannotBeRejected: "Новый вариант записи не отклоняют — исправьте её ещё раз.",
  thisMeetingHasTooManyEvents: "У встречи слишком много событий для одного плана — обратитесь к администратору.",
  theSpecifiedNewerRecordHasItself: "Указанная более новая запись сама уже заменена — вставьте адрес её действующего варианта.",
  theNoteTextIsTooLong: "Текст заметки слишком длинный: сократите его или загрузите документом в «Мои записи».",
  theRecordIsBeingChangedTry: "Запись сейчас меняют — повторите через минуту.",
  checkTheFormFieldsSomethingIs: "Проверьте поля формы: что-то заполнено не так.",
  openCurrentVersion: "Открыть действующий вариант",
  rejectedLine: "Отклонено",
  withdrawnLine: "Отозвано",
  outOfDateRecordChangedLine: "Устарело: запись изменилась",
  notAppliedLine: "Не применено",
};
export const CORRECTION_KIND_TITLES: Messages<typeof en.CORRECTION_KIND_TITLES> = {
  "extraction_error": "Встреча записана с ошибкой (срок, исполнитель, суть)",
  "wrong": "Неверно по существу",
  "outdated": "Больше не действует",
  "own_note": "Заменить текст заметки"
};
export const OWN_TEXT_NOUN: Messages<typeof en.OWN_TEXT_NOUN> = {
  "decision": "решения",
  "action": "задачи",
  "question_risk": "записи о риске",
  "fact": "факта"
};
export const OWN_TYPE_NOUN: Messages<typeof en.OWN_TYPE_NOUN> = {
  "note": "заметки",
  "document": "документа",
  "profile": "карточки",
  "summary": "резюме",
  "event": "записи"
};
export const CORRECTION_KIND_HINTS: Messages<typeof en.CORRECTION_KIND_HINTS> = {
  "extraction_error": "Неверно записаны срок, исполнитель, суть или название. Исправьте поля; если можете — вставьте фразу из стенограммы, которая это подтверждает.",
  "wrong": "На встрече или в документе так сказали, но это неправда. Запись останется как есть, рядом появится ваше исправление.",
  "outdated": "Решение отменили или заменили. Если есть более новая запись — вставьте её адрес: агенты будут опираться на неё.",
  "own_note": "Искаться будет новый текст, прежний останется в истории."
};
export const CORRECTION_STATE_TITLES: Messages<typeof en.CORRECTION_STATE_TITLES> = {
  "applied": "применено",
  "proposed": "ждёт решения",
  "rejected": "отклонено",
  "withdrawn": "отозвано",
  "superseded": "устарело: запись изменилась",
  "cancelled": "не применено",
  "planned": "не применено"
};
export const CORRECTION_BY_TITLES: Messages<typeof en.CORRECTION_BY_TITLES> = {
  "author": "автором записи",
  "space_owner": "владельцем пространства",
  "participant": "участником встречи",
  "space_member": "участником пространства",
  "reader": "коллегой"
};
export const OLD_VERSION: Messages<typeof en.OLD_VERSION> = {
  "visible": "Это прежний вариант записи. Действующий — исправленный:",
  "hidden": "Это прежний вариант записи. Действующий вариант вам недоступен.",
  "none": "Эта запись больше не действует."
};
export const CORRECTIONS_SECTIONS: Messages<typeof en.CORRECTIONS_SECTIONS> = {
  "toConfirm": "Ждут вашего решения",
  "mine": "Ваши исправления",
  "whoSees": "Кто это видит?"
};
export const CORRECTIONS_EMPTY: Messages<typeof en.CORRECTIONS_EMPTY> = {
  "toConfirm": "Сейчас ничего не ждёт вашего решения. Когда коллега предложит исправить вашу запись, она появится здесь.",
  "mine": "Нашли ошибку? Откройте запись и нажмите «Исправить» — прежний вариант сохранится в истории записи."
};
export const DECIDED_BY_TITLES: Messages<typeof en.DECIDED_BY_TITLES> = {
  "author": "автор записи",
  "space_owner": "владелец пространства",
  "participant": "участник встречи",
  "space_member": "участник пространства",
  "reader": "коллега"
};
export const DECISION_DONE: Messages<typeof en.DECISION_DONE> = {
  "confirm": "Исправление подтверждено",
  "reject": "Исправление отклонено",
  "withdraw": "Исправление отозвано"
};
