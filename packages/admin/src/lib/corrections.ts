import { text as M } from "../messages/corrections";
import { derived } from "../i18n/runtime";
import { failState, type ActionResult } from "./action-state";
import { archivedOf, toolErrorMessage, type McpFail } from "./mcp-parse";
import { formatWhen } from "./format";
import { instanceTz } from "../i18n/runtime";
import { formatDay, GUIDE_PLAIN } from "./plain";
import { guideApplyHref, guideProposalsHref } from "./space-guide";
import { PREVIEW_TEXT } from "./preview";
import type { OpenCheckMark, CorrectionFields, CorrectionKind, CorrectionRole, CorrectionStatus, CorrectionView, CorrectResult, EventFields } from "./types";

export const CORRECTION_KINDS: readonly CorrectionKind[] = ["extraction_error", "wrong", "outdated", "own_note"];
export const isCorrectionKind = (s: string): s is CorrectionKind => (CORRECTION_KINDS as readonly string[]).includes(s);

export { CORRECTION_KIND_TITLES } from "../messages/corrections";
import { CORRECTION_KIND_TITLES } from "../messages/corrections";
export const CORRECTION_KIND_ORDER: readonly CorrectionKind[] = ["own_note", "extraction_error", "wrong", "outdated"];
export const OTHER_KINDS: ReadonlySet<CorrectionKind> = new Set<CorrectionKind>(["wrong", "outdated"]);


export function correctionKindTitle(kind: CorrectionKind, type?: string | null, eventKind?: string | null): string {
  if (kind !== "own_note") return CORRECTION_KIND_TITLES[kind];
  return M.ownTextTitle(type ?? "", eventKind ?? null);
}

export function actorsFieldLabel(eventKind: string | null | undefined): string {
  return M.actorsField(eventKind ?? null);
}

export const isCalendarDate = (due: string | null | undefined): due is string => typeof due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(due);
export const dueWordsHint = (due: string): string => M.currentlyChooseADateToReplace(due);

export { CORRECTION_KIND_HINTS } from "../messages/corrections";
import { CORRECTION_KIND_HINTS } from "../messages/corrections";
export { CORRECTION_STATE_TITLES } from "../messages/corrections";
import { CORRECTION_STATE_TITLES } from "../messages/corrections";
export { CORRECTION_BY_TITLES } from "../messages/corrections";







export { OLD_VERSION } from "../messages/corrections";
import { OLD_VERSION } from "../messages/corrections";






export { CORRECTIONS_SECTIONS } from "../messages/corrections";
import { CORRECTIONS_SECTIONS } from "../messages/corrections";

export { CORRECTIONS_EMPTY } from "../messages/corrections";
import { CORRECTIONS_EMPTY } from "../messages/corrections";
export function correctionStateBadge(v: Pick<CorrectionView, "status" | "via">): { label: string; tone: "ok" | "warn" | "muted" | "danger" } {
  switch (v.status) {
    case "applied": return { label: M.applied2, tone: "ok" };
    case "proposed": return { label: M.awaitingADecision2, tone: "warn" };
    case "rejected": return { label: M.rejected2, tone: "muted" };
    case "withdrawn": return { label: M.withdrawn2, tone: "muted" };
    case "superseded": return { label: M.outOfDateRecordChanged2, tone: "muted" };
    case "cancelled": return v.via === "plan" ? { label: M.planCancelledNotApplied, tone: "muted" } : { label: M.notSavedTryAgain, tone: "danger" };
    case "planned": return { label: M.notApplied2, tone: "muted" };
  }
}
export { DECIDED_BY_TITLES } from "../messages/corrections";
import { DECIDED_BY_TITLES } from "../messages/corrections";
export function correctionDecidedLine(v: Pick<CorrectionView, "status" | "decided_at" | "decided_by_role">): string | null {
  if (!v.decided_at) return null;
  const day = formatDay(v.decided_at);
  const role = v.decided_by_role ? DECIDED_BY_TITLES[v.decided_by_role] : null;
  if (role && v.status === "rejected") return M.decidedLine(v.status, v.decided_by_role!, day);
  if (role && v.status === "applied") return M.decidedLine(v.status, v.decided_by_role!, day);
  return day;
}

