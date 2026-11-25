import type { Messages } from "../../i18n/core";
import type * as en from "./en";
export const texts: Messages<typeof en.texts> = {
  spacesAndProjects: "Пространства и проекты",
  youDoNotHaveAnySpacesYet: "У вас пока нет ни одного пространства. Обратитесь к администратору памяти.",
  spacesAndProjects2: "Пространства и проекты",
  sharedMemoryFoldersEachHasItsOwn: "Общие папки памяти: у каждой свой круг людей.",
  noProjectsYet: "Проектов пока нет.",
  hideArchive: "Скрыть архив",
  completedProjectsAndTeamsReadOnly: "Завершённые проекты и команды: только чтение.",
  whatYouCanDoWithArchivedRecords: "Что можно с архивными",
  archive: "архив",
  nothingFurther: "Дальше пусто.",
  theArchiveIsEmpty: "В архиве ничего нет.",
  archivedBy: (value0: unknown): string => `, отправил ${value0}`,
  archived: "в архиве",
  back: "Назад",
  spacesAndProjects3: "Пространства и проекты",
  spacesAndProjects4: "Пространства и проекты",
  newProjectLine: "<tag1/>Новый проект",
  projectArchiveLine: "<tag1/>Архив проектов",
  archivedSinceLine: "в архиве с {value1}{value2}",
  projectArchiveLine2: "<tag1/>Архив проектов<tag2/>",
  projectPageLine: "<tag1/>Страница проекта",
  projectPageLine2: "<tag1/>Страница проекта",
  openColleaguesLine: "<tag1/><tag2>{value1} <tag3>Открыть «Сотрудников»</tag3></tag2>",
};

export const spaceRecords: Messages<typeof en.spaceRecords> = {
  folders: "Папки",
  decisionTypes: "Виды решений",
  allRecordsAreInTheFoldersAbove: "Все записи — по папкам выше.",
  path: "Путь",
  goToSpacesAndProjects: "К пространствам и проектам",
  search: "Поиск",
  closedRecordTitleHiddenHere: "Закрытая запись — название здесь не видно",
  whatToDoWithIt: "Что с ней сделать",
  generatedAutomaticallyPleaseCheck: "Составлено автоматически — проверьте",
  generatedAutomatically: "составлено автоматически",
  recentRecordsLine: "<tag1/>Последние записи",
  listCouldNotBeLoadedLine: "Список не загрузился: {value1}",
  pageNotFoundTheLinkMayLine: "<tag1>Не нашли эту страницу.</tag1> Возможно, ссылка устарела или у вас нет доступа. {value1}",
  listCouldNotBeLoadedLine2: "<tag1>Список не загрузился.</tag1> {value1}",
  whatThisMeansLine: "<tag1/><tag2>{value1}: {value2}. <tag3>Что это значит</tag3></tag2>",
  noVisibleRecordsHereYourOwnLine: "Видимых записей здесь нет: {value1} — {value2}. Свои закрытые записи и действия с ними — в <tag1>«Моих записях»</tag1>.",
  moreRecordsLine: "Ещё записи<tag1/>",
};

export const spaceParts: Messages<typeof en.spaceParts> = {
  whatThisMeans: "Что это значит",
  whatThisMeans2: "Что это значит",
};
