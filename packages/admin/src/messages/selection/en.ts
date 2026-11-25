import { formatCount } from "../../i18n/format";
// Messages in the language of the current request. One export per dictionary.
export const SELECTION_TEXT = {
selectionHint: "Memory identifies people, companies and projects in records automatically and may miss something — search all memory for the name.",
meetingsHint: "These are meetings the person attended without being mentioned in the meeting records: no tasks or decisions name them. Records that mention them are on the colleague’s page.",
personRecordsLink: "Go to the colleague’s records",
 kinds: { meetings: "Meetings attended", person: "Colleague", company: "Company", deal: "Deal", contact: "Contact", task: "Task", project: "Project", selection: "Selection" },
 count: (name: string, count: number, more: boolean, meetings: boolean): string => `${meetings ? `Meetings attended by “${name}” without a mention in the records` : `Records where memory identified “${name}”`}: ${more ? `more than ${formatCount(count)}` : formatCount(count)}`,
 meetingTitle: "Meetings attended",
 meetingLine: (name: string, count: number): string => `Meetings attended by “${name}” without a mention in the meeting records: ${formatCount(count)}.`,
 meetingLink: "Open meeting list",
 search: (name: string): string => `Find “${name}” in all memory`,
};