export { DECISION_DONE } from "../messages/corrections";
import { DECISION_DONE } from "../messages/corrections";
export type CorrectionDecision = keyof typeof DECISION_DONE;

export function bulkEmptyText(skipped: Array<{ reason: string; count: number }> | undefined): string {
  const has = (r: string) => (skipped ?? []).some((x) => x.reason === r && x.count > 0);
  if (has("in_progress")) return M.theMeetingIsBeingMovedBetween;
  if (has("archived")) return M.theMeetingSSpaceIsArchived;
  if (has("no_rights")) return M.meetingParticipantsTheAuthorAndThe;
  return CORRECTIONS_COPY.bulkEmpty;
}



export const LIMITS = { title: 200, statement: 2000, text: 2000, actors: 20, actor: 120, quoteMin: 8, quoteMax: 1000 } as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
export const isUuid = (s: string): boolean => UUID.test(s);

export const charCount = (s: string): number => [...s].length;
export const multiline = (s: string): string => s.replace(/\r\n?/g, "\n").trim();

/**
 * Day and month in words on the clock of the installation (as meeting deadlines in meeting-state.ts): a correction made at
 * 01:30 local time is already the next day. Without the year — the common date style (formatWhen).
 */
export function dayMonth(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : formatWhen(iso, { tz: instanceTz(), dayOnly: true, year: false });
}

export function correctionLine(v: CorrectionView): string {
  const day = dayMonth(v.created_at);
  if (v.space_guide && v.status === "applied") return GUIDE_PLAIN.appliedLine(dayMonth(v.decided_at ?? v.created_at));
  switch (v.status) {
    case "applied":
    case "proposed": return M.correctionLine(v, day);
    case "rejected": return M.rejectedLine;
    case "withdrawn": return M.withdrawnLine;
    case "superseded": return M.outOfDateRecordChangedLine;
    default: return M.notAppliedLine;
  }
}

export function correctionLink(v: CorrectionView): { href: string; label: string } | null {
  if (v.space_guide && v.status === "proposed" && v.target.space) return { href: guideProposalsHref(v.target.space), label: GUIDE_PLAIN.openGuide };
  if (v.space_guide && v.status === "applied" && v.result_id) return { href: `/records/${v.result_id}`, label: GUIDE_PLAIN.newVersion };
  if (v.status !== "applied") return null;
  if (v.kind === "wrong" && v.result_id) return { href: `/records/${v.result_id}`, label: M.correctionRecord };
  if (v.kind === "outdated" && v.effect === "link" && v.newer) return { href: `/records/${v.newer.id}`, label: M.newerRecord };
  return null;
}

export function correctionProposal(v: CorrectionView): string[] {
  if (v.space_guide) return [GUIDE_PLAIN.correctionWhat];
  const out: string[] = [CORRECTION_KIND_TITLES[v.kind] ?? M.correction];
  const f: CorrectionFields = v.fields ?? {};
  if (f.title) out.push(M.title(f.title));
  if (f.statement) out.push(M.statement(f.statement));
  if (f.due === null) out.push(M.dueDateRemoved);
  else if (f.due) out.push(M.dueDate(formatDay(f.due)));
  if (f.actors) out.push(M.proposedAssignees(f.actors));
  if (v.quote) out.push(M.phrase(v.quote));
  if (v.newer) out.push(M.proposedNewer(v.newer.title));
  else if (v.effect === "link") out.push(M.newerRecordYouDoNotHave);
  if (v.text) out.push(v.text);
  return out;
}

export interface OwnResult { cls: "open" | "closed"; why: string | null; mark?: OpenCheckMark | null }

