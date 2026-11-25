import { formatCount } from "../../i18n/format";
// Messages in the language of the current request. One export per dictionary.
import type { Messages } from "../../i18n/core";
import type * as en from "./en";

export const SELECTION_TEXT: Messages<typeof en.SELECTION_TEXT> = {
  selectionHint: "Память отмечает людей, компании и проекты в записях сама и может что-то пропустить — найдите название во всей памяти.",
  meetingsHint: "Здесь встречи, в которых человек участвовал, но в записях встречи не упомянут: поручений и решений с его именем в них нет. Записи, где он упомянут, — на странице сотрудника.",
  personRecordsLink: "К записям сотрудника",
 kinds: { meetings: "Встречи с участием", person: "Сотрудник", company: "Компания", deal: "Сделка", contact: "Контакт", task: "Задача", project: "Проект", selection: "Подборка" },
 count: (name: string, count: number, more: boolean, meetings: boolean): string => `${meetings ? `Встречи с участием «${name}» без упоминания в записях` : `Записи, где память отметила «${name}»`}: ${more ? `больше ${formatCount(count)}` : formatCount(count)}`,
 meetingTitle: "Встречи с участием",
 meetingLine: (name: string, count: number): string => `Встречи с участием «${name}» без упоминания в записях встречи: ${formatCount(count)}.`,
 meetingLink: "Открыть список встреч",
 search: (name: string): string => `Найти «${name}» во всей памяти`,
};
