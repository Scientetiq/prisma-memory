import { RECORD_TYPE_TITLES } from "../labels/en";
export const text = {
  parentCaption: (type: string, title: string | null, day: string | null): string => {
    const kind = type === "transcript" ? text.meeting : (RECORD_TYPE_TITLES[type] ?? type).replace(/^./, c => c.toUpperCase());
    return text.parentRecord(kind, title || text.untitled, day);
  },
  meetingBack: (title: string | null): string => text.meeting2(title || text.untitledParent),
  materialsBack: "← My records",

  parentRecord: (kind: string, title: string, day: string | null): string => `${kind} “${title}”${day ? ` · ${day}` : ""}`,

  fromTheColleagueDirectory: "From the colleague directory",
  generatedAutomaticallyFromAMeetingPlease: "Generated automatically from a meeting — please check",
  generatedAutomaticallyFromADocumentPlease: "Generated automatically from a document — please check",
  meetingTranscript: "Meeting transcript",
  uploadedAsAFile: "Uploaded as a file",
  fromADocumentFolder: "From a document folder",
  fromTheSourceSystem: "From the source system",
  correctionBasedOnAPersonS: "Correction based on a person’s words",
  aiAgentCorrection: "AI agent correction",
  writtenByAPerson: "Written by a person",
  generatedAutomaticallyPleaseCheck: "Generated automatically — please check",
  uploadedByAnAiAgent: "Uploaded by an AI agent",
  writtenByAnAiAgent: "Written by an AI agent",
  untitled: "Untitled",
  meeting: "Meeting",
  meeting2: (value0: string | number | null | undefined): string => `← Meeting “${value0}”`,
  meetingsWithMe: "← Meetings with me",
  record: "Record",
  closedRecord: "Closed record",
  you: (value0: string | number | null | undefined): string => `${value0} (you)`,
  generatedAutomaticallyFallback: "Generated automatically — please check",
  writtenByAPersonFallback: "Written by a person",
  untitledParent: "Untitled",
};
