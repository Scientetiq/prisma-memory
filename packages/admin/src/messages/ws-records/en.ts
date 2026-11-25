import { EDGE_SHOW } from "../../lib/edge-status";
import { OLD_VERSION } from "../corrections/en";
import type { OpenCheckMark } from "../../lib/types";
import { text as closed } from "../closed-class/en";
import { text as decision } from "../decisions/en";
import { text as due } from "../due-check/en";
import { MEETING_PEOPLE_PLAIN as people, HANDOVER_PLAIN, RETURN_PERSONAL } from "../plain/en";
import { RECORD_TYPE_TITLES, EVENT_KIND_TITLES, SOURCE_KIND_TITLES, SPACE_ROLE_YOU } from "../labels/en";
import { pluralEn } from "../../i18n/core";
export const bulkActorFormText = {
  replaceAnAssigneeInAllDecisions: "Replace an assignee in all decisions",
  createChangePlan: "Create change plan",
  creating: "Creating…",
  whoToReplaceAsRecordedIn: "Who to replace (as recorded in decisions)",
  replaceWith: "Replace with",
};

export const copyLinkText = {
  copied: "Copied",
  copyLink: "Copy link",
  recordLinkCopied: "Record link copied",
  couldNotCopyTheLinkCopy: "Could not copy the link. Copy the address from your browser’s address bar.",
};

export const correctBlockText = {
  candidateCaption: (type: string, event: string | null, day: string | null): string => {
    const kind = ((event ? EVENT_KIND_TITLES[event] : null) ?? RECORD_TYPE_TITLES[type] ?? type).replace(/^./, c => c.toUpperCase());
    return ` · ${kind}${day ? ` · ${day}` : ""}`;
  },

  title: "Title",
  statement: "Statement",
  dueDate: "Due date",
  noDueDate: "<tag0/> No due date",
  phraseFromTheTranscript: "Phrase from the transcript",
  optionalAnExactPhrase81: "Optional: an exact phrase, 8–1,000 characters. Memory will check it against the transcript.",
  whatIsCorrectInYourOwn: "What is correct, in your own words",
  fillInThisFieldOrSpecify: "Fill in this field or specify a newer record, or both.",
  newerRecord: "Newer record",
  untitled: "Untitled",
  pasteARecordLink: "Paste a record link",
  linkToTheNewerRecordPage: "Link to the newer record page",
  linkToTheRecordPage: "link to the record page",
  text: "Text",
  findANewerRecord: "Find a newer record",
  partOfTheTitle: "part of the title",
  search: "Search",
  noResultsForTryAnotherWord: "No results for “{value0}”. Try another word or paste a link.",
  searchDidNotRespondPasteA: "Search did not respond. Paste a link to the record.",
  saveCorrection: "Save correction",
  saving: "Saving…",
  correct: "Correct",
};

export const correctLinkText = {
  correct: "<tag0/>Correct",
};

export const correctionsBlockText = {
  confirm: "Confirm",
  reject: "Reject",
  thisIsIncorrect: "This is incorrect",
  withdraw: "Withdraw",
  correctionsToThisRecord: "Corrections to this record",
  whoCorrectedTheRecordAndHow: "Who corrected the record and how. Applied corrections take effect immediately; proposals await a decision by the record author, meeting participants or space owner.",
};

export const decisionsListText = {
  actorNames: (kind: string | null, names: readonly string[]): string => `${kind === "decision" ? decision.whoDecided : kind === "action" ? decision.whoDoesIt : decision.whoSaidIt}: ${names.join(", ")}`,
  handoverLabel: (title: string | null): string => `${HANDOVER_PLAIN.link}: ${title || decisionsListText.decision}`,
  dueLine: (check: boolean): string => `Due date: {date}${check ? ` <check>${due.checkTheDueDate}</check>` : ""}`,
  groupHeading: (kind: string, count: number): string => `${({ decision: decision.decisions, action: decision.tasks, question_risk: decision.risksAndQuestions, fact: decision.facts } as Record<string, string>)[kind] ?? decision.other} <count>${count}</count>`,

  untitled: "(untitled)",
  dueDate: "Due date: {value0}{value1}",
  decision: "decision",
  showAll: "Show all ({value0})",
};

