import { pluralEn } from "../../i18n/core";
import type { OrgReviewViewName } from "../../lib/types";
import type { OrgWrongReason } from "../../lib/types";
export const orgReview = {
  noCurators: (days: number | null): string => `No curators: nobody reviews new company knowledge records — they return automatically${days ? ` after ${days} ${pluralEn(days, "day", "days")}` : " when their review period ends"}, and no one receives the weekly email.`,
  curatorsHint: (days: number | null, title: string): string => `The first team’s manager and 1–2 deputies. New company knowledge records are immediately visible to everyone with an “unconfirmed” mark; curators confirm, return to a project or delete them weekly in the workspace (“${title}” section). Any curator acts for everyone. Without confirmation, a record returns to its original space automatically${days ? ` after ${days} ${pluralEn(days, "day", "days")}` : ""}.`,
  confirmUsefulRecordsAndReturnTheRest: "Confirm useful records and return the rest — usually 10 minutes a week.",
  nothingToReview: "Nothing to review.",
  return: "Return",
  showingOfTheRestAreOnLater: (value0: unknown, value1: unknown): string => `Showing ${value0} of ${value1}: the rest are on later pages or will appear after decisions on these records.`,
  wasHereBeforeReview: "was here before review",
  fromAnotherSpace: "from another space",
  fromTheAuthorSPersonalSpace2: "from the author’s personal space",
  from: (value0: unknown): string => `from “${value0}”`,
  toTheAuthorSPersonalSpace: "to the author’s personal space",
  toItsOriginalSpace: "to its original space",
  to: (value0: unknown): string => `to “${value0}”`,
  returnTheRecordColleaguesWithoutAccessThere: (value0: unknown): string => `Return the record ${value0}? Colleagues without access there will no longer see it. The author will see this in “My actions”.`,
  forDays: (value0: unknown): string => ` for ${value0} days`,
  deleteTheRecordItWillReturnAnd: (value0: unknown, value1: unknown): string => `Delete the record? It will return ${value0} and immediately go to Trash there${value1}; the author can restore it there, rather than in “Company knowledge”.`,
  wrong: "Wrong",
  notForEveryone: "Not for everyone",
  hiddenFromAgents: "hidden from agents",
  peopleMarkedWrongNotForEveryoneAgents: "People marked “Wrong / not for everyone”: agents cannot find it until you decide",
  marksRemovedAwaitingADecision: "marks removed — awaiting a decision",
  everyoneWhoMarkedItHasRemovedTheir: "Everyone who marked it has removed their mark: agents can find it again, but a curator still needs to decide",
  useful: (value0: unknown): string => `Useful: ${value0}`,
  confirmedByTheCommunity: "confirmed by the community",
  addedByAnAgentWithExtendedAccess: "added by an agent with extended access",
  aCuratorReviewsTheseRecordsEvenWhen: "A curator reviews these records even when the community has confirmed them",
  authorHasLeftNowhereToReturnIt: "author has left — nowhere to return it",
  confirmOrDeleteTheRecordItCannot: "Confirm or delete the record: it cannot return automatically",
  reviewPeriodEnded: "review period ended",
  willReturnAtTheNextCheckUnless: "Will return at the next check unless you confirm it",
  readershipRestrictedTitleHidden: "Readership restricted — title hidden",
  youCannotSeeThisRecordACurator: "You cannot see this record: a curator within its readership can open it and decide.",
  willNotReturnAutomatically: "will not return automatically",
  willNotReturnUntilYouDecide: "will not return until you decide",
  confirmedByTheCommunityWillNotReturn: "confirmed by the community; will not return automatically",
  willReturnOn: (value0: unknown): string => `will return on ${value0}`,
  noDeadline: "no deadline",
  curatorsHaveNotReviewedThisRecordYet: "Curators have not reviewed this record yet.",
  ifItContainsAnErrorOrInformation: "If it contains an error or information not meant for everyone, mark “Wrong / not for everyone”: AI agents will stop finding it until a curator decides.",
  thisIsAnEarlierVersionMarkWrong: "This is an earlier version: mark “Wrong / not for everyone” on the current version.",
  theOrgTableFillsInColleagueCards: "The org table fills in colleague cards: curators do not return them; errors are corrected in the org table.",
  markedWrongNotForEveryoneAgentsCannot: "Marked “Wrong / not for everyone”: agents cannot find it until a curator decides. People see it with this mark.",
  theWrongNotForEveryoneMarksHave: "The “Wrong / not for everyone” marks have been removed: agents can find it again, but it still awaits a curator’s decision.",
  willReturnTo: (value0: unknown): string => `will return to “${value0}”`,
  willReturnToYourPersonalSpace: "will return to your personal space",
  willReturnToTheAuthor: "will return to the author",
  ifItIsNotConfirmedByIt: (value0: unknown, value1: unknown): string => ` If it is not confirmed by ${value0}, it ${value1}.`,
  unconfirmedAllColleaguesAndTheirAgentsCan: (value0: unknown): string => `Unconfirmed: all colleagues and their agents can see the record, but it ranks lower in search. Curators review it weekly.${value0}`,
  confirmedByACuratorWillNotReturn: "Confirmed by a curator: will not return automatically.",
  confirmedByTheCommunityColleaguesFromDepartments: (value0: unknown): string => `Confirmed by the community: colleagues from ${value0} departments marked it “Useful”. It will not return automatically.`,
  addedByAnAiAgentWithExtended: "Added by an AI agent with extended access — a curator will review it in any case.",
  to2: (value0: unknown): string => `to “${value0}”`,
  toYourPersonalSpace: "to your personal space",
  removeTheRecordFromCompanyKnowledgeColleagues: (value0: unknown): string => `Remove the record from “Company knowledge” ${value0}? Colleagues without access there will no longer see it.`,
  wrong2: "Wrong",
  notForEveryone2: "Not for everyone",
  youMarked: (value0: unknown): string => `You marked: “${value0}”.`,
  after: (value0: unknown, value1: unknown): string => `, after ${value0} ${value1}`,
  nothingAwaitingReview: "Nothing awaiting review.",
  hiddenAsWrongNotForEveryone: (value0: unknown): string => ` · hidden as “Wrong / not for everyone”: ${value0}`,
  awaitingReviewNewThisWeek: (value0: unknown, value1: unknown, value2: unknown): string => `Awaiting review: ${value0} (new this week: ${value1})${value2}`,
  oldestSince: (value0: unknown): string => ` · oldest since ${value0}`,
  returningAutomaticallyInTheNext7Days: (value0: unknown, value1: unknown): string => ` · returning automatically in the next 7 days: ${value0}${value1}.`,
  weeklyCuratorEmailIsDisabledInSettings: "Weekly curator email is disabled in settings (“Access” section).",
  monday2: "Monday",
  onAt: (value0: unknown, value1: unknown, value2: unknown): string => `on ${value0} at ${value1} (${value2})`,
  curatorEmailWhenThereAreRecordsTo: (value0: unknown): string => `Curator email — ${value0}, when there are records to review: counts and a link, without record titles.`,
  curatorEmailButEmailIsDisabledNothing: (value0: unknown): string => `Curator email — ${value0}, but email is disabled: nothing is sent.`,
  lastReviewPeriodCheck: (value0: unknown): string => `Last review-period check — ${value0}`,
  returnedAutomatically: (value0: unknown): string => `returned automatically: ${value0}`,
  returnedAfterReadershipWasRestricted: (value0: unknown): string => `returned after readership was restricted: ${value0}`,
  emailForTheWeek: (value0: unknown): string => `email for the week ${value0}`,
  emailForWeek: (value0: unknown): string => `email for week ${value0}`,
  notSent: (value0: unknown): string => `${value0}: not sent`,
  reviewTitle: "Company knowledge review",
};

