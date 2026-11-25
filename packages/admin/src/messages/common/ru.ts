// Common texts of the panel in Russian: the words of today's interface, copied from the modules that use them now
// (product name, month names, "today" and "yesterday"). Same constants and keys as en.ts.
import type { Messages } from "../../i18n/core";
import type * as en from "./en";

const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"] as const;
const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"] as const;

export const brand: Messages<typeof en.brand> = {
  product: "Prisma Memory",
};

export const dates: Messages<typeof en.dates> = {
  months: MONTHS,
  monthsGen: MONTHS_GEN,
  today: "сегодня",
  yesterday: "вчера",
  dayMonth: (d, m) => `${d} ${MONTHS_GEN[m - 1]}`,
  dayMonthYear: (d, m, y) => `${d} ${MONTHS_GEN[m - 1]} ${y}`,
  dateTime: (day, hh, mm, ss) => `${day}, ${hh}:${mm}${ss ? `:${ss}` : ""}`,
  dayRange: (d1, d2, m) => `${d1}–${d2} ${MONTHS_GEN[m - 1]}`,
  spanRange: (from, to) => `${from} – ${to}`,
};
