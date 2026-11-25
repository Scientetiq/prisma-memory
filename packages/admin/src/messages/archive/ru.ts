import type { Messages } from "../../i18n/core";
import type * as en from "./en";
export const archive: Messages<typeof en.archive> = {
  completedProjectsAndTeamSpacesYouCan: "Завершённые проекты и командные пространства, которые вы читаете. Только чтение: записи можно читать, удалять и скрывать от агентов, но не добавлять и не переносить. Поиск находит их только с отметкой «Искать и в архиве».",
  theProjectIsFinishedArchiveItRecords: "Проект закончился — отправьте его в архив. Записи останутся: участники читают их, поиск находит их только с отметкой «Искать и в архиве». Писать, переносить сюда и восстанавливать из корзины в архивный проект нельзя. Вернуть из архива можете вы или администратор памяти.",
  records: (value0: unknown): string => ` Записей: ${value0}.`,
  archiveProjectAgentsWillNoLongerWrite: (value0: unknown, value1: unknown): string => `Отправить проект «${value0}» в архив?${value1} Агенты перестанут писать сюда, поиск по умолчанию перестанет их находить.`,
  theProjectIsFinishedAgentsNoLonger: "Проект закончился: агенты больше не пишут сюда",
  youOrTheMemoryAdministratorCanRestore: "Вернуть из архива можете вы или администратор памяти.",
  transferOwnershipOfTo: (value0: unknown): string => `Передать владение «${value0}» — {}?`,
  youWillRemainAMemberTheNew: "Вы останетесь участником: составом, группами сотрудников и названием будет распоряжаться новый владелец.",
  theProjectWillBecomeActiveAgainMembers: "Проект снова станет обычным: агенты участников смогут писать сюда, поиск — находить его записи.",
  projectArchived: "Проект отправлен в архив.",
  anyProjectRecordsRemainMembersCanRead: "Записи проекта, если они были, остались: участники их читают, поиск находит их только с отметкой «Искать и в архиве»; проект с записями виден в «Пространствах и проектах» → «Архив проектов». Вернуть проект можно здесь же — «Вернуть из архива».",
  projectActiveAgain: "Проект снова действует.",
  membersAgentsCanWriteHereAgainAnd: "Агенты участников снова могут писать сюда, поиск по умолчанию находит его записи. Состав по группам сотрудников сверится с каталогом компании.",
  theProjectIsArchivedAgentsCannotWrite: "Проект в архиве: агенты сюда не пишут. Уберите строку подключения из CLAUDE.md или AGENTS.md в репозиториях проекта.",
  whileTheProjectIsArchivedYouCannot: "Пока проект в архиве, название, описание и владельца не меняют, новых участников и группы не добавляют: убрать участника или отвязать группу — можно. Чтобы снова всё менять, верните проект из архива.",
  roleAndMembershipBasisWhileTheProject: "Роль и основание участия. Пока проект в архиве, участников можно только убирать. Кто вышел из группы сотрудников, участие теряет; новые члены группы участниками не становятся.",
  includeArchivedRecords: "Искать и в архиве",
  recordsFromCompletedProjects: "записи завершённых проектов",
  theSpaceIsArchivedReadOnlySearch: "Пространство в архиве: только чтение. Поиск находит его записи только с отметкой «Искать и в архиве».",
  unarchiveConfirm: ((value0: unknown): string => `Вернуть проект из архива? ${value0}`)("Проект снова станет обычным: агенты участников смогут писать сюда, поиск — находить его записи."),
  archivedGroupsHint: "Пока проект в архиве, группу можно только отвязать. Кто вышел из группы, участие теряет; новые члены группы участниками не становятся. "
  + /* i18n */ "While the company directory does not answer, membership through groups is kept until the expiry set by the memory administrator passes without a successful sync, then removed until the directory answers.",
};

export const ARCHIVE_TEXT: Messages<typeof en.ARCHIVE_TEXT> = {

  archivedReadonly: "Только чтение: записи можно читать, удалять и скрывать от агентов, но не добавлять, не переносить и не показывать агентам.",

  trashArchived: "Пространство в архиве — сюда не восстановить. Сначала его вернёт из архива владелец или администратор памяти.",

  openInArchive: "Пространство в архиве: показать агентам получится, только если запись скрыли от них уже после того, как пространство ушло в архив.",
};

export const TRANSFER_SPEC: Messages<typeof en.TRANSFER_SPEC> = {
  question: "Передать владение пространством?",
  change: "Составом, группами сотрудников и названием будет распоряжаться новый владелец, вы останетесь участником.",
  undo: "Вернуть владение может только он или администратор памяти.",
  danger: true,
  ack: { label: "Понимаю: после передачи я — участник, распоряжается новый владелец" },
};
