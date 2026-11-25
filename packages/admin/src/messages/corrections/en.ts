import { text as closed } from "../closed-class/en";
import type { OpenCheckMark } from "../../lib/types";
import type { CorrectionView } from "../../lib/types";
export const text = {
  closedCheckResult: (mark: OpenCheckMark): string => text.closedResult(closed.reasonSummary(mark, false)),

  ownTextTitle: (type: string, event: string | null): string => text.changeText((event ? OWN_TEXT_NOUN[event] : null) ?? OWN_TYPE_NOUN[type] ?? text.record),
  actorsField: (event: string | null): string => text.separatedByCommas(event === "action" ? text.whoDoesIt : event === "decision" ? text.whoDecided : text.whoSaidIt),
  decidedLine: (status: string, role: keyof typeof DECIDED_BY_TITLES, day: string): string => status === "rejected" ? text.rejectedBy(DECIDED_BY_TITLES[role], day) : text.confirmedBy(DECIDED_BY_TITLES[role], day),
  correctionLine: (v: Pick<CorrectionView, "status" | "kind" | "by_role" | "quote_checked" | "effect" | "newer" | "via" | "link_status">, day: string): string => {
    const who = CORRECTION_BY_TITLES[v.by_role] ?? CORRECTION_BY_TITLES.reader;
    if (v.status === "proposed") return text.proposedByAwaitingADecision(who, day);
    let line: string;
    switch (v.kind) {
      case "extraction_error": line = text.correctedBy(who, day, v.quote_checked ? text.confirmedByAPhrase : text.notConfirmedByAQuote); break;
      case "outdated": line = v.effect === "link" ? v.newer?.title ? text.markedAsReplacedBy(v.newer.title, day) : text.markedAsReplacedByANewer(day) : text.markedByAsNoLongerValid(who, day); break;
      case "own_note": line = text.noteReplacedBy(who, day); break;
      default: line = text.correctedBy2(who, day);
    }
    if (v.via === "mcp" && v.link_status === "active") line += text.byAnAgentUnconfirmed;
    if (v.via === "plan") line += text.byChangePlan;
    return line;
  },
  proposedAssignees: (names: readonly string[]): string => text.assignees(names.length ? names.join(", ") : text.noAssignees),
  proposedNewer: (title: string | null): string => text.newerRecord2(title || text.untitled),
  knownResult: (applied: boolean): string => text.thisCorrectionAlreadyExists(applied ? text.applied : text.awaitingADecision),
  closedResult: (why: string | null): string => text.savedButOnlyPeopleCanSee(why ? `: ${why}` : text.informationThatCannotBeShownTo),

  otherCases: "Other cases",
  record: "record",
  changeText: (value0: string | number | null | undefined): string => `Change ${value0} text`,
  whoDoesIt: "Who does it",
  whoDecided: "Who decided",
  whoSaidIt: "Who said it",
  separatedByCommas: (value0: string | number | null | undefined): string => `${value0} (separated by commas)`,
  currentlyChooseADateToReplace: (value0: string | number | null | undefined): string => `Currently: “${value0}”. Choose a date to replace it; leave the field empty to keep the current due date.`,
  applied: "applied",
  awaitingADecision: "awaiting a decision",
  theCorrectionIsSavedInMemory: "The correction is saved in memory so the next agent will not repeat the error. The previous version stays in the record history.",
  theRecordAuthorMeetingParticipantsAnd: "The record author, meeting participants and space owner can correct it directly. Your correction will be sent to them for approval.",
  afterSavingYourAiAgentsWill: "After saving, your AI agents will no longer see this record, and the previous version will move to Trash.",
  yourAiAgentsWillContinueTo: "Your AI agents will continue to see the record if the automatic check finds nothing in its title and text. Otherwise, only people will see the new version, and you will see why.",
  thisIsALongNotePaste: "This is a long note. Paste the complete replacement text.",
  transcriptExcerptAroundTheEventCopy: "Transcript excerpt around the event — copy a phrase from here:",
  aNewMeetingVersionResetsCorrections: "A new meeting version resets corrections. If the meeting is uploaded again, decisions will be extracted again; corrections to this version will not carry over and must be made again.",
  ifTheSameAssigneeWasRecorded: "If the same assignee was recorded incorrectly in several decisions, replace them all in one change plan. You will review the list and apply it on the plan page.",
  proposalSentUntilItIsApproved: "Proposal sent. Until it is approved, only you and people who can approve it can see it.",
  confirmThisCorrectionEveryoneWhoCan: "Confirm this correction? Everyone who can see the record will see it.",
  confirmThatTheCorrectionIsAccurate: "Confirm that the correction is accurate? The “unconfirmed” annotation will disappear.",
  removeThisCorrectionItWillNo: "Remove this correction? It will no longer apply.",
  memoryCorrectionsAwaitingYourDecisionAnd: "Memory corrections awaiting your decision, and corrections you proposed.",
  colleaguesProposedCorrectionsToRecordsYou: "Colleagues proposed corrections to records you can correct directly. Until a decision is made, the proposer and everyone who can approve it can see the proposal. Once approved, everyone who can see the record will see it.",
  correctionsYouMadeOrProposedWhile: "Corrections you made or proposed. While a proposal awaits a decision, you and people who can approve it can see it, and you can withdraw it.",
  applied2: "Applied",
  awaitingADecision2: "Awaiting a decision",
  rejected2: "Rejected",
  withdrawn2: "Withdrawn",
  outOfDateRecordChanged2: "Out of date: record changed",
  planCancelledNotApplied: "Plan cancelled — not applied",
  notSavedTryAgain: "Not saved — try again",
  notApplied2: "Not applied",
  rejectedBy: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `Rejected by ${value0} · ${value1}`,
  confirmedBy: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `Confirmed by ${value0} · ${value1}`,
  theRecordOrCorrectionIsUnavailable: "The record or correction is unavailable: it does not exist or you do not have access.",
  noDecisionInThisMeetingHas: "No decision in this meeting has that assignee.",
  theMeetingIsBeingMovedBetween: "The meeting is being moved between open and closed storage. Try again in a minute.",
  theMeetingSSpaceIsArchived: "The meeting’s space is archived, so its records cannot be changed.",
  meetingParticipantsTheAuthorAndThe: "Meeting participants, the author and the space owner can correct these decisions directly or by proposal. You do not have that permission.",
  changeAtLeastOneFieldTitle: "Change at least one field: title, statement, due date or assignees.",
  changeTheNoteTextOrTitle: "Change the note text or title.",
  confirmedByAPhrase: "confirmed by a phrase",
  notConfirmedByAQuote: "not confirmed by a quote",
  correctedBy: (value0: string | number | null | undefined, value1: string | number | null | undefined, value2: string | number | null | undefined): string => `Corrected by ${value0} ${value1} · ${value2}`,
  markedAsReplacedBy: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `Marked as replaced by “${value0}” ${value1}`,
  markedAsReplacedByANewer: (value0: string | number | null | undefined): string => `Marked as replaced by a newer record ${value0}`,
  markedByAsNoLongerValid: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `Marked by ${value0} as no longer valid ${value1}`,
  noteReplacedBy: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `Note replaced by ${value0} ${value1}`,
  correctedBy2: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `Corrected by ${value0} ${value1}`,
  byAnAgentUnconfirmed: " (by an agent, unconfirmed)",
  byChangePlan: " · by change plan",
  proposedByAwaitingADecision: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `Proposed by ${value0} ${value1} — awaiting a decision`,
  correctionRecord: "correction record",
  newerRecord: "newer record",
  correction: "Correction",
  title: (value0: string | number | null | undefined): string => `Title: ${value0}`,
  statement: (value0: string | number | null | undefined): string => `Statement: ${value0}`,
  dueDateRemoved: "Due date: removed",
  dueDate: (value0: string | number | null | undefined): string => `Due date: ${value0}`,
  noAssignees: "no assignees",
  assignees: (value0: string | number | null | undefined): string => `Assignees: ${value0}`,
  phrase: (value0: string | number | null | undefined): string => `Phrase: “${value0}”`,
  untitled: "Untitled",
  newerRecord2: (value0: string | number | null | undefined): string => `Newer record: “${value0}”`,
  newerRecordYouDoNotHave: "Newer record: you do not have access",
  thisCorrectionAlreadyExists: (value0: string | number | null | undefined): string => `This correction already exists (${value0}).`,
  openCorrectedRecord: "Open corrected record",
  savedOnlyPeopleCanSeeThe: "Saved. Only people can see the new version; the previous version is in Trash.",
  savedYourAiAgentsCanSee: "Saved. Your AI agents can see the corrected record.",
  informationThatCannotBeShownTo: " information that cannot be shown to AI agents",
  savedButOnlyPeopleCanSee: (value0: string | number | null | undefined): string => `Saved, but only people can see the new version: the automatic check found${value0}. The previous version is in Trash.`,
  correctedWithoutAConfirmingPhraseThe: "Corrected without a confirming phrase. The record is marked “not confirmed by a quote”.",
  correctedAgentsWillFindTheCorrected: "Corrected. Agents will find the corrected version.",
  correctionSavedAlongsideTheRecordSearch: "Correction saved alongside the record. Search finds both.",
  markedAsReplacedByANewer2: "Marked as replaced by a newer record. Use the newer record when answering agents; search results do not show this annotation yet.",
  titleCannotBeEmpty: "Title cannot be empty.",
  titleMustBeAtMost200: "Title must be at most 200 characters.",
  statementCannotBeEmpty: "Statement cannot be empty.",
  statementMustBeAtMost2: "Statement must be at most 2,000 characters.",
  enterADueDateOrSelect: "Enter a due date or select “No due date”, but not both.",
  chooseADueDateFromThe: "Choose a due date from the calendar.",
  useNoMoreThan20Assignees: "Use no more than 20 assignees.",
  anAssigneeSNameMustBe: "An assignee’s name must be at most 120 characters.",
  thisExactPhraseWasNotFound: "This exact phrase was not found in the transcript. Copy it from the excerpt above, or save without a phrase.",
  thePhraseCouldNotBeChecked: "The phrase could not be checked against the transcript in time. Nothing changed. Try again in a minute or save without a phrase.",
  youCannotSeeThisMeetingS: "You cannot see this meeting’s transcript. Save the correction without a phrase.",
  thisKindOfCorrectionDoesNot: "This kind of correction does not apply to this record.",
  thisRecordHasAlreadyBeenCorrected: "This record has already been corrected. Correct the current version.",
  aPersonMustPerformThisAction: "A person must perform this action. Open it in the workspace.",
  tooLongUseAtMost2: "Too long: use at most 2,000 characters to briefly explain what is correct.",
  theSpecifiedRecordIsOlderThan: "The specified record is older than the record being corrected. Choose the one that replaced it.",
  theAuthorOfTheRecordBeing: "The author of the record being corrected cannot see this record. Choose a record in the same space.",
  thisSpaceIsArchivedItsRecords: "This space is archived. Its records cannot be corrected.",
  theNoteAuthorAndSpaceOwner: "The note author and space owner can replace the note.",
  theRecordAuthorMeetingParticipantsAnd2: "The record author, meeting participants and space owner can correct this record.",
  aDecisionHasAlreadyBeenMade: "A decision has already been made, or the proposal was withdrawn.",
  theRecordChangedAfterThisProposal: "The record changed after this proposal, so the proposal is out of date. If the correction is still needed, propose it again.",
  aNewVersionCannotBeRejected: "A new version cannot be rejected. Correct it again instead.",
  thisMeetingHasTooManyEvents: "This meeting has too many events for a single change plan. Contact your administrator.",
  theSpecifiedNewerRecordHasItself: "The specified newer record has itself been replaced. Paste the address of its current version.",
  theNoteTextIsTooLong: "The note text is too long. Shorten it or upload it as a document in “My records”.",
  theRecordIsBeingChangedTry: "The record is being changed. Try again in a minute.",
  checkTheFormFieldsSomethingIs: "Check the form fields: something is not filled in correctly.",
  openCurrentVersion: "Open current version",
  rejectedLine: "Rejected",
  withdrawnLine: "Withdrawn",
  outOfDateRecordChangedLine: "Out of date: record changed",
  notAppliedLine: "Not applied",
};
export const CORRECTION_KIND_TITLES = {
  "extraction_error": "Meeting details are incorrect (due date, assignee or statement)",
  "wrong": "Wrong in substance",
  "outdated": "No longer valid",
  "own_note": "Replace note text"
} as const;
export const OWN_TEXT_NOUN: Record<string, string> = {
  "decision": "decision",
  "action": "task",
  "question_risk": "risk record",
  "fact": "fact"
};
export const OWN_TYPE_NOUN: Record<string, string> = {
  "note": "note",
  "document": "document",
  "profile": "profile",
  "summary": "summary",
  "event": "record"
};
export const CORRECTION_KIND_HINTS = {
  "extraction_error": "The due date, assignee, statement or title is incorrect. Edit the fields and, if possible, paste a phrase from the transcript that confirms the correction.",
  "wrong": "This was said in the meeting or document, but it is not true. The record will stay as it is, with your correction alongside it.",
  "outdated": "The decision was cancelled or replaced. If a newer record exists, paste its address so agents can use it instead.",
  "own_note": "Search will find the new text; the previous version will remain in the history."
} as const;
export const CORRECTION_STATE_TITLES = {
  "applied": "applied",
  "proposed": "awaiting a decision",
  "rejected": "rejected",
  "withdrawn": "withdrawn",
  "superseded": "out of date: record changed",
  "cancelled": "not applied",
  "planned": "not applied"
} as const;
export const CORRECTION_BY_TITLES = {
  "author": "the record author",
  "space_owner": "the space owner",
  "participant": "a meeting participant",
  "space_member": "a space member",
  "reader": "a colleague"
} as const;
export const OLD_VERSION = {
  "visible": "This is a previous version of the record. The current, corrected version is:",
  "hidden": "This is a previous version of the record. You cannot access the current version.",
  "none": "This record is no longer valid."
} as const;
export const CORRECTIONS_SECTIONS = {
  "toConfirm": "Awaiting your decision",
  "mine": "Your corrections",
  "whoSees": "Who can see this?"
} as const;
export const CORRECTIONS_EMPTY = {
  "toConfirm": "Nothing needs your decision right now. When a colleague proposes a correction to your record, it will appear here.",
  "mine": "Found an error? Open the record and select “Correct”. The previous version will stay in the record history."
} as const;
export const DECIDED_BY_TITLES = {
  "author": "the record author",
  "space_owner": "the space owner",
  "participant": "a meeting participant",
  "space_member": "a space member",
  "reader": "a colleague"
} as const;
export const DECISION_DONE = {
  "confirm": "Correction confirmed",
  "reject": "Correction rejected",
  "withdraw": "Correction withdrawn"
} as const;
