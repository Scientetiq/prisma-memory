import { RECORD_TYPE_TITLES } from "../labels/ru";
import type { Messages } from "../../i18n/core";
import * as en from "./en";

export const text: Messages<typeof en.text> = {
  parentCaption: (type: string, title: string | null, day: string | null): string => {
    const kind = type === "transcript" ? text.meeting : (RECORD_TYPE_TITLES[type] ?? type).replace(/^./, c => c.toUpperCase());
    return text.parentRecord(kind, title || text.untitled, day);
  },
  meetingBack: (title: string | null): string => text.meeting2(title || text.untitledParent),
  materialsBack: "← Мои записи",

  parentRecord: (kind: string, title: string, day: string | null): string => `${kind} «${title}»${day ? ` · ${day}` : ""}`,

  fromTheColleagueDirectory: "Из справочника сотрудников",
  generatedAutomaticallyFromAMeetingPlease: "Составлено автоматически по встрече — проверьте",
  generatedAutomaticallyFromADocumentPlease: "Составлено автоматически по документу — проверьте",
  meetingTranscript: "Стенограмма встречи",
  uploadedAsAFile: "Загружено файлом",
  fromADocumentFolder: "Из папки с документами",
  fromTheSourceSystem: "Из системы-источника",
  correctionBasedOnAPersonS: "Исправление со слов человека",
  aiAgentCorrection: "Исправление ИИ-агента",
  writtenByAPerson: "Записано человеком",
  generatedAutomaticallyPleaseCheck: "Составлено автоматически — проверьте",
  uploadedByAnAiAgent: "Загружено ИИ-агентом",
  writtenByAnAiAgent: "Записал ИИ-агент",
  untitled: "Без названия",
  meeting: "Встреча",
  meeting2: (value0: string | number | null | undefined): string => `← Встреча «${value0}»`,
  meetingsWithMe: "← Встречи со мной",
  record: "Запись",
  closedRecord: "Закрытая запись",
  you: (value0: string | number | null | undefined): string => `${value0} (вы)`,
  generatedAutomaticallyFallback: "Составлено автоматически — проверьте",
  writtenByAPersonFallback: "Записано человеком",
  untitledParent: "Без названия",
};
