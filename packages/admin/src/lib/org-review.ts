import { derived, derivedList } from "../i18n/runtime";
import { REVIEW_MORE, REVIEW_FOR_EMPLOYEE as REVIEW_FOR_EMPLOYEE_LABELS, FROM_KIND, ORG_REVIEW_TEXT, VIEW_BADGE as VIEW_BADGE_LABELS, WRONG_REASONS as WRONG_REASONS_LABELS, ORG_DONE, ORG_PARTIAL, WEEKDAYS } from "../messages/org-review";
import { orgReview as M } from "../messages/org-review";
import { formatWhen } from "./format";
import { zoneLabel } from "../i18n/format";
import { instanceTz } from "../i18n/runtime";
import { isoWeekDates, SECTION_TITLES } from "./plain";
import type { OrgReviewAdmin, OrgReviewItem, OrgReviewViewName, OrgWrongMark, OrgWrongReason, RecordOrgReview } from "./types";


export { REVIEW_MORE } from "../messages/org-review";


/** A date in words for lines and confirmations, on the clock of the installation like the curators' mail (formatWhen, with the year). */
export const reviewDay = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : formatWhen(iso, { tz: instanceTz(), dayOnly: true, year: true });
};

export const queueTail = (shown: number, total: number): string | null =>
  total > shown ? M.showingOfTheRestAreOnLater(shown, total) : null;


export function fromText(from: OrgReviewItem["from"]): string {
  if (!from) return M.wasHereBeforeReview;
  if ("hidden" in from) return FROM_KIND[from.kind] ?? M.fromAnotherSpace;
  if (from.kind === "personal") return M.fromTheAuthorSPersonalSpace2;
  return M.from(from.name);
}

const whereTo = (from: OrgReviewItem["from"]): string =>
  !from || from.kind === "personal" ? M.toTheAuthorSPersonalSpace : "hidden" in from ? M.toItsOriginalSpace : M.to(from.name);

/** Texts of this module that other sections read; one dictionary, so that it can follow the interface language. */
export { ORG_REVIEW_TEXT } from "../messages/org-review";
export const returnConfirm = (from: OrgReviewItem["from"]): string =>
  M.returnTheRecordColleaguesWithoutAccessThere(whereTo(from));
export const deleteConfirm = (from: OrgReviewItem["from"], trashDays?: number | null): string =>
  M.deleteTheRecordItWillReturnAnd(whereTo(from), trashDays ? M.forDays(trashDays) : "");

export function wrongGroups(marks: readonly OrgWrongMark[]): Array<{ reason: OrgWrongReason; label: string; count: number; names: string }> {
  const out: Array<{ reason: OrgWrongReason; label: string; count: number; names: string }> = [];
  for (const reason of ["wrong", "not_for_all"] as const) {
    const m = marks.filter((x) => x.reason === reason);
    if (m.length) out.push({ reason, label: reason === "wrong" ? M.wrong : M.notForEveryone, count: m.length, names: m.map((x) => x.name || x.login).join(", ") });
  }
  return out;
}

export function itemBadges(it: OrgReviewItem): Array<{ text: string; tone: "warn" | "danger" | "info" | "neutral" | "muted"; title?: string }> {
  const out: Array<{ text: string; tone: "warn" | "danger" | "info" | "neutral" | "muted"; title?: string }> = [];
  if (it.held) out.push({ text: M.hiddenFromAgents, tone: "danger", title: M.peopleMarkedWrongNotForEveryoneAgents });
  else if (it.disputed) out.push({ text: M.marksRemovedAwaitingADecision, tone: "warn", title: M.everyoneWhoMarkedItHasRemovedTheir });
  for (const g of wrongGroups(it.wrong_marks)) out.push({ text: `${g.label} ×${g.count}`, tone: "warn", title: g.names });
  if (it.useful) out.push({ text: M.useful(it.useful), tone: "info" });
  if (it.state === "community") out.push({ text: M.confirmedByTheCommunity, tone: "neutral" });
  if (it.extended) out.push({ text: M.addedByAnAgentWithExtendedAccess, tone: "warn", title: M.aCuratorReviewsTheseRecordsEvenWhen });
  if (it.no_target) out.push({ text: M.authorHasLeftNowhereToReturnIt, tone: "muted", title: M.confirmOrDeleteTheRecordItCannot });
  else if (it.overdue) out.push({ text: M.reviewPeriodEnded, tone: "muted", title: M.willReturnAtTheNextCheckUnless });
  return out;
}



export function itemDue(it: OrgReviewItem): string {
  if (it.no_target) return M.willNotReturnAutomatically;
  if (it.held) return M.willNotReturnUntilYouDecide;
  if (it.state === "community") return M.confirmedByTheCommunityWillNotReturn;
  return it.return_after ? M.willReturnOn(reviewDay(it.return_after)) : M.noDeadline;
}





