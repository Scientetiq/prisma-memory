import { pluralRu } from "../../i18n/core";
import type { Messages } from "../../i18n/core";
import type * as en from "./en";
export const orgReview: Messages<typeof en.orgReview> = {
  noCurators: (days: number | null): string => `Кураторов нет: новые записи общих знаний компании никто не проверяет — они возвращаются сами${days ? ` через ${days} ${pluralRu(days, ["день", "дня", "дней"])}` : " по сроку"}, а недельное письмо не уходит никому.`,
  curatorsHint: (days: number | null, title: string): string => "Руководитель первой команды и 1–2 заместителя. Новые записи общих знаний компании сразу видны всем с пометкой «не подтверждено»; " + `кураторы раз в неделю подтверждают, возвращают в проект или удаляют их в рабочем месте (раздел «${title}»), любой куратор действует за всех. ` + `Без подтверждения запись сама возвращается туда, откуда пришла${days ? `, через ${days} ${pluralRu(days, ["день", "дня", "дней"])}` : ""}.`,
  confirmUsefulRecordsAndReturnTheRest: "Подтвердите полезное, верните остальное — обычно 10 минут в неделю.",
  nothingToReview: "Проверять нечего.",
  return: "Вернуть",
  showingOfTheRestAreOnLater: (value0: unknown, value1: unknown): string => `Показаны ${value0} из ${value1}: остальные — на следующих страницах или появятся здесь после решений по этим.`,
  wasHereBeforeReview: "была здесь до проверки",
  fromAnotherSpace: "из другого пространства",
  fromTheAuthorSPersonalSpace2: "из личного пространства автора",
  from: (value0: unknown): string => `из «${value0}»`,
  toTheAuthorSPersonalSpace: "в личное пространство автора",
  toItsOriginalSpace: "туда, откуда она пришла",
  to: (value0: unknown): string => `в «${value0}»`,
  returnTheRecordColleaguesWithoutAccessThere: (value0: unknown): string => `Вернуть запись ${value0}? Её перестанут видеть сотрудники, у которых нет доступа туда. Автор увидит это в «Моих действиях».`,
  forDays: (value0: unknown): string => ` на ${value0} дн.`,
  deleteTheRecordItWillReturnAnd: (value0: unknown, value1: unknown): string => `Удалить запись? Она вернётся ${value0} и сразу уйдёт там в корзину${value1}; восстановить её может автор — там, а не в «Общих знаниях компании».`,
  wrong: "Неверно",
  notForEveryone: "Не для всех",
  hiddenFromAgents: "скрыта от агентов",
  peopleMarkedWrongNotForEveryoneAgents: "Люди отметили «Неверно / не для всех»: агенты её не находят, пока вы не решите",
  marksRemovedAwaitingADecision: "отметки сняты — ждёт решения",
  everyoneWhoMarkedItHasRemovedTheir: "Все отметившие сняли отметку: агенты снова её находят, но решение за куратором",
  useful: (value0: unknown): string => `Полезно: ${value0}`,
  confirmedByTheCommunity: "подтверждена сообществом",
  addedByAnAgentWithExtendedAccess: "записал агент с расширенным доступом",
  aCuratorReviewsTheseRecordsEvenWhen: "Такие записи куратор смотрит в любом случае, даже подтверждённые сообществом",
  authorHasLeftNowhereToReturnIt: "автор уволен — вернуть некуда",
  confirmOrDeleteTheRecordItCannot: "Подтвердите запись или удалите её: сама она не вернётся",
  reviewPeriodEnded: "срок вышел",
  willReturnAtTheNextCheckUnless: "Вернётся при ближайшей проверке, если вы её не подтвердите",
  readershipRestrictedTitleHidden: "Круг читателей сужен — название скрыто",
  youCannotSeeThisRecordACurator: "Вам эта запись не видна: открыть её и решить может куратор, который входит в круг её читателей.",
  willNotReturnAutomatically: "сама не вернётся",
  willNotReturnUntilYouDecide: "не вернётся, пока вы не решите",
  confirmedByTheCommunityWillNotReturn: "подтверждена сообществом, по сроку не вернётся",
  willReturnOn: (value0: unknown): string => `вернётся ${value0}`,
  noDeadline: "без срока",
  curatorsHaveNotReviewedThisRecordYet: "Кураторы эту запись ещё не проверяли.",
  ifItContainsAnErrorOrInformation: "Видите ошибку или сведения не для всех — отметьте «Неверно / не для всех»: ИИ-агенты перестанут её находить до решения куратора.",
  thisIsAnEarlierVersionMarkWrong: "Это прежняя версия записи: «Неверно / не для всех» отмечают на текущей версии.",
  theOrgTableFillsInColleagueCards: "Карточку сотрудника заполняет орг-таблица: кураторы её не возвращают; ошибку в ней исправляют в орг-таблице.",
  markedWrongNotForEveryoneAgentsCannot: "Отмечено «Неверно / не для всех»: агенты её не находят до решения куратора. Люди видят её с этой пометкой.",
  theWrongNotForEveryoneMarksHave: "Отметки «Неверно / не для всех» сняты: агенты снова её находят, но она ждёт решения куратора.",
  willReturnTo: (value0: unknown): string => `вернётся в «${value0}»`,
  willReturnToYourPersonalSpace: "вернётся в ваше личное пространство",
  willReturnToTheAuthor: "вернётся автору",
  ifItIsNotConfirmedByIt: (value0: unknown, value1: unknown): string => ` Если до ${value0} её не подтвердят, она ${value1}.`,
  unconfirmedAllColleaguesAndTheirAgentsCan: (value0: unknown): string => `Не подтверждено: запись видна всем сотрудникам и их агентам, но стоит ниже в поиске. Кураторы проверяют раз в неделю.${value0}`,
  confirmedByACuratorWillNotReturn: "Подтверждено куратором: по сроку не вернётся.",
  confirmedByTheCommunityColleaguesFromDepartments: (value0: unknown): string => `Подтверждено сообществом: «Полезно» отметили сотрудники ${value0} подразделений. По сроку не вернётся.`,
  addedByAnAiAgentWithExtended: "Записал ИИ-агент с расширенным доступом — куратор посмотрит её в любом случае.",
  to2: (value0: unknown): string => `в «${value0}»`,
  toYourPersonalSpace: "в ваше личное пространство",
  removeTheRecordFromCompanyKnowledgeColleagues: (value0: unknown): string => `Убрать запись из «Общих знаний компании» ${value0}? Её перестанут видеть сотрудники, у которых нет доступа туда.`,
  wrong2: "Неверно",
  notForEveryone2: "Не для всех",
  youMarked: (value0: unknown): string => `Вы отметили: «${value0}».`,
  after: (value0: unknown, value1: unknown): string => `, через ${value0} ${value1}`,
  nothingAwaitingReview: "На проверке ничего нет.",
  hiddenAsWrongNotForEveryone: (value0: unknown): string => ` · скрыто «Неверно / не для всех»: ${value0}`,
  awaitingReviewNewThisWeek: (value0: unknown, value1: unknown, value2: unknown): string => `На проверке: ${value0} (новых за неделю: ${value1})${value2}`,
  oldestSince: (value0: unknown): string => ` · самая давняя — с ${value0}`,
  returningAutomaticallyInTheNext7Days: (value0: unknown, value1: unknown): string => ` · вернутся сами в ближайшие 7 дней: ${value0}${value1}.`,
  weeklyCuratorEmailIsDisabledInSettings: "Недельное письмо кураторам выключено в настройках (раздел «Доступ»).",
  monday2: "понедельник",
  onAt: (value0: unknown, value1: unknown, value2: unknown): string => `в ${value0} в ${value1} (${value2})`,
  curatorEmailWhenThereAreRecordsTo: (value0: unknown): string => `Письмо кураторам — ${value0}, если есть что проверять: числа и ссылка, без названий записей.`,
  curatorEmailButEmailIsDisabledNothing: (value0: unknown): string => `Письмо кураторам — ${value0}, но почта выключена: писем нет.`,
  lastReviewPeriodCheck: (value0: unknown): string => `Последняя проверка сроков — ${value0}`,
  returnedAutomatically: (value0: unknown): string => `вернулось по сроку: ${value0}`,
  returnedAfterReadershipWasRestricted: (value0: unknown): string => `вернулось после сужения круга читателей: ${value0}`,
  emailForTheWeek: (value0: unknown): string => `письмо за неделю ${value0}`,
  emailForWeek: (value0: unknown): string => `письмо недели ${value0}`,
  notSent: (value0: unknown): string => `${value0}: не отправлялось`,
  reviewTitle: "Проверка общих знаний",
};

