import { pluralEn } from "../../i18n/core";
import { formatCount } from "../../i18n/format";

export const searchQuality = {
  fewerPeople: (n: number) => `fewer than ${formatCount(n)} ${pluralEn(n, "person", "people")}`,
  fewerMembers: (n: number) => `fewer than ${formatCount(n)} ${pluralEn(n, "member", "members")}`,
  peopleCount: (n: number) => `${formatCount(n)} ${pluralEn(n, "person", "people")}`,
  smallWeek: (n: number) => `Not enough data: fewer than ${formatCount(n)} ${pluralEn(n, "person searched", "people searched")}`,
  smallSessions: (n: number) => `Not enough data: fewer than ${formatCount(n)} ${pluralEn(n, "person worked", "people worked")} with AI agents`,
  smallSpaces: (n: number, spaces: number) => `Small spaces: fewer than ${formatCount(n)} ${pluralEn(n, "member", "members")} (${formatCount(spaces)})`,
  smallNote: (n: number) => `Numbers are hidden if fewer than ${formatCount(n)} ${pluralEn(n, "person searched", "people searched")}, so that an individual colleague’s search activity cannot be identified.`,
  emptyNothing: (n: number) => `Nothing to show yet: there have been no searches or fewer than ${formatCount(n)} ${pluralEn(n, "person searched", "people searched")}.`,
  sliceHidden: (n: number) => `Breakdown hidden: fewer than ${formatCount(n)} ${pluralEn(n, "person", "people")}`,
  emptyQueriesLead: (n: number) => `What memory could not find. Query text is shown only when at least ${formatCount(n)} different ${pluralEn(n, "person asked", "people asked")} the same question. Query texts are stored for 90 days.`,
  emptyQueriesTail: (hidden: number, n: number) => `${formatCount(hidden)} more ${pluralEn(hidden, "query with no results was", "queries with no results were")} asked by fewer than ${formatCount(n)} ${pluralEn(n, "person", "people")}. Their text is hidden.`,
  emptyQueriesNone: (n: number) => `No queries with no results were asked by ${formatCount(n)} or more ${pluralEn(n, "person", "people")}.`,
  corrections: (day: string) => `will be complete by ${day}`,
  notBuilt: "Calculation has never run yet. It runs every 15 minutes.",
  behind: (n: number) => `Calculation is ${formatCount(n)} ${pluralEn(n, "hour", "hours")} behind. Contact your memory administrator.`,
  lastBuilt: "Last calculation:",
  numbersAppear: (n: number) => `Numbers will appear when at least ${formatCount(n)} different ${pluralEn(n, "person searches", "people search")} in a week`,
  previousWeek: (value: string) => `previous week: ${value}`,
  change: (what: string, up: boolean, before: string, after: string) => `${what} ${up ? "more often" : "less often"}: ${before} → ${after}`,
  pooledLead: (n: number) => `Weeks with too few people searching are grouped into fixed four-week periods: ${formatCount(n)} ${pluralEn(n, "week is", "weeks are")} combined here.${n < 4 ? " Weeks in this period with enough people searching are shown separately and excluded from the total." : ""} Numbers appear a week after the period ends, once corrections are complete, and then stay fixed. Individual weeks are hidden so that one person’s activity cannot be identified by subtraction.`,
  poolWait: "Weeks with too few people searching are grouped into four-week periods. Numbers appear a week after the period ends if enough people searched across the period.",
  metricChange: (key: keyof typeof METRIC_WHAT, up: boolean, before: string, after: string, summary: boolean): string => {
    const change = searchQuality.change(METRIC_WHAT[key], up, before, after);
    return summary ? `Largest change: ${change}.` : change;
  },
};

export const SQ_TEXT = {
  lead: "Does memory search help? Does it find anything, do people open the results, and at which position? Calculated from logs, without record texts or figures for individual colleagues. Data refreshes every 15 minutes; each week appears after it ends.",
  exactHint: "The agent reported which search led it to open a record. Memory links other opens automatically: the same key, within 10 minutes of the search.",
  current: "The week is still in progress. Numbers will appear on Monday",
  rules: "calculation rules changed this week; compare with care",
  off: "Calculation is disabled by an administrator in settings (“Observability”). Previous data is kept.",
  failed: "Calculation failed. Contact your memory administrator.",
  stale: "Breakdowns are being recalculated after a settings change. Check again in 15 minutes.",
  queued: "Recalculation started. Refresh the page in a minute.",
};

export const METRIC_WHAT: Record<"zero_share" | "read1_share" | "read3_share" | "no_read_share" | "reformulated_share" | "corrected_share" | "outdated_share" | "useful_share", string> = {
  zero_share: "nothing is found",
  read1_share: "the first result is opened",
  read3_share: "one of the first three results is opened",
  no_read_share: "no results are opened",
  reformulated_share: "the question is rephrased immediately",
  corrected_share: "results are later corrected",
  outdated_share: "results are marked outdated",
  useful_share: "results are marked useful",
};
