import { text as M } from "../messages/closed-class";
import { derived } from "../i18n/runtime";

import type { ConfirmSpec } from "@/components/confirm-dialog";
import type { OpenCheckMark } from "./types";

export const readsClosed = (key: { kind: string; tier: string }): boolean => key.kind === "session" || key.tier === "T0";

/** What happens after "Hide from agents"; the dictionary below uses it twice (warning and confirmation). */


/** Texts of this module that other sections read; one dictionary, so that it can follow the interface language. */
export { CLOSED_CLASS_TEXT } from "../messages/closed-class";
import { CLOSED_CLASS_TEXT } from "../messages/closed-class";




export const derivedInList = (e: { type?: string | null; origin?: string | null }): boolean => e.type === "summary" || e.origin === "model";



export const CLOSED_EXPLAIN_ANCHOR = "closed-class";
export const CLOSED_EXPLAIN_HREF = `/materials#${CLOSED_EXPLAIN_ANCHOR}`;

export function openCheckFindingLine(f: { kind: string; reason: string; field: string; at?: number }, o: { position?: boolean } = {}): string {
  return M.findingLine(f, o.position !== false);
}

export function openCheckLead(sourceKind: string | null | undefined, origin?: string | null, o: { personal?: boolean; space?: string | null } = {}): string {
  return M.checkLead(sourceKind ?? null, origin ?? null, o.personal !== false, o.space ?? null);
}

export function openCheckReason(mark: OpenCheckMark, o: { position?: boolean } = {}): string {
  return M.reasonSummary(mark, o.position !== false);
}

export const DESPITE_ACCEPTABLE_RULES = ["phone", "email_near_name", "inn", "passport", "snils", "card", "amount", "contract_number",
  "bank_account", "national_id", "phone_intl", "date_of_birth"] as const;
const DESPITE_NEVER_KINDS = new Set(["secret", "nda", "custom", "never_open"]);

export function despiteOffered(mark: OpenCheckMark): boolean {
  if (mark.result !== "closed") return false;
  if ((mark.kinds ?? []).some((k) => DESPITE_NEVER_KINDS.has(k))) return false;
  if ((mark.findings ?? []).some((f) => DESPITE_NEVER_KINDS.has(f.kind) || !(DESPITE_ACCEPTABLE_RULES as readonly string[]).includes(f.rule))) return false;
  return mark.unchecked !== "empty_text";
}

export const openCheckAdviceText = (mark: OpenCheckMark, o: { offered?: boolean } = {}): string => {
  const offered = o.offered !== false;
  if (mark.by_word === true) return M.wordAdvice(offered);
  if (despiteOffered(mark)) return offered ? M.consentAdvice() : M.disabledAdvice();
  return M.thisCannotBeShownEvenWith;
};





export const OPEN_CLASS_SPEC: ConfirmSpec = derived(() => ({
  question: M.showTheRecordToAgents2,
  change: M.aiAgentsOfEveryoneWhoCan2,
  undo: M.youCanHideTheRecordFrom,
  danger: true,
  ack: { name: "confirm", label: M.iUnderstandTheConsequences },
}));

export const SPACE_OWNER_SPEC: ConfirmSpec = derived(() => ({
  question: M.assignANewSpaceOwner,
  change: M.theyWillBeAbleToDelete,
  undo: M.youCanChangeTheOwnerAgain,
  verb: M.assign,
}));
export function spaceOwnerConfirm(s: { title?: string | null; slug: string; org_unit?: string | null; owner?: { login: string; display_name?: string | null } | null }): ConfirmSpec {
  const prev = s.owner ? s.owner.display_name || s.owner.login : null;
  return {
    question: M.makeTheOwnerOf(s.title || s.slug),
    change: M.ownerChange(prev, Boolean(s.org_unit)),
    undo: SPACE_OWNER_SPEC.undo,
    verb: SPACE_OWNER_SPEC.verb,
    fill: "owner_name|owner_login",
  };
}
export const SPACE_MEMBERS_SPEC: ConfirmSpec = derived(() => ({
  question: M.applyMembershipChanges,
  who: M.addedMembersWillImmediatelySeeSpace,
  undo: M.youCanChangeMembershipAgainHere,
  verb: M.apply,
}));

export { ACCESS_ACTION } from "../messages/closed-class";
import { ACCESS_ACTION } from "../messages/closed-class";

export { SHOW_AGENTS_LINES } from "../messages/closed-class";
import { SHOW_AGENTS_LINES } from "../messages/closed-class";


export const SHOW_AGENTS_SPEC: ConfirmSpec = derived(() => ({ ...OPEN_CLASS_SPEC, verb: ACCESS_ACTION.show }));
export const HIDE_AGENTS_SPEC: ConfirmSpec = derived(() => ({
  question: M.hideTheRecordFromAgents2,
  change: CLOSED_CLASS_TEXT.closeClassWarning,
  undo: M.hideUndo(),
  verb: ACCESS_ACTION.hide,
  danger: true,
}));



export { SHOW_ANYWAY_LINES } from "../messages/closed-class";
import { SHOW_ANYWAY_LINES } from "../messages/closed-class";