export const REVIEW_MORE: Messages<typeof en.REVIEW_MORE> = [
  "Здесь новые записи «Общих знаний компании». Любой куратор действует за всех.",
  "Без подтверждения запись сама вернётся туда, откуда пришла, когда выйдет её срок.",
  "Записи, которые люди отметили «Неверно / не для всех», скрыты от агентов до вашего решения и стоят первыми.",
] as const;

export const REVIEW_FOR_EMPLOYEE: Messages<typeof en.REVIEW_FOR_EMPLOYEE> = {
  title: "Этот раздел — для кураторов «Общих знаний компании»",
  what: "Кураторы раз в неделю проверяют новые записи «Общих знаний компании»: подтверждают полезное, а неподтверждённое само возвращается туда, откуда пришло.",
  you: "Что можете вы: на странице такой записи отметить «Полезно» или «Неверно / не для всех». Вторая отметка сразу скрывает запись от агентов до решения куратора.",
  who: "Кураторов назначает администратор памяти.",
  open: ((value0: unknown): string => `Открыть «${value0}»`)("Общие знания компании"),
} as const;

export const FROM_KIND: Messages<typeof en.FROM_KIND> = { project: "из проекта", team: "из команды", personal: "из личного пространства автора" };

export const ORG_REVIEW_TEXT: Messages<typeof en.ORG_REVIEW_TEXT> = {
  confirmReview: "Подтвердить запись для всех? Пометка «не подтверждено» снимается, по сроку она не вернётся, агенты снова её находят.",

  orgNarrowHint: "Встреча лежит в «Общих знаниях компании», где её видят все сотрудники. После смены состава её будут видеть только организатор и участники, и она вернётся туда, откуда её перенесли.",

  orgNarrowStayHint: "Встреча лежит в «Общих знаниях компании», где её видят все сотрудники. После смены состава её будут видеть только организатор и участники.",
  usefulHint: "Две отметки «Полезно» из разных подразделений — и запись подтверждена сообществом: она не вернётся по сроку. Отметка без подразделения учитывается, но в подтверждение не идёт.",
  wrongConfirm: "Запись сразу перестанет находиться агентами — до решения куратора. Кураторы увидят вашу отметку и ваше имя.",
  wrongHint: "«Неверно» — напишите, что верно: это станет исправлением записи. «Не для всех» — можно без слов.",
};