export const edgeActionsText = {
  failure: (message: string): string => `${EDGE_SHOW.failed}: ${message}`,

  recordIdIsMissing: "Record ID is missing",
};

export const edgeStatusBlockText = {
  externalCopy: "External copy",
  theExternalCopyContainsOpenRecords: "The external copy contains open records for colleagues’ AI agents connected from outside the company network.",
};

export const meetingProjectText = {
  decisionsLegend: (limit: number | null): string => meetingProjectText.meetingDecisions.replace("{value0}", limit ? meetingProjectText.atMostAtATime(limit) : ""),

  handOverTheSelectedDecisionsTo: "Hand over the selected decisions to the project?",
  eachSelectedDecisionWillBecomeA: "Each selected decision will become a separate project record. The meeting will stay as it is; project members will not see its transcript.",
  allProjectMembersIncludingThoseWho: "All project members, including those who were not in the meeting; in a project where new records are visible to AI agents, their agents will see them too.",
  youCannotTakeBackWhatHas: "You cannot take back what has been read: you can delete the project record, but someone may already have read it.",
  handOver: "Hand over",
  iHaveReviewedTheDecisionsAnd: "I have reviewed the decisions and agree that project members can see them",
  untitledDecision: "Untitled decision",
  meetingAndProject: "Meeting and project",
  theMeetingStaysWithItsOrganiser: "The meeting stays with its organiser. You can hand over its decisions to a project, each as a project record. Project members will not see the transcript.",
  youMarkedThisMeetingAsBelonging: "You marked this meeting as belonging to the project <tag0>“{value0}”</tag0>. It appears in “Meetings for this project” for meeting participants who can read this project.",
  markWhichProjectThisMeetingBelongs: "Mark which project this meeting belongs to. It will appear in “Meetings for this project” for meeting participants who can read the project. Access to the meeting will not change.",
  changeProjectMark: "Change project mark",
  mark: "Mark",
  saving: "Saving…",
  projectMeeting: "Project meeting",
  notAProjectMeeting: "— not a project meeting —",
  handOverAllDecisionsToA: "<tag0/>Hand over all decisions to a project…",
  sendToProject: "Hand over to project",
  handingOver: "Handing over…",
  project: "Project",
  chooseAProject: "— choose a project —",
  atMostAtATime: (value0: string | number | null | undefined): string => ` — at most ${value0} at a time`,
  meetingDecisions: "Meeting decisions{value0}",
  eachDecisionSTextWillBe: "Each decision’s text will be handed over to the project unchanged. If a decision contains information that should stay within the meeting, clear its checkbox and hand it over separately after editing the text.",
};

export const orgReviewBlockText = {
  usefulCount: (count: number, departments: number): string => orgReviewBlockText.markedUsefulBy.replace("{value0}", String(count)).replace("{value1}", departments ? orgReviewBlockText.departments(departments) : ""),
  wrongGroupLines: (groups: readonly { label: string; names: string }[]): string => groups.map(g => `${g.label}: ${g.names}`).join("; ") + ".",

  companyKnowledge: "Company knowledge",
  departments: (value0: string | number | null | undefined): string => ` (departments: ${value0})`,
  markedUsefulBy: "Marked “Useful” by: {value0}{value1}.",
  previewIsReadOnly: "Preview is read-only.",
  removeUseful: "Remove “Useful”",
  useful: "Useful",
  undoAnnotation: "Undo annotation",
  wrongNotForEveryone: "Wrong, not for everyone",
  mark: "Mark",
  whatIsCorrectForWrong: "What is correct (for “Wrong”)",
  forExampleApprovalTakes5Working: "for example: approval takes 5 working days, not 3",
  confirm: "Confirm",
  returnToSource: "Return to source",
  restore: "Return",
  returnTheRecordToWhereIt: "Return the record to where it came from? Colleagues without access there will no longer see it. The author will see this in “My actions”.",
  delete: "Delete",
  deleteTheRecordItWillReturn: "Delete the record? It will return to where it came from and immediately move to Trash there. Its author can restore it there, rather than in “Company knowledge”.",
};