export function correctResultText(r: CorrectResult, closedResult: boolean, own?: OwnResult | null): { message: string; link?: { href: string; label: string } } {
  if (r.already_known) return { message: M.knownResult(r.status === "applied") };
  if (r.status === "proposed") return { message: CORRECTIONS_COPY.proposedDone };
  const link = r.effect === "new_version" && r.result_id && isUuid(r.result_id) ? { link: { href: `/records/${r.result_id}`, label: M.openCorrectedRecord } } : {};
  if (r.kind === "own_note" && closedResult) return { message: M.savedOnlyPeopleCanSeeThe, ...link };
  if (r.kind === "own_note" && own?.cls === "open") return { message: M.savedYourAiAgentsCanSee, ...link };
  if (r.kind === "own_note" && own?.cls === "closed")
    return { message: own.mark ? M.closedCheckResult(own.mark) : M.closedResult(own.why), ...link };
  if (r.kind === "extraction_error" && !r.quote_checked) return { message: M.correctedWithoutAConfirmingPhraseThe, ...link };
  if (r.effect === "new_version") return { message: M.correctedAgentsWillFindTheCorrected, ...link };
  if (r.effect === "annotation") return { message: M.correctionSavedAlongsideTheRecordSearch };
  return { message: M.markedAsReplacedByANewer2 };
}