export const VIEW_BADGE: Messages<typeof en.VIEW_BADGE> = {
  unreviewed: { text: "не подтверждено" },
  confirmed: { text: "подтверждено куратором" },
  community: { text: "подтверждено сообществом" },
  disputed: { text: "отмечено «Неверно / не для всех»" },
};

export const WRONG_REASONS: Messages<typeof en.WRONG_REASONS> = [
  { label: "Неверно — в записи ошибка" },
  { label: "Не для всех — здесь закрытые сведения" },
];

export const ORG_DONE: Messages<typeof en.ORG_DONE> = {
  useful: "Отметка «Полезно» поставлена.",
  unuseful: "Отметка «Полезно» снята.",
  wrong: "Отметка поставлена: агенты не находят запись до решения куратора.",
  unwrong: "Ваша отметка снята.",
  confirm: "Запись подтверждена для всех.",
  return: "Запись возвращена.",
  delete: "Запись возвращена и удалена в корзину.",
};

export const ORG_PARTIAL: Messages<typeof en.ORG_PARTIAL> = {
  delete_partial: "Запись вернули автору, а удалить там не удалось — удалить её может автор или владелец того пространства.",
} as const;

export const WEEKDAYS: Messages<typeof en.WEEKDAYS> = ["понедельник", "вторник", "среду", "четверг", "пятницу", "субботу", "воскресенье"];