export function recordReviewLines(v: RecordOrgReview, whereName: string | null, o: { card?: boolean; old?: boolean } = {}): string[] {
  const out: string[] = [];
  if (v.exempt === "org_card" || (o.card && !v.state)) out.push(M.theOrgTableFillsInColleagueCards);
  if (!v.state && !o.card) out.push(v.can.wrong ? `${M.curatorsHaveNotReviewedThisRecordYet} ${M.ifItContainsAnErrorOrInformation}` : o.old ? M.thisIsAnEarlierVersionMarkWrong : M.curatorsHaveNotReviewedThisRecordYet);
  if (v.held) out.push(M.markedWrongNotForEveryoneAgentsCannot);
  else if (v.disputed) out.push(M.theWrongNotForEveryoneMarksHave);
  if (v.state === "unreviewed") {
    const back = whereName ? M.willReturnTo(whereName) : v.author ? M.willReturnToYourPersonalSpace : M.willReturnToTheAuthor;
    out.push(M.unconfirmedAllColleaguesAndTheirAgentsCan(v.return_after && !v.held ? M.ifItIsNotConfirmedByIt(reviewDay(v.return_after), back) : ""));
  }
  if (v.state === "confirmed") out.push(M.confirmedByACuratorWillNotReturn);
  if (v.state === "community") out.push(M.confirmedByTheCommunityColleaguesFromDepartments(v.marks.useful_teams));
  if (v.extended) out.push(M.addedByAnAiAgentWithExtended);
  return out;
}


export const authorReturnConfirm = (whereName: string | null): string =>
  M.removeTheRecordFromCompanyKnowledgeColleagues(whereName ? M.to2(whereName) : M.toYourPersonalSpace);
export const myWrongText = (r: OrgWrongReason): string => M.youMarked(r === "wrong" ? M.wrong2 : M.notForEveryone2);

export { ORG_DONE } from "../messages/org-review";
export type OrgOp = "useful" | "unuseful" | "wrong" | "unwrong" | "confirm" | "return" | "delete";
export const isOrgOp = (op: string): op is OrgOp => Object.hasOwn(ORG_DONE, op);
export { ORG_PARTIAL } from "../messages/org-review";
export type OrgDone = OrgOp | keyof typeof ORG_PARTIAL;
export const isOrgPartial = (op: string): op is keyof typeof ORG_PARTIAL => Object.hasOwn(ORG_PARTIAL, op);

export const curatorsHint = (days: number | null): string => M.curatorsHint(days, SECTION_TITLES.review);
export const noCuratorsText = (days: number | null): string => M.noCurators(days);
export function queueLine(r: Pick<OrgReviewAdmin, "waiting" | "new_week" | "held" | "due_week" | "oldest_entered_at">): string {
  if (!r.waiting) return M.nothingAwaitingReview;
  return M.awaitingReviewNewThisWeek(r.waiting, r.new_week, r.held ? M.hiddenAsWrongNotForEveryone(r.held) : "") +
    M.returningAutomaticallyInTheNext7Days(r.due_week, r.oldest_entered_at ? M.oldestSince(reviewDay(r.oldest_entered_at)) : "");
}
export function digestLine(r: Pick<OrgReviewAdmin, "mail_enabled" | "settings">): string {
  const d = r.settings.digest;
  if (!d.enabled) return M.weeklyCuratorEmailIsDisabledInSettings;
  const when = M.onAt(WEEKDAYS[d.weekday - 1] ?? M.monday2, d.time, zoneLabel(d.tz));
  return r.mail_enabled ? M.curatorEmailWhenThereAreRecordsTo(when)
    : M.curatorEmailButEmailIsDisabledNothing(when);
}
export function lastRunLine(v: Record<string, unknown> | null): string | null {
  if (!v || typeof v.at !== "string") return null;
  const parts = [M.lastReviewPeriodCheck(reviewDay(v.at)), M.returnedAutomatically(Number(v.returned ?? 0))];
  if (Number(v.narrowed ?? 0)) parts.push(M.returnedAfterReadershipWasRestricted(Number(v.narrowed)));
  if (typeof v.digest_week === "string") {
    const week = isoWeekDates(v.digest_week) ? M.emailForTheWeek(isoWeekDates(v.digest_week)) : M.emailForWeek(v.digest_week);
    parts.push(Number(v.digest_sent ?? 0) ? `${week}: ${Number(v.digest_sent)}` : M.notSent(week));
  }
  return `${parts.join(" · ")}.`;
}

export { orgReview as ORG_REVIEW_MESSAGES } from "../messages/org-review";

export const VIEW_BADGE: Record<OrgReviewViewName, { text: string; tone: "warn" | "danger" | "info" | "neutral" }> = derived(() => ({
  unreviewed: { text: VIEW_BADGE_LABELS.unreviewed.text, tone: "warn" },
  confirmed: { text: VIEW_BADGE_LABELS.confirmed.text, tone: "info" },
  community: { text: VIEW_BADGE_LABELS.community.text, tone: "info" },
  disputed: { text: VIEW_BADGE_LABELS.disputed.text, tone: "danger" },
}));
export const WRONG_REASONS = derivedList<{ value: OrgWrongReason; label: string }>(() => [
  { value: "wrong", label: WRONG_REASONS_LABELS[0]!.label },
  { value: "not_for_all", label: WRONG_REASONS_LABELS[1]!.label },
]);
export const REVIEW_FOR_EMPLOYEE = derived(() => ({ ...REVIEW_FOR_EMPLOYEE_LABELS, href: `/browse?path=${encodeURIComponent("/org")}` }));
