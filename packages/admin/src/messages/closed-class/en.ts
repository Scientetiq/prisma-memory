import type { OpenCheckMark } from "../../lib/types";
import { OPEN_CHECK_FIELD_TITLES, OPEN_CHECK_KIND_TITLES } from "../labels/en";
export const text = {
  findingLine: (f: { kind: string; reason: string; field: string; at?: number }, position: boolean): string =>
    f.kind === "never_open" ? text.neverOpenRule(f.reason) : text.looksLikeField(f.reason, OPEN_CHECK_FIELD_TITLES[f.field] ?? f.field, position && typeof f.at === "number" ? text.position(f.at) : ""),
  reasonSummary: (mark: Pick<OpenCheckMark, "findings" | "kinds" | "unchecked">, position: boolean): string => {
    const parts = (mark.findings ?? []).slice(0, 3).map(f => text.findingLine(f, position));
    const more = (mark.findings?.length ?? 0) - parts.length;
    // Keep the remainder with the last finding, before any scan warning.
    if (more > 0) parts[parts.length - 1] += text.andMore(more);
    if (mark.unchecked === "empty_text") parts.push(text.noTextCouldBeExtractedFrom);
    else if (mark.unchecked === "partial_text") parts.push(text.somePagesAreScansAndCould);
    if (!parts.length) parts.push((mark.kinds ?? []).map(k => OPEN_CHECK_KIND_TITLES[k] ?? k).join(", ") || text.aCheckFinding);
    return parts.join("; ");
  },
  checkLead: (source: string | null, origin: string | null, personal: boolean, space: string | null): string => {
    const where = personal ? text.toYourPersonalSpace : space ? text.toTheSpace(space) : text.toThisSpace;
    return source === "upload" ? text.youUploadedThisFileButThe(where) : source === "agent"
      ? origin === "human" ? text.youSavedThisRecordButThe(where) : text.yourAiAgentSavedThisRecord(where)
      : text.thisRecordWasSavedButThe(where);
  },
  wordAdvice: (offered: boolean): string => offered ? text.ifAgentsNeedThisTellYour(text.makeAvailableToAgents, text.allFindingsOfTheseKindsIn) : text.ifAgentsNeedThisTellYour2(text.allFindingsOfTheseKindsIn),
  consentAdvice: (): string => text.ifAgentsNeedThisSelectMemory(text.makeAvailableToAgents),
  openConfirmation: (): string => text.showTheRecordToAgents(CLOSED_CLASS_TEXT.openClassWarning),
  hideUndo: (): string => text.youCanShowItAgainHere(ACCESS_ACTION.show),
  disabledAdvice: (): string => text.theAdministratorHasDisabledMakeAvailable(text.asANewNoteOrUpload),
  reopenAdvice: (): string => text.thisRecordWasPreviouslyShownTo(text.makeAvailableToAgents),
  neverAdvice: (reasons: string): string => text.thisRecordCannotBeShownTo(reasons, text.asANewNoteOrUpload),
  sensitiveAdvice: (): string => text.passportDetailsSnilsAndBankCard(text.asANewNoteOrUpload),
  noWriteAdvice: (space: string | null): string => text.youCanNoLongerChangeRecords(space ? text.inTheSpace(space) : text.inThisSpace),
  orgAdvice: (): string => text.recordsWithThisFindingCannotBe(text.asANewNoteOrUpload),
  disabledGateAdvice: (projects: boolean): string => projects ? text.theAdministratorHasDisabledMakeAvailable3(text.asANewNoteOrUpload) : text.theAdministratorHasDisabledMakeAvailable2(text.asANewNoteOrUpload),
  ownerChange: (previous: string | null, department: boolean): string => [text.theNewOwnerManagesMembershipAnd, previous ? text.thePreviousOwnerWillRemainA(previous) : "", department ? text.theOrgTableAlsoSetsThe : ""].filter(Boolean).join(" "),
  keptReasons: (reasons: readonly string[]): string => !reasons.length ? text.informationThatIsUsuallyHiddenFrom : reasons.length === 1 ? reasons[0]! : text.and(reasons.slice(0, -1).join(", "), reasons[reasons.length - 1]),
  keptWhy: (mark: Pick<OpenCheckMark, "findings" | "kinds" | "via" | "unchecked">): string => {
    const reasons = [...new Set((mark.findings ?? []).filter(f => f.kind !== "never_open").map(f => f.reason))];
    const parts = reasons.length || mark.unchecked !== "partial_text" ? [`the check found ${text.keptReasons(reasons)}${mark.via === "convert" && reasons.length ? " in the text" : ""}`] : [];
    if (mark.unchecked === "partial_text") parts.push(text.somePagesAreScansAndCould);
    return parts.join("; ");
  },
  keptUpload: (mark: Pick<OpenCheckMark, "findings" | "kinds" | "via" | "unchecked">, kind: string | null, name: string | null): string => text.fileSavedButAgentsCannotSee(text.keptWhy(mark), text.peopleIn(kind, name)),
  keptNotice: (mark: Pick<OpenCheckMark, "findings" | "kinds" | "via" | "unchecked">, kind: string | null, name: string | null): string => {
    const why = text.keptWhy(mark);
    return text.peopleCanSeeItAsUsual(why.charAt(0).toUpperCase() + why.slice(1), text.peopleIn(kind, name));
  },

  peopleIn: (kind: string | null, name: string | null): string => `${kind === "team" ? "in the team" : kind === "project" ? "in the project" : "in the space"}${name ? ` “${name}”` : ""}`,

  ifARecordIsClosedAn: "If a record is closed, an AI agent with a personal key cannot access it, and it will not appear here. A person with access can read it in the workspace using their own account; its owner can show it to agents.",
  showTheRecordToAgents: (value0: string | number | null | undefined): string => `Show the record to agents? ${value0}`,
  thisRecordIsPartOfThe: "This record is part of the source record and can only be hidden from agents together with it.",
  thisRecordIsPartOfThe2: "This record is part of the source record and can only be shown to agents together with it.",
  neverOpenRule: (value0: string | number | null | undefined): string => `“Never open” rule: ${value0}`,
  position: (value0: string | number | null | undefined): string => `, position ${value0}`,
  looksLikeField: (value0: string | number | null | undefined, value1: string | number | null | undefined, value2: string | number | null | undefined): string => `looks like ${value0} (field “${value1}”${value2})`,
  toTheSpace: (value0: string | number | null | undefined): string => `to the space “${value0}”`,
  toThisSpace: "to this space",
  toYourPersonalSpace: "to your personal space",
  youUploadedThisFileButThe: (value0: string | number | null | undefined): string => `You uploaded this file ${value0}, but the check found`,
  youSavedThisRecordButThe: (value0: string | number | null | undefined): string => `You saved this record ${value0}, but the check found`,
  yourAiAgentSavedThisRecord: (value0: string | number | null | undefined): string => `Your AI agent saved this record ${value0}, but the check found`,
  thisRecordWasSavedButThe: (value0: string | number | null | undefined): string => `This record was saved ${value0}, but the check found`,
  andMore: (value0: string | number | null | undefined): string => ` and ${value0} more`,
  noTextCouldBeExtractedFrom: "no text could be extracted from the file, so there is nothing to check",
  somePagesAreScansAndCould: "some pages are scans and could not be checked",
  aCheckFinding: "a check finding",
  ifAgentsNeedThisTellYour: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `If agents need this, tell your agent “show it” or select “${value0}” here. Your consent will cover ${value1}.`,
  ifAgentsNeedThisTellYour2: (value0: string | number | null | undefined): string => `If agents need this, tell your agent “show it”. Your consent will cover ${value0}.`,
  ifAgentsNeedThisSelectMemory: (value0: string | number | null | undefined): string => `If agents need this, select “${value0}”: memory will show what it found and who will see the record, and ask for your consent.`,
  thisCannotBeShownEvenWith: "This cannot be shown even with your consent. Remove it and save a new record.",
  asANewNoteOrUpload: "as a new note, or upload a corrected file again (editing this record will not help: memory checks its earlier versions too)",
  theAdministratorHasDisabledMakeAvailable: (value0: string | number | null | undefined): string => `The administrator has disabled “Make available to agents”. If agents need this, save what they need without the findings ${value0}.`,
  allFindingsOfTheseKindsIn: "all findings of these kinds in the record and records extracted from it, as they are now",
  theUsualShowToAgentsAction: "The usual “Show to agents” action will refuse because of this finding. Select “Make available to agents” to review the findings and give consent.",
  showToAgentsWillCheckThe: "“Show to agents” will check the record again and refuse if the finding is still there.",
  makeAvailableToAgents: "Make available to agents",
  thisRecordWasPreviouslyShownTo: (value0: string | number | null | undefined): string => `This record was previously shown to agents and then hidden. To show it again, select “${value0}”: memory will show the findings again and ask for your consent.`,
  showTheRecordToAgents2: "Show the record to agents?",
  aiAgentsOfEveryoneWhoCan2: "AI agents of everyone who can see this record, such as Claude Code or Codex, will be able to read it. These agents use external cloud models, so the record text will be sent outside your company.",
  youCanHideTheRecordFrom: "You can hide the record from agents again, but they will keep what they have already read.",
  iUnderstandTheConsequences: "I understand the consequences",
  assignANewSpaceOwner: "Assign a new space owner?",
  theyWillBeAbleToDelete: "They will be able to delete and move space records and change its membership. The previous owner will remain a member.",
  youCanChangeTheOwnerAgain: "You can change the owner again here.",
  assign: "Assign",
  makeTheOwnerOf: (value0: string | number | null | undefined): string => `Make {} the owner of “${value0}”?`,
  theNewOwnerManagesMembershipAnd: "The new owner manages membership and can move and delete space records.",
  thePreviousOwnerWillRemainA: (value0: string | number | null | undefined): string => `The previous owner, ${value0}, will remain a member with read and write access.`,
  theOrgTableAlsoSetsThe: "The org table also sets the owner of a department space and may change it on the next import.",
  applyMembershipChanges: "Apply membership changes?",
  addedMembersWillImmediatelySeeSpace: "Added members will immediately see space records; removed members will lose access.",
  youCanChangeMembershipAgainHere: "You can change membership again here, but cannot take back what added members have already read.",
  apply: "Apply",
  agentsWillImmediatelyStopFindingAnd2: "Agents will immediately stop finding and reading the record. They will keep what they have already read.",
  hideTheRecordFromAgents2: "Hide the record from agents?",
  youCanShowItAgainHere: (value0: string | number | null | undefined): string => `You can show it again here by selecting “${value0}”.`,
  makeAvailableToAgents2: "Make available to agents?",
  theCheckFoundInformationInThe: "The check found information in the record that is usually hidden from AI agents.",
  inTheRecordItself: "in the record itself",
  inRecordsExtractedFromIt: "in records extracted from it",
  agentsWillAlsoSeeColleaguesAnnotations: (value0: string | number | null | undefined): string => `Agents will also see colleagues’ annotations on this record: ${value0}.`,
  yourAiAgentsSuchAsClaude: "Your AI agents, such as Claude Code or Codex, connected with your key.",
  agentsUseExternalCloudModelsSo: "Agents use external cloud models, so the record text will be sent outside your company.",
  onlyThisRecordAsItIs: "Only this record as it is now, and only the kinds of information listed above, wherever they occur in the record. Memory will ask again if this record or records extracted from it change, a colleague adds an annotation, the record is moved or placed in another space, or someone receives separate access. Findings discovered later will not be shown to agents.",
  theCountShowsHowManyPlaces: "The count shows how many places in the record (title, summary, text, file and extracted records) contain the finding. The summary is a separate place even if it repeats the start of the text: agents see it in search results. A place may contain several instances of this information, and agents will see them all.",
  theFileContainsScannedPagesAgents: "The file contains scanned pages. Agents will receive only recognised text that memory has checked. The file itself and scanned pages will remain visible only to people.",
  iAmTheRecordAuthorAnd: "I am the record author and understand that agents will see the information the check found",
  keepHidden: "Keep hidden",
  ifThisPageHasBeenOpen: "If this page has been open for more than 15 minutes, refresh it so memory can check the record again.",
  thisRecordCannotBeShownTo: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `This record cannot be shown to agents even with your consent because it contains ${value0}. If agents need this, save what they need without it ${value1}.`,
  passportDetailsSnilsAndBankCard: (value0: string | number | null | undefined): string => `Passport details, national ID numbers and bank card numbers can be shown to agents only in your personal space when only you can see it. Other information can be shown: save it without these details ${value0}.`,
  noTextWasFoundInThe: "No text was found in the file. It appears to be a scan or photos of pages. There is nothing to show agents; only people can see the file.",
  theRecordAndItsEditHistory: "The record and its edit history are too large to check in full. Save what agents need as a new note.",
  theAdministratorHasDisabledShowingScans: "The administrator has disabled showing scans as text. Only people can see the file.",
  inTheSpace: (value0: string | number | null | undefined): string => `in the space “${value0}”`,
  inThisSpace: "in this space",
  youCanNoLongerChangeRecords: (value0: string | number | null | undefined): string => `You can no longer change records ${value0}, so this record cannot be shown to agents.`,
  recordsWithThisFindingCannotBe: (value0: string | number | null | undefined): string => `Records with this finding cannot be shown to agents in “Company knowledge”. Save what agents need without the findings ${value0}.`,
  thisRecordIsPlacedInCompany: "This record is placed in “Company knowledge”, so it cannot be shown to agents with this finding.",
  someRecordsExtractedFromThisRecord: "Some records extracted from this record are in another space, so they cannot all be shown together.",
  meetingsAndRecordsDerivedFromThem: "Meetings and records derived from them cannot be shown this way. Neither can records whose source was deleted or whose source link is incomplete: memory cannot verify whether they came from a meeting.",
  theAdministratorHasDisabledMakeAvailable2: (value0: string | number | null | undefined): string => `The administrator has disabled “Make available to agents”. Save what agents need without the findings ${value0}, or ask your administrator.`,
  theAdministratorHasDisabledMakeAvailable3: (value0: string | number | null | undefined): string => `The administrator has disabled “Make available to agents” in teams and projects. Save what agents need without the findings ${value0}, or ask your administrator.`,
  theRecordCouldNotBeChecked: "The record could not be checked right now. Try again in a minute.",
  theFileIsStillBeingProcessed: "The file is still being processed. Reopen this page when processing is complete.",
  theRecordCouldNotBeChecked2: "The record could not be checked. Refresh the page in a minute.",
  onlyTheRecordAuthorCanMake: "Only the record author can make it available to agents.",
  agentsSeeOnlyRecognisedTextThey: "Agents see only recognised text; they do not receive the file itself or its scanned pages.",
  saveAsANewNote: "Save as a new note",
  uploadAgain: "Upload again",
  informationThatIsUsuallyHiddenFrom: "information that is usually hidden from AI agents",
  and: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `${value0} and ${value1}`,
  inTheText: " in the text",
  theCheckFound: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `the check found${value0} ${value1}`,
  fileSavedButAgentsCannotSee: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `File saved, but agents cannot see it yet: ${value0}. People ${value1} can see it as usual.`,
  fileSavedAgentsCannotSeeIt: "File saved. Agents cannot see it yet",
  peopleCanSeeItAsUsual: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `${value0}. People ${value1} can see it as usual.`,
};
export const CLOSED_CLASS_TEXT = {
  "closedClassLine": "This record is closed: only people can read it here in the workspace, and every opening is logged. Your AI agent cannot read it until you show it to agents.",
  "closedSessionLine": "You can read closed records here in the workspace through your space role or as a meeting participant. Every opening of a closed record is recorded in the audit log, visible in “My actions”. Closed records are never sent to AI agents. To let agents read your record, show it to agents.",
  "closedSpaceNotice": "Only open records appear here: this is what an AI agent with a personal key can see. People can read closed records in the workspace by signing in with their own account.",
  "closedHiddenLabel": "closed records hidden",
  "closedHiddenHint": "Only open records appear here, as they do for an AI agent with a personal key. Closed records show only their date and record number, without a title or text.",
  "closedHiddenActions": "You can show your hidden record to agents or move it to Trash without reading it: both actions use the record number. You can show it to agents only here in the workspace, and you cannot take back what agents have already read.",
  "openClassWarning": "AI agents of everyone who can see this space, such as Claude Code or Codex, will be able to read the record. These agents use external cloud models, so the record text will be sent outside your company. You can hide the record from agents again, but they will keep what they have already read.",
  "openClassLead": "You cannot take back what agents have already read.",
  "openSpaceWarning": "AI agents of all members, such as Claude Code or Codex, can read records in an open space. These agents use external cloud models, so record text leaves your company. Agents also see the space name, description and address; the address appears in repository files (CLAUDE.md, AGENTS.md). All three are therefore checked in the same way as open records. If records must not be sent to cloud models, choose a closed space.",
  "repoClosedWarning": "Members’ AI agents can write here, but cannot read any records back, including their own. Agents working in the repository need an open space to use project memory.",
  "repoReaderWarning": "You have read-only access here. Your AI agent can read this space but cannot write to it.",
  "closeClassWarning": "Agents will immediately stop finding and reading the record. The record and its original file will then move to closed storage. Agents that have already read the record may have saved a copy: hiding only affects future access.",
  "closeClassConfirm": "Hide the record from agents? Agents will immediately stop finding and reading the record. The record and its original file will then move to closed storage. Agents that have already read the record may have saved a copy: hiding only affects future access.",
  "closedExplainTitle": "Why some records are hidden",
  "showAnywayOpen": "The record is already visible to agents.",
  "showAnywayInProgress": "The record is being hidden from or shown to agents. Refresh the page in a minute.",
  "showAnywayClosing": "The record is being hidden from agents. Wait a minute and try again.",
  "showAnywayDone": "Done: the record is being shown to agents. They will be able to read it in a few seconds. You can hide it again here.",
  "showAnywayBecoming": "The record is becoming visible to agents. This will take a few seconds.",
  "showAnywayRefused": "The record was not shown to agents because something changed during the process. Open it and check again. See “My actions” for details.",
  "showAnywayLook": "See what the check found",
  "uploadKeptAgain": "This file is already uploaded here and hidden from agents.",
  "uploadKeptLink": "Review and show to agents"
} as const;
export const ACCESS_ACTION = {
  "show": "Show to agents",
  "hide": "Hide from agents",
  "title": "Access for AI agents",
  "more": "Details"
} as const;
export const SHOW_AGENTS_LINES = [
  [
    "Why",
    "AI agents will find the record and use it to answer questions for you and colleagues who can see it."
  ],
  [
    "Who will see it",
    "AI agents of everyone who can see the record, such as Claude Code or Codex."
  ],
  [
    "What leaves your company",
    "Agents use external cloud models: the record text will be sent outside your company, and you cannot take back what they have already read."
  ]
] as const;
export const SHOW_ANYWAY_LINES = {
  "found": "What the check found",
  "who": "Who will see it",
  "undo": "Can you undo this?",
  "scope": "What your consent covers"
} as const;
export const SHOW_ANYWAY_STALE: Readonly<Record<string, string>> = {
  "changed": "The record changed while this page was open. Review the findings again.",
  "more_found": "The check found something new in the record. Review the findings again.",
  "audience": "The record’s audience has changed. Review who will see it again.",
  "expired": "This page was open too long. Memory has checked the record again; review it again.",
  "consent_required": "This page is out of date. Refresh it and confirm again.",
  "consent_invalid": "This page is out of date. Refresh it and confirm again."
};
