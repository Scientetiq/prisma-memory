import { formatCount } from "../../i18n/format";
// Messages in the language of the current request. One export per dictionary.
import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const ATTENTION_TEXT: Messages<typeof en.ATTENTION_TEXT> = {
  report: "отчёт",
  noLogin: "Не настроен ни один способ входа: в рабочее место не входит никто",
  ldap: "Вход и LDAP",
  sso: "Единый вход",
  missing: (missing: readonly string[]): string => `Не заполнены обязательные настройки (${missing.length}): ${missing.join(", ")}`,
  groupBinds: "привязки групп в отчёте",
  groupSyncFailed: "Сверка групп каталога не удалась: каталог не ответил, участие по группам не менялось",
  operator: (u: { login: string; person: string | null }): string => `${u.person ? `Человек за ${u.login} неактивен` : `Не указано, кто работает под ${u.login}`}: расширенный доступ ко всей памяти (уровень 5) выдать нельзя`,
  assign: "указать",
  orgNoOwner: "У общих знаний компании нет владельца: некому удалять и продвигать записи",
  assignSpaces: "назначить в «Пространствах»",
  leftoversFailed: "Уборка тестовых остатков остановлена сбоем — удаление и отправка в архив не идут",
  deletion: (count: number): string => `Участники просят удалить встречи: ${formatCount(count)}`,
  deletionRequests: "просьбы удалить",
  openNew: (openNew: number): string => `Новых открытых пространств за сутки: ${formatCount(openNew)} — их записи читают облачные агенты участников`,
  orphans: (orphans: number): string => `Пространств без действующего владельца: ${formatCount(orphans)} — владелец уволен или отключён, назначьте нового`,
  noHead: (noHead: number): string => `Подразделений без действующего руководителя и назначенного владельца: ${formatCount(noHead)} — их пространствами пока управляет только администратор памяти. Отметьте руководителей в кадровом списке или назначьте владельцев пространств`,
  staleTest: (staleTest: number): string => `Тестовые учётные записи включены дольше суток: ${formatCount(staleTest)} — проверка не убрала за собой. Отключают их по одной, в карточке человека`,
  testPeople: "Люди: тестовые",
  keptTest: (keptTest: number): string => `Тестовых пространств осталось действующими: ${formatCount(keptTest)} — в них работают сотрудники или пишет сервис, решите их судьбу`,
  markedStaff: (markedStaff: number): string => `Людей с пометкой test на настоящем адресе: ${formatCount(markedStaff)} — проверьте, не сотрудники ли это`,
  failedCheck: (title: string, detail: string): string => `Проверка «${title}» не пройдена${detail ? `: ${detail}` : ""}`,
};
