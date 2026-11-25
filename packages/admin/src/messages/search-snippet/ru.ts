import type { Messages } from "../../i18n/core";
import type * as en from "./en";
export const searchSnippet: Messages<typeof en.searchSnippet> = {
  meetingTranscript: (value0: unknown): string => `стенограмма встречи, ${value0}`,
  meetingTranscript2: "стенограмма встречи",
  fromAMeeting: (value0: unknown): string => `из встречи, ${value0}`,
  workProfileWrittenByTheColleague: "рабочий профиль: его пишет сам сотрудник",
  fromTheColleagueDirectory: "из справочника сотрудников",
  p: (value0: unknown, value1: unknown): string => `стр. ${value0}${value1}`,
  section: (value0: unknown): string => `раздел «${value0}»`,
  fromADocument: (value0: unknown): string => `из документа, ${value0}`,
  fromADocument2: "из документа",
  addedByAnAiAgent: (value0: unknown): string => `записал ИИ-агент, ${value0}`,
  addedByAnAiAgent2: "записал ИИ-агент",
  generatedAutomatically: (value0: unknown): string => `составлено автоматически, ${value0}`,
  generatedAutomatically2: "составлено автоматически",
  similarityOfTheBestMatch: (value0: unknown): string => `Насколько похоже: ${value0}% от лучшего совпадения`,
};