export const ownerActionsText = {
  derivedHint: (hidden: boolean): string => `${hidden ? closed.thisRecordIsPartOfThe : closed.thisRecordIsPartOfThe2} <link>${ownerActionsText.sourceRecord}</link>`,

  sourceRecord: "Source record",
  iUnderstandTheConsequences: "<tag0/> I understand the consequences",
  processNow: "Process now",
  deleteRecord: "Delete record",
};

export const pageText = {
  returnExplanation: (space: string | null, derived: boolean, participants: boolean, open: boolean): string => (derived ? RETURN_PERSONAL.explainDerived(space) : RETURN_PERSONAL.explain(space)) + (participants ? ` ${RETURN_PERSONAL.participants}` : "") + (open ? ` ${RETURN_PERSONAL.agents}` : ""),
  returnParent: `<link>${RETURN_PERSONAL.parentLink}</link> ${RETURN_PERSONAL.parentHint}`,
  oldVersion: (title: boolean): string => `${OLD_VERSION.visible} <link>${title ? "{title}" : pageText.untitled2}</link>.`,
  sourceDetails: (source: string, ref: string | null): string => `${SOURCE_KIND_TITLES[source] ?? source}${ref ? ` · ${ref}` : ""}`,
  roleSuffix: (role: string): string => ` · ${SPACE_ROLE_YOU[role] ?? pageText.you(role)}`,
  eventKindSuffix: (kind: string): string => ` · ${EVENT_KIND_TITLES[kind] ?? kind}`,
  requesterStatus: "{name} — {status}.",

  closedNotice: (owner: boolean, participant: boolean): string => pageText.closedRecordEveryViewIsRecorded.replace("{value0}", owner ? pageText.youAreItsOwner : participant ? pageText.youAreAParticipantInThis : pageText.youCanSeeItThroughYour).replace("{value1}", owner ? pageText.untilYouShowItToAi : ""),
  meetingSource: (title: boolean, day: boolean): string => pageText.fromTheMeeting.replace("{value0}", title ? "{title}" : pageText.untitled2).replace("{value1}", day ? " · {day}" : ""),
  transcriptPart: (from: boolean, to: boolean): string => pageText.showingPartOfTheTranscript.replace("{value0}", from ? pageText.from.replace("{value0}", "{from}") : "").replace("{value1}", to ? pageText.to.replace("{value0}", "{to}") : ""),
  originalSize: (pages: number, duration: boolean): string => pageText.kb.replace("{value0}", "{kb}").replace("{value1}", pages ? pageText.pages(pages) : "").replace("{value2}", duration ? " · {duration}" : ""),
  checkHeader: (dated: boolean): string => `<tag0>Closed by the automatic check${dated ? " {at}" : ""}.</tag0>`,
  checkBody: (mark: Pick<OpenCheckMark, "findings" | "kinds" | "unchecked" | "by_word">, source: string | null, origin: string | null, personal: boolean, space: string | null, offered: boolean, allowed: boolean): string => `${closed.checkLead(source, origin, personal, space)}: ${closed.reasonSummary(mark, false)}. The record is therefore closed and agents cannot see it. ${mark.by_word ? closed.wordAdvice(offered) : allowed ? offered ? closed.consentAdvice() : closed.disabledAdvice() : closed.thisCannotBeShownEvenWith}`,
  keptHeader: "File saved. Agents cannot see it yet.",

  recordNumberLine: "Record number: <code>{id}</code>.",
  errorCode: " Code: <code>{code}</code>.",
  deleteOrKeepMeeting: "To delete the meeting, select “Delete meeting” under “Owner actions”; it will move to Trash. To keep it, respond to the participant; the memory administrator will then decide.",

  peopleCount: (count: number, named: boolean): string => named ? `and ${count} more` : `${count} ${pluralEn(count, "person", "people")}`,

  record: "Record",
  detailsForIt: "Details for IT",
  path: "Path",
  recordNumber: "Record number",
  source: "Source",
  sizeInTokens: "Size in tokens",
  version: "Version",
  fileFormat: "File format",
  fileConversion: "File conversion",
  thisRecordSSpaceIsArchived: "This record’s space is archived.",
  closedByTheAutomaticCheckThe: "<tag0>Closed by the automatic check{value0}.</tag0> {value1}: {value2}. The record is therefore closed and agents cannot see it. {value3}",
  recordUnavailable: "Record unavailable",
  theRecordLinkIsInvalidIt: "The record link is invalid. It may not have been copied in full.",
  thisIsAClosedRecordOnly: "<tag0>This is a closed record.</tag0> Only open records are visible in this view. A person with access can read it in the workspace with their own account; if it is your record, you can show it to agents.",
  theRecordWasDeletedOrMoved: "The record was deleted or moved, or you do not have access. For a meeting, the organiser may have removed you from its participants; ask them. Find your deleted records in <tag0>Trash</tag0>.",
  theRecordWasDeletedOrMoved2: "The record was deleted or moved, or it is closed and only open records are visible here.",
  theRecordHasNotOpenedYet: "The record has not opened yet.",
  theRecordCouldNotBeOpened: "The record could not be opened.",
  details: "Details",
  memoryDeliberatelyGivesTheSameResponse: " Memory deliberately gives the same response for deleted records and records hidden from you, so a link cannot reveal someone else’s record.",
  ownerActions: "Owner actions",
  ifThisIsNotYourRecord: "If this is not your record, memory will refuse and nothing will change. Its content will appear here when processing is complete.",
  closedRecord: "Closed record",
  theContentsOfThisRecordAre: "The contents of this record are hidden from you.",
  knownRecordDetails: "Known record details",
  recordDetailsOnlyWithoutTextThis: "Record details only, without text. This view has the same access as an AI agent with a personal key and cannot show closed content. People with access can read closed records in the workspace using their own account.",
  type: "Type",
  space: "Space",
  owner: "Owner",
  when: "When",
  processing: "Processing",
  location: "Location",
  thisIsNotYourRecordOnly: "This is not your record. Only the author can show it to agents; the author or space owner can delete it.",
  untitled: "(untitled)",
  actions: "Actions",
  untitled2: "Untitled",
  fromTheMeeting: "<tag0/> From the meeting “{value0}”{value1}",
  youAreItsOwner: "You are its owner",
  youAreAParticipantInThis: "You are a participant in this meeting",
  youCanSeeItThroughYour: "You can see it through your role in the space",
  untilYouShowItToAi: " until you show it to AI agents",
  closedRecordEveryViewIsRecorded: "<tag0>Closed record.</tag0> {value0}. Every view is recorded in the audit log, visible in <tag1>“My actions”</tag1>. The record is not sent to AI agents{value1}.",
  participantsHaveAskedToDeleteThis: "Participants have asked to delete this meeting:",
  keepMeeting: (value0: string | number | null | undefined): string => `Keep meeting — ${value0}`,
  removeFromParticipants: (value0: string | number | null | undefined): string => `Remove ${value0} from participants`,
  from: " from [{value0}]",
  to: " to [{value0}]",
  showingPartOfTheTranscript: "Showing part of the transcript{value0}{value1}.",
  showingPartOfTheRecord: "Showing part of the record.",
  readMore: "Read more →",
  fromTheStart: "← From the start",
  summary: "Summary",
  theSummaryCouldNotBeOpened: "The summary could not be opened.",
  decisionsAndAgreements: "Decisions and agreements",
  whatMemoryExtractedFromTheMeeting: "What memory extracted from the meeting: decisions, tasks, risks and facts. Each is a separate record that you can find with search.",
  noDecisionsOrAgreementsWereFound: "No decisions or agreements were found in the meeting.",
  decisionsCouldNotBeExtracted: "decisions could not be extracted",
  theseWillAppearWithTheSummary: "These will appear with the summary.",
  transcript: "<tag0/>Transcript",
  aboutThisRecord: "About this record",
  addedToMemory: "Added to memory",
  visibleToMeetingParticipants: " · visible to meeting participants",
  you: (value0: string | number | null | undefined): string => `you ${value0}`,
  origin: "Origin",
  sourceRecord: "source record",
  retryingWillReceiveTheSameRefusal: " · retrying will receive the same refusal",
  access: "Access",
  limitedByTheSystemTheRecord: "limited by the system the record came from",
  recorded: "Recorded",
  people: "People",
  recordsInvolvingThisPerson: "Records involving this person",
  mentions: "Mentions",
  topics: "Topics",
  recordsInvolving: "<tag0/>Records involving: {value0}",
  findWithSearch: "<tag0/>Find with search",
  contents: "Contents",
  p: " p. {value0}",
  extractedFromThisRecord: "Extracted from this record",
  summariesDecisionsAndTasksThatMemory: "Summaries, decisions and tasks that memory extracted from this record. Each is a separate record.",
  original: "Original",
  format: "Format",
  size: "Size",
  pages: (value0: string | number | null | undefined): string => ` · ${value0} ${pluralEn(Number(value0), "page", "pages")}`,
  kb: "{value0} KB{value1}{value2}",
  downloadFile: "<tag0/> Download file",
  thisLinkExpiresSoon: "this link expires soon",
  fileLinkUnavailable: "File link unavailable.",
  deleteMeeting: "Delete meeting",
  deleteRecord: "Delete record",
  findInMemory: "<tag0/>Find in memory",
  meetingsWithMe: "Meetings with me",
  overview: "<tag0/>Overview",
};

