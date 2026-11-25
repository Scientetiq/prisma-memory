// English messages for this area.
import type { DeletionReason } from "../../lib/deletion-requests";
export const DELETION_REASON_TITLES: Record<DeletionReason, string> = { by_mistake: "recorded by mistake", private: "private conversation", no_consent: "did not consent to recording", other: "other" };
export const DELETION_REQUESTS_TEXT = {
    askDeleteConfirm: "Ask to delete this meeting? The organiser and memory administrator will see the request and receive an email if email is configured. You cannot delete the meeting yourself. They can move it to trash.",
    keepConfirm: "Keep this meeting? The participant will see that you kept it. The memory administrator will make the final decision on their request. If this person did not attend, remove them from the participants. The meeting will remain.",
    keptByAdmin: "The memory administrator kept the meeting. You cannot ask to delete it again.",
};
export const REQUESTER_GONE: Record<"left" | "removed", string> = { left: "left the meeting themselves", removed: "no longer a meeting participant" };
export const DELETION_REQUESTS_MESSAGES = {
    askDeleteHint: "The organiser or memory administrator can delete a meeting. If it should not be in memory, ask to delete it.",
    adminKeepConfirm: "Keep this meeting in memory? All deletion requests will close. Requesters will see “administrator kept the meeting” and receive an email if email is enabled. They will not be able to ask to delete this meeting again.",
    adminDeleteConfirm: "Delete this meeting at a participant’s request? The meeting, summary and events will move to the owner’s trash for the trash retention period. The owner can restore it until that period ends, after which it will be deleted permanently.",
};