export const showAnywayMarks = (n: number): string => M.agentsWillAlsoSeeColleaguesAnnotations(n);








export const SHOW_ANYWAY_NEVER = derived(() => ({
  never_rule: (reasons: string) => M.neverAdvice(reasons),
  sensitive_pii: M.sensitiveAdvice(),
  empty_text: M.noTextWasFoundInThe,
  too_large: M.theRecordAndItsEditHistory,
  scans_disabled: M.theAdministratorHasDisabledShowingScans,
} as const));
const showAnywayNoWrite = (s: string | null) => M.noWriteAdvice(s);
export const SHOW_ANYWAY_NOT_ALLOWED: Readonly<Record<string, (space: string | null) => string>> = derived(() => ({
  org_space: () => M.orgAdvice(),
  org_placement: () => M.thisRecordIsPlacedInCompany,
  other_spaces: () => M.someRecordsExtractedFromThisRecord,
  meeting: () => M.meetingsAndRecordsDerivedFromThem,
  archived: showAnywayNoWrite,
  no_write: showAnywayNoWrite,
  disabled: () => M.disabledGateAdvice(false),
  projects_disabled: () => M.disabledGateAdvice(true),
}));


export { SHOW_ANYWAY_STALE } from "../messages/closed-class";
import { SHOW_ANYWAY_STALE } from "../messages/closed-class";



export function keptReasons(mark: Pick<OpenCheckMark, "findings" | "kinds">): string {
  const reasons = [...new Set((mark.findings ?? []).filter((f) => f.kind !== "never_open").map((f) => f.reason))];
  return M.keptReasons(reasons);
}

export function keptWhy(mark: Pick<OpenCheckMark, "findings" | "kinds" | "via" | "unchecked">): string {
  return M.keptWhy(mark);
}


export const uploadKeptClosed = (mark: Pick<OpenCheckMark, "findings" | "kinds" | "via" | "unchecked">, space: { kind?: string | null; name: string }): string =>
  M.keptUpload(mark, space.kind ?? null, space.name);

export function keptNotice(mark: Pick<OpenCheckMark, "findings" | "kinds" | "via" | "unchecked">, sourceKind: string | null | undefined,
                           where: { kind?: string | null; space?: string | null }): { lead: string; why: string } | null {
  if (sourceKind !== "upload" || (where.kind !== "team" && where.kind !== "project")) return null;
  return { lead: M.fileSavedAgentsCannotSeeIt, why: M.keptNotice(mark, where.kind, where.space ?? null) };
}

export const uploadKept = (space: { kind?: string | null; defaultClass: "open" | "closed" },
                           body: { class?: string | null; already_known?: boolean; open_check?: Pick<OpenCheckMark, "result"> | null }): boolean =>
  (space.kind === "team" || space.kind === "project") && space.defaultClass === "open" && body.class === "closed"
  && (body.already_known === true || body.open_check?.result === "closed");

export const CLOSED_CLASS_COPY = derived(() => ({
  closedRecordHint: M.ifARecordIsClosedAn,
  openClassConfirm: M.openConfirmation(),
  closeDerivedHint: M.thisRecordIsPartOfThe,
  openDerivedHint: M.thisRecordIsPartOfThe2,
  showAnywayAnew: M.asANewNoteOrUpload,
  openDespiteOff: M.disabledAdvice(),
  byWordScopeText: M.allFindingsOfTheseKindsIn,
  openCheckOpenRefuses: M.theUsualShowToAgentsAction,
  openCheckRecheck: M.showToAgentsWillCheckThe,
  openDespiteButton: M.makeAvailableToAgents,
  openAcceptedReopen: M.reopenAdvice(),
  hideAgentsLine: M.agentsWillImmediatelyStopFindingAnd2,
  showAnywayTitle: M.makeAvailableToAgents2,
  showAnywayLead: M.theCheckFoundInformationInThe,
  showAnywayInRecord: M.inTheRecordItself,
  showAnywayInExtracted: M.inRecordsExtractedFromIt,
  showAnywayWhoSolo: M.yourAiAgentsSuchAsClaude,
  showAnywayCloud: M.agentsUseExternalCloudModelsSo,
  showAnywayUndo: M.youCanHideTheRecordFrom,
  showAnywayScope: M.onlyThisRecordAsItIs,
  showAnywayCountNote: M.theCountShowsHowManyPlaces,
  showAnywayScans: M.theFileContainsScannedPagesAgents,
  showAnywayAck: M.iAmTheRecordAuthorAnd,
  showAnywayCancel: M.keepHidden,
  showAnywayRefresh: M.ifThisPageHasBeenOpen,
  showAnywayUnchecked: M.theRecordCouldNotBeChecked,
  showAnywayConversion: M.theFileIsStillBeingProcessed,
  showAnywayFailed: M.theRecordCouldNotBeChecked2,
  showAnywayNotAuthor: M.onlyTheRecordAuthorCanMake,
  showAnywayTextOnly: M.agentsSeeOnlyRecognisedTextThey,
  showAnywayNewNote: M.saveAsANewNote,
  showAnywayReupload: M.uploadAgain,
}));