export function parseRecordRef(s: string): string | null {
  const bare = s.replace(/[?#]\S*/g, "");
  const pages = [...bare.matchAll(new RegExp(`/records/(${UUID_ANY.source})`, "gi"))];
  if (pages.length) return pages[pages.length - 1]![1]!.toLowerCase();
  const all = bare.match(UUID_ANY);
  return all?.length ? all[all.length - 1]!.toLowerCase() : null;
}

export function parseActors(s: string): string[] {
  return [...new Set(s.split(/[,;\r\n]+/).map((a) => a.trim()).filter(Boolean))];
}

export function sameName(a: string, b: string): boolean {
  const norm = (x: string) => x.normalize("NFKC").toLowerCase().replaceAll("ё", "е").replace(/\p{M}+/gu, "").replace(/[^\p{L}\p{N}_]+/gu, " ").trim();
  return norm(a) === norm(b);
}

export interface EventForm { title: string; statement: string; due: string; noDue: boolean; actors: string }
export function eventFieldsChange(was: EventFields, f: EventForm): { fields: CorrectionFields; error?: undefined } | { error: string; fields?: undefined } {
  const fields: CorrectionFields = {};
  const title = f.title.trim(), wasTitle = (was.title ?? "").trim();
  if (!title && wasTitle) return { error: M.titleCannotBeEmpty };
  if (charCount(title) > LIMITS.title) return { error: M.titleMustBeAtMost200 };
  if (title && title !== wasTitle) fields.title = title;
  const statement = multiline(f.statement), wasStatement = multiline(was.statement ?? "");
  if (!statement && wasStatement) return { error: M.statementCannotBeEmpty };
  if (charCount(statement) > LIMITS.statement) return { error: M.statementMustBeAtMost2 };
  if (statement && statement !== wasStatement) fields.statement = statement;
  const due = f.due.trim();
  if (f.noDue && due) return { error: M.enterADueDateOrSelect };
  if (due && (!/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(Date.parse(due)) || new Date(due).toISOString().slice(0, 10) !== due)) return { error: M.chooseADueDateFromThe };
  if (f.noDue && was.due !== null) fields.due = null;
  else if (due && due !== was.due) fields.due = due;
  const actors = parseActors(f.actors);
  if (actors.length > LIMITS.actors) return { error: M.useNoMoreThan20Assignees };
  if (actors.some((a) => charCount(a) > LIMITS.actor)) return { error: M.anAssigneeSNameMustBe };
  const wasActors = parseActors((was.actors ?? []).join(", "));
  if (actors.length !== wasActors.length || actors.some((a, i) => a !== wasActors[i])) fields.actors = actors;
  return Object.keys(fields).length ? { fields } : { error: CORRECTIONS_COPY.nothingChangedEvent };
}

const REASON_TEXTS: Record<string, string> = derived(() => ({
  quote_not_found: M.thisExactPhraseWasNotFound,
  quote_check_timeout: M.thePhraseCouldNotBeChecked,
  quote_not_allowed: M.youCannotSeeThisMeetingS,
  kind_not_applicable: M.thisKindOfCorrectionDoesNot,
  not_current: M.thisRecordHasAlreadyBeenCorrected,
  origin_not_allowed: M.aPersonMustPerformThisAction,
  text_too_long: M.tooLongUseAtMost2,
  newer_older: M.theSpecifiedRecordIsOlderThan,
  newer_not_shared: M.theAuthorOfTheRecordBeing,
  archived: M.thisSpaceIsArchivedItsRecords,
  own_note_not_author: M.theNoteAuthorAndSpaceOwner,
  not_participant: M.theRecordAuthorMeetingParticipantsAnd2,
  not_proposed: M.aDecisionHasAlreadyBeenMade,
  superseded: M.theRecordChangedAfterThisProposal,
  not_rejectable: M.aNewVersionCannotBeRejected,
  too_many_items: M.thisMeetingHasTooManyEvents,
  preview: PREVIEW_TEXT.previewDenied,
}));


export function correctionErrorText(code: string, reason: string | null | undefined, o: { kind?: string; currentId?: boolean } = {}): string | null {
  if (code === "too_large") return M.theNoteTextIsTooLong;
  if (code === "not_found") return CORRECTIONS_COPY.notFoundText;
  if (code === "in_progress") return reason === "overloaded" ? null : M.theRecordIsBeingChangedTry;
  if (reason === "not_current" && o.kind === "outdated" && !o.currentId) return (M.theSpecifiedNewerRecordHasItself);
  if (reason && REASON_TEXTS[reason]) return REASON_TEXTS[reason];
  if (code === "invalid_argument" && !reason) return M.checkTheFormFieldsSomethingIs;
  return null;
}

type Fail = Pick<McpFail, "code" | "message" | "retryAfter" | "hint" | "details"> & { status?: number };
export function correctionFailState(fail: Fail, kind?: string): ActionResult {
  const d = (fail.details && typeof fail.details === "object" ? fail.details : {}) as { reason?: unknown; current_id?: unknown };
  const reason = typeof d.reason === "string" ? d.reason : archivedOf(fail.details) ? "archived" : null;
  const currentId = typeof d.current_id === "string" && isUuid(d.current_id) ? d.current_id : null;
  const own = correctionErrorText(fail.code, reason, { kind, currentId: Boolean(currentId) });
  if (own) {
    if (reason === "preview") return failState(own, { lines: [PREVIEW_TEXT.previewDeniedHint] });
    return failState(own, reason === "not_current" && currentId ? { link: { href: `/records/${currentId}`, label: M.openCurrentVersion } } : {});
  }
  return failState(toolErrorMessage(fail), fail.hint ? { lines: [fail.hint] } : {});
}

export function guideApplyLink(v: CorrectionView): { href: string; label: string } | null {
  return v.space_guide && v.status === "proposed" && v.can.reject && v.target.space ? { href: guideApplyHref(v.target.space, v.id), label: GUIDE_PLAIN.apply } : null;
}

export const CORRECTIONS_COPY = derived(() => ({
  otherKindsTitle: M.otherCases,
  correctLead: M.theCorrectionIsSavedInMemory,
  proposeWarning: M.theRecordAuthorMeetingParticipantsAnd,
  closedResultWarning: M.afterSavingYourAiAgentsWill,
  openKeptHint: M.yourAiAgentsWillContinueTo,
  noteTruncatedHint: M.thisIsALongNotePaste,
  fragmentLead: M.transcriptExcerptAroundTheEventCopy,
  meetingResetNotice: M.aNewMeetingVersionResetsCorrections,
  bulkLead: M.ifTheSameAssigneeWasRecorded,
  proposedDone: M.proposalSentUntilItIsApproved,
  confirmProposed: M.confirmThisCorrectionEveryoneWhoCan,
  confirmApplied: M.confirmThatTheCorrectionIsAccurate,
  confirmUndo: M.removeThisCorrectionItWillNo,
  correctionsLead: M.memoryCorrectionsAwaitingYourDecisionAnd,
  toConfirmHint: M.colleaguesProposedCorrectionsToRecordsYou,
  mineHint: M.correctionsYouMadeOrProposedWhile,
  notFoundText: M.theRecordOrCorrectionIsUnavailable,
  bulkEmpty: M.noDecisionInThisMeetingHas,
  nothingChangedEvent: M.changeAtLeastOneFieldTitle,
  nothingChangedNote: M.changeTheNoteTextOrTitle,
}));