export const participantPickerText = {
  retryAfter: (seconds: number | null): string => participantPickerText.tooManySearchesInARow(seconds ? participantPickerText.seconds(seconds) : participantPickerText.aMinute),
  optionCaption: (department: string, login: string, inMemory: boolean): string => [department, login].filter(Boolean).join(" · ") + (inMemory ? "" : participantPickerText.willSeeTheMeetingAfterFirst(people.labelWaiting)),
  insideCaption: (department: string): string => [department, people.inMeeting].filter(Boolean).join(" · "),

  willSeeTheMeetingAfterFirst: (value0: string | number | null | undefined): string => ` — ${value0}: will see the meeting after first sign-in`,
  yourSessionEndedRefreshThePage: "Your session ended — refresh the page and sign in again",
  searchDidNotRespondTryAgain: "Search did not respond — try again",
  seconds: (value0: string | number | null | undefined): string => `${value0} ${pluralEn(Number(value0), "second", "seconds")}`,
  aMinute: "a minute",
  tooManySearchesInARow: (value0: string | number | null | undefined): string => `Too many searches in a row. Wait ${value0} and keep typing`,
  searchDidNotRespondCheckYour: "Search did not respond — check your connection and try again",
  searchingPeopleWhoHaveAccessTo: "Searching people who have access to memory…",
  noMatchesAmongPeopleWithAccess: "No matches among people with access to memory. Check the spelling or add your colleague manually below.",
  matchingColleagues: "Matching colleagues",
  showingTheFirst10NarrowYour: "Showing the first 10 — narrow your search by last name.",
  adding: "Adding…",
};

