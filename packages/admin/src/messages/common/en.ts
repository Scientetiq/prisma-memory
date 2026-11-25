// Common texts of the panel in English: the product name and the date pack. One exported constant per
// dictionary (a client module imports only the ones it reads); ru.ts has the same constants with the same keys.

const MONTHS = [
  "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December",
] as const;

/** Name of the product as people see it; an installation may set its own (instance value productName). */
export const brand = {
  product: "Prisma Memory",
};

/**
 * Date pack: day first, 24-hour clock ("5 October 2026, 16:03", "today, 16:03", "5–11 October"). m is the month
 * number 1–12; hh, mm and ss are two-digit strings. No range checks: callers keep their own fallbacks.
 */
export const dates = {
  /** Month names on their own (a folder of a month). */
  months: MONTHS,
  /** Month names inside a date. */
  monthsGen: MONTHS,
  today: "today",
  yesterday: "yesterday",
  dayMonth: (d: number, m: number): string => `${d} ${MONTHS[m - 1]}`,
  /** The year is written as given: a number, or the four digits of an ISO date ("0099"). */
  dayMonthYear: (d: number, m: number, y: number | string): string => `${d} ${MONTHS[m - 1]} ${y}`,
  dateTime: (day: string, hh: string, mm: string, ss?: string): string => `${day}, ${hh}:${mm}${ss ? `:${ss}` : ""}`,
  /** Days of one month: "5–11 October". */
  dayRange: (d1: number, d2: number, m: number): string => `${d1}–${d2} ${MONTHS[m - 1]}`,
  /** Two dates already in words: "28 September – 4 October". */
  spanRange: (from: string, to: string): string => `${from} – ${to}`,
};