export const REVIEW_MORE = [
  "New records in “Company knowledge” appear here. Any curator acts for everyone.",
  "Without confirmation, a record returns to its original space when its review period ends.",
  "Records marked “Wrong / not for everyone” are hidden from agents until you decide and appear first.",
] as const;

export const REVIEW_FOR_EMPLOYEE = {
  title: "This section is for “Company knowledge” curators",
  what: "Curators review new records in “Company knowledge” once a week: they confirm useful records, and unconfirmed records return to their original space automatically.",
  you: "You can mark a record as “Useful” or “Wrong / not for everyone” on its page. The second mark immediately hides it from agents until a curator decides.",
  who: "The memory administrator appoints curators.",
  open: ((value0: unknown): string => `Open “${value0}”`)("Company knowledge"),
} as const;

export const FROM_KIND: Record<string, string> = { project: "from a project", team: "from a team", personal: "from the author’s personal space" };

export const ORG_REVIEW_TEXT = {
  confirmReview: "Confirm the record for everyone? The “unconfirmed” mark will be removed, it will not return when its review period ends, and agents will find it again.",

  orgNarrowHint: "This meeting is in “Company knowledge”, where all colleagues can see it. After the participant list changes, only the organiser and participants will see it, and it will return to its original space.",

  orgNarrowStayHint: "This meeting is in “Company knowledge”, where all colleagues can see it. After the participant list changes, only the organiser and participants will see it.",
  usefulHint: "Two “Useful” marks from different departments confirm the record through the community: it will not return when its review period ends. Marks from colleagues without a department are counted, but do not contribute to confirmation.",
  wrongConfirm: "Agents will immediately stop finding the record until a curator decides. Curators will see your mark and your name.",
  wrongHint: "For “Wrong”, explain what is correct: this becomes a record correction. For “not for everyone”, an explanation is optional.",
};

export const VIEW_BADGE: Record<OrgReviewViewName, { text: string }> = {
  unreviewed: { text: "unconfirmed" },
  confirmed: { text: "confirmed by a curator" },
  community: { text: "confirmed by the community" },
  disputed: { text: "marked “Wrong / not for everyone”" },
};

export const WRONG_REASONS: Array<{ label: string }> = [
  { label: "Wrong — the record contains an error" },
  { label: "Not for everyone — contains confidential information" },
];

export const ORG_DONE: Record<string, string> = {
  useful: "“Useful” mark added.",
  unuseful: "“Useful” mark removed.",
  wrong: "Mark added: agents cannot find the record until a curator decides.",
  unwrong: "Your mark has been removed.",
  confirm: "Record confirmed for everyone.",
  return: "Record returned.",
  delete: "Record returned and moved to Trash.",
};

export const ORG_PARTIAL = {
  delete_partial: "The record was returned to its author, but could not be deleted there — the author or that space’s owner can delete it.",
} as const;

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