export const participantsBlockText = {
  leftCaption: (dated: boolean): string => participantsBlockText.leftVoluntarily.replace("{value0}", dated ? " · {at}" : ""),
  deletionKept: (dated: boolean): string => participantsBlockText.youAskedToDeleteTheMeeting.replace("{value0}", dated ? " {at}" : ""),
  deletionDeclined: (dated: boolean): string => participantsBlockText.youAskedToDeleteTheMeeting2.replace("{value0}", dated ? " {at}" : ""),

  personCaption: (name: string, you: boolean, gone: boolean): string => name + (you ? participantsBlockText.you : "") + (gone ? ` — ${people.gone}` : ""),
  participantNames: (names: readonly (string | { name: string; you: boolean; gone: boolean })[], more: number): string => (names.length ? names.map(p => typeof p === "string" ? p : participantsBlockText.personCaption(p.name, p.you, p.gone)).join(", ") : people.noParticipants) + (more > 0 ? participantsBlockText.andMore(more) : ""),
  organizerCaption: (name: string, you: boolean): string => `<tag0>${people.organizer}:</tag0> ${participantsBlockText.personCaption(name, you, false)}`,
  participantHeading: "Participants:",
  unresolvedNames: (names: readonly string[]): string => `${people.unresolved}: ${names.join(", ")}.`,
  suggestedPerson: (department: string | null, why: string): string => [department, people.why[why as keyof typeof people.why] ?? null].filter(Boolean).join(" · "),

  colleagueExample: "colleague@example.com",
  you: " (you)",
  recordsInvolvingThisPerson: "Records involving this person",
  andMore: (value0: string | number | null | undefined): string => ` and ${value0} more`,
  participants: "Participants",
  remove: "Remove",
  add: "Add",
  leftVoluntarily: "left voluntarily{value0}",
  youAskedToDeleteTheMeeting: "You asked to delete the meeting <tag0/>. The memory administrator kept the meeting{value0}; you cannot ask to delete it again.",
  youAskedToDeleteTheMeeting2: "You asked to delete the meeting <tag0/>. The organiser kept it{value0}; the memory administrator will make the final decision.",
  deletionRequestedTheOrganiserAndMemory: "Deletion requested <tag0/>. The organiser and memory administrator can see the request.",
  reasonOptional: "Reason (optional)",
  doNotSpecify: "do not specify",
};

