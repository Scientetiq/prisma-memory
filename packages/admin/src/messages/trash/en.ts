import { pluralEn } from "../../i18n/core";
// English messages for this area.
import type { ConfirmSpec } from "../../components/confirm-dialog";
export const TRASH_TEXT = {
    deleteConfirm: "Delete this record? It will disappear from search and reading immediately and move to trash. You can restore it until the trash retention period ends (30 days).",
};
export const PURGE_SPEC: ConfirmSpec = {
    question: "Delete this record permanently?",
    change: "The record, records derived from it and the original file will be cleared by the next cleanup job.",
    undo: "Recovery will be impossible.",
    danger: true,
    ack: { name: "confirm", label: "Recovery will be impossible" },
};
export const TRASH_MESSAGES = {
    purgeConfirm: "Delete permanently? The record, its derived records and the original file will be cleared by the next cleanup job. Recovery will be impossible.",
    trashHeld: "kept for as long as the former organiser’s records are retained",
    trashHeldNote: "This meeting was handed over to you by a former colleague. It cannot be deleted permanently while their records are retained, but you can restore it.",
    trashHint: "Records deleted by you, from your records, or from spaces you own appear here. A record’s author and the space owner have equal rights: both can see it here, restore it, or delete it permanently. At the end of the retention period, the record and its original file are deleted permanently.",
    deletedRecordsAreKeptHere: "Deleted records are kept here until the trash retention period ends. You can restore them before then.",
    personal: "Personal",
    unnamedSpace: "unnamed space",
    deletedByYou: "Deleted by: you",
    spaceOwner: " (space owner)",
    deletedBy: (value1: string | number, value2: string | number): string => `Deleted by: ${value1}${value2}`,
    deletedByAnAdministratorAt: "Deleted by an administrator at a meeting participant’s request",
    deletedAutomatically: "Deleted automatically",
    willBeDeletedToday: "will be deleted today",
    willBeDeletedTomorrow: "will be deleted tomorrow",
    appliesToEveryRecordOn: (value1: string | number): string => `${value1} — applies to every record on this page`,
    permanentlyDelete: (value1: string | number): string => `Permanently delete “${value1}”?`,
    permanentlyDeleteThisRecord: (value1: string | number, value2: string | number): string => `Permanently delete this record (${value1}, deleted ${value2})?`,
    recoveryWillBeImpossibleThe: "Recovery will be impossible: the record, its derived records and the original file will be deleted.",
    open: "Open",
    undo: "Undo",
    recordReturnedToTrash: "Record returned to trash",
    itCanBeFoundIn: "It can be found in search and read again.",
    itWasRestoredAsClosed: "It was restored as closed. An administrator has disabled sharing with agents in teams and projects, so agents will not find it.",
    itWasRestoredHiddenFrom: "It was restored hidden from agents: a customer name from the expanded NDA list was found in it. People can still see it as usual.",
    itWasRestoredHiddenFrom2: "It was restored hidden from agents. The former organiser chose to share it with agents, and their decision does not transfer to you. People can see it as usual. You can share it with agents using the usual button.",
    deleteThisMeeting: "Delete this meeting?",
    youCanRestoreItFrom: "You can restore it from trash until the retention period ends (30 days).",
    deleteMeeting: "Delete meeting",
    deletedRecordsAreKeptHere2: (n: number): string => `Deleted records are kept here for ${n} ${pluralEn(n, "day", "days")} — you can restore them.`,
    willBeDeletedIn: (n: number): string => `will be deleted in ${n} ${pluralEn(n, "day", "days")}`,
    keptFor: (n: number, normal: number, automatic: boolean): string => `Kept for ${n} ${pluralEn(n, "day", "days")} instead of ${normal}: ${automatic ? "automatic cleanup uses a shorter retention period" : "this retention period was set at deletion"}`,
    appliesTo: (note: string, n: number): string => `${note} — applies to ${n} ${pluralEn(n, "record", "records")} on this page`,
    derivedPart: (type: string, n: number): string => {
        const forms: Record<string, readonly [
            string,
            string
        ]> = { summary: ["a summary", "summaries"], event: ["a decision or task", "decisions and tasks"], note: ["a note", "notes"], document: ["a document", "documents"], transcript: ["a meeting", "meetings"], profile: ["a profile", "profiles"] };
        const f = forms[type] ?? ["a record", "records"];
        return n === 1 ? f[0] : `${n} ${f[1]}`;
    },
    derivedRecords: (n: number): string => `${n} ${pluralEn(n, "derived record", "derived records")}`,
    derivedList: (parts: readonly string[]): string => `together with ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]}`,
    restoreDone: (title: string | null, n: number): string => `Restored${title ? `: “${title}”` : ""}${n > 1 ? ` together with derived records (total ${n})` : ""}`,
    restoreWhere: (title: string | null, n: number, space: {
        name: string;
        kind: string;
    }): string => `${title ? `“${title}”` : "Record"} is back in “${space.kind === "personal" ? "Personal" : space.name}”${n > 1 ? ` together with derived records (total ${n})` : ""}`,
    meetingChange: (summary: boolean, decisions: number): string => { const parts = ["the transcript", ...(summary ? ["the summary"] : []), ...(decisions ? [`all decisions and tasks (${decisions})`] : [])]; const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0]; return `The following will move to trash together: ${list}. The meeting will disappear from search immediately.`; },
    meetingWho: (ps: readonly string[] | null, space: {
        name: string | null;
    } | null): string => { const names = ps ? ps.slice(0, 5).join(", ") + (ps.length > 5 ? ` and ${ps.length - 5} more` : "") : ""; const inSpace = space ? `everyone who can see it in the space${space.name ? ` “${space.name}”` : ""}` : null; return ps === null ? `Meeting participants${inSpace ? ` and ${inSpace}` : ""} will immediately lose access.` : ps.length ? `Participants will immediately lose access: ${names}.${inSpace ? ` This also applies to ${inSpace}.` : ""}` : inSpace ? `${inSpace[0]!.toUpperCase()}${inSpace.slice(1)} will immediately lose access.` : "There are no other participants in this meeting."; },
};