export const recheckActionsText = {
  failure: (message: string): string => `${recheckViewText.couldNotPrepare}: ${message}`,

  recordIdIsMissing: "Record ID is missing",
};

export const recheckViewText = {
  hiddenByRecheck: "Hidden by recheck",
  anOpenCheckRecheckHidesRecords: "Rechecking open records hides them from agents when it finds information that agents must not see. People can still see the record.",
  hiddenFromAgents: "Hidden from agents",
  keptHidden: "Kept hidden",
  willReturnFromTrashHidden: "Will return from Trash hidden",
  keepHidden: "Keep hidden",
  theRecordWillStayHiddenFrom: "The record will stay hidden from agents, and the administrator will no longer see it in the review list. You can show it to agents later using the usual button, with a full check. Keep it hidden?",
  youChoseToKeepItHidden: "You chose to keep it hidden. You can show it to agents using the usual button, with a full check.",
  recordKeptHidden: "Record kept hidden",
  couldNotPrepare: "Could not complete",
};

export const recordTrailText = {
  backToSearchResults: "Back to search results",
  recordLocation: "Record location",
};

export const showAnywayPanelText = {
  iUnderstandTheConsequences: "I understand the consequences",
};

export const transcriptJumpText = {
  thisPointIsBeyondThePart: "This point is beyond the part of the transcript shown here. The page shows only the start of a long meeting.",
};

export const whoSeesText = {
  peopleWhoCanAccessTheRecord: "people who can access the record and their AI agents",
  onlyPeopleWhoCanAccessThe: "only people who can access the record, here in the workspace",
  whoCanSeeTheRecord: "Who can see the record",
  whoCanSeeIt: "Who can see it:",
  why: "Why",
};
